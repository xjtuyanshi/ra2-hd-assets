import { describe, expect, it } from 'vitest';
import { localLightHeadroomRgb } from '../src/atmosphere';
import { softLightWeight } from '../src/lightField';

describe('world-space soft light pool', () => {
  it('is isotropic, monotonic and zero at/beyond the radius with a smooth centre and edge', () => {
    const radius = 2.6;
    let previous = 1;
    for (let i = 0; i <= 100; i++) {
      const d = (i * radius) / 100;
      const w = softLightWeight(d, 0, radius);
      expect(w).toBeCloseTo(softLightWeight(d / Math.SQRT2, d / Math.SQRT2, radius), 12);
      expect(w).toBeLessThanOrEqual(previous);
      previous = w;
    }
    expect(softLightWeight(0, 0, radius)).toBe(1);
    expect(softLightWeight(radius, 0, radius)).toBe(0);
    expect(softLightWeight(radius * 2, 0, radius)).toBe(0);
    expect((1 - softLightWeight(1e-4, 0, radius)) / 1e-4).toBeLessThan(1e-3);
    expect(softLightWeight(radius - 1e-4, 0, radius) / 1e-4).toBeLessThan(1e-3);
  });
});
describe('summed local-light headroom', () => {
  it('cannot lift lamp-lit sandstone above white', () => {
    const base = [1, 0.71, 0.54] as const;
    const added = localLightHeadroomRgb(base, [0.05, 0.14, 0.85]);
    expect(added).toEqual([0, 0, 0]);
    expect(Math.max(...base.map((v, i) => v + added[i]!))).toBe(1);
  });
  it('scales the entire added term equally, preserving hue after multiple sources sum', () => {
    const base = [0.8, 0.6, 0.4] as const;
    const pool = [0.15, 0.42, 2.55] as const;
    const added = localLightHeadroomRgb(base, pool);
    expect(Math.max(...base.map((v, i) => v + added[i]!))).toBeLessThanOrEqual(1);
    expect(added[0] / added[2]).toBeCloseTo(pool[0] / pool[2]);
    expect(added[1] / added[2]).toBeCloseTo(pool[1] / pool[2]);
  });
  it('leaves a blue pool and fire/explosion light within dark-ground headroom untouched', () => {
    for (const added of [
      [0.05, 0.14, 0.85],
      [0.9, 0.4, 0.1],
      [0.2, 0.5, 0.8],
    ] as const)
      expect(localLightHeadroomRgb([0.05, 0.05, 0.06], added)).toEqual(added);
    expect(localLightHeadroomRgb([0, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
  });
});
