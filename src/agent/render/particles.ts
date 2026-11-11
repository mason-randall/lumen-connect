/**
 * Voice mode, v3: the agent as particles. At rest and while it talks, the dots are its waveform: three bands of its own
 * voice (voice-signal.ts, as the soundwave's lines are), the dots streaming along each band like current through a wire.
 * And because it's dots, what it does can be the same dots moving: when it looks at something, a stream of them
 * multiplies out of the waveform and swoops there to frame it and sweep across it; when it has its hands on a control,
 * they swirl around it (on a slider, around the thumb, riding along as it moves, more streaming down the track into
 * it); when it points, they ring the thing and pulse; when it's done, they drift home and merge back in.
 *
 * Nothing is ever quite still: every dot rides a slow flow field, so a formation breathes and shimmers; travelling,
 * they arc instead of flying straight, and fast ones leave a short streak.
 *
 * Looks (`setLook`): aurora (each dot drifting through a saturated spectrum), mono (pearl white), lime (Softmax's lime
 * and cyan), voice (the soundwave's band colors). The colors are mid-bright and haloed so they read on a bright sky and
 * in deep shadow alike. And sand: grains, a speck of sand color a device pixel or two across, lit or in shadow,
 * partly covering what's under it; never outlined, glowing or glinting. They read by how many there are. Sand is the
 * default look. With something else drawn at home (`wave: false`) they lift out of its middle to look and touch, and
 * settle back into it.
 *
 * Everything is drawn on one canvas over the page (it doesn't take the page's clicks), wiped only where the dots were,
 * so a resting agent costs very little.
 */
import type { AgentState, Mood, VoiceLike, VoiceProfile } from '../../voice/index.ts';
import type { Actor } from './types.ts';
import { BANDS, MOOD_LOOK, rgbOf, TRACE } from './soundwave-bands.ts';
import { sampleTrace, SpeechDriver } from './speech-driver.ts';
import type { BandName } from './voice-signal.ts';

/** Something on the page: where it is now (null: gone), and, for a control, the element (a slider's thumb is followed). */
export type Target = (() => DOMRect | null) & { el?: Element };

/** What the travelling dots are doing at a target. */
export type Gesture = 'look' | 'touch' | 'point' | 'wide';

export type ParticleLook = 'aurora' | 'mono' | 'lime' | 'voice' | 'sand';
export const PARTICLE_LOOKS: ParticleLook[] = ['aurora', 'mono', 'lime', 'voice', 'sand'];

export interface ParticleField {
  actor: Actor<VoiceLike>;
  /** Eyes on `target` (null: they come home); `dots`, how many set out (else the usual number). */
  look(target: Target | null, dots?: number): void;
  /** Hands on `target`, or pointing at it, or the whole window (null: they come home); `dots`, how many. */
  touch(target: Target | null, gesture?: Exclude<Gesture, 'look'>, dots?: number): void;
  /** How many of its hands have got there (0–1): the share of the touching dots near their place at the target. */
  reached(): number;
  setLook(look: ParticleLook): void;
  dispose(): void;
}

const BANDS_SHOWN: BandName[] = ['low', 'mid', 'high'];
/** Dots per band in the waveform, and how many points of its trace they ride on. */
const PER_BAND = 22;
const TRACE_POINTS = 32;
/** Dots that set out when it looks, and when it touches. */
const LOOKERS = 120;
const TOUCHERS = 64;
/** Stagger between dots setting out (ms), so they stream rather than jump. */
const STAGGER = 5;
/** Color buckets: dots are drawn a bucket at a time. */
const SHADES = 14;

interface Palette {
  /** Color stops the dots drift through (each dot at its own place, all moving slowly along). */
  stops: [number, number, number][];
  /** A dark ring under each dot, for colors too light to show on a bright page. */
  shadow: number;
  /** How strong the halo is. */
  halo: number;
  /** The waveform's dots take their band's color instead (the voice look). */
  byBand?: boolean;
  /** Grains, not lights (the sand look): specks, each its own color (sand doesn't drift through colors), drawn as the orb draws them. */
  grain?: boolean;
}

const hex = (h: string) => rgbOf(h);
const PALETTES: Record<ParticleLook, Palette> = {
  aurora: { stops: ['#22d3ee', '#60a5fa', '#a78bfa', '#e879f9', '#fb7185', '#fbbf24', '#22d3ee'].map(hex), shadow: 0, halo: 0.22 },
  mono: { stops: ['#ffffff', '#e8eeff', '#ffffff'].map(hex), shadow: 0.4, halo: 0.16 },
  lime: { stops: ['#e5ff00', '#b8ff4a', '#8df7ff', '#e5ff00'].map(hex), shadow: 0.38, halo: 0.2 },
  voice: { stops: ['#5d8ff0', '#ff8a5c', '#5d8ff0'].map(hex), shadow: 0.25, halo: 0.18, byBand: true },
  // Sand (#bd8f59) under a light: × 0.45 (in shadow) to × 1.15 (in the light).
  sand: { stops: ['#554028', '#715635', '#8e6b43', '#aa8150', '#bd8f59', '#d9a466'].map(hex), shadow: 0, halo: 0, grain: true },
};
/**
 * How much of its pixel a grain covers. Out on a page there are hundreds, not thousands, so they cover most of theirs.
 */
const GRAIN_COVER = [0.7, 0.85, 1];
/** The body at home, as a share of its circle's width (where grains lift out of, and settle back into). */
const BODY = 0.28;

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  band: number;
  /** Its place in the formation (0..1), and a little randomness of its own. */
  slot: number;
  seed: number;
  /** Where along the colors it sits. */
  hue: number;
  /** Waiting to set out (or, called home, to start back) (ms). */
  wait: number;
  /** Going home: merges into the waveform when it gets there. */
  home: boolean;
  gesture: Gesture;
  /** A grain in a cloud: how lit its side of the cloud is (0–1; the light from the upper left, as on the orb). */
  lit?: number;
}

const fract = (x: number) => x - Math.floor(x);

/** A slow, swirling flow over the page: the direction a dot drifts at (x, y) now. */
const flow = (x: number, y: number, t: number) => (Math.sin(x * 0.011 + t * 0.7) + Math.sin(y * 0.013 - t * 0.5) + Math.sin((x + y) * 0.006 + t * 0.35)) * 1.1;

/** Where a slider's thumb is (its center), from its value. */
function thumbOf(el: HTMLInputElement, r: DOMRect): [number, number] {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  const t = max > min ? (Number(el.value) - min) / (max - min) : 0.5;
  return [r.left + 8 + t * (r.width - 16), r.top + r.height / 2];
}

/** A point along a rectangle's edge, `u` (0..1) of the way round from its top left. */
function around(r: DOMRect, u: number, pad: number): [number, number] {
  const w = r.width + pad * 2, h = r.height + pad * 2, x = r.left - pad, y = r.top - pad;
  let d = fract(u) * 2 * (w + h);
  if (d < w) return [x + d, y];
  d -= w;
  if (d < h) return [x + w, y + d];
  d -= h;
  if (d < w) return [x + w - d, y + h];
  return [x, y + h - (d - w)];
}

export function createParticles(
  host: HTMLElement,
  options: {
    home: () => DOMRect | null;
    profile: () => VoiceProfile;
    mood?: Mood;
    passive?: boolean;
    look?: ParticleLook;
    /** Places the travelling dots pass behind (a panel, a speech bubble): they're not drawn there. */
    behind?: () => DOMRect[];
    /** Draw the waveform at home (default). Off when something else is drawn there: the dots come out of it. */
    wave?: boolean;
  },
): ParticleField {
  const canvas = document.createElement('canvas');
  canvas.className = 'agent-particles';
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;display:block;';
  host.append(canvas);
  const ctx = canvas.getContext('2d')!;
  const driver = new SpeechDriver(options.profile);
  const bandColors = BANDS_SHOWN.map((b) => rgbOf(MOOD_LOOK[options.mood ?? 'neutral'].colors[b]));
  const trace = new Float32Array(TRACE_POINTS);
  const traces = BANDS_SHOWN.map(() => new Float32Array(TRACE_POINTS));
  const moving = options.passive !== false;

  let palette = PALETTES[options.look ?? 'sand'];
  /** The colors, as strings, a shade at a time: `shades[i]` for the core, `soft[i]` for the halo. */
  let shades: string[] = [];
  let soft: string[] = [];
  function paint(p: Palette) {
    palette = p;
    shades = [];
    soft = [];
    for (let i = 0; i < SHADES; i++) {
      const u = (i / SHADES) * (p.stops.length - 1);
      const a = p.stops[Math.floor(u)]!, b = p.stops[Math.min(p.stops.length - 1, Math.floor(u) + 1)]!;
      const c = a.map((v, k) => Math.round(v + (b[k]! - v) * (u - Math.floor(u))));
      shades.push(`rgb(${c.join(', ')})`);
      soft.push(`rgba(${c.join(', ')}, ${p.halo})`);
    }
    // The voice look: a shade per band, at the end.
    for (const c of bandColors.map((c) => c.map((v) => Math.round(v + (255 - v) * 0.35)))) {
      shades.push(`rgb(${c.join(', ')})`);
      soft.push(`rgba(${c.join(', ')}, ${p.halo})`);
    }
  }
  paint(palette);

  /** The waveform's dots, by band then along it. */
  const wave: Dot[] = [];
  for (let b = 0; b < 3; b++) for (let i = 0; i < PER_BAND; i++) wave.push({ x: NaN, y: NaN, vx: 0, vy: 0, band: b, slot: i / PER_BAND, seed: Math.random(), hue: (b * 0.33 + i / PER_BAND) % 1, wait: 0, home: false, gesture: 'look' });
  let travellers: Dot[] = [];
  let lookAt: Target | null = null;
  let touchAt: Target | null = null;
  let touchGesture: Exclude<Gesture, 'look'> = 'touch';
  let state: AgentState = 'idle';
  let gone = false;
  let frame = 0;
  let last = 0;
  let skipped = 0;
  /** The home, eased: dragging the circle, the waveform trails a little behind. */
  let homeAt: { x: number; y: number; w: number; h: number } | null = null;
  /** The grains' cloud, when it looks: its radius (px), from how many are in it, so it stays as dense however many there are. */
  let lookCloud = 20;
  /** Where the dots were drawn last frame, to wipe only that. */
  let dirty: [number, number, number, number] | null = null;
  /** The waveform's dot sizes, by band. */
  const b0 = [1.55, 1.4, 1.25];

  function size() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    dirty = [0, 0, innerWidth, innerHeight];
  }
  size();
  addEventListener('resize', size);

  /** Dots multiply out of the waveform (or lift out of the body at home, as grains) and set out for `gesture`, streaming. */
  function send(n: number, gesture: Gesture) {
    for (let i = 0; i < n; i++) {
      const from = wave[Math.floor(Math.random() * wave.length)]!;
      const seed = Math.random();
      const hue = Math.random();
      if (options.wave === false && homeAt) {
        // Out of the body, outward, as a grain thrown off it.
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * homeAt.w * BODY;
        // Many grains (one per token) stream out over at most a second and a half; hands go together (0.4 s).
        travellers.push({ x: homeAt.x + Math.cos(a) * r, y: homeAt.y + Math.sin(a) * r, vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 1.6 - 0.6, band: from.band, slot: i / n, seed, hue, wait: i * Math.min(STAGGER, (gesture === 'look' ? 1500 : 400) / n), home: false, gesture });
        continue;
      }
      const x = Number.isNaN(from.x) ? (homeAt?.x ?? 0) : from.x, y = Number.isNaN(from.y) ? (homeAt?.y ?? 0) : from.y;
      travellers.push({ x, y, vx: (Math.random() - 0.5) * 3, vy: -1 - Math.random() * 3, band: from.band, slot: i / n, seed, hue, wait: i * STAGGER, home: false, gesture });
    }
  }

  /** Calls them home: they drift back in a stream, as they came. */
  function recall(gesture: Gesture | 'touching') {
    let i = 0;
    for (const d of travellers) {
      if (d.home || (gesture === 'touching' ? d.gesture === 'look' : d.gesture !== gesture)) continue;
      d.home = true;
      d.wait = Math.max(d.wait, (i++ % 60) * 6);
    }
  }

  /** Where a travelling dot belongs now, in its formation at its target: never quite still. */
  function place(d: Dot, t: number): [number, number] | null {
    const target = d.gesture === 'look' ? lookAt : touchAt;
    const r = target?.();
    if (!r || !r.width) return null;
    const speed = 0.7 + d.seed * 0.9;
    switch (d.gesture) {
      case 'look': {
        // Grains: most go as a cloud of their own, drifting over what it's looking at and turning inside it; a few
        // mark the corners.
        if (palette.grain && d.seed >= 0.15) {
          const cx = r.left + r.width * (0.5 + 0.4 * Math.sin(t * 0.9)), cy = r.top + r.height * (0.5 + 0.36 * Math.sin(t * 0.55 + 1));
          const rr = lookCloud * Math.sqrt(fract(d.seed * 13.7));
          const a = fract(d.seed * 97.31) * Math.PI * 2 + t * (0.4 + 0.5 * fract(d.seed * 3.1)) * (fract(d.seed * 5.3) < 0.5 ? 1 : -1);
          const ox = Math.cos(a) * rr, oy = Math.sin(a) * rr * 0.82;
          d.lit = Math.min(1, Math.max(0, 0.5 - (0.5 * (ox + oy)) / (lookCloud * 1.2)));
          return [cx + ox, cy + oy];
        }
        d.lit = undefined;
        if (d.seed < 0.6) {
          // Corner brackets, breathing: each dot on one corner's L, half along its edge, half along its side.
          const corner = Math.floor(d.slot * 4) % 4;
          const u = fract(d.slot * 4 + t * 0.05 * (d.seed - 0.3));
          const corners: [number, number, number, number][] = [[r.left, r.top, 1, 1], [r.right, r.top, -1, 1], [r.right, r.bottom, -1, -1], [r.left, r.bottom, 1, -1]];
          const [cx, cy, sx, sy] = corners[corner]!;
          const leg = Math.min(r.width, r.height) * 0.3 * (1 + 0.1 * Math.sin(t * 1.6 + corner));
          const inset = 3 * Math.sin(t * 1.6 + corner);
          const along = Math.abs(u - 0.5) * 2;
          // Sand lies in a band, not single file.
          const j = palette.grain ? (fract(d.seed * 7.3) - 0.5) * 7 : 0;
          return u < 0.5 ? [cx + sx * (along * leg - inset), cy + sy * (j - inset)] : [cx + sx * (j - inset), cy + sy * (along * leg - inset)];
        }
        // The sweep: a rippling line of them across, drifting down, a few trailing just behind.
        const sweep = fract(t * 0.28 + (d.seed > 0.9 ? -0.03 : 0));
        const across = fract(d.slot * 2.7 + t * 0.04 * speed);
        const x = r.left + across * r.width;
        return [x, r.top + sweep * r.height + Math.sin(x * 0.035 + t * 4) * 5 + (palette.grain ? (fract(d.seed * 7.3) - 0.5) * 10 : 0)];
      }
      case 'touch': {
        const el = target!.el;
        if (el instanceof HTMLInputElement && el.type === 'range') {
          // A slider: a swirl around its thumb, and more streaming down the track into it.
          const [tx, ty] = thumbOf(el, el.getBoundingClientRect());
          if (d.seed < 0.7) {
            const a = d.slot * Math.PI * 2 + t * (2 + speed * 1.6) * (d.seed < 0.35 ? 1 : -1);
            const rad = palette.grain ? 3 + d.seed * 8 + 1.5 * Math.sin(t * 3 + d.seed * 6) : 10 + d.seed * 12 + 3 * Math.sin(t * 3 + d.seed * 6);
            return [tx + Math.cos(a) * rad, ty + Math.sin(a) * rad * 0.75];
          }
          const left = el.getBoundingClientRect().left + 8;
          const u = fract(d.slot * 3.7 + t * 0.5 * speed);
          return [left + u * (tx - left), ty + Math.sin(t * 5 + d.seed * 9 + u * 6) * 3];
        }
        return around(r, d.slot + t * 0.05 * speed, 7 + Math.sin(t * 2.4 + d.seed * 6) * 3);
      }
      case 'point': {
        const pulse = Math.sin(t * 4.5) * 4;
        return around(r, d.slot + t * 0.09 * speed, 10 + pulse + Math.sin(t * 3 + d.seed * 8) * 2);
      }
      case 'wide':
        return around(r, d.slot + t * 0.025 * speed, -10 + Math.sin(t * 1.5 + d.slot * 20) * 4);
    }
  }

  /**
   * Moves a dot toward (tx, ty): a soft spring, plus a swirl across its way while it's far (so it arcs rather than
   * flying straight), plus the flow it drifts on.
   */
  function steer(d: Dot, tx: number, ty: number, f: number, t: number, k: number, damp: number) {
    const dx = tx - d.x, dy = ty - d.y;
    const dist = Math.hypot(dx, dy) || 1;
    // The arc: a gentle lean across its way, strongest mid-flight, gone by the time it arrives.
    const swirl = Math.min(dist, 360) * 0.008 * Math.min(1, dist / 80) * (d.seed < 0.5 ? 1 : -1);
    const a = flow(d.x, d.y, t);
    const drift = moving ? 0.16 + Math.min(1, dist / 160) * 0.2 : 0;
    d.vx = (d.vx + (dx * k + (-dy / dist) * swirl + Math.cos(a) * drift) * f) * damp ** f;
    d.vy = (d.vy + (dy * k + (dx / dist) * swirl + Math.sin(a) * drift) * f) * damp ** f;
    // A cruising speed (each dot its own): they glide, never shoot. Hands reaching for a far control go faster.
    const top = (7 + d.seed * 5) * (d.gesture !== 'look' && !d.home ? 1 + Math.min(1, dist / 300) : 1);
    const sp = Math.hypot(d.vx, d.vy);
    if (sp > top) {
      d.vx *= top / sp;
      d.vy *= top / sp;
    }
    d.x += d.vx * f;
    d.y += d.vy * f;
  }

  function draw(now: number) {
    if (gone) return;
    frame = requestAnimationFrame(draw);
    const ms = last ? Math.min(64, now - last) : 16;
    last = now;
    const t = now / 1000;
    const f = ms / 16.67;
    driver.tick(ms);
    const speaking = driver.speaking;
    driver.signal.advance(ms, moving ? 1 : 0);
    // With reduced motion, a resting agent holds still between frames it has to draw.
    if (!moving && !speaking && !travellers.length && ++skipped < 4) return;
    skipped = 0;

    // The waveform: each band's trace, its dots streaming along it, in the home's middle.
    const home = options.home();
    if (home) {
      const to = { x: home.left + home.width / 2, y: home.top + home.height / 2, w: home.width, h: home.height };
      homeAt ??= to;
      const e = 1 - 0.72 ** f;
      homeAt = { x: homeAt.x + (to.x - homeAt.x) * e, y: homeAt.y + (to.y - homeAt.y) * e, w: to.w, h: to.h };
      const aw = homeAt.w * 0.7, ax = homeAt.x - aw / 2, cy = homeAt.y;
      const amp = homeAt.h * 0.34;
      const back = driver.signal.trigger(TRACE.head);
      const voiced = Math.min(1, driver.signal.voicing * 3);
      const thinking = state === 'thinking' ? 1 : state === 'working' ? 0.6 : 0;
      for (let b = 0; b < 3; b++) sampleTrace(driver.signal, BANDS_SHOWN[b]!, back, TRACE.head, TRACE_POINTS, traces[b]!);
      for (let b = 0; b < 3; b++) {
        const tr = traces[b]!;
        const height = BANDS[BANDS_SHOWN[b]!].height;
        for (let i = 0; i < PER_BAND; i++) {
          const d = wave[b * PER_BAND + i]!;
          // Streaming along: each band at its own pace, faster while it speaks or thinks.
          const u = fract(i / PER_BAND + t * (0.06 + b * 0.025) * (1 + voiced * 1.5 + thinking));
          const at = u * (TRACE_POINTS - 1), lo = Math.floor(at);
          const v = tr[lo]! + ((tr[Math.min(TRACE_POINTS - 1, lo + 1)] ?? 0) - tr[lo]!) * (at - lo);
          const taper = Math.sin(Math.PI * u) ** 1.2;
          // Quiet, the bands undulate gently around each other; the voice takes over as it speaks.
          const idle = (1 - voiced) * homeAt.h * (0.05 + 0.04 * thinking) * Math.sin(u * Math.PI * (2 + b) + t * (1.1 + b * 0.35 + thinking * 2) + b * 2);
          d.x = ax + u * aw;
          d.y = cy + (b - 1) * (1 - voiced) * homeAt.h * 0.045 + (idle - v * amp * height) * taper;
          d.hue = fract(b * 0.33 + u * 0.5 + t * 0.05);
          d.slot = taper;
        }
      }
    }

    // The travellers: setting out (staggered), keeping their formation, or drifting home to merge back in.
    for (const d of travellers) {
      const at = d.home ? null : place(d, t);
      if (d.wait > 0) {
        d.wait -= ms;
        if (!d.home || at === null) continue;
      }
      if (!palette.grain) d.hue = fract(d.hue + ms * 0.00004);
      if (at) steer(d, at[0], at[1], f, t, 0.03, 0.85);
      else if (options.wave === false && homeAt) {
        // Back into the body: each to its own place in it.
        d.home = true;
        const a = d.seed * 97, r = fract(d.seed * 31) * homeAt.w * BODY * 0.8;
        steer(d, homeAt.x + Math.cos(a) * r, homeAt.y + Math.sin(a) * r, f, t, 0.03, 0.85);
      } else {
        d.home = true;
        const back = wave[(d.band * PER_BAND + Math.floor(d.seed * PER_BAND)) % wave.length]!;
        steer(d, back.x, back.y, f, t, 0.03, 0.85);
      }
    }
    if (homeAt) {
      // Home: merged back in (into the waveform, or into the body, where it settles).
      const hx = homeAt.x, hy = homeAt.y, reach = options.wave === false ? homeAt.w * BODY : homeAt.w * 0.42;
      travellers = travellers.filter((d) => !(d.home && d.wait <= 0 && Math.hypot(d.x - hx, d.y - hy) < reach && Math.hypot(d.vx, d.vy) < 2));
    }

    // Wipe where they were, and draw where they are: halo, ring, streak, and core, a shade at a time.
    const dpr = canvas.width / innerWidth;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dirty) ctx.clearRect(dirty[0], dirty[1], dirty[2] - dirty[0], dirty[3] - dirty[1]);
    // Out in the page (and not behind anything in front of them, like a panel with the conversation in it).
    const covers = options.behind?.() ?? [];
    const hidden = (d: Dot) => covers.some((r) => d.x > r.left - 4 && d.x < r.right + 4 && d.y > r.top - 4 && d.y < r.bottom + 4);
    const out = travellers.filter((d) => (d.home || d.wait <= 0) && !hidden(d));
    if (palette.grain) {
      lookCloud = 3 + 0.45 * Math.sqrt(travellers.filter((d) => d.gesture === 'look' && !d.home).length);
      return void drawGrains(out, dpr);
    }
    const shadeOf = (d: Dot, inWave: boolean) => (palette.byBand && inWave ? SHADES + d.band : Math.floor(d.hue * SHADES) % SHADES);
    const groups: [Dot, number, boolean][][] = Array.from({ length: SHADES + 3 }, () => []);
    if (options.wave !== false) for (const d of wave) if (!Number.isNaN(d.x)) groups[shadeOf(d, true)]!.push([d, (b0[d.band] ?? 1.2) * (0.55 + 0.45 * d.slot), true]);
    for (const d of out) groups[shadeOf(d, palette.byBand ? true : false)]!.push([d, 2 + 0.6 * Math.sin(t * 4 + d.seed * 9), false]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let g = 0; g < groups.length; g++) {
      const dots = groups[g]!;
      if (!dots.length) continue;
      // The halo: soft, wide, in the dot's own color.
      if (palette.halo) {
        ctx.fillStyle = soft[g]!;
        ctx.beginPath();
        for (const [d, r] of dots) {
          const h = r * 3.2;
          ctx.moveTo(d.x + h, d.y);
          ctx.arc(d.x, d.y, h, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      // A dark ring, for the light looks on a bright page.
      if (palette.shadow) {
        ctx.fillStyle = `rgba(10, 12, 24, ${palette.shadow})`;
        ctx.beginPath();
        for (const [d, r] of dots) {
          ctx.moveTo(d.x + r + 1, d.y);
          ctx.arc(d.x, d.y, r + 1, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      // A short streak behind a moving one: a comet's tail, not a line across the page.
      ctx.strokeStyle = shades[g]!;
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      let streaks = false;
      for (const [d, r, inWave] of dots) {
        if (inWave) continue;
        const sp = Math.hypot(d.vx, d.vy);
        if (sp < 2.5) continue;
        streaks = true;
        const len = Math.min(14, sp * 1.6) / sp;
        ctx.lineWidth = r * 1.1;
        ctx.moveTo(d.x - d.vx * len, d.y - d.vy * len);
        ctx.lineTo(d.x, d.y);
      }
      if (streaks) ctx.stroke();
      ctx.globalAlpha = 1;
      // The dot.
      ctx.fillStyle = shades[g]!;
      ctx.beginPath();
      for (const [d, r] of dots) {
        ctx.moveTo(d.x + r, d.y);
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        const reach = r * 3.2 + 16;
        if (d.x - reach < x0) x0 = d.x - reach;
        if (d.x + reach > x1) x1 = d.x + reach;
        if (d.y - reach < y0) y0 = d.y - reach;
        if (d.y + reach > y1) y1 = d.y + reach;
      }
      ctx.fill();
    }
    dirty = x0 <= x1 ? [x0, y0, x1, y1] : null;
  }
  /**
   * A grain: a speck of sand one device pixel across (some two), snapped to the screen's pixels, covering its pixel only partly mostly, in its
   * light or shadow. Nothing more: no glow, no highlight, no glint.
   */
  function drawGrains(out: Dot[], dpr: number) {
    const px = 1 / dpr;
    const covers = GRAIN_COVER.length;
    const byShade: Dot[][] = Array.from({ length: SHADES * covers }, () => []);
    // A grain in the cloud takes the light of its side of it (so the cloud reads as a body, as the orb does); its hands
    // catch the light (the lit half of the sand, as its grains read on dark paper: they work on dark controls).
    for (const d of out) {
      const light = d.home ? d.hue : d.gesture !== 'look' ? 0.45 + 0.55 * d.hue : d.lit === undefined ? d.hue : 0.3 * d.hue + 0.7 * d.lit;
      const shade = Math.min(SHADES - 1, Math.floor(light * SHADES));
      const cover = fract(d.seed * 29) < 0.5 ? 0 : fract(d.seed * 29) < 0.82 ? 1 : 2;
      byShade[cover * SHADES + shade]!.push(d);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let g = 0; g < SHADES * covers; g++) {
      if (!byShade[g]!.length) continue;
      ctx.globalAlpha = GRAIN_COVER[Math.floor(g / SHADES)]!;
      ctx.fillStyle = shades[g % SHADES]!;
      ctx.beginPath();
      for (const d of byShade[g]!) {
        const s = (fract(d.seed * 17) < 0.9 ? 1 : 2) * px;
        ctx.rect(Math.round(d.x * dpr) * px, Math.round(d.y * dpr) * px, s, s);
        if (d.x < x0) x0 = d.x;
        if (d.x > x1) x1 = d.x;
        if (d.y < y0) y0 = d.y;
        if (d.y > y1) y1 = d.y;
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    dirty = x0 <= x1 ? [x0 - 4, y0 - 4, x1 + 6, y1 + 6] : null;
  }

  frame = requestAnimationFrame(draw);

  return {
    actor: {
      setState(next, opts) {
        if (!opts?.once) state = next;
        return Promise.resolve();
      },
      setRecipe: () => Promise.resolve(),
      speech: (opts) => driver.speech(opts),
    },
    look(target, dots = LOOKERS) {
      const was = lookAt;
      lookAt = target;
      if (!target) return recall('look');
      // Already looking: the same dots move to the new place (a closer look), and more join if it's taking in more.
      const out = travellers.filter((d) => d.gesture === 'look' && !d.home).length;
      if (!was || !out) send(dots, 'look');
      else if (dots > out) send(dots - out, 'look');
    },
    touch(target, gesture = 'touch', dots) {
      touchAt = target;
      if (!target) return recall('touching');
      const out = travellers.filter((d) => d.gesture !== 'look' && !d.home);
      if (out.length && touchGesture === gesture && dots === undefined) return;
      for (const d of out) d.gesture = gesture;
      touchGesture = gesture;
      const n = dots ?? (gesture === 'wide' ? LOOKERS : TOUCHERS);
      if (n > out.length) send(n - out.length, gesture);
    },
    reached() {
      const hands = travellers.filter((d) => d.gesture !== 'look' && !d.home);
      if (!hands.length) return 1;
      const t = performance.now() / 1000;
      let near = 0;
      for (const d of hands) {
        const at = d.wait > 0 ? null : place(d, t);
        if (at && Math.hypot(at[0] - d.x, at[1] - d.y) < 40) near++;
      }
      return near / hands.length;
    },
    setLook: (look) => paint(PALETTES[look]),
    dispose() {
      gone = true;
      cancelAnimationFrame(frame);
      removeEventListener('resize', size);
      driver.cancel();
      canvas.remove();
    },
  };
}
