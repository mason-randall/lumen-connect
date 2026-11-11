/**
 * Practice: two versions of the agent's policy, on the same photos it wasn't coached on and the same request. For each
 * photo, the app opens it (through its own file input), every control goes back to its default, and each version
 * edits it in turn (alternating which goes first), on its own and in a few steps. The originals and the results go to
 * a judge that knows only the player's own coaching (server/policies.ts); the player decides which version to keep.
 */
import type { ConnectApi, Practice, PolicyVersion, Site } from '../api.ts';
import { changedFromDefaults, discover, openFile, resetToDefaults, restoreValues, snapshotValues } from './controls.ts';
import { lookNow, type Operator } from './operator.ts';
import type { Seen } from './vision.ts';

const STEPS = 3;
const SIDE = 640;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const img = (s: Seen) => ({ media_type: s.media_type, data: s.data });

/** Waits for the main view to show something else, and settle. */
async function viewChange(before: string | null, ms = 8000) {
  const end = Date.now() + ms;
  let last = before;
  while (Date.now() < end) {
    await sleep(200);
    const now = lookNow(24)?.data ?? null;
    if (now && now !== before && now === last) return;
    last = now;
  }
}

async function settle() {
  await sleep(150);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await sleep(150);
}

export interface PracticeProgress {
  photo: number;
  of: number;
  version: string;
}

export async function practice(api: ConnectApi, operator: Operator, site: Site, a: PolicyVersion, b: PolicyVersion, progress: (p: PracticeProgress) => void): Promise<Practice> {
  const plan = site.practice;
  if (!plan?.files.length) throw new Error(`${site.name} has no practice photos.`);
  const input = discover(document).controls.find((c) => c.kind === 'file')?.el as HTMLInputElement | undefined;
  if (!input) throw new Error('There’s no way to open a photo on this page.');
  // What you were working on comes back afterwards: the file you'd opened (else the site's own) and every control.
  const yours = input.files?.[0] ?? null;
  const values = snapshotValues(discover(document).controls);
  const episodes = [];
  try {
    for (const [i, file] of plan.files.entries()) {
      const before = lookNow(24)?.data ?? null;
      await openFile(input, file);
      await viewChange(before);
      resetToDefaults(discover(document).controls);
      await settle();
      const original = lookNow(SIDE);
      if (!original) throw new Error("Can't see the photo.");
      const out: Record<string, Seen> = {};
      const settings: Record<string, string> = {};
      // Alternate who goes first, so neither always starts from a freshly opened app.
      for (const v of i % 2 ? [b, a] : [a, b]) {
        progress({ photo: i + 1, of: plan.files.length, version: `v${v.n}` });
        resetToDefaults(discover(document).controls);
        await settle();
        await operator.run(plan.request, undefined, { version: v.id, practice: STEPS });
        await settle();
        out[v.id] = lookNow(SIDE)!;
        settings[v.id] = changedFromDefaults(discover(document).controls);
      }
      episodes.push({ photo: file, original: img(original), a: img(out[a.id]!), b: img(out[b.id]!), settings: { a: settings[a.id]!, b: settings[b.id]! } });
    }
  } finally {
    // Back to where the player was.
    const back = yours ?? plan.home;
    if (back) {
      const before = lookNow(24)?.data ?? null;
      await openFile(input, back).catch(() => {});
      await viewChange(before);
    }
    restoreValues(values);
  }
  progress({ photo: plan.files.length, of: plan.files.length, version: 'judge' });
  return api.judge({ a: a.id, b: b.id, episodes });
}
