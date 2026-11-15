/**
 * Picks a theme colour for a Cinematic Cut-ins preset from a character portrait.
 *
 * Pure function over RGBA pixels so it can be tested without a browser; the caller
 * (cut-ins.ts) is responsible for downscaling the image and reading its pixels.
 *
 * Three styles:
 *   - prominent: the colour covering the most area (skin/hair browns are down-weighted),
 *                pushed to a vivid mid-tone so it pops. The default.
 *   - natural:   the same colour, kept calmer and closer to what is in the portrait.
 *   - highlight: the brightest, most vivid accent (glows, gold trim, eyes) even if it
 *                covers little area, pushed vivid. Tends to contrast with the character.
 */

/** Used when a portrait has no usable colour (greyscale, near-empty, unreadable). */
export const FALLBACK_COLOR = '#324453';

export type ColorStyle = 'prominent' | 'natural' | 'highlight';
export const COLOR_STYLES: readonly ColorStyle[] = ['prominent', 'natural', 'highlight'];

const HUE_BINS = 18; // 20 degrees each
const MIN_SHARE = 0.01; // prominent: the winning hue must cover at least 1% of opaque pixels
const HIGHLIGHT_TOP_FRACTION = 0.08; // highlight: look at the most vivid 8% of pixels
const HIGHLIGHT_MIN_PIXELS = 5;

interface Range {
  s: [number, number];
  l: [number, number];
}
const VIVID: Range = { s: [0.8, 0.95], l: [0.48, 0.56] };
const CALM: Range = { s: [0.55, 0.85], l: [0.42, 0.55] };

export interface PortraitColor {
  hex: string;
  /** true when FALLBACK_COLOR was used because no hue was strong enough */
  fallback: boolean;
  /** how much of the portrait the winning colour covers (0..1), a rough confidence */
  share: number;
}

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const fallback = (share: number): PortraitColor => ({
  hex: FALLBACK_COLOR,
  fallback: true,
  share: round3(share),
});

/** Index of the strongest bin, counting half of each neighbour (hue wraps around). */
function strongestBin(weights: number[]): { index: number; score: number } {
  let index = -1;
  let score = 0;
  for (let i = 0; i < weights.length; i++) {
    const a = weights[(i + 1) % weights.length];
    const b = weights[(i + weights.length - 1) % weights.length];
    const s = weights[i] + 0.5 * a + 0.5 * b;
    if (s > score) {
      score = s;
      index = i;
    }
  }
  return { index, score };
}

function pickProminent(rgba: ArrayLike<number>, range: Range): PortraitColor {
  const weight = new Array<number>(HUE_BINS).fill(0);
  const sums = Array.from({ length: HUE_BINS }, () => ({ r: 0, g: 0, b: 0 }));
  let opaque = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue; // transparent background
    opaque++;
    const { h, s, l } = toHsl(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    if (l < 0.06 || l > 0.92 || s < 0.15) continue; // near-black, near-white, grey

    let w = s;
    if (h >= 8 && h < 48 && l < 0.5) w *= 0.3; // skin, hair, leather

    const bin = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
    weight[bin] += w;
    sums[bin].r += rgba[i] * w;
    sums[bin].g += rgba[i + 1] * w;
    sums[bin].b += rgba[i + 2] * w;
  }

  const best = strongestBin(weight);
  const share = opaque > 0 ? best.score / opaque : 0;
  if (best.index < 0 || share < MIN_SHARE) return fallback(share);

  let w = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of [
    best.index,
    (best.index + 1) % HUE_BINS,
    (best.index + HUE_BINS - 1) % HUE_BINS,
  ]) {
    const k = i === best.index ? 1 : 0.5;
    w += weight[i] * k;
    r += sums[i].r * k;
    g += sums[i].g * k;
    b += sums[i].b * k;
  }

  const { h, s, l } = toHsl(r / w / 255, g / w / 255, b / w / 255);
  return {
    hex: hslToHex(h, clamp(s, range.s), clamp(l, range.l)),
    fallback: false,
    share: round3(share),
  };
}

function pickHighlight(rgba: ArrayLike<number>, range: Range): PortraitColor {
  const vivid: Array<{ h: number; score: number }> = [];
  let opaque = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    opaque++;
    const { h, s, l } = toHsl(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    if (l < 0.1 || l > 0.92 || s < 0.3) continue;
    // Strong colour that is also reasonably bright scores highest.
    const chroma = s * (1 - Math.abs(2 * l - 1));
    vivid.push({ h, score: chroma * (0.6 + 0.4 * l) });
  }
  if (vivid.length < HIGHLIGHT_MIN_PIXELS) return fallback(0);

  vivid.sort((a, b) => b.score - a.score);
  const top = vivid.slice(
    0,
    Math.max(HIGHLIGHT_MIN_PIXELS, Math.floor(vivid.length * HIGHLIGHT_TOP_FRACTION))
  );

  const weight = new Array<number>(HUE_BINS).fill(0);
  for (const p of top) weight[Math.floor(p.h / (360 / HUE_BINS)) % HUE_BINS] += p.score;
  const best = strongestBin(weight);
  const near = new Set([
    best.index,
    (best.index + 1) % HUE_BINS,
    (best.index + HUE_BINS - 1) % HUE_BINS,
  ]);
  const chosen = top.filter(p => near.has(Math.floor(p.h / (360 / HUE_BINS)) % HUE_BINS));

  // Average the hue as an angle so 350 and 10 degrees do not average to 180.
  let x = 0;
  let y = 0;
  for (const p of chosen) {
    x += Math.cos((p.h * Math.PI) / 180) * p.score;
    y += Math.sin((p.h * Math.PI) / 180) * p.score;
  }
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  return {
    hex: hslToHex(h, (range.s[0] + range.s[1]) / 2, (range.l[0] + range.l[1]) / 2),
    fallback: false,
    share: round3(opaque > 0 ? chosen.length / opaque : 0),
  };
}

/**
 * @param rgba flat RGBA bytes, as from CanvasRenderingContext2D#getImageData().data
 */
export function pickPortraitColor(
  rgba: ArrayLike<number>,
  style: ColorStyle = 'prominent'
): PortraitColor {
  if (style === 'highlight') return pickHighlight(rgba, VIVID);
  return pickProminent(rgba, style === 'natural' ? CALM : VIVID);
}

/** All three styles for one portrait, so they can be compared side by side. */
export function pickAllPortraitColors(rgba: ArrayLike<number>): Record<ColorStyle, PortraitColor> {
  return {
    prominent: pickPortraitColor(rgba, 'prominent'),
    natural: pickPortraitColor(rgba, 'natural'),
    highlight: pickPortraitColor(rgba, 'highlight'),
  };
}
