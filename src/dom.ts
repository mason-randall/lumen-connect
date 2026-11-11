/** Building the embed's UI without a framework: elements from tag, props, and children. */
import { icon, type IconName } from './icons.ts';

export type Child = Node | string | null | undefined | false;

export function h(tag: string, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    // Only for the generated icon SVGs (constants): words from the site, the agent, or visitors always go in as text.
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const iconEl = (name: IconName, size = 20) => h('span', { html: icon(name, size), 'aria-hidden': 'true', style: 'display:grid' });
