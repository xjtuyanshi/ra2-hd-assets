import { Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { EffectsLayer, GarnishOptions } from '../src/effects';
import { LiveEffectsDriver, type LiveEffects } from '../src/live/effects';
import { causticField, fbmField, rippleField } from '../src/proceduralTextures';
import { SPECK_TEXELS, buildShoreField, fillSpecks } from '../src/ra2/shoreField';

/** Mean step between horizontally or vertically adjacent texels, inside the tile and across its wrap edges. */
function steps(field: Float32Array, size: number): { inside: number; seam: number } {
  let inside = 0;
  let seam = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = field[y * size + x]!;
      const dx = Math.abs(field[y * size + ((x + 1) % size)]! - v);
      const dy = Math.abs(field[((y + 1) % size) * size + x]! - v);
      if (x === size - 1) seam += dx;
      else inside += dx;
      if (y === size - 1) seam += dy;
      else inside += dy;
    }
  return { inside: inside / (2 * size * (size - 1)), seam: seam / (2 * size) };
}

describe('procedural water textures', () => {
  it('builds a tileable ripple field with unit RMS slopes and matching analytic slopes', () => {
    const size = 64;
    const field = rippleField(size, 5, 40);
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(field.height)).toBeCloseTo(1, 5);
    expect((rms(field.slopeX) ** 2 + rms(field.slopeY) ** 2) / 2).toBeCloseTo(1, 5);
    // The wrap edges are no rougher than the inside (integer wave numbers repeat exactly).
    for (const channel of [field.height, field.slopeX, field.slopeY]) {
      const { inside, seam } = steps(channel, size);
      expect(seam).toBeLessThan(inside * 1.5);
    }
    // The slope channels are the height's derivatives: central differences correlate strongly with them.
    let dot = 0;
    let norm = 0;
    let normSlope = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const diff =
          (field.height[y * size + ((x + 1) % size)]! - field.height[y * size + ((x - 1 + size) % size)]!) / 2;
        const slope = field.slopeX[y * size + x]!;
        dot += diff * slope;
        norm += diff * diff;
        normSlope += slope * slope;
      }
    expect(dot / Math.sqrt(norm * normSlope)).toBeGreaterThan(0.95);
  });

  it('builds tileable caustics and fbm within 0..1', () => {
    const size = 64;
    const caustic = causticField(size, 3, 4);
    const fbm = fbmField(size, 4, 3, 9);
    for (const field of [caustic, fbm]) {
      expect(Math.min(...field)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...field)).toBeLessThanOrEqual(1);
      const { inside, seam } = steps(field, size);
      expect(seam).toBeLessThan(inside * 1.5);
    }
  });
});

describe('shore field specks', () => {
  it('turns small inland specks into water, keeping larger islands and land at the border', () => {
    const w = 12;
    const h = 10;
    const water = new Uint8Array(w * h).fill(1);
    const land = (x: number, y: number) => (water[y * w + x] = 0);
    land(3, 3);
    land(4, 3); // a two-texel speck
    for (let y = 5; y < 9; y++) for (let x = 6; x < 10; x++) land(x, y); // a 16-texel island
    land(0, 0); // a speck touching the border
    const changed = fillSpecks(water, w, h, 8);
    expect(changed).toBe(2);
    expect(water[3 * w + 3]).toBe(1);
    expect(water[3 * w + 4]).toBe(1);
    expect(water[6 * w + 7]).toBe(0);
    expect(water[0]).toBe(0);
  });

  it('gives no land distance to a speck in open water', () => {
    // Mask at scale 1 and step 1: 255 = water, one 2x2 land speck (4 texels <= SPECK_TEXELS) in the middle.
    const w = 32;
    const h = 32;
    const mask = new Uint8Array(w * h).fill(255);
    for (let y = 15; y < 17; y++) for (let x = 15; x < 17; x++) mask[y * w + x] = 0;
    expect(4).toBeLessThanOrEqual(SPECK_TEXELS);
    const { data } = buildShoreField(mask, w, h, 1, 1);
    // Encoded 0..255 over -3..9 cells: every texel reads as water (above the zero crossing at 255 * 3 / 12).
    for (const v of data) expect(v).toBeGreaterThan(Math.round((255 * 3) / 12));
  });
});

describe('enhanced effect style', () => {
  const explosionAnim = (id: number, type: string): LiveEffects => ({
    anims: [{ id, uid: id, type, x: 256 * 10, y: 256 * 10, z: 0 }],
    bullets: [],
    particleSystems: [],
  });

  it('passes the enhanced options (and the hot crater only for crater-leaving art) to the explosion garnish', () => {
    const explode = vi.fn<(now: number, at: Vector3, scale: number, wind: Vector3, options?: GarnishOptions) => void>();
    const effects = { explode, setBeams: vi.fn() } as unknown as EffectsLayer;
    const driver = new LiveEffectsDriver(effects, () => false);
    driver.push(explosionAnim(1, 'TWLT070'), 1, 0, new Vector3());
    expect(explode.mock.calls[0]![4]).toMatchObject({ enhanced: false, hotCrater: false, smoke: 0, scorch: false });
    driver.style = 'enhanced';
    driver.push(explosionAnim(2, 'TWLT070'), 2, 0.1, new Vector3());
    // TWLT070 is Crater=yes art: the engine leaves its smudge, HD only makes it glow for a moment.
    expect(explode.mock.calls[1]![4]).toMatchObject({ enhanced: true, hotCrater: true, scorch: false });
    driver.push(explosionAnim(3, 'GTPOWEXP'), 3, 0.2, new Vector3());
    expect(explode.mock.calls[2]![4]).toMatchObject({ enhanced: true, hotCrater: false });
  });
});
