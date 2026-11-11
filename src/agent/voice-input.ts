/**
 * Talking to the agent: the browser's speech recognition, heard as you go (words appear while you speak) and kept
 * once a phrase is final. Where the browser has none, there's no microphone button and typing does everything.
 *
 * Coaching keeps it on, so you can talk through what you're doing the whole time (Co-play's narrated recording); asking
 * uses it for one request at a time.
 */

interface Recognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

type RecognitionClass = new () => Recognition;

const Speech = (): RecognitionClass | null => ((window as unknown as { SpeechRecognition?: RecognitionClass }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: RecognitionClass }).webkitSpeechRecognition ?? null);

export const canListen = () => Speech() !== null;

export interface Listening {
  stop(): void;
}

/**
 * Listens until stopped: `interim` with what it's hearing so far, `final` with each finished phrase. Recognition ends
 * by itself after a silence in some browsers; while `keepOn`, it starts again.
 */
export function listen(handlers: { interim(text: string): void; final(text: string): void; error(message: string): void; ended?(): void }, keepOn = false): Listening | null {
  const Ctor = Speech();
  if (!Ctor) return null;
  let stopped = false;
  let rec: Recognition;
  const begin = () => {
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0]!.transcript.trim();
        if (r.isFinal) text && handlers.final(text);
        else interim += `${text} `;
      }
      handlers.interim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      stopped = true;
      handlers.error(e.error === 'not-allowed' ? 'The microphone is blocked for this site.' : `Couldn't hear you (${e.error}).`);
    };
    rec.onend = () => {
      if (keepOn && !stopped) begin();
      else handlers.ended?.();
    };
    rec.start();
  };
  begin();
  return {
    stop() {
      stopped = true;
      rec.stop();
    },
  };
}
