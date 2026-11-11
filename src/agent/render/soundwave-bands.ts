/**
 * Voice mode's lines: one per band of the agent's voice (see voice-signal.ts), each with its own color. Shared by the
 * live soundwave and its still (AgentPortrait), so they match.
 */
import type { Mood } from '../../voice/index.ts';

export type Band = 'low' | 'mid' | 'high' | 'pitch';

/** How tall each band's line gets (a share of the half height). Its color comes from the mood (`MOOD_LOOK`). */
export const BANDS: Record<Band, { height: number }> = {
  /** The fundamental, the voice's pitch itself: the slow wave under everything. */
  low: { height: 0.92 },
  /** The first formant, the vowel. */
  mid: { height: 0.7 },
  /** The second formant, the brightness: the fast one. */
  high: { height: 0.42 },
  /** The pitch over time, the melody. */
  pitch: { height: 0.5 },
};

/**
 * The signal bands' display gain: their levels differ (the fundamental is quiet next to the vowel), so each is scaled
 * to fill its height when the voice is at its usual loudness, and softly limited past that.
 */
export const GAIN: Record<'low' | 'mid' | 'high', number> = { low: 14, mid: 5.2, high: 9 };

/**
 * How much of the signal the traces show (samples at 16 kHz): the same moment for every band, so how fast each line
 * waves is its frequency. 16 ms in the agent's view, 8 ms in a small head.
 */
export const TRACE = { body: 256, head: 128 };

/**
 * How each mood looks in voice mode (the agent sets its mood with `set_mood`; its voice changes too, so the lines
 * follow a voice that really is quicker, higher, or calmer):
 *
 * - colors: one per band (low, mid, high, pitch); each glows in a lighter tint of itself.
 * - drama: how tall the lines get and how much they glow (1 = as neutral).
 * - taper: the curve the lines make across: low is a long, even swell; high is pinched to a peak in the middle.
 * - smooth: how rounded the waves are drawn (0 = the trace as it is; 1 = soft, rolling curves).
 * - swellMs, ebbMs: how fast the lines rise into a syllable and fall away after it.
 */
export interface MoodLook {
  colors: Record<Band, string>;
  drama: number;
  taper: number;
  smooth: number;
  swellMs: number;
  ebbMs: number;
}

export const MOOD_LOOK: Record<Mood, MoodLook> = {
  neutral: { colors: { low: '#1a3875', mid: '#2a78d6', high: '#eb6834', pitch: '#78598c' }, drama: 1, taper: 1.6, smooth: 0, swellMs: 60, ebbMs: 240 },
  calm: { colors: { low: '#0f4c5c', mid: '#2a9d8f', high: '#5fb3c7', pitch: '#7d7fb8' }, drama: 0.7, taper: 0.9, smooth: 0.85, swellMs: 120, ebbMs: 460 },
  cheerful: { colors: { low: '#c4521f', mid: '#f0a400', high: '#2c9bd6', pitch: '#e8638b' }, drama: 1.1, taper: 1.4, smooth: 0.3, swellMs: 50, ebbMs: 220 },
  excited: { colors: { low: '#7a1f5c', mid: '#e0457b', high: '#ff7a1a', pitch: '#e8a91c' }, drama: 1.3, taper: 2.2, smooth: 0, swellMs: 28, ebbMs: 150 },
  curious: { colors: { low: '#2e2a7a', mid: '#6c5ce7', high: '#00a3c4', pitch: '#a35bc9' }, drama: 1, taper: 1.5, smooth: 0.25, swellMs: 60, ebbMs: 280 },
  focused: { colors: { low: '#1b2a3a', mid: '#2f6fb0', high: '#23977a', pitch: '#5f6680' }, drama: 0.8, taper: 2.6, smooth: 0.1, swellMs: 45, ebbMs: 200 },
  concerned: { colors: { low: '#3b4252', mid: '#5e7ea6', high: '#b5834b', pitch: '#86708a' }, drama: 0.6, taper: 1.2, smooth: 0.55, swellMs: 95, ebbMs: 400 },
  playful: { colors: { low: '#5b2a86', mid: '#ff4f9a', high: '#6fb526', pitch: '#18adad' }, drama: 1.25, taper: 1.3, smooth: 0.2, swellMs: 30, ebbMs: 160 },
};

/** A color's glow: the same hue, lighter and a little more vivid, as `r, g, b`. */
export function glowOf(rgb: readonly number[]): string {
  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  // Lighter and more vivid, then back to RGB.
  const L = Math.min(0.68, l + 0.3);
  const S = Math.min(1, s * 1.15 + 0.05);
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return [r1, g1, b1].map((v) => Math.round((v + m) * 255)).join(', ');
}

export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
