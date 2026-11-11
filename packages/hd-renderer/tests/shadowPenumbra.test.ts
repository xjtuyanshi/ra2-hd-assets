import { describe, expect, it } from 'vitest';
import {
  SHADOW_PENUMBRA_TEXELS,
  SHADOW_QUAD_PAD_TEXELS,
  shadowPenumbraCoverage,
  shadowPenumbraRadius,
  shadowQuadPad,
} from '../src/ra2/sprites';

describe('enhanced shadow penumbra', () => {
  it("grows from a building's walls, not from its foundation centre", () => {
    // A 4 x 4 yard whose foundation starts at the draw point; the cinematic softness at 16.5 h (1 x stretch 1.62).
    const yard = { centre: [2, 2] as const, half: [2, 2] as const };
    const softness = 1.62;
    // Right by the north-east and south-east walls: crisp. Measured from the centre (over two cells away) these
    // points took the largest blur.
    expect(shadowPenumbraRadius([2, -0.05], softness, yard)).toBeLessThan(0.2);
    expect(shadowPenumbraRadius([4.05, 1], softness, yard)).toBeLessThan(0.2);
    expect(Math.min(SHADOW_PENUMBRA_TEXELS, softness * 2.05 * 2.2)).toBe(SHADOW_PENUMBRA_TEXELS);
    // Half a cell out it softens, and the radius never exceeds the cap.
    expect(shadowPenumbraRadius([2, -0.5], softness, yard)).toBeCloseTo(softness * 0.5 * 2.2, 12);
    expect(shadowPenumbraRadius([2, -3], softness, yard)).toBe(SHADOW_PENUMBRA_TEXELS);
    // Without a foundation the base is the draw point, as before.
    expect(shadowPenumbraRadius([0.3, 0.4], 1)).toBeCloseTo(0.5 * 2.2, 12);
  });

  it('softens a straight edge into an even ramp instead of stair-stepped bands', () => {
    // Solid shadow left of x = 20 (texels 0..19), empty to the right.
    const occupied = (kx: number) => (kx < 20 ? 1 : 0);
    // The filtered coverage across that edge (quadratic B-spline over the texel centres, as frameCoverage).
    const spline = (u: number) => {
      const d = Math.abs(u);
      return d < 0.5 ? 0.75 - d * d : d < 1.5 ? 0.5 * (1.5 - d) ** 2 : 0;
    };
    const bspline = (x: number) => {
      let sum = 0;
      for (let k = Math.floor(x) - 2; k <= Math.floor(x) + 2; k++) sum += occupied(k) * spline(x - k - 0.5);
      return sum;
    };
    const samples: number[] = [];
    for (let x = 15; x <= 25; x += 0.05) samples.push(shadowPenumbraCoverage(occupied, [x, 7.3], bspline(x), 3));
    // Monotonic from solid to empty, with no jump: nearest-texel taps changed by a whole tap (1/8) at once.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]! + 1e-12);
      expect(samples[i - 1]! - samples[i]!).toBeLessThan(0.03);
    }
    expect(samples[0]).toBeCloseTo(1, 12);
    expect(samples[samples.length - 1]).toBeCloseTo(0, 12);
    // A solid interior stays solid; a small radius keeps the filtered coverage alone.
    expect(shadowPenumbraCoverage(occupied, [10, 4], 1, 3)).toBe(1);
    expect(shadowPenumbraCoverage(occupied, [19.6, 4], 0.4, 0.2)).toBe(0.4);
  });
});

describe('enhanced shadow quad margin', () => {
  // The filtered coverage (quadratic B-spline over the texel centres, as frameCoverage) of a 1-D mask.
  const spline = (u: number) => {
    const d = Math.abs(u);
    return d < 0.5 ? 0.75 - d * d : d < 1.5 ? 0.5 * (1.5 - d) ** 2 : 0;
  };

  it('draws the whole softened shadow of art that fills its trimmed frame', () => {
    // A trimmed shadow frame: the art fills texels 0..11 of a 12-texel-wide rect and touches its right edge (x = 12).
    const width = 12;
    const occupied = (kx: number) => (kx >= 0 && kx < width ? 1 : 0);
    const bspline = (x: number) => {
      let sum = 0;
      for (let k = Math.floor(x) - 2; k <= Math.floor(x) + 2; k++) sum += occupied(k) * spline(x - k - 0.5);
      return sum;
    };
    // Far from the object's base the penumbra takes its widest radius; past the right edge the shadow fades out.
    const at = (x: number) => shadowPenumbraCoverage(occupied, [x, 3.5], bspline(x), SHADOW_PENUMBRA_TEXELS);
    let reach = width;
    for (let x = width; x < width + 10; x += 0.01) if (at(x) > 1e-9) reach = x;
    // The soft edge reaches well past the rect: the old quad (the rect itself) cut it off at x = 12 with a straight
    // line at about half the shadow's strength, the arrowheads seen on XMP27T8.
    expect(at(width)).toBeGreaterThan(0.2);
    expect(reach).toBeGreaterThan(width + SHADOW_PENUMBRA_TEXELS);
    // The widened quad holds all of it.
    expect(reach).toBeLessThanOrEqual(width + SHADOW_QUAD_PAD_TEXELS);
    expect(at(width + SHADOW_QUAD_PAD_TEXELS)).toBe(0);
  });

  it('widens only softened SHP shadows of the enhanced look', () => {
    const shadow = { shadow: true };
    expect(shadowQuadPad(shadow, true)).toBe(SHADOW_QUAD_PAD_TEXELS);
    // The faithful look keeps every quad exactly on its frame rect.
    expect(shadowQuadPad(shadow, false)).toBe(0);
    // Infantry footprints, upright cards, contact shades and wet reflections keep their quads.
    expect(shadowQuadPad({ shadow: true, infantryShadow: true }, true)).toBe(0);
    expect(shadowQuadPad({ shadow: false }, true)).toBe(0);
    expect(shadowQuadPad({ shadow: false, kind: 'contact' }, true)).toBe(0);
    expect(shadowQuadPad({ shadow: false, kind: 'reflection' }, true)).toBe(0);
  });
});
