/**
 * The player's agent using the app with them, in the page. Each step it looks (a picture of the view, and of the part
 * it asked to see up close), asks the agent what to do (server/operator.ts), then says it and does it where the player
 * can see: its eyes on what it's looking at, its hands on each control as it moves it. It follows its policy for the
 * app (server/policies.ts), and hears what the player tells it while it works. When the app can't do what's needed it
 * changes the app's code, reloads, and carries on.
 */
import type { ConnectApi, Step } from '../api.ts';
import { describe, discover, glide, reveal, setValue, watch, type Change, type Control, type View } from './controls.ts';
import { outlinePage, outlineText } from '../outline.ts';
import { boxOf, type Presence, type Target } from './presence.ts';
import { checkRegion, look, regionRect, type Region, type Seen } from './vision.ts';
import { Ledger, pictureTokens } from './facts.ts';

const MAX_STEPS = 8;
/** Its eyes, as grains: one per token of what it's looking at (est.), (1 grain = 1 token), up to 1200. */
const TOKENS_PER_DOT = 1;
const MAX_DOTS = 1200;
/** After a rework the page reloads; the request carries on if it comes back within this long. */
const RESUME_MS = 120_000;

/** A line of the conversation; `at` is when it was said (an agent's line joins the log once it's said, in its place). */
export type Line = { who: 'you' | 'agent' | 'note'; text: string; at?: number };

interface Resume {
  request: string;
  history: string[];
  said: string;
  at: number;
  /** Where the page's controls were (by element id), so the reload doesn't undo the work so far. */
  values?: Record<string, string | boolean>;
}

export interface RunOptions {
  /** The policy version to follow (else the one the player kept). */
  version?: string;
  /** Practicing on its own: at most this many steps, no changes to the app, and nothing said aloud. */
  practice?: number;
}

/** What it did in a step, for whoever's watching (the coaching recorder). */
export interface StepReport {
  said: string;
  did: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (x: number) => String(Number(x.toFixed(3)));

export class Operator {
  running = false;
  private stopped = false;
  private player: Change[] = [];
  private controls: Control[] = [];
  /** What the player has told it since its last step. */
  private heard: string[] = [];
  /** What it last pointed at: left highlighted for a while after it's done, so the player can find it. */
  private pointed: Target | null = null;
  /** Called after each of its steps (the coaching recorder listens). */
  onStep: ((s: StepReport) => void) | null = null;

  constructor(
    private api: ConnectApi,
    private presence: Presence,
    private page: string,
    private events: { line(l: Line): void; busy(label: string | null): void; changed(): void },
    /** What it does, as measured, a step at a time (facts.ts: its model calls, and vision, touch, tools, the loop). */
    readonly ledger = new Ledger(),
  ) {
    // Watching the player use the controls: what they do is part of what the agent knows.
    watch(document, () => (this.controls.length ? this.controls : (this.controls = discover(document).controls)), (c) => {
      const last = this.player.at(-1);
      if (last && last.ref === c.ref) this.player.pop();
      this.player.push(c);
      if (this.player.length > 20) this.player.shift();
    });
  }

  private resumeKey = () => `softmax-connect:resume:${location.host}${this.page}`;

  /** A request that was mid-way when the agent changed the app's code (and the page reloaded). */
  takeResume(): Resume | null {
    const raw = sessionStorage.getItem(this.resumeKey());
    sessionStorage.removeItem(this.resumeKey());
    const r = raw ? (JSON.parse(raw) as Resume) : null;
    return r && Date.now() - r.at < RESUME_MS ? r : null;
  }

  stop() {
    this.stopped = true;
  }

  /** The player tells it something while it works (typed or said): it acts on it in its next step. */
  hear(text: string) {
    this.heard.push(text);
  }

  async run(request: string, resume?: Resume, options: RunOptions = {}) {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.heard = [];
    this.pointed = null;
    const quiet = options.practice !== undefined;
    const history = resume?.history ?? [];
    this.ledger.newRequest();
    let next: Step['look'] = null;
    try {
      if (resume) {
        // The page reloaded with the new code: its controls go back where they were before it did.
        for (const [id, value] of Object.entries(resume.values ?? {})) {
          const el = document.getElementById(id);
          if (!el) continue;
          setValue(el, value);
          if (el instanceof HTMLInputElement && el.type === 'range') el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await this.presence.say(resume.said);
        this.events.line({ who: 'agent', text: resume.said });
      }
      for (let n = 0; n < (options.practice ?? MAX_STEPS) && !this.stopped; n++) {
        this.ledger.begin();
        const { controls, views } = discover(document);
        this.controls = controls;
        const view = views.find((v) => v.ref === next?.view) ?? biggest(views);
        const region = checkRegion(next?.region);
        // What it sees (the pictures first: as many of its grains go there as the tokens they cost, est.).
        // No view to look at (an ordinary page): it reads the page instead, and its eyes are on the whole of it.
        const images = view ? pictures(view, region) : [];
        for (const i of images) this.ledger.picture(i.width, i.height, i.zoom);
        const pageText = view ? undefined : outlineText(outlinePage(document), false);
        const seen = images.reduce((a, i) => a + pictureTokens(i.width, i.height), 0) || Math.ceil((pageText?.length ?? 0) / 4);
        this.presence.see(view ? () => regionRect(view, region) : () => new DOMRect(8, 8, window.innerWidth - 16, window.innerHeight - 16), view ? (region ? 'Looking closer' : 'Looking') : 'Reading the page', Math.min(MAX_DOTS, Math.max(8, Math.round(seen / TOKENS_PER_DOT))));
        if (!quiet) this.events.busy(n === 0 ? (view ? 'Looking at the app…' : 'Reading the page…') : 'Looking at how that came out…');
        this.presence.state('thinking');
        const heard = this.heard.splice(0);

        this.ledger.sent();
        const step = await this.api.act({
          request,
          page: this.page,
          controls: describe(controls, views),
          images: images.map(({ label, media_type, data }) => ({ label, media_type, data })),
          history,
          // Practice is on its own: what the player did elsewhere isn't part of it.
          player: quiet ? [] : this.player.map((c) => `Set "${c.label}" (${c.ref}) to ${c.value}`),
          heard,
          version: options.version,
          practice: options.practice,
          pageText,
        });
        this.ledger.answered(step.calls);
        this.ledger.setPresence('awake');
        if (this.stopped) break;
        if (!quiet) this.events.busy(null);

        // It says it as it does it: live in the bubble, then into the conversation once it's said.
        this.presence.state('working');
        const saidAt = Date.now();
        const talking = step.say && !quiet ? this.presence.say(step.say) : Promise.resolve();
        const did = await this.perform(step.actions, controls);
        await talking;
        this.ledger.end();
        if (step.say && !quiet) this.events.line({ who: 'agent', text: step.say, at: saidAt });
        this.onStep?.({ said: step.say, did });
        history.push(
          [heard.length ? `The player told you: ${heard.map((h) => `"${h}"`).join(' ')}.` : '', step.say && `Said "${step.say}".`, did.length ? `Did: ${did.join('; ')}.` : 'Made no moves.', step.look ? `Asked to look at ${step.look.view}${step.look.region ? ` region ${JSON.stringify(step.look.region)}` : ''}.` : '']
            .filter(Boolean)
            .join(' '),
        );
        next = step.look;

        if (step.rework && !quiet) {
          if (history.some((h) => h.startsWith('Changed the app'))) {
            history.push(`(Wanted another change to the app, "${step.rework}", but only one per request.)`);
            continue;
          }
          await this.rework(request, step.rework, history);
          return;
        }
        // Done, unless the player told it something it hasn't acted on yet.
        if (step.done && !this.heard.length) break;
        await sleep(250);
      }
    } catch (err) {
      this.ledger.end();
      this.ledger.setPresence('failed');
      this.events.line({ who: 'note', text: (err as Error).message });
      if (quiet) throw err;
    } finally {
      this.running = false;
      this.presence.state('idle');
      if (!quiet) this.events.busy(null);
      this.presence.see(null);
      // What it pointed at stays lit while you read what it said.
      if (this.pointed) {
        const pointed = this.pointed;
        this.presence.touch(pointed, 'Here', 'point');
        setTimeout(() => !this.running && this.presence.touch(null), 9000);
      } else this.presence.rest();
      if (!quiet) this.presence.clear(9000);
    }
  }

  /** Its moves, where the player sees them; what it did, in words, for the next step. */
  private async perform(actions: Step['actions'], controls: Control[]): Promise<string[]> {
    const did: string[] = [];
    for (const a of actions) {
      if (this.stopped) break;
      const c = controls.find((x) => x.ref === a.ref);
      if (!c || !c.el.isConnected) {
        did.push(`${a.ref} isn't a control on the page`);
        continue;
      }
      if (c.kind === 'file') {
        did.push(`left "${c.label}" alone (opening files is the player's)`);
        continue;
      }
      // A control in a closed section: it opens the section first, as a person would.
      if (c.folded) {
        reveal(c.el);
        // At once (not smoothly), so its hands land on the control and don't trail the scroll.
        c.el.scrollIntoView({ block: 'nearest' });
        await sleep(200);
      }
      // Its hands on the control (which shows its own name), and on the record: a tool call, and how far it moves it.
      const travel = travelOf(c, a);
      const finish = this.ledger.move('point' in a ? 'point' : 'press' in a || c.kind === 'button' || c.kind === 'link' ? 'press' : 'set', c.label, travel);
      const before = did.length;
      // Its hands, as grains (specks, like its cloud's): 120 to hold the control, and one more for each 0.25% of its
      // range it moves it (a press: 400).
      this.presence.touch(boxOf(c.el), '', 'touch', 120 + Math.round(400 * travel));
      // It moves a control once its hands are there (the first reach, from wherever it is on the screen, is the long
      // one: across a wide window, about two seconds).
      await this.presence.reach(did.length === 0 ? 2500 : 450);
      const el = c.el;
      if ('point' in a) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this.pointed = boxOf(el);
        this.presence.touch(this.pointed, 'Here', 'point');
        did.push(`pointed the player to "${c.label}"`);
        await sleep(1200);
      } else if ('press' in a) {
        if (c.kind === 'link') this.events.line({ who: 'note', text: `Going to ${(el as HTMLAnchorElement).href}` });
        did.push(`${c.kind === 'link' ? 'followed' : 'pressed'} "${c.label}"`);
        el.click();
        await sleep(450);
      } else if (c.kind === 'slider') {
        const x = Number(a.value);
        if (!Number.isFinite(x)) did.push(`"${c.label}" needs a number`);
        else {
          await glide(el as HTMLInputElement, x);
          did.push(`set "${c.label}" to ${fmt(Number((el as HTMLInputElement).value))}`);
        }
      } else if (c.kind === 'switch') {
        const on = a.value === true || a.value === 'true' || a.value === 'on';
        setValue(el, on);
        did.push(`turned "${c.label}" ${on ? 'on' : 'off'}`);
        await sleep(350);
      } else if (c.kind === 'choice') {
        const select = el as HTMLSelectElement;
        const option = [...select.options].find((o) => o.value === String(a.value) || o.text === String(a.value));
        if (!option) did.push(`"${c.label}" has no option "${a.value}"`);
        else {
          setValue(select, option.value);
          did.push(`chose "${option.text}" for "${c.label}"`);
        }
        await sleep(400);
      } else if (c.kind === 'button') {
        el.click();
        did.push(`pressed "${c.label}"`);
        await sleep(450);
      } else if (c.kind === 'link') {
        did.push(`"${c.label}" is a link: point to it, or press it to go there`);
      } else {
        setValue(el, String(a.value));
        did.push(`set "${c.label}" to ${String(a.value).slice(0, 40)}`);
        await sleep(350);
      }
      finish(did.slice(before).join('; '));
    }
    this.presence.touch(null);
    return did;
  }

  /** Changes the app's code, with its hands on the whole app, then reloads to carry on in the changed app. */
  private async rework(request: string, need: string, history: string[]) {
    this.presence.see(null);
    this.presence.touch(() => new DOMRect(8, 8, window.innerWidth - 16, window.innerHeight - 16), "Changing the app's code", 'wide');
    this.events.busy("Changing the app's code…");
    const change = await this.api.rework(need);
    this.events.changed();
    // What the controls are set to now, to put back after the reload (only those with an id to find them by).
    const values = Object.fromEntries(
      discover(document)
        .controls.filter((c) => c.el.id && !['file', 'button', 'link'].includes(c.kind))
        .map((c) => [c.el.id, c.kind === 'switch' ? (c.el as HTMLInputElement).checked : (c.el as HTMLInputElement).value]),
    );
    const resume: Resume = { request, history: [...history, `Changed the app's code: ${change.title} (${change.why})`], said: `I changed the app: ${change.why}`, at: Date.now(), values };
    sessionStorage.setItem(this.resumeKey(), JSON.stringify(resume));
    await sleep(500);
    location.reload();
    await new Promise(() => {}); // the page is going
  }
}

/** How far a move takes a control, before it's made: the share of a slider's range it crosses; 1 for a change of a switch, a choice, a field, or a press; 0 for pointing (or no change). */
function travelOf(c: Control, a: Step['actions'][number]): number {
  if ('point' in a) return 0;
  if ('press' in a) return 1;
  const el = c.el as HTMLInputElement;
  if (c.kind === 'slider') {
    const lo = Number(el.min || 0), hi = Number(el.max || 100), x = Number(a.value);
    return Number.isFinite(x) && hi > lo ? Math.min(1, Math.abs(Math.min(hi, Math.max(lo, x)) - Number(el.value)) / (hi - lo)) : 0;
  }
  if (c.kind === 'switch') return (a.value === true || a.value === 'true' || a.value === 'on') !== el.checked ? 1 : 0;
  return String(a.value) !== el.value ? 1 : 0;
}

export function biggest(views: View[]): View | null {
  const area = (v: View) => v.el.getBoundingClientRect().width * v.el.getBoundingClientRect().height;
  return views.reduce<View | null>((best, v) => (!best || area(v) > area(best) ? v : best), null);
}

/** The main view as it is now (for coaching snapshots and practice). */
export function lookNow(maxSide?: number): Seen | null {
  const view = biggest(discover(document).views);
  return view ? look(view, null, maxSide) : null;
}

/** What it sees: the whole view, and the region it asked for, up close (with its size, and how much closer it is). */
function pictures(view: View, region: Region | null) {
  const out: { label: string; media_type: string; data: string; width: number; height: number; zoom: number }[] = [];
  const whole = look(view);
  if (whole) out.push({ label: `${view.ref} "${view.label}", the whole view as it is now`, media_type: whole.media_type, data: whole.data, width: whole.width, height: whole.height, zoom: 1 });
  const close = region && look(view, region);
  if (close) out.push({ label: `${view.ref} up close: region ${JSON.stringify(region.map((x) => Number(x.toFixed(3))))}`, media_type: close.media_type, data: close.data, width: close.width, height: close.height, zoom: whole ? close.width / region[2] / whole.width : 1 });
  return out;
}
