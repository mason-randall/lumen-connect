import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect } from '../server/server.ts';
import { SITES, type SiteConfig } from '../server/sites.ts';
import type { Model } from '../server/coworld.ts';

/** A site with a task for its coworld, registered only here (the API doesn't need its pages: the outline comes with each request). */
const SHOP: SiteConfig = { id: 'shop', name: 'Sample Shop', port: 7461, dir: 'shop', tasks: [{ id: 'order-beans', page: '/', goal: 'You want to buy a bag of their coffee beans, delivered to your home.', success: 'a[href="/shop"]' }] };
const ORIGIN = `http://localhost:${SHOP.port}`;
const OUTLINE = 'e1 link "Visit the café" → #visit [drawn as a button]\ne2 link "Shop beans online" → /shop [plain link, below the fold]';

/** A model that answers like the agent and the visitors would: a variant that adds a Shop button; visitors who find it once it's there. */
const calls: string[] = [];
const fake: Model = async (system, user) => {
  if (typeof user !== 'string') throw new Error('Expected words.');
  calls.push(system.slice(0, 20));
  if (system.startsWith('You simulate')) {
    const found = user.includes('e3 link "Shop beans"');
    return JSON.stringify({ answers: Array.from({ length: 6 }, (_, i) => ({ persona: `P${i}`, click: found && i > 0 ? 'e3' : 'e1', why: 'It looked right.' })) });
  }
  if (calls.filter((c) => !c.startsWith('You simulate')).length === 1) {
    // The first try breaks the rules (it's corrected and retried).
    return JSON.stringify({ title: 'Shop in the hero', hypothesis: 'Visitors miss the footer link.', patches: [{ op: 'attr', target: 'a', name: 'onclick', value: 'x' }] });
  }
  return `Here's my variant:\n${JSON.stringify({ title: 'Shop in the hero', hypothesis: 'Visitors who want beans miss the footer link; a Shop button in the hero puts it where they look.', patches: [{ op: 'clone', target: 'a.btn-primary', to: '.hero-actions', position: 'prepend', text: 'Shop beans', href: '/shop' }] })}`;
};

let server: Server;
let base = '';
const post = (p: string, body: unknown) => fetch(`${base}/api/sites/shop${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });

beforeAll(async () => {
  const connect = createConnect({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'connect-')), model: fake, sites: [...SITES, SHOP] });
  server = createServer(connect.handler).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('a site as a coworld, through the API', () => {
  it("tells the page its tasks, and lets only the site's own pages in", async () => {
    const site = await (await fetch(`${base}/api/sites/shop`, { headers: { origin: ORIGIN } })).json();
    expect(site).toMatchObject({ name: 'Sample Shop', tasks: [{ id: 'order-beans', success: 'a[href="/shop"]' }], champion: null });
    const res = await fetch(`${base}/api/sites/shop`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const stranger = await fetch(`${base}/api/sites/shop/variants`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    expect(stranger.status).toBe(403);
  });

  it('scores the original, improves on what visitors did, and scores the variant higher', async () => {
    const original = await (await post('/evaluate', { page: '/', task: 'order-beans', variant: null, outline: OUTLINE, matches: { e2: ['order-beans'] }, labels: { e1: 'Visit the café', e2: 'Shop beans online' } })).json();
    expect(original).toMatchObject({ hits: 0, n: 6 });
    expect(original.answers[0]).toMatchObject({ clicked: 'Visit the café', hit: false });

    const v = await (await post('/improve', { page: '/', task: 'order-beans', parent: null, outline: OUTLINE })).json();
    expect(v).toMatchObject({ title: 'Shop in the hero', author: { kind: 'agent' }, patches: [{ op: 'clone', href: '/shop' }] });

    const after = await (await post('/evaluate', { page: '/', task: 'order-beans', variant: v.id, outline: `${OUTLINE}\ne3 link "Shop beans" → /shop [drawn as a button, above the fold]`, matches: { e2: ['order-beans'], e3: ['order-beans'] }, labels: { e3: 'Shop beans' } })).json();
    expect(after).toMatchObject({ hits: 5, n: 6 });

    const board = await (await fetch(`${base}/api/sites/shop/board?page=/&task=order-beans`, { headers: { origin: ORIGIN } })).json();
    expect(board.original.score).toEqual({ hits: 0, n: 6 });
    expect(board.variants.map((x: { title: string; score: unknown }) => [x.title, x.score])).toEqual([['Shop in the hero', { hits: 5, n: 6 }]]);
  });

  it("refuses a player's variant that breaks the rules, and keeps one that doesn't", async () => {
    const bad = await post('/variants', { page: '/', title: 'x', patches: [{ op: 'css', css: '@import url(https://x)' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/no @import/);
    const ok = await (await post('/variants', { page: '/', title: 'Bigger roasts', hypothesis: 'h', patches: [{ op: 'style', target: '.roasts', style: { gap: '32px' } }] })).json();
    expect(ok).toMatchObject({ author: { kind: 'player' }, title: 'Bigger roasts' });
  });
});
