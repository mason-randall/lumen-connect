/**
 * Teaching (the grad cap by your agent; after Co-play's "Coach something"): while it's on, everything you do to teach
 * your agent is kept, in order and timed from the start, in your own words:
 *
 * - your inputs: each control you change (from what to what) or press, and anything you ask the agent;
 * - the outputs: a picture of the screen after each of them (what your move did), and what the agent did, if you had
 *   it try something;
 * - the screen itself, recorded (the tab you share when it starts), with
 * - your voice: recorded with the screen, and heard as you go (each phrase is evidence: you explaining why).
 *
 * Ending it sends the evidence to be learned from (server/policies.ts: analysis, then a new version of the agent's
 * policy that cites it) and keeps the recording, to watch later.
 */
import type { ConnectApi, EvidenceIn, SessionSummary } from '../api.ts';
import { discover, watch, type Control } from './controls.ts';
import { lookNow, type Operator } from './operator.ts';
import { listen, type Listening } from './voice-input.ts';

const FRAME_SIDE = 960;
const SNAPSHOT_SIDE = 480;
const FLUSH_MS = 3000;

const valueOf = (c: Control) => {
  const el = c.el as HTMLInputElement;
  return el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'on' : 'off') : 'value' in el ? String(el.value) : '';
};

const RECORDING_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export interface Teaching {
  /** Each control you change, as you change it (the agent's eyes follow). */
  onMove?: (el: HTMLElement) => void;
  /** The screen share was stopped from the browser's own bar: that ends the lesson too. */
  onEnded?: () => void;
}

export class Coach {
  session: SessionSummary | null = null;
  /** What it's hearing right now, before the phrase is final, and the last thing it heard. */
  interim = '';
  heard = '';
  counts = { move: 0, speech: 0, note: 0, mark: 0, ask: 0, agent: 0 };
  listening = false;
  /** The screen is being recorded (you shared the tab). */
  screen = false;
  /** Something didn't work (the screen or the microphone): said, and the lesson goes on without it. */
  notes: string[] = [];
  error: string | null = null;
  private started = 0;
  private n = 0;
  private pending: EvidenceIn[] = [];
  private values = new Map<string, string>();
  private unwatch: (() => void) | null = null;
  private mic: Listening | null = null;
  private timer = 0;
  private display: MediaStream | null = null;
  private voice: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** The shared screen, playing, for taking frames from. */
  private video: HTMLVideoElement | null = null;

  constructor(
    private api: ConnectApi,
    private operator: Operator,
    private changed: () => void,
  ) {}

  get recording() {
    return !!this.session && !this.session.finished_at;
  }

  elapsed() {
    return this.started ? Date.now() - this.started : 0;
  }

  /**
   * Starts a lesson, from a click: the screen first (the browser asks which tab to share; only a click may ask), then
   * the microphone, then the session.
   */
  async start(teaching: Teaching = {}) {
    this.notes = [];
    this.error = null;
    try {
      this.display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
      this.display.getVideoTracks()[0]?.addEventListener('ended', () => this.recording && teaching.onEnded?.());
      this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: this.display });
      void this.video.play().catch(() => {});
    } catch {
      this.display = null;
      this.notes.push("The screen isn't being recorded (it wasn't shared), so it learns from your moves, your voice, and pictures of the app.");
    }
    try {
      this.voice = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.voice = null;
    }
    this.screen = !!this.display;
    // The screen and your voice, recorded together.
    const tracks = [...(this.display?.getVideoTracks() ?? []), ...(this.voice?.getAudioTracks() ?? [])];
    if (tracks.length && typeof MediaRecorder !== 'undefined') {
      const mimeType = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      this.chunks = [];
      this.recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : undefined);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.start(1000);
    }

    this.session = await this.api.startCoaching();
    this.started = Date.now();
    this.n = 0;
    this.counts = { move: 0, speech: 0, note: 0, mark: 0, ask: 0, agent: 0 };
    this.heard = '';
    const controls = discover(document).controls;
    this.values = new Map(controls.map((c) => [c.ref, valueOf(c)]));
    // Your own moves (trusted events only: the agent's are kept as what the agent did).
    this.unwatch = watch(document, () => discover(document).controls, (c) => {
      const was = this.values.get(c.ref);
      this.values.set(c.ref, c.value);
      if (was === c.value && c.value !== 'pressed') return;
      const el = discover(document).controls.find((x) => x.ref === c.ref)?.el;
      if (el) teaching.onMove?.(el);
      // A moment for the app to redraw, then a picture of what the move did.
      setTimeout(() => this.add('move', c.value === 'pressed' ? `pressed "${c.label}"` : `set "${c.label}" to ${c.value}${was !== undefined ? ` (was ${was})` : ''}`, true), 450);
    });
    this.operator.onStep = (s) => {
      if (s.said || s.did.length) this.add('agent', `${s.said ? `the agent said "${s.said}"` : 'the agent'}${s.did.length ? `; it ${s.did.join('; ')}` : ''}`, true);
      // Its moves aren't yours, but they change where the controls are.
      for (const c of discover(document).controls) this.values.set(c.ref, valueOf(c));
    };
    // Your voice, heard as you go: each phrase you finish is you explaining.
    this.mic = listen(
      {
        interim: (t) => ((this.interim = t), this.changed()),
        final: (t) => {
          this.interim = '';
          this.heard = t;
          this.add('speech', t);
          // Said while the agent works, it's also a correction it hears now.
          if (this.operator.running) this.operator.hear(t);
        },
        error: (m) => ((this.notes = [...this.notes, m]), (this.mic = null), (this.listening = false), this.changed()),
      },
      true,
    );
    this.listening = !!this.mic;
    if (!this.listening) this.notes.push("Talking needs a browser that can hear you (Chrome, Edge, Safari): type in the chat to explain instead.");
    this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
    this.changed();
  }

  /** A picture of what's on the screen now: the shared screen if there is one, else the app's main view. */
  private picture(): { media_type: string; data: string } | null {
    const v = this.video;
    if (v && v.videoWidth) {
      const scale = Math.min(1, FRAME_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.8);
      return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
    }
    const shot = lookNow(SNAPSHOT_SIDE);
    return shot ? { media_type: shot.media_type, data: shot.data } : null;
  }

  private add(kind: EvidenceIn['kind'], text: string, picture = false) {
    if (!this.recording) return;
    const image = picture ? this.picture() : null;
    this.pending.push({ id: `e${++this.n}`, t: this.elapsed(), kind, text, ...(image ? { image } : {}) });
    this.counts[kind]++;
    this.changed();
  }

  note(text: string) {
    this.add('note', text);
  }

  mark() {
    this.add('mark', 'marked this moment', true);
  }

  /** Something you asked or told the agent while teaching. */
  ask(text: string) {
    this.add('ask', text);
  }

  private async flush() {
    if (!this.session || !this.pending.length) return;
    const batch = this.pending.splice(0);
    try {
      this.session = await this.api.sendEvidence(this.session.id, batch);
    } catch (err) {
      this.pending.unshift(...batch);
      this.error = (err as Error).message;
      this.changed();
    }
  }

  private release() {
    clearInterval(this.timer);
    this.unwatch?.();
    this.unwatch = null;
    this.operator.onStep = null;
    this.mic?.stop();
    this.mic = null;
    this.listening = false;
    this.interim = '';
    for (const t of [...(this.display?.getTracks() ?? []), ...(this.voice?.getTracks() ?? [])]) t.stop();
    this.display = this.voice = null;
    this.video = null;
  }

  /**
   * Ends the lesson: the result as it stands, the last of the evidence sent, and the recording (the screen with your
   * voice), which comes back to be kept.
   */
  async stop(): Promise<Blob | null> {
    // A last move's picture may still be on its way; then the result, as you left it.
    await new Promise((r) => setTimeout(r, 500));
    this.add('mark', 'the result, as the player left it', true);
    const recorded = new Promise<Blob | null>((resolve) => {
      const r = this.recorder;
      if (!r || r.state === 'inactive') return resolve(null);
      r.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: r.mimeType || 'video/webm' }) : null);
      r.stop();
    });
    const recording = await recorded;
    this.recorder = null;
    this.release();
    await this.flush();
    if (this.pending.length) throw new Error("Some of the lesson didn't upload; try again.");
    return recording;
  }

  discard() {
    this.recorder?.stop();
    this.recorder = null;
    this.release();
    this.pending = [];
    this.session = null;
    this.changed();
  }
}
