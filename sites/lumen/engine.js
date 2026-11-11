/*
 * Lumen's engine: develops the photo on the GPU (WebGL2), the way a raw editor does.
 *
 * Everything happens in scene-linear light, in a wide gamut (linear Rec. 2020), in half floats: a raw comes in that way
 * from Lumen's server (Apple's raw engine: demosaic, the camera's color, lens corrections; server/develop.swift), with
 * what's above white still there to recover. A JPEG is taken back to scene light through the inverse of the display
 * curve, so it opens looking exactly as it was.
 *
 * Per pixel, in order: noise, retouch, white balance (a chromatic adaptation from the as-shot light), exposure, local
 * tone (highlights and shadows move a smooth, edge-aware base, so detail stays and edges don't halo), contrast, detail
 * (clarity, texture, sharpening, all on luminance, so no color fringes), dehaze, color (in Oklab: saturation, vibrance,
 * the mixer, grading), glow, vignette; then the display curve (a filmic toe and shoulder that lands the raw's clip
 * point at white), the path to white for what's still over, the gamut of the screen (Display P3 where the browser has
 * it), and a dither so smooth skies don't band. The masks' own settings blend in per pixel wherever a mask covers.
 *
 * What only depends on the photo (its luminance and blurs at four scales, the edge-aware base) is worked out once when
 * it opens; a change to a control is one pass over the pixels.
 */
(() => {
  const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // ---- color: the working space (linear Rec. 2020) and what's needed around it ------------------------------------
  const COMMON = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 o;
const vec3 W2020 = vec3(0.2627, 0.6780, 0.0593);
const float LOG_GREY = -2.473931;  // log2(0.18)
// Linear Rec. 2020 to and from linear sRGB primaries (for Oklab, which is defined on them).
const mat3 R2020_TO_709 = mat3(1.660491, -0.124550, -0.018151, -0.587641, 1.132900, -0.100579, -0.072850, -0.008349, 1.118730);
const mat3 R709_TO_2020 = mat3(0.627404, 0.069097, 0.016391, 0.329283, 0.919540, 0.088013, 0.043313, 0.011362, 0.895595);
float lum(vec3 c) { return dot(c, W2020); }
vec3 srgbDecode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 srgbEncode(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Oklab (Björn Ottosson), on linear sRGB primaries; cube roots kept signed so out-of-gamut values survive the trip.
vec3 cbrt3(vec3 x) { return sign(x) * pow(abs(x), vec3(1.0 / 3.0)); }
vec3 toOklab(vec3 c) {
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005) * c;
  return mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.7936177850, -2.4285922050, 0.7827717662, -0.0040720468, 0.4505937099, -0.8086757660) * cbrt3(lms);
}
vec3 fromOklab(vec3 l) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480) * l;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}
// A power norm (darktable filmic's): close to the brightest channel for saturated colors, to luminance for gray ones.
float pnorm(vec3 c) { c = max(c, 0.0); float s2 = dot(c, c); return s2 > 1e-12 ? dot(c * c, c) / s2 : 0.0; }

// The display curve, in stops from middle gray (e) to display-encoded value (y): an exponential toe, a cubic
// shoulder that lands at white at uWhite stops, matched in slope at middle gray.
uniform float uWhite, uSlope;
const float Y0 = 0.47;
float curve(float e) {
  float SLOPE = uSlope;
  if (e <= 0.0) return Y0 * exp(SLOPE / Y0 * e);
  float u = min(e / uWhite, 1.0), s = SLOPE * uWhite / (1.0 - Y0);
  float q = (2.0 * u * u * u - 3.0 * u * u + 1.0) - s * (u * u * u - 2.0 * u * u + u);
  return 1.0 - (1.0 - Y0) * max(q, 0.0);
}
float curveInverse(float y) {
  if (y <= Y0) return log(max(y, 1e-6) / Y0) * Y0 / uSlope;
  float lo = 0.0, hi = uWhite;
  for (int i = 0; i < 24; i++) { float m = 0.5 * (lo + hi); if (curve(m) < y) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
`;

  // A JPEG to scene light: sRGB to display-linear, the display curve undone on the norm, the primaries widened.
  const FS_LINEARIZE = `${COMMON}
uniform sampler2D uImg;
void main() {
  vec3 d = R709_TO_2020 * srgbDecode(texture(uImg, vUv).rgb);
  float yl = pnorm(d);
  float n = 0.18 * exp2(curveInverse(srgbEncode(vec3(yl)).r));
  o = vec4(yl > 1e-6 ? d * (n / yl) : vec3(0.0), 1.0);
}`;

  // Log luminance, and the same at its finest blur (about a pixel).
  const FS_LOGLUM = `${COMMON}
uniform sampler2D uSrc;
void main() { o = vec4(log2(max(lum(texture(uSrc, vUv).rgb), 1e-5)), 0.0, 0.0, 1.0); }`;

  // A separable gaussian (one direction), at the target's resolution.
  const FS_BLUR = `${COMMON}
uniform sampler2D uTex; uniform vec2 uStep; uniform float uSigma; uniform int uTaps;
void main() {
  vec4 acc = texture(uTex, vUv); float wsum = 1.0;
  for (int i = 1; i <= 40; i++) {
    if (i > uTaps) break;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    acc += w * (texture(uTex, vUv + uStep * float(i)) + texture(uTex, vUv - uStep * float(i)));
    wsum += 2.0 * w;
  }
  o = acc / wsum;
}`;

  // Copies (a resample; with linear filtering, halving twice is a 4x4 box).
  const FS_COPY = `${COMMON}
uniform sampler2D uTex;
void main() { o = texture(uTex, vUv); }`;

  // The guided filter's inputs (I, I²) from log luminance; then its coefficients from their means.
  const FS_GUIDE_IN = `${COMMON}
uniform sampler2D uTex;
void main() { float i = texture(uTex, vUv).r; o = vec4(i, i * i, 0.0, 1.0); }`;
  const FS_GUIDE_AB = `${COMMON}
uniform sampler2D uTex; uniform float uEps;
void main() { vec2 m = texture(uTex, vUv).rg; float v = max(m.y - m.x * m.x, 0.0); float a = v / (v + uEps); o = vec4(a, m.x - a * m.x, 0.0, 1.0); }`;
  // The guided base itself, at full resolution: a·I + b (the base highlights and shadows move).
  const FS_GUIDE_BASE = `${COMMON}
uniform sampler2D uAB; uniform sampler2D uLum;
void main() { vec2 ab = texture(uAB, vUv).rg; float i = texture(uLum, vUv).r; o = vec4(i, ab.x * i + ab.y, 0.0, 1.0); }`;

  // ---- developing ---------------------------------------------------------------------------------------------------
  const FS_DEVELOP = `${COMMON}
uniform sampler2D uSrc, uLum, uMicro, uFine, uCoarse, uFineRGB, uCoarseRGB, uMaskA, uMaskB;
uniform vec2 uSize;
uniform mat3 uWB;            // white balance (linear Rec. 2020)
uniform mat3 uOut;           // linear Rec. 2020 to the screen's primaries
uniform float uEV, uContrast, uHighlights, uShadows, uWhites, uBlacks, uTexture, uClarity, uDehaze, uSharpen;
uniform float uDenoise, uDenoiseColor, uSmooth, uBrighten, uEyes, uSat, uVib, uMono, uFade, uGlow, uVignette, uFeather;
uniform float uGrain, uGrainSize, uTintLocal;
uniform float uBaseEV, uBaseChroma;  // the profile a raw opens with: its placement, its color
uniform vec3 uAir;           // the haze's color (the brightest of the coarse view)
uniform float uMix[24];      // the color mixer: hue, saturation, luminance for 8 colors
uniform float uMixAt[8];     // where each of those colors sits on Oklab's hue circle (radians)
uniform int uMixing, uGrading;
uniform vec3 uGradeS, uGradeM, uGradeH;  // grading: Oklab a, b offsets (and amount) per range
uniform float uBalance;
// The masks: per mask, exposure, contrast, highlights, shadows, temperature, saturation, clarity.
uniform float uLocal[35];
uniform int uLocalOn[5];
uniform int uHasSubject;
uniform vec4 uRadial;        // x, y, size, feather
uniform int uRadialInvert;
uniform vec3 uLinear;        // from (0 top, 1 bottom, 2 left, 3 right), position, feather
uniform int uOverlay;        // -1 none, else the mask shown
uniform int uClipping, uOriginal;

float smoothstep01(float a, float b, float x) { return smoothstep(a, b, x); }
float maskAt(int m, vec4 A, vec2 uv) {
  if (m == 0) return uHasSubject == 1 ? A.r : 0.0;
  if (m == 1) return uHasSubject == 1 ? 1.0 - A.r : 0.0;
  if (m == 2) return A.g;
  if (m == 3) {
    float aspect = uSize.x / uSize.y;
    vec2 d = vec2((uv.x - uRadial.x) * aspect, (1.0 - uv.y) - uRadial.y);
    float f = max(0.02, uRadial.w * uRadial.z);
    float k = 1.0 - smoothstep(uRadial.z - f, uRadial.z + f * 0.2, length(d));
    return uRadialInvert == 1 ? 1.0 - k : k;
  }
  float y = 1.0 - uv.y, x = uv.x;
  float t = uLinear.x < 0.5 ? y : uLinear.x < 1.5 ? 1.0 - y : uLinear.x < 2.5 ? x : 1.0 - x;
  float f = max(0.01, uLinear.z * 0.5);
  return 1.0 - smoothstep(uLinear.y - f, uLinear.y + f, t);
}
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 uv = vUv;
  vec3 x = texture(uSrc, uv).rgb;
  vec4 A = texture(uMaskA, uv);
  float subject = A.r, skin = A.b, face = A.a, eyes = texture(uMaskB, uv).r;
  vec2 lm = texture(uLum, uv).rg;      // log luminance; the edge-aware base
  float L = lm.r, base = lm.g;
  float Lmicro = texture(uMicro, uv).r, Lfine = texture(uFine, uv).r, Lcoarse = texture(uCoarse, uv).r;
  vec3 f = texture(uFineRGB, uv).rgb, c = texture(uCoarseRGB, uv).rgb;

  if (uOriginal == 0) {
    // Noise: luminance toward the fine blur where it's flat (not across edges); color, the chroma of the blur.
    if (uDenoise > 0.0) {
      float d = L - Lfine;
      float k = uDenoise * 0.85 * exp(-d * d / (2.0 * 0.12 * 0.12));
      x *= exp2(-k * (L - Lfine));
    }
    if (uDenoiseColor > 0.0) {
      vec3 a = toOklab(R2020_TO_709 * x), b = toOklab(R2020_TO_709 * f);
      a.yz = mix(a.yz, b.yz * (a.x / max(b.x, 1e-4)), uDenoiseColor);
      x = R709_TO_2020 * fromOklab(a);
    }
  }

  // Local settings: what each mask covering this pixel adds.
  float ex = uBaseEV + uEV, co = uContrast, hi = uHighlights, sh = uShadows, te = 0.0, sa = uSat, cl = uClarity;
  if (uOriginal == 0) {
    for (int m = 0; m < 5; m++) {
      if (uLocalOn[m] == 0) continue;
      float k = maskAt(m, A, uv);
      if (k <= 0.0) continue;
      ex += k * uLocal[m * 7 + 0]; co += k * uLocal[m * 7 + 1]; hi += k * uLocal[m * 7 + 2]; sh += k * uLocal[m * 7 + 3];
      te += k * uLocal[m * 7 + 4]; sa += k * uLocal[m * 7 + 5]; cl += k * uLocal[m * 7 + 6];
    }
    // Retouch: the face a little brighter (more on its skin), the eyes brighter.
    ex += face * (0.3 + 0.7 * skin) * uBrighten * 0.7 + eyes * uEyes * 0.45;
  }

  // White balance (global, a chromatic adaptation), then any local warming or cooling.
  x = uWB * x;
  x *= vec3(1.0 + te * 0.22, 1.0, 1.0 - te * 0.22);
  // Exposure.
  float gain = exp2(ex);
  x *= gain;
  float Lx = L + ex;

  // Dehaze: the veil the haze adds, taken out (or put in), from the dark channel of the wide view.
  if (uOriginal == 0 && uDehaze != 0.0) {
    vec3 cx = c * gain, air = uAir * gain;
    float dark = clamp(min(min(cx.r / air.r, cx.g / air.g), cx.b / air.b), 0.0, 1.0);
    if (uDehaze > 0.0) {
      float t = max(0.3, 1.0 - uDehaze * 0.9 * dark);
      x = max((x - air) / t + air, 0.0);
    } else x = mix(x, air * 0.9, -uDehaze * 0.45 * (0.4 + 0.6 * dark));
    Lx = log2(max(lum(x), 1e-5));
  }

  // Local tone: highlights and shadows move the edge-aware base (in stops from middle gray), detail rides along.
  float L2 = Lx;
  if (uOriginal == 0) {
    float b = base + ex, rel = b - LOG_GREY;
    float detail = Lx - b;
    b += sh * 2.2 * (1.0 - smoothstep(-4.0, 0.8, rel)) * smoothstep(-11.0, -6.0, rel);
    b += hi * 2.0 * smoothstep(-0.8, 2.6, rel);
    L2 = b + detail;
    // Contrast: about middle gray, in stops.
    L2 = (L2 - LOG_GREY) * (1.0 + co * 0.5) + LOG_GREY;
    // Detail on luminance: clarity (wide, the midtones), texture (fine), sharpening (finest, not the noise).
    float mid = 1.0 - smoothstep(1.5, 4.5, abs(rel + 0.5));
    L2 += cl * 0.9 * mid * clamp(L - Lcoarse, -1.5, 1.5);
    L2 += uTexture * 1.1 * (Lmicro - Lfine);
    float sd = L - Lmicro;
    L2 += uSharpen * 1.6 * sd * smoothstep(0.015, 0.05, abs(sd));
    // Skin: the blemish band taken out, the finest texture partly kept (never plastic).
    if (uSmooth > 0.0) {
      float k = skin * (0.35 + 0.65 * face) * uSmooth;
      L2 -= k * (0.95 * (Lmicro - Lfine) + 0.45 * (L - Lmicro));
    }
    // The eyes: crisper.
    L2 += eyes * uEyes * 0.8 * (L - Lfine);
    x *= exp2(L2 - Lx);
  }

  // Color, in Oklab: the mixer (each color's hue, saturation, lightness), then saturation and vibrance, grading.
  vec3 lab = toOklab(R2020_TO_709 * x);
  float C = length(lab.yz);
  if (uOriginal == 0) {
    float h = atan(lab.z, lab.y);
    if (uMixing == 1 && C > 1e-4) {
      // The two colors this hue is between, and how far along.
      float hh = h < 0.0 ? h + 6.2831853 : h;
      int j = 7;
      for (int i = 7; i >= 0; i--) { if (uMixAt[i] <= hh) { j = i; break; } if (i == 0) j = 7; }
      int n = j == 7 ? 0 : j + 1;
      float a0 = uMixAt[j], a1 = n == 0 ? uMixAt[0] + 6.2831853 : uMixAt[n];
      float hx = hh < a0 ? hh + 6.2831853 : hh;
      float t = clamp((hx - a0) / (a1 - a0), 0.0, 1.0);
      float wc = smoothstep(0.0, 0.05, C);
      float dh = mix(uMix[j], uMix[n], t) * 0.5 * wc;
      float ds = mix(uMix[8 + j], uMix[8 + n], t) * wc;
      float dl = mix(uMix[16 + j], uMix[16 + n], t) * wc * smoothstep(0.0, 0.12, C);
      h += dh;
      C *= max(0.0, 1.0 + ds);
      lab.x *= exp2(dl * 0.9);
    }
    // Skin (by its hue, in Oklab around 30–75°) is spared most of vibrance.
    float skinHue = (1.0 - smoothstep(0.35, 0.6, abs(h - 0.9))) * smoothstep(0.02, 0.06, C);
    C *= max(0.0, 1.0 + sa) * (1.0 + uVib * (1.0 - smoothstep(0.02, 0.22, C)) * (1.0 - 0.7 * max(skinHue, skin)));
    if (uMono > 0.5) C = 0.0;
    lab.yz = C * vec2(cos(h), sin(h));
  }
  // The profile's color (a raw's; a JPEG has its own already), then grading.
  lab.yz *= uBaseChroma;
  if (uOriginal == 0) {
    if (uGrading == 1) {
      float y = curve(log2(max(pnorm(x), 1e-6)) - LOG_GREY);
      float ws = 1.0 - smoothstep(0.05, 0.45 + uBalance, y), wh = smoothstep(0.55 + uBalance, 0.95, y), wm = max(0.0, 1.0 - ws - wh);
      lab.yz += (ws * uGradeS.xy + wm * uGradeM.xy + wh * uGradeH.xy) * clamp(lab.x / 0.6, 0.25, 1.6);
    }
  }
  x = R709_TO_2020 * fromOklab(lab);

  if (uOriginal == 0) {
    // Glow: the bright parts of the wide view bloom into their surroundings.
    if (uGlow > 0.0) {
      vec3 cx = c * gain;
      x += cx * uGlow * 0.9 * smoothstep(0.1, 0.8, lum(cx));
    }
    // Vignette: in stops, darkening (or lightening) toward the corners; feather softens its edge.
    if (uVignette != 0.0) {
      vec2 d = (uv - 0.5) * 2.0;
      float r = length(d) / 1.41421356;
      x *= exp2(uVignette * 1.6 * smoothstep(0.75 - uFeather * 0.55, 1.05, r));
    }
  }

  // The display curve, on the norm (so hues hold); the white point moves with whites, blacks lift or crush the toe.
  float n = pnorm(x);
  float y = curve(log2(max(n, 1e-6)) - LOG_GREY);
  if (uOriginal == 0) y = clamp(y + uBlacks * 0.07 * (1.0 - smoothstep(0.0, 0.35, y)), 0.0, 1.0);
  float yl = srgbDecode(vec3(y)).r;
  vec3 d = n > 1e-6 ? x * (yl / n) : vec3(0.0);
  // The path to white: a channel still over 1 pulls the color toward its gray (bright colors go to white, not hue).
  float dl = lum(d), mx = max(max(d.r, d.g), d.b);
  if (mx > 1.0) d = dl + (d - dl) * max(0.0, (1.0 - dl) / max(mx - dl, 1e-5));
  // To the screen's primaries; colors outside its gamut are brought in toward their gray.
  vec3 s = uOut * d;
  float sl = dot(s, vec3(0.2126, 0.7152, 0.0722)), mn = min(min(s.r, s.g), s.b);
  if (mn < 0.0) s = sl + (s - sl) * (sl / max(sl - mn, 1e-5));
  vec3 e = srgbEncode(clamp(s, 0.0, 1.0));

  if (uOriginal == 0) {
    if (uFade > 0.0) e = e * (1.0 - uFade) + uFade;
    if (uGrain > 0.0) {
      vec2 p = uv * uSize / uGrainSize;
      float g = valueNoise(p) + 0.5 * valueNoise(p * 2.1 + 17.0) - 0.75;
      float Y = dot(e, vec3(0.2126, 0.7152, 0.0722));
      e += g * uGrain * 0.2 * (1.0 - abs(Y - 0.5) * 1.3);
    }
  }
  if (uClipping == 1) {
    if (min(min(s.r, s.g), s.b) >= 0.995) e = vec3(1.0, 0.16, 0.16);
    else if (max(max(s.r, s.g), s.b) <= 0.0015) e = vec3(0.16, 0.36, 1.0);
  }
  if (uOverlay >= 0) {
    float m = maskAt(uOverlay, A, uv) * 0.6;
    e = vec3(e.r + (1.0 - e.r) * m, e.g - e.g * m * 0.85, e.b - e.b * m * 0.75);
  }
  // A dither: smooth gradients (a sky) don't band at 8 bits.
  e += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(e, 1.0);
}`;

  // ---- white balance --------------------------------------------------------------------------------------------
  const M = {
    mul: (a, b) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c])),
    vec: (a, v) => [0, 1, 2].map((r) => a[r][0] * v[0] + a[r][1] * v[1] + a[r][2] * v[2]),
    inv(m) {
      const [[a, b, c], [d, e, f], [g, h, i]] = m;
      const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
      return [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]].map((r) => r.map((x) => x / det));
    },
    // Row-major to the column-major a GLSL mat3 wants.
    gl: (m) => new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]),
  };
  const R2020_TO_XYZ = [[0.636958, 0.144617, 0.168881], [0.2627, 0.677998, 0.059302], [0, 0.028073, 1.060985]];
  const XYZ_TO_R2020 = M.inv(R2020_TO_XYZ);
  const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const BRADFORD_INV = M.inv(BRADFORD);
  const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
  const D65 = xyToXYZ([0.3127, 0.329]);
  /** The Planckian locus at `kelvin` (Kim et al.'s cubic): its chromaticity. */
  function planckXY(kelvin) {
    const T = Math.max(1700, Math.min(25000, kelvin));
    const x = T <= 4000 ? -0.2661239e9 / T ** 3 - 0.234358e6 / T ** 2 + 0.8776956e3 / T + 0.17991 : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039;
    const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
    return [x, y];
  }
  /** A light of `kelvin`, `green` (Duv) off the locus toward green (negative: magenta): its chromaticity. */
  function lightXY(kelvin, green) {
    const uv = ([x, y]) => [(4 * x) / (-2 * x + 12 * y + 3), (6 * y) / (-2 * x + 12 * y + 3)];
    const [u, v] = uv(planckXY(kelvin)), [u2, v2] = uv(planckXY(kelvin * 1.01));
    const len = Math.hypot(u2 - u, v2 - v) || 1;
    // Along the locus as it warms is (u2 - u, v2 - v); green is the side v grows toward.
    let [pu, pv] = [-(v2 - v) / len, (u2 - u) / len];
    if (pv < 0) [pu, pv] = [-pu, -pv];
    const U = u + pu * green, V = v + pv * green;
    return [(3 * U) / (2 * U - 8 * V + 4), (2 * V) / (2 * U - 8 * V + 4)];
  }
  /**
   * The white balance as a matrix on the working space: the photo was balanced for the as-shot light; this rebalances
   * it for the light the sliders say (temperature in mireds from it, tint off the locus), by Bradford adaptation.
   */
  function whiteBalance(asShotK, asShotTint, temperature, tint) {
    if (!temperature && !tint) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // Warmer (positive) assumes a bluer light to correct for, as the slider does in raw editors.
    const mired = 1e6 / asShotK - temperature * 120;
    const target = 1e6 / Math.max(40, mired);
    // Positive tint is magenta, as raw editors have it: it assumes a greener light, and corrects for it.
    const shot = xyToXYZ(lightXY(asShotK, 0));
    const want = xyToXYZ(lightXY(target, tint * 0.02));
    // How the wanted light's white looks in the photo as it's balanced (for the as-shot light): adapt that to white.
    const cone = (xyz) => M.vec(BRADFORD, xyz);
    const s = cone(shot), w = cone(want), d = cone(D65);
    const seen = [0, 1, 2].map((i) => (w[i] / s[i]) * d[i]);
    const scale = [[d[0] / seen[0], 0, 0], [0, d[1] / seen[1], 0], [0, 0, d[2] / seen[2]]];
    const adapt = M.mul(BRADFORD_INV, M.mul(scale, BRADFORD));
    const m = M.mul(XYZ_TO_R2020, M.mul(adapt, R2020_TO_XYZ));
    // Keep the exposure: the adapted gray as bright as before.
    const g = M.vec(m, [1, 1, 1]);
    const k = 1 / (0.2627 * g[0] + 0.678 * g[1] + 0.0593 * g[2]);
    return m.map((r) => r.map((x) => x * k));
  }

  /** Where each of the mixer's colors (red, orange, yellow, green, aqua, blue, purple, magenta) sits on Oklab's hue circle. */
  function mixerHues() {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const hue = ([r, g, b]) => {
      [r, g, b] = [r, g, b].map(lin);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      const h = Math.atan2(bb, a);
      return h < 0 ? h + 2 * Math.PI : h;
    };
    return [[1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [0.5, 0, 1], [1, 0, 1]].map(hue);
  }
  /** Color grading's push for a hue (degrees) and amount (0–1): an Oklab a, b offset. */
  function gradeOf(deg, amount) {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const h = ((((deg % 360) + 360) % 360) / 60), x = 1 - Math.abs((h % 2) - 1);
    const [r, g, b] = (h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x]).map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const len = Math.hypot(a, bb) || 1;
    return [(a / len) * amount * 0.07, (bb / len) * amount * 0.07, amount];
  }

  // ---- the engine ---------------------------------------------------------------------------------------------------
  function create() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    // The screen's gamut where the browser can draw it (Display P3), else sRGB.
    const p3 = 'drawingBufferColorSpace' in gl;
    if (p3) gl.drawingBufferColorSpace = 'display-p3';
    const toScreen = p3
      ? [[1.343578, -0.282180, -0.061399], [-0.065297, 1.075788, -0.010490], [0.002822, -0.019598, 1.016777]]
      : [[1.660491, -0.587641, -0.07285], [-0.12455, 1.1329, -0.008349], [-0.018151, -0.100579, 1.11873]];

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const programs = new Map();
    function program(fs) {
      if (programs.has(fs)) return programs.get(fs);
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Lumen engine: ${gl.getShaderInfoLog(s)}`);
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Lumen engine: ${gl.getProgramInfoLog(p)}`);
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const a = gl.getActiveUniform(p, i);
        u[a.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, a.name);
      }
      const entry = { p, u };
      programs.set(fs, entry);
      return entry;
    }
    function texture(w, h, internal, format, type, data = null, filter = gl.LINEAR) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { t, w, h };
    }
    const target = (w, h, internal = gl.RGBA16F, format = gl.RGBA, type = gl.HALF_FLOAT) => {
      const tex = texture(w, h, internal, format, type);
      tex.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, tex.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.t, 0);
      return tex;
    };
    /** One pass of `fs` into `out` (a target, or the canvas), with its textures and uniforms. */
    function pass(fs, out, textures = {}, set = () => {}) {
      const { p, u } = program(fs);
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
      gl.viewport(0, 0, out ? out.w : canvas.width, out ? out.h : canvas.height);
      let unit = 0;
      for (const [name, tex] of Object.entries(textures)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex.t);
        gl.uniform1i(u[name], unit++);
      }
      set(u);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const free = [];
    const keep = (tex) => (free.push(tex), tex);
    /** `src` blurred by `sigma` (in source pixels), worked at a resolution where that's a few pixels. */
    function blur(src, sigma, internal = gl.RGBA16F, format = gl.RGBA) {
      let cur = src;
      // Halve until the blur is about 3 pixels wide there (each halving: a 2x2 box, with linear filtering).
      while (sigma * (cur.w / src.w) > 6 && cur.w > 32) {
        const half = keep(target(Math.max(1, cur.w >> 1), Math.max(1, cur.h >> 1), internal, format));
        pass(FS_COPY, half, { uTex: cur });
        cur = half;
      }
      const s = Math.max(0.5, sigma * (cur.w / src.w));
      const taps = Math.min(40, Math.ceil(s * 3));
      const a = keep(target(cur.w, cur.h, internal, format)), b = keep(target(cur.w, cur.h, internal, format));
      pass(FS_BLUR, a, { uTex: cur }, (u) => (gl.uniform2f(u.uStep, 1 / cur.w, 0), gl.uniform1f(u.uSigma, s), gl.uniform1i(u.uTaps, taps)));
      pass(FS_BLUR, b, { uTex: a }, (u) => (gl.uniform2f(u.uStep, 0, 1 / cur.h), gl.uniform1f(u.uSigma, s), gl.uniform1i(u.uTaps, taps)));
      return b;
    }

    let photo = null;
    const masks = { a: texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)), b: texture(1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1)), subject: false };
    const MIX_AT = mixerHues();
    /** The look a raw opens with (fitted to Apple's own default rendering of Sony raws): its midtone contrast, placement, color. */
    const PROFILE = { slope: 0.21, ev: 0.75, chroma: 1.4 };

    /** Everything that depends only on the photo: luminance and its blurs, the edge-aware base, the wide views. */
    function analyse(src, meta) {
      for (const t of free.splice(0)) (gl.deleteTexture(t.t), t.fb && gl.deleteFramebuffer(t.fb));
      const { w, h } = src;
      const lumRaw = keep(target(w, h, gl.R16F, gl.RED));
      pass(FS_LOGLUM, lumRaw, { uSrc: src });
      // The edge-aware base (a self-guided filter on log luminance, at a quarter of the size).
      const q = keep(target(Math.max(1, w >> 2), Math.max(1, h >> 2), gl.RG16F, gl.RG));
      pass(FS_GUIDE_IN, q, { uTex: lumRaw });
      const means = blur(q, Math.max(w, h) * 0.012 / 4, gl.RG16F, gl.RG);
      const ab = keep(target(means.w, means.h, gl.RG16F, gl.RG));
      pass(FS_GUIDE_AB, ab, { uTex: means }, (u) => gl.uniform1f(u.uEps, 0.35));
      const abSmooth = blur(ab, means.w * 0.01, gl.RG16F, gl.RG);
      const lum = keep(target(w, h, gl.RG16F, gl.RG));
      pass(FS_GUIDE_BASE, lum, { uAB: abSmooth, uLum: lumRaw });
      const side = Math.max(w, h);
      const micro = blur(lumRaw, Math.max(0.8, side / 3000), gl.R16F, gl.RED);
      const fine = blur(lumRaw, side * 0.0024, gl.R16F, gl.RED);
      const coarse = blur(lumRaw, side * 0.016, gl.R16F, gl.RED);
      const fineRGB = blur(src, side * 0.0024);
      const coarseRGB = blur(src, side * 0.016);
      // The haze's color: the brightest of the wide view (its top half-percent, averaged).
      const px = new Float32Array(coarseRGB.w * coarseRGB.h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, coarseRGB.fb);
      gl.readPixels(0, 0, coarseRGB.w, coarseRGB.h, gl.RGBA, gl.FLOAT, px);
      const ls = [];
      for (let i = 0; i < px.length; i += 4) ls.push([0.2627 * px[i] + 0.678 * px[i + 1] + 0.0593 * px[i + 2], i]);
      ls.sort((a, b) => b[0] - a[0]);
      const top = ls.slice(0, Math.max(1, Math.round(ls.length * 0.005)));
      const air = [0, 1, 2].map((c) => Math.max(0.05, top.reduce((s, [, i]) => s + px[i + c], 0) / top.length));
      return { src, w, h, lum, micro, fine, coarse, fineRGB, coarseRGB, air, meta };
    }

    function size(w, h) {
      if (canvas.width !== w || canvas.height !== h) (canvas.width = w), (canvas.height = h);
    }

    const engine = {
      canvas,
      profile: PROFILE,
      wideGamut: p3,
      get size() {
        return photo ? { w: photo.w, h: photo.h } : null;
      },
      get asShot() {
        return photo?.meta ?? null;
      },
      /** A raw, as Lumen's server developed it: RGBA half floats, scene-linear Rec. 2020. */
      setLinear(half, w, h, meta) {
        // Its rows come top first; the textures here are bottom first.
        const flipped = new Uint16Array(half.length), row = w * 4;
        for (let y = 0; y < h; y++) flipped.set(half.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
        const src = texture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, flipped);
        if (photo) gl.deleteTexture(photo.src.t);
        photo = analyse(src, { temperature: meta.temperature ?? 6500, tint: meta.tint ?? 0, camera: meta.camera ?? '', raw: true });
        size(w, h);
      },
      /** A JPEG (or PNG): taken back to scene light so it opens exactly as it was. */
      setImage(img, maxSide = 3000) {
        const s = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
        const w = Math.round((img.naturalWidth || img.width) * s), h = Math.round((img.naturalHeight || img.height) * s);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cc = c.getContext('2d');
        cc.imageSmoothingQuality = 'high';
        cc.drawImage(img, 0, 0, w, h);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        const img8 = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        const src = target(w, h);
        pass(FS_LINEARIZE, src, { uImg: img8 }, (u) => (gl.uniform1f(u.uWhite, 3.3), gl.uniform1f(u.uSlope, PROFILE.slope)));
        gl.deleteTexture(img8.t);
        if (photo) gl.deleteTexture(photo.src.t);
        photo = analyse(src, { temperature: 6500, tint: 0, camera: '', raw: false });
        size(w, h);
      },
      /** The masks Lumen finds (bytes, the same size as each other): subject, sky, skin, face, eyes. */
      setMasks({ w, h, subject, sky, skin, face, eyes }) {
        const a = new Uint8Array(w * h * 4), b = new Uint8Array(w * h);
        // Bottom row first (the textures are sampled with y up).
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = y * w + x, q = (h - 1 - y) * w + x;
            a[q * 4] = subject ? subject[p] : 0;
            a[q * 4 + 1] = sky[p];
            a[q * 4 + 2] = skin[p];
            a[q * 4 + 3] = face[p];
            b[q] = eyes[p];
          }
        gl.deleteTexture(masks.a.t);
        gl.deleteTexture(masks.b.t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        masks.a = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, a);
        masks.b = texture(w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, b);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        masks.subject = !!subject;
      },
      /** Develops the photo with `v` (Lumen's values) into the canvas, or into `out` (a small target, for reading). */
      render(v, { original = false, out = null } = {}) {
        if (!photo) return;
        const P = photo;
        const n = (k) => Number(v[k] ?? 0) || 0;
        pass(
          FS_DEVELOP,
          out,
          { uSrc: P.src, uLum: P.lum, uMicro: P.micro, uFine: P.fine, uCoarse: P.coarse, uFineRGB: P.fineRGB, uCoarseRGB: P.coarseRGB, uMaskA: masks.a, uMaskB: masks.b },
          (u) => {
            const f = (name, x) => u[name] !== undefined && u[name] !== null && gl.uniform1f(u[name], x);
            gl.uniform2f(u.uSize, P.w, P.h);
            gl.uniformMatrix3fv(u.uWB, false, M.gl(original ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : whiteBalance(P.meta.temperature, P.meta.tint, n('temperature'), n('tint'))));
            gl.uniformMatrix3fv(u.uOut, false, M.gl(toScreen));
            gl.uniform1i(u.uOriginal, original ? 1 : 0);
            gl.uniform1f(u.uWhite, original ? 3.3 : 3.3 * (1 - n('whites') * 0.35));
            gl.uniform1f(u.uSlope, PROFILE.slope);
            gl.uniform1f(u.uBaseEV, P.meta.raw ? PROFILE.ev : 0);
            gl.uniform1f(u.uBaseChroma, P.meta.raw ? PROFILE.chroma : 1);
            const o = original ? () => 0 : n;
            f('uEV', o('exposure'));
            f('uContrast', o('contrast'));
            f('uHighlights', o('highlights'));
            f('uShadows', o('shadows'));
            f('uWhites', o('whites'));
            f('uBlacks', o('blacks'));
            f('uTexture', o('texture'));
            f('uClarity', o('clarity'));
            f('uDehaze', o('dehaze'));
            f('uSharpen', o('sharpen'));
            f('uDenoise', o('denoise'));
            f('uDenoiseColor', o('denoise-color'));
            f('uSmooth', o('smooth'));
            f('uBrighten', o('brighten'));
            f('uEyes', o('eyes'));
            f('uSat', o('saturation'));
            f('uVib', o('vibrance'));
            f('uMono', o('mono'));
            f('uFade', o('fade'));
            f('uGlow', o('glow'));
            f('uVignette', o('vignette'));
            f('uFeather', o('vignette-feather'));
            f('uGrain', o('grain'));
            // Grain's size in the photo's pixels (its slider is in Lumen's 1400-pixel ones).
            f('uGrainSize', Math.max(1, (Number(v['grain-size']) || 1) * (Math.max(P.w, P.h) / 1400)));
            gl.uniform3fv(u.uAir, P.air);
            const HUES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
            const mix = new Float32Array(24);
            HUES.forEach((c, i) => ((mix[i] = o(`mix-h-${c}`)), (mix[8 + i] = o(`mix-s-${c}`)), (mix[16 + i] = o(`mix-l-${c}`))));
            gl.uniform1fv(u.uMix, mix);
            gl.uniform1fv(u.uMixAt, new Float32Array(MIX_AT));
            gl.uniform1i(u.uMixing, mix.some(Boolean) ? 1 : 0);
            const gs = o('grade-shadows-sat'), gm = o('grade-midtones-sat'), gh = o('grade-highlights-sat');
            gl.uniform1i(u.uGrading, gs || gm || gh ? 1 : 0);
            gl.uniform3fv(u.uGradeS, gradeOf(Number(v['grade-shadows-hue']) || 0, gs));
            gl.uniform3fv(u.uGradeM, gradeOf(Number(v['grade-midtones-hue']) || 0, gm));
            gl.uniform3fv(u.uGradeH, gradeOf(Number(v['grade-highlights-hue']) || 0, gh));
            f('uBalance', o('grade-balance') * 0.2);
            const MASKS = ['subject', 'background', 'sky', 'radial', 'linear'], LOCAL = ['exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'saturation', 'clarity'];
            const local = new Float32Array(35), on = new Int32Array(5);
            MASKS.forEach((m, i) => LOCAL.forEach((k, j) => {
              local[i * 7 + j] = o(`m-${m}-${k}`);
              if (local[i * 7 + j]) on[i] = 1;
            }));
            gl.uniform1fv(u.uLocal, local);
            gl.uniform1iv(u.uLocalOn, on);
            gl.uniform1i(u.uHasSubject, masks.subject ? 1 : 0);
            gl.uniform4f(u.uRadial, n('m-radial-x'), n('m-radial-y'), n('m-radial-size'), n('m-radial-feather'));
            gl.uniform1i(u.uRadialInvert, v.radialInvert ? 1 : 0);
            gl.uniform3f(u.uLinear, ['top', 'bottom', 'left', 'right'].indexOf(v.linearFrom ?? 'top'), n('m-linear-position'), n('m-linear-feather'));
            gl.uniform1i(u.uOverlay, original || !v.showMask || v.showMask === 'none' ? -1 : MASKS.indexOf(v.showMask));
            gl.uniform1i(u.uClipping, v.clipping ? 1 : 0);
          },
        );
      },
      /** The photo as `v` develops it, small (its longest side `side`), as RGBA bytes, top row first. */
      read(v, side, opts = {}) {
        if (!photo) return null;
        const s = Math.min(1, side / Math.max(photo.w, photo.h));
        const w = Math.max(1, Math.round(photo.w * s)), h = Math.max(1, Math.round(photo.h * s));
        const t = target(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
        this.render(v, { ...opts, out: t });
        const px = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.t);
        // Top row first.
        const flipped = new Uint8ClampedArray(px.length), row = w * 4;
        for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        return { w, h, data: flipped };
      },
      /** The photo as `v` develops it, small, on a 2D canvas (for finding its masks, and asking Lumen's server). */
      proxy(v, side) {
        const r = this.read(v, side, { original: true });
        const c = document.createElement('canvas');
        c.width = r.w;
        c.height = r.h;
        c.getContext('2d').putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
        return c;
      },
    };
    return engine;
  }

  window.LumenEngine = { create };
})();
