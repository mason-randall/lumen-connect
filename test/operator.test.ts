import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, Model } from '../server/coworld.ts';
import { actContent, applyEdits, parseStep } from '../server/operator.ts';
import { createConnect, siteFiles, siteHandler } from '../server/server.ts';
import { SITES, type SiteConfig } from '../server/sites.ts';

const lumen = SITES.find((s) => s.id === 'lumen')!;
/** A site that doesn't share its code with Connect (registered only here). */
const CLOSED: SiteConfig = { id: 'closed', name: 'Closed', port: 7462, dir: 'closed', tasks: [] };

describe("the agent's steps", () => {
  it('keeps what it can use from a reply, and drops the rest', () => {
    const step = parseStep(`Sure:\n${JSON.stringify({ say: 'Warming it up.', look: { view: 'v1', region: [0.2, 0.1, 0.5, 0.4] }, actions: [{ ref: 'c11', value: 25 }, { ref: 'c6', press: true }, { ref: 'c9', point: true }, { ref: 'c7' }, { value: 3 }], done: false, rework: '' })}`);
    expect(step).toEqual({ say: 'Warming it up.', look: { view: 'v1', region: [0.2, 0.1, 0.5, 0.4] }, actions: [{ ref: 'c11', value: 25 }, { ref: 'c6', press: true }, { ref: 'c9', point: true }], done: false, rework: null });
  });

  it('sends the pictures it looks at as images, after the words', () => {
    const content = actContent({ request: 'warmer', page: '/', controls: 'Controls:\nc1 slider "Exposure"', images: [{ label: 'v1 the photo', media_type: 'image/jpeg', data: 'abc' }], history: [], player: ['Set "Exposure" (c1) to 0.5'], changes: [], pageText: 'e1 heading "Lumen"' }) as Exclude<Content, string>;
    expect((content[0] as { text: string }).text).toContain('The page, as you\'d read it (for reading only: act on the controls\' c refs):\ne1 heading "Lumen"');
    expect(content[0]).toMatchObject({ type: 'text' });
    expect((content[0] as { text: string }).text).toContain('What the player did with the controls lately');
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } });
  });
});

describe('changing the app’s code', () => {
  const files = { 'app.js': 'const A = 1;\nconst B = 2;\n', 'index.html': '<p>hi</p>' };

  it('applies edits whose text appears exactly once', () => {
    expect(applyEdits(files, [{ file: 'app.js', find: 'const B = 2;', replace: 'const B = 3;' }])).toEqual({ files: { ...files, 'app.js': 'const A = 1;\nconst B = 3;\n' }, issues: [] });
  });

  it('refuses edits that miss, repeat, break the code, or reach out', () => {
    const issues = (edits: Parameters<typeof applyEdits>[1]) => applyEdits(files, edits).issues.join(' ');
    expect(issues([{ file: 'app.js', find: 'const', replace: 'let' }])).toContain('appears 2 times');
    expect(issues([{ file: 'nope.js', find: 'x', replace: 'y' }])).toContain('no file');
    expect(issues([{ file: 'app.js', find: 'const B = 2;', replace: 'const B = (;' }])).toContain("doesn't parse");
    expect(issues([{ file: 'app.js', find: 'const B = 2;', replace: 'fetch("https://x")' }])).toContain('not allowed');
  });
});

/** A model that, asked to act, wants a Noise reduction slider; asked to rework, adds one (wrongly once, then right). */
let reworkCalls = 0;
const fake: Model = async (system, user) => {
  if (system.startsWith('You are the player')) {
    expect(Array.isArray(user)).toBe(true);
    return JSON.stringify({ say: "There's no noise control.", look: null, actions: [], done: false, rework: 'Add a Noise reduction slider.' });
  }
  reworkCalls++;
  const find = reworkCalls === 1 ? 'not in the file' : '<p class="mask-status" id="mask-status" role="status">Finding the subject…</p>';
  return JSON.stringify({ title: 'Add Noise reduction', why: 'So it can clean up grain.', edits: [{ file: 'index.html', find, replace: `<input type="range" id="agent-added" />\n${find}` }] });
};

let api: Server;
let site: Server;
let base = '';
let siteBase = '';
const post = (p: string, body: unknown) => fetch(`${base}/api/sites/lumen${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${lumen.port}` }, body: JSON.stringify(body) });

beforeAll(async () => {
  const connect = createConnect({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'connect-')), model: fake, sites: [...SITES, CLOSED] });
  api = createServer(connect.handler).listen(0);
  site = createServer(siteHandler(lumen, 'http://connect', () => connect.code(lumen))).listen(0);
  await Promise.all([api, site].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => {
  api.close();
  site.close();
});

describe('Lumen, through the API', () => {
  it('takes a step with a picture', async () => {
    const res = await post('/act', { request: 'Clean up the grain', page: '/', controls: 'Controls:\n(none)', images: [{ label: 'v1', media_type: 'image/jpeg', data: 'abc' }], history: [], player: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rework: 'Add a Noise reduction slider.' });
  });

  it('changes the code it serves (retrying a change that missed), and undoes it, leaving the files alone', async () => {
    const before = siteFiles(lumen)['index.html']!;
    const res = await post('/rework', { need: 'Add a Noise reduction slider.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Add Noise reduction' });
    expect(reworkCalls).toBe(2);
    expect(await (await fetch(siteBase)).text()).toContain('id="agent-added"');
    expect((await (await fetch(`${base}/api/sites/lumen/changes`)).json()).changes).toHaveLength(1);
    expect(siteFiles(lumen)['index.html']).toBe(before);

    expect((await post('/rework/undo', {})).status).toBe(200);
    expect(await (await fetch(siteBase)).text()).not.toContain('id="agent-added"');
    expect((await post('/rework/undo', {})).status).toBe(404);
  });

  it("won't change a site that doesn't share its code", async () => {
    const res = await fetch(`${base}/api/sites/closed/rework`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${CLOSED.port}` }, body: JSON.stringify({ need: 'x' }) });
    expect(res.status).toBe(403);
  });
});
