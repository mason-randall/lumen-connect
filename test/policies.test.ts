import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, Model } from '../server/coworld.ts';
import { candidateRules, coachingStandard, judge, parseAnalysis, policyText, type CoachingSession, type PolicyVersion } from '../server/policies.ts';
import { createConnect } from '../server/server.ts';

const base: PolicyVersion = { id: 'pv_1', site: 'lumen', n: 1, rules: [{ id: 'rule_a', layer: 'goal', text: 'Keep it natural.', evidence: [] }], parent: null, session: null, created_at: '' };
const session: CoachingSession = {
  id: 'coach_1',
  site: 'lumen',
  version: 'pv_1',
  started_at: '',
  evidence: [
    { id: 'e1', t: 1000, kind: 'speech', text: 'I only smooth a little, under twenty.' },
    { id: 'e2', t: 2000, kind: 'move', text: 'set "Smooth skin" to 18 (was 0)' },
    { id: 'e3', t: 3000, kind: 'agent', text: 'the agent set "Glow" to 30' },
    { id: 'e4', t: 4000, kind: 'note', text: 'Never use Glow.' },
  ],
};

describe('a policy', () => {
  it('reads as rules in layer order, or says nothing is coached yet', () => {
    expect(policyText({ ...base, rules: [] })).toMatch(/nothing coached yet/);
    const text = policyText({ ...base, rules: [{ id: 'r2', layer: 'execution', text: 'Smooth skin under 20.', evidence: [] }, ...base.rules] });
    expect(text.indexOf('[goal]')).toBeLessThan(text.indexOf('[execution]'));
  });

  it('keeps only what the analysis grounds in real evidence', () => {
    const reply = JSON.stringify({
      summary: 'Light smoothing, no glow.',
      moments: [{ t: 1000, observation: 'o', intent: 'i', uncertainty: 'u', evidence_ids: ['e1', 'e99'] }, { t: 1, observation: 'x', intent: '', uncertainty: '', evidence_ids: ['e99'] }],
      proposals: [
        { layer: 'execution', change: 'Keep Smooth skin under 20.', rationale: 'r', verification: 'v', evidence_ids: ['e1', 'e2'], replaces: null },
        { layer: 'goal', change: 'Never use Glow.', rationale: 'r', verification: 'v', evidence_ids: ['e4'], replaces: 'rule_a' },
        { layer: 'vibes', change: 'x', evidence_ids: ['e1'] },
        { layer: 'goal', change: 'Uncited.', evidence_ids: [] },
      ],
      questions: ['How much warmth?'],
    });
    const { analysis, dropped } = parseAnalysis(reply, new Set(session.evidence.map((e) => e.id)), new Set(['rule_a']));
    expect(dropped).toBe(3);
    expect(analysis.moments).toHaveLength(1);
    expect(analysis.moments[0]!.evidence_ids).toEqual(['e1']);
    expect(analysis.proposals.map((p) => p.change)).toEqual(['Keep Smooth skin under 20.', 'Never use Glow.']);
    expect(analysis.proposals[1]!.replaces).toBe('rule_a');
  });

  it('makes a candidate from the incumbent and the kept proposals', () => {
    let n = 0;
    const rules = candidateRules(base, session, [{ layer: 'goal', change: 'Never use Glow.', rationale: '', verification: '', evidence_ids: ['e4'], replaces: 'rule_a' }], () => `rule_${++n}`);
    expect(rules).toEqual([{ id: 'rule_1', layer: 'goal', text: 'Never use Glow.', evidence: ['coach_1/e4'] }]);
  });

  it("judges by the player's own coaching only, not the agent's moves", () => {
    const standard = coachingStandard([session]);
    expect(standard).toContain('said: I only smooth a little');
    expect(standard).toContain('moved: set "Smooth skin" to 18');
    expect(standard).not.toContain('Glow" to 30');
    expect(coachingStandard([{ ...session, evidence: [{ id: 'e9', t: 1, kind: 'ask', text: 'lift the shadows' }] }])).toContain('asked the agent, for that photo: lift the shadows');
  });

  it('maps the judge’s A and B back to the versions, whichever order they were shown in', async () => {
    const seen: string[] = [];
    const prompts: string[] = [];
    const model: Model = async (_s, user) => {
      const blocks = user as Exclude<Content, string>;
      prompts.push((blocks[0] as { text: string }).text);
      seen.push((blocks[2] as { source: { data: string } }).source.data);
      return JSON.stringify({ winner: 'A', why: "Edit A keeps the skin texture; edit B is over-smoothed. B's shadows were a one-off. A plain sentence stays." });
    };
    const imgs = { original: { media_type: 'image/jpeg', data: 'O' }, a: { media_type: 'image/jpeg', data: 'A' }, b: { media_type: 'image/jpeg', data: 'B' } };
    const context = { request: 'Edit it', settings: { a: 'Smooth skin 18', b: 'Smooth skin 60' } };
    const straight = await judge(model, 'std', imgs, { a: 'v1', b: 'v2' }, context, false);
    const flipped = await judge(model, 'std', imgs, { a: 'v1', b: 'v2' }, context, true);
    expect(seen).toEqual(['A', 'B']);
    expect(straight).toEqual({ winner: 'a', why: "v1 keeps the skin texture; v2 is over-smoothed. v2's shadows were a one-off. A plain sentence stays." });
    expect(flipped).toEqual({ winner: 'b', why: "v2 keeps the skin texture; v1 is over-smoothed. v1's shadows were a one-off. A plain sentence stays." });
    // The settings follow the order the edits were shown in.
    expect(prompts[0]).toContain("Edit A's settings (changed from the app's defaults): Smooth skin 18");
    expect(prompts[1]).toContain("Edit A's settings (changed from the app's defaults): Smooth skin 60");
    expect(prompts[0]).toContain('edited for: "Edit it"');
  });
});

/** The analysis proposes one rule from the note; the judge prefers whichever edit it was shown as A. */
const fake: Model = async (system) => {
  if (system.startsWith('You analyze a coaching session')) return JSON.stringify({ summary: 'No glow.', moments: [], proposals: [{ layer: 'goal', change: 'Never use Glow.', rationale: 'They said so.', verification: 'Glow stays 0.', evidence_ids: ['e2'], replaces: null }], questions: [] });
  if (system.startsWith('You judge')) return JSON.stringify({ winner: 'tie', why: 'Both follow it.' });
  return '{}';
};

let api: Server;
let baseUrl = '';
const post = (p: string, body: unknown) => fetch(`${baseUrl}/api/sites/lumen${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:7463' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const img = { media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') };

beforeAll(async () => {
  api = createServer(createConnect({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'connect-')), model: fake }).handler).listen(0);
  await new Promise((r) => api.once('listening', r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

describe('coaching Lumen, through the API', () => {
  it('coaches, analyzes, makes a candidate, practices, and keeps it', async () => {
    const policy = await (await fetch(`${baseUrl}/api/sites/lumen/policy`)).json();
    expect(policy.versions).toHaveLength(1);
    const v1 = policy.champion;

    const s = (await post('/coaching', {})).body;
    expect(s.version).toBe(v1);
    const sent = await post(`/coaching/${s.id}/evidence`, { evidence: [{ id: 'e1', t: 500, kind: 'move', text: 'set "Glow" to 0', image: img }, { id: 'e2', t: 900, kind: 'note', text: 'Never use Glow.' }, { id: 'bad', t: 1, kind: 'note', text: 'x' }] });
    expect(sent.body.evidence).toBe(2);
    const picture = sent.body.items[0].image;
    expect((await fetch(`${baseUrl}/api/sites/lumen/images/${picture}`)).headers.get('content-type')).toBe('image/jpeg');

    const finished = (await post(`/coaching/${s.id}/finish`, {})).body;
    expect(finished.analysis.proposals).toHaveLength(1);
    expect((await post(`/coaching/${s.id}/evidence`, { evidence: [{ id: 'e3', t: 1, kind: 'note', text: 'late' }] })).status).toBe(409);
    expect((await post(`/coaching/${s.id}/candidate`, { proposals: [] })).status).toBe(400);
    const v2 = (await post(`/coaching/${s.id}/candidate`, { proposals: [0] })).body;
    expect(v2).toMatchObject({ n: 2, parent: v1, rules: [{ layer: 'goal', text: 'Never use Glow.', evidence: [`${s.id}/e2`] }] });

    const practice = (await post('/practice/judge', { a: v1, b: v2.id, episodes: [{ photo: '/p.jpg', original: img, a: img, b: img }] })).body;
    expect(practice.episodes[0]).toMatchObject({ winner: 'tie', why: 'Both follow it.' });
    expect((await post(`/practice/${practice.id}/keep`, { version: 'pv_nope' })).status).toBe(400);
    await post(`/practice/${practice.id}/keep`, { version: v2.id });
    expect((await (await fetch(`${baseUrl}/api/sites/lumen/policy`)).json()).champion).toBe(v2.id);
  });

  it('tells the agent its policy, what it heard, and when it’s practicing', async () => {
    let user = '' as Content;
    const capture = createConnect({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'connect-')), model: async (_s, u) => ((user = u), JSON.stringify({ say: 'ok', look: null, actions: [], done: true, rework: 'add a slider' })) });
    const srv = createServer(capture.handler).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/sites/lumen/act`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:7463' }, body: JSON.stringify({ request: 'Edit it', controls: 'Controls:', images: [], heard: ['less contrast'], practice: 3 }) });
    srv.close();
    const text = ((user as Exclude<Content, string>)[0] as { text: string }).text;
    expect(text).toContain('nothing coached yet');
    expect(text).toContain('"less contrast"');
    expect(text).toContain('be done within 3 steps');
    expect((await res.json()).rework).toBeNull();
  });
});

describe('the analysis, as the player reads it', () => {
  it('keeps evidence ids out of its prose', () => {
    const { analysis } = parseAnalysis(JSON.stringify({ summary: 'Texture matters (e1).', moments: [], proposals: [{ layer: 'goal', change: 'Natural skin (e1, e2).', rationale: 'They said so (e1 and e4) twice.', verification: 'v', evidence_ids: ['e1'], replaces: null }], questions: [] }), new Set(['e1', 'e2', 'e4']), new Set());
    expect(analysis.summary).toBe('Texture matters.');
    expect(analysis.proposals[0]).toMatchObject({ change: 'Natural skin.', rationale: 'They said so twice.' });
  });
});

describe('teaching with the grad cap, through the API', () => {
  it('trains on a lesson: every proposal makes the next version, which it follows from now on', async () => {
    const lesson = (await post('/coaching', {})).body;
    await post(`/coaching/${lesson.id}/evidence`, { evidence: [{ id: 'e1', t: 100, kind: 'speech', text: 'I lift the shadows first.' }, { id: 'e2', t: 900, kind: 'note', text: 'Never use Glow.' }] });
    const trained = (await post(`/coaching/${lesson.id}/train`, {})).body;
    expect(trained.version).toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ text: 'Never use Glow.' })]) });
    const policy = await (await fetch(`${baseUrl}/api/sites/lumen/policy`)).json();
    expect(policy.champion).toBe(trained.version.id);
    // Training again is the same lesson: no second version.
    expect((await post(`/coaching/${lesson.id}/train`, {})).body.version.id).toBe(trained.version.id);
  });

  it('keeps the recording, and plays it back in ranges', async () => {
    const lesson = (await post('/coaching', {})).body;
    const bytes = Buffer.alloc(4096, 7);
    const up = await fetch(`${baseUrl}/api/sites/lumen/coaching/${lesson.id}/recording`, { method: 'POST', headers: { 'content-type': 'video/webm', origin: 'http://localhost:7463' }, body: bytes });
    expect(up.status).toBe(200);
    const all = await fetch(`${baseUrl}/api/sites/lumen/recordings/${lesson.id}`);
    expect(all.headers.get('content-type')).toBe('video/webm');
    const part = await fetch(`${baseUrl}/api/sites/lumen/recordings/${lesson.id}`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const policy = await (await fetch(`${baseUrl}/api/sites/lumen/policy`)).json();
    expect(policy.sessions.find((x: { id: string }) => x.id === lesson.id).recording).toBe(true);
  });
});
