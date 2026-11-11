/**
 * Your agent, as measured: each model call's tokens read (and read from the cache) and written, how long it took, the
 * tools it called and when they came back, whether it's awake. This keeps that record of your agent using a page, a
 * step at a time, and carries it on to what it does there:
 *
 * - **vision**: each picture it's sent: its pixels, what they cost it in tokens (est.: w·h/750, Anthropic's rule for
 *   images), and how close it looked (a close-up of a quarter of the view is 2× closer);
 * - **touch**: each control it moves: how far (the share of a slider's range it crossed; a switch, a choice or a press
 *   is a whole move) and for how long its hands were on it;
 * - **tools**: each of those moves is a tool call: called when the model answers, done when its hands come off, its
 *   result what it says it did (tokens est. as characters/4);
 * - **computer use**: the loop itself: each step's time looking (taking the pictures), thinking (waiting on the model),
 *   and acting (its hands on the page, and its voice).
 *
 * Times are the page's clock (performance.now, ms). Every number here was measured on the page or by the server; the
 * estimates say so.
 */
import type { Step } from '../api.ts';

export interface CallFacts {
  /** When the call started, and how long it took (end to end, as the server timed it). */
  t: number;
  dur_ms: number;
  /** Tokens read: everything sent (input, cache writes and cache reads), and how many of those came from the cache. */
  prefill: number;
  cached: number;
  /** Tokens written. */
  output: number;
}

export interface PictureFacts {
  t: number;
  width: number;
  height: number;
  /** est.: width × height / 750. */
  tokens: number;
  /** How much closer than the whole view (1 for the whole view; a close-up of a quarter of it is 2). */
  zoom: number;
}

export type MoveName = 'set' | 'press' | 'point';

export interface MoveFacts {
  name: MoveName;
  label: string;
  /** Hands on, and off. */
  t: number;
  done: number;
  /** How far it moved the control: a share of a slider's range; 1 for a switch, a choice, or a press; 0 for pointing. */
  travel: number;
  /** est.: what it says it did, in characters/4. */
  tokens: number;
}

export interface StepFacts {
  /** Started looking; sent to the model; the model answered; done acting (and saying). */
  t: number;
  sent: number;
  answered: number;
  end: number;
  calls: CallFacts[];
  pictures: PictureFacts[];
  moves: MoveFacts[];
}

export type Presence = 'asleep' | 'waking' | 'awake' | 'failed';

/** est. tokens for a picture (Anthropic: tokens ≈ width × height / 750). */
export const pictureTokens = (width: number, height: number) => Math.ceil((width * height) / 750);

/** Some steps' measures (a request's, say), for showing: their tokens and times, and the four channels they carry on to. */
export function measure(steps: StepFacts[]) {
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const calls = steps.flatMap((s) => s.calls), pictures = steps.flatMap((s) => s.pictures), moves = steps.flatMap((s) => s.moves);
  const read = sum(calls, (c) => c.prefill), cached = sum(calls, (c) => c.cached), wrote = sum(calls, (c) => c.output);
  const thinking = sum(calls, (c) => c.dur_ms);
  const seen = sum(pictures, (p) => p.tokens);
  const handsOn = sum(moves, (m) => m.done - m.t);
  const travel = sum(moves, (m) => m.travel);
  return {
    steps: steps.length,
    span_ms: steps.length ? steps.at(-1)!.end - steps[0]!.t : 0,
    tokens: { read, cached, fresh: read - cached, wrote, thinking_ms: thinking, writeRate: thinking > 0 ? wrote / (thinking / 1000) : 0 },
    vision: { pictures: pictures.length, tokens: seen, pixels: sum(pictures, (p) => p.width * p.height), zoom: Math.max(1, ...pictures.map((p) => p.zoom)), share: read - cached > 0 ? Math.min(1, seen / (read - cached)) : 0 },
    touch: { moves: moves.filter((m) => m.travel > 0).length, travel, handsOn_ms: handsOn, rate: handsOn > 0 ? travel / (handsOn / 1000) : 0 },
    tools: { calls: moves.length, mean_ms: moves.length ? handsOn / moves.length : 0, resultTokens: sum(moves, (m) => m.tokens) },
    loop: { looking_ms: sum(steps, (s) => s.sent - s.t), thinking_ms: sum(steps, (s) => s.answered - s.sent), acting_ms: sum(steps, (s) => s.end - s.answered) },
  };
}
export type Measures = ReturnType<typeof measure>;

/** The record, as it's made: a step at a time (begun, sent, answered, its moves, done), and the agent's presence. */
export class Ledger {
  steps: StepFacts[] = [];
  /** The steps of the request it's on (or was on last). */
  request: StepFacts[] = [];
  presence: Presence = 'asleep';
  private open: StepFacts | null = null;
  private listeners = new Set<(e: { step: StepFacts } | { presence: Presence; at: number }) => void>();

  on(f: (e: { step: StepFacts } | { presence: Presence; at: number }) => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(e: { step: StepFacts } | { presence: Presence; at: number }) {
    for (const f of this.listeners) f(e);
  }

  setPresence(p: Presence) {
    if (p === this.presence) return;
    this.presence = p;
    this.emit({ presence: p, at: performance.now() });
  }

  /** A new request: its steps start here. */
  newRequest() {
    this.request = [];
  }

  /** It starts looking. */
  begin() {
    const now = performance.now();
    this.open = { t: now, sent: now, answered: now, end: now, calls: [], pictures: [], moves: [] };
  }

  picture(width: number, height: number, zoom = 1) {
    this.open?.pictures.push({ t: performance.now(), width, height, tokens: pictureTokens(width, height), zoom });
  }

  sent() {
    if (this.open) this.open.sent = performance.now();
  }

  /** The model answered: its calls as the server measured them, laid back to back so the last ends now. */
  answered(calls: Step['calls']) {
    const s = this.open;
    if (!s) return;
    s.answered = performance.now();
    let end = s.answered;
    s.calls = [...(calls ?? [])].reverse().map((c) => {
      const dur = Math.max(1, Math.min(c.dur_ms, end - s.sent));
      end -= dur;
      return { t: end, dur_ms: dur, prefill: c.prefill, cached: c.cached, output: c.output };
    }).reverse();
  }

  /** Its hands on a control; call the result when they come off, with what it did. */
  move(name: MoveName, label: string, travel: number) {
    const m: MoveFacts = { name, label, t: performance.now(), done: 0, travel: Math.max(0, Math.min(1, travel)), tokens: 0 };
    this.open?.moves.push(m);
    return (did: string) => {
      m.done = performance.now();
      m.tokens = Math.ceil(did.length / 4);
    };
  }

  /** Done acting (and saying it): the step goes on the record. A step the model never answered isn't one. */
  end() {
    const s = this.open;
    this.open = null;
    if (!s || !s.calls.length) return;
    s.end = performance.now();
    for (const m of s.moves) m.done ||= s.end;
    this.steps.push(s);
    this.request.push(s);
    if (this.steps.length > 200) this.steps.shift();
    this.emit({ step: s });
  }

  get last(): StepFacts | null {
    return this.steps.at(-1) ?? null;
  }
}
