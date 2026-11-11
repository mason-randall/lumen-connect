/**
 * Softmax Connect, locally: serves connect.js and its API on :7460, and each sample site on its own port (another
 * origin, like a real site with the script on it). What it keeps (variants, changes, policies, practice) is a JSON
 * file and some images in the data dir (CONNECT_DATA_DIR, ./data by default).
 *
 *   npm run dev        # then open http://localhost:7463 (Lumen)
 *
 * The agent is a model behind an Anthropic Messages API (CONNECT_MODEL_URL, CONNECT_MODEL_KEY: see the README).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { checkPatches, type Patch, type PatchIssue, type Variant } from '../src/patches.ts';
import { firstClicks, improverPrompt, messagesModel, propose, type Answer, type Model, type Tried } from './coworld.ts';
import { act, applyEdits, proposeRework, type ActInput, type Edit } from './operator.ts';
import { analyze, candidateRules, coachingStandard, judge, policyText, type CoachingSession, type Evidence, type Img, type Practice, type PolicyVersion } from './policies.ts';
import { SITES, type SiteConfig } from './sites.ts';
import { overlayFor } from './overlay.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

export interface Result {
  id: string;
  site: string;
  page: string;
  task: string;
  variant: string | null;
  hits: number;
  n: number;
  answers: Answer[];
  created_at: string;
}

/** A change the agent made to an app's code (sites that share their code with Connect). */
export interface CodeChange {
  id: string;
  site: string;
  title: string;
  why: string;
  /** What the agent needed that the app couldn't do. */
  need: string;
  edits: Edit[];
  created_at: string;
  undone_at?: string;
}

interface Store {
  variants: (Variant & { skipped?: PatchIssue[] })[];
  results: Result[];
  champions: Record<string, string | null>;
  changes?: CodeChange[];
  /** Policies for using the sites (policies.ts): every version, the coaching, and the practice between versions. */
  versions?: PolicyVersion[];
  sessions?: CoachingSession[];
  practices?: Practice[];
  /** The version each site's agent follows. */
  policyChampions?: Record<string, string>;
}

export interface ConnectOptions {
  dataDir?: string;
  model?: Model;
  sites?: SiteConfig[];
  port?: number;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 512 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('That request is too large.');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * The bundle, rebuilt when any file in it changes: its own sources, as the last build's metafile lists them.
 */
function bundler() {
  let cache: { at: number; code: string; inputs: string[] } | null = null;
  const src = path.join(PKG, 'src');
  const newest = (files: string[]) => Math.max(...files.map((f) => (existsSync(f) ? statSync(f).mtimeMs : Infinity)));
  return async () => {
    const own = readdirSync(src, { recursive: true }).map((f) => path.join(src, String(f)));
    const at = newest([...own, ...(cache?.inputs ?? [])]);
    if (cache?.at !== at) {
      const out = await build({ entryPoints: [path.join(src, 'connect.ts')], bundle: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none', metafile: true });
      const inputs = Object.keys(out.metafile!.inputs).filter((f) => !f.includes('node_modules')).map((f) => path.resolve(f));
      cache = { at: newest([...own, ...inputs]), code: out.outputFiles[0]!.text, inputs };
    }
    return cache.code;
  };
}

const score = (results: Result[]) => (results.length ? { hits: results.reduce((s, r) => s + r.hits, 0), n: results.reduce((s, r) => s + r.n, 0) } : null);
const firstName = (persona: string) => persona.split(/[ ,]/)[0];

export function createConnect(options: ConnectOptions = {}) {
  const sites = options.sites ?? SITES;
  const dataDir = options.dataDir ?? process.env.CONNECT_DATA_DIR ?? path.join(PKG, 'data');
  const file = path.join(dataDir, 'store.json');
  const model = options.model ?? messagesModel(process.env.CONNECT_MODEL_URL ?? 'http://127.0.0.1:7440', process.env.CONNECT_MODEL_KEY ?? 'claude-code-local', process.env.CONNECT_MODEL);
  mkdirSync(dataDir, { recursive: true });
  const store: Store = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Store) : { variants: [], results: [], champions: {} };
  store.changes ??= [];
  store.versions ??= [];
  store.sessions ??= [];
  store.practices ??= [];
  store.policyChampions ??= {};
  const imageDir = path.join(dataDir, 'images');
  mkdirSync(imageDir, { recursive: true });
  /** Teaching sessions' screen recordings (with the voice), one WebM per session. */
  const recordingDir = path.join(dataDir, 'recordings');
  mkdirSync(recordingDir, { recursive: true });
  const recordingOf = (id: string) => path.join(recordingDir, `${id}.webm`);
  const save = () => writeFileSync(file, JSON.stringify(store, null, 1));
  const bundle = bundler();
  const require = createRequire(path.join(PKG, 'package.json'));

  /** The pages that may call the API: the sites' own origins (and the client). */
  const origins = new Set(sites.flatMap((s) => [`http://localhost:${s.port}`, `http://127.0.0.1:${s.port}`]).concat(['http://localhost:5173', 'http://127.0.0.1:5173']));

  const variantsOf = (site: string, page: string) => store.variants.filter((v) => v.site === site && v.page === page);
  const resultsOf = (site: string, task: string, variant: string | null) => store.results.filter((r) => r.site === site && r.task === task && r.variant === variant);

  function board(site: SiteConfig, page: string, task: string) {
    const original = resultsOf(site.id, task, null);
    return {
      original: { score: score(original), latest: original.at(-1) ?? null },
      variants: variantsOf(site.id, page).map((v) => {
        const rs = resultsOf(site.id, task, v.id);
        return { ...v, score: score(rs), latest: rs.at(-1) ?? null };
      }),
    };
  }

  const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
  const versionsOf = (site: string) => store.versions!.filter((v) => v.site === site);
  /** The version a site's agent follows: the one the player kept, else the base (v1, made the first time it's asked for). */
  function championOf(site: string): PolicyVersion {
    const list = versionsOf(site);
    const kept = list.find((v) => v.id === store.policyChampions![site]);
    if (kept) return kept;
    if (list[0]) return list[0];
    const base: PolicyVersion = { id: id('pv'), site, n: 1, rules: [], parent: null, session: null, created_at: new Date().toISOString() };
    store.versions!.push(base);
    save();
    return base;
  }
  const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  function saveImage(img: unknown): string | null {
    const i = img as Img | null;
    if (!i || typeof i.data !== 'string' || !IMAGE_TYPES[i.media_type]) return null;
    const name = `${id('img')}${IMAGE_TYPES[i.media_type]}`;
    writeFileSync(path.join(imageDir, name), Buffer.from(i.data, 'base64'));
    return name;
  }
  function readImage(name: string): Img | null {
    if (!/^img_[\w]+\.(jpg|png|webp)$/.test(name) || !existsSync(path.join(imageDir, name))) return null;
    const ext = path.extname(name);
    return { media_type: Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === ext)!, data: readFileSync(path.join(imageDir, name)).toString('base64') };
  }
  // The evidence comes back without its pictures (they're at /images/<name>).
  const sessionSummary = (c: CoachingSession) => ({ id: c.id, version: c.version, started_at: c.started_at, finished_at: c.finished_at ?? null, evidence: c.evidence.length, items: c.evidence, analysis: c.analysis ?? null, candidate: c.candidate ?? null, recording: existsSync(recordingOf(c.id)) });

  const changesOf = (site: string) => store.changes!.filter((c) => c.site === site && !c.undone_at);

  /** A site's code as served now: its files, with the agent's changes on them (any that no longer apply are skipped). */
  function code(site: SiteConfig): Record<string, string> {
    let files = siteFiles(site);
    for (const c of changesOf(site.id)) {
      const next = applyEdits(files, c.edits);
      if (!next.issues.length) files = next.files;
    }
    return files;
  }

  function tried(site: SiteConfig, page: string, task: string): Tried[] {
    const misses = (r: Result | undefined) => (r ? r.answers.filter((a) => !a.hit).map((a) => `${firstName(a.persona)} clicked "${a.clicked}" (${a.why})`) : []);
    const original = resultsOf(site.id, task, null);
    const list: Tried[] = [{ name: 'the original', title: 'The site as built', hypothesis: '-', ...(score(original) ?? { hits: null, n: null }), misses: misses(original.at(-1)) }];
    variantsOf(site.id, page).forEach((v, i) => {
      const rs = resultsOf(site.id, task, v.id);
      list.push({ name: `v${i + 1}`, title: v.title, hypothesis: v.hypothesis, ...(score(rs) ?? { hits: null, n: null }), misses: misses(rs.at(-1)) });
    });
    return list;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = /^\/api\/sites\/([\w-]+)(\/.*)?$/.exec(url.pathname);
    const site = m && sites.find((s) => s.id === m[1]);
    if (!site) return json(res, 404, { error: `There's no site "${m?.[1] ?? ''}" on Softmax Connect.` });
    const rest = m![2] ?? '';
    const taskOf = (id: unknown) => site.tasks.find((t) => t.id === id);

    if (req.method === 'GET' && rest === '') return json(res, 200, { id: site.id, name: site.name, tasks: site.tasks, champion: store.champions[site.id] ?? null, practice: site.practice ?? null });
    // The Softmax overlay (⌃⇧ in the embed): your apps, your agent's policies in each, your friends.
    if (req.method === 'GET' && rest === '/overlay') {
      return json(res, 200, overlayFor(site, sites, (s) => ({ inUse: championOf(s), versions: versionsOf(s), lessons: store.sessions!.filter((c) => c.site === s && c.finished_at).length })));
    }
    // The site's policy: every version, which one the agent follows, the coaching, and the practice.
    if (req.method === 'GET' && rest === '/policy') {
      const champion = championOf(site.id);
      return json(res, 200, { champion: champion.id, versions: versionsOf(site.id), sessions: store.sessions!.filter((c) => c.site === site.id).map(sessionSummary), practices: store.practices!.filter((p) => p.site === site.id) });
    }
    // A session's recording, for watching (with ranges, so it can seek).
    const watch = /^\/recordings\/(coach_[\w]+)$/.exec(rest);
    if (req.method === 'GET' && watch) {
      const file = recordingOf(watch[1]!);
      if (!existsSync(file)) return json(res, 404, { error: 'No recording of that session.' });
      const size = statSync(file).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      res.setHeader('content-type', 'video/webm');
      res.setHeader('accept-ranges', 'bytes');
      if (!range) {
        res.setHeader('content-length', size);
        return res.end(readFileSync(file));
      }
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
      res.setHeader('content-length', end - start + 1);
      return res.end(readFileSync(file).subarray(start, end + 1));
    }
    // A session's recording, sent when it ends (the bytes, not JSON).
    const upload = /^\/coaching\/(coach_[\w]+)\/recording$/.exec(rest);
    if (req.method === 'POST' && upload) {
      if (!store.sessions!.some((x) => x.id === upload[1] && x.site === site.id)) return json(res, 404, { error: 'No such coaching session.' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 400 * 1024 * 1024) return json(res, 413, { error: 'That recording is too long to keep.' });
        chunks.push(c as Buffer);
      }
      // The browser writes the recording without its length: remuxed (with ffmpeg, where there is one), it can seek.
      const raw = `${recordingOf(upload[1]!)}.raw`;
      writeFileSync(raw, Buffer.concat(chunks));
      const remuxed = await new Promise<boolean>((resolve) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c', 'copy', recordingOf(upload[1]!)], { timeout: 120_000 }, (err) => resolve(!err)));
      if (!remuxed) renameSync(raw, recordingOf(upload[1]!));
      else rmSync(raw, { force: true });
      return json(res, 200, { ok: true, bytes: size, seekable: remuxed });
    }
    const image = /^\/images\/([\w.]+)$/.exec(rest);
    if (req.method === 'GET' && image) {
      const img = readImage(image[1]!);
      if (!img) return json(res, 404, { error: 'No such picture.' });
      res.setHeader('content-type', img.media_type);
      res.setHeader('cache-control', 'max-age=31536000, immutable');
      return res.end(Buffer.from(img.data, 'base64'));
    }
    if (req.method === 'GET' && rest === '/board') {
      const task = taskOf(url.searchParams.get('task'));
      if (!task) return json(res, 400, { error: 'Which task?' });
      return json(res, 200, board(site, url.searchParams.get('page') ?? task.page, task.id));
    }
    const listChanges = () => changesOf(site.id).map(({ id, title, why, created_at }) => ({ id, title, why, created_at }));
    if (req.method === 'GET' && rest === '/changes') return json(res, 200, { changes: listChanges() });
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST.' });
    const big = rest === '/act' || rest === '/practice/judge' || /^\/coaching\/[\w]+\/evidence$/.test(rest);
    const body = await readBody(req, big ? 16 * 1024 * 1024 : undefined);

    // ---- coaching (policies.ts) ----
    if (rest === '/coaching') {
      const c: CoachingSession = { id: id('coach'), site: site.id, version: championOf(site.id).id, started_at: new Date().toISOString(), evidence: [] };
      store.sessions!.push(c);
      save();
      return json(res, 200, sessionSummary(c));
    }
    const coaching = /^\/coaching\/(coach_[\w]+)\/(evidence|finish|candidate|train)$/.exec(rest);
    if (coaching) {
      const c = store.sessions!.find((x) => x.id === coaching[1] && x.site === site.id);
      if (!c) return json(res, 404, { error: 'No such coaching session.' });
      if (coaching[2] === 'evidence') {
        if (c.finished_at) return json(res, 409, { error: 'That session is finished.' });
        const kinds = new Set<Evidence['kind']>(['speech', 'note', 'move', 'mark', 'ask', 'agent']);
        for (const e of Array.isArray(body.evidence) ? body.evidence.slice(0, 200) : []) {
          if (!e || typeof e.id !== 'string' || !/^e\d+$/.test(e.id) || !kinds.has(e.kind) || typeof e.text !== 'string' || c.evidence.some((x) => x.id === e.id)) continue;
          const image = e.image ? saveImage(e.image) : null;
          c.evidence.push({ id: e.id, t: Math.max(0, Number(e.t) || 0), kind: e.kind, text: e.text.slice(0, 600), ...(image ? { image } : {}) });
        }
        c.evidence.sort((a, b) => a.t - b.t);
        save();
        return json(res, 200, sessionSummary(c));
      }
      if (coaching[2] === 'finish' || (coaching[2] === 'train' && !c.analysis)) {
        const policy = store.versions!.find((v) => v.id === c.version) ?? championOf(site.id);
        const images = Object.fromEntries(c.evidence.flatMap((e) => (e.image ? [[e.image, readImage(e.image)] as const] : [])).filter((x): x is [string, Img] => !!x[1]));
        c.analysis = await analyze(model, policy, c, images);
        c.finished_at = new Date().toISOString();
        save();
        if (coaching[2] === 'finish') return json(res, 200, sessionSummary(c));
      }
      // Training: everything it learned becomes the next version, and the agent follows it from now on.
      if (coaching[2] === 'train') {
        if (c.candidate) return json(res, 200, { session: sessionSummary(c), version: store.versions!.find((v) => v.id === c.candidate) ?? null });
        const proposals = c.analysis!.proposals;
        if (!proposals.length) return json(res, 200, { session: sessionSummary(c), version: null });
        const incumbent = store.versions!.find((v) => v.id === c.version) ?? championOf(site.id);
        const v: PolicyVersion = { id: id('pv'), site: site.id, n: Math.max(...versionsOf(site.id).map((x) => x.n)) + 1, rules: candidateRules(incumbent, c, proposals, () => id('rule')), parent: incumbent.id, session: c.id, created_at: new Date().toISOString() };
        store.versions!.push(v);
        c.candidate = v.id;
        store.policyChampions![site.id] = v.id;
        save();
        return json(res, 200, { session: sessionSummary(c), version: v });
      }
      // A candidate: the coached version with the proposals the player kept.
      if (!c.analysis) return json(res, 409, { error: 'Finish the session first.' });
      const picks = Array.isArray(body.proposals) ? body.proposals.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < c.analysis!.proposals.length) : [];
      if (!picks.length) return json(res, 400, { error: 'Keep at least one change.' });
      const incumbent = store.versions!.find((v) => v.id === c.version) ?? championOf(site.id);
      const v: PolicyVersion = { id: id('pv'), site: site.id, n: Math.max(...versionsOf(site.id).map((x) => x.n)) + 1, rules: candidateRules(incumbent, c, picks.map((i) => c.analysis!.proposals[i]!), () => id('rule')), parent: incumbent.id, session: c.id, created_at: new Date().toISOString() };
      store.versions!.push(v);
      c.candidate = v.id;
      save();
      return json(res, 200, v);
    }

    // ---- practice: two versions on the same photos, judged against the player's own coaching ----
    if (rest === '/practice/judge') {
      const a = store.versions!.find((v) => v.id === body.a && v.site === site.id);
      const b = store.versions!.find((v) => v.id === body.b && v.site === site.id);
      if (!a || !b) return json(res, 400, { error: 'Which two versions?' });
      const episodes = (Array.isArray(body.episodes) ? body.episodes : []).slice(0, 6) as { photo?: string; original?: Img; a?: Img; b?: Img; settings?: { a?: unknown; b?: unknown } }[];
      const settingsOf = (e: (typeof episodes)[number]) => (typeof e.settings?.a === 'string' && typeof e.settings.b === 'string' ? { a: e.settings.a.slice(0, 600), b: e.settings.b.slice(0, 600) } : undefined);
      if (!episodes.length || episodes.some((e) => !e?.original?.data || !e.a?.data || !e.b?.data)) return json(res, 400, { error: 'Send each photo: the original and both edits.' });
      // The standard is the player's own coaching, of whichever version is the newer, and everything before it.
      const lineage = new Set<string>();
      for (let v: PolicyVersion | undefined = b.n > a.n ? b : a; v; v = store.versions!.find((x) => x.id === v!.parent)) if (v.session) lineage.add(v.session);
      const standard = coachingStandard(store.sessions!.filter((c) => lineage.has(c.id)));
      const request = site.practice?.request ?? 'Edit this the way I like it.';
      const judged = await Promise.all(episodes.map((e) => judge(model, standard, { original: e.original!, a: e.a!, b: e.b! }, { a: `v${a.n}`, b: `v${b.n}` }, { request, settings: settingsOf(e) })));
      const p: Practice = {
        id: id('prac'),
        site: site.id,
        a: a.id,
        b: b.id,
        episodes: episodes.map((e, i) => ({ photo: String(e.photo ?? ''), original: saveImage(e.original)!, a: saveImage(e.a)!, b: saveImage(e.b)!, settings: settingsOf(e), ...judged[i]! })),
        created_at: new Date().toISOString(),
      };
      store.practices!.push(p);
      save();
      return json(res, 200, p);
    }
    const keep = /^\/practice\/(prac_[\w]+)\/keep$/.exec(rest);
    if (keep) {
      const p = store.practices!.find((x) => x.id === keep[1] && x.site === site.id);
      if (!p || (body.version !== p.a && body.version !== p.b)) return json(res, 400, { error: 'Keep one of the two versions it practiced.' });
      p.kept = body.version as string;
      store.policyChampions![site.id] = p.kept;
      save();
      return json(res, 200, p);
    }
    if (rest === '/policy/champion') {
      const v = store.versions!.find((x) => x.id === body.version && x.site === site.id);
      if (!v) return json(res, 404, { error: 'No such version.' });
      store.policyChampions![site.id] = v.id;
      save();
      return json(res, 200, { champion: v.id });
    }

    // The player's agent, using the app: one step (it sees the views, says what it's doing, moves the controls).
    if (rest === '/act') {
      if (typeof body.request !== 'string' || !body.request.trim()) return json(res, 400, { error: 'What should your agent do?' });
      if (typeof body.controls !== 'string') return json(res, 400, { error: "Send the page's controls." });
      const strings = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(-n).map((s) => s.slice(0, 400)) : []);
      const images = (Array.isArray(body.images) ? body.images : [])
        .filter((i): i is ActInput['images'][number] => !!i && typeof i === 'object' && typeof i.data === 'string' && /^image\/(jpeg|png|webp)$/.test(String(i.media_type)))
        .slice(0, 2)
        .map((i) => ({ label: String(i.label ?? 'the view').slice(0, 120), media_type: i.media_type, data: i.data }));
      const version = (typeof body.version === 'string' && store.versions!.find((v) => v.id === body.version && v.site === site.id)) || championOf(site.id);
      const practice = Number.isInteger(body.practice) ? { steps: Math.min(6, Math.max(1, body.practice as number)) } : undefined;
      const step = await act(model, { request: body.request.slice(0, 1000), page: String(body.page ?? '/'), controls: body.controls.slice(0, 20_000), images, history: strings(body.history, 12), player: strings(body.player, 20), changes: listChanges().map((c) => `${c.title}: ${c.why}`), policy: policyText(version), heard: strings(body.heard, 6), practice, pageText: typeof body.pageText === 'string' ? body.pageText.slice(0, 16_000) : undefined });
      if (practice) step.rework = null;
      return json(res, 200, step);
    }
    // The agent changes the app's code, when the app can't do what it needs.
    if (rest === '/rework') {
      if (!site.code) return json(res, 403, { error: `${site.name} doesn't share its code with Connect.` });
      if (typeof body.need !== 'string' || !body.need.trim()) return json(res, 400, { error: 'What does the app need?' });
      const r = await proposeRework(model, body.need.slice(0, 1000), code(site));
      const c: CodeChange = { id: `chg_${randomUUID().slice(0, 8)}`, site: site.id, title: r.title, why: r.why, need: body.need.slice(0, 1000), edits: r.edits, created_at: new Date().toISOString() };
      store.changes!.push(c);
      save();
      return json(res, 200, { id: c.id, title: c.title, why: c.why, created_at: c.created_at });
    }
    if (rest === '/rework/undo') {
      const last = changesOf(site.id).at(-1);
      if (!last) return json(res, 404, { error: 'There are no changes to undo.' });
      last.undone_at = new Date().toISOString();
      save();
      return json(res, 200, { undone: last.id, changes: listChanges() });
    }

    if (rest === '/variants') {
      const issues = checkPatches(body.patches);
      if (typeof body.title !== 'string' || !body.title.trim()) issues.push({ path: 'title', message: 'is required' });
      if (issues.length) return json(res, 400, { error: `The variant has ${issues.length} problem(s): ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, issues });
      const v: Variant = { id: `var_${randomUUID().slice(0, 8)}`, site: site.id, page: String(body.page ?? '/'), title: String(body.title), hypothesis: String(body.hypothesis ?? ''), author: { kind: 'player', name: 'you' }, patches: body.patches as Patch[], created_at: new Date().toISOString(), parent: (body.parent as string | null) ?? null };
      store.variants.push(v);
      save();
      return json(res, 200, v);
    }
    const applied = /^\/variants\/(var_[\w-]+)\/applied$/.exec(rest);
    if (applied) {
      const v = store.variants.find((x) => x.id === applied[1] && x.site === site.id);
      if (!v) return json(res, 404, { error: 'No such variant.' });
      v.skipped = Array.isArray(body.skipped) ? (body.skipped as PatchIssue[]).slice(0, 20) : [];
      save();
      return json(res, 200, { ok: true });
    }
    if (rest === '/champion') {
      store.champions[site.id] = typeof body.variant === 'string' ? body.variant : null;
      save();
      return json(res, 200, { champion: store.champions[site.id] });
    }
    const task = taskOf(body.task);
    if (!task) return json(res, 400, { error: 'Which task?' });
    const page = typeof body.page === 'string' ? body.page : task.page;
    if (typeof body.outline !== 'string' || !body.outline.trim()) return json(res, 400, { error: 'Send the page outline.' });

    if (rest === '/improve') {
      const parent = typeof body.parent === 'string' ? store.variants.find((v) => v.id === body.parent && v.site === site.id) ?? null : null;
      const list = variantsOf(site.id, page);
      const prompt = improverPrompt({ site: site.name, page, goal: task.goal, outline: body.outline, tried: tried(site, page, task.id), parent: parent ? { name: `v${list.indexOf(parent) + 1}`, patches: parent.patches } : null });
      const p = await propose(model, prompt);
      const v: Variant = { id: `var_${randomUUID().slice(0, 8)}`, site: site.id, page, title: p.title, hypothesis: p.hypothesis, author: { kind: 'agent', name: 'your agent' }, patches: p.patches, created_at: new Date().toISOString(), parent: parent?.id ?? null };
      store.variants.push(v);
      save();
      return json(res, 200, v);
    }
    if (rest === '/evaluate') {
      const variant = typeof body.variant === 'string' ? body.variant : null;
      const answers = await firstClicks(model, task.goal, body.outline, (body.matches ?? {}) as Record<string, string[]>, (body.labels ?? {}) as Record<string, string>, task.id);
      const r: Result = { id: `res_${randomUUID().slice(0, 8)}`, site: site.id, page, task: task.id, variant, hits: answers.filter((a) => a.hit).length, n: answers.length, answers, created_at: new Date().toISOString() };
      store.results.push(r);
      save();
      return json(res, 200, r);
    }
    return json(res, 404, { error: `No ${rest}.` });
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('vary', 'origin');
    }
    try {
      if (req.method === 'OPTIONS') return res.writeHead(origin && origins.has(origin) ? 204 : 403).end();
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && !(origin && origins.has(origin)) && origin !== undefined) return json(res, 403, { error: 'Not from a site on Softmax Connect.' });
        return await api(req, res, url);
      }
      if (url.pathname === '/connect.js') {
        res.setHeader('content-type', 'text/javascript');
        res.setHeader('cache-control', 'no-store');
        return res.end(await bundle());
      }
      if (url.pathname === '/brandmark.svg') {
        res.setHeader('content-type', 'image/svg+xml');
        return res.end(readFileSync(path.join(PKG, 'server/assets/brandmark.svg')));
      }
      const font = /^\/fonts\/(ibm-plex-(sans|mono)-latin-\d00-normal)\.woff2$/.exec(url.pathname);
      if (font) {
        res.setHeader('content-type', 'font/woff2');
        res.setHeader('access-control-allow-origin', '*');
        return res.end(readFileSync(require.resolve(`@fontsource/ibm-plex-${font[2]}/files/${font[1]}.woff2`)));
      }
      json(res, 404, { error: 'Not found.' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  return { handler, store, sites, code, dataDir };
}

const TEXT = new Set(['.html', '.css', '.js']);

/** A site's own code files (what an agent may change), as they are on disk. */
export function siteFiles(site: SiteConfig): Record<string, string> {
  const dir = path.join(PKG, 'sites', site.dir);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => TEXT.has(path.extname(f)))
      .sort()
      .map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]),
  );
}

/** A sample site: its files, and any other path a tiny page saying the visitor got there (where a task ends). */
export function siteHandler(site: SiteConfig, connectUrl: string, code?: () => Record<string, string>, api?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>) {
  const dir = path.join(PKG, 'sites', site.dir);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (api && (await api(req, res, url))) return;
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // The site's own server code isn't served.
    if (name.startsWith('server/')) {
      res.statusCode = 404;
      return res.end('Not found.');
    }
    const fileName = path.join(dir, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
    const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
    if (fileName.startsWith(dir) && existsSync(fileName) && statSync(fileName).isFile()) {
      res.setHeader('content-type', types[path.extname(fileName)] ?? 'application/octet-stream');
      // The code as the agent has changed it, for sites that share theirs; never cached, so a change shows on reload.
      const changed = code && path.dirname(fileName) === dir ? code()[path.basename(fileName)] : undefined;
      // Pages (and changed code) never cached: a reload always gets the current page and the current connect.js.
      if (changed !== undefined || path.extname(fileName) === '.html') res.setHeader('cache-control', 'no-store');
      const content = changed !== undefined ? Buffer.from(changed) : readFileSync(fileName);
      return res.end(path.extname(fileName) === '.html' ? content.toString('utf8').replaceAll('{{CONNECT}}', connectUrl) : content);
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><meta charset="utf-8"><title>${site.name}</title><link rel="stylesheet" href="/site.css"><main class="landed"><h1>${url.pathname}</h1><p>You got to <code>${url.pathname}${url.search}</code> on ${site.name}. (A sample site: this is where that link goes.)</p><p><a href="/">Back</a></p></main>`);
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.CONNECT_PORT ?? 7460);
  const connect = createConnect();
  const servers: Server[] = [createServer(connect.handler).listen(port, '127.0.0.1')];
  console.log(`Softmax Connect on http://localhost:${port} (connect.js, the API)`);
  for (const site of connect.sites) {
    servers.push(createServer(siteHandler(site, `http://localhost:${port}`, site.code ? () => connect.code(site) : undefined, site.api?.(connect.dataDir))).listen(site.port, '127.0.0.1'));
    console.log(`  ${site.name}: http://localhost:${site.port}`);
  }
}
