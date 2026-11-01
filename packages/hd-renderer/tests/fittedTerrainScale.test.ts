import type { DataTexture } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCliffField, buildShoreField, SHORE_MAX, SHORE_MIN } from '../src/ra2/shoreField';

/**
 * A map too wide for a 2x terrain composite is fitted at a fractional scale (ra2-assets terrainScale.ts: a multiple
 * of 1/256, each side rounded up). The water fields measure in engine pixels through `scale`, so the same shoreline
 * gives the same distances in cells at either scale.
 */
const FITTED = 451 / 256;
const ENGINE_PIXELS_PER_CELL = 60 / Math.SQRT2;
const textures: DataTexture[] = [];
afterEach(() => {
  for (const texture of textures.splice(0)) texture.dispose();
});

function cells(field: ReturnType<typeof buildShoreField>, x: number, y: number): number {
  const values = field.texture.image.data as Uint8Array;
  return SHORE_MIN + (values[y * field.width + x]! / 255) * (SHORE_MAX - SHORE_MIN);
}

/** Water left of engine x = 200 over a `size` x `size / 2` engine px area, drawn at `scale` with the size rounded up. */
function shoreMask(scale: number, size = 480) {
  const width = Math.ceil(size * scale);
  const height = Math.ceil((size / 2) * scale);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[y * width + x] = (x + 0.5) / scale < 200 ? 255 : 0;
  return { data, width, height };
}

describe('water fields of a fitted terrain composite', () => {
  it('gives the same shore distance in cells at scale 1 and at a fractional scale', () => {
    const step = 4;
    const one = shoreMask(1);
    const fitted = shoreMask(FITTED);
    expect(fitted.width).toBe(846);
    const a = buildShoreField(one.data, one.width, one.height, 1, step);
    const b = buildShoreField(fitted.data, fitted.width, fitted.height, FITTED, step);
    textures.push(a.texture, b.texture);
    for (let engineX = 90; engineX <= 390; engineX += 15) {
      const ta = Math.floor(engineX / step);
      const tb = Math.floor((engineX * FITTED) / step);
      // Each field answers for its texel centre; allow for where the centres sit, one texel and one 8-bit step.
      const centreA = (ta + 0.5) * step;
      const centreB = ((tb + 0.5) * step) / FITTED;
      const tolerance = (Math.abs(centreA - centreB) + step) / ENGINE_PIXELS_PER_CELL + (SHORE_MAX - SHORE_MIN) / 255;
      expect(Math.abs(cells(a, ta, 20) - cells(b, tb, 20))).toBeLessThanOrEqual(tolerance);
    }
    // Water two cells out at 1x is still two cells out when fitted, not 2 * 1.76.
    const twoCellsIn = Math.round(200 - 2 * ENGINE_PIXELS_PER_CELL);
    expect(cells(b, Math.floor((twoCellsIn * FITTED) / step), 20)).toBeCloseTo(2, 0);
  });

  it('builds a cliff field at a fractional scale', () => {
    const fitted = shoreMask(FITTED, 240);
    const ignore = new Uint8Array(fitted.data.length);
    for (let i = 0; i < ignore.length; i++) if (i % fitted.width > fitted.width / 2) ignore[i] = 255;
    const field = buildCliffField(fitted.data, ignore, fitted.width, fitted.height, FITTED, 4);
    textures.push(field.texture);
    expect(field.texture.image.width).toBe(Math.ceil(fitted.width / 4));
    expect(field.data.some((value) => value > 0)).toBe(true);
  });
});
