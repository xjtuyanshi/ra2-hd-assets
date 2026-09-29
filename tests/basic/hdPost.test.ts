/** HD renderer display transform (packages/hd-renderer/src/post.ts): the curve's CPU twin. */
import { describe, expect, it } from 'vitest';
import { FAITHFUL_KNEE, faithfulCurve, faithfulToneMapRgb } from '../../packages/hd-renderer/src/post';

describe('faithful display transform', () => {
  it('is the identity up to the knee', () => {
    for (let i = 0; i <= 800; i++) {
      const m = (i / 800) * FAITHFUL_KNEE;
      expect(Math.abs(faithfulCurve(m) - m)).toBeLessThan(1e-6);
    }
    const rgb: [number, number, number] = [0.8, 0.31, 0.02];
    expect(faithfulToneMapRgb(rgb)).toEqual(rgb);
  });

  it('is continuous with slope 1 at the knee, strictly increasing and bounded by 1 above it', () => {
    const e = 1e-6;
    expect(Math.abs(faithfulCurve(FAITHFUL_KNEE + e) - (FAITHFUL_KNEE + e))).toBeLessThan(1e-9);
    let previous = faithfulCurve(0);
    for (let i = 1; i <= 4000; i++) {
      const m = i * 0.005;
      const y = faithfulCurve(m);
      // Strictly increasing over any realistic HDR range; far above it doubles saturate towards 1.
      if (m <= 6) expect(y).toBeGreaterThan(previous);
      else expect(y).toBeGreaterThanOrEqual(previous);
      expect(y).toBeLessThanOrEqual(1);
      previous = y;
    }
    expect(faithfulCurve(6)).toBeLessThan(1);
    // White at the noon reference keeps most of its level (sRGB 255 -> about 247).
    expect(faithfulCurve(1)).toBeCloseTo(0.9264, 3);
  });

  it('preserves hue and saturation: all channels scale by the same factor', () => {
    const colours: [number, number, number][] = [
      [3.2, 1.1, 0.2], // orange fire core, far above the knee
      [1.25, 0.9, 0.4],
      [0.95, 0.05, 0.9],
      [2, 2, 2],
    ];
    for (const c of colours) {
      const out = faithfulToneMapRgb(c);
      const k = out[0] / c[0];
      expect(out[1] / c[1]).toBeCloseTo(k, 9);
      expect(out[2] / c[2]).toBeCloseTo(k, 9);
      expect(Math.max(...out)).toBeLessThan(1);
    }
  });
});
