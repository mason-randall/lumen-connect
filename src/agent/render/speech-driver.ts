/**
 * What a voice-drawn body (the soundwave, the particles) talks with: the speech it's saying, played out in time. Each
 * syllable goes to the speaker (when there's sound) and into the voice signal together, as its moment comes, so what's
 * drawn is what's heard. The body calls `tick` once a frame and draws from `signal`.
 */
import { VisemeStream, type MouthShape, type VoiceLike, type VoiceProfile } from '../../voice/index.ts';
import type { Pace, SpeechLike } from './types.ts';
import { GAIN } from './soundwave-bands.ts';
import { VoiceSignal, type BandName } from './voice-signal.ts';

/** A starved stream (waiting for more streamed text) stops looking like talking after this long. */
const STARVED_MS = 400;

interface Job {
  stream: VisemeStream;
  voice?: VoiceLike;
  left: number;
  starved: number;
  shape: MouthShape;
  resolve: () => void;
}

export class SpeechDriver {
  readonly signal = new VoiceSignal();
  private job: Job | null = null;

  constructor(private readonly profile: () => VoiceProfile) {}

  /** Saying something now (not just waiting on more streamed text). */
  get speaking(): boolean {
    return !!this.job && this.job.starved < STARVED_MS;
  }

  private end(j: Job, interrupted: boolean) {
    if (this.job !== j) return;
    this.job = null;
    if (interrupted) {
      j.voice?.stop();
      this.signal.clear();
    }
    j.resolve();
  }

  /** Takes the next syllables as their time comes, and hands each to the speaker and the signal together. */
  tick(ms: number) {
    const j = this.job;
    if (!j) return;
    j.left -= ms;
    while (j.left <= 0) {
      const v = j.stream.take();
      if (!v) {
        if (j.stream.done) return this.end(j, false);
        j.shape = 'rest';
        j.starved += ms;
        j.left = 0;
        return;
      }
      j.starved = 0;
      j.left += v.ms;
      j.shape = v.shape;
      if (v.shape === 'rest') {
        j.voice?.pause(v.ms);
        this.signal.pause(v.ms);
        continue;
      }
      const emphasis = !!v.emphasis || v.shape === 'wide';
      const say = { ...(emphasis ? { emphasis: true } : {}), ...(v.question ? { question: true } : {}), ...(v.final ? { final: true } : {}) };
      j.voice?.syllable(v.shape, v.ms, say);
      this.signal.syllable(v.shape, v.ms, this.profile(), say);
    }
  }

  /** Starts saying streamed text (cutting off whatever it was saying). */
  speech(opts: { voice?: VoiceLike } & Pace = {}): SpeechLike {
    if (this.job) this.end(this.job, true);
    const { voice, ...pace } = opts;
    const charsPerSecond = pace.charsPerSecond ?? voice?.charsPerSecond;
    const stream = new VisemeStream({ ...pace, ...(charsPerSecond ? { charsPerSecond } : {}) });
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const j: Job = { stream, voice, left: 0, starved: 0, shape: 'rest', resolve };
    this.job = j;
    return {
      push: (text) => this.job === j && stream.push(text),
      end: () => {
        stream.end();
        return done;
      },
      cancel: () => this.end(j, true),
      done,
    };
  }

  /** Stops talking at once. */
  cancel() {
    if (this.job) this.end(this.job, true);
  }
}

/** `points` values of a trace (`length` samples of a band from `back` ago), each through the band's display gain. */
export function sampleTrace(signal: VoiceSignal, band: BandName, back: number, length: number, points: number, out: Float32Array) {
  const at = signal.window(band, back, length);
  const gain = GAIN[band];
  for (let i = 0; i < points; i++) {
    const f = (i * (length - 1)) / (points - 1);
    const lo = Math.floor(f);
    const v = at(lo) + (at(lo + 1) - at(lo)) * (f - lo);
    out[i] = Math.tanh(gain * v);
  }
}
