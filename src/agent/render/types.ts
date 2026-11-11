/**
 * The shapes the renderers (particles.ts, soundwave.ts) and their speech driver share with the presence that uses them.
 */
import type { AgentState, AvatarRecipe } from '../../voice/index.ts';

/** Streamed speech, as a renderer provides it. */
export interface SpeechLike {
  push(text: string): void;
  end(): Promise<void>;
  cancel(): void;
  readonly done: Promise<void>;
}

/** How fast it talks: letters a second and the pauses at commas and full stops (the renderer's defaults when unset). */
export interface Pace {
  charsPerSecond?: number;
  commaMs?: number;
  stopMs?: number;
  /** Keep up with text shown as it streams: never this far (ms) behind it (see `VisemeOptions.maxLagMs`). */
  maxLagMs?: number;
}

/** What a renderer's agent can be told to do. */
export interface Performer {
  setState(state: AgentState, options?: { clip?: string; once?: boolean }): Promise<void>;
  setRecipe(recipe: AvatarRecipe): Promise<void>;
}

export interface Actor<Voice> extends Performer {
  speech(options?: { voice?: Voice } & Pace): SpeechLike;
}
