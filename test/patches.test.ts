import { describe, expect, it } from 'vitest';
import { checkPatches, unsafeCss, unsafeHref } from '../src/patches.ts';
import { jsonIn, improverPrompt } from '../server/coworld.ts';

const msgs = (patches: unknown) => checkPatches(patches).map((i) => `${i.path}: ${i.message}`);

describe('the patch language', () => {
  it('accepts every kind of change, built from the site\'s own pieces', () => {
    expect(
      msgs([
        { op: 'text', target: '.hero h1', text: 'Fresh beans, delivered' },
        { op: 'attr', target: 'a.btn-ghost', name: 'href', value: '/shop' },
        { op: 'style', target: '#beans', style: { 'background-color': '#fff', padding: '24px' } },
        { op: 'class', target: 'a.btn-ghost', add: ['btn-primary'], remove: ['btn-ghost'] },
        { op: 'hide', target: '.aside' },
        { op: 'move', target: '#beans', to: '#story', position: 'before' },
        { op: 'clone', target: 'a.btn-primary', to: '.hero-actions', position: 'prepend', text: 'Shop beans', href: '/shop' },
        { op: 'insert', to: '.roast:nth-of-type(1)', position: 'append', tag: 'a', text: 'Buy this roast', classes: ['btn', 'btn-primary'], href: '/shop' },
        { op: 'css', css: '.roast { border-color: #c98b4f; }' },
      ]),
    ).toEqual([]);
  });

  it('refuses anything that runs, loads from elsewhere, or covers the page', () => {
    expect(msgs([{ op: 'attr', target: 'a', name: 'onclick', value: 'steal()' }])[0]).toMatch(/name: should be one of href/);
    expect(msgs([{ op: 'attr', target: 'a', name: 'href', value: 'javascript:alert(1)' }])[0]).toMatch(/value: should be a path on the site/);
    expect(msgs([{ op: 'style', target: 'a', style: { position: 'fixed' } }])[0]).toMatch(/style.position: isn't a property a variant can set/);
    expect(msgs([{ op: 'style', target: 'a', style: { background: 'url(https://evil.example/x.png)' } }])[0]).toMatch(/only use url\(\) for data:image/);
    expect(msgs([{ op: 'css', css: '@import url(https://x/y.css);' }])[0]).toMatch(/no @import/);
    expect(msgs([{ op: 'css', css: '.x { position: fixed; inset: 0 }' }])[0]).toMatch(/can't pin things over the page/);
    expect(msgs([{ op: 'text', target: 'h1', text: '<img src=x onerror=alert(1)>' }])[0]).toMatch(/plain text: no HTML/);
    expect(msgs([{ op: 'insert', to: 'main', position: 'append', tag: 'script', text: 'x' }])[0]).toMatch(/tag: should be one of p, span/);
    expect(msgs([{ op: 'text', target: 'h1 { color: red }', text: 'x' }])[0]).toMatch(/isn't a CSS selector/);
    expect(msgs([{ op: 'eval', code: 'x' }])[0]).toMatch(/op: should be one of/);
  });

  it('knows a safe link and a safe style value', () => {
    for (const ok of ['/shop', '#beans', 'shop.html', '?plan=team', 'mailto:hi@example.com', 'https://example.com']) expect(unsafeHref(ok), ok).toBeNull();
    for (const bad of ['javascript:x', '//evil.example', 'data:text/html,x', 'http://plain.example', '/\\evil.example', '\\\\evil.example', 'java\tscript:x']) expect(unsafeHref(bad), bad).not.toBeNull();
    expect(unsafeCss('url("data:image/png;base64,AAA")')).toBeNull();
    expect(unsafeCss('expression(alert(1))')).not.toBeNull();
  });

  it('keeps CSS from loading anything, however it is spelled', () => {
    for (const ok of ['16px', '@media (max-width: 600px) { .menu { display: none } }', '@keyframes pulse { to { opacity: .5 } }']) expect(unsafeCss(ok), ok).toBeNull();
    for (const bad of [
      'url(https://evil.example/x.png)',
      'u\\72l(https://evil.example/x.png)',
      '\\40 import "https://evil.example/a.css"',
      '@import "https://evil.example/a.css"',
      '@font-face { font-family: x; src: url(data:image/png;base64,AAA) }',
      'image-set("https://evil.example/x.png" 1x)',
      'url(https://evil.example/x.png',
      'input[value^="a"] { background: url(https://evil.example/a) }',
    ]) expect(unsafeCss(bad), bad).not.toBeNull();
  });
});

describe('the agent and the visitors', () => {
  it('reads the JSON out of a reply that wraps it', () => {
    expect(jsonIn('Here you go:\n```json\n{"title":"x","patches":[]}\n```')).toEqual({ title: 'x', patches: [] });
    expect(() => jsonIn('no json here')).toThrow(/no JSON/);
  });

  it('tells the agent what was tried, how it scored, and who missed', () => {
    const prompt = improverPrompt({
      site: 'Sample Shop',
      page: '/',
      goal: 'Buy beans',
      outline: 'e1 link "Shop beans online"',
      tried: [{ name: 'the original', title: 'The site as built', hypothesis: '-', hits: 1, n: 6, misses: ['Dana clicked "Visit the café" (looked like the main thing)'] }],
      parent: null,
    });
    expect(prompt).toContain('1/6 got it right');
    expect(prompt).toContain('Dana clicked "Visit the café"');
    expect(prompt).toContain('start from the original page');
  });
});
