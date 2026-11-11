/**
 * Plays babble in the browser (Web Audio). Implements the avatar renderer's `VoiceLike` hook so the avatar's mouth
 * clock drives the sound, and also speaks on its own (`say`) for notifications without an avatar.
 */
import { babbleScript, renderSyllable, type BabbleShape, type SyllableOptions } from './babble.ts';
import { hashString, rng } from './dsp.ts';
import type { VoiceProfile } from './profile.ts';

export interface VoiceLike {
  syllable(shape: BabbleShape, ms: number, opts?: SyllableOptions): void;
  pause(ms: number): void;
  stop(): void;
  /** The voice's preferred pace; an avatar driving it should use this for its mouth too. Absent when silent. */
  readonly charsPerSecond?: number;
}

export interface VoicePlayer extends VoiceLike {
  /** The current voice, or null when silent (`mode: 'none'`). */
  readonly voice: VoiceProfile | null;
  /** Switches voice live, e.g. while a customizer's sliders move. `null` silences it. */
  setVoice(voice: VoiceProfile | null): void;
  /** Speaks a line on its own; resolves when it finishes (or when stopped). */
  say(text: string, options?: { charsPerSecond?: number }): Promise<void>;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

/**
 * Browsers start audio suspended until a user gesture; call `context.resume()` from a click before the first line.
 * One AudioContext can serve every avatar on the page. A `null` voice (or context) gives a silent player with the
 * same interface, so "no voice" needs no special cases.
 */
export function createVoicePlayer(context: AudioContext | null, initialVoice: VoiceProfile | null, options: { seed?: string; volume?: number } = {}): VoicePlayer {
  let voice = initialVoice;
  const master = context?.createGain() ?? null;
  if (master && context) {
    master.gain.value = options.volume ?? 0.8;
    master.connect(context.destination);
  }
  const random = rng(hashString(options.seed ?? 'voice'));
  const playing = new Set<AudioBufferSourceNode>();
  let muted = false;
  let generation = 0;

  const play = (samples: Float32Array, at: number) => {
    if (!context || !master) return;
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.onended = () => playing.delete(source);
    playing.add(source);
    source.start(at);
  };

  const player: VoicePlayer = {
    get muted() {
      return muted;
    },
    get voice() {
      return voice;
    },
    get charsPerSecond() {
      return voice?.speed;
    },
    setVoice(next) {
      voice = next;
      if (!next) player.stop();
    },
    syllable(shape, ms, opts = {}) {
      if (muted || !voice || !context || context.state !== 'running') return;
      play(renderSyllable(shape, ms, voice, opts, random, context.sampleRate), context.currentTime + 0.005);
    },
    pause() {},
    stop() {
      generation++;
      for (const source of playing) source.stop();
      playing.clear();
    },
    async say(text, sayOptions = {}) {
      const mine = ++generation;
      if (!voice || !context) return; // silent voice: nothing to say
      const current = voice;
      let at = context.currentTime + 0.02;
      for (const step of babbleScript(text, { charsPerSecond: sayOptions.charsPerSecond ?? current.speed })) {
        if (step.kind === 'syllable' && !muted) play(renderSyllable(step.shape, step.ms, current, step, random, context.sampleRate), at);
        at += step.ms / 1000;
      }
      const remaining = Math.max(0, (at - context.currentTime) * 1000);
      await new Promise((resolve) => setTimeout(resolve, remaining));
      if (mine !== generation) return;
    },
    setVolume(volume) {
      if (master && context) master.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), context.currentTime, 0.02);
    },
    setMuted(value) {
      muted = value;
      if (muted) player.stop();
    },
  };
  return player;
}
