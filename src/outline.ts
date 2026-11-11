/**
 * How an agent sees a page: its structure (landmarks, headings, words), everything you can click, and how each thing
 * looks (where it is, how big, what color, whether it looks like a button), as short lines with a ref and a selector
 * that a patch can target. Simulated visitors see the same lines, without the selectors.
 */

export interface OutlineItem {
  ref: string;
  selector: string;
  tag: string;
  kind: 'landmark' | 'heading' | 'text' | 'link' | 'button' | 'image' | 'field';
  text: string;
  href?: string;
  classes: string[];
  /** Page coordinates (px) and size. */
  y: number;
  height: number;
  /** In the first screen, without scrolling. */
  aboveFold: boolean;
  fontSize: number;
  bold: boolean;
  color: string;
  background: string;
  /** A link or button drawn as a button (filled or outlined, padded). */
  buttonLike: boolean;
  depth: number;
}

export interface Outline {
  items: OutlineItem[];
  viewport: { width: number; height: number };
  /** For each ref, the tasks whose success it is (never shown to visitors). */
  matches: Record<string, string[]>;
}

const LANDMARKS = new Set(['HEADER', 'NAV', 'MAIN', 'SECTION', 'FOOTER', 'ASIDE', 'FORM']);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4']);
const MAX_ITEMS = 160;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function hex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color);
  if (!m) return color;
  if (m[4] !== undefined && Number(m[4]) === 0) return 'transparent';
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

/** The color behind an element: its own, or the nearest ancestor's that isn't transparent. */
function backgroundOf(el: Element, win: Window): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const bg = hex(win.getComputedStyle(n).backgroundColor);
    if (bg !== 'transparent') return bg;
  }
  return '#ffffff';
}

const unique = (doc: Document, sel: string) => {
  try {
    return doc.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};

/** A short selector that finds just this element: its id, its classes, or its place under a parent that has one. */
export function selectorOf(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && unique(doc, `#${el.id}`)) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const classes = [...el.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c));
  if (classes.length && unique(doc, `${tag}.${classes.join('.')}`)) return `${tag}.${classes.join('.')}`;
  const href = el.getAttribute('href');
  if (href && /^[\w/#?.=&-]+$/.test(href) && unique(doc, `${tag}[href="${href}"]`)) return `${tag}[href="${href}"]`;
  const parent = el.parentElement;
  if (!parent || parent === doc.documentElement) return tag;
  const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
  const step = sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})` : tag;
  const up = parent === doc.body ? 'body' : selectorOf(parent);
  return `${up} > ${step}`;
}

function kindOf(el: Element): OutlineItem['kind'] | null {
  const t = el.tagName;
  if (t === 'A' && el.hasAttribute('href')) return 'link';
  if (t === 'BUTTON' || el.getAttribute('role') === 'button') return 'button';
  if (HEADINGS.has(t)) return 'heading';
  if (t === 'IMG') return 'image';
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return 'field';
  if (LANDMARKS.has(t)) return 'landmark';
  if ((t === 'P' || t === 'LI' || t === 'SMALL' || t === 'BLOCKQUOTE') && el.textContent?.trim()) {
    // Words that aren't just the text of a link inside them.
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
    return own ? 'text' : null;
  }
  return null;
}

function visible(el: Element, win: Window): boolean {
  const s = win.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The page as an agent reads it. `tasks` marks which elements are each task's success (kept apart from the text). */
export function outlinePage(doc: Document, tasks: { id: string; success: string }[] = []): Outline {
  const win = doc.defaultView!;
  const items: OutlineItem[] = [];
  const matches: Record<string, string[]> = {};
  const fold = win.innerHeight;
  const walk = (el: Element, depth: number) => {
    if (items.length >= MAX_ITEMS || el.hasAttribute('data-softmax-connect')) return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return;
    if (!visible(el, win) && el !== doc.body) return;
    const kind = kindOf(el);
    let next = depth;
    if (kind) {
      const r = el.getBoundingClientRect();
      const s = win.getComputedStyle(el);
      const y = Math.round(r.top + win.scrollY);
      const background = backgroundOf(el, win);
      const ownBg = hex(s.backgroundColor);
      const padded = parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) >= 16;
      const bordered = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
      const ref = `e${items.length + 1}`;
      const text = kind === 'image' ? `image: ${el.getAttribute('alt') || '(no alt)'}` : kind === 'field' ? `field: ${el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || ''}` : kind === 'landmark' ? '' : clip(el.textContent ?? '', kind === 'text' ? 140 : 80);
      const item: OutlineItem = {
        ref,
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        kind,
        text,
        classes: [...el.classList],
        y,
        height: Math.round(r.height),
        aboveFold: r.top + win.scrollY < fold,
        fontSize: Math.round(parseFloat(s.fontSize)),
        bold: Number(s.fontWeight) >= 600,
        color: hex(s.color),
        background,
        buttonLike: (kind === 'link' || kind === 'button') && padded && (ownBg !== 'transparent' || bordered),
        depth,
      };
      if (kind === 'link') item.href = el.getAttribute('href') ?? undefined;
      items.push(item);
      const hit = tasks.filter((t) => {
        try {
          return el.matches(t.success) || !!el.closest(t.success);
        } catch {
          return false;
        }
      });
      if (hit.length && kind !== 'landmark') matches[ref] = hit.map((t) => t.id);
      if (kind === 'landmark') next = depth + 1;
      // A link or a button is one thing to click: what's inside it isn't listed again.
      if (kind === 'link' || kind === 'button' || kind === 'heading' || kind === 'text') return;
    }
    for (const child of el.children) walk(child, next);
  };
  walk(doc.body, 0);
  return { items, viewport: { width: win.innerWidth, height: win.innerHeight }, matches };
}

/** The outline as lines. `forAgent` adds the selectors and classes a patch needs. */
export function outlineText(o: Outline, forAgent: boolean): string {
  const lines = [`Viewport ${o.viewport.width}×${o.viewport.height}; "above the fold" is what shows before scrolling.`];
  for (const it of o.items) {
    const pad = '  '.repeat(it.depth);
    if (it.kind === 'landmark') {
      lines.push(`${pad}${it.ref} ${it.tag}${forAgent ? ` (${it.selector})` : ''} at y=${it.y}`);
      continue;
    }
    const look = [
      it.kind === 'link' || it.kind === 'button' ? (it.buttonLike ? 'drawn as a button' : 'plain link') : null,
      `${it.fontSize}px${it.bold ? ' bold' : ''}`,
      it.buttonLike ? `fill ${it.background}` : null,
      `text ${it.color}`,
      it.aboveFold ? 'above the fold' : `below the fold (y=${it.y})`,
    ].filter(Boolean);
    const where = it.href ? ` → ${it.href}` : '';
    const sel = forAgent ? ` (${it.selector}${it.classes.length ? `; classes: ${it.classes.join(' ')}` : ''})` : '';
    lines.push(`${pad}${it.ref} ${it.kind} "${it.text}"${where} [${look.join(', ')}]${sel}`);
  }
  return lines.join('\n');
}
