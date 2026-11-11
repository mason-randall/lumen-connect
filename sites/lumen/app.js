/*
 * Lumen: a raw photo editor with retouching and masks. Every control is a plain <input> or <select> in index.html;
 * this file reads them and redraws the photo.
 *
 * Raws (ARW, CR3, NEF, RAF, DNG, …) are developed to scene-linear light by Lumen's server (Apple's raw engine), and
 * every photo is then developed on the GPU by engine.js (linear light, wide gamut, a filmic display curve). Where the
 * browser has no WebGL2, `develop` below does it on the CPU from the 8-bit photo (JPEGs only).
 *
 * To add an adjustment: put a slider in index.html (its id is the adjustment's name; `data-scale` turns its value into
 * the number used here, 0.01 by default, so -100…100 becomes -1…1), then use it in engine.js's FS_DEVELOP (as a
 * uniform set in `render`) and in `develop` here. Each pixel's work happens in `develop`, in order; it has the pixel
 * (r, g, b in 0–1), three blurred copies (`micro`, a pixel or two; `fine`, a few; `coarse`, wide), how much of it is
 * skin, face, eyes, subject, and sky, and where it is (x, y).
 *
 * Masks: the subject (people and what they hold) comes from Lumen's server, which asks Apple Vision (server/); the
 * background is everything else, the sky is found here, and the radial and linear masks are drawn from their sliders.
 * Each mask adds its own exposure, contrast, highlights, shadows, temperature, saturation, and clarity to the pixels it
 * covers, so a mask's settings blend in wherever it's partly on.
 */

const MAX_SIDE = 1400;
const HUES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
/** Where each of the color mixer's colors sits on the hue circle (degrees). */
const HUE_AT = [0, 30, 60, 120, 180, 240, 280, 320];
const MASKS = ['subject', 'background', 'sky', 'radial', 'linear'];
const LOCAL = ['exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'saturation', 'clarity'];

/** Looks: a starting point the sliders add to. */
const LOOKS = {
  none: {},
  golden: { temperature: 0.35, tint: 0.06, vibrance: 0.2, glow: 0.15, fade: 0.04 },
  film: { contrast: -0.12, fade: 0.08, saturation: -0.12, temperature: 0.06, grain: 0.25 },
  cool: { temperature: -0.3, tint: -0.04, contrast: 0.08 },
  noir: { mono: 1, contrast: 0.35, clarity: 0.2, vignette: -0.25 },
};

const $ = (id) => document.getElementById(id);
const photo = $('photo');
/** The GPU engine (engine.js), or null where the browser can't run it (then `develop`, on the CPU). */
const engine = (() => {
  // `?engine=cpu`: the CPU path, for comparing.
  if (new URLSearchParams(location.search).get('engine') === 'cpu') return null;
  try {
    return window.LumenEngine?.create() ?? null;
  } catch (err) {
    console.warn('Lumen: no GPU engine', err);
    return null;
  }
})();
const ctx = photo.getContext('2d', { colorSpace: engine?.wideGamut ? 'display-p3' : 'srgb' });
/** Camera raws Lumen's server can develop. */
const RAW = /\.(arw|cr2|cr3|nef|nrw|raf|orf|rw2|dng|pef|srw|3fr|iiq)$/i;
const hctx = $('histogram').getContext('2d');
const note = $('stage-note');
const form = $('adjustments');
/** Where a level's developed pixels go before they're shown (cropped, turned, straightened). */
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

/** Where the faces are in the photos Lumen ships with, for when its server can't look (`faces.json`, Apple Vision). */
const knownFaces = fetch('/faces.json')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));

/**
 * The photo, for finding its masks (and, without the GPU, for developing): `full` (up to 1400 px) and, on the CPU only,
 * `preview` (half that, drawn while a slider moves).
 */
let levels = null;
/** What's known about it: faces (boxes and eyes) and whether the subject has been found. */
let analysis = { faces: [], subject: false };
let loadToken = 0;
let showOriginal = false;
/** Quarter turns (rotate left and right). */
let quarter = 0;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- the controls ------------------------------------------------------------------------------------------------

const sliders = () => [...form.querySelectorAll('input[type="range"]')];

/** Every slider's number (its value times its `data-scale`), the looks added in, and the other choices. */
function values() {
  const v = {};
  for (const input of sliders()) v[input.id] = Number(input.value) * Number(input.dataset.scale ?? 0.01);
  for (const [k, x] of Object.entries(LOOKS[$('look').value] ?? {})) v[k] = (v[k] ?? 0) + x;
  v.clipping = $('clipping').checked;
  v.showMask = $('show-mask').value;
  v.radialInvert = $('m-radial-invert').checked;
  v.linearFrom = $('m-linear-from').value;
  return v;
}

function format(input) {
  const x = Number(input.value);
  switch (input.dataset.format) {
    case 'ev':
      return (x > 0 ? '+' : '') + x.toFixed(2);
    case 'deg':
      return `${x > 0 ? '+' : ''}${x.toFixed(1)}°`;
    case 'pct':
      return `${Math.round(x)}%`;
    default:
      return String(Math.round(x));
  }
}

function showValues() {
  for (const input of sliders()) {
    const out = $(`${input.id}-out`);
    if (out) out.textContent = format(input);
    input.closest('.slider')?.toggleAttribute('data-changed', input.value !== input.defaultValue);
  }
  // A section with something changed in it says so, even closed.
  for (const d of form.querySelectorAll('details')) d.toggleAttribute('data-changed', !![...d.querySelectorAll('input[type="range"]')].some((i) => i.value !== i.defaultValue));
}

// ---- loading -----------------------------------------------------------------------------------------------------

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't a photo this browser can open."));
    img.src = src;
  });

/** Says something over the photo while it opens (null: done). */
function opening(text) {
  note.textContent = text ?? 'Original';
  note.hidden = !text;
}

/** Opens a photo: a raw through Lumen's server, anything else as it is. `file`, when it came from Open. */
async function load(src, name, file) {
  const token = ++loadToken;
  try {
    let source;
    if (RAW.test(name)) {
      if (!engine) throw new Error('Raw photos need a browser with WebGL2.');
      opening(`Developing ${name}…`);
      const res = await fetch(`/api/develop?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file ?? (await (await fetch(src)).blob()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `The server answered ${res.status}.`);
      const buf = await res.arrayBuffer();
      const n = new DataView(buf).getUint32(0, true);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
      if (token !== loadToken) return;
      engine.setLinear(new Uint16Array(buf.slice(4 + n)), meta.width, meta.height, meta);
      // The masks are found on the photo as it opens (developed, small).
      source = engine.proxy({}, MAX_SIDE);
    } else {
      source = await loadImage(src);
      if (token !== loadToken) return;
      engine?.setImage(source);
    }
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    levels = engine ? { full: prepare(source, w, h) } : { full: prepare(source, w, h), preview: prepare(source, Math.round(w / 2), Math.round(h / 2)) };
    analysis = { faces: [], subject: false };
    $('file-name').textContent = name;
    opening(null);
    // Until the server has looked: faces from the sidecar, or guessed from the skin.
    const known = (await knownFaces)[src.split('/').pop()] ?? (await knownFaces)[name];
    setFaces(known ? known.map((box) => ({ box, eyes: [] })) : []);
    past.length = 0;
    undone.length = 0;
    remember();
    redraw();
    void analyze(source, w, h, token);
  } catch (err) {
    if (token !== loadToken) return;
    opening(`Couldn't open ${name}: ${err.message}`);
  }
}

/** The masks, to the GPU (they're found on the CPU, at Lumen's 1400 pixels). */
function syncMasks() {
  if (!engine || !levels) return;
  const L = levels.full;
  engine.setMasks({ w: L.w, h: L.h, subject: L.subject, sky: L.sky, skin: L.skin, face: L.face, eyes: L.eyes });
}

/** A level of the photo: its pixels, three blurs, and its skin; masks get filled in as they're known. */
function prepare(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.drawImage(img, 0, 0, w, h);
  const px = cc.getImageData(0, 0, w, h).data;
  const r = Math.max(1, Math.round(Math.min(w, h) / 260));
  const level = { w, h, px, micro: blurRGB(px, w, h, 1, 1), fine: blurRGB(px, w, h, r, 3), coarse: blurRGB(px, w, h, r * 6, 3) };
  level.skin = skinOf(level);
  level.subject = null;
  level.face = new Uint8Array(w * h);
  level.eyes = new Uint8Array(w * h);
  level.sky = skyOf(level);
  level.out = new ImageData(w, h);
  return level;
}

/** Three box blurs, about a gaussian, into bytes. */
function blurRGB(px, w, h, radius, passes) {
  const out = new Uint8ClampedArray(px.length);
  let a = new Float32Array(w * h);
  for (let ch = 0; ch < 3; ch++) {
    for (let p = 0; p < w * h; p++) a[p] = px[p * 4 + ch];
    for (let pass = 0; pass < passes; pass++) a = boxBlur(a, w, h, radius);
    for (let p = 0; p < w * h; p++) out[p * 4 + ch] = a[p];
  }
  for (let p = 3; p < out.length; p += 4) out[p] = 255;
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** A mask (bytes) softened. */
function blurMask(mask, w, h, radius) {
  let a = Float32Array.from(mask);
  for (let pass = 0; pass < 2; pass++) a = boxBlur(a, w, h, radius);
  return Uint8Array.from(a, (x) => Math.round(x));
}

/**
 * Skin by its hue, not its brightness (a backlit face is dark, and still skin): red over green over blue, in the narrow
 * band of chromaticity every skin tone shares. Deep reds (wine, a burgundy sweater) have too little green.
 */
function skinOf(L) {
  const { w, h, fine } = L;
  const raw = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const R = fine[p * 4], G = fine[p * 4 + 1], B = fine[p * 4 + 2];
    const sum = R + G + B;
    if (sum < 36 || !(R > G && G > B)) continue;
    const d = ((R / sum - 0.45) / 0.07) ** 2 + ((G / sum - 0.31) / 0.035) ** 2;
    if (d < 1) raw[p] = Math.round(255 * (1 - d));
  }
  return raw;
}

/**
 * The sky: bright, toward the top, cool or neutral rather than warm, and (once it's known) not the subject. Grown from
 * the top down, so a bright wall low in the frame isn't sky. Softened first and only then cut around the subject, so it
 * runs right up to the subject's own (soft) edge: cut first, the softening would leave a ring of untouched sky around
 * them, a halo whenever the sky is darkened.
 */
function skyOf(L) {
  const { w, h, coarse, subject } = L;
  const sky = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let open = 1;
    for (let y = 0; y < h; y++) {
      const p = y * w + x;
      const R = coarse[p * 4] / 255, G = coarse[p * 4 + 1] / 255, B = coarse[p * 4 + 2] / 255;
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const warm = Math.max(0, R - B - 0.15);
      // Behind the subject, the sky is whatever's around it (it's cut out below), so the run from the top carries on.
      const high = 1 - smoothstep(0.45, 0.9, y / h);
      const s = subject && subject[p] > 128 ? (open > 0.5 ? high : 0) : smoothstep(0.42, 0.7, lum) * (1 - Math.min(1, warm * 3)) * high;
      // Below the first long run of not-sky, nothing is sky (the horizon, then the ground).
      if (s < 0.2) open = Math.max(0, open - 0.04);
      sky[p] = Math.round(255 * s * open);
    }
  }
  const soft = blurMask(sky, w, h, Math.max(2, Math.round(Math.min(w, h) / 120)));
  if (subject) for (let p = 0; p < w * h; p++) soft[p] = Math.round(soft[p] * (1 - subject[p] / 255));
  return soft;
}

/** Faces (from the server, the sidecar, or none), drawn into each level's face and eye masks; guessed from skin if none. */
function setFaces(faces) {
  analysis.faces = faces;
  for (const L of Object.values(levels)) {
    const { w, h } = L;
    L.face.fill(0);
    L.eyes.fill(0);
    const ovals = faces.length ? faces.map((f) => ({ x: f.box[0] + f.box[2] / 2, y: f.box[1] + f.box[3] / 2, rx: f.box[2] * 0.62, ry: f.box[3] * 0.66 })) : [findFace(L)];
    for (const o of ovals) {
      const x0 = Math.max(0, Math.floor((o.x - o.rx) * w)), x1 = Math.min(w, Math.ceil((o.x + o.rx) * w));
      const y0 = Math.max(0, Math.floor((o.y - o.ry) * h)), y1 = Math.min(h, Math.ceil((o.y + o.ry) * h));
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const d = ((x / w - o.x) / o.rx) ** 2 + ((y / h - o.y) / o.ry) ** 2;
          if (d < 1) L.face[y * w + x] = Math.max(L.face[y * w + x], Math.round(255 * (1 - d) ** 1.5));
        }
    }
    for (const f of faces)
      for (const [ex, ey, er] of f.eyes ?? []) {
        const R = er * Math.max(w, h) * 1.7;
        const cx = ex * w, cy = ey * h;
        for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, Math.ceil(cy + R)); y++)
          for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, Math.ceil(cx + R)); x++) {
            const d = Math.hypot(x - cx, y - cy) / R;
            if (d < 1) L.eyes[y * w + x] = Math.max(L.eyes[y * w + x], Math.round(255 * (1 - d * d)));
          }
      }
  }
  syncMasks();
}

/** With no face known: the densest patch of skin (a face is solid; hair, also skin-colored, is streaky). */
function findFace(L) {
  const { w, h, skin } = L;
  const c = Math.max(4, Math.round(Math.min(w, h) / 90));
  const gw = Math.ceil(w / c), gh = Math.ceil(h / c);
  const grid = new Float32Array(gw * gh);
  for (let p = 0; p < w * h; p++) grid[Math.floor(Math.floor(p / w) / c) * gw + Math.floor((p % w) / c)] += skin[p] / 255 / (c * c);
  const k = Math.max(3, Math.round(gh * 0.12));
  let best = { score: 0.2, x: -1, y: -1 };
  for (let y = 0; y + k <= gh; y++)
    for (let x = 0; x + k <= gw; x++) {
      let s = 0;
      for (let j = y; j < y + k; j++) for (let i = x; i < x + k; i++) s += grid[j * gw + i];
      const score = (s / (k * k)) * (1 - 0.3 * (y / gh));
      if (score > best.score) best = { score, x, y };
    }
  if (best.x < 0) return { x: 0.5, y: 0.38, rx: 0.14, ry: 0.2 };
  return { x: ((best.x + k / 2) * c) / w, y: ((best.y + k / 2) * c) / h, rx: ((k * c) / w) * 0.9, ry: ((k * c) / h) * 1.1 };
}

/** Asks Lumen's server where the subject and the faces are (Apple Vision), and fills in the masks. */
async function analyze(img, w, h, token) {
  const status = (text) => ($('mask-status').textContent = text);
  status('Finding the subject…');
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob });
    const a = await res.json();
    if (!res.ok) throw new Error(a.error ?? `The server answered ${res.status}.`);
    if (token !== loadToken) return;
    if (a.subject) {
      const mask = await new Promise((resolve, reject) => {
        const m = new Image();
        m.onload = () => resolve(m);
        m.onerror = reject;
        m.src = a.subject;
      });
      for (const L of Object.values(levels)) {
        const mc = document.createElement('canvas');
        mc.width = L.w;
        mc.height = L.h;
        const mcc = mc.getContext('2d', { willReadFrequently: true });
        mcc.drawImage(mask, 0, 0, L.w, L.h);
        const d = mcc.getImageData(0, 0, L.w, L.h).data;
        L.subject = new Uint8Array(L.w * L.h);
        for (let p = 0; p < L.w * L.h; p++) L.subject[p] = d[p * 4];
        L.sky = skyOf(L);
      }
      analysis.subject = true;
      syncMasks();
    }
    if (a.faces?.length) setFaces(a.faces);
    const n = a.faces?.length ?? 0;
    status(a.subject ? `Subject found${n ? ` · ${n} face${n === 1 ? '' : 's'}` : ''}.` : 'No subject stands out in this photo; the sky, radial, and linear masks still work.');
  } catch (err) {
    if (token !== loadToken) return;
    status(`The subject and background masks need Lumen's server (Apple Vision, on a Mac): ${err.message} The sky, radial, and linear masks still work.`);
  }
  redraw();
}

// ---- developing --------------------------------------------------------------------------------------------------

/** A mask's settings, if any of them is on: what `develop` adds where the mask covers. */
function activeMasks(v) {
  return MASKS.map((m) => ({ name: m, ...Object.fromEntries(LOCAL.map((k) => [k, v[`m-${m}-${k}`] ?? 0])) })).filter((m) => LOCAL.some((k) => m[k]));
}

/** How much of a pixel a mask covers (0–1). */
function maskAt(name, L, v, p, x, y) {
  switch (name) {
    case 'subject':
      return L.subject ? L.subject[p] / 255 : 0;
    case 'background':
      return L.subject ? 1 - L.subject[p] / 255 : 0;
    case 'sky':
      return L.sky[p] / 255;
    case 'radial': {
      const aspect = L.w / L.h;
      const dx = (x - v['m-radial-x']) * aspect, dy = y - v['m-radial-y'];
      const r = v['m-radial-size'];
      const f = Math.max(0.02, v['m-radial-feather'] * r);
      const m = 1 - smoothstep(r - f, r + f * 0.2, Math.sqrt(dx * dx + dy * dy));
      return v.radialInvert ? 1 - m : m;
    }
    case 'linear': {
      const t = v.linearFrom === 'top' ? y : v.linearFrom === 'bottom' ? 1 - y : v.linearFrom === 'left' ? x : 1 - x;
      const pos = v['m-linear-position'];
      const f = Math.max(0.01, v['m-linear-feather'] * 0.5);
      return 1 - smoothstep(pos - f, pos + f, t);
    }
  }
  return 0;
}

/** A hue (degrees) at full saturation, minus gray: the push color grading gives. */
function tintOf(deg, amount) {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const k = amount * 0.22;
  return [(r - 0.5) * k, (g - 0.5) * k, (b - 0.5) * k];
}

/** The photo with every adjustment, into the level's `out`. */
function develop(L, v) {
  const { w, h, px, micro, fine, coarse, skin, face, eyes } = L;
  const out = L.out.data;
  const masks = activeMasks(v);
  const overlay = v.showMask !== 'none' ? v.showMask : null;
  const mixH = HUES.map((c) => v[`mix-h-${c}`] ?? 0), mixS = HUES.map((c) => v[`mix-s-${c}`] ?? 0), mixL = HUES.map((c) => v[`mix-l-${c}`] ?? 0);
  const mixing = [...mixH, ...mixS, ...mixL].some(Boolean);
  const tS = tintOf(v['grade-shadows-hue'], v['grade-shadows-sat']), tM = tintOf(v['grade-midtones-hue'], v['grade-midtones-sat']), tH = tintOf(v['grade-highlights-hue'], v['grade-highlights-sat']);
  const grading = v['grade-shadows-sat'] || v['grade-midtones-sat'] || v['grade-highlights-sat'];
  const bal = v['grade-balance'] * 0.2;
  const fade = v.fade ?? 0;
  const grainSize = Math.max(1, Math.round(v['grain-size'] * (w / levels.full.w) * 1)) || 1;
  const feather = v['vignette-feather'];

  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const x = (p % w) / w, y = ((p / w) | 0) / h;
    let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const fr = fine[i] / 255, fg = fine[i + 1] / 255, fb = fine[i + 2] / 255;

    // Noise: the grain toward its smooth copy; color noise, only the color.
    if (v.denoise) {
      const k = v.denoise * 0.85;
      r += (fr - r) * k;
      g += (fg - g) * k;
      b += (fb - b) * k;
    }
    if (v['denoise-color']) {
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Yf = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb, k = v['denoise-color'];
      r += (fr - Yf - (r - Y)) * k;
      g += (fg - Yf - (g - Y)) * k;
      b += (fb - Yf - (b - Y)) * k;
    }

    // Retouch: skin toward its smooth copy, the face a little brighter, the eyes brighter and crisper.
    const sk = skin[p] / 255;
    if (v.smooth && sk) {
      const m = sk * (0.35 + 0.65 * (face[p] / 255)) * v.smooth * 0.9;
      r += (fr - r) * m;
      g += (fg - g) * m;
      b += (fb - b) * m;
    }
    if (v.brighten && face[p]) {
      const k = 1 + (face[p] / 255) * (0.3 + 0.7 * sk) * v.brighten * 0.45;
      r *= k;
      g *= k;
      b *= k;
    }
    if (v.eyes && eyes[p]) {
      const e = (eyes[p] / 255) * v.eyes;
      r = (r + (r - fr) * e * 0.9) * (1 + 0.35 * e);
      g = (g + (g - fg) * e * 0.9) * (1 + 0.35 * e);
      b = (b + (b - fb) * e * 0.9) * (1 + 0.35 * e);
    }

    // What the masks add here.
    let ex = v.exposure, co = v.contrast, hi = v.highlights, sh = v.shadows, te = v.temperature, sa = v.saturation, cl = v.clarity;
    for (const m of masks) {
      const k = maskAt(m.name, L, v, p, x, y);
      if (!k) continue;
      ex += k * m.exposure;
      co += k * m.contrast;
      hi += k * m.highlights;
      sh += k * m.shadows;
      te += k * m.temperature;
      sa += k * m.saturation;
      cl += k * m.clarity;
    }

    // Detail: sharpening (the finest), texture (fine), clarity (wide).
    if (v.sharpen) {
      const k = v.sharpen * 1.6;
      r += (r - micro[i] / 255) * k;
      g += (g - micro[i + 1] / 255) * k;
      b += (b - micro[i + 2] / 255) * k;
    }
    if (v.texture) {
      const k = v.texture * 0.7;
      r += (r - fr) * k;
      g += (g - fg) * k;
      b += (b - fb) * k;
    }
    const cr = coarse[i] / 255, cg = coarse[i + 1] / 255, cb = coarse[i + 2] / 255;
    if (cl) {
      r += (r - cr) * cl;
      g += (g - cg) * cl;
      b += (b - cb) * cl;
    }
    // Dehaze: take out (or add) the veil bright, flat areas have.
    if (v.dehaze) {
      const A = 0.92, veil = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      if (v.dehaze > 0) {
        const t = Math.max(0.35, 1 - v.dehaze * 0.55 * veil);
        r = (r - A) / t + A;
        g = (g - A) / t + A;
        b = (b - A) / t + A;
      } else {
        const k = -v.dehaze * 0.45;
        r += (A - r) * k;
        g += (A - g) * k;
        b += (A - b) * k;
      }
    }

    // White balance, exposure, and the tones by brightness.
    r *= 1 + te * 0.2;
    b *= 1 - te * 0.2;
    g *= 1 - v.tint * 0.12;
    const gain = Math.exp(ex * 0.6931);
    r *= gain;
    g *= gain;
    b *= gain;
    let Lm = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const tone = 1 + sh * 0.7 * (1 - smoothstep(0, 0.5, Lm)) + hi * 0.45 * smoothstep(0.45, 1, Lm) + v.whites * 0.3 * smoothstep(0.6, 1.05, Lm);
    const lift = v.blacks * 0.1 * (1 - smoothstep(0, 0.28, Lm));
    const contrast = 1 + co * 0.8;
    r = (r * tone + lift - 0.5) * contrast + 0.5;
    g = (g * tone + lift - 0.5) * contrast + 0.5;
    b = (b * tone + lift - 0.5) * contrast + 0.5;

    // Glow: the bright parts bloom into their neighborhood.
    if (v.glow) {
      const bloom = Math.max(0, 0.2126 * cr + 0.7152 * cg + 0.0722 * cb - 0.35) * v.glow * 0.9;
      r += bloom * cr;
      g += bloom * cg;
      b += bloom * cb;
    }

    // The color mixer: each color's hue, saturation, and luminance, blended between its neighbors on the hue circle.
    if (mixing) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn;
      if (ch > 0.01) {
        let hue = mx === r ? ((g - b) / ch + 6) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4;
        hue *= 60;
        let j = 7;
        while (j > 0 && HUE_AT[j] > hue) j--;
        const next = (j + 1) % 8, span = (next ? HUE_AT[next] : 360) - HUE_AT[j];
        const t = (hue - HUE_AT[j]) / span;
        const dh = (mixH[j] * (1 - t) + mixH[next] * t) * 30;
        const ds = mixS[j] * (1 - t) + mixS[next] * t;
        const dl = mixL[j] * (1 - t) + mixL[next] * t;
        const sat = Math.min(1, ch / Math.max(1e-3, mx));
        const nh = (((hue + dh) % 360) + 360) % 360 / 60;
        const ns = Math.max(0, Math.min(1, sat * (1 + ds)));
        const nv = mx * (1 + dl * 0.5 * sat);
        const f = nh - Math.floor(nh), P = nv * (1 - ns), Q = nv * (1 - ns * f), T = nv * (1 - ns * (1 - f));
        [r, g, b] = [[nv, T, P], [Q, nv, P], [P, nv, T], [P, Q, nv], [T, P, nv], [nv, P, Q]][Math.floor(nh) % 6];
      }
    }

    // Saturation everywhere; vibrance mostly where color is weak (and gentler on skin).
    Lm = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const k = v.mono ? 0 : (1 + sa) * (1 + v.vibrance * (1 - Math.min(1, chroma * 2)) * (1 - sk * 0.5));
    r = Lm + (r - Lm) * k;
    g = Lm + (g - Lm) * k;
    b = Lm + (b - Lm) * k;

    // Color grading: a color for the shadows, one for the midtones, one for the highlights.
    if (grading) {
      const ws = 1 - smoothstep(0.05, 0.45 + bal, Lm), wh = smoothstep(0.55 + bal, 0.95, Lm), wm = Math.max(0, 1 - ws - wh);
      r += ws * tS[0] + wm * tM[0] + wh * tH[0];
      g += ws * tS[1] + wm * tM[1] + wh * tH[1];
      b += ws * tS[2] + wm * tM[2] + wh * tH[2];
    }

    if (fade) {
      r = r * (1 - fade) + fade;
      g = g * (1 - fade) + fade;
      b = b * (1 - fade) + fade;
    }
    // Vignette: like other editors, below zero darkens the edges and above lightens them; feather softens its edge.
    if (v.vignette) {
      const dx = (x - 0.5) * 2, dy = (y - 0.5) * 2;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const m = 1 + v.vignette * 0.85 * smoothstep(0.75 - feather * 0.55, 1.05, d);
      r *= m;
      g *= m;
      b *= m;
    }
    // Grain, strongest in the midtones, in clumps of its size.
    if (v.grain) {
      const gx = ((p % w) / grainSize) | 0, gy = ((p / w) / grainSize) | 0;
      let n = (gx * 374761393 + gy * 668265263) ^ 0x5bd1e995;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      const noise = ((n ^ (n >>> 16)) & 1023) / 1023 - 0.5;
      const k = noise * v.grain * 0.16 * (1 - Math.abs(Lm - 0.5));
      r += k;
      g += k;
      b += k;
    }

    let R = r * 255, G = g * 255, B = b * 255;
    if (v.clipping) {
      if (R >= 255 && G >= 255 && B >= 255) (R = 255), (G = 40), (B = 40);
      else if (R <= 0 && G <= 0 && B <= 0) (R = 40), (G = 90), (B = 255);
    }
    // Show mask: the mask's coverage in red, over the photo.
    if (overlay) {
      const m = maskAt(overlay, L, v, p, x, y) * 0.6;
      R += (255 - R) * m;
      G -= G * m * 0.85;
      B -= B * m * 0.75;
    }
    out[i] = R;
    out[i + 1] = G;
    out[i + 2] = B;
    out[i + 3] = 255;
  }
}

// ---- showing it: cropped, turned, straightened -------------------------------------------------------------------

const CROPS = { '1:1': 1, '4:5': 0.8, '3:2': 1.5, '16:9': 16 / 9, '9:16': 9 / 16 };

/** Draws `src` (the developed photo, `sw`×`sh`) into the photo canvas, sized as the full photo (`fw`×`fh`) would be. */
function present(src, sw, sh, fw, fh) {
  const turned = quarter % 2 === 1;
  const W = turned ? fh : fw, H = turned ? fw : fh;
  // The crop: the largest centered rectangle of its shape.
  const want = CROPS[$('crop').value];
  let cw = W, ch = H;
  if (want) {
    if (W / H > want) cw = Math.round(H * want);
    else ch = Math.round(W / want);
  }
  if (photo.width !== cw || photo.height !== ch) {
    photo.width = cw;
    photo.height = ch;
  }
  // Straightened, it zooms in just enough that no corner shows.
  const angle = ((Number($('straighten').value) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  const cover = Math.max((cw * cos + ch * sin) / W, (cw * sin + ch * cos) / H);
  const scale = cover * (fw / sw);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((quarter * Math.PI) / 2 + angle);
  ctx.scale($('flip').checked ? -scale : scale, scale);
  ctx.drawImage(src, -sw / 2, -sh / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawHistogram(data) {
  const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
  for (let i = 0; i < data.length; i += 16) for (let c = 0; c < 3; c++) bins[c][data[i + c] >> 2]++;
  const max = Math.max(1, ...bins.flatMap((b) => [...b].slice(1, 63)));
  const { width: W, height: H } = hctx.canvas;
  hctx.clearRect(0, 0, W, H);
  hctx.globalCompositeOperation = 'lighter';
  ['rgba(255,80,80,.55)', 'rgba(80,220,120,.5)', 'rgba(90,140,255,.6)'].forEach((color, c) => {
    hctx.beginPath();
    hctx.moveTo(0, H);
    bins[c].forEach((n, x) => hctx.lineTo((x / 63) * W, H - Math.min(1, n / max) * (H - 6)));
    hctx.lineTo(W, H);
    hctx.fillStyle = color;
    hctx.fill();
  });
  hctx.globalCompositeOperation = 'source-over';
}

/**
 * Redraws: while a slider is moving, the half-size preview at once and the full photo once it rests; otherwise the
 * full photo.
 */
let frame = 0;
let settle = 0;
function redraw(moving = false) {
  showValues();
  if (!levels) return;
  cancelAnimationFrame(frame);
  clearTimeout(settle);
  // On the GPU the full photo keeps up with a moving slider; on the CPU, the preview does.
  const quick = moving && levels.preview;
  frame = requestAnimationFrame(() => render(quick ? levels.preview : levels.full));
  if (quick) settle = setTimeout(() => (frame = requestAnimationFrame(() => render(levels.full))), 220);
}

let histogramSoon = 0;
function render(L) {
  if (engine?.size) {
    const v = values();
    engine.render(v, { original: showOriginal });
    const { w, h } = engine.size;
    present(engine.canvas, w, h, w, h);
    // The histogram from a small copy, at most every 80 ms (reading back waits for the GPU).
    clearTimeout(histogramSoon);
    histogramSoon = setTimeout(() => drawHistogram(engine.read(v, 240, { original: showOriginal }).data), 80);
    return;
  }
  if (showOriginal) L.out.data.set(L.px);
  else develop(L, values());
  work.width = L.w;
  work.height = L.h;
  wctx.putImageData(L.out, 0, 0);
  present(work, L.w, L.h, levels.full.w, levels.full.h);
  drawHistogram(L.out.data);
}

// ---- history: undo and redo ----------------------------------------------------------------------------------------

/** Every state so far (the last is now), and the ones undone (to redo). */
const past = [];
const undone = [];

function snapshot() {
  const s = { quarter };
  for (const el of document.querySelectorAll('.controls input, .controls select')) {
    if (el.type === 'file') continue;
    s[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return s;
}

function apply(s) {
  quarter = s.quarter;
  for (const [id, x] of Object.entries(s)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = x;
    else el.value = x;
  }
  redraw();
}

const buttons = () => (($('undo').disabled = past.length < 2), ($('redo').disabled = !undone.length));

/** Keeps where things are now, if anything changed. */
function remember() {
  const s = snapshot();
  if (past.length && JSON.stringify(past.at(-1)) === JSON.stringify(s)) return;
  past.push(s);
  if (past.length > 100) past.shift();
  undone.length = 0;
  buttons();
}

function undo() {
  if (past.length < 2) return;
  undone.push(past.pop());
  apply(past.at(-1));
  buttons();
}

function redo() {
  if (!undone.length) return;
  past.push(undone.pop());
  apply(past.at(-1));
  buttons();
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.target.matches?.('input[type="text"], textarea')) return;
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
});

// ---- the controls, wired -----------------------------------------------------------------------------------------

// A slider redraws as it moves (the quick preview); everything else once it's changed.
form.addEventListener('input', (e) => e.target.type === 'range' && redraw(true));
form.addEventListener('change', () => (redraw(), remember()));
for (const id of ['look', 'clipping']) $(id).addEventListener('change', () => (redraw(), remember()));

// Double-click a slider's name to put it back.
for (const input of sliders()) {
  input.closest('.slider')?.querySelector('label')?.addEventListener('dblclick', () => {
    input.value = input.defaultValue;
    redraw();
    remember();
  });
}

$('rotate-left').addEventListener('click', () => ((quarter = (quarter + 3) % 4), redraw(), remember()));
$('rotate-right').addEventListener('click', () => ((quarter = (quarter + 1) % 4), redraw(), remember()));

$('reset').addEventListener('click', () => {
  for (const el of document.querySelectorAll('.controls input, .controls select')) {
    if (el.type === 'file') continue;
    if (el.type === 'checkbox') el.checked = el.defaultChecked;
    else if (el.tagName === 'SELECT') el.value = ([...el.options].find((o) => o.defaultSelected) ?? el.options[0]).value;
    else el.value = el.defaultValue;
  }
  quarter = 0;
  redraw();
  remember();
});

const compare = $('compare');
const hold = (on) => {
  showOriginal = on;
  note.hidden = !on;
  compare.setAttribute('aria-pressed', String(on));
  redraw();
};
compare.addEventListener('pointerdown', () => hold(true));
for (const e of ['pointerup', 'pointerleave', 'blur']) compare.addEventListener(e, () => showOriginal && hold(false));
// A click from the keyboard (or an agent) flips it instead.
compare.addEventListener('click', (e) => e.detail === 0 && hold(!showOriginal));

/** Auto: exposure toward a middle brightness, the ends of the range to its whites and blacks. */
$('auto').addEventListener('click', () => {
  if (!levels) return;
  const px = (levels.preview ?? levels.full).px;
  let sum = 0, lo = 0, hi = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) {
    const L = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    sum += L;
    if (L < 0.05) lo++;
    if (L > 0.95) hi++;
    n++;
  }
  const mean = sum / n;
  const set = (id, x) => ($(id).value = String(x));
  set('exposure', Math.max(-1.5, Math.min(1.5, Math.log2(0.46 / Math.max(0.05, mean)))).toFixed(2));
  set('contrast', Math.round(Math.max(-30, Math.min(30, (0.06 - (lo + hi) / n) * 300))));
  set('shadows', Math.round(Math.min(40, (lo / n) * 400)));
  set('highlights', -Math.round(Math.min(40, (hi / n) * 400)));
  set('whites', Math.round(Math.max(-20, Math.min(20, (0.02 - hi / n) * 400))));
  set('blacks', Math.round(Math.max(-20, Math.min(20, (lo / n - 0.02) * 300))));
  redraw();
  remember();
});

$('open').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) void load(URL.createObjectURL(file), file.name, file);
});

$('export').addEventListener('click', (e) => {
  e.currentTarget.href = photo.toDataURL('image/jpeg', 0.92);
});

// A stock portrait (see CREDITS.md). Open a photo or a camera raw to edit your own.
void load('/portrait.jpg', 'portrait.jpg');
