import { describe, expect, it } from 'vitest';
import { AGENT_RECIPE, AUTO_VOICE, resolveVoice, voiceFor } from '../src/voice/index.ts';

describe("the agent's voice", () => {
  it('is the one its look picks', () => {
    const voice = resolveVoice(AUTO_VOICE, AGENT_RECIPE);
    expect(voice).toEqual(voiceFor(AGENT_RECIPE));
    expect(voice).toEqual({ speed: 14, questionLift: 1.35, emphasis: 1.18, pitchHz: 238, jitter: 0.1, formantScale: 1, buzz: 0.3, blipMs: 70, volume: 0.74 });
  });
});
