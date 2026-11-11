/**
 * Animal Crossing / Zelda-style babble: every letter becomes a tiny pitched blip shaped like a vowel, consonants are
 * softer clicks, punctuation is a pause, questions lift at the end. Driven by the same mouth shapes as the avatar, so
 * sound and lips stay in step. Pure synthesis: deterministic, asset-free, identical on every platform.
 */
import { BandPass, hashString, rng, softClip } from './dsp.ts';
import type { VoiceProfile } from './profile.ts';

export type BabbleShape = 'closed' | 'open' | 'round' | 'wide';

export interface SyllableOptions {
  emphasis?: boolean;
  /** Part of the last word of a question: pitch rises. */
  question?: boolean;
  /** Part of the last word of a statement: pitch settles down. */
  final?: boolean;
}

export type BabbleStep = ({ kind: 'syllable'; shape: BabbleShape } & SyllableOptions & { ms: number }) | { kind: 'pause'; ms: number };

/** Vowel formants (F1, F2) in Hz for each mouth shape. */
const FORMANTS: Record<BabbleShape, [number, number]> = {
  closed: [320, 950],
  open: [760, 1250],
  round: [460, 880],
  wide: [640, 1750],
};

function shapeOf(ch: string): BabbleShape | null {
  const c = ch.toLowerCase();
  if ('mbp'.includes(c)) return 'closed';
  if ('ouw'.includes(c)) return 'round';
  if (/[a-z0-9]/.test(c)) return 'open';
  return null;
}

/**
 * A speaking script for text at `charsPerSecond` (default 14): one step per letter, merged so very short runs don't
 * strobe, with pauses for spaces and punctuation. The avatar renderer has its own equivalent for mouth textures.
 */
export function babbleScript(text: string, options: { charsPerSecond?: number } = {}): BabbleStep[] {
  const perChar = 1000 / (options.charsPerSecond ?? 14);
  const steps: BabbleStep[] = [];
  const sentences = text.match(/[^.!?]+[.!?]*|[.!?]+/g) ?? [];
  for (const sentence of sentences) {
    const ending = /[?]\s*$/.test(sentence) ? 'question' : /[.!]\s*$/.test(sentence) ? 'final' : null;
    const words = sentence.split(/(\s+)/);
    const lastWord = words.map((w, i) => (/\w/.test(w) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    words.forEach((word, wi) => {
      if (/^\s+$/.test(word)) return void steps.push({ kind: 'pause', ms: perChar });
      const emphasis = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      for (const ch of word) {
        const shape = shapeOf(ch);
        if (shape) {
          steps.push({
            kind: 'syllable',
            shape: emphasis ? 'wide' : shape,
            ms: perChar,
            ...(emphasis ? { emphasis } : {}),
            ...(wi === lastWord && ending === 'question' ? { question: true } : {}),
            ...(wi === lastWord && ending === 'final' ? { final: true } : {}),
          });
        } else if (ch === ',' || ch === ';' || ch === ':') {
          steps.push({ kind: 'pause', ms: 150 });
        } else if (ch === '.' || ch === '!' || ch === '?') {
          steps.push({ kind: 'pause', ms: 350 });
        }
      }
    });
  }
  // Merge adjacent pauses; drop leading and trailing pauses.
  const merged: BabbleStep[] = [];
  for (const step of steps) {
    const last = merged.at(-1);
    if (step.kind === 'pause' && last?.kind === 'pause') last.ms += step.ms;
    else merged.push({ ...step });
  }
  while (merged[0]?.kind === 'pause') merged.shift();
  while (merged.at(-1)?.kind === 'pause') merged.pop();
  return merged;
}

/** Renders one blip; `ms` is the step length (the blip itself is at most `voice.blipMs`, the rest is silence). */
export function renderSyllable(shape: BabbleShape, ms: number, voice: VoiceProfile, options: SyllableOptions, random: () => number, sampleRate: number): Float32Array {
  const total = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const out = new Float32Array(total);
  const blip = Math.min(total, Math.round(((shape === 'closed' ? 0.6 : 1) * voice.blipMs * sampleRate) / 1000));
  const wobble = 1 + (random() - 0.5) * voice.jitter;
  const start = voice.pitchHz * wobble * (options.emphasis ? voice.emphasis : 1) * (options.final ? 0.9 : 1);
  const end = options.question ? start * voice.questionLift : start * (options.final ? 0.93 : 1.0);
  const [f1, f2] = FORMANTS[shape].map((f) => f * voice.formantScale) as [number, number];
  const bp1 = new BandPass(f1, 4, sampleRate);
  const bp2 = new BandPass(f2, 6, sampleRate);
  const attack = Math.round(0.004 * sampleRate);
  const release = Math.round(0.025 * sampleRate);
  const gain = voice.volume * (options.emphasis ? 1 + (voice.emphasis - 1) * 1.4 : 1) * (shape === 'closed' ? 0.55 : 1);
  let phase = random();
  for (let i = 0; i < blip; i++) {
    const t = i / blip;
    phase += (start + (end - start) * t) / sampleRate;
    phase -= Math.floor(phase);
    const pulse = phase < 0.3 ? 1 : -0.43; // hollow, cute
    const saw = 2 * phase - 1; // buzzy, gruff
    const src = pulse * (1 - voice.buzz) + saw * voice.buzz;
    const env = i < attack ? i / attack : i > blip - release ? Math.max(0, (blip - i) / release) : 1;
    out[i] = softClip((bp1.process(src) * 1.6 + bp2.process(src) * 0.9 + src * 0.12) * env * gain);
  }
  return out;
}

export interface RenderedSpeech {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

/** Renders a whole line of babble (for previews, notifications, and tests). Deterministic for the same inputs. */
export function renderBabble(text: string, voice: VoiceProfile, options: { sampleRate?: number; charsPerSecond?: number; seed?: number } = {}): RenderedSpeech {
  const sampleRate = options.sampleRate ?? 24_000;
  const random = rng(options.seed ?? hashString(text));
  const chunks = babbleScript(text, { charsPerSecond: options.charsPerSecond ?? voice.speed }).map((step) =>
    step.kind === 'pause' ? new Float32Array(Math.round((step.ms / 1000) * sampleRate)) : renderSyllable(step.shape, step.ms, voice, step, random, sampleRate),
  );
  const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { samples, sampleRate, durationMs: (samples.length / sampleRate) * 1000 };
}

/** 16-bit PCM WAV bytes, for saving or playing a preview. */
export function encodeWav({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(buffer);
}
