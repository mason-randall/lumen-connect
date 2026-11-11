/**
 * What the Softmax overlay shows (⌃⇧ on any Connect site, like Steam's in-game overlay): your apps, your agent's
 * policies in each, and your friends.
 *
 * - Apps are the sites registered with Connect (the SDK installed), each with what Softmax does there, from its own
 *   settings. Owners choosing what Softmax may do on their site comes later.
 * - Policies are your agent's, per app, as Connect keeps them (every version, the one in use, its rules).
 * - Friends are sample people for now: Connect isn't signed in to Softmax, and Softmax's own notion of friends (players
 *   who are live in a league together) isn't reachable from here yet. The answer says which parts are samples.
 */
import type { PolicyVersion } from './policies.ts';
import type { SiteConfig } from './sites.ts';

export interface OverlayApp {
  id: string;
  name: string;
  origin: string;
  /** The app the overlay was opened in. */
  here: boolean;
  /** What Softmax does in it (each from the app's own settings). */
  does: string[];
}

export interface OverlayPolicy {
  app: string;
  appName: string;
  /** The version your agent follows there, and every version, oldest first. */
  inUse: { n: number; rules: { layer: string; text: string }[]; created_at: string; fromLesson: boolean };
  versions: { n: number; rules: number; inUse: boolean; created_at: string }[];
  lessons: number;
}

export type Presence = 'in-app' | 'online' | 'away' | 'offline';

export interface OverlayFriend {
  name: string;
  /** Their agent (cogent). */
  agent: string;
  presence: Presence;
  /** What they're doing, in a few words. */
  doing: string;
  /** Where: an app (by id) or a Softmax coworld. */
  where?: { app?: string; coworld?: string };
  hue: number;
}

/** Sample friends (see above). */
export const SAMPLE_FRIENDS: OverlayFriend[] = [
  { name: 'Rowan Iyer', agent: 'Pip', presence: 'in-app', doing: 'Coaching Pip in Lumen', where: { app: 'lumen' }, hue: 28 },
  { name: 'Dana Okafor', agent: 'Moth', presence: 'in-app', doing: 'Playing Minion Rush · level 3', where: { coworld: 'Minion Rush' }, hue: 200 },
  { name: 'Kit Alvarez', agent: 'Juniper', presence: 'in-app', doing: 'Juniper is practicing in Lumen', where: { app: 'lumen' }, hue: 140 },
  { name: 'Sam Reyes', agent: 'Ostrich', presence: 'online', doing: 'Online', hue: 330 },
  { name: 'Priya Nair', agent: 'Ledger', presence: 'online', doing: 'Reviewing Ledger’s policy v4', hue: 265 },
  { name: 'Lee Park', agent: 'Bramble', presence: 'away', doing: 'Away · 20 min', hue: 55 },
  { name: 'Theo Marsh', agent: 'Quill', presence: 'offline', doing: 'Last online 2 days ago', hue: 180 },
  { name: 'Ana Lindqvist', agent: 'Fen', presence: 'offline', doing: 'Last online last week', hue: 300 },
];

/** What Softmax does on an app, from its settings. */
export function appAbilities(site: SiteConfig): string[] {
  return [
    'Your agent sees the page and uses its own controls',
    'You can teach your agent here (the grad cap)',
    site.code ? 'Your agent may change the app’s code (each change can be undone)' : null,
    site.tasks.length ? `Simulated visitors try ${site.tasks.length === 1 ? 'a task' : `${site.tasks.length} tasks`} on it, to improve the page` : null,
    site.practice ? `Your agent practices on ${site.practice.files.length} ${site.practice.noun ?? 'example'}s it hasn’t been taught on` : null,
  ].filter((x): x is string => !!x);
}

export function overlayFor(here: SiteConfig, sites: SiteConfig[], policyOf: (site: string) => { inUse: PolicyVersion; versions: PolicyVersion[]; lessons: number }) {
  const apps: OverlayApp[] = sites.map((s) => ({ id: s.id, name: s.name, origin: `http://localhost:${s.port}`, here: s.id === here.id, does: appAbilities(s) }));
  apps.sort((a, b) => Number(b.here) - Number(a.here));
  const policies: OverlayPolicy[] = sites.map((s) => {
    const { inUse, versions, lessons } = policyOf(s.id);
    return {
      app: s.id,
      appName: s.name,
      inUse: { n: inUse.n, rules: inUse.rules.map((r) => ({ layer: r.layer, text: r.text })), created_at: inUse.created_at, fromLesson: !!inUse.session },
      versions: versions.map((v) => ({ n: v.n, rules: v.rules.length, inUse: v.id === inUse.id, created_at: v.created_at })),
      lessons,
    };
  });
  // The app you're in first, then the others as they're registered.
  policies.sort((a, b) => Number(b.app === here.id) - Number(a.app === here.id));
  return { here: here.id, apps, policies, friends: SAMPLE_FRIENDS, samples: ['friends'] as const };
}
