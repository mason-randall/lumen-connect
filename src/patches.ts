/**
 * Liquid: how a site changes without anyone touching its code. A variant is a list of patches, each a small,
 * declarative change to the page (new words, a style, a move, a copy of one of the site's own elements). There is no
 * script and no event handler in the language, so a variant from anyone (a visitor, their agent) is safe to try, and
 * because new things are made from the site's own elements and classes, a variant still looks like the site.
 *
 * Checking (`checkVariant`) is pure, for the server and the agent; applying (`applyVariant`) needs a page.
 */

export type Position = 'before' | 'after' | 'prepend' | 'append';

export type Patch =
  /** New words for an element that holds only text. */
  | { op: 'text'; target: string; text: string }
  /** A safe attribute: a link's destination, alt text, a label. */
  | { op: 'attr'; target: string; name: AttrName; value: string }
  /** Inline styles, from a list of visual properties. */
  | { op: 'style'; target: string; style: Record<string, string> }
  /** Classes the site already uses, added or taken off. */
  | { op: 'class'; target: string; add?: string[]; remove?: string[] }
  | { op: 'hide'; target: string }
  /** The element, moved next to (or into) another. */
  | { op: 'move'; target: string; to: string; position: Position }
  /** A copy of one of the site's elements (so it looks like the site), with new words or a new destination. */
  | { op: 'clone'; target: string; to: string; position: Position; text?: string; href?: string }
  /** A new simple element, styled with the site's own classes. */
  | { op: 'insert'; to: string; position: Position; tag: InsertTag; text: string; classes?: string[]; href?: string }
  /** A stylesheet for the variant (visual properties only, nothing loaded from elsewhere). */
  | { op: 'css'; css: string };

export const ATTRS = ['href', 'alt', 'title', 'aria-label', 'placeholder'] as const;
export type AttrName = (typeof ATTRS)[number];

export const INSERT_TAGS = ['p', 'span', 'strong', 'em', 'h2', 'h3', 'a', 'li', 'small'] as const;
export type InsertTag = (typeof INSERT_TAGS)[number];

/** What a variant may style: how things look and sit, never what they do. */
export const STYLE_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-radius', 'box-shadow',
  'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'display', 'gap', 'order', 'flex-direction', 'justify-content', 'align-items', 'width', 'max-width', 'min-width', 'height', 'min-height', 'opacity', 'outline',
]);

export interface Variant {
  id: string;
  site: string;
  /** The page's path: `/`, `/pricing`. */
  page: string;
  title: string;
  /** What the variant is betting on: "Visitors who want to order can't find where; a clear Order button in the hero will fix that." */
  hypothesis: string;
  author: { kind: 'agent' | 'player'; name: string };
  patches: Patch[];
  created_at: string;
  /** The variant it builds on (its patches come first), if any. */
  parent?: string | null;
}

export interface PatchIssue {
  /** `patches[2].style.position` */
  path: string;
  message: string;
}

const MAX_PATCHES = 40;
const MAX_TEXT = 400;
const MAX_CSS = 6000;

/** At-rules a variant's CSS may use: none of them load anything. */
const AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'container', 'layer']);

/**
 * A value that can't load or run anything: no url() to elsewhere, no expression(), no javascript:, no @import.
 * Escapes are refused outright, since `u\72l(` or `\40 import` would hide those from the checks below.
 */
export function unsafeCss(value: string): string | null {
  if (/\\/.test(value)) return 'can only set how things look: no CSS escapes (\\)';
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding|<\/?style|image-set\s*\(|\bsrc\s*\(/i.test(value)) return 'can only set how things look: no expression(), javascript:, image-set(), src() or behavior';
  for (const m of value.matchAll(/@([\w-]+)/g)) {
    if (!AT_RULES.has(m[1]!.toLowerCase())) return `can only set how things look: no @${m[1]} (only @media, @supports, @keyframes, @container and @layer)`;
  }
  // Every url(, closed or not (a browser loads an unclosed one at the end of a value).
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    if (!/^data:image\/(png|gif|jpe?g|webp|svg\+xml)[;,]/i.test(m[2]!)) return 'can only use url() for data:image values (nothing loaded from elsewhere)';
  }
  return null;
}

/** A destination a link may have: on the site, an anchor, mail, or https. */
export function unsafeHref(href: string): string | null {
  const h = href.trim();
  // A backslash or control character makes a browser read "/\evil.example" as another site.
  if (/[\\\u0000-\u001f\u007f]/.test(h)) return 'should be a plain link, with no backslashes or control characters';
  if (/^(\/(?!\/)|#|\?|\.\.?\/|mailto:|https:\/\/)/i.test(h) || /^[\w-]+(\.html?)?([?#].*)?$/.test(h)) return null;
  return 'should be a path on the site ("/order"), an anchor ("#menu"), mailto:, or an https:// link';
}

const CLASS = /^-?[_a-zA-Z][\w-]*$/;

/** Checks a variant's patches. No issues means it's safe to apply (selectors are checked against the page when applied). */
export function checkPatches(patches: unknown): PatchIssue[] {
  const issues: PatchIssue[] = [];
  if (!Array.isArray(patches)) return [{ path: 'patches', message: 'should be a list of patches' }];
  if (patches.length > MAX_PATCHES) issues.push({ path: 'patches', message: `has ${patches.length}; at most ${MAX_PATCHES} (a variant is one idea)` });
  patches.forEach((raw, i) => {
    const at = (k: string) => `patches[${i}]${k ? `.${k}` : ''}`;
    const p = raw as Record<string, unknown>;
    const need = (k: string, kind: 'string' | 'object' = 'string') => {
      if (kind === 'string' ? typeof p[k] !== 'string' || !(p[k] as string).trim() : !p[k] || typeof p[k] !== 'object' || Array.isArray(p[k])) {
        issues.push({ path: at(k), message: `is required (${kind === 'string' ? 'text' : 'an object'})` });
        return false;
      }
      return true;
    };
    const text = (k: string, required: boolean) => {
      if (p[k] === undefined && !required) return;
      if (typeof p[k] !== 'string') return void issues.push({ path: at(k), message: 'should be text' });
      if ((p[k] as string).length > MAX_TEXT) issues.push({ path: at(k), message: `is ${(p[k] as string).length} characters; keep it to ${MAX_TEXT}` });
      if (/<[a-z/!]/i.test(p[k] as string)) issues.push({ path: at(k), message: 'is plain text: no HTML' });
    };
    const position = () => {
      if (!['before', 'after', 'prepend', 'append'].includes(p.position as string)) issues.push({ path: at('position'), message: 'should be "before", "after", "prepend", or "append"' });
    };
    const href = (k: string) => {
      if (p[k] === undefined) return;
      const why = typeof p[k] === 'string' ? unsafeHref(p[k] as string) : 'should be text';
      if (why) issues.push({ path: at(k), message: why });
    };
    if (!p || typeof p !== 'object') return void issues.push({ path: at(''), message: 'should be a patch: { "op": …, … }' });
    switch (p.op) {
      case 'text':
        need('target');
        text('text', true);
        break;
      case 'attr':
        need('target');
        if (!ATTRS.includes(p.name as AttrName)) issues.push({ path: at('name'), message: `should be one of ${ATTRS.join(', ')}` });
        text('value', true);
        if (p.name === 'href') href('value');
        break;
      case 'style':
        need('target');
        if (need('style', 'object')) {
          for (const [k, v] of Object.entries(p.style as Record<string, unknown>)) {
            if (!STYLE_PROPERTIES.has(k)) issues.push({ path: at(`style.${k}`), message: "isn't a property a variant can set; it can set how things look (color, spacing, size, font, display, order…)" });
            else if (typeof v !== 'string') issues.push({ path: at(`style.${k}`), message: 'should be text, like "16px"' });
            else if (unsafeCss(v)) issues.push({ path: at(`style.${k}`), message: unsafeCss(v)! });
          }
        }
        break;
      case 'class':
        need('target');
        for (const k of ['add', 'remove'] as const) {
          if (p[k] === undefined) continue;
          if (!Array.isArray(p[k]) || (p[k] as unknown[]).some((c) => typeof c !== 'string' || !CLASS.test(c))) issues.push({ path: at(k), message: 'should be a list of class names' });
        }
        if (p.add === undefined && p.remove === undefined) issues.push({ path: at(''), message: 'should add or remove classes' });
        break;
      case 'hide':
        need('target');
        break;
      case 'move':
        need('target');
        need('to');
        position();
        break;
      case 'clone':
        need('target');
        need('to');
        position();
        text('text', false);
        href('href');
        break;
      case 'insert':
        need('to');
        position();
        if (!INSERT_TAGS.includes(p.tag as InsertTag)) issues.push({ path: at('tag'), message: `should be one of ${INSERT_TAGS.join(', ')}` });
        text('text', true);
        if (p.classes !== undefined && (!Array.isArray(p.classes) || (p.classes as unknown[]).some((c) => typeof c !== 'string' || !CLASS.test(c)))) issues.push({ path: at('classes'), message: 'should be a list of class names' });
        href('href');
        if (p.href !== undefined && p.tag !== 'a') issues.push({ path: at('href'), message: 'only links (tag "a") have an href' });
        break;
      case 'css':
        if (need('css')) {
          if ((p.css as string).length > MAX_CSS) issues.push({ path: at('css'), message: `is ${(p.css as string).length} characters; keep it to ${MAX_CSS}` });
          const why = unsafeCss(p.css as string);
          if (why) issues.push({ path: at('css'), message: why });
          if (/position\s*:\s*fixed/i.test(p.css as string)) issues.push({ path: at('css'), message: "can't pin things over the page (position: fixed)" });
        }
        break;
      default:
        issues.push({ path: at('op'), message: 'should be one of text, attr, style, class, hide, move, clone, insert, css' });
    }
    for (const k of ['target', 'to'] as const) {
      if (typeof p[k] === 'string' && !validSelector(p[k] as string)) issues.push({ path: at(k), message: `"${p[k]}" isn't a CSS selector` });
    }
  });
  return issues;
}

/** A syntax check for selectors without a page: balanced brackets and quotes, nothing that could close a style block. */
function validSelector(s: string): boolean {
  if (!s.trim() || s.length > 300 || /[{};]/.test(s)) return false;
  let depth = 0;
  for (const c of s) {
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && (s.match(/"/g)?.length ?? 0) % 2 === 0;
}

// ---- applying (needs a page) ----------------------------------------------------------------------------------------

export interface Applied {
  /** Patches that applied. */
  done: number;
  /** Patches that couldn't (a selector that matches nothing, or more than one thing), with why. */
  skipped: PatchIssue[];
  /** Puts the page back as it was. */
  undo: () => void;
}

const MARK = 'data-softmax-liquid';

function one(doc: Document, selector: string, path: string, skipped: PatchIssue[]): HTMLElement | null {
  let found: NodeListOf<Element>;
  try {
    found = doc.querySelectorAll(selector);
  } catch {
    skipped.push({ path, message: `"${selector}" isn't a selector this browser reads` });
    return null;
  }
  if (found.length !== 1) {
    skipped.push({ path, message: found.length ? `"${selector}" matches ${found.length} elements; it has to match one` : `"${selector}" matches nothing on this page` });
    return null;
  }
  return found[0] as HTMLElement;
}

function place(node: Node, anchor: Element, position: Position) {
  if (position === 'before') anchor.before(node);
  else if (position === 'after') anchor.after(node);
  else if (position === 'prepend') anchor.prepend(node);
  else anchor.append(node);
}

/** A copy without ids (they must stay unique) or anything that runs. */
function cleanCopy(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    n.removeAttribute('id');
    for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    if (n.tagName === 'SCRIPT') n.remove();
  }
  return copy;
}

/** Applies a variant to the page. Patches that don't fit the page are skipped (and said); the rest apply in order. */
export function applyVariant(doc: Document, patches: Patch[]): Applied {
  const issues = checkPatches(patches);
  if (issues.length) return { done: 0, skipped: issues, undo: () => {} };
  const undo: (() => void)[] = [];
  const skipped: PatchIssue[] = [];
  let done = 0;
  patches.forEach((p, i) => {
    const path = `patches[${i}]`;
    if (p.op === 'css') {
      const style = doc.createElement('style');
      style.setAttribute(MARK, '');
      style.textContent = p.css;
      doc.head.append(style);
      undo.push(() => style.remove());
      done++;
      return;
    }
    if (p.op === 'insert') {
      const anchor = one(doc, p.to, `${path}.to`, skipped);
      if (!anchor) return;
      const el = doc.createElement(p.tag);
      el.textContent = p.text;
      if (p.classes?.length) el.className = p.classes.join(' ');
      if (p.href) el.setAttribute('href', p.href);
      el.setAttribute(MARK, '');
      place(el, anchor, p.position);
      undo.push(() => el.remove());
      done++;
      return;
    }
    const el = one(doc, p.target, `${path}.target`, skipped);
    if (!el) return;
    switch (p.op) {
      case 'text': {
        if (el.children.length) return void skipped.push({ path: `${path}.target`, message: `"${p.target}" holds other elements, not just text: target the one with the words` });
        const before = el.textContent;
        el.textContent = p.text;
        undo.push(() => (el.textContent = before));
        break;
      }
      case 'attr': {
        const before = el.getAttribute(p.name);
        el.setAttribute(p.name, p.value);
        undo.push(() => (before === null ? el.removeAttribute(p.name) : el.setAttribute(p.name, before)));
        break;
      }
      case 'style': {
        const before = el.getAttribute('style');
        for (const [k, v] of Object.entries(p.style)) el.style.setProperty(k, v);
        undo.push(() => (before === null ? el.removeAttribute('style') : el.setAttribute('style', before)));
        break;
      }
      case 'class': {
        const before = el.className;
        el.classList.add(...(p.add ?? []));
        el.classList.remove(...(p.remove ?? []));
        undo.push(() => (el.className = before));
        break;
      }
      case 'hide': {
        const before = el.hidden;
        el.hidden = true;
        el.style.setProperty('display', 'none', 'important');
        undo.push(() => {
          el.hidden = before;
          el.style.removeProperty('display');
        });
        break;
      }
      case 'move': {
        const anchor = one(doc, p.to, `${path}.to`, skipped);
        if (!anchor || anchor === el || el.contains(anchor)) return void (anchor && skipped.push({ path: `${path}.to`, message: "can't move an element into itself" }));
        const marker = doc.createComment('softmax-moved');
        el.before(marker);
        place(el, anchor, p.position);
        undo.push(() => {
          marker.before(el);
          marker.remove();
        });
        break;
      }
      case 'clone': {
        const anchor = one(doc, p.to, `${path}.to`, skipped);
        if (!anchor) return;
        const copy = cleanCopy(el);
        if (p.text !== undefined) {
          // The words go in the copy's innermost text, so an icon or a wrapper inside it stays.
          const leaf = [...copy.querySelectorAll<HTMLElement>('*')].reverse().find((n) => n.textContent?.trim() && !n.children.length) ?? copy;
          leaf.textContent = p.text;
        }
        if (p.href !== undefined) (copy.tagName === 'A' ? copy : copy.querySelector('a'))?.setAttribute('href', p.href);
        copy.setAttribute(MARK, '');
        place(copy, anchor, p.position);
        undo.push(() => copy.remove());
        break;
      }
    }
    done++;
  });
  return { done, skipped, undo: () => undo.reverse().forEach((u) => u()) };
}
