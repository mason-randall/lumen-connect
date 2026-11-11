/**
 * Voice mode: the agent as a soundwave. It does everything the avatar does, through the same presence (rests,
 * thinks, works, asks, says remarks, talks while replies stream), but as thin lines drawn from its voice itself:
 * every syllable it says is rendered with the same synth and the same voice its speaker plays, split into bands, and
 * played out in time (voice-signal.ts). Each line is a scope trace of one band over the same 20 ms, triggered on the
 * fundamental so a steady sound holds a steady wave; how fast a line waves is its frequency:
 *
 * - low (navy): the fundamental, the voice's pitch itself; deep voices draw long, slow waves, squeaky ones short.
 * - mid (blue): the first formant, the vowel: it changes shape and size between "ah", "oo", and "ee".
 * - high (orange): the second formant, the brightness: wide vowels light it up, round ones barely move it.
 * - pitch (plum): the melody over the last second and a half, measured from the voice: it climbs through a
 *   question, drops at the end of a statement, and jumps on emphasis.
 *
 * Its mood (set_mood) changes the lines too: their colors, their curves, and how dramatic they are (MOOD_LOOK), on
 * top of the voice itself changing with the mood.
 *
 * Not talking, there's no voice to draw: the lines show a faint noise floor, and only glow differently while it thinks
 * or works. A streamed reply is said in step with the chat showing it (presence.ts), so the lines move like a voice
 * exactly while words are appearing.
 */
import type { AgentState, Mood, VoiceLike, VoiceProfile } from '../../voice/index.ts';
import type { Actor } from './types.ts';
import { BANDS, glowOf, MOOD_LOOK, rgbOf, TRACE, type Band } from './soundwave-bands.ts';
import { sampleTrace, SpeechDriver } from './speech-driver.ts';
import { PITCH_POINTS, VoiceSignal, type BandName } from './voice-signal.ts';

/** What the stage needs from a body: the presence drives it; the stage adds the rest. */
export interface Body {
  actor: Actor<VoiceLike>;
  ready: Promise<void>;
  /** Being carried (dragged): it wobbles. */
  flail(on: boolean): void;
  /** Waving hello: it sways. */
  wave(on: boolean): void;
  hover(on: boolean): void;
  /** The agent's mood (its set_mood): in voice mode, the lines' colors, curves, and drama. */
  setMood(mood: Mood): void;
  dispose(): void;
}

/**
 * How loud the noise floor is in each state, when it isn't speaking (1 = at rest). The same faint floor whether it's
 * resting, thinking, or working: the lines only move like a voice while words are coming in. Thinking and working
 * show in how the lines glow instead (`breath`).
 */
const FLOOR: Record<AgentState, number> = { idle: 1, talking: 1, thinking: 1, working: 1, waiting: 0.6, done: 1, error: 1, offline: 0.15 };

/** How far the pitch line reaches: this much above or below the voice's base pitch fills its height. */
const PITCH_SPAN = 0.45;

/** Once it stops talking, the lines settle at least this fast (ms), whatever the mood's ebb. */
const SETTLE_MS = 150;

/** How long a change of mood takes to show (ms): colors and curves blend into the new mood's. */
const MOOD_BLEND_MS = 700;

const GRAY = '#9a9aa0';
const SIGNAL_BANDS: BandName[] = ['low', 'mid', 'high'];

/**
 * A line's height at `u` (0..1 across): tapered to nothing at both ends, like a waveform on a scope; the higher the
 * power, the more it's pinched to a peak in the middle (the mood's `taper`).
 */
const taper = (u: number, power: number) => Math.sin(Math.PI * u) ** power;
/** The pitch line comes in from the past on the left and is full height at "now", on the right. */
const fadeIn = (u: number) => Math.sin((Math.PI / 2) * Math.min(1, u / 0.45)) ** 1.6;

const rms = (values: ArrayLike<number>, n: number) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i]! ** 2;
  return Math.sqrt(sum / n);
};

/**
 * Rounds a trace's curves (the mood's `smooth`, 0..1): a gentle low-pass across it, forwards then backwards so the
 * waves stay where they are.
 */
function roundOff(values: Float32Array, n: number, amount: number) {
  const a = Math.min(0.8, amount * 0.8);
  if (a <= 0.01) return;
  for (let i = 1; i < n; i++) values[i] = a * values[i - 1]! + (1 - a) * values[i]!;
  for (let i = n - 2; i >= 0; i--) values[i] = a * values[i + 1]! + (1 - a) * values[i]!;
}

/** A smooth line through evenly spaced points: curves through the midpoints, so a short trace doesn't look jagged. */
function smoothLine(x: number, w: number, ys: ArrayLike<number>): Path2D {
  const line = new Path2D();
  const n = ys.length;
  let px = x;
  let py = ys[0]!;
  line.moveTo(px, py);
  for (let i = 1; i < n; i++) {
    const nx = x + (i / (n - 1)) * w;
    const ny = ys[i]!;
    line.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    px = nx;
    py = ny;
  }
  line.lineTo(px, py);
  return line;
}

/**
 * A still frame of a voice saying "ah", for voice mode's portrait: each band's head-sized trace, from the same signal
 * the live lines draw, taken in the steady middle of the sound and scaled together so the loudest band reaches 1.
 */
export function stillTraces(voice: VoiceProfile, points: number): Record<BandName, Float32Array> {
  const signal = new VoiceSignal();
  signal.syllable('open', 140, voice, {});
  signal.advance(Math.min(40, voice.blipMs * 0.55), 0);
  const back = signal.trigger(TRACE.head);
  const traces = {} as Record<BandName, Float32Array>;
  for (const b of SIGNAL_BANDS) {
    traces[b] = new Float32Array(points);
    sampleTrace(signal, b, back, TRACE.head, points, traces[b]);
  }
  const peak = Math.max(1e-6, ...SIGNAL_BANDS.flatMap((b) => Array.from(traces[b], Math.abs)));
  for (const b of SIGNAL_BANDS) traces[b] = traces[b].map((v) => v / peak);
  return traces;
}

export function createSoundwave(
  container: HTMLElement,
  options: { framing: 'body' | 'head'; passive: boolean; /** The voice it speaks with now. */ profile: () => VoiceProfile; /** Its mood to start in. */ mood?: Mood },
): Body {
  // Two layers: the glow, blurred, at a fraction of the size and scaled up behind (a blur costs by the pixel, and the
  // upscale softens it further), and the lines themselves, crisp at full size with no blur. Blurring every stroke at
  // full size was what made voice mode lag.
  const layer = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;transition:transform 160ms ease;';
  const glowCanvas = document.createElement('canvas');
  glowCanvas.className = 'agent-soundwave-glow';
  glowCanvas.style.cssText = layer;
  const canvas = document.createElement('canvas');
  canvas.className = 'agent-soundwave';
  canvas.style.cssText = layer;
  // The canvas fills the stage; a stage with no position of its own gets one (never override the frame's own).
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(glowCanvas, canvas);
  const ctx = canvas.getContext('2d')!;
  const gctx = glowCanvas.getContext('2d')!;
  /** The glow layer's size against the stage's (CSS px): a third for the agent's body, half for a small head. */
  const GLOW = options.framing === 'head' ? 0.5 : 1 / 3;
  // Small (a head in a round frame): the three bands; big enough, the pitch line too.
  const bands: Band[] = options.framing === 'head' ? ['low', 'mid', 'high'] : ['low', 'mid', 'high', 'pitch'];
  const driver = new SpeechDriver(options.profile);
  const signal = driver.signal;
  const length = TRACE[options.framing];

  let state: AgentState = 'idle';
  /** What's drawn: the traces, following the measured ones (swelling fast, ebbing slow). */
  const shown: Record<BandName, Float32Array> = { low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0) };
  const fresh = new Float32Array(1024);
  const glow: Record<Band, number> = { low: 0, mid: 0, high: 0, pitch: 0 };
  /** How much of the melody shows: all of it while it speaks; flattening as soon as it stops (no history scrolling on). */
  let melody = 0;
  /** The mood's look as drawn now, blending toward `target` after a change. */
  let target = MOOD_LOOK[options.mood ?? 'neutral'];
  const look = { ...target, colors: Object.fromEntries(bands.map((b) => [b, rgbOf(target.colors[b])])) as Record<Band, [number, number, number]> };
  let burst = 0;
  let hovering = false;
  let carried = false;
  let waving = false;
  let gone = false;
  let frame = 0;
  let last = 0;
  /** Frames since the last one drawn (at rest, every other frame is skipped), and the time they covered. */
  let skipped = 0;
  let carry = 0;
  let tilted = '';
  /**
   * The stage's size and where the wave goes in it, measured when they change (not every frame: reading layout every
   * frame forces the page to lay itself out again).
   */
  let size = { width: 0, height: 0 };
  let box = { x: 0, y: 0, w: 0, h: 0 };
  let onScreen = true;
  const measure = () => {
    size = { width: canvas.clientWidth, height: canvas.clientHeight };
    box = area(size.width, size.height);
  };
  const resized = new ResizeObserver(measure);
  resized.observe(container);
  if (container.parentElement) resized.observe(container.parentElement);
  // Off screen, it still keeps time (its voice and the syllables go on) but draws nothing.
  const seen = new IntersectionObserver((entries) => (onScreen = entries.at(-1)!.isIntersecting));
  seen.observe(container);
  /** Buffers reused frame to frame (no garbage at 60 frames a second). */
  const lines: Record<Band, Float32Array> = { low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0), pitch: new Float32Array(PITCH_POINTS) };
  const cores = new Map<string, CanvasGradient>();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  /** Where the wave goes in the canvas (CSS px): the character's place in the full box, or the frame's visible window. */
  function area(width: number, height: number) {
    if (options.framing === 'body') return { x: width * 0.24, y: height * 0.22, w: width * 0.58, h: height * 0.56 };
    // The head stage is larger than its round frame (and offset in it): draw in the part that shows.
    const own = container.getBoundingClientRect();
    const frameEl = container.parentElement;
    const box = frameEl ? frameEl.getBoundingClientRect() : own;
    const x = Math.max(0, box.left - own.left);
    const y = Math.max(0, box.top - own.top);
    const w = Math.min(own.width, box.width);
    const h = Math.min(own.height, box.height);
    // A head is small: its lines get more of the frame's height, so they still read as a wave.
    return { x: x + w * 0.12, y: y + h * 0.1, w: w * 0.76, h: h * 0.8 };
  }

  /** Moves the look `ms` closer to the mood's. */
  function blend(ms: number) {
    const k = 1 - Math.exp(-ms / MOOD_BLEND_MS);
    for (const key of ['drama', 'taper', 'smooth', 'swellMs', 'ebbMs'] as const) look[key] += (target[key] - look[key]) * k;
    for (const b of bands) {
      const to = rgbOf(target.colors[b]);
      look.colors[b] = look.colors[b].map((c, i) => c + (to[i]! - c) * k) as [number, number, number];
    }
  }

  function draw(now: number) {
    if (gone) return;
    frame = requestAnimationFrame(draw);
    const ms = last ? Math.min(64, now - last) : 16;
    last = now;
    const t = now / 1000;
    driver.tick(ms);

    const speaking = driver.speaking;
    const mode: AgentState = speaking ? 'talking' : state;
    // With reduced motion, the floor holds still: the lines move only while it speaks.
    const floor = options.passive ? FLOOR[mode] * (1 + (hovering ? 0.6 : 0) + burst * 4) : 0;
    signal.advance(ms, floor);
    burst *= Math.exp(-ms / 380);
    // Thinking, the lines' glow breathes slowly; working, it pulses. Never while it speaks.
    const breath = speaking || !options.passive ? 0 : mode === 'thinking' ? 0.5 + 0.5 * Math.sin(t * 2.4) : mode === 'working' ? Math.max(0, Math.sin(t * 6)) : 0;

    if (!size.width) measure();
    const { width, height } = size;
    if (!width || !height) return;
    // At rest (only the faint noise floor moving), every other frame is enough; anything livelier draws every frame.
    const lively = speaking || burst > 0.02 || hovering || carried || waving || breath > 0 || melody > 0.01 || Object.values(glow).some((g) => g > 0.05);
    if (!onScreen || (!lively && ++skipped < 2)) {
      carry += ms;
      return resolveReady();
    }
    skipped = 0;
    // What changes with time on screen (the mood blending in, the lines swelling and ebbing) catches up on skipped frames.
    const dms = Math.min(250, ms + carry);
    carry = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      glowCanvas.width = Math.max(1, Math.ceil(width * GLOW));
      glowCanvas.height = Math.max(1, Math.ceil(height * GLOW));
      cores.clear();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    gctx.setTransform(GLOW, 0, 0, GLOW, 0, 0);
    gctx.clearRect(0, 0, width, height);

    const a = box;
    const cy = a.y + a.h / 2;
    // Hairlines: the glow around them gives them their body.
    const thin = options.framing === 'head' ? 0.7 : Math.max(0.8, Math.min(1.3, a.w / 300));
    const quiet = mode === 'offline';
    blend(dms);
    const swell = 1 - Math.exp(-dms / look.swellMs);
    // Between syllables the lines ebb at the mood's pace; once it has stopped talking they settle quickly, so nothing
    // keeps moving after the reply.
    const ebb = 1 - Math.exp(-dms / (speaking ? look.ebbMs : Math.min(look.ebbMs, SETTLE_MS)));
    // Drama: how tall the lines reach (a head's round frame has less room) and how much they glow.
    const reach = options.framing === 'head' ? Math.min(1.1, look.drama) : look.drama;
    melody += ((speaking ? 1 : 0) - melody) * (speaking ? swell : ebb);
    const flare = 0.6 + 0.4 * look.drama;
    const back = signal.trigger(length);

    ctx.lineCap = gctx.lineCap = 'round';
    ctx.lineJoin = gctx.lineJoin = 'round';
    for (const b of bands) {
      const band = BANDS[b];
      let line: Path2D;
      let loud: number;
      if (b === 'pitch') {
        // The melody: the pitch trace, scrolling left, "now" at the right.
        const ys = lines.pitch;
        for (let i = 0; i < PITCH_POINTS; i++) {
          const rel = Math.max(-1, Math.min(1, (signal.pitchTrail(i) - 1) / PITCH_SPAN));
          ys[i] = cy - rel * (a.h / 2) * band.height * reach * melody * fadeIn(i / (PITCH_POINTS - 1));
        }
        line = smoothLine(a.x, a.w, ys);
        loud = signal.voicing;
      } else {
        const points = Math.max(24, Math.min(length, Math.round(a.w / 1.2)));
        if (shown[b].length !== points) shown[b] = new Float32Array(points);
        sampleTrace(signal, b, back, length, points, fresh);
        const held = shown[b];
        // Louder than what's drawn: swell to it. Quieter: ebb to it, slowly.
        const k = rms(fresh, points) >= rms(held, points) ? swell : ebb;
        if (lines[b].length !== points) lines[b] = new Float32Array(points);
        const ys = lines[b];
        for (let i = 0; i < points; i++) held[i] = held[i]! + (fresh[i]! - held[i]!) * k;
        ys.set(held);
        roundOff(ys, points, look.smooth);
        for (let i = 0; i < points; i++) ys[i] = cy - ys[i]! * (a.h / 2) * band.height * reach * taper(i / (points - 1), look.taper);
        line = smoothLine(a.x, a.w, ys);
        loud = Math.min(1, 2 * rms(held, points));
      }
      glow[b] += (loud - glow[b]) * (loud > glow[b] ? swell : ebb);

      const lineWidth = b === 'high' ? thin * 0.85 : b === 'pitch' ? thin * 0.8 : thin;
      const rgb = look.colors[b];
      const tint = glowOf(rgb);
      // The louder the band, the more it glows.
      const bright = quiet ? 0 : Math.min(1.25, (0.35 + 0.65 * glow[b] + 0.3 * breath) * flare);
      // The glow (on the small layer: its blur is in that layer's pixels, so it's scaled with it): a soft, wide stroke
      // in the band's lighter tint, blurred, and the line's own bloom, a tight blur along it.
      gctx.shadowColor = `rgba(${tint}, ${0.7 * bright})`;
      // (A touch tighter than the old full-size blur: scaling the layer up softens it a little more.)
      gctx.shadowBlur = lineWidth * (options.framing === 'head' ? 5 : 8) * flare * GLOW;
      gctx.strokeStyle = `rgba(${tint}, ${0.2 * bright})`;
      gctx.lineWidth = lineWidth * 3.5;
      gctx.stroke(line);
      gctx.shadowBlur = lineWidth * 2.5 * GLOW;
      gctx.strokeStyle = `rgba(${tint}, ${0.3 * bright})`;
      gctx.lineWidth = lineWidth * 1.2;
      gctx.stroke(line);
      // The line itself: a hairline, fading out at its ends. The pitch line fades only into the past.
      const ink = quiet ? GRAY : `rgb(${rgb.map(Math.round).join(', ')})`;
      const key = `${b}|${ink}|${tint}|${a.x}|${a.w}`;
      let core = cores.get(key);
      if (!core) {
        // Its colors only change while a mood blends in: made once per color, not every frame.
        if (cores.size > 64) cores.clear();
        core = ctx.createLinearGradient(a.x, 0, a.x + a.w, 0);
        core.addColorStop(0, `rgba(${tint}, ${b === 'pitch' ? 0.1 : 0.25})`);
        core.addColorStop(b === 'pitch' ? 0.7 : 0.5, ink);
        core.addColorStop(1, b === 'pitch' ? ink : `rgba(${tint}, 0.25)`);
        cores.set(key, core);
      }
      ctx.strokeStyle = core;
      ctx.globalAlpha = b === 'pitch' ? 0.85 : 0.95;
      ctx.lineWidth = lineWidth;
      ctx.stroke(line);
      if (b === 'pitch') {
        // "Now": a bead at the line's end, brighter while it's voiced, glowing on the glow layer.
        const rel = Math.max(-1, Math.min(1, (signal.pitchTrail(PITCH_POINTS - 1) - 1) / PITCH_SPAN));
        const bx = a.x + a.w;
        const by = cy - rel * (a.h / 2) * band.height * reach * melody;
        gctx.beginPath();
        gctx.arc(bx, by, lineWidth * 1.9, 0, Math.PI * 2);
        gctx.shadowBlur = lineWidth * 8 * flare * GLOW;
        gctx.shadowColor = `rgba(${tint}, ${0.5 + 0.5 * glow.pitch})`;
        gctx.fillStyle = `rgba(${tint}, ${0.3 * (0.45 + 0.55 * glow.pitch)})`;
        gctx.fill();
        ctx.beginPath();
        ctx.arc(bx, by, lineWidth * 1.9, 0, Math.PI * 2);
        ctx.fillStyle = quiet ? GRAY : `rgba(${tint}, ${0.45 + 0.55 * glow.pitch})`;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    gctx.shadowBlur = 0;
    gctx.shadowColor = 'transparent';

    // Carried, it wobbles; waving, it sways (written only when it changes: a style write every frame costs a restyle).
    const tilt = carried ? Math.sin(t * 7) * 9 : waving ? Math.sin(t * 3.2) * 5 : 0;
    const transform = tilt ? `rotate(${tilt.toFixed(2)}deg)` : '';
    if (transform !== tilted) {
      tilted = transform;
      canvas.style.transform = glowCanvas.style.transform = transform;
    }

    resolveReady();
  }
  frame = requestAnimationFrame(draw);

  return {
    ready,
    actor: {
      setState(next, opts) {
        // A moment (a clip played once: a wave, a jump) is a little burst; a state is how it moves until the next.
        if (opts?.once) {
          burst = 0.45;
          return new Promise((r) => setTimeout(r, 900));
        }
        state = next;
        return Promise.resolve();
      },
      // Faces don't show on a soundwave.
      setRecipe: () => Promise.resolve(),
      speech: (opts) => driver.speech(opts),
    },
    flail: (on) => (carried = on),
    wave: (on) => (waving = on),
    hover: (on) => {
      hovering = on;
      if (on) burst = Math.max(burst, 0.2);
    },
    setMood: (mood) => (target = MOOD_LOOK[mood]),
    dispose() {
      gone = true;
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
      driver.cancel();
      canvas.remove();
      glowCanvas.remove();
    },
  };
}
