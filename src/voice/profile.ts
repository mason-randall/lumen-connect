/**
 * Voices for agents' babble. A voice is a handful of parameters (VOICE_PARAMS) that a customizer can expose as
 * sliders; presets are just named parameter sets; and a character's voice setting is `auto` (follows its avatar),
 * `custom` (its own parameters), or `none` (silent).
 */
import type { AvatarRecipe } from './recipe.ts';
import { hashString } from './dsp.ts';

export interface VoiceProfile {
  /** Base pitch in Hz. */
  pitchHz: number;
  /** Random pitch wobble per syllable, as a fraction (0.12 = ±6%). */
  jitter: number;
  /** Scales vowel formants: >1 sounds smaller, <1 bigger. */
  formantScale: number;
  /** 0 = hollow pulse (cute), 1 = buzzy saw (gruff). */
  buzz: number;
  /** Length of each blip in ms. */
  blipMs: number;
  /** Letters per second. */
  speed: number;
  /** Pitch multiplier reached at the end of a question. */
  questionLift: number;
  /** Pitch and loudness boost for SHOUTED words. */
  emphasis: number;
  /** 0..1. Presets are balanced to about the same loudness (RMS ≈ 0.08). */
  volume: number;
}

export type VoiceParamKey = keyof VoiceProfile;

export interface VoiceParam {
  key: VoiceParamKey;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Labels for the ends of the slider, e.g. hollow ↔ buzzy. */
  ends?: [string, string];
}

/** Every voice parameter, in display order, with its range: everything a voice customizer needs to render. */
export const VOICE_PARAMS: readonly VoiceParam[] = [
  { key: 'pitchHz', label: 'Pitch', description: 'How high or low the voice is.', min: 80, max: 520, step: 1, unit: 'Hz', ends: ['Low', 'High'] },
  { key: 'formantScale', label: 'Size', description: 'How big the speaker sounds, independent of pitch.', min: 0.6, max: 1.6, step: 0.01, ends: ['Big', 'Tiny'] },
  { key: 'buzz', label: 'Timbre', description: 'Hollow and cute, or buzzy and gruff.', min: 0, max: 1, step: 0.01, ends: ['Hollow', 'Buzzy'] },
  { key: 'jitter', label: 'Wobble', description: 'How much the pitch varies from syllable to syllable.', min: 0, max: 0.4, step: 0.01, ends: ['Steady', 'Sing-song'] },
  { key: 'blipMs', label: 'Blip length', description: 'Short chirps or longer, smoother syllables.', min: 30, max: 140, step: 1, unit: 'ms', ends: ['Chirpy', 'Smooth'] },
  { key: 'speed', label: 'Speed', description: 'Letters spoken per second.', min: 6, max: 32, step: 0.5, unit: 'chars/s', ends: ['Slow', 'Fast'] },
  { key: 'questionLift', label: 'Question lift', description: 'How much the pitch rises at the end of a question.', min: 1, max: 1.8, step: 0.01, ends: ['Flat', 'Rising'] },
  { key: 'emphasis', label: 'Emphasis', description: 'How much SHOUTED words stand out.', min: 1, max: 1.6, step: 0.01, ends: ['Calm', 'Dramatic'] },
  { key: 'volume', label: 'Volume', description: 'Loudness of this voice.', min: 0, max: 1, step: 0.01 },
];

const base = { speed: 14, questionLift: 1.35, emphasis: 1.18 };

export interface VoicePreset {
  label: string;
  description: string;
  params: VoiceProfile;
}

/** Built-in presets: named parameter sets, nothing more. */
export const VOICE_PRESETS = {
  squeaky: { label: 'Squeaky', description: 'Tiny and excitable, like a gnome.', params: { ...base, pitchHz: 360, jitter: 0.14, formantScale: 1.3, buzz: 0.15, blipMs: 55, volume: 0.55, speed: 16 } },
  bright: { label: 'Bright', description: 'Upbeat and clear.', params: { ...base, pitchHz: 290, jitter: 0.12, formantScale: 1.15, buzz: 0.25, blipMs: 62, volume: 0.68 } },
  warm: { label: 'Warm', description: 'Friendly and easy to listen to.', params: { ...base, pitchHz: 220, jitter: 0.1, formantScale: 1.0, buzz: 0.3, blipMs: 70, volume: 0.74 } },
  deep: { label: 'Deep', description: 'Big, slow, and booming, like a god.', params: { ...base, pitchHz: 140, jitter: 0.08, formantScale: 0.85, buzz: 0.45, blipMs: 80, volume: 1.0, speed: 12 } },
  gravelly: { label: 'Gravelly', description: 'Rough and menacing, for villains.', params: { ...base, pitchHz: 120, jitter: 0.1, formantScale: 0.8, buzz: 0.75, blipMs: 78, volume: 0.82, speed: 12 } },
  robot: { label: 'Robot', description: 'Perfectly steady and buzzy.', params: { ...base, pitchHz: 180, jitter: 0, formantScale: 1.0, buzz: 0.9, blipMs: 50, volume: 0.6, questionLift: 1.1, emphasis: 1.05, speed: 15 } },
  chipper: { label: 'Chipper', description: 'Fast, sing-song, and cheerful.', params: { ...base, pitchHz: 320, jitter: 0.24, formantScale: 1.2, buzz: 0.2, blipMs: 45, volume: 0.62, questionLift: 1.5, speed: 22 } },
} as const satisfies Record<string, VoicePreset>;

export type VoiceName = keyof typeof VOICE_PRESETS;

/** Preset parameters by name (`VOICES.squeaky`). */
export const VOICES = Object.fromEntries(Object.entries(VOICE_PRESETS).map(([k, v]) => [k, v.params])) as { [K in VoiceName]: (typeof VOICE_PRESETS)[K]['params'] };

/** Clamps every parameter into its range and fills missing ones from the `warm` preset. */
export function normalizeVoice(params: Partial<VoiceProfile>): VoiceProfile {
  const out = { ...VOICES.warm } as VoiceProfile;
  for (const param of VOICE_PARAMS) {
    const value = params[param.key];
    if (typeof value === 'number' && Number.isFinite(value)) out[param.key] = Math.min(param.max, Math.max(param.min, value));
  }
  return out;
}

// ---- per-character voice settings ------------------------------------------------------------------

export const VOICE_SCHEMA = 'polyworld-voice/1';

/**
 * How a character sounds: `auto` follows its avatar (gnomes squeak, gods rumble), `custom` uses its own parameters
 * (`preset` records which preset it started from, for display), and `none` is silent.
 */
export type VoiceSettings =
  | { schema: typeof VOICE_SCHEMA; mode: 'auto' }
  | { schema: typeof VOICE_SCHEMA; mode: 'none' }
  | { schema: typeof VOICE_SCHEMA; mode: 'custom'; params: VoiceProfile; preset?: VoiceName };

export const AUTO_VOICE: VoiceSettings = { schema: VOICE_SCHEMA, mode: 'auto' };
export const NO_VOICE: VoiceSettings = { schema: VOICE_SCHEMA, mode: 'none' };

/** Settings for a preset (as a custom voice, so later tweaks keep everything else). */
export function presetVoice(name: VoiceName): VoiceSettings {
  return { schema: VOICE_SCHEMA, mode: 'custom', preset: name, params: { ...VOICES[name] } };
}

/** Settings with one or more parameters changed (from any starting point, including `auto`). */
export function tuneVoice(settings: VoiceSettings, changes: Partial<VoiceProfile>, recipe?: AvatarRecipe): VoiceSettings {
  const current = resolveVoice(settings, recipe) ?? VOICES.warm;
  return {
    schema: VOICE_SCHEMA,
    mode: 'custom',
    params: normalizeVoice({ ...current, ...changes }),
    ...(settings.mode === 'custom' && settings.preset ? { preset: settings.preset } : {}),
  };
}

const DEEP = new Set(['Zeus', 'Hades', 'Death Knight', 'Lich', 'Vanguard Knight', 'Berserker']);

/** The voice `auto` gives a character: picked from its look, with a small stable variation per character. */
export function voiceFor(recipe: AvatarRecipe): VoiceProfile {
  const mouth = recipe.parts.find((p) => p.category === 'Mouth')?.item ?? '';
  const name: VoiceName =
    mouth.startsWith('Evil') ? 'gravelly'
    : recipe.preset && DEEP.has(recipe.preset) ? 'deep'
    : recipe.preset?.startsWith('Gnome') || recipe.parts.some((p) => p.item.startsWith('Gnome')) ? 'squeaky'
    : (['bright', 'warm'] as const)[hashString(JSON.stringify(recipe.parts)) % 2]!;
  const shift = 1 + ((hashString(`${recipe.skin}:${recipe.hairColor ?? ''}:${recipe.preset ?? ''}`) % 21) - 10) / 100;
  return { ...VOICES[name], pitchHz: Math.round(VOICES[name].pitchHz * shift) };
}

/** The voice to play, or `null` for silence. `auto` needs the character's avatar recipe. */
export function resolveVoice(settings: VoiceSettings | null | undefined, recipe?: AvatarRecipe): VoiceProfile | null {
  if (!settings || settings.mode === 'auto') return recipe ? voiceFor(recipe) : { ...VOICES.warm };
  if (settings.mode === 'none') return null;
  return normalizeVoice(settings.params);
}

/** Problems with stored settings (empty when valid). Out-of-range values are reported, not silently clamped. */
export function validateVoiceSettings(settings: VoiceSettings): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  if (settings.schema !== VOICE_SCHEMA) problems.push({ path: 'schema', message: `expected "${VOICE_SCHEMA}"` });
  if (!['auto', 'none', 'custom'].includes(settings.mode)) problems.push({ path: 'mode', message: 'must be auto, none, or custom' });
  if (settings.mode === 'custom') {
    if (settings.preset !== undefined && !(settings.preset in VOICE_PRESETS)) problems.push({ path: 'preset', message: `unknown preset "${settings.preset}"` });
    for (const param of VOICE_PARAMS) {
      const value = settings.params?.[param.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push({ path: `params.${param.key}`, message: 'must be a number' });
      else if (value < param.min || value > param.max) problems.push({ path: `params.${param.key}`, message: `must be ${param.min}..${param.max}` });
    }
  }
  return problems;
}

/** A line to audition a voice in a customizer. */
export const VOICE_PREVIEW_LINE = 'Hi! I finished the eval run. Want to see how we did?';
