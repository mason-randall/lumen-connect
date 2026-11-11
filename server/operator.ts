/**
 * The player's agent using an app, the way a person does: it looks at the app's views and moves its controls (all
 * found from the page's own HTML, see src/agent/controls.ts), a step at a time, seeing the result each time. When the
 * app can't do what's asked, it changes the app's code (a rework): small edits to the files, checked before they're
 * served, and undoable.
 */
import vm from 'node:vm';
import { jsonIn, type CallFact, type Content, type Model } from './coworld.ts';

// ---- a step ------------------------------------------------------------------------------------------------------

const ACT_SYSTEM = `You are the player's agent, using an app on their screen alongside them, the way a person would: you see what's in its views (pictures are attached) and you use its controls (sliders, switches, choices, buttons), which are listed with their refs and current values. The player watches you work: they see what you look at, what you touch, and hear what you say.

Work a step at a time. Each step: say one short thing, make a few moves, and say where to look next. You see the result in the next step, so judge it then and adjust; don't try to do everything at once.

Answer with JSON only:
{"say":"…","look":{"view":"v1","region":[x,y,w,h]},"actions":[{"ref":"c3","value":0.4},{"ref":"c7","press":true},{"ref":"c12","point":true}],"done":false,"rework":null}

- say: one or two short spoken sentences to the player: what you see, or what you're doing and why. Plain words, no lists, no numbers unless they help.
- look: the view to look at next, and optionally a region of it (x, y, width, height, each 0–1 of the view) to see up close, e.g. a face to judge skin or eyes. null: the whole first view.
- actions: up to 6, done in order. A slider, number, or text gets a "value" (an absolute value in its range, from where it is now); a switch gets true or false; a choice gets one of its option values; a button gets "press": true. A link gets "press": true only when the player wants to go there (the page changes and you stop); to show the player where something is, "point": true highlights it without using it. Prefer moderate moves; you can always go further next step.
- done: true once what the player asked for is met; then "say" wraps up and actions can be empty.
- rework: only when no control can do what's needed (the app is missing it) or the app gets in your way: what to change in the app's code, in one or two sentences ("Add a Noise reduction slider in Effects that blends toward the fine blur"). The app's code is changed and you continue after it reloads. At most once per request. Otherwise null.
- Never open files, export, or leave the page unless the player asked.
- Your policy for this app (when there is one) is what the player has coached you: follow it. What the player tells you while you work comes first of all: act on it in this step.`;

export interface Step {
  say: string;
  look: { view: string; region: number[] | null } | null;
  actions: ({ ref: string; value: string | number | boolean } | { ref: string; press: true } | { ref: string; point: true })[];
  done: boolean;
  rework: string | null;
}

export interface ActInput {
  request: string;
  page: string;
  /** The controls and views, as lines (describe() in src/agent/controls.ts). */
  controls: string;
  /** The views it's looking at, newest first: [label, picture]. */
  images: { label: string; media_type: string; data: string }[];
  /** What it said and did in earlier steps of this request. */
  history: string[];
  /** What the player did with the controls lately (watching them: the start of coaching). */
  player: string[];
  /** The changes made to the app's code so far. */
  changes: string[];
  /** The policy it follows here (policyText in policies.ts). */
  policy?: string;
  /** What the player told it since its last step, newest last: corrections come first. */
  heard?: string[];
  /** The page in words (its structure, headings, text, and links), when there's no view to look at. */
  pageText?: string;
  /** Practicing on its own: no changing the app, and finish within this many steps. */
  practice?: { steps: number };
}

export function actContent(input: ActInput): Content {
  const text = [
    `The player asked: ${input.request}`,
    `Page: ${input.page}`,
    input.policy ?? '',
    input.heard?.length ? `The player just told you, while you worked (do this now):\n${input.heard.map((l) => `- "${l}"`).join('\n')}` : '',
    input.practice ? `You're practicing on your own, with no one to ask: don't change the app's code (rework stays null), and be done within ${input.practice.steps} steps.` : '',
    input.player.length ? `What the player did with the controls lately, oldest first:\n${input.player.map((l) => `- ${l}`).join('\n')}` : '',
    input.changes.length ? `Changes made to the app's code so far:\n${input.changes.map((l) => `- ${l}`).join('\n')}` : '',
    `Your steps so far on this request:\n${input.history.length ? input.history.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(this is your first step)'}`,
    input.controls,
    input.pageText ? `The page, as you'd read it (for reading only: act on the controls' c refs):\n${input.pageText}` : '',
    input.images.length ? `The pictures below: ${input.images.map((i, n) => `(${n + 1}) ${i.label}`).join('; ')}.` : "(No picture: the views can't be seen.)",
    'Your next step, as JSON.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [{ type: 'text', text }, ...input.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.media_type, data: i.data } }))];
}

/** The step in a model's reply, with anything malformed left out (the page checks the refs and values). */
export function parseStep(reply: string): Step {
  const r = jsonIn(reply) as Record<string, unknown>;
  const look = r.look && typeof r.look === 'object' ? (r.look as Record<string, unknown>) : null;
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { ref?: unknown }).ref === 'string')
    .slice(0, 6)
    .flatMap((a): Step['actions'] => (a.press === true ? [{ ref: a.ref as string, press: true }] : a.point === true ? [{ ref: a.ref as string, point: true }] : ['string', 'number', 'boolean'].includes(typeof a.value) ? [{ ref: a.ref as string, value: a.value as string | number | boolean }] : []));
  return {
    say: typeof r.say === 'string' ? r.say.trim().slice(0, 300) : '',
    look: look && typeof look.view === 'string' ? { view: look.view, region: Array.isArray(look.region) ? (look.region as number[]) : null } : null,
    actions,
    done: r.done === true,
    rework: typeof r.rework === 'string' && r.rework.trim() ? r.rework.trim().slice(0, 500) : null,
  };
}

/** A step, and each model call it took as measured (a retry is a second call). */
export async function act(model: Model, input: ActInput): Promise<Step & { calls: CallFact[] }> {
  const content = actContent(input);
  const calls: CallFact[] = [];
  const meter = (c: CallFact) => calls.push(c);
  try {
    return { ...parseStep(await model(ACT_SYSTEM, content, meter)), calls };
  } catch (err) {
    const again = Array.isArray(content) ? [{ type: 'text' as const, text: `Your last answer wasn't usable (${(err as Error).message}). Answer with the JSON object only.` }, ...content] : content;
    return { ...parseStep(await model(ACT_SYSTEM, again, meter)), calls };
  }
}

// ---- a rework ----------------------------------------------------------------------------------------------------

const REWORK_SYSTEM = `You change a web app's own code so the player's agent can do what it needs. The agent uses the app the way a person does: it finds the app's controls from the HTML (inputs, selects, buttons, with their labels and fieldsets) and looks at its canvases and images. So a new ability is usually a new control in the HTML plus the code that makes it work.

Make the smallest change that does it, written like the app's own code: follow the comments in the code on how to extend it, reuse its classes and structure, and keep everything that works working.

Answer with JSON only:
{"title":"<3–6 words, what changed>","why":"<one sentence, to the player>","edits":[{"file":"<one of the files>","find":"<exact text from the file>","replace":"<what it becomes>"}]}

- find is copied exactly from the file as it is now (whitespace too) and appears in it exactly once: include enough lines around the spot. Edits apply in order.
- No network requests, no other sites' scripts or styles, no storage, no eval.`;

export interface Edit {
  file: string;
  find: string;
  replace: string;
}

export interface Rework {
  title: string;
  why: string;
  edits: Edit[];
}

const BANNED = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\beval\s*\(/, /new\s+Function\b/, /localStorage|sessionStorage|indexedDB/, /document\.cookie/, /<script[^>]+src=["']?https?:/i, /@import/, /\bimport\s*\(/];

/** The files after `edits`, or what's wrong with them. */
export function applyEdits(files: Record<string, string>, edits: Edit[]): { files: Record<string, string>; issues: string[] } {
  const out = { ...files };
  const issues: string[] = [];
  edits.forEach((e, i) => {
    if (!(e.file in out)) return issues.push(`edits[${i}]: there's no file "${e.file}" (the files are ${Object.keys(files).join(', ')})`);
    if (!e.find) return issues.push(`edits[${i}]: find is empty`);
    const count = out[e.file]!.split(e.find).length - 1;
    if (count !== 1) return issues.push(`edits[${i}]: find appears ${count} times in ${e.file}; it has to appear exactly once (copy it exactly, with enough lines around it)`);
    out[e.file] = out[e.file]!.replace(e.find, () => e.replace);
    for (const b of BANNED) if (b.test(e.replace)) issues.push(`edits[${i}]: not allowed in the app: ${b.source}`);
  });
  if (!issues.length) {
    for (const [name, code] of Object.entries(out)) {
      if (!name.endsWith('.js') || code === files[name]) continue;
      try {
        new vm.Script(code, { filename: name });
      } catch (err) {
        issues.push(`${name} doesn't parse after the edits: ${(err as Error).message}`);
      }
    }
  }
  return { files: out, issues };
}

function parseRework(reply: string): Rework {
  const r = jsonIn(reply) as Record<string, unknown>;
  const edits = (Array.isArray(r.edits) ? r.edits : []).filter((e): e is Edit => !!e && typeof e === 'object' && typeof e.file === 'string' && typeof e.find === 'string' && typeof e.replace === 'string');
  return { title: typeof r.title === 'string' ? r.title.trim().slice(0, 60) : '', why: typeof r.why === 'string' ? r.why.trim().slice(0, 300) : '', edits };
}

/** Asks for a rework, and once more with what's wrong if it doesn't apply cleanly. */
export async function proposeRework(model: Model, need: string, files: Record<string, string>): Promise<Rework> {
  const prompt = `What the agent needs: ${need}\n\nThe app's files, as they are now:\n\n${Object.entries(files)
    .map(([name, code]) => `===== ${name} =====\n${code}`)
    .join('\n\n')}\n\nYour change, as JSON.`;
  let reply = await model(REWORK_SYSTEM, prompt);
  for (let attempt = 0; attempt < 2; attempt++) {
    let issues: string[];
    let rework: Rework | null = null;
    try {
      rework = parseRework(reply);
      issues = applyEdits(files, rework.edits).issues;
      if (!rework.edits.length) issues.push('there are no edits');
      if (!rework.title) issues.push('title is required');
    } catch (err) {
      issues = [`the answer wasn't JSON (${(err as Error).message})`];
    }
    if (!issues.length && rework) return rework;
    if (attempt) throw new Error(`The agent's change to the app didn't check out: ${issues.slice(0, 3).join('; ')}`);
    reply = await model(REWORK_SYSTEM, `${prompt}\n\nYour last change had problems; fix them and answer again:\n${issues.map((i) => `- ${i}`).join('\n')}`);
  }
  throw new Error('No change.');
}
