/**
 * The Softmax overlay: Control and Shift together (pressed and let go, nothing else) on any Connect site, like Steam's
 * in-game overlay. The site dims behind it; across the top, the app you're in, the windows, the time. The windows:
 *
 * - Apps: the sites with Softmax Connect, and what Softmax does on each (from the app's own settings; owners choosing
 *   what Softmax may do there comes later);
 * - Policies: your agent's policy in each app (the version in use, its rules, every version), opening your agent on it;
 * - Friends: who's around, what they and their agents are doing (sample people for now, and it says so).
 *
 * Each window can be put away from the top bar. ⌃⇧ again, Escape, or a click on the dimmed site closes it.
 */
import type { ConnectApi, Overlay } from './api.ts';
import { h, iconEl } from './dom.ts';
import type { IconName } from './icons.ts';

export const OVERLAY_CSS = `
.sx { position: fixed; inset: 0; z-index: 2147483600; display: grid; grid-template-rows: auto minmax(0, 1fr); font: 400 13px/1.45 var(--sans); color: #f2f2ef;
  /* Dim enough to read over even where the blur isn't drawn. */
  background: rgba(9, 9, 13, .66); -webkit-backdrop-filter: blur(12px) saturate(.85); backdrop-filter: blur(12px) saturate(.85);
  opacity: 0; transition: opacity 160ms ease; }
.sx[data-on] { opacity: 1; }
.sx[hidden] { display: none; }
.sx-bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; height: 56px; padding: 0 18px;
  background: rgba(14, 14, 18, .95); border-bottom: 1px solid rgba(255,255,255,.08); }
.sx-where { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sx-where img { width: 22px; height: 22px; display: block; }
.sx-where strong { font-weight: 600; letter-spacing: -.01em; }
.sx-where .sep { width: 1px; height: 18px; background: rgba(255,255,255,.16); }
.sx-where .app { color: #f2f2ef; } .sx-where .origin { color: #8a8a94; font: 400 11.5px/1 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sx-tabs { display: flex; gap: 6px; }
.sx-tab { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px 0 12px; border-radius: 10px; border: 1px solid transparent;
  background: transparent; color: #a8a8b2; font: 500 13px/1 var(--sans); cursor: pointer; }
.sx-tab:hover { background: rgba(255,255,255,.06); color: #f2f2ef; }
.sx-tab[aria-pressed="true"] { background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.1); color: #f2f2ef; }
.sx-tab .n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: rgba(229,255,0,.16); color: #e5ff00; font: 600 11px/18px var(--sans); text-align: center; }
.sx-right { display: flex; align-items: center; justify-content: flex-end; gap: 14px; color: #8a8a94; }
.sx-clock { color: #f2f2ef; font: 500 14px/1 var(--sans); font-variant-numeric: tabular-nums; }
.sx kbd { display: inline-block; min-width: 20px; padding: 3px 5px; border-radius: 5px; border: 1px solid rgba(255,255,255,.16); border-bottom-width: 2px;
  color: #c8c8d0; font: 500 11px/1 var(--sans); text-align: center; }
.sx-close { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: #a8a8b2; cursor: pointer; }
.sx-close:hover { background: rgba(255,255,255,.08); color: #f2f2ef; }
.sx-desk { display: grid; grid-template-columns: minmax(300px, 380px) minmax(360px, 1fr) minmax(280px, 340px); gap: 18px; padding: 22px; min-height: 0; align-items: start; }
.sx-desk[data-n="2"] { grid-template-columns: repeat(2, minmax(320px, 1fr)); }
.sx-desk[data-n="1"] { grid-template-columns: minmax(360px, 640px); justify-content: center; }
.sx-win { display: flex; flex-direction: column; max-height: 100%; min-height: 0; border-radius: 14px; overflow: hidden;
  background: rgba(22, 22, 27, .95); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 24px 60px rgba(0,0,0,.45);
  transform: translateY(8px); transition: transform 200ms ease; }
.sx[data-on] .sx-win { transform: none; }
.sx-win[hidden] { display: none; }
.sx-win > header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,.06); }
.sx-win h2 { margin: 0; font: 600 15px/1.2 var(--sans); letter-spacing: -.01em; color: #f2f2ef; }
.sx-win header .meta { color: #8a8a94; font-size: 12px; }
.sx-body { overflow: auto; padding: 8px 8px 12px; min-height: 0; }
.sx-foot { padding: 10px 16px 12px; border-top: 1px solid rgba(255,255,255,.06); color: #7a7a84; font-size: 11.5px; }
.sx-group { margin: 10px 8px 4px; color: #7a7a84; font: 600 10.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
/* Apps */
.sx-app { display: grid; grid-template-columns: 40px 1fr; gap: 12px; padding: 12px 8px; border-radius: 10px; }
.sx-app + .sx-app { border-top: 1px solid rgba(255,255,255,.05); }
.sx-app[data-here] { background: rgba(255,255,255,.04); }
.sx-tile { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; font: 700 17px/1 var(--sans); color: #15151a; }
.sx-app .name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; color: #f2f2ef; }
.sx-app .origin { color: #7a7a84; font: 400 11.5px/1.4 var(--mono); }
.sx-badge { height: 18px; padding: 0 7px; border-radius: 9px; font: 600 10.5px/18px var(--sans); background: rgba(255,255,255,.08); color: #c8c8d0; }
.sx-badge.lime { background: rgba(229,255,0,.14); color: #e5ff00; }
.sx-does { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; color: #b8b8c0; font-size: 12px; }
.sx-does li { display: grid; grid-template-columns: 14px 1fr; gap: 7px; align-items: start; }
.sx-does li span:first-child { color: #e5ff00; padding-top: 2px; }
.sx-link { color: #c8c8d0; font-size: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; }
.sx-link:hover { color: #f2f2ef; }
/* Policies */
.sx-pol { padding: 12px 10px 14px; border-radius: 10px; }
.sx-pol + .sx-pol { border-top: 1px solid rgba(255,255,255,.05); }
.sx-pol .top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.sx-pol .app { font-weight: 600; color: #f2f2ef; }
.sx-pol .state { color: #8a8a94; font-size: 12px; }
.sx-vers { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0 8px; }
.sx-ver { height: 22px; min-width: 30px; padding: 0 7px; border-radius: 6px; display: inline-grid; place-items: center; background: rgba(255,255,255,.06); color: #9a9aa4; font: 500 11px/1 var(--mono); }
.sx-ver[data-in-use] { background: #e5ff00; color: #15151a; font-weight: 700; }
.sx-rules { margin: 4px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.sx-rules li { display: grid; grid-template-columns: 74px 1fr; gap: 10px; color: #c8c8d0; font-size: 12.5px; line-height: 1.4; }
.sx-rules .layer { color: #7a7a84; font: 600 10px/1.9 var(--mono); letter-spacing: .05em; text-transform: uppercase; }
.sx-rules .text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sx-more { color: #7a7a84; font-size: 12px; margin-top: 6px; }
.sx-btn { display: inline-flex; align-items: center; gap: 7px; height: 30px; margin-top: 12px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14);
  background: rgba(255,255,255,.06); color: #f2f2ef; font: 500 12.5px/1 var(--sans); cursor: pointer; text-decoration: none; }
.sx-btn:hover { background: rgba(255,255,255,.12); }
.sx-empty { color: #8a8a94; font-size: 12.5px; margin-top: 8px; }
/* Friends */
.sx-friend { display: grid; grid-template-columns: 36px 1fr; gap: 10px; align-items: center; padding: 7px 8px; border-radius: 9px; }
.sx-friend:hover { background: rgba(255,255,255,.04); }
.sx-avatar { position: relative; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font: 600 13px/1 var(--sans); color: #f2f2ef; }
.sx-avatar::after { content: ''; position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #16161b; background: #55555f; }
.sx-friend[data-presence="in-app"] .sx-avatar::after { background: #e5ff00; }
.sx-friend[data-presence="online"] .sx-avatar::after { background: #8df7ff; }
.sx-friend[data-presence="away"] .sx-avatar::after { background: #f2b84b; }
.sx-friend[data-presence="offline"] { opacity: .55; }
.sx-friend .who { color: #f2f2ef; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sx-friend .who .agent { color: #8a8a94; font-weight: 400; }
.sx-friend .doing { color: #9a9aa4; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sx-friend[data-presence="in-app"] .doing { color: #e5ff00; }
.sx-loading { padding: 24px 16px; color: #8a8a94; }
@media (max-width: 1100px) { .sx-desk { grid-template-columns: 1fr 1fr; } .sx-desk > :first-child { grid-column: 1 / -1; } }
@media (prefers-reduced-motion: reduce) { .sx, .sx-win { transition: none; } }
`;

type Win = 'apps' | 'policies' | 'friends';
const WINDOWS: [Win, string, IconName][] = [
  ['friends', 'Friends', 'friends'],
  ['policies', 'Policies', 'policy'],
  ['apps', 'Apps', 'apps'],
];
const SHOWN_KEY = 'softmax-connect:overlay:shown';

const TILE_HUES: Record<string, string> = { lumen: '#f2b84b' };
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const ago = (iso: string) => {
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString();
};

export function createOverlay(opts: { api: ConnectApi; shadow: ShadowRoot; base: string; appName: string; openPolicy: () => void }) {
  const { api, shadow, base } = opts;
  let data: Overlay | null = null;
  let error: string | null = null;
  let shown = new Set<Win>(((): Win[] => {
    try {
      const s = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? 'null') as Win[] | null;
      return Array.isArray(s) && s.length ? s : ['friends', 'policies', 'apps'];
    } catch {
      return ['friends', 'policies', 'apps'];
    }
  })());
  let clockTimer = 0;
  let returnFocus: Element | null = null;

  const root = h('div', { class: 'sx', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Softmax', tabindex: '-1', hidden: true });
  shadow.append(root);
  // A click on the dimmed site (not on a window or the bar) closes it, as in Steam.
  root.addEventListener('click', (e) => {
    if (e.target === root || (e.target as HTMLElement).classList?.contains('sx-desk')) close();
  });

  const clock = h('span', { class: 'sx-clock' });
  const tick = () => (clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));

  function toggleWindow(w: Win) {
    if (shown.has(w) && shown.size > 1) shown.delete(w);
    else shown.add(w);
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown]));
    render();
    // The bar was redrawn: the button you pressed keeps the focus.
    root.querySelector<HTMLElement>(`.sx-tab[data-win="${w}"]`)?.focus();
  }

  function appsWindow(d: Overlay) {
    return [
      h('header', {}, h('h2', {}, 'Apps'), h('span', { class: 'meta' }, `${d.apps.length} with Softmax Connect`)),
      h(
        'div',
        { class: 'sx-body' },
        ...d.apps.map((a) =>
          h(
            'div',
            { class: 'sx-app', ...(a.here ? { 'data-here': '' } : {}) },
            h('div', { class: 'sx-tile', style: `background:${TILE_HUES[a.id] ?? '#c8c8d0'}` }, a.name[0]!),
            h(
              'div',
              {},
              h('div', { class: 'name' }, a.name, a.here && h('span', { class: 'sx-badge lime' }, 'You’re here'), h('span', { class: 'sx-badge' }, 'SDK installed')),
              h('div', { class: 'origin' }, a.origin.replace(/^https?:\/\//, '')),
              h('ul', { class: 'sx-does', 'aria-label': `What Softmax does in ${a.name}` }, ...a.does.map((x) => h('li', {}, h('span', { 'aria-hidden': 'true' }, '✓'), h('span', {}, x)))),
              !a.here && h('a', { class: 'sx-link', href: a.origin, target: '_blank', rel: 'noopener' }, `Open ${a.name}`, iconEl('external', 12)),
            ),
          ),
        ),
      ),
      h('div', { class: 'sx-foot' }, 'What Softmax may do on each app will be up to its owner.'),
    ];
  }

  function policiesWindow(d: Overlay) {
    const taught = d.policies.filter((p) => p.versions.length > 1 || p.inUse.rules.length).length;
    return [
      h('header', {}, h('h2', {}, 'Policies'), h('span', { class: 'meta' }, `Your agent’s, in ${d.policies.length} ${d.policies.length === 1 ? 'app' : 'apps'} · ${taught} taught`)),
      h(
        'div',
        { class: 'sx-body' },
        ...d.policies.map((p) => {
          const here = p.app === d.here;
          const shownRules = p.inUse.rules.slice(0, 3);
          return h(
            'div',
            { class: 'sx-pol' },
            h('div', { class: 'top' }, h('span', { class: 'app' }, p.appName), h('span', { class: 'state' }, `v${p.inUse.n} in use · ${p.inUse.rules.length} rule${p.inUse.rules.length === 1 ? '' : 's'}${p.inUse.fromLesson ? ` · from your lesson ${ago(p.inUse.created_at)}` : ''}`)),
            h('div', { class: 'sx-vers', 'aria-label': `${p.versions.length} versions` }, ...p.versions.map((v) => h('span', { class: 'sx-ver', ...(v.inUse ? { 'data-in-use': '' } : {}), title: `v${v.n}: ${v.rules} rules, ${ago(v.created_at)}` }, `v${v.n}`))),
            shownRules.length
              ? h('ul', { class: 'sx-rules' }, ...shownRules.map((r) => h('li', {}, h('span', { class: 'layer' }, r.layer), h('span', { class: 'text' }, r.text))))
              : h('p', { class: 'sx-empty' }, `No rules yet. Teach your agent ${here ? 'here' : `in ${p.appName}`} with the grad cap.`),
            p.inUse.rules.length > shownRules.length && h('p', { class: 'sx-more' }, `and ${p.inUse.rules.length - shownRules.length} more · ${p.lessons} lesson${p.lessons === 1 ? '' : 's'}`),
            here
              ? h('button', { class: 'sx-btn', type: 'button', onClick: () => (close(), opts.openPolicy()) }, iconEl('agent', 14), 'Open in your agent')
              : h('a', { class: 'sx-btn', href: d.apps.find((a) => a.id === p.app)?.origin ?? '#', target: '_blank', rel: 'noopener' }, `Open ${p.appName}`, iconEl('external', 12)),
          );
        }),
      ),
    ];
  }

  function friendsWindow(d: Overlay) {
    const groups: [string, Overlay['friends']][] = [
      ['Playing', d.friends.filter((f) => f.presence === 'in-app')],
      ['Online', d.friends.filter((f) => f.presence === 'online' || f.presence === 'away')],
      ['Offline', d.friends.filter((f) => f.presence === 'offline')],
    ];
    const playing = groups[0]![1].length, online = playing + groups[1]![1].length;
    return [
      h('header', {}, h('h2', {}, 'Friends'), h('span', { class: 'meta' }, `${online} online · ${playing} playing`)),
      h(
        'div',
        { class: 'sx-body' },
        ...groups.flatMap(([title, list]) =>
          list.length
            ? [
                h('p', { class: 'sx-group' }, `${title} · ${list.length}`),
                ...list.map((f) =>
                  h(
                    'div',
                    { class: 'sx-friend', 'data-presence': f.presence },
                    h('div', { class: 'sx-avatar', style: `background:hsl(${f.hue} 34% 30%)`, 'aria-hidden': 'true' }, initials(f.name)),
                    h('div', { style: 'min-width:0' }, h('div', { class: 'who' }, f.name, h('span', { class: 'agent' }, ` · ${f.agent}`)), h('div', { class: 'doing' }, f.doing)),
                  ),
                ),
              ]
            : [],
        ),
      ),
      d.samples.includes('friends') && h('div', { class: 'sx-foot' }, 'Sample friends: Connect isn’t signed in to Softmax yet.'),
    ];
  }

  function render() {
    const tabs = h(
      'nav',
      { class: 'sx-tabs', 'aria-label': 'Windows' },
      ...WINDOWS.map(([w, label, ic]) => {
        const n = w === 'friends' && data ? data.friends.filter((f) => f.presence !== 'offline').length : 0;
        return h('button', { class: 'sx-tab', type: 'button', 'data-win': w, 'aria-pressed': String(shown.has(w)), onClick: () => toggleWindow(w) }, iconEl(ic, 16), label, n ? h('span', { class: 'n' }, String(n)) : null);
      }),
    );
    const bar = h(
      'div',
      { class: 'sx-bar' },
      h('div', { class: 'sx-where' }, h('img', { src: `${base}/brandmark.svg`, alt: '' }), h('strong', {}, 'Softmax'), h('span', { class: 'sep' }), h('span', { class: 'app' }, opts.appName), h('span', { class: 'origin' }, location.host)),
      tabs,
      h('div', { class: 'sx-right' }, h('span', {}, h('kbd', {}, '⌃'), ' ', h('kbd', {}, '⇧'), ' to close'), clock, h('button', { class: 'sx-close', type: 'button', 'aria-label': 'Close Softmax', onClick: close }, iconEl('close', 16))),
    );
    const order: Win[] = ['apps', 'policies', 'friends'];
    const visible = order.filter((w) => shown.has(w));
    const desk = h('div', { class: 'sx-desk', 'data-n': String(visible.length) });
    if (!data) desk.append(h('div', { class: 'sx-win' }, h('div', { class: 'sx-loading' }, error ?? 'Loading…')));
    else for (const w of visible) desk.append(h('section', { class: 'sx-win', 'aria-label': w }, ...(w === 'apps' ? appsWindow(data) : w === 'policies' ? policiesWindow(data) : friendsWindow(data))));
    root.replaceChildren(bar, desk);
    tick();
  }

  function open() {
    if (!root.hidden) return;
    returnFocus = document.activeElement;
    root.hidden = false;
    render();
    requestAnimationFrame(() => root.setAttribute('data-on', ''));
    root.focus();
    clockTimer = window.setInterval(tick, 10_000);
    // Fresh each time (a lesson may have made a new version since).
    void api.overlay().then(
      (d) => ((data = d), (error = null), render()),
      (err: Error) => ((error = `Couldn't load Softmax: ${err.message}`), render()),
    );
  }

  function close() {
    if (root.hidden) return;
    root.removeAttribute('data-on');
    clearInterval(clockTimer);
    setTimeout(() => (root.hidden = true), 160);
    (returnFocus as HTMLElement | null)?.focus?.();
  }

  // Escape closes it, wherever the focus is (and the site under it doesn't get the key).
  addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || root.hidden) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    },
    true,
  );

  return {
    open,
    close,
    toggle: () => (root.hidden ? open() : close()),
    get isOpen() {
      return !root.hidden;
    },
  };
}

/**
 * Control and Shift pressed together and let go with nothing else pressed (so ⌃⇧Tab and the like still do what they do).
 */
export function onControlShift(run: () => void) {
  const down = new Set<string>();
  let armed = false, spoiled = false;
  const reset = () => (down.clear(), (armed = false), (spoiled = false));
  addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Control' || e.key === 'Shift') {
        down.add(e.key);
        if (down.size === 2 && !e.altKey && !e.metaKey) armed = true;
      } else if (down.size) spoiled = true;
    },
    true,
  );
  addEventListener(
    'keyup',
    (e) => {
      if (e.key !== 'Control' && e.key !== 'Shift') return;
      if (armed && !spoiled) run();
      armed = false;
      down.delete(e.key);
      if (!down.size) spoiled = false;
    },
    true,
  );
  addEventListener('blur', reset);
}
