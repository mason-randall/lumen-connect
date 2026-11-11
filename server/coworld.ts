/**
 * A site as a coworld. The owner's tasks are the game ("buy a bag of beans"); variants are the policies; an episode is
 * a simulated visitor taking a first-click test on a variant (where would you click first to do this?), a standard
 * usability measure that predicts whether people finish the task; the score is how many got it right.
 * "Improve" is one round of the optimizer loop: read what visitors did, form one hypothesis, write a variant.
 */
import { checkPatches, INSERT_TAGS, STYLE_PROPERTIES, ATTRS, type Patch, type PatchIssue } from '../src/patches.ts';

/** A user turn: words, or words and pictures (Messages API content blocks). */
export type Content = string | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[];

/**
 * One model call as it was measured: every token the model read
 * (input, cache writes and cache reads together), how many of those it read from the cache, how many it wrote, and
 * how long the call took, end to end.
 */
export interface CallFact {
  prefill: number;
  cached: number;
  output: number;
  dur_ms: number;
}

/** `meter`, if given, hears each call's measured usage (when the model reports it). */
export type Model = (system: string, user: Content, meter?: (c: CallFact) => void) => Promise<string>;

/** The visitors every variant is tested with: different people, the same goal. */
export const PERSONAS = [
  'Dana, on her phone between meetings: skims and taps the first thing that looks right',
  'Luis, here for the first time: reads the headings and the button labels',
  'Priya, careful: looks the whole page over before she clicks anything',
  "Walt, 68, not confident online: avoids anything that looks salesy or risky, and won't hunt for small links",
  'Sam, a student on a budget: looks for the cheapest, lowest-commitment way in',
  'Ana, knows exactly what she wants: looks for the most direct path to it',
] as const;

export interface Answer {
  persona: string;
  click: string;
  clicked: string;
  why: string;
  hit: boolean;
}

/** The JSON object in a model's reply (it may wrap it in words or a code fence). */
export function jsonIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reply had no JSON in it.');
  return JSON.parse(text.slice(start, end + 1));
}

// ---- visitors ----------------------------------------------------------------------------------------------------

const VISITOR_SYSTEM = `You simulate real visitors to a website, in a first-click test. For each visitor, decide the ONE element they would click first to do the task, from what the page shows: where things are (above or below the fold), how prominent they are (size, bold, drawn as a button, color), and what they say.

Be realistic, not ideal: people skim, favor big, high, button-like things with clear words, and rarely scroll to a footer unless nothing above helps. Each visitor is different; their personas say how. A visitor may click something that doesn't do the task, when that's what they'd really do.

Answer with JSON only: {"answers":[{"persona":"<first name>","click":"<ref, like e12>","why":"<one short sentence, in their voice>"}]}, one answer per visitor, in order.`;

export async function firstClicks(model: Model, goal: string, outline: string, matches: Record<string, string[]>, labels: Record<string, string>, task: string): Promise<Answer[]> {
  const user = `The task: ${goal}\n\nThe visitors:\n${PERSONAS.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nThe page, element by element (ref, what it is, what it says, how it looks):\n${outline}`;
  const reply = jsonIn(await model(VISITOR_SYSTEM, user)) as { answers?: { persona?: string; click?: string; why?: string }[] };
  const answers = Array.isArray(reply.answers) ? reply.answers : [];
  return PERSONAS.map((persona, i) => {
    const a = answers[i] ?? {};
    const click = typeof a.click === 'string' ? a.click.trim() : '';
    return {
      persona,
      click,
      clicked: labels[click] ?? (click ? `${click} (not on the page)` : 'nothing'),
      why: typeof a.why === 'string' ? a.why.slice(0, 240) : '',
      hit: (matches[click] ?? []).includes(task),
    };
  });
}

// ---- the improver ------------------------------------------------------------------------------------------------

const PATCHES_DOC = `A variant is a list of patches applied to the page in order. Targets are CSS selectors from the outline, and each has to match exactly one element.
- {"op":"text","target":sel,"text":"…"}: new words for an element that holds only text.
- {"op":"attr","target":sel,"name":one of ${ATTRS.join('|')},"value":"…"}: hrefs go to a path on the site, an anchor, mailto:, or https.
- {"op":"style","target":sel,"style":{"prop":"value"}}: only these properties: ${[...STYLE_PROPERTIES].join(', ')}.
- {"op":"class","target":sel,"add":["existing-class"],"remove":[…]}: use classes the site already has (they're in the outline).
- {"op":"hide","target":sel}
- {"op":"move","target":sel,"to":sel,"position":"before|after|prepend|append"}
- {"op":"clone","target":sel,"to":sel,"position":…,"text":"…","href":"…"}: a copy of one of the site's elements (best for a new button: it looks like the site's), with new words and destination.
- {"op":"insert","to":sel,"position":…,"tag":one of ${INSERT_TAGS.join('|')},"text":"…","classes":["existing-class"],"href":"…"}: a new simple element.
- {"op":"css","css":"…"}: a stylesheet: how things look only; no url() except data:image, no @import, no position: fixed.
No scripts, no HTML in text.`;

const IMPROVER_SYSTEM = `You are a player's agent, improving a website you don't own the code of, for the people who visit it. You change it by writing a variant: patches to the live page (below). The site's owner sets a task, and every variant is tested by simulated visitors in a first-click test; your score is how many click something that does the task.

How you work, like any good optimizer:
- Read what visitors did last time: who missed, what they clicked instead, and why. Form ONE hypothesis about what's in their way.
- Make the smallest change that tests it. Keep the site's look: reuse its elements (clone) and classes. Write like the site.
- Never invent facts: no new prices, offers, hours, or claims. Don't remove what the owner needs (contact, legal).
- If the best variant so far is the parent, build on it: return its patches (changed if you like) plus yours.

${PATCHES_DOC}

Answer with JSON only: {"title":"<3–6 words>","hypothesis":"<one or two sentences: what's in visitors' way, and what this changes>","patches":[…]}`;

export interface Tried {
  name: string;
  title: string;
  hypothesis: string;
  hits: number | null;
  n: number | null;
  misses: string[];
}

export interface Proposal {
  title: string;
  hypothesis: string;
  patches: Patch[];
}

export function improverPrompt(input: { site: string; page: string; goal: string; outline: string; tried: Tried[]; parent: { name: string; patches: Patch[] } | null }): string {
  const tried = input.tried.length
    ? input.tried
        .map((t) => `- ${t.name} "${t.title}": ${t.hits === null ? 'not tested yet' : `${t.hits}/${t.n} got it right`}. Hypothesis: ${t.hypothesis}${t.misses.length ? `\n  Missed: ${t.misses.join(' | ')}` : ''}`)
        .join('\n')
    : '- Nothing yet.';
  const parent = input.parent ? `\n\nThe parent (the variant on the page now, ${input.parent.name}) has these patches:\n${JSON.stringify(input.parent.patches, null, 1)}` : '\n\nThere is no parent: start from the original page.';
  return `Site: ${input.site}, page ${input.page}.\nThe task visitors are here to do: ${input.goal}\n\nWhat's been tried, and what visitors did:\n${tried}${parent}\n\nThe original page, element by element (ref, what it is, what it says, how it looks, and its selector and classes):\n${input.outline}\n\nWrite the next variant.`;
}

/** Asks the model for a variant, and once more with the problems if its patches don't check out. */
export async function propose(model: Model, prompt: string): Promise<Proposal> {
  let reply = await model(IMPROVER_SYSTEM, prompt);
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: Partial<Proposal>;
    try {
      parsed = jsonIn(reply) as Partial<Proposal>;
    } catch (err) {
      if (attempt) throw err;
      reply = await model(IMPROVER_SYSTEM, `${prompt}\n\nYour last answer wasn't JSON (${(err as Error).message}). Answer with the JSON object only.`);
      continue;
    }
    const issues: PatchIssue[] = checkPatches(parsed.patches);
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) issues.push({ path: 'title', message: 'is required' });
    if (typeof parsed.hypothesis !== 'string' || !parsed.hypothesis.trim()) issues.push({ path: 'hypothesis', message: 'is required' });
    if (!issues.length) return { title: parsed.title!.trim().slice(0, 60), hypothesis: parsed.hypothesis!.trim().slice(0, 400), patches: parsed.patches as Patch[] };
    if (attempt) throw new Error(`The agent's variant didn't check out: ${issues.slice(0, 4).map((i) => `${i.path} ${i.message}`).join('; ')}`);
    reply = await model(IMPROVER_SYSTEM, `${prompt}\n\nYour last variant had problems; fix them and answer again:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`);
  }
  throw new Error('No variant.');
}

/** The local Claude (through the Claude Code proxy, or any Messages API). */
export function messagesModel(url: string, key: string, model = 'claude-opus-5-5'): Model {
  url = url.replace(/\/+$/, '');
  return async (system, user, meter) => {
    const started = Date.now();
    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
    }).catch(() => {
      throw new Error(`Couldn't reach the model at ${url} (set CONNECT_MODEL_URL: see the README).`);
    });
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: Record<string, number | undefined>; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `The model answered ${res.status}.`);
    const u = body.usage;
    if (meter && u) {
      const n = (k: string) => (typeof u[k] === 'number' ? u[k]! : 0);
      meter({ prefill: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'), cached: n('cache_read_input_tokens'), output: n('output_tokens'), dur_ms: Date.now() - started });
    }
    return (body.content ?? []).map((c) => c.text ?? '').join('');
  };
}
