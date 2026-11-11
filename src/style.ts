/** The nav and the Liquid panel's look: Softmax's (ink on paper, Plex, lime for the one action that matters). */
export const FONT_SANS = "'Softmax Plex Sans', 'IBM Plex Sans', system-ui, sans-serif";
export const FONT_MONO = "'Softmax Plex Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace";

/** Plex for the embed, under its own family names so the site's fonts are left alone. Declared on the page: shadow roots can't. */
export const fontFaces = (base: string) =>
  [
    ['Softmax Plex Sans', 400, 'ibm-plex-sans-latin-400-normal'],
    ['Softmax Plex Sans', 600, 'ibm-plex-sans-latin-600-normal'],
    ['Softmax Plex Mono', 500, 'ibm-plex-mono-latin-500-normal'],
    ['Softmax Plex Mono', 600, 'ibm-plex-mono-latin-600-normal'],
  ]
    .map(([family, weight, file]) => `@font-face { font-family: '${family}'; font-weight: ${weight}; font-display: swap; src: url(${base}/fonts/${file}.woff2) format('woff2'); }`)
    .join('\n');

export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root, .presence, .bubble, .sx {
  --sans: ${FONT_SANS}; --mono: ${FONT_MONO};
}
.root {
  --ink: #161616; --ink-2: #5e5e5e; --ink-3: #707070; --line: rgba(22,22,22,.14); --line-strong: rgba(22,22,22,.3);
  --paper: #fffdf4; --paper-2: #f8f6ef; --paper-3: #f0eee6; --lime: #e5ff00; --lime-press: #d7ef00; --cyan: #8df7ff;
  --green: #356443; --red: #b3362b; --blue-800: #1a3875;
  position: fixed; z-index: 2147483000;
  display: flex; gap: 10px;
  font-family: ${FONT_SANS}; font-size: 13px; line-height: 1.45; color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
/* Where the site put it (data-position): bottom right by default, out of the way of the site's own header. */
.root[data-pos="bottom-right"] { right: 16px; bottom: 16px; align-items: flex-end; }
.root[data-pos="top-right"] { right: 16px; top: 16px; align-items: flex-start; }
.root[data-pos="bottom-left"] { left: 16px; bottom: 16px; align-items: flex-end; flex-direction: row-reverse; }
.root[data-pos="top-left"] { left: 16px; top: 16px; align-items: flex-start; flex-direction: row-reverse; }
.root[data-pos$="left"] .tip { right: auto; left: calc(100% + 10px); }

/* The agent-only nav: one circle wherever you put it (orb.ts sets left/top, and which way the panel opens). */
.root.free { display: block; width: var(--orb, 56px); height: var(--orb, 56px); }
.item.orb {
  width: var(--orb, 56px); height: var(--orb, 56px); touch-action: none; cursor: grab;
  border: 1px solid rgba(22,22,22,.1); background: rgba(255,253,244,.88);
  -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: 0 10px 30px rgba(22,22,22,.18), 0 1px 0 rgba(255,255,255,.7) inset;
}
.item.orb:hover { background: rgba(255,253,244,.96); }
/* Open, it keeps its light face (the lines need it) and wears a ring instead. */
.item.orb[aria-pressed="true"] { background: rgba(255,253,244,.96); box-shadow: 0 0 0 2px var(--ink), 0 10px 30px rgba(22,22,22,.18); }
.orb-wave { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; pointer-events: none; }
/* Teaching: the grad cap, on the agent's top right (riding along wherever the circle goes). */
.cap {
  position: absolute; top: -7px; right: -7px; z-index: 2; display: grid; place-items: center;
  width: 26px; height: 26px; padding: 0; border: 1.5px solid rgba(255,255,255,.85); border-radius: 50%;
  background: #17171d; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.35);
  transition: background-color 150ms ease, scale 200ms cubic-bezier(.34,1.56,.64,1);
}
.cap:hover { scale: 1.1; background: #24242c; }
.cap:active { scale: .94; }
.cap .tip { top: auto; right: auto; bottom: calc(100% + 8px); left: 50%; translate: -50% 0; }
/* Above the cap, running toward the room (never off the screen's edge). */
.root.free[data-h="right"] .cap .tip { left: -4px; translate: 0 0; }
.root.free[data-h="left"] .cap .tip { left: auto; right: -4px; translate: 0 0; }
.cap:hover > .tip, .cap:focus-visible > .tip { opacity: 1; transition-delay: 250ms; }
.cap[data-state="on"] { background: var(--red); border-color: #fff; animation: cap-rec 1.6s ease-out infinite; }
.cap[data-state="starting"], .cap[data-state="training"] { cursor: progress; }
.cap[data-state="starting"]::after, .cap[data-state="training"]::after {
  content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid transparent;
  border-top-color: #e5ff00; border-right-color: #8df7ff; animation: spin 900ms linear infinite;
}
@keyframes cap-rec { 0% { box-shadow: 0 0 0 0 rgba(179,54,43,.55), 0 4px 12px rgba(0,0,0,.35); } 100% { box-shadow: 0 0 0 10px rgba(179,54,43,0), 0 4px 12px rgba(0,0,0,.35); } }
.item.cap-item[data-state="on"] { background: var(--red); color: #fff; }
/* While teaching: a strip beside the circle (on the side with room): the time, and what it heard you say. */
.teach-strip {
  position: absolute; top: 50%; translate: 0 -50%; display: flex; align-items: center; gap: 8px;
  max-width: 340px; padding: 7px 12px; border-radius: 999px; white-space: nowrap; overflow: hidden;
  background: rgba(20,20,26,.88); color: #f2f2f5; font: 500 12px/1.2 ${FONT_MONO};
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 8px 24px rgba(0,0,0,.3);
}
.teach-strip[hidden] { display: none; }
.root.free[data-h="right"] .teach-strip { left: calc(100% + 14px); }
.root.free[data-h="left"] .teach-strip { right: calc(100% + 14px); }
.teach-strip .rec-dot { width: 8px; height: 8px; }
.teach-strip[data-state="training"] .rec-dot { background: #8df7ff; }
.strip-time { font-variant-numeric: tabular-nums; }
.strip-heard { overflow: hidden; text-overflow: ellipsis; color: rgba(242,242,245,.75); font: 400 12px/1.2 ${FONT_SANS}; }
/* The particles' circle: dark glass, so every look's dots glow in it. */
.item.orb.dark { background: radial-gradient(circle at 50% 35%, rgba(40,42,56,.92), rgba(14,14,20,.94)); color: var(--paper); box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 10px 30px rgba(0,0,0,.35); }
.item.orb.dark:hover { background: radial-gradient(circle at 50% 35%, rgba(52,54,70,.94), rgba(18,18,26,.95)); }
.item.orb.dark[aria-pressed="true"] { box-shadow: 0 0 0 2px rgba(255,255,255,.75), 0 10px 30px rgba(0,0,0,.35); }
.root.free[data-dragging] .item.orb { cursor: grabbing; scale: 1.08; box-shadow: 0 18px 40px rgba(22,22,22,.28); transition: scale 150ms ease; }
.root.free[data-dragging] .tip { opacity: 0 !important; }
/* Its tip and panel open toward the middle of the screen, where there's room. */
.root.free[data-h="left"] .tip { right: calc(100% + 10px); left: auto; }
.root.free[data-h="right"] .tip { left: calc(100% + 10px); right: auto; }
.root.free .panel { position: absolute; max-height: var(--room, calc(100vh - 24px)); }
.root.free[data-h="right"] .panel { left: calc(100% + 12px); }
.root.free[data-h="left"] .panel { right: calc(100% + 12px); }
.root.free[data-v="up"] .panel { bottom: 0; }
.root.free[data-v="down"] .panel { top: 0; }
button { font: inherit; color: inherit; }
a { color: inherit; }

/* The nav: a glass stack of icons, like the app's. */
.pill {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 6px; border: 1px solid rgba(22,22,22,.1); border-radius: 30px;
  background: rgba(255,253,244,.82); -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: 0 10px 30px rgba(22,22,22,.12), 0 1px 0 rgba(255,255,255,.7) inset;
}
.item {
  position: relative; display: grid; place-items: center; width: 44px; height: 44px; padding: 0;
  border: 0; border-radius: 50%; background: none; color: var(--ink); cursor: pointer; text-decoration: none;
  transition: background-color 150ms ease, scale 300ms cubic-bezier(.34,1.56,.64,1);
}
.item:hover { background: rgba(22,22,22,.07); }
.item:active { scale: .94; }
.item[aria-pressed="true"], .item.here { background: var(--ink); color: var(--paper); }
.item.liquid[aria-pressed="true"] { background: var(--lime); color: var(--ink); }
.mark { width: 44px; height: 44px; }
.mark img { width: 26px; height: 26px; }
.rule { width: 28px; height: 1px; margin: 4px 0; background: rgba(22,22,22,.12); }
.badge-dot { position: absolute; top: 7px; right: 7px; width: 9px; height: 9px; border: 2px solid var(--paper); border-radius: 50%; background: var(--lime); }
.tip {
  position: absolute; right: calc(100% + 10px); top: 50%; translate: 0 -50%; padding: 5px 8px; border-radius: 6px;
  background: var(--ink); color: var(--paper); font: 500 12px/1.2 ${FONT_MONO}; white-space: nowrap; pointer-events: none;
  opacity: 0; transition: opacity 100ms ease;
}
.item:hover > .tip, .item:focus-visible > .tip { opacity: 1; transition-delay: 250ms; }
:focus-visible { outline: 2px solid var(--blue-800); outline-offset: 2px; }

/* The Liquid panel. */
.panel {
  width: 368px; max-height: calc(100vh - 24px); overflow: auto; padding: 16px 16px 14px;
  border: 1px solid rgba(22,22,22,.1); border-radius: 16px; background: #fff;
  box-shadow: 0 18px 48px rgba(22,22,22,.18);
}
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
h2 { margin: 0; font: 600 15px/1.3 ${FONT_MONO}; letter-spacing: -.01em; }
.sub { margin: 2px 0 0; color: var(--ink-3); font-size: 12px; }
.close { width: 28px; height: 28px; border: 0; border-radius: 8px; background: none; color: var(--ink-3); cursor: pointer; display: grid; place-items: center; }
.close:hover { background: var(--paper-2); color: var(--ink); }
.eyebrow { margin: 14px 0 6px; color: var(--ink-3); font: 500 11px/1 ${FONT_MONO}; letter-spacing: .04em; text-transform: uppercase; }
.task { padding: 10px 12px; border-radius: 10px; background: var(--paper-2); }
.rows { display: flex; flex-direction: column; gap: 2px; }
.row {
  display: grid; grid-template-columns: 16px minmax(0,1fr) auto; align-items: center; gap: 10px;
  width: 100%; padding: 8px 8px; border: 0; border-radius: 10px; background: none; text-align: left; cursor: pointer;
}
.row:hover { background: var(--paper); }
.row[aria-current="true"] { background: var(--paper-2); }
.radio { width: 14px; height: 14px; border: 1.5px solid var(--line-strong); border-radius: 50%; }
.row[aria-current="true"] .radio { border: 4px solid var(--ink); }
.row-name { overflow: hidden; font: 500 13px/1.3 ${FONT_MONO}; text-overflow: ellipsis; white-space: nowrap; }
.row-by { display: block; color: var(--ink-3); font: 400 11px/1.3 ${FONT_SANS}; }
.score { display: flex; align-items: center; gap: 8px; font: 600 12px/1 ${FONT_MONO}; font-variant-numeric: tabular-nums; }
.bar { display: flex; gap: 2px; }
.bar i { width: 6px; height: 14px; border-radius: 2px; background: var(--paper-3); }
.bar i.on { background: var(--green); }
.best { padding: 2px 6px; border-radius: 999px; background: var(--lime); font: 600 10px/1.3 ${FONT_MONO}; }
.untested { color: var(--ink-3); font: 400 11px/1 ${FONT_SANS}; }
.detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.hyp { margin: 4px 0 0; color: var(--ink-2); }
.meta { margin: 6px 0 0; color: var(--ink-3); font-size: 12px; }
details { margin-top: 8px; }
summary { color: var(--ink-2); font-size: 12px; cursor: pointer; }
.answers { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.answers li { display: grid; grid-template-columns: 16px 1fr; gap: 6px; font-size: 12px; color: var(--ink-2); }
.answers b { color: var(--ink); font-weight: 600; }
.yes { color: var(--green); }
.no { color: var(--red); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.btn {
  display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 12px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; font: 500 13px/1 ${FONT_MONO}; cursor: pointer; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--paper-2); }
.btn.primary { border-color: transparent; background: var(--lime); }
.btn.primary:hover:not(:disabled) { background: var(--lime-press); }
.btn:disabled { color: rgba(22,22,22,.45); cursor: default; }
.btn.champion { margin-top: 10px; }
.status { margin: 10px 0 0; color: var(--ink-3); font-size: 12px; min-height: 18px; }
.status.error { color: var(--red); }
.spin { display: inline-grid; animation: spin 900ms linear infinite; }
@keyframes spin { to { rotate: 360deg; } }
/* Your agent's panel: what you asked and what it said, the ask box, and its changes to the app. */
.agent-panel { width: 384px; }
.head-actions { display: flex; gap: 2px; }
.hint { margin-top: 12px; }
.log { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; margin: 12px 0 0; padding: 0; list-style: none; }
.line { max-width: 88%; padding: 7px 10px; border-radius: 12px; font-size: 13px; }
.line.you { align-self: flex-end; background: var(--ink); color: var(--paper); border-bottom-right-radius: 4px; }
.line.agent { align-self: flex-start; background: var(--paper-2); border-bottom-left-radius: 4px; }
.line.note { align-self: stretch; max-width: none; color: var(--red); font-size: 12px; }
/* What it's saying now, typing out as it speaks: the unsaid part holds the line's size, so it doesn't jump. */
.line.live .unsaid { visibility: hidden; }
.log.live-only { max-height: none; }
.ask { display: flex; gap: 8px; margin-top: 12px; }
.ask-input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; color: var(--ink); font: 400 13px/1 ${FONT_SANS}; }
.ask-input:focus { outline: 2px solid var(--blue-800); outline-offset: -1px; }
.ask .btn { min-height: 34px; }
.changes { margin-top: 4px; padding-top: 2px; border-top: 1px solid var(--line); }
/* What its last step measurably was (panel.ts measured()). */
.measured { margin: 8px 0 0; color: var(--ink-3); font-size: 12px; }
.measured summary { cursor: pointer; font: 500 11px/1.6 ${FONT_MONO}; letter-spacing: .04em; text-transform: uppercase; }
.measured dl { margin: 6px 0 0; display: grid; gap: 3px; }
.measured dl div { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
.measured dt { color: var(--ink-2); }
.measured dd { margin: 0; font-variant-numeric: tabular-nums; }
.change-list { display: flex; flex-direction: column; gap: 6px; margin: 0 0 10px; padding: 0; list-style: none; }
.change-list li { display: flex; flex-direction: column; }
.change-list .meta { margin: 0; }
/* The agent's tabs, coaching, and policy. */
.tabs { display: flex; gap: 2px; margin: 12px 0 4px; padding: 3px; border-radius: 10px; background: var(--paper-2); }
.tab { position: relative; flex: 1; height: 28px; border: 0; border-radius: 8px; background: none; color: var(--ink-2); font: 500 12px/1 ${FONT_MONO}; cursor: pointer; }
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(22,22,22,.12); }
h3 { margin: 14px 0 4px; font: 600 14px/1.3 ${FONT_MONO}; }
.lead { margin-top: 2px; color: var(--ink-2); font-size: 13px; }
.lead.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
.btn.ghost { border-color: transparent; background: none; color: var(--ink-2); }
.btn.ghost:hover:not(:disabled) { background: var(--paper-2); color: var(--ink); }
.icon-btn { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; cursor: pointer; }
.icon-btn:hover { background: var(--paper-2); }
.icon-btn.on, .btn.talk.on { border-color: var(--red); background: #fdecea; color: var(--red); }
.hearing { margin: 6px 0 0; color: var(--ink-3); font-style: italic; font-size: 12px; }
.rec { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 10px; border-radius: 10px; background: var(--paper-2); }
.rec-time { font: 600 12px/1 ${FONT_MONO}; font-variant-numeric: tabular-nums; }
.rec-tally { margin: 0 0 0 auto; font-size: 11px; text-align: right; }
.rec-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: var(--red); animation: rec 1.2s ease-in-out infinite; }
.rec-dot.small { position: absolute; top: 5px; right: 8px; width: 6px; height: 6px; }
.rec-dot.badge { position: absolute; top: 7px; right: 7px; border: 2px solid var(--paper); width: 11px; height: 11px; }
@keyframes rec { 50% { opacity: .35; } }
.btn.talk { width: 100%; justify-content: center; margin-top: 10px; min-height: 36px; }
.transcript { margin-top: 8px; padding: 8px 10px; border-left: 2px solid var(--line-strong); color: var(--ink-2); font-size: 12px; }
.transcript p { margin: 0 0 4px; }
.transcript .interim { color: var(--ink-3); font-style: italic; }
.proposals { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.proposal { padding: 10px; border: 1px solid var(--line); border-radius: 10px; }
.proposal:not(.picked) { opacity: .55; }
.proposal label { display: grid; grid-template-columns: 16px auto 1fr; align-items: baseline; gap: 8px; cursor: pointer; }
.proposal input { margin: 0; accent-color: var(--ink); translate: 0 2px; }
.layer { padding: 1px 6px; border-radius: 6px; background: var(--paper-3); color: var(--ink-2); font: 500 10px/1.5 ${FONT_MONO}; letter-spacing: .02em; text-transform: uppercase; }
.change { font-weight: 600; }
.replaces { margin: 6px 0 0 24px; color: var(--ink-3); font-size: 12px; }
.replaces b { color: var(--ink-2); font: 500 10px/1 ${FONT_MONO}; text-transform: uppercase; letter-spacing: .03em; }
.why { margin: 6px 0 0 24px; color: var(--ink-2); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0 24px; }
.chip { max-width: 100%; overflow: hidden; padding: 2px 7px; border-radius: 999px; background: var(--paper-2); color: var(--ink-2); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.chip b { color: var(--ink); font: 500 10px/1 ${FONT_MONO}; }
.questions { margin: 0; padding-left: 18px; color: var(--ink-2); font-size: 12px; }
.rules { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.rule-group .layer { display: inline-block; margin: 0 0 4px; }
.rule-group ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.progress { height: 4px; margin-top: 10px; border-radius: 2px; background: var(--paper-3); overflow: hidden; }
.progress i { display: block; height: 100%; background: var(--ink); transition: width 400ms ease; }
.episodes { display: flex; flex-direction: column; gap: 12px; margin: 10px 0 0; padding: 0; list-style: none; }
.thumbs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.thumb { margin: 0; }
.thumb img { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border: 2px solid transparent; border-radius: 8px; background: var(--paper-3); }
.thumb.won img { border-color: var(--green); }
.thumb figcaption { margin-top: 3px; color: var(--ink-3); font: 500 11px/1.2 ${FONT_MONO}; text-align: center; }
.thumb.won figcaption { color: var(--green); font-weight: 600; }
.thumb .settings { margin: 4px 0 0; color: var(--ink-3); font: 400 10px/1.4 ${FONT_MONO}; }
.thumb .settings span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.practice-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.practice-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.practice-list .meta { margin: 0; }
.link { padding: 0; border: 0; background: none; color: var(--blue-800); font: 500 13px/1.3 ${FONT_SANS}; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.episodes .why { margin: 6px 0 0; }
.tab-chat .ask, .tab-coach .ask { margin-top: 10px; }
/* The step's main actions stay in reach at the panel's foot, however long what's above them is. */
.actions.footer { position: sticky; bottom: -14px; z-index: 1; margin: 14px -16px -14px; padding: 12px 16px 14px; border-top: 1px solid var(--line); background: #fff; }
@media (prefers-reduced-motion: reduce) { .spin, .rec-dot, .cap, .cap::after { animation: none; } .item { transition: none; } }
`;
