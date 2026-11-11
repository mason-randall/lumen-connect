/**
 * The agent-only nav (`data-nav="agent"`): one circle, your agent, that you put wherever you like. Drag it anywhere
 * on the screen (or move it with the arrow keys when it has focus); it stays there across visits, as a share of the
 * window so it keeps its place when the window changes size. A click (not a drag) opens your agent. Its panel opens
 * toward whichever side has room: `data-h` (left/right) and `data-v` (up/down) on the root, and `--room` for how tall
 * it can be.
 */

export const ORB = 56;
const MARGIN = 10;
/** Moved this far, it's a drag, not a click. */
const DRAG_PX = 5;

interface Place {
  /** The circle's center, as a share of the window's width and height. */
  x: number;
  y: number;
}

export function placeOrb(root: HTMLElement, key: string, corner: string, size = ORB) {
  const fallback = (): Place => {
    const r = size / 2 + 16;
    return { x: corner.endsWith('left') ? r / innerWidth : 1 - r / innerWidth, y: corner.startsWith('top') ? r / innerHeight : 1 - r / innerHeight };
  };
  let place: Place = (() => {
    try {
      const p = JSON.parse(localStorage.getItem(key) ?? 'null') as Place | null;
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : fallback();
    } catch {
      return fallback();
    }
  })();

  /** Puts it where `place` says, kept on screen, and says which way its panel opens. */
  function apply() {
    const half = size / 2;
    const cx = Math.min(innerWidth - MARGIN - half, Math.max(MARGIN + half, place.x * innerWidth));
    const cy = Math.min(innerHeight - MARGIN - half, Math.max(MARGIN + half, place.y * innerHeight));
    // Where it is, not where a drag past the edge tried to put it (so the arrow keys and the next visit agree).
    place = { x: cx / innerWidth, y: cy / innerHeight };
    root.style.left = `${cx - half}px`;
    root.style.top = `${cy - half}px`;
    root.dataset.h = cx > innerWidth / 2 ? 'left' : 'right';
    const up = cy > innerHeight / 2;
    root.dataset.v = up ? 'up' : 'down';
    root.style.setProperty('--room', `${Math.max(240, up ? cy + half - 12 : innerHeight - (cy - half) - 12)}px`);
  }

  const save = () => localStorage.setItem(key, JSON.stringify(place));
  addEventListener('resize', apply);
  apply();

  /** Makes `handle` the thing you drag; `click` runs only for a click that wasn't a drag. */
  function attach(handle: HTMLElement, click: () => void) {
    let start: { x: number; y: number; dx: number; dy: number } | null = null;
    let dragged = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = handle.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
      dragged = false;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_PX) return;
      dragged = true;
      root.toggleAttribute('data-dragging', true);
      place = { x: (e.clientX - start.dx) / innerWidth, y: (e.clientY - start.dy) / innerHeight };
      apply();
    });
    const end = () => {
      if (!start) return;
      start = null;
      root.toggleAttribute('data-dragging', false);
      if (dragged) save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // A drag ends in a click; only a real click (or Enter/Space) opens it.
    handle.addEventListener('click', (e) => {
      if (dragged) {
        dragged = false;
        e.preventDefault();
        return;
      }
      click();
    });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!move) return;
      e.preventDefault();
      place = { x: place.x + move[0]! / innerWidth, y: place.y + move[1]! / innerHeight };
      apply();
      save();
    });
  }

  return { attach, apply };
}
