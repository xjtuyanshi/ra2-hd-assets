/** Palette remap, art file naming, frame selection and atlas packing. */
import { describe, expect, it } from 'vitest';
import {
  animStillFrame,
  artFileCandidates,
  buildingConditionFrame,
  facingFrame,
  parseFoundation,
  parseIniFraction,
  parseSequenceEntry,
  resolveArtFile,
  splitShadowHalf,
} from '../src/art.ts';
import { packShelves } from '../src/atlas.ts';
import { REMAP_START, applyRemap, hsvToRgb, isRemapIndex, parseHsv, remapRamp } from '../src/remap.ts';

describe('house remap', () => {
  // A palette whose remap range is a red ramp from 252 down to 12 and whose other entries are grey.
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i, i, i], i * 3);
  for (let i = 0; i < 16; i++) pal.set([252 - i * 16, 0, 0], (REMAP_START + i) * 3);

  it('parses rules [Colors] HSV triples', () => {
    expect(parseHsv('43,239,255')).toEqual([43, 239, 255]);
    expect(parseHsv(' 0, 0 ,131 ')).toEqual([0, 0, 131]);
    expect(parseHsv('bad')).toBeUndefined();
  });

  it('converts HSV (0..255 hue) to RGB', () => {
    expect(hsvToRgb([0, 255, 255])).toEqual([255, 0, 0]);
    expect(hsvToRgb([0, 0, 131])).toEqual([131, 131, 131]);
    const [r, g, b] = hsvToRgb([85, 255, 255]); // ~120 degrees
    expect(g).toBe(255);
    expect(r).toBeLessThan(10);
    expect(b).toBe(0);
  });

  it('builds a 16-shade ramp that keeps the palette brightness profile', () => {
    const ramp = remapRamp(pal, [153, 214, 212]); // DarkBlue
    expect(ramp).toHaveLength(16);
    const bright = ramp.map((c) => Math.max(...c));
    for (let i = 1; i < 16; i++) expect(bright[i]).toBeLessThanOrEqual(bright[i - 1]!);
    expect(bright[0]).toBe(212);
    // Blue dominates every shade.
    for (const [r, g, b] of ramp.slice(0, 12)) expect(b).toBeGreaterThan(Math.max(r, g));
  });

  it('applies the ramp to indices 16..31 only', () => {
    const ramp = remapRamp(pal, [43, 239, 255]);
    const out = applyRemap(pal, ramp);
    for (let i = 0; i < 256; i++) {
      const same = out[i * 3] === pal[i * 3] && out[i * 3 + 1] === pal[i * 3 + 1] && out[i * 3 + 2] === pal[i * 3 + 2];
      if (isRemapIndex(i)) expect(Array.from(out.subarray(i * 3, i * 3 + 3))).toEqual(ramp[i - REMAP_START]);
      else expect(same).toBe(true);
    }
    expect(isRemapIndex(15)).toBe(false);
    expect(isRemapIndex(31)).toBe(true);
    expect(isRemapIndex(32)).toBe(false);
  });
});

describe('art file names', () => {
  const opts = { theater: false, newTheater: true, theaterExt: 'tem', theaterLetter: 'T' };

  it('applies NewTheater substitution with the generic G fallback', () => {
    expect(artFileCandidates('GAPOWR', opts)).toEqual(['gtpowr.shp', 'ggpowr.shp', 'gapowr.shp']);
    expect(artFileCandidates('CABHUT', opts)).toEqual(['ctbhut.shp', 'cgbhut.shp', 'cabhut.shp']);
    expect(artFileCandidates('NAPOWR', { ...opts, theaterLetter: 'A' })[0]).toBe('napowr.shp');
  });

  it('leaves names outside the NewTheater prefix scheme alone', () => {
    expect(artFileCandidates('TSTLAMP', opts)).toEqual(['tstlamp.shp']);
    expect(artFileCandidates('GAPOWR', { ...opts, newTheater: false })).toEqual(['gapowr.shp']);
    // G is a prefix letter but not a theater letter in the engine's list.
    expect(artFileCandidates('GGCNST', opts)).toEqual(['ggcnst.shp']);
  });

  it('uses the theater extension for Theater=yes art', () => {
    expect(artFileCandidates('TREE05', { ...opts, theater: true })).toEqual(['tree05.tem', 'tree05.shp']);
  });

  it('resolves the first existing candidate', () => {
    const have = new Set(['ggpowr.shp']);
    expect(resolveArtFile(artFileCandidates('GAPOWR', opts), (n) => have.has(n))).toBe('ggpowr.shp');
    expect(resolveArtFile(['x.shp'], () => false)).toBeUndefined();
  });

  it('parses foundations', () => {
    expect(parseFoundation('4x3')).toEqual([4, 3]);
    expect(parseFoundation('Custom')).toEqual([1, 1]);
    expect(parseFoundation(undefined)).toEqual([1, 1]);
  });
});

describe('frames', () => {
  it('maps clockwise engine facings to counter-clockwise SHP frames, frame 0 facing screen up', () => {
    // Map north (facing 0) points to screen up-right: one eighth of a turn clockwise from frame 0.
    expect(facingFrame(0, 8)).toBe(7);
    expect(facingFrame(32, 8)).toBe(6);
    expect(facingFrame(64, 8)).toBe(5);
    expect(facingFrame(128, 8)).toBe(3);
    expect(facingFrame(192, 8)).toBe(1);
    expect(facingFrame(224, 8)).toBe(0);
    expect(facingFrame(0, 32)).toBe(28);
    expect(facingFrame(255, 32)).toBe(28);
    expect(facingFrame(-32, 8)).toBe(0);
  });

  it('parses INI fractions written as percentages', () => {
    expect(parseIniFraction('50%', 0.5)).toBe(0.5);
    expect(parseIniFraction(' 25% ', 0)).toBe(0.25);
    expect(parseIniFraction('0.5', 0)).toBe(0.5);
    expect(parseIniFraction('', 0.5)).toBe(0.5);
    expect(parseIniFraction('abc', 0.4)).toBe(0.4);
  });

  it('uses the damaged building frame only at or below ConditionYellow', () => {
    const yellow = parseIniFraction('50%', 0.5);
    expect(buildingConditionFrame(256, yellow, 3)).toBe(0);
    expect(buildingConditionFrame(129, yellow, 3)).toBe(0);
    expect(buildingConditionFrame(128, yellow, 3)).toBe(1);
    expect(buildingConditionFrame(10, yellow, 3)).toBe(1);
    expect(buildingConditionFrame(10, yellow, 1)).toBe(0);
  });

  it('picks the middle of an anim loop as its still frame', () => {
    expect(animStillFrame({ loopStart: 0, loopEnd: 30 }, 31)).toBe(15);
    expect(animStillFrame({ start: 0, loopStart: 0, loopEnd: 8 }, 9)).toBe(4);
    expect(animStillFrame({}, 10)).toBe(4);
    expect(animStillFrame({ loopStart: 3, loopEnd: 99 }, 8)).toBe(5);
    expect(animStillFrame({}, 0)).toBe(0);
  });

  it('parses artmd sequence entries', () => {
    expect(parseSequenceEntry('86,1,6')).toEqual({ start: 86, count: 1, facingMultiplier: 6 });
    expect(parseSequenceEntry('0')).toEqual({ start: 0, count: 1, facingMultiplier: 0 });
    expect(parseSequenceEntry('')).toBeUndefined();
  });

  it('splits body and shadow halves only when the second half is shadow-only', () => {
    const f = (...v: number[]) => ({ pixels: Uint8Array.from(v) });
    expect(splitShadowHalf([f(5, 9), f(7), f(1, 0), f(0, 1)])).toEqual({ body: 2, hasShadows: true });
    expect(splitShadowHalf([f(5, 9), f(7), f(1, 3), f(0)])).toEqual({ body: 4, hasShadows: false });
    expect(splitShadowHalf([f(5), f(7), f(9)])).toEqual({ body: 3, hasShadows: false });
    expect(splitShadowHalf([f(0), f(0)])).toEqual({ body: 2, hasShadows: false });
  });
});

describe('atlas packing', () => {
  it('packs without overlaps inside the atlas, keeping a gutter', () => {
    const sizes = Array.from({ length: 200 }, (_, i) => ({ w: 5 + ((i * 37) % 90), h: 3 + ((i * 53) % 70) }));
    const pack = packShelves(sizes, 1);
    pack.rects.forEach((r, i) => {
      expect(r.w).toBe(sizes[i]!.w);
      expect(r.x).toBeGreaterThanOrEqual(1);
      expect(r.y).toBeGreaterThanOrEqual(1);
      expect(r.x + r.w).toBeLessThanOrEqual(pack.width - 1);
      expect(r.y + r.h).toBeLessThanOrEqual(pack.height - 1);
    });
    for (let a = 0; a < pack.rects.length; a++) {
      for (let b = a + 1; b < pack.rects.length; b++) {
        const p = pack.rects[a]!;
        const q = pack.rects[b]!;
        const apart = p.x + p.w + 1 <= q.x || q.x + q.w + 1 <= p.x || p.y + p.h + 1 <= q.y || q.y + q.h + 1 <= p.y;
        expect(apart).toBe(true);
      }
    }
  });
});
