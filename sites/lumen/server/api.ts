/**
 * Lumen's server: what it can't do in the browser.
 *
 * - `POST /api/analyze` with a photo (JPEG or PNG bytes) answers where its subject is (a soft mask, as a PNG data URL)
 *   and where the faces and eyes are, from Apple Vision (analyze.swift).
 * - `POST /api/develop` with a camera raw (ARW, CR2/CR3, NEF, RAF, DNG, …) answers the photo developed to scene-linear
 *   light by Apple's raw engine (develop.swift): a 4-byte length, that much JSON (size, camera, as-shot white balance),
 *   then the pixels as RGBA half floats, linear Rec. 2020. Lumen's engine (engine.js) does the rest on the GPU.
 *
 * The helpers are built the first time they're needed; answers are kept by the file's hash, so a photo opened again
 * is instant. It needs macOS and Xcode's command line tools (swiftc); elsewhere it says so, and JPEGs still open.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 12 * 1024 * 1024;
/** A raw is bigger: a 61-megapixel ARW is about 120 MB uncompressed. */
const MAX_RAW_BYTES = 160 * 1024 * 1024;
/** The long side a raw is developed to (a 24-megapixel Sony at exactly half its size). */
const DEVELOP_SIDE = 3000;

export interface Analysis {
  width: number;
  height: number;
  /** The subject's mask (white where it is), as a PNG data URL; null when nothing stands out. */
  subject: string | null;
  faces: { box: [number, number, number, number]; eyes: [number, number, number][] }[];
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function bytes(req: IncomingMessage, limit = MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('That photo is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function lumenApi(dataDir: string) {
  const dir = path.join(dataDir, 'lumen');
  mkdirSync(dir, { recursive: true });
  const building = new Map<string, Promise<string>>();

  /** A helper, built from its .swift source (again whenever the source is newer). */
  function helper(name: 'analyze' | 'develop', needs: string): Promise<string> {
    if (process.platform !== 'darwin') return Promise.reject(new Error(`${needs}, which needs macOS.`));
    const source = path.join(HERE, `${name}.swift`), bin = path.join(dir, name);
    if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(source).mtimeMs) return Promise.resolve(bin);
    if (!building.has(name))
      building.set(
        name,
        run('swiftc', ['-O', source, '-o', bin], { timeout: 180_000 })
          .then(() => bin)
          .catch((err: Error) => {
            throw new Error(`Couldn't build the ${name} helper (Xcode's command line tools?): ${err.message.split('\n')[0]}`);
          })
          .finally(() => building.delete(name)),
      );
    return building.get(name)!;
  }

  async function analyze(photo: Buffer): Promise<Analysis> {
    const key = createHash('sha256').update(photo).digest('hex').slice(0, 24);
    const done = path.join(dir, `${key}.json`);
    if (existsSync(done)) return JSON.parse(readFileSync(done, 'utf8')) as Analysis;
    const image = path.join(dir, `${key}.img`);
    const mask = path.join(dir, `${key}.png`);
    writeFileSync(image, photo);
    const { stdout } = await run(await helper('analyze', 'Subject masks use Apple Vision'), [image, mask], { timeout: 60_000 });
    const found = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Omit<Analysis, 'subject'> & { subject: boolean };
    const result: Analysis = { ...found, subject: found.subject && existsSync(mask) ? `data:image/png;base64,${readFileSync(mask).toString('base64')}` : null };
    writeFileSync(done, JSON.stringify(result));
    return result;
  }

  /** A raw, developed: the header (JSON) and the pixels, kept by the file's hash. */
  async function develop(raw: Buffer, name: string): Promise<Buffer> {
    const key = createHash('sha256').update(raw).digest('hex').slice(0, 24);
    const done = path.join(dir, `${key}-${DEVELOP_SIDE}.developed`);
    if (existsSync(done)) return readFileSync(done);
    // The extension tells Core Image which camera format it is.
    const ext = (path.extname(name).slice(1) || 'raw').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const input = path.join(dir, `${key}.${ext}`), pixels = path.join(dir, `${key}.bin`);
    writeFileSync(input, raw);
    try {
      const { stdout } = await run(await helper('develop', 'Raw photos are developed with Apple’s raw engine'), [input, pixels, String(DEVELOP_SIDE)], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      const header = Buffer.from(stdout.slice(stdout.indexOf('{')).trim());
      const length = Buffer.alloc(4);
      length.writeUInt32LE(header.length);
      const out = Buffer.concat([length, header, readFileSync(pixels)]);
      writeFileSync(done, out);
      return out;
    } catch (err) {
      throw new Error(/not a raw/.test((err as Error).message) ? `This Mac can't read ${name} as a camera raw.` : (err as Error).message);
    } finally {
      rmSync(input, { force: true });
      rmSync(pixels, { force: true });
    }
  }

  /** Handles Lumen's API requests; false for anything else (the site's files). */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname === '/api/develop') {
      if (req.method !== 'POST') return (send(res, 405, { error: 'POST a raw photo.' }), true);
      try {
        const raw = await bytes(req, MAX_RAW_BYTES);
        if (raw.length < 1000) return (send(res, 400, { error: 'POST the raw file’s bytes.' }), true);
        const out = await develop(raw, url.searchParams.get('name') ?? 'photo.raw');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(out);
      } catch (err) {
        send(res, 503, { error: (err as Error).message });
      }
      return true;
    }
    if (url.pathname !== '/api/analyze') return false;
    if (req.method !== 'POST') return (send(res, 405, { error: 'POST a photo.' }), true);
    try {
      const photo = await bytes(req);
      if (photo.length < 100) return (send(res, 400, { error: 'POST the photo’s bytes (JPEG or PNG).' }), true);
      send(res, 200, await analyze(photo));
    } catch (err) {
      send(res, 503, { error: (err as Error).message });
    }
    return true;
  };
}
