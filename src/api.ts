/** Talking to Softmax Connect: the site's tasks, its variants and their scores, and asking for an improvement or a test. */
import type { Patch, PatchIssue, Variant } from './patches.ts';

export interface Task {
  id: string;
  page: string;
  /** What a visitor is here to do. */
  goal: string;
  /** What reaching it means: a selector for the element(s) that get them there. The owner's; visitors never see it. */
  success: string;
}

export interface Site {
  id: string;
  name: string;
  tasks: Task[];
  /** The variant the owner ships to everyone (else the original). */
  champion: string | null;
  /** Where its agent practices a policy: photos it hasn't seen, and one request for all. */
  practice: { request: string; files: string[]; home?: string; noun?: string } | null;
}

export interface Answer {
  persona: string;
  click: string;
  /** What they clicked, in words. */
  clicked: string;
  why: string;
  hit: boolean;
}

export interface Result {
  id: string;
  variant: string | null;
  task: string;
  hits: number;
  n: number;
  answers: Answer[];
  created_at: string;
}

export interface Scored extends Variant {
  /** Every visitor test it's had, for the task: hits over visitors. */
  score: { hits: number; n: number } | null;
  latest: Result | null;
}

export interface Board {
  original: { score: Scored['score']; latest: Result | null };
  variants: Scored[];
}

/** One step of the player's agent using the app (server/operator.ts). */
export interface Step {
  say: string;
  look: { view: string; region: number[] | null } | null;
  actions: ({ ref: string; value: string | number | boolean } | { ref: string; press: true } | { ref: string; point: true })[];
  done: boolean;
  rework: string | null;
  /** Each model call the step took, as measured on the server: tokens read (and read from the cache), written, and how long. */
  calls?: { prefill: number; cached: number; output: number; dur_ms: number }[];
}

export interface Overlay {
  here: string;
  apps: { id: string; name: string; origin: string; here: boolean; does: string[] }[];
  policies: {
    app: string;
    appName: string;
    inUse: { n: number; rules: { layer: string; text: string }[]; created_at: string; fromLesson: boolean };
    versions: { n: number; rules: number; inUse: boolean; created_at: string }[];
    lessons: number;
  }[];
  friends: { name: string; agent: string; presence: 'in-app' | 'online' | 'away' | 'offline'; doing: string; where?: { app?: string; coworld?: string }; hue: number }[];
  /** Which parts are sample data (not yet real). */
  samples: string[];
}

export interface CodeChange {
  id: string;
  title: string;
  why: string;
  created_at: string;
}

// ---- policies (server/policies.ts) ----

export type Layer = 'situation' | 'belief' | 'goal' | 'skill' | 'strategy' | 'execution' | 'update';

export interface Rule {
  id: string;
  layer: Layer;
  text: string;
  evidence: string[];
}

export interface PolicyVersion {
  id: string;
  n: number;
  rules: Rule[];
  parent: string | null;
  session: string | null;
  created_at: string;
}

export interface EvidenceIn {
  id: string;
  t: number;
  kind: 'speech' | 'note' | 'move' | 'mark' | 'ask' | 'agent';
  text: string;
  image?: { media_type: string; data: string };
}

export interface Proposal {
  layer: Layer;
  change: string;
  rationale: string;
  verification: string;
  evidence_ids: string[];
  replaces: string | null;
}

export interface Analysis {
  summary: string;
  moments: { t: number; observation: string; intent: string; uncertainty: string; evidence_ids: string[] }[];
  proposals: Proposal[];
  questions: string[];
}

export interface SessionSummary {
  id: string;
  version: string;
  started_at: string;
  finished_at: string | null;
  evidence: number;
  items: { id: string; t: number; kind: EvidenceIn['kind']; text: string; image?: string }[];
  analysis: Analysis | null;
  candidate: string | null;
  /** Its screen recording (with the voice) was kept. */
  recording?: boolean;
}

export interface Practice {
  id: string;
  a: string;
  b: string;
  episodes: { photo: string; original: string; a: string; b: string; settings?: { a: string; b: string }; winner: 'a' | 'b' | 'tie'; why: string }[];
  created_at: string;
  kept?: string;
}

export interface PolicyState {
  champion: string;
  versions: PolicyVersion[];
  sessions: SessionSummary[];
  practices: Practice[];
}

type Img = { media_type: string; data: string };

export class ConnectApi {
  constructor(
    readonly base: string,
    readonly site: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}/api/sites/${encodeURIComponent(this.site)}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: PatchIssue[] };
    if (!res.ok) throw new Error(body.error ?? `${res.status} from Softmax Connect`);
    return body;
  }

  siteInfo = () => this.req<Site>('');
  board = (page: string, task: string) => this.req<Board>(`/board?page=${encodeURIComponent(page)}&task=${encodeURIComponent(task)}`);
  improve = (input: { page: string; task: string; parent: string | null; outline: string }) => this.req<Variant>('/improve', { method: 'POST', body: JSON.stringify(input) });
  evaluate = (input: { page: string; task: string; variant: string | null; outline: string; matches: Record<string, string[]>; labels: Record<string, string> }) =>
    this.req<Result>('/evaluate', { method: 'POST', body: JSON.stringify(input) });
  report = (variant: string, skipped: PatchIssue[]) => this.req<{ ok: true }>(`/variants/${encodeURIComponent(variant)}/applied`, { method: 'POST', body: JSON.stringify({ skipped }) });
  champion = (variant: string | null) => this.req<{ champion: string | null }>('/champion', { method: 'POST', body: JSON.stringify({ variant }) });
  act = (input: { request: string; page: string; controls: string; images: { label: string; media_type: string; data: string }[]; history: string[]; player: string[]; heard?: string[]; version?: string; practice?: number; pageText?: string }) =>
    this.req<Step>('/act', { method: 'POST', body: JSON.stringify(input) });
  changes = () => this.req<{ changes: CodeChange[] }>('/changes');
  rework = (need: string) => this.req<CodeChange>('/rework', { method: 'POST', body: JSON.stringify({ need }) });
  undoChange = () => this.req<{ undone: string; changes: CodeChange[] }>('/rework/undo', { method: 'POST', body: '{}' });
  policy = () => this.req<PolicyState>('/policy');
  /** What the Softmax overlay shows (server/overlay.ts). */
  overlay = () => this.req<Overlay>('/overlay');
  imageUrl = (name: string) => `${this.base}/api/sites/${encodeURIComponent(this.site)}/images/${encodeURIComponent(name)}`;
  startCoaching = () => this.req<SessionSummary>('/coaching', { method: 'POST', body: '{}' });
  sendEvidence = (session: string, evidence: EvidenceIn[]) => this.req<SessionSummary>(`/coaching/${session}/evidence`, { method: 'POST', body: JSON.stringify({ evidence }) });
  finishCoaching = (session: string) => this.req<SessionSummary>(`/coaching/${session}/finish`, { method: 'POST', body: '{}' });
  /** Ends a teaching session: what it learned becomes the next version, which the agent follows from now on (null: nothing new). */
  train = (session: string) => this.req<{ session: SessionSummary; version: PolicyVersion | null }>(`/coaching/${session}/train`, { method: 'POST', body: '{}' });
  uploadRecording = (session: string, recording: Blob) =>
    fetch(`${this.base}/api/sites/${encodeURIComponent(this.site)}/coaching/${session}/recording`, { method: 'POST', headers: { 'content-type': recording.type || 'video/webm' }, body: recording }).then((r) => r.ok);
  recordingUrl = (session: string) => `${this.base}/api/sites/${encodeURIComponent(this.site)}/recordings/${encodeURIComponent(session)}`;
  makeCandidate = (session: string, proposals: number[]) => this.req<PolicyVersion>(`/coaching/${session}/candidate`, { method: 'POST', body: JSON.stringify({ proposals }) });
  judge = (input: { a: string; b: string; episodes: { photo: string; original: Img; a: Img; b: Img; settings: { a: string; b: string } }[] }) => this.req<Practice>('/practice/judge', { method: 'POST', body: JSON.stringify(input) });
  keep = (practice: string, version: string) => this.req<Practice>(`/practice/${practice}/keep`, { method: 'POST', body: JSON.stringify({ version }) });
  setChampion = (version: string) => this.req<{ champion: string }>('/policy/champion', { method: 'POST', body: JSON.stringify({ version }) });
  propose = (input: { page: string; title: string; hypothesis: string; patches: Patch[]; parent: string | null }) => this.req<Variant>('/variants', { method: 'POST', body: JSON.stringify(input) });
}
