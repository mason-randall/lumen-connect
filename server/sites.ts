import type { IncomingMessage, ServerResponse } from 'node:http';
import { lumenApi } from '../sites/lumen/server/api.ts';

/** The sample sites: each on its own port, with its tasks for its coworld (Lumen, the photo editor, has none yet). */
export interface SiteConfig {
  id: string;
  name: string;
  /** Served on its own port, so it's another origin, like a real site embedding Connect. */
  port: number;
  dir: string;
  /** The owner shares the site's code with Connect: the player's agent may change it (see operator.ts). */
  code?: boolean;
  /** The site's own server, for what it can't do in the browser (its `/api/…`); answers false for anything else. */
  api?: (dataDir: string) => (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  tasks: { id: string; page: string; goal: string; success: string }[];
  /** Where the agent practices a policy (policies.ts): photos it hasn't been coached on, opened through the page's file input, and one request for all of them. */
  practice?: { request: string; files: string[]; home?: string; noun?: string };
}

export const SITES: SiteConfig[] = [
  {
    id: 'lumen',
    name: 'Lumen',
    port: 7463,
    dir: 'lumen',
    code: true,
    api: lumenApi,
    tasks: [],
    practice: { request: 'Edit this photo the way I like it.', files: ['/practice/dark-backdrop.jpg', '/practice/warm-wall.jpg', '/practice/blue-light.jpg'], home: '/portrait.jpg', noun: 'photo' },
  },
];
