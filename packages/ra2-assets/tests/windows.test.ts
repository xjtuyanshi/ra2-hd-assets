import { describe, expect, it } from 'vitest';
import {
  detectBuildingWindows,
  detectWindows,
  roofBottom,
  seededRandom,
  windowColumns,
  windowStats,
} from '../src/windows.ts';

/** Luminance per palette index: index i has luminance i (so 30 is dark, 180 is wall). */
const LUM = Float32Array.from({ length: 256 }, (_, i) => i);
const WALL = 180;
const DARK = 30;
const all = () => 0;

/** A w x h frame filled with wall (index 180), with a transparent border of `border` pixels. */
function facade(w: number, h: number, border = 0): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) px[y * w + x] = WALL;
  return px;
}

function paint(px: Uint8Array, w: number, x0: number, y0: number, ww: number, hh: number, index = DARK): void {
  for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) px[y * w + x] = index;
}

const litPixels = (mask: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < mask.length; i += 2) if (mask[i]) n++;
  return n;
};

/** 2x4 windows on three floors in two columns, framed by wall. */
function windowGrid(index = DARK): { px: Uint8Array; w: number; h: number } {
  const w = 32;
  const h = 32;
  const px = facade(w, h);
  for (const x of [9, 19]) for (const y of [6, 14, 22]) paint(px, w, x, y, 2, 4, index);
  return { px, w, h };
}

describe('detectWindows', () => {
  it('finds framed 2x4 windows on a facade', () => {
    const { px, w, h } = windowGrid();
    const mask = detectWindows(px, w, h, LUM, all);
    expect(litPixels(mask)).toBe(6 * 8);
    expect(mask[(6 * w + 9) * 2]).toBe(255);
    expect(mask[(5 * w + 9) * 2]).toBe(0);
  });

  it('rejects a large dark roof patch', () => {
    const w = 32;
    const px = facade(w, w);
    paint(px, w, 10, 10, 10, 10);
    expect(litPixels(detectWindows(px, w, w, LUM, all))).toBe(0);
  });

  it('rejects windows touching the sprite edge', () => {
    const w = 32;
    const px = facade(w, w);
    for (const y of [6, 14, 22]) paint(px, w, 0, y, 2, 4);
    expect(litPixels(detectWindows(px, w, w, LUM, all))).toBe(0);
  });

  it('rejects an isolated dark speck without neighbouring windows', () => {
    const w = 32;
    const px = facade(w, w);
    paint(px, w, 14, 14, 2, 4);
    expect(litPixels(detectWindows(px, w, w, LUM, all))).toBe(0);
  });

  it('detects glass indices even when they are not darker than the wall', () => {
    const lum = Float32Array.from(LUM);
    lum[92] = 108;
    const { px, w, h } = windowGrid(92);
    expect(litPixels(detectWindows(px, w, h, lum, all))).toBe(6 * 8);
  });

  it('lights a hollow pane outline as a filled pane', () => {
    const w = 40;
    const h = 40;
    const px = facade(w, h);
    // 4x6 dark outlines with a lighter (highlight) interior, three floors in two columns.
    for (const x of [10, 22])
      for (const y of [6, 16, 26]) {
        paint(px, w, x, y, 4, 6);
        paint(px, w, x + 1, y + 1, 2, 4, 120);
      }
    const mask = detectWindows(px, w, h, LUM, all);
    expect(litPixels(mask)).toBe(6 * 24);
    // The highlight inside the outline is lit too.
    expect(mask[((6 + 2) * w + 11) * 2]).toBe(255);
  });

  it('rejects L-shaped fragments that straddle a mullion', () => {
    const w = 40;
    const h = 40;
    const px = facade(w, h);
    for (const x of [10, 22])
      for (const y of [6, 16, 26]) {
        // An L: a 1-pixel column and a foot, filling half of its 4x6 box.
        paint(px, w, x, y, 1, 6);
        paint(px, w, x, y + 5, 4, 1);
      }
    expect(litPixels(detectWindows(px, w, h, LUM, all))).toBe(0);
  });

  it('skips frames drawn with indices >= 240', () => {
    const { px, w, h } = windowGrid();
    px[0] = 250;
    expect(litPixels(detectWindows(px, w, h, LUM, all))).toBe(0);
  });

  it('is deterministic for a seed and lights a subset', () => {
    const { px, w, h } = windowGrid();
    const a = detectWindows(px, w, h, LUM, seededRandom(42));
    const b = detectWindows(px, w, h, LUM, seededRandom(42));
    expect(a).toEqual(b);
    expect(litPixels(a) % 8).toBe(0);
    // Each window shares one variant.
    const variant = a[(6 * w + 9) * 2 + 1];
    if (a[(6 * w + 9) * 2]) expect(a[(9 * w + 10) * 2 + 1]).toBe(variant);
  });
});

describe('detectBuildingWindows', () => {
  /** A 60 x 80 block on a 1x1 foundation: two roof fans (stacked) above the roof line, four 14 x 10 panes below. */
  function block(): { px: Uint8Array; w: number; h: number } {
    const w = 60;
    const h = 80;
    const px = facade(w, h);
    for (const y of [4, 16]) paint(px, w, 23, y, 14, 8);
    for (const x of [8, 36]) for (const y of [42, 58]) paint(px, w, x, y, 14, 10);
    return { px, w, h };
  }

  it('falls back to the large-pane profile when the pane detector finds nothing', () => {
    const { px, w, h } = block();
    expect(litPixels(detectWindows(px, w, h, LUM, all))).toBe(0);
    const result = detectBuildingWindows(px, w, h, LUM, all, { roof: roofBottom(px, w, h, [1, 1]) });
    expect(result.mode).toBe('large');
    expect(litPixels(result.mask)).toBe(4 * 140);
    // The roof fans stay dark.
    expect(result.mask[(6 * w + 30) * 2]).toBe(0);
    expect(result.mask[(45 * w + 12) * 2]).toBe(255);
  });

  it('keeps roof candidates without a roof band, and the pane detector where it covers the facade', () => {
    const { px, w, h } = block();
    expect(litPixels(detectBuildingWindows(px, w, h, LUM, all).mask)).toBe(4 * 140 + 2 * 112);
    const grid = windowGrid();
    expect(detectBuildingWindows(grid.px, grid.w, grid.h, LUM, all).mode).toBe('panes');
    // A forced mode is kept (damaged frames follow their healthy frame).
    expect(detectBuildingWindows(px, w, h, LUM, all, { mode: 'panes' }).mode).toBe('panes');
  });

  it('puts the roof bottom at the silhouette top plus the roof diamond depth', () => {
    const { px, w, h } = block();
    const roof = roofBottom(px, w, h, [1, 1]);
    // Width 59, 1x1 foundation: depth min(x, 59 - x, 29.5) below the top row.
    expect(roof[0]).toBe(0);
    expect(roof[10]).toBe(10);
    expect(roof[30]).toBe(29);
    expect(roof[59]).toBe(0);
    // A 2x1 foundation flattens the roof's deepest part to width x 1/3.
    expect(roofBottom(px, w, h, [2, 1])[30]).toBe(20);
  });
});

describe('windowColumns', () => {
  it('groups lit panes into columns with their count and lowest pixel', () => {
    const { px, w, h } = windowGrid();
    const mask = detectWindows(px, w, h, LUM, all);
    // Panes at x 9-10 and 19-20, three floors each, the lowest ending at y 25.
    expect(windowColumns(mask, w, [0, 0, w, h])).toEqual([
      [9.5, 3, 25],
      [19.5, 3, 25],
    ]);
  });
});

describe('windowStats', () => {
  it('counts lit pixels and their centroid', () => {
    const { px, w, h } = windowGrid();
    const mask = detectWindows(px, w, h, LUM, all);
    const stats = windowStats(mask, w, [0, 0, w, h]);
    expect(stats.lit).toBe(48);
    expect(stats.centroid[0]).toBeCloseTo(14.5, 6);
    expect(stats.centroid[1]).toBeCloseTo(15.5, 6);
  });
});
