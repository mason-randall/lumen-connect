/**
 * The agent's voice: babble in its own voice, in step with what it says (what the renderers and presence.ts use).
 */
export { createVoicePlayer, type VoiceLike, type VoicePlayer } from './player.ts';
export { renderSyllable, type BabbleShape, type SyllableOptions } from './babble.ts';
export { VisemeStream, type MouthShape } from './visemes.ts';
export { MOOD_VOICE, moodVoice, type Mood } from './mood.ts';
export { AUTO_VOICE, resolveVoice, voiceFor, type VoiceProfile } from './profile.ts';
export { AGENT_RECIPE, type AgentState, type AvatarRecipe } from './recipe.ts';
