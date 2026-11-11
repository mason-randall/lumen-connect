/**
 * The agent, present on the page. Three primitives, each one thing you can see:
 *
 * - Touch: what it's working on. A moving gradient traces whatever it has its hands on (a slider it's moving, a
 *   button it's pressing, the whole app while it changes the code).
 * - Vision: what it's looking at. A viewfinder on the view or the part of it it's studying.
 * - Talk: what it says to you. The app's chat bubble, by its place in the nav, in its own voice, typing in step with
 *   it (the same pace as the voice, so words and sound never drift apart).
 *
 * All of it is drawn in the embed's shadow root, over the page, and never takes the page's clicks.
 */
import { AGENT_RECIPE, AUTO_VOICE, createVoicePlayer, resolveVoice, voiceFor, type VoicePlayer, type VoiceProfile } from '../voice/index.ts';
// The app's voice mode, as is: the agent as a soundwave drawn from its own voice (one renderer for the app and the embed).
import { createSoundwave, type Body } from './render/soundwave.ts';
// And v3: the agent as particles, whose dots are also what it looks at and touches.
import { createParticles, type Gesture, type ParticleField, type ParticleLook } from './render/particles.ts';

/** Letters a second: the voice's pace and the bubble's. */
export const CHARS_PER_SECOND = 14;

/** Something on the page: where it is now; for a control, the element too (the particles follow a slider's thumb). */
export type Target = (() => DOMRect | null) & { el?: Element };

/** An element's box, with its label's when the label sits apart (a slider and its name read as one thing). */
export function boxOf(el: Element): Target {
  const box = () => {
    if (!el.isConnected) return null;
    let r = el.getBoundingClientRect();
    const label = (el as HTMLInputElement).labels?.[0];
    if (label && !label.contains(el)) {
      const l = label.getBoundingClientRect();
      // Only a label close by (the same row or just above): one far away would stretch the box over half the page.
      if (Math.abs(l.top - r.top) < 60 && Math.abs(l.left - r.left) < 400) {
        const parent = el.parentElement!.getBoundingClientRect();
        const left = Math.min(r.left, l.left), top = Math.min(r.top, l.top);
        r = new DOMRect(left, top, Math.max(r.right, l.right, Math.min(parent.right, r.right)) - left, Math.max(r.bottom, l.bottom) - top);
      }
    }
    return r.width || r.height ? r : null;
  };
  return Object.assign(box, { el });
}

export const PRESENCE_CSS = `
.presence { position: fixed; inset: 0; z-index: 2147482990; pointer-events: none; }
.touch, .vision { position: fixed; left: 0; top: 0; opacity: 0; transition: opacity 220ms ease; }
.touch[data-on], .vision[data-on] { opacity: 1; }

/* Touch: a gradient ring that moves around what the agent has its hands on, a glow behind it, a faint wash inside. */
.touch { border-radius: 12px; }
.touch-ring, .touch-glow > div {
  position: absolute; inset: 0; padding: 2px; border-radius: inherit; overflow: hidden;
  -webkit-mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
}
.touch-glow { position: absolute; inset: -2px; border-radius: 14px; filter: blur(7px); opacity: .85; }
.touch-glow > div { padding: 5px; }
.swirl {
  position: absolute; left: 50%; top: 50%; width: 200vmax; height: 200vmax; translate: -50% -50%;
  background: conic-gradient(from 0deg, #e5ff00, #8df7ff, #9b8cff, #ff8ad8, #ffb36b, #e5ff00);
  animation: swirl 2.4s linear infinite;
}
.touch-wash {
  position: absolute; inset: 2px; border-radius: 10px;
  background: linear-gradient(110deg, rgba(229,255,0,.07), rgba(141,247,255,.08), rgba(255,138,216,.07));
  background-size: 300% 100%; animation: wash 3s ease-in-out infinite alternate;
}
@keyframes swirl { to { rotate: 360deg; } }
@keyframes wash { to { background-position: 100% 0; } }

/* Vision: a viewfinder, its corners and a slow sweep of light, in the cool color. */
.vision { transition: opacity 220ms ease, left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1), width 420ms cubic-bezier(.2,.8,.2,1), height 420ms cubic-bezier(.2,.8,.2,1); }
.corner { position: absolute; width: 18px; height: 18px; border: 2px solid #8df7ff; filter: drop-shadow(0 0 4px rgba(141,247,255,.8)) drop-shadow(0 1px 1px rgba(0,0,0,.5)); }
.corner.tl { left: 0; top: 0; border-right: 0; border-bottom: 0; border-radius: 6px 0 0 0; }
.corner.tr { right: 0; top: 0; border-left: 0; border-bottom: 0; border-radius: 0 6px 0 0; }
.corner.bl { left: 0; bottom: 0; border-right: 0; border-top: 0; border-radius: 0 0 0 6px; }
.corner.br { right: 0; bottom: 0; border-left: 0; border-top: 0; border-radius: 0 0 6px 0; }
.sweep { position: absolute; inset: 0; overflow: hidden; border-radius: 6px; }
.sweep::after {
  content: ''; position: absolute; left: 0; right: 0; height: 30%; top: -30%;
  background: linear-gradient(180deg, transparent, rgba(141,247,255,.13) 70%, rgba(141,247,255,.35) 98%, transparent);
  animation: sweep 2.6s cubic-bezier(.45,0,.55,1) infinite;
}
@keyframes sweep { to { top: 100%; } }
.vision-label, .touch-label {
  position: absolute; left: 0; bottom: calc(100% + 6px); display: flex; align-items: center; gap: 6px;
  padding: 3px 8px; border-radius: 999px; white-space: nowrap;
  font: 500 11px/1.3 var(--mono); color: #0d2a2d; background: #8df7ff; box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.touch-label { color: #161616; background: linear-gradient(90deg, #e5ff00, #8df7ff); }
.vision-label:empty, .touch-label:empty { display: none; }

/* Talk: the app's chat bubble, by the agent's place in the nav, its tail toward it. */
.bubble {
  position: fixed; z-index: 2147483001; max-width: 300px; width: max-content; pointer-events: auto;
  border: 1px solid rgba(22,22,22,.14); border-radius: 16px; background: #fffdf4; color: #161616;
  box-shadow: 0 8px 20px rgba(0,0,0,.18);
  animation: bubble-in 180ms cubic-bezier(.2,.9,.3,1.2) both;
}
.bubble-body { display: block; width: 100%; padding: 12px 14px; border: 0; border-radius: inherit; background: none; color: inherit; text-align: left; font: 400 14px/1.4 var(--sans); cursor: pointer; }
.unsaid { visibility: hidden; }
.bubble::after { content: ''; position: absolute; width: 12px; height: 12px; border: 1px solid rgba(22,22,22,.14); border-width: 1px 1px 0 0; background: #fffdf4; bottom: 16px; }
.bubble[data-tail="left"]::after { left: -7px; rotate: -135deg; }
.bubble[data-v="down"]::after { top: 16px; bottom: auto; }
.bubble[data-tail="right"]::after { right: -7px; rotate: 45deg; }
@keyframes bubble-in { from { opacity: 0; scale: .85; } }
.bubble[data-tail="left"] { transform-origin: 0 100%; }
.bubble[data-tail="right"] { transform-origin: 100% 100%; }

/* Working: the agent's place in the nav wears the touch gradient. */
.item.agent[data-working]::before {
  content: ''; position: absolute; inset: 0; border-radius: 50%; padding: 2px;
  background: conic-gradient(from 0deg, #e5ff00, #8df7ff, #9b8cff, #ff8ad8, #ffb36b, #e5ff00);
  -webkit-mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  animation: swirl 2.4s linear infinite;
}
/* Over what the agent has its hands on, its panel and bubble fade so you can see it; hovering brings them back. */
.peek { opacity: .12; transition: opacity 250ms ease; }
.peek:hover { opacity: 1; }
/* v3: the particles, over everything (the nav and its panel too), never taking a click. */
.particles { position: fixed; inset: 0; z-index: 2147483002; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .swirl, .touch-wash, .sweep::after, .item.agent[data-working]::before { animation: none; }
  .vision, .bubble { transition: none; animation: none; }
}
`;

type Child = Node | string;
function el(tag: string, cls: string, ...children: Child[]) {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...children);
  return e;
}

export class Presence {
  private layer = el('div', 'presence');
  private touchBox = el('div', 'touch', el('div', 'touch-glow', el('div', '', el('div', 'swirl'))), el('div', 'touch-wash'), el('div', 'touch-ring', el('div', 'swirl')), el('span', 'touch-label'));
  private visionBox = el('div', 'vision', el('div', 'sweep'), el('i', 'corner tl'), el('i', 'corner tr'), el('i', 'corner bl'), el('i', 'corner br'), el('span', 'vision-label'));
  private touching: Target | null = null;
  private seeing: Target | null = null;
  private frame = 0;
  private bubble: HTMLElement | null = null;
  private voice: VoicePlayer | null = null;
  private audio: AudioContext | null = null;
  private saying = 0;
  /** Its voice: the generic agent's (the embed doesn't know the player's look yet). */
  private readonly profile: VoiceProfile = (() => {
    const recipe = AGENT_RECIPE;
    return resolveVoice(AUTO_VOICE, recipe) ?? voiceFor(recipe);
  })();
  /** The agent in voice mode, where the nav shows it: it says what the bubble says, and its lines (or dots) are that voice. */
  private wave: Pick<Body, 'actor' | 'dispose'> | null = null;
  /** v3: the particles, which also go where it looks and what it touches. */
  private dots: ParticleField | null = null;
  private speech: { cancel(): void } | null = null;
  muted = false;
  /**
   * The agent's panel is open: what it says types out there, as it says it (`onLive`), and there's no bubble. The
   * bubble is for when the panel is closed.
   */
  panelOpen: () => boolean = () => false;
  /** What it's saying, as far as it's got (null: it stopped). */
  onLive: ((text: string | null, shown: number) => void) | null = null;

  constructor(
    private shadow: ShadowRoot,
    /** The agent's place in the nav: the bubble sits by it. */
    private anchor: () => HTMLElement | null,
  ) {
    this.layer.append(this.visionBox, this.touchBox);
    shadow.append(this.layer);
  }

  /** From a click or key press: browsers only let sound start from one. */
  wake() {
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume();
      this.voice ??= createVoicePlayer(this.audio, this.profile, { seed: 'softmax-agent' });
      this.voice.setMuted(this.muted);
    } catch {
      this.voice = null;
    }
  }

  /** Shows the agent in `container` as its soundwave (voice mode, a head's three lines). */
  showWave(container: HTMLElement) {
    this.wave?.dispose();
    this.wave = createSoundwave(container, { framing: 'head', passive: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, profile: () => this.profile });
  }

  /**
   * Shows the agent as particles (v3), their waveform in `home` (its place in the nav, wherever that is now). Its looking
   * and touching are then those dots, travelling, in place of the ring and the viewfinder.
   */
  showParticles(home: () => HTMLElement | null, look?: ParticleLook) {
    this.wave?.dispose();
    const host = el('div', 'particles');
    this.shadow.append(host);
    // They pass behind the panel and the bubble (what it's saying stays clear to read).
    const behind = () => [...this.shadow.querySelectorAll<HTMLElement>('.panel, .bubble, .teach-strip:not([hidden])')].map((e) => e.getBoundingClientRect());
    this.dots = createParticles(host, { home: () => home()?.getBoundingClientRect() ?? null, profile: () => this.profile, passive: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, look, behind });
    this.wave = { actor: this.dots.actor, dispose: () => (this.dots?.dispose(), host.remove(), (this.dots = null)) };
  }

  /** What it's doing, for its lines' glow: breathing while it thinks, pulsing while it works. */
  state(state: 'idle' | 'thinking' | 'working') {
    void this.wave?.actor.setState(state);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.voice?.setMuted(muted);
  }

  /** Hands on `target` (null: hands off): working a control, pointing at something, or all over the app. */
  touch(target: Target | null, label = '', gesture: Exclude<Gesture, 'look'> = 'touch', dots?: number) {
    this.touching = target;
    if (this.dots) this.dots.touch(target, gesture, dots);
    else {
      this.touchBox.querySelector('.touch-label')!.textContent = label;
      this.touchBox.toggleAttribute('data-on', !!target);
    }
    this.track();
  }

  /** Eyes on `target` (null: looking away). */
  see(target: Target | null, label = '', dots?: number) {
    this.seeing = target;
    if (this.dots) this.dots.look(target, dots);
    else {
      this.visionBox.querySelector('.vision-label')!.textContent = label;
      this.visionBox.toggleAttribute('data-on', !!target);
    }
    this.track();
  }

  /** Says `text`: the bubble types it as the voice says it. Resolves once it's said. */
  async say(text: string): Promise<void> {
    const id = ++this.saying;
    this.bubble?.remove();
    this.bubble = null;
    let said: HTMLElement | null = null;
    let unsaid: HTMLElement | null = null;
    /** The bubble, made when it's needed (the panel's closed), from wherever the sentence has got to. */
    const bubbleUp = () => {
      const body = el('button', 'bubble-body');
      body.setAttribute('type', 'button');
      body.setAttribute('aria-label', text);
      said = document.createElement('span');
      unsaid = el('span', 'unsaid', text);
      body.append(said, unsaid);
      const bubble = el('div', 'bubble', body);
      bubble.setAttribute('role', 'status');
      body.addEventListener('click', () => this.hush());
      this.bubble = bubble;
      this.shadow.append(bubble);
      this.place();
      this.track();
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    const typing = new Promise<void>((resolve) => {
      const tick = () => {
        if (id !== this.saying) return resolve();
        const n = reduced ? text.length : Math.min(text.length, Math.floor(((performance.now() - start) / 1000) * CHARS_PER_SECOND) + 1);
        // In the panel when it's open; in the bubble when it isn't (and each follows the panel opening or closing).
        if (this.panelOpen()) {
          this.bubble?.remove();
          this.bubble = null;
        } else if (!this.bubble) bubbleUp();
        if (this.bubble && said && unsaid) {
          (said as HTMLElement).textContent = text.slice(0, n);
          (unsaid as HTMLElement).textContent = text.slice(n);
        }
        this.onLive?.(text, n);
        if (n >= text.length) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });
    // Said through the soundwave when it's showing, so the lines are the very syllables the speaker plays (and still
    // move with sound off); else by the speaker alone.
    const speaking = this.wave
      ? (() => {
          const s = this.wave.actor.speech({ charsPerSecond: CHARS_PER_SECOND, ...(this.voice ? { voice: this.voice } : {}) });
          this.speech = s;
          s.push(text);
          return s.end();
        })()
      : this.voice?.say(text, { charsPerSecond: CHARS_PER_SECOND });
    await Promise.all([typing, speaking?.catch(() => {})]);
  }

  /** Takes the bubble down (after a while to read it, unless it's said something since). */
  clear(afterMs = 0) {
    const id = this.saying;
    setTimeout(() => id === this.saying && this.hush(), afterMs);
  }

  private hush() {
    this.saying++;
    this.speech?.cancel();
    this.speech = null;
    this.voice?.stop();
    this.bubble?.remove();
    this.bubble = null;
    this.onLive?.(null, 0);
  }

  /**
   * Its hands getting there: resolves once most of them have reached what it's touching (the particles; they come
   * from wherever it is on the screen), or after `maxMs`. Without particles, a moment.
   */
  async reach(maxMs: number) {
    const start = performance.now();
    do await new Promise((r) => setTimeout(r, 60));
    while (this.dots && this.dots.reached() < 0.6 && performance.now() - start < maxMs);
    if (!this.dots) await new Promise((r) => setTimeout(r, 120));
  }

  /** Done: hands off, eyes away. The bubble stays up a moment to be read. */
  rest() {
    this.touch(null);
    this.see(null);
  }

  /** Beside the agent, toward the middle of the screen (it can be anywhere: the agent-only nav moves). */
  private place() {
    // Opening the panel takes a bubble that's still up away: what it said is in the panel.
    if (this.bubble && this.panelOpen()) {
      this.bubble.remove();
      this.bubble = null;
    }
    const a = this.anchor()?.getBoundingClientRect();
    if (!this.bubble || !a) return;
    const right = a.left + a.width / 2 > window.innerWidth / 2;
    const low = a.top + a.height / 2 > window.innerHeight / 2;
    this.bubble.dataset.tail = right ? 'right' : 'left';
    this.bubble.dataset.v = low ? 'up' : 'down';
    const s = this.bubble.style;
    s.left = right ? '' : `${a.right + 14}px`;
    s.right = right ? `${window.innerWidth - a.left + 14}px` : '';
    // Level with the agent's foot when it's low on the screen, with its head when it's high.
    s.bottom = low ? `${Math.max(8, window.innerHeight - a.bottom - 2)}px` : '';
    s.top = low ? '' : `${Math.max(8, a.top + 2)}px`;
  }

  /** Follows the targets as the page scrolls, resizes, or reflows, while there's something to follow. */
  private track() {
    if (this.frame) return;
    const step = () => {
      this.frame = 0;
      const pad = 6;
      for (const [box, target, p] of [
        [this.touchBox, this.touching, pad],
        [this.visionBox, this.seeing, 0],
      ] as const) {
        const r = target?.();
        if (!r) continue;
        box.style.left = `${r.left - p}px`;
        box.style.top = `${r.top - p}px`;
        box.style.width = `${r.width + p * 2}px`;
        box.style.height = `${r.height + p * 2}px`;
      }
      this.place();
      this.peek();
      if (this.touching || this.seeing || this.bubble) this.frame = requestAnimationFrame(step);
      else this.peek();
    };
    this.frame = requestAnimationFrame(step);
  }

  /** What it has its hands on shows through its own panel and bubble, where they're over it (hover brings them back). */
  private peek() {
    const t = this.touching?.();
    // Not for the whole app (while it changes the code): only something it could be hidden behind.
    const r = t && t.width * t.height < (window.innerWidth * window.innerHeight) / 2 ? t : null;
    for (const el of this.shadow.querySelectorAll<HTMLElement>('.panel, .bubble')) {
      const b = el.getBoundingClientRect();
      const over = !!r && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
      el.classList.toggle('peek', over);
    }
  }
}
