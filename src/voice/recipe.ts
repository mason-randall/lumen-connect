/**
 * The few facts about an agent's look that pick its voice (profile.ts `voiceFor`), and the agent's own.
 */
export interface AvatarRecipe {
  /** The preset it started from, when it did. */
  preset?: string;
  /** Index into the skin palette. */
  skin: number;
  hairColor?: string;
  /** One entry per part category. */
  parts: { category: string; item: string }[];
}

export type AgentState = 'idle' | 'talking' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'offline';

/** The generic agent's look (the embed doesn't know the player's), as far as its voice goes. */
export const AGENT_RECIPE: AvatarRecipe = {
  preset: 'Arcanist',
  skin: 20,
  hairColor: 'White',
  parts: [
    { category: 'Hair', item: '12 Wolf cut' },
    { category: 'Eyes', item: '01 Bright' },
    { category: 'Mouth', item: '03 Neutral' },
    { category: 'Brow', item: '01 Soft arch' },
    { category: 'Ears', item: 'Round' },
    { category: 'Body', item: 'Gota base' },
    { category: 'Face', item: 'Base' },
    { category: 'Nose', item: 'Tiny' },
    { category: 'Beard', item: 'None' },
    { category: 'Earring', item: 'None' },
    { category: 'Eyewear', item: 'None' },
    { category: 'Headgear', item: 'Gota Arcanist circlet' },
    { category: 'Chest', item: 'Gota Arcanist violet robe' },
    { category: 'Back', item: 'None' },
    { category: 'Hand', item: 'None' },
    { category: 'Leg', item: 'Gota Arcanist leggings' },
    { category: 'Foot', item: 'Gota Arcanist boots' },
    { category: 'Left hand', item: 'Arcanist orbs' },
    { category: 'Right hand', item: 'Arcanist staff' },
    { category: 'Jacket', item: 'None' },
    { category: 'Belt', item: 'Gota Arcanist amethyst belt' },
    { category: 'Suspenders', item: 'None' },
  ],
};
