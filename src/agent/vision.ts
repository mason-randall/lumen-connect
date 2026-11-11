/**
 * The agent's eyes: a picture of what's in a view (a canvas, image, or video on the page), or of a region of it, small
 * enough to send. Only what the page itself can read: a canvas tainted by another origin's pixels can't be seen.
 */
import type { View } from './controls.ts';

/** A region of a view, each 0–1 of its width and height. */
export type Region = [x: number, y: number, w: number, h: number];

export interface Seen {
  media_type: 'image/jpeg';
  /** Base64, no data: prefix. */
  data: string;
  width: number;
  height: number;
}

const MAX_SIDE = 768;

function sizeOf(el: View['el']): [number, number] {
  if (el instanceof HTMLCanvasElement) return [el.width, el.height];
  if (el instanceof HTMLImageElement) return [el.naturalWidth, el.naturalHeight];
  return [el.videoWidth, el.videoHeight];
}

export function look(view: View, region: Region | null = null, maxSide = MAX_SIDE): Seen | null {
  const [W, H] = sizeOf(view.el);
  if (!W || !H) return null;
  const [rx, ry, rw, rh] = region ?? [0, 0, 1, 1];
  const sx = rx * W, sy = ry * H, sw = Math.max(1, rw * W), sh = Math.max(1, rh * H);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  try {
    canvas.getContext('2d')!.drawImage(view.el, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.82);
    return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height };
  } catch {
    return null; // tainted: another origin's pixels
  }
}

/** Where a region of a view is on the screen (the view's box, letterboxing aside). */
export function regionRect(view: View, region: Region | null): DOMRect {
  const box = view.el.getBoundingClientRect();
  if (!region) return box;
  const [x, y, w, h] = region;
  return new DOMRect(box.left + x * box.width, box.top + y * box.height, w * box.width, h * box.height);
}

/** A region the agent named, checked: four numbers in 0–1 that stay inside the view. */
export function checkRegion(r: unknown): Region | null {
  if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x, y, w, h] = (r as number[]).map((n) => Math.min(1, Math.max(0, n))) as Region;
  if (w < 0.02 || h < 0.02) return null;
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
}
