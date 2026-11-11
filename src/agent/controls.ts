/**
 * What an agent can use on any page, found from the web's own primitives: no integration, no annotations. A range
 * input is a slider it can move, a checkbox a switch, a select a choice, a button something to press, a file input a
 * way to open something; a canvas, image, or video is something it can look at. Names come from where the page
 * already gives them (a <label for>, a wrapping label, aria-label, aria-labelledby, title, the text), and groups
 * from <fieldset><legend> or the nearest labelled region.
 *
 * Driving a control is what a person does: the value changes and the page gets the same `input` and `change` events
 * (through the native setter, so frameworks like React see it too). A page can opt an element out with
 * `data-softmax="off"`, or add words for the agent with `data-softmax-hint`.
 */

export type ControlKind = 'slider' | 'switch' | 'choice' | 'button' | 'number' | 'text' | 'color' | 'file' | 'link';

export interface Control {
  ref: string;
  kind: ControlKind;
  el: HTMLElement;
  label: string;
  group: string | null;
  hint: string | null;
  /** In a closed section (<details>): it opens when the control is used (`reveal`). */
  folded?: boolean;
}

export interface View {
  ref: string;
  el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
  label: string;
}

const clip = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const off = (el: Element) => !!el.closest('[data-softmax="off"], [data-softmax-connect]');

/** Inside a section someone closed (<details> without `open`): there, but folded away. */
const folded = (el: HTMLElement) => !!el.parentElement?.closest('details:not([open])');

/** Opens the sections a control is folded inside, the way a person would before using it. */
export function reveal(el: HTMLElement) {
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
}

function visible(el: HTMLElement): boolean {
  if (el.hidden || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function kindOf(el: Element): ControlKind | null {
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'range':
        return 'slider';
      case 'checkbox':
      case 'radio':
        return 'switch';
      case 'number':
        return 'number';
      case 'color':
        return 'color';
      case 'file':
        return 'file';
      case 'button':
      case 'submit':
      case 'reset':
        return 'button';
      case 'hidden':
        return null;
      default:
        return 'text';
    }
  }
  if (el instanceof HTMLSelectElement) return 'choice';
  if (el instanceof HTMLTextAreaElement) return 'text';
  if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button') return 'button';
  if (el instanceof HTMLAnchorElement && el.hasAttribute('download')) return 'button';
  // A link goes somewhere: the agent can point you to it, or follow it when you ask.
  if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) return 'link';
  return null;
}

/** The element's name, the way assistive tech would find it. */
export function nameOf(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clip(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (text.trim()) return clip(text);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const label = labels[0]!;
    // A wrapping label's own words, without the control's.
    const text = [...label.childNodes].filter((n) => n !== el && !(n instanceof HTMLElement && n.contains(el))).map((n) => n.textContent ?? '').join(' ');
    if (text.trim()) return clip(text);
  }
  // A button is named by its words before its tooltip; a field by its tooltip, then its placeholder.
  const text = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? '' : (el.textContent ?? '');
  if (text.trim()) return clip(text);
  if (el.title) return clip(el.title);
  if (el instanceof HTMLInputElement && el.placeholder) return clip(el.placeholder);
  return el.id ? el.id.replace(/[-_]/g, ' ') : el.tagName.toLowerCase();
}

/** Its sections (each <details>' summary, outermost first) and its fieldset's legend: "Masks › Subject mask". */
function groupOf(el: HTMLElement): string | null {
  const path: string[] = [];
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
    const s = d.querySelector(':scope > summary')?.textContent?.trim();
    if (s) path.unshift(clip(s, 30));
  }
  const legend = el.closest('fieldset')?.querySelector(':scope > legend')?.textContent?.trim();
  // A legend that says the section's name again (or more of it) takes its place.
  if (legend && path.length && legend.toLowerCase().startsWith(path.at(-1)!.toLowerCase())) path[path.length - 1] = clip(legend, 40);
  else if (legend && !path.includes(legend)) path.push(clip(legend, 40));
  if (path.length) return path.join(' › ');
  const region = el.closest('[aria-label]:not(input, button, select, textarea, a), [aria-labelledby]:not(input, button, select, textarea, a)');
  return region && region !== el ? nameOf(region as HTMLElement) : null;
}

/** Everything on the page an agent can use and look at, in reading order. Refs are stable while the page is. */
export function discover(doc: Document): { controls: Control[]; views: View[] } {
  const controls: Control[] = [];
  const views: View[] = [];
  const seen = new Set<Element>();
  for (const el of doc.body.querySelectorAll<HTMLElement>('input, select, textarea, button, [role="button"], a[href], canvas, img, video')) {
    if (off(el) || seen.has(el)) continue;
    seen.add(el);
    if (el instanceof HTMLCanvasElement || el instanceof HTMLImageElement || el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 60) views.push({ ref: `v${views.length + 1}`, el, label: nameOf(el) });
      continue;
    }
    const kind = kindOf(el);
    // A file input is usually hidden behind its label; it's still the way to open a file.
    const away = folded(el) && !el.hidden && !el.closest('[hidden]');
    if (!kind || (kind !== 'file' && !visible(el) && !away) || (el as HTMLInputElement).disabled) continue;
    const label = nameOf(el);
    // A tooltip that says more than the name is a hint (e.g. "Hold to see the original").
    const hint = el.getAttribute('data-softmax-hint') ?? (el.title && clip(el.title) !== label ? clip(el.title) : null);
    controls.push({ ref: `c${controls.length + 1}`, kind, el, label, group: groupOf(el), hint, ...(away ? { folded: true } : {}) });
  }
  return { controls, views };
}

/** A control's current state, in words. */
export function stateOf(c: Control): string {
  const el = c.el;
  if (el instanceof HTMLInputElement) {
    if (c.kind === 'slider' || c.kind === 'number') {
      const range = c.kind === 'slider' || el.min || el.max ? ` (${el.min || '…'} to ${el.max || '…'}${el.step && el.step !== '1' ? `, step ${el.step}` : ''}; default ${el.defaultValue || '0'})` : '';
      return `= ${el.value}${range}`;
    }
    if (c.kind === 'switch') return el.checked ? 'on' : 'off';
    if (c.kind === 'file') return el.accept ? `accepts ${el.accept}` : '';
    return el.value ? `= "${clip(el.value, 40)}"` : 'empty';
  }
  if (el instanceof HTMLSelectElement) return `= "${el.value}" of ${[...el.options].map((o) => `"${o.value}"${o.text !== o.value ? ` (${clip(o.text, 24)})` : ''}`).join(', ')}`;
  if (el instanceof HTMLTextAreaElement) return el.value ? `= "${clip(el.value, 40)}"` : 'empty';
  if (c.kind === 'link') return `→ ${(el as HTMLAnchorElement).getAttribute('href')}`;
  return '';
}

/** The page's controls and views, as lines for an agent: `c3 slider "Exposure" [Light] = 0 (-2 to 2, step 0.05)`. */
export function describe(controls: Control[], views: View[]): string {
  const lines = controls.map((c) => [c.ref, c.kind, `"${c.label}"`, c.group ? `[${c.group}${c.folded ? ', closed' : ''}]` : c.folded ? '[closed]' : '', stateOf(c), c.hint ? `(${c.hint})` : ''].filter(Boolean).join(' '));
  const seeing = views.map((v) => `${v.ref} ${v.el.tagName.toLowerCase()} "${v.label}" ${Math.round(v.el.getBoundingClientRect().width)}×${Math.round(v.el.getBoundingClientRect().height)}`);
  const closed = controls.some((c) => c.folded) ? '\n(Controls marked "closed" are in a folded section; using one opens it.)' : '';
  return `Controls:\n${lines.join('\n') || '(none)'}${closed}\n\nViews you can look at:\n${seeing.join('\n') || '(none)'}`;
}

/** Sets a value the way a person would: the native setter, then the events the page listens for. */
export function setValue(el: HTMLElement, value: string | boolean) {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.checked !== !!value) el.click();
    return;
  }
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (!(el instanceof HTMLInputElement && el.type === 'range')) el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A slider value in its range, on its step. */
export function clampToRange(el: HTMLInputElement, x: number): number {
  const min = el.min === '' ? -Infinity : Number(el.min);
  const max = el.max === '' ? Infinity : Number(el.max);
  const step = el.step === '' || el.step === 'any' ? 0 : Number(el.step);
  let v = Math.min(max, Math.max(min, x));
  if (step > 0) v = Math.round((v - (Number.isFinite(min) ? min : 0)) / step) * step + (Number.isFinite(min) ? min : 0);
  return Number(v.toFixed(6));
}

/**
 * Moves a slider to `to` over `ms`, an input event each frame, so the page redraws as it goes (as it would under a
 * hand); a range's `change` comes once at the end.
 */
export function glide(el: HTMLInputElement, to: number, ms = 650): Promise<void> {
  const from = Number(el.value);
  const target = clampToRange(el, to);
  if (from === target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setValue(el, String(target));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  }
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      setValue(el, String(t >= 1 ? target : from + (target - from) * e));
      if (t < 1) requestAnimationFrame(step);
      else {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

export interface Change {
  ref: string;
  label: string;
  value: string;
  at: number;
}

/**
 * What the person does with the controls (trusted events only, so the agent's own moves aren't counted): the start of
 * coaching, where the agent learns from watching you. A slider's drag is one change, at the value it stopped on.
 */
export function watch(doc: Document, controls: () => Control[], onChange: (c: Change) => void): () => void {
  const handler = (e: Event) => {
    if (!e.isTrusted) return;
    const c = controls().find((x) => x.el === e.target || (e.target instanceof Node && x.el.contains(e.target)));
    // A switch clicks and changes; a button only clicks.
    if (!c || (e.type === 'click') !== (c.kind === 'button')) return;
    const el = c.el;
    const value = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'on' : 'off') : 'value' in el ? String((el as HTMLInputElement).value) : 'pressed';
    onChange({ ref: c.ref, label: c.label, value, at: Date.now() });
  };
  doc.addEventListener('change', handler, true);
  doc.addEventListener('click', handler, true);
  return () => {
    doc.removeEventListener('change', handler, true);
    doc.removeEventListener('click', handler, true);
  };
}

/** What's been changed from the page's defaults, in words: `Smooth skin 18 · Look "film"`. */
export function changedFromDefaults(controls: Control[]): string {
  const out: string[] = [];
  for (const c of controls) {
    const el = c.el;
    if (el instanceof HTMLInputElement) {
      if (c.kind === 'switch' && el.checked !== el.defaultChecked) out.push(`${c.label} ${el.checked ? 'on' : 'off'}`);
      else if ((c.kind === 'slider' || c.kind === 'number' || c.kind === 'text') && el.value !== el.defaultValue) out.push(`${c.label} ${el.value}`);
    } else if (el instanceof HTMLSelectElement) {
      const d = [...el.options].find((o) => o.defaultSelected) ?? el.options[0];
      if (d && el.value !== d.value) out.push(`${c.label} "${el.selectedOptions[0]?.text ?? el.value}"`);
    }
  }
  return out.join(' · ') || 'nothing changed';
}

/** Where every control is now, to put them back later (`restoreValues`). */
export function snapshotValues(controls: Control[]): Map<HTMLElement, string | boolean> {
  return new Map(controls.filter((c) => c.kind !== 'file' && c.kind !== 'button' && c.kind !== 'link').map((c) => [c.el, c.kind === 'switch' ? (c.el as HTMLInputElement).checked : (c.el as HTMLInputElement).value]));
}

export function restoreValues(snapshot: Map<HTMLElement, string | boolean>) {
  for (const [el, v] of snapshot) {
    if (!el.isConnected) continue;
    const now = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : (el as HTMLInputElement).value;
    if (now === v) continue;
    setValue(el, v);
    if (el instanceof HTMLInputElement && el.type === 'range') el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** Every control back to how the page wrote it (its HTML defaults), with the events a person's reset would make. */
export function resetToDefaults(controls: Control[]) {
  for (const c of controls) {
    const el = c.el;
    if (el instanceof HTMLInputElement) {
      if (c.kind === 'switch') {
        if (el.checked !== el.defaultChecked) setValue(el, el.defaultChecked);
      } else if (c.kind !== 'file' && c.kind !== 'button' && el.value !== el.defaultValue) {
        setValue(el, el.defaultValue);
        if (el.type === 'range') el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (el instanceof HTMLSelectElement) {
      const d = [...el.options].find((o) => o.defaultSelected) ?? el.options[0];
      if (d && el.value !== d.value) setValue(el, d.value);
    }
  }
}

/** Opens a file (a URL, or a file the person picked before) through the page's own file input, as if they'd picked it. */
export async function openFile(input: HTMLInputElement, source: string | File) {
  const file = typeof source === 'string' ? await fetch(source).then(async (r) => new File([await r.blob()], source.split('/').pop() || 'file', { type: r.headers.get('content-type') ?? '' })) : source;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
