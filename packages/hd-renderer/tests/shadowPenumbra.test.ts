import { describe, expect, it } from 'vitest';
import { SHADOW_PENUMBRA_TEXELS, shadowPenumbraCoverage, shadowPenumbraRadius } from '../src/ra2/sprites';

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
