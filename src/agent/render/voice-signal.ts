/**
 * The agent's voice as a signal, for voice mode's lines: every syllable rendered with the same synth the speaker plays
 * (`renderSyllable`, the agent's own voice profile), split into bands with filters, and played out in time with the
 * speech. What the lines draw is that signal, not an illustration of it:
 *
 * - low: the fundamental (the voice's pitch itself), a low-pass a little above the voice's base pitch;
 * - mid: the first formant, the vowel (a band around 560 Hz);
 * - high: the second formant, the brightness (a band around 1500 Hz);
 *
 * (each a fourth-order filter, so the bands come out clean);
 * - pitch: the fundamental's frequency over time, measured from each syllable (start and end) with YIN.
 *
 * It renders its own samples rather than tapping the speakers, so it shows the voice even when sound is off.
 */
import { renderSyllable, type BabbleShape, type SyllableOptions, type VoiceProfile } from '../../voice/index.ts';

export const RATE = 16000;
/** How much signal is kept to draw (samples): the longest trace plus room to find its trigger. */
const HISTORY = 2048;
/** The pitch trace: one point every 10 ms, the last 1.6 s. */
const PITCH_STEP = RATE / 100;
export const PITCH_POINTS = 160;

export type BandName = 'low' | 'mid' | 'high';
const BAND_NAMES: BandName[] = ['low', 'mid', 'high'];

/** A biquad (RBJ cookbook), keeping its state between syllables so the bands run continuously. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  constructor(kind: 'lowpass' | 'bandpass', hz: number, q: number) {
    this.set(kind, hz, q);
  }

  set(kind: 'lowpass' | 'bandpass', hz: number, q: number) {
    const w = (2 * Math.PI * hz) / RATE;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    if (kind === 'lowpass') {
      this.b0 = (1 - cos) / 2 / a0;
      this.b1 = (1 - cos) / a0;
      this.b2 = (1 - cos) / 2 / a0;
    } else {
      this.b0 = alpha / a0;
      this.b1 = 0;
      this.b2 = -alpha / a0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * A band: two biquads in a row (fourth order), so each band is clean: the fundamental comes out round, without its
 * harmonics' kinks, and the formant bands without the neighbouring harmonics' spikes.
 */
class Filter {
  private readonly first: Biquad;
  private readonly second: Biquad;

  constructor(kind: 'lowpass' | 'bandpass', hz: number, q: number) {
    this.first = new Biquad(kind, hz, q);
    this.second = new Biquad(kind, hz, q);
  }

  set(kind: 'lowpass' | 'bandpass', hz: number, q: number) {
    this.first.set(kind, hz, q);
    this.second.set(kind, hz, q);
  }

  process(x: number): number {
    return this.second.process(this.first.process(x));
  }
}

function filters(lowHz: number): Record<BandName, Filter> {
  return { low: new Filter('lowpass', lowHz, 0.6), mid: new Filter('bandpass', 560, 1.1), high: new Filter('bandpass', 1500, 1.3) };
}

/** Where the fundamental sits: a little above the voice's base pitch (and its questions' lift), below its harmonics. */
const lowCutoff = (pitchHz: number) => Math.min(640, Math.max(160, pitchHz * 1.45));

/** A small seeded random, for the synth's per-syllable wobble and the noise floor. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fundamental's frequency in a stretch of signal (Hz, 0 when silent or unpitched), by YIN: the lag at which the
 * signal best repeats itself, normalized so a harmonic can't pass for the fundamental.
 */
export function measurePitch(samples: Float32Array, from: number, to: number, range: [number, number] = [70, 900]): number {
  const minLag = Math.floor(RATE / range[1]);
  const maxLag = Math.min(Math.ceil(RATE / range[0]), Math.floor((to - from) / 2));
  if (maxLag <= minLag) return 0;
  const span = to - from - maxLag;
  let energy = 0;
  for (let i = from; i < from + span; i++) energy += samples[i]! * samples[i]!;
  if (energy / span < 1e-5) return 0;
  let running = 0;
  let best = 0;
  let bestScore = Infinity;
  const score = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let d = 0;
    for (let i = from; i < from + span; i++) {
      const diff = samples[i]! - samples[i + lag]!;
      d += diff * diff;
    }
    running += d;
    score[lag] = running ? (d * lag) / running : 1;
    if (lag >= minLag && score[lag]! < bestScore) {
      bestScore = score[lag]!;
      best = lag;
    }
  }
  // The first dip under the threshold is the fundamental (later dips are its multiples). With none that clear, the
  // deepest dip, unless one at half its lag is nearly as deep (then the deepest was an octave down).
  const dip = score.findIndex((v, lag) => lag >= minLag && lag < maxLag && v < 0.15 && v <= score[lag + 1]!);
  if (dip > 0) best = dip;
  else {
    const halfLag = Math.round(best / 2);
    for (let lag = Math.max(minLag, halfLag - 2); lag <= halfLag + 2; lag++) if (score[lag]! < score[best]! * 1.5 + 0.05) best = lag;
  }
  if (score[best]! > 0.5) return 0;
  // Between samples: a parabola through the dip and its neighbours.
  const [a, b, c] = [score[best - 1] ?? score[best]!, score[best]!, score[best + 1] ?? score[best]!];
  const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0;
  return RATE / (best + Math.max(-0.5, Math.min(0.5, shift)));
}

interface Queued {
  bands: Record<BandName, Float32Array>;
  read: number;
  /** Measured pitch at the syllable's start and end, relative to the voice's base (0 = unvoiced). */
  pitch: [number, number];
  /** Where its sound ends (samples): past that, the syllable's silence. */
  voiced: number;
}

export class VoiceSignal {
  private bands: Record<BandName, Filter> = filters(lowCutoff(220));
  /** The noise floor goes through its own copy of the bands, so it never disturbs the voice's filters. */
  private readonly noiseBands: Record<BandName, Filter> = filters(lowCutoff(220));
  private readonly history: Record<BandName, Float32Array> = { low: new Float32Array(HISTORY), mid: new Float32Array(HISTORY), high: new Float32Array(HISTORY) };
  private write = 0;
  private queue: Queued[] = [];
  private readonly random = mulberry(0x50f7);
  private base = 220;
  /** The pitch trace, oldest first: pitch relative to base, 0 where it wasn't voiced. */
  private readonly trail = new Float32Array(PITCH_POINTS).fill(1);
  private trailAt = 0;
  private sinceStep = 0;
  /** The pitch now (relative to the voice's base; 1 = its base) and how voiced it is now (0..1). */
  pitch = 1;
  voicing = 0;
  /** The pitch as heard: it glides to each syllable's (over ~25 ms) instead of jumping. */
  private heard = 1;

  /** A syllable to play out next: rendered with the voice, filtered into bands, its pitch measured. */
  syllable(shape: BabbleShape, ms: number, voice: VoiceProfile, options: SyllableOptions) {
    if (voice.pitchHz !== this.base) {
      this.base = voice.pitchHz;
      this.bands.low.set('lowpass', lowCutoff(voice.pitchHz), 0.6);
      this.noiseBands.low.set('lowpass', lowCutoff(voice.pitchHz), 0.6);
    }
    const raw = renderSyllable(shape, ms, voice, options, this.random, RATE);
    const bands = { low: new Float32Array(raw.length), mid: new Float32Array(raw.length), high: new Float32Array(raw.length) };
    for (let i = 0; i < raw.length; i++) for (const b of BAND_NAMES) bands[b][i] = this.bands[b].process(raw[i]!);
    // Where the blip ends: the last sample with sound in it.
    let voiced = raw.length;
    while (voiced > 0 && Math.abs(raw[voiced - 1]!) < 1e-4) voiced--;
    // Pitch at its start (past the first 8 ms, while the attack and the vowel's resonances come up) and at its end,
    // each over enough signal for two of its slowest periods, looking from 0.6× to 2× the voice's base.
    const range: [number, number] = [this.base * 0.6, this.base * 2];
    const needed = Math.ceil((2.2 * RATE) / range[0]);
    const from = Math.min(128, Math.max(0, voiced - needed));
    const start = measurePitch(raw, from, Math.min(voiced, from + needed), range) / this.base;
    const end = measurePitch(raw, Math.max(from, voiced - needed), voiced, range) / this.base;
    this.queue.push({ bands, read: 0, pitch: start && end ? [start, end] : [0, 0], voiced });
  }

  /** Silence to play out next (a pause between words). */
  pause(ms: number) {
    const z = new Float32Array(Math.round((ms / 1000) * RATE));
    this.queue.push({ bands: { low: z, mid: z, high: z }, read: 0, pitch: [0, 0], voiced: 0 });
  }

  /** Drops what hasn't played yet (the speech was cut off). */
  clear() {
    this.queue = [];
  }

  /** Plays `ms` more of the signal into the history; with nothing queued, a faint noise floor (`floor`, 0 = none). */
  advance(ms: number, floor: number) {
    const n = Math.round((ms / 1000) * RATE);
    for (let i = 0; i < n; i++) {
      const q = this.queue[0];
      let voicedNow = false;
      if (q) {
        for (const b of BAND_NAMES) this.history[b][this.write] = q.bands[b][q.read]!;
        if (q.read < q.voiced && q.pitch[0]) {
          voicedNow = true;
          this.pitch = q.pitch[0] + (q.pitch[1] - q.pitch[0]) * (q.read / q.voiced);
        }
        if (++q.read >= q.bands.low.length) this.queue.shift();
      } else {
        // Silence isn't flat on a real meter: white noise through the same bands, very quiet.
        const white = (this.random() - 0.5) * floor;
        this.history.low[this.write] = this.noiseBands.low.process(white * 0.05);
        this.history.mid[this.write] = this.noiseBands.mid.process(white * 0.08);
        this.history.high[this.write] = this.noiseBands.high.process(white * 0.04);
      }
      // Voicing comes up within ~15 ms of a sound, and lets go over ~80 ms after.
      this.voicing = voicedNow ? Math.min(1, this.voicing + 1 / 240) : this.voicing * 0.9992;
      if (voicedNow) this.heard += (this.pitch - this.heard) / 400;
      this.write = (this.write + 1) % HISTORY;
      if (++this.sinceStep >= PITCH_STEP) {
        this.sinceStep = 0;
        this.trail[this.trailAt] = this.voicing > 0.05 ? this.heard * this.voicing + (1 - this.voicing) : 1;
        this.trailAt = (this.trailAt + 1) % PITCH_POINTS;
      }
    }
  }

  /**
   * Where to start drawing traces up to `longest` samples, like a scope's trigger: within the last whole period of
   * the voice, where the fundamental rises through zero most steeply (to a fraction of a sample). That's the same
   * point of every period, so a steady voice draws a steady wave instead of flickering every frame. Returns how many
   * samples back from now the traces start.
   */
  trigger(longest: number): number {
    const low = this.history.low;
    const latest = Math.min(HISTORY - 2, longest);
    const period = Math.ceil(RATE / (this.base * Math.max(0.5, this.pitch)));
    const search = Math.min(HISTORY - 2 - latest, period);
    let found = latest;
    let steepest = 0;
    for (let back = latest; back < latest + search; back++) {
      const i = (this.write - back + HISTORY) % HISTORY;
      const before = low[(i - 1 + HISTORY) % HISTORY]!;
      const after = low[i]!;
      if (before < 0 && after >= 0 && after - before > steepest) {
        steepest = after - before;
        found = back + after / (after - before);
      }
    }
    return found;
  }

  /** A band's signal from `back` samples ago (fractional is fine), for `length` samples (`at(i)` for i in 0..length). */
  window(band: BandName, back: number, length: number): (i: number) => number {
    const h = this.history[band];
    const start = this.write - back + HISTORY;
    return (i) => {
      const f = start + Math.min(i, length - 1);
      const lo = Math.floor(f);
      const a = h[lo % HISTORY]!;
      return a + (h[(lo + 1) % HISTORY]! - a) * (f - lo);
    };
  }

  /** How loud a band is over its last `length` samples (RMS). */
  level(band: BandName, length: number): number {
    const at = this.window(band, length, length);
    let sum = 0;
    for (let i = 0; i < length; i++) sum += at(i) ** 2;
    return Math.sqrt(sum / length);
  }

  /** The pitch trace, oldest first (relative to base, 1 where it wasn't voiced). */
  pitchTrail(i: number): number {
    return this.trail[(this.trailAt + i) % PITCH_POINTS]!;
  }

  /** Signal still to play (ms). */
  get queuedMs(): number {
    return (this.queue.reduce((s, q) => s + q.bands.low.length - q.read, 0) / RATE) * 1000;
  }
}
