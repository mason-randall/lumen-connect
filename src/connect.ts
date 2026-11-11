/**
 * Softmax Connect: one script tag puts Softmax on any site.
 *
 *   <script src="https://connect.softmax.com/connect.js" data-site="lumen" async></script>
 *
 * (`data-position`: where the nav sits, `bottom-right` by default; `data-client`: the Softmax client its links open;
 * `data-nav="agent"`: only your agent, as one circle you can drag anywhere, instead of the whole nav: see orb.ts.)
 *
 * - The nav: Softmax's sections and your agent, on the site, in a shadow root so neither page nor nav restyles the other.
 * - Liquid: the site's pages change through variants (see patches.ts), safe to try from anyone. A visitor picks one to
 *   see; the owner's champion is what everyone sees by default.
 * - Your agent: it uses the site with you, through the page's own controls (sliders, switches, buttons, found from the
 *   HTML: see agent/controls.ts), where you can see what it touches, what it looks at, and hear what it says
 *   (agent/presence.ts). On a site that shares its code, it changes the code when the site can't do what it needs.
 * - A coworld: the site's tasks (what visitors are here to do) are the game, variants are the policies, simulated
 *   visitors are the episodes, and their first clicks are the score. "Improve with my agent" is one round of the loop.
 */
import { createAgent } from './agent/panel.ts';
import { PRESENCE_CSS } from './agent/presence.ts';
import { ConnectApi, type Board, type Result, type Scored, type Site, type Task } from './api.ts';
import { h, iconEl, type Child } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { ORB, placeOrb } from './orb.ts';
import { createOverlay, onControlShift, OVERLAY_CSS } from './overlay.ts';
import { outlinePage, outlineText } from './outline.ts';
import { applyVariant, type Applied } from './patches.ts';
import { CSS, fontFaces } from './style.ts';

const SECTIONS: [IconName, string, string][] = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['player', 'Players', 'players'],
  ['policy', 'Policies', 'policies'],
  ['coworld', 'Coworlds', 'coworlds'],
  ['leaderboard', 'Leaderboards', 'leaderboards'],
  ['cogent', 'Cogents', 'cogents'],
  ['opponent', 'Opponents', 'opponents'],
];

const first = (persona: string) => persona.split(/[ ,]/)[0];

interface State {
  site: Site;
  task: Task | null;
  board: Board | null;
  /** The variant on the page (null: the original). */
  current: string | null;
  applied: Applied | null;
  open: boolean;
  /** The agent's panel is open. */
  agentOpen: boolean;
  busy: string | null;
  error: string | null;
}

async function main() {
  const script = document.currentScript as HTMLScriptElement | null;
  const src = script?.src ?? '';
  const siteId = script?.dataset.site;
  if (!src || !siteId) return console.warn('[softmax] connect.js needs data-site="<your site id>"');
  const base = new URL(src).origin;
  const client = script!.dataset.client ?? 'http://localhost:5173';
  const api = new ConnectApi(base, siteId);
  const page = location.pathname;
  const choiceKey = `softmax-connect:${siteId}:${page}`;

  const faces = document.createElement('style');
  faces.textContent = fontFaces(base);
  document.head.append(faces);

  // Out of the page's layout: everything in it is fixed to the window, so the host itself takes no room (as a grid or
  // flex item it would otherwise add a row, and what's inside could make the page scroll).
  const host = h('div', { 'data-softmax-connect': '', style: 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000' });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', {}, CSS + PRESENCE_CSS + OVERLAY_CSS));
  const position = ['top-right', 'bottom-right', 'top-left', 'bottom-left'].includes(script!.dataset.position ?? '') ? script!.dataset.position! : 'bottom-right';
  // The whole nav (a pill in a corner), or only your agent (a circle you put anywhere).
  const agentOnly = script!.dataset.nav === 'agent';
  const root = h('div', agentOnly ? { class: 'root free' } : { class: 'root', 'data-pos': position });
  shadow.append(root);
  document.body.append(host);

  let site: Site;
  try {
    site = await api.siteInfo();
  } catch (err) {
    return console.warn('[softmax] Connect is unavailable:', (err as Error).message);
  }
  const state: State = { site, task: site.tasks.find((t) => t.page === page) ?? null, board: null, current: null, applied: null, open: false, agentOpen: false, busy: null, error: null };
  const agent = createAgent({ api, site, page, shadow, render: () => render() });
  // The Softmax overlay (Steam's, in spirit): Control and Shift together, on any Connect site.
  const overlay = createOverlay({ api, shadow, base, appName: site.name, openPolicy: () => ((state.agentOpen = true), (state.open = false), render(), agent.showTab('policy')) });
  onControlShift(() => overlay.toggle());
  const stored = localStorage.getItem(choiceKey);
  state.current = stored === 'original' ? null : (stored ?? site.champion ?? null);

  const variants = () => state.board?.variants ?? [];
  const byId = (id: string | null) => variants().find((v) => v.id === id) ?? null;

  /** Shows `id` on the page (null: the original), taking the last one off first. */
  function show(id: string | null, remember = true) {
    state.applied?.undo();
    state.applied = null;
    state.current = id;
    if (remember) localStorage.setItem(choiceKey, id ?? 'original');
    const v = byId(id);
    if (!v) return;
    state.applied = applyVariant(document, v.patches);
    if (state.applied.skipped.length) void api.report(v.id, state.applied.skipped).catch(() => {});
  }

  /** The page as it is now (with whatever variant is on it), for visitors; and the original, for the agent. */
  function capture(original: boolean) {
    const keep = state.current;
    if (original && keep) show(null, false);
    const o = outlinePage(document, state.task ? [{ id: state.task.id, success: state.task.success }] : []);
    if (original && keep) show(keep, false);
    return o;
  }

  async function refresh() {
    if (!state.task) return;
    state.board = await api.board(page, state.task.id);
  }

  async function run(label: string, work: () => Promise<void>) {
    state.busy = label;
    state.error = null;
    render();
    try {
      await work();
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      state.busy = null;
      render();
    }
  }

  const test = () =>
    run('Trying it with 6 visitors…', async () => {
      const o = capture(false);
      const labels = Object.fromEntries(o.items.map((i) => [i.ref, i.text]));
      await api.evaluate({ page, task: state.task!.id, variant: state.current, outline: outlineText(o, false), matches: o.matches, labels });
      await refresh();
    });

  const improve = () =>
    run('Your agent is reading the page and what visitors did…', async () => {
      const o = capture(true);
      const v = await api.improve({ page, task: state.task!.id, parent: state.current, outline: outlineText(o, true) });
      await refresh();
      show(v.id);
      render();
      state.busy = 'Trying it with 6 visitors…';
      render();
      const after = capture(false);
      const labels = Object.fromEntries(after.items.map((i) => [i.ref, i.text]));
      await api.evaluate({ page, task: state.task!.id, variant: v.id, outline: outlineText(after, false), matches: after.matches, labels });
      await refresh();
    });

  function scoreEl(score: Scored['score']) {
    if (!score) return h('span', { class: 'untested' }, 'not tested');
    const share = score.hits / score.n;
    const filled = Math.round(share * 6);
    return h('span', { class: 'score' }, h('span', { class: 'bar', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => h('i', { class: i < filled ? 'on' : '' }))), `${score.hits}/${score.n}`);
  }

  function bestId(): string | null | undefined {
    const all: { id: string | null; s: Scored['score'] }[] = [{ id: null, s: state.board?.original.score ?? null }, ...variants().map((v) => ({ id: v.id, s: v.score }))];
    const tested = all.filter((a) => a.s);
    if (!tested.length) return undefined;
    return tested.sort((a, b) => b.s!.hits / b.s!.n - a.s!.hits / a.s!.n)[0]!.id;
  }

  function panel(): HTMLElement {
    const task = state.task;
    const best = bestId();
    const row = (id: string | null, name: string, by: string, score: Scored['score']) =>
      h(
        'button',
        { class: 'row', type: 'button', 'aria-current': String(state.current === id), onClick: () => (show(id), render()) },
        h('span', { class: 'radio', 'aria-hidden': 'true' }),
        h('span', { class: 'row-name' }, name, h('span', { class: 'row-by' }, by)),
        h('span', { class: 'score' }, scoreEl(score), best === id && score ? h('span', { class: 'best' }, 'best') : null),
      );
    const current = byId(state.current);
    const latest: Result | null = state.current ? (current?.latest ?? null) : (state.board?.original.latest ?? null);
    return h(
      'section',
      { class: 'panel', 'aria-label': 'Liquid' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'This site is liquid'), h('p', { class: 'sub' }, `${site.name} · ${page}`)), h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onClick: () => ((state.open = false), render()), html: icon('close', 16) })),
      task
        ? h('div', {}, h('p', { class: 'eyebrow' }, 'The task'), h('div', { class: 'task' }, task.goal))
        : h('p', { class: 'sub' }, 'No task on this page yet: the owner sets what visitors are here to do.'),
      task && h('p', { class: 'eyebrow' }, 'Variants · first clicks that got it right'),
      task &&
        h(
          'div',
          { class: 'rows' },
          row(null, 'Original', 'the site as built', state.board?.original.score ?? null),
          ...variants().map((v, i) => row(v.id, `v${i + 1} ${v.title}`, `by ${v.author.name}${site.champion === v.id ? ' · champion' : ''}`, v.score)),
        ),
      task &&
        h(
          'div',
          { class: 'detail' },
          current
            ? h(
                'div',
                {},
                h('strong', {}, current.title),
                h('p', { class: 'hyp' }, current.hypothesis),
                h('p', { class: 'meta' }, `${current.patches.length} change${current.patches.length === 1 ? '' : 's'}${state.applied?.skipped.length ? ` · ${state.applied.skipped.length} didn't fit this page` : ''}`),
              )
            : h('strong', {}, 'The original'),
          // The owner ships a winner: the champion is what every visitor sees, until they pick another.
          site.champion !== state.current &&
            h('button', { class: 'btn champion', type: 'button', disabled: !!state.busy, onClick: () => run('Making it the champion…', async () => void (site.champion = (await api.champion(state.current)).champion)) }, iconEl('check', 16), state.current ? 'Make it the champion' : 'Go back to the original for everyone'),
          site.champion === state.current && state.current && h('p', { class: 'meta' }, 'The champion: what every visitor sees.'),
          latest &&
            h(
              'details',
              { open: state.current !== null || undefined },
              h('summary', {}, `What ${latest.n} visitors clicked first`),
              h(
                'ul',
                { class: 'answers' },
                ...latest.answers.map((a) => h('li', {}, h('span', { class: a.hit ? 'yes' : 'no', html: icon(a.hit ? 'check' : 'close', 14) }), h('span', {}, h('b', {}, first(a.persona)), ` clicked “${a.clicked}”. ${a.why}`))),
              ),
            ),
        ),
      task &&
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', disabled: !!state.busy, onClick: improve }, iconEl('improve', 16), 'Improve with my agent'),
          h('button', { class: 'btn', type: 'button', disabled: !!state.busy, onClick: test }, iconEl('visitors', 16), 'Test'),
        ),
      h('p', { class: `status${state.error ? ' error' : ''}`, role: 'status' }, state.busy ? h('span', {}, h('span', { class: 'spin', html: icon('loading', 14) }), ' ', state.busy) : (state.error ?? '')),
    );
  }

  // The agent-only nav: the circle stays the same element (a render mid-drag mustn't drop it); the panel has a slot.
  // In it, your agent in voice mode: its soundwave (v2, `data-wave="lines"`), or its particles (v3,
  // `data-wave="particles"`), whose dots also go where it looks and what it touches.
  const wave = h('span', { class: 'orb-wave', 'aria-hidden': 'true' });
  const orb = agentOnly ? h('button', { class: 'item agent orb', type: 'button' }, wave, h('span', { class: 'tip' })) : null;
  // `data-look`: sand (the default), or aurora, mono, lime, voice.
  const look = (['aurora', 'mono', 'lime', 'voice', 'sand'] as const).find((l) => l === script!.dataset.look) ?? 'sand';
  if (script!.dataset.wave === 'particles') {
    agent.presence.showParticles(() => orb ?? shadow.querySelector<HTMLElement>('.item.agent'), look);
    orb?.classList.add('dark');
  } else if (orb) agent.presence.showWave(wave);
  const slot = h('div', { class: 'slot' });
  if (orb) placeOrb(root, `softmax-connect:orb:${siteId}`, position, ORB).attach(orb, () => ((state.agentOpen = !state.agentOpen), render(), state.agentOpen && agent.focus()));

  // Teaching: the grad cap on your agent's top right. Pressed, it records what you do, the screen, and your voice;
  // pressed again, it trains a new policy from all of it (panel.ts). The strip beside it says it's listening.
  const cap = h('button', { class: 'cap', type: 'button', onClick: () => void agent.toggleTeaching() }, iconEl('cap', 15), h('span', { class: 'tip' }));
  const capTime = h('span', { class: 'strip-time' });
  const capHeard = h('span', { class: 'strip-heard' });
  const strip = h('div', { class: 'teach-strip', role: 'status', hidden: true }, h('span', { class: 'rec-dot' }), capTime, capHeard);
  const CAP_LABEL = { off: 'Teach your agent: show it, and say why', starting: 'Starting the lesson…', on: 'Finish the lesson (it learns from it)', training: 'Training your new policy…' } as const;
  const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function renderCap(el: HTMLElement) {
    const t = agent.teach;
    el.dataset.state = t;
    el.setAttribute('aria-label', CAP_LABEL[t]);
    el.setAttribute('aria-pressed', String(t === 'on'));
    el.querySelector('.tip')!.textContent = CAP_LABEL[t];
    (el as HTMLButtonElement).disabled = t === 'starting' || t === 'training';
  }
  function renderStrip() {
    const t = agent.teach;
    strip.hidden = !(t === 'on' || t === 'training') || state.agentOpen;
    strip.dataset.state = t;
    capTime.textContent = t === 'training' ? 'Learning from your lesson…' : clock(agent.coach.elapsed());
    const heard = agent.coach.interim || agent.coach.heard;
    capHeard.textContent = t === 'on' ? (heard ? `“${heard}”` : agent.coach.listening ? 'Listening: show it, and say why' : 'Show it what you do') : '';
  }
  setInterval(() => agent.teach === 'on' && renderStrip(), 500);

  function renderOrb() {
    const label = state.agentOpen ? 'Close your agent' : 'Your agent · drag to move · ⌃⇧ for Softmax';
    orb!.setAttribute('aria-label', label);
    orb!.setAttribute('aria-pressed', String(state.agentOpen));
    orb!.toggleAttribute('data-working', agent.working);
    orb!.querySelector('.tip')!.textContent = label;
    renderCap(cap);
    renderStrip();
    if (orb!.parentElement !== root || cap.parentElement !== root) root.replaceChildren(slot, orb!, cap, strip);
    slot.replaceChildren(...(state.agentOpen ? [agent.panel(() => ((state.agentOpen = false), render()))] : []));
  }

  function render() {
    // A render rebuilds the panel around the same text boxes: whichever had focus keeps it (and its caret).
    const focused = shadow.activeElement as HTMLInputElement | null;
    const caret = focused && 'selectionStart' in focused ? focused.selectionStart : null;
    if (orb) renderOrb();
    else renderNav();
    if (focused?.isConnected && shadow.activeElement !== focused) {
      focused.focus();
      if (caret !== null) focused.setSelectionRange?.(caret, caret);
    }
    const log = root.querySelector('.log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function renderNav() {
    const item = (name: IconName, label: string, props: Record<string, unknown>, extra?: Child) =>
      h(props.href ? 'a' : 'button', { class: 'item', 'aria-label': label, ...(props.href ? {} : { type: 'button' }), ...props }, iconEl(name), h('span', { class: 'tip' }, label), extra);
    const pill = h(
      'nav',
      { class: 'pill', 'aria-label': 'Softmax' },
      h('a', { class: 'item mark', href: client, target: '_blank', rel: 'noopener', 'aria-label': 'Softmax' }, h('img', { src: `${base}/brandmark.svg`, alt: '' }), h('span', { class: 'tip' }, 'Softmax')),
      item('agent', state.agentOpen ? 'Close your agent' : 'Your agent', { class: 'item agent', 'aria-pressed': String(state.agentOpen), 'data-working': agent.working || undefined, onClick: () => ((state.agentOpen = !state.agentOpen), (state.open = false), render(), state.agentOpen && agent.focus()) }),
      (() => {
        const c = item('cap', CAP_LABEL[agent.teach], { class: 'item cap-item', onClick: () => void agent.toggleTeaching() });
        renderCap(c);
        return c;
      })(),
      item('liquid', state.open ? 'Close Liquid' : 'Liquid: this site, improved', { class: 'item liquid', 'aria-pressed': String(state.open), onClick: () => ((state.open = !state.open), (state.agentOpen = false), render()) }, state.current ? h('span', { class: 'badge-dot', 'aria-hidden': 'true' }) : null),
      h('span', { class: 'rule', 'aria-hidden': 'true' }),
      ...SECTIONS.map(([name, label, id]) => item(name, label, { href: `${client}/#/${id}`, target: '_blank', rel: 'noopener' })),
      h('span', { class: 'rule', 'aria-hidden': 'true' }),
      item('sign-in', 'Sign in with Softmax', { href: client, target: '_blank', rel: 'noopener' }),
    );
    root.replaceChildren(...(state.agentOpen ? [agent.panel(() => ((state.agentOpen = false), render()))] : state.open ? [panel()] : []), pill);
  }

  render();
  void agent.start(() => ((state.agentOpen = true), render()));
  if (state.task) {
    await refresh().catch((err: Error) => (state.error = err.message));
    show(state.current, false);
    render();
  }
}

void main();
