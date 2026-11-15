import { describe, expect, it } from 'vitest';
import { FALLBACK_COLOR, pickAllPortraitColors, pickPortraitColor } from './cut-in-color.js';

/** Build RGBA pixels from [count, [r,g,b], alpha?] runs. */
function pixels(...runs: Array<[number, [number, number, number], number?]>): Uint8ClampedArray {
  const out: number[] = [];
  for (const [count, [r, g, b], a] of runs) {
    for (let i = 0; i < count; i++) out.push(r, g, b, a ?? 255);
  }
  return Uint8ClampedArray.from(out);
}

function hue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('pickPortraitColor', () => {
  it('picks the clearly dominant hue', () => {
    const { hex, fallback } = pickPortraitColor(pixels([400, [30, 90, 200]], [50, [200, 40, 40]]));
    expect(fallback).toBe(false);
    expect(hue(hex)).toBeGreaterThan(205);
    expect(hue(hex)).toBeLessThan(230);
  });

  it('prefers a teal cloak over a larger area of brown skin and hair', () => {
    // 600 brown pixels vs 400 teal pixels: brown is more numerous but is down-weighted.
    const { hex } = pickPortraitColor(pixels([600, [110, 70, 40]], [400, [30, 120, 110]]));
    expect(hue(hex)).toBeGreaterThan(160);
    expect(hue(hex)).toBeLessThan(190);
  });

  it('still returns a warm colour when the portrait is only warm', () => {
    const { hex, fallback } = pickPortraitColor(pixels([500, [230, 120, 30]]));
    expect(fallback).toBe(false);
    expect(hue(hex)).toBeGreaterThan(15);
    expect(hue(hex)).toBeLessThan(40);
  });

  it('ignores transparent pixels', () => {
    const { hex } = pickPortraitColor(
      pixels([2000, [220, 30, 30], 0], [300, [30, 160, 60]], [300, [128, 128, 128]])
    );
    expect(hue(hex)).toBeGreaterThan(110);
    expect(hue(hex)).toBeLessThan(150);
  });

  it('falls back for greyscale portraits', () => {
    const result = pickPortraitColor(pixels([300, [128, 128, 128]], [300, [20, 20, 20]]));
    expect(result.fallback).toBe(true);
    expect(result.hex).toBe(FALLBACK_COLOR);
  });

  it('falls back for an empty or fully transparent image', () => {
    expect(pickPortraitColor(new Uint8ClampedArray()).fallback).toBe(true);
    expect(pickPortraitColor(pixels([100, [200, 30, 30], 0])).hex).toBe(FALLBACK_COLOR);
  });

  it('keeps the colour vivid enough for white text', () => {
    // A very dark navy and a very pale pink both get pulled into the mid-tone range.
    for (const rgb of [
      [10, 20, 60],
      [250, 200, 220],
    ] as Array<[number, number, number]>) {
      const { hex } = pickPortraitColor(pixels([400, rgb]));
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
      expect(lightness).toBeGreaterThan(0.38);
      expect(lightness).toBeLessThan(0.58);
    }
  });
});

describe('pickPortraitColor styles', () => {
  const dullOrange = (): Uint8ClampedArray => pixels([500, [150, 100, 55]]);

  function hsl(hex: string): { s: number; l: number } {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    return { s, l };
  }

  it('prominent is the default: saturated and bright, so it pops', () => {
    const def = pickPortraitColor(dullOrange());
    expect(def.hex).toBe(pickPortraitColor(dullOrange(), 'prominent').hex);
    const { s, l } = hsl(def.hex);
    expect(s).toBeGreaterThan(0.78);
    expect(l).toBeGreaterThanOrEqual(0.47);
    expect(l).toBeLessThanOrEqual(0.57);
  });

  it('natural keeps colours calmer than prominent', () => {
    const prominent = hsl(pickPortraitColor(dullOrange(), 'prominent').hex);
    const natural = hsl(pickPortraitColor(dullOrange(), 'natural').hex);
    expect(natural.s).toBeLessThan(prominent.s);
    expect(natural.s).toBeGreaterThanOrEqual(0.54);
  });

  it('prominent and natural share a hue', () => {
    expect(hue(pickPortraitColor(dullOrange(), 'prominent').hex)).toBeCloseTo(
      hue(pickPortraitColor(dullOrange(), 'natural').hex),
      -1
    );
  });

  it('brightens a dark portrait colour enough to stand out', () => {
    const { l } = hsl(pickPortraitColor(pixels([400, [120, 20, 30]])).hex);
    expect(l).toBeGreaterThanOrEqual(0.47);
  });

  describe('highlight', () => {
    // A big area of dull blue-grey with a small, bright orange accent (a gem, a glow).
    const accented = (): Uint8ClampedArray =>
      pixels([700, [70, 85, 140]], [45, [255, 140, 10]], [100, [20, 20, 20]]);

    it('picks the bright accent where prominent picks the large area', () => {
      const prominent = hue(pickPortraitColor(accented(), 'prominent').hex);
      const highlight = hue(pickPortraitColor(accented(), 'highlight').hex);
      expect(prominent).toBeGreaterThan(200);
      expect(prominent).toBeLessThan(240);
      expect(highlight).toBeGreaterThan(20);
      expect(highlight).toBeLessThan(45);
    });

    it('is vivid', () => {
      const { s, l } = hsl(pickPortraitColor(accented(), 'highlight').hex);
      expect(s).toBeGreaterThan(0.8);
      expect(l).toBeGreaterThan(0.47);
      expect(l).toBeLessThan(0.57);
    });

    it('averages hue across the red wrap-around', () => {
      // 350 and 10 degrees are both red; the average must not land on cyan.
      const h = hue(
        pickPortraitColor(
          pixels([40, [230, 20, 55]], [40, [230, 55, 20]], [600, [60, 60, 70]]),
          'highlight'
        ).hex
      );
      expect(h < 30 || h > 330).toBe(true);
    });

    it('falls back for greyscale and for nearly empty images', () => {
      expect(pickPortraitColor(pixels([300, [128, 128, 128]]), 'highlight').fallback).toBe(true);
      expect(pickPortraitColor(new Uint8ClampedArray(), 'highlight').hex).toBe(FALLBACK_COLOR);
    });
  });

  it('pickAllPortraitColors returns every style', () => {
    const all = pickAllPortraitColors(pixels([400, [30, 90, 200]]));
    expect(Object.keys(all).sort()).toEqual(['highlight', 'natural', 'prominent']);
    expect(all.prominent.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});
