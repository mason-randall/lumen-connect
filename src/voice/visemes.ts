/**
 * Talking avatars. Polyworld has no visemes; its mouths are swappable textured decals, so speech is driven by text:
 * each character maps to a mouth shape, paced at reading speed and smoothed so the mouth never strobes. A speaking
 * set (closed, open, round, wide) is picked to match the recipe's mouth style. Pure; a renderer plays the result.
 */

/** `rest` is the recipe's own mouth; the others come from the speaking set. */
export type MouthShape = 'rest' | 'closed' | 'open' | 'round' | 'wide';
export type SpeakingShape = Exclude<MouthShape, 'rest'>;

export interface Viseme {
  shape: MouthShape;
  ms: number;
  /** Stressed (an ALL-CAPS word or one ending in `!`); open shapes become `wide`. */
  emphasis?: boolean;
  /** Last word of a question. */
  question?: boolean;
  /** Last word of a statement or exclamation. */
  final?: boolean;
}

export interface VisemeOptions {
  /** Reading pace; about 14 characters per second by default. */
  charsPerSecond?: number;
  /** Shortest time a shape stays up, so the mouth does not strobe. */
  minHoldMs?: number;
  /** Pause for `,` `;` `:`. */
  commaMs?: number;
  /** Pause for `.` `!` `?` and line breaks, with the mouth back at rest. */
  stopMs?: number;
  /**
   * Keep up with the text, for a reply shown as it streams in: while text is coming, never more than about this far
   * (ms) behind the newest whole word; once it has ended, done within `END_LAG_MS`. A little behind, it talks faster
   * (up to `KEEP_UP_SPEEDUP`); further, it skips ahead to the newest words. So it talks while the text appears and
   * stops when the text stops. 0 (the default) says everything at its own pace.
   */
  maxLagMs?: number;
}

const DEFAULTS = { charsPerSecond: 14, minHoldMs: 70, commaMs: 150, stopMs: 350, maxLagMs: 0 } as const;
/** The most a stream that keeps up speeds up before it skips ahead instead. */
export const KEEP_UP_SPEEDUP = 2.2;
/** A stream that keeps up finishes this soon (ms) after its text ends. */
export const END_LAG_MS = 250;
const MAX_REST_MS = 600;

const isLetter = (ch: string) => /\p{L}|\p{N}/u.test(ch);

function letterShape(ch: string): SpeakingShape {
  const c = ch.toLowerCase();
  if ('mbp'.includes(c)) return 'closed';
  if ('ouw'.includes(c)) return 'round';
  return 'open';
}

/** Visemes for one word (letters only), with stress and sentence-end marks. */
function wordVisemes(word: string, charMs: number, mark: { emphasis: boolean; question: boolean; final: boolean }): Viseme[] {
  const out: Viseme[] = [];
  for (const ch of word) {
    if (!isLetter(ch)) continue;
    let shape: MouthShape = letterShape(ch);
    if (mark.emphasis && shape === 'open') shape = 'wide';
    out.push({
      shape,
      ms: charMs,
      ...(mark.emphasis ? { emphasis: true } : {}),
      ...(mark.question ? { question: true } : {}),
      ...(mark.final ? { final: true } : {}),
    });
  }
  return out;
}

/**
 * Merges runs of one shape and keeps every shape up at least `minHoldMs`: a too-short shape absorbs the shapes after
 * it until it is long enough (so fast speech alternates every couple of letters instead of strobing), and a short
 * shape just before a pause is folded into the pause. Total time is preserved.
 */
export function smoothVisemes(visemes: readonly Viseme[], minHoldMs: number = DEFAULTS.minHoldMs): Viseme[] {
  const out: Viseme[] = [];
  const extend = (into: Viseme, v: Viseme) => {
    into.ms = into.shape === 'rest' && v.shape === 'rest' ? Math.min(into.ms + v.ms, Math.max(MAX_REST_MS, into.ms)) : into.ms + v.ms;
    if (v.emphasis) into.emphasis = true;
    if (v.question) into.question = true;
    if (v.final) into.final = true;
  };
  for (const input of visemes) {
    if (input.ms <= 0) continue;
    const v = { ...input };
    let last = out[out.length - 1];
    if (v.shape === 'rest' && last && last.shape !== 'rest' && last.ms < minHoldMs) {
      v.ms += last.ms;
      out.pop();
      last = out[out.length - 1];
    }
    if (last && last.shape === v.shape) extend(last, v);
    else if (last && last.ms < minHoldMs && v.shape !== 'rest') extend(last, v);
    else out.push(v);
  }
  const first = out[0];
  if (first && out.length > 1 && first.ms < minHoldMs) {
    out[1]!.ms += first.ms;
    out.shift();
  }
  const tail = out[out.length - 1];
  if (tail && out.length > 1 && tail.ms < minHoldMs) {
    out[out.length - 2]!.ms += tail.ms;
    out.pop();
  }
  return out;
}

/**
 * Turns text that arrives in pieces (a model's streamed reply) into visemes. A word is only spoken once it is
 * complete, because stress (`!`, ALL CAPS) and sentence ends (`.` `?`) are only known after it.
 */
export class VisemeStream {
  private buffer = '';
  private ended = false;
  private ready: Viseme[] = [];
  private readonly charMs: number;
  private readonly options: Required<VisemeOptions>;

  constructor(options: VisemeOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.charMs = 1000 / Math.max(this.options.charsPerSecond, 1);
  }

  push(text: string): void {
    if (this.ended) return;
    this.buffer += text;
    this.drain(false);
  }

  end(): void {
    this.ended = true;
    this.drain(true);
  }

  /** The next viseme, or null when none is ready (starved mid-stream, or finished). */
  take(): Viseme | null {
    if (this.options.maxLagMs <= 0) return this.ready.shift() ?? null;
    const lag = this.ended ? Math.min(this.options.maxLagMs, END_LAG_MS) : this.options.maxLagMs;
    // Nothing comes after the last word: no pause to hold at the end.
    if (this.ended) while (this.ready.at(-1)?.shape === 'rest') this.ready.pop();
    // How far behind it is: the speech still to say (its pauses shrink with it, but don't count).
    let behind = this.queuedMs;
    // Further behind than talking faster can make up: skip to the newest words.
    while (this.ready.length > 1 && behind > lag * KEEP_UP_SPEEDUP) {
      const skipped = this.ready.shift()!;
      if (skipped.shape !== 'rest') behind -= skipped.ms;
    }
    const v = this.ready.shift();
    if (!v) return null;
    const speed = Math.min(KEEP_UP_SPEEDUP, Math.max(1, behind / lag));
    return speed > 1 ? { ...v, ms: v.ms / speed } : v;
  }

  /** How long the speech that's ready would take to say at its own pace (ms), not counting its pauses. */
  get queuedMs(): number {
    return this.ready.reduce((sum, v) => (v.shape === 'rest' ? sum : sum + v.ms), 0);
  }

  /** Ended and fully played out. */
  get done(): boolean {
    return this.ended && this.ready.length === 0;
  }

  get pending(): number {
    return this.ready.length;
  }

  private drain(final: boolean): void {
    const out: Viseme[] = [];
    let i = 0;
    const text = this.buffer;
    while (i < text.length) {
      const ch = text[i]!;
      if (isLetter(ch) || ch === "'" || ch === '’') {
        let j = i;
        while (j < text.length && (isLetter(text[j]!) || text[j] === "'" || text[j] === '’')) j++;
        if (j >= text.length && !final) break;
        const word = text.slice(i, j);
        const next = text[j];
        const letters = [...word].filter(isLetter).join('');
        const shouted = letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
        out.push(...wordVisemes(word, this.charMs, { emphasis: shouted || next === '!', question: next === '?', final: next === '.' || next === '!' }));
        i = j;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '-') out.push({ shape: 'closed', ms: this.charMs });
      else if (ch === ',' || ch === ';' || ch === ':') out.push({ shape: 'rest', ms: this.options.commaMs });
      else if (ch === '.' || ch === '!' || ch === '?' || ch === '\n' || ch === '…') out.push({ shape: 'rest', ms: this.options.stopMs });
      i++;
    }
    this.buffer = text.slice(i);
    if (final && this.buffer) this.buffer = '';
    if (!out.length) return;
    const tail = this.ready[this.ready.length - 1];
    const joined = smoothVisemes(tail ? [tail, ...out] : out, this.options.minHoldMs);
    if (tail) this.ready.pop();
    this.ready.push(...joined);
  }
}

/** Visemes for a whole text at once. */
export function textToVisemes(text: string, options: VisemeOptions = {}): Viseme[] {
  const stream = new VisemeStream(options);
  stream.push(text);
  stream.end();
  const out: Viseme[] = [];
  for (let v = stream.take(); v; v = stream.take()) out.push(v);
  return out;
}

/** FNV-1a → mulberry32: a small deterministic random source per avatar. */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An endless, pleasant generic cadence for `talking` without text: syllables in phrases with breaths between. */
export function* babble(seed: string): Generator<Viseme> {
  const random = seededRandom(`babble:${seed}`);
  const shapes: SpeakingShape[] = ['open', 'closed', 'open', 'round', 'open', 'closed'];
  for (;;) {
    const syllables = 4 + Math.floor(random() * 8);
    for (let s = 0; s < syllables; s++) {
      yield { shape: shapes[Math.floor(random() * shapes.length)]!, ms: 90 + Math.round(random() * 90) };
      if (random() < 0.25) yield { shape: 'closed', ms: 70 + Math.round(random() * 40) };
    }
    yield { shape: 'rest', ms: 280 + Math.round(random() * 320) };
  }
}

/** Seconds until the next blink (2–6 s), and whether it is a double blink (about one in six). */
export function nextBlink(random: () => number): { inSeconds: number; double: boolean } {
  return { inSeconds: 2 + random() * 4, double: random() < 0.16 };
}

/** Eye squash for a blink `t` seconds in: closes over 45 ms, holds 30 ms, opens over 45 ms (about 120 ms). */
export function blinkSquash(t: number): number {
  if (t <= 0 || t >= 0.12) return 0;
  if (t < 0.045) return t / 0.045;
  if (t < 0.075) return 1;
  return 1 - (t - 0.075) / 0.045;
}

