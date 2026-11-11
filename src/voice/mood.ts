/**
 * Moods: how the agent feels right now, which it sets itself (the gateway's `set_mood`). A mood changes how its voice
 * sounds, on top of the voice the player chose: higher and quicker when excited, lower and slower when concerned,
 * questions lifting more when curious. The client also changes how the agent looks in it (voice mode's colors, curves,
 * and how dramatic the lines are).
 */
import { normalizeVoice, type VoiceProfile } from './profile.ts';

export const MOODS = ['neutral', 'calm', 'cheerful', 'excited', 'curious', 'focused', 'concerned', 'playful'] as const;
export type Mood = (typeof MOODS)[number];

/** What each mood is for, in the agent's terms (the tool's description lists these). */
export const MOOD_NOTES: Record<Mood, string> = {
  neutral: 'your usual self',
  calm: 'steady and reassuring, when things are tense or the user is frustrated',
  cheerful: 'warm and upbeat, for good news and friendly chat',
  excited: 'thrilled, for a win, a breakthrough, a big result',
  curious: 'intrigued, while exploring an idea or asking questions',
  focused: 'heads-down and precise, while working through something hard',
  concerned: 'worried, when something is going wrong (a run failing, a big loss)',
  playful: 'joking around, teasing, having fun',
};

/**
 * How a mood changes a voice: multiplies its pitch, pace, and loudness, and scales how much its pitch wobbles, how far
 * questions lift, and how much stressed words stand out (1 = unchanged).
 */
export const MOOD_VOICE: Record<Mood, { pitch: number; speed: number; volume: number; jitter: number; lift: number; emphasis: number }> = {
  neutral: { pitch: 1, speed: 1, volume: 1, jitter: 1, lift: 1, emphasis: 1 },
  calm: { pitch: 0.95, speed: 0.86, volume: 0.9, jitter: 0.55, lift: 0.7, emphasis: 0.6 },
  cheerful: { pitch: 1.06, speed: 1.05, volume: 1, jitter: 1.25, lift: 1.15, emphasis: 1.2 },
  excited: { pitch: 1.13, speed: 1.2, volume: 1.08, jitter: 1.6, lift: 1.4, emphasis: 1.7 },
  curious: { pitch: 1.03, speed: 0.95, volume: 0.95, jitter: 1.05, lift: 1.7, emphasis: 1 },
  focused: { pitch: 0.98, speed: 1.08, volume: 0.95, jitter: 0.45, lift: 0.8, emphasis: 0.8 },
  concerned: { pitch: 0.92, speed: 0.85, volume: 0.85, jitter: 0.5, lift: 0.9, emphasis: 0.7 },
  playful: { pitch: 1.08, speed: 1.1, volume: 1, jitter: 1.9, lift: 1.3, emphasis: 1.4 },
};

export const isMood = (value: unknown): value is Mood => typeof value === 'string' && (MOODS as readonly string[]).includes(value);

/** A voice in a mood, kept within every parameter's range. */
export function moodVoice(voice: VoiceProfile, mood: Mood): VoiceProfile {
  const m = MOOD_VOICE[mood];
  if (mood === 'neutral') return voice;
  return normalizeVoice({
    ...voice,
    pitchHz: voice.pitchHz * m.pitch,
    speed: voice.speed * m.speed,
    volume: voice.volume * m.volume,
    jitter: voice.jitter * m.jitter,
    questionLift: 1 + (voice.questionLift - 1) * m.lift,
    emphasis: 1 + (voice.emphasis - 1) * m.emphasis,
  });
}
