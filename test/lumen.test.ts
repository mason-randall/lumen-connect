import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lumenApi } from '../sites/lumen/server/api.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  const api = lumenApi(mkdtempSync(path.join(os.tmpdir(), 'lumen-')));
  server = createServer(async (req, res) => {
    if (!(await api(req, res, new URL(req.url ?? '/', 'http://local')))) res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("Lumen's raw developer", () => {
  it('takes a raw file posted to it, and says what it wants otherwise', async () => {
    expect((await fetch(`${base}/api/develop`)).status).toBe(405);
    const tiny = await fetch(`${base}/api/develop?name=x.arw`, { method: 'POST', body: new Uint8Array(10) });
    expect(tiny.status).toBe(400);
    expect((await tiny.json()).error).toMatch(/raw file/);
  });

  it.runIf(process.platform === 'darwin')(
    "says so when the file isn't a raw this Mac can read",
    async () => {
      const res = await fetch(`${base}/api/develop?name=not-a-photo.arw`, { method: 'POST', body: new Uint8Array(4096).fill(7) });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/can't read not-a-photo\.arw as a camera raw|Couldn't build/);
    },
    180_000,
  );
});
