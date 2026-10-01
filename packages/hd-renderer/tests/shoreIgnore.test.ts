import { createHash } from 'node:crypto';
import { DataUtils, type DataTexture } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShoreField, SHORE_MAX, SHORE_MIN } from '../src/ra2/shoreField';

const textures: DataTexture[] = [];
function build(...args: Parameters<typeof buildShoreField>) {
  const field = buildShoreField(...args);
  textures.push(field.texture);
  return field;
}

afterEach(() => {
  for (const texture of textures) texture.dispose();
  textures.length = 0;
});

function cells(field: ReturnType<typeof buildShoreField>, x: number, y: number): number {
  const values = field.texture.image.data as Uint8Array | Uint16Array;
  const value = values[y * field.width + x]!;
  const unit = values instanceof Uint16Array ? DataUtils.fromHalfFloat(value) : value / 255;
  return SHORE_MIN + unit * (SHORE_MAX - SHORE_MIN);
}

function digest(values: Uint8Array | Uint16Array): string {
  return createHash('sha256')
    .update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
    .digest('hex');
}

describe.each([false, true])('shore ignore (precise=%s)', (precise) => {
  it('keeps a normal beach shallow and dry plateau edges out of the shoreline', () => {
    const width = 128;
    const mask = new Uint8Array(width * width);
    const ignore = new Uint8Array(mask.length);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        if (x >= 16 && x < 112 && y >= 16 && y < 112) mask[y * width + x] = 255;
        if (x >= 112 || y < 16 || y >= 112) ignore[y * width + x] = 255;
      }
    const originalMask = mask.slice();
    const originalIgnore = ignore.slice();
    const baseline = build(mask, width, width, 1, 2, precise);
    const field = build(mask, width, width, 1, 2, precise, ignore);

    expect(cells(field, 55, 32)).toBeGreaterThanOrEqual(1);
    expect(cells(field, 55, 32)).toBeCloseTo(((55 - 7) * 2 - (precise ? 1 : 0)) / (60 / Math.SQRT2), 1);
    expect(cells(baseline, 55, 32)).toBeLessThan(0.1);
    expect(cells(field, 8, 32)).toBeGreaterThan(0);
    expect(cells(field, 8, 32)).toBeLessThan(0.1);
    expect(cells(field, 56, 32)).toBe(SHORE_MIN);
    expect(cells(field, 32, 7)).toBe(SHORE_MIN);
    expect(cells(field, 32, 56)).toBe(SHORE_MIN);

    // Every non-ignored land texel keeps its distance to the original water, including the precise texture bytes.
    for (const key of ['data', 'texture'] as const) {
      const values = key === 'data' ? field.data : (field.texture.image.data as Uint8Array | Uint16Array);
      const before = key === 'data' ? baseline.data : (baseline.texture.image.data as Uint8Array | Uint16Array);
      for (let y = 8; y < 56; y++) {
        expect(values.slice(y * field.width, y * field.width + 8)).toEqual(
          before.slice(y * field.width, y * field.width + 8),
        );
      }
    }
    expect(mask).toEqual(originalMask);
    expect(ignore).toEqual(originalIgnore);
  });

  it.each([
    { pixels: [128, 128, 0, 0], ignored: true },
    { pixels: [255, 0, 0, 0], ignored: false },
    { pixels: [127, 127, 127, 127], ignored: false },
    { pixels: [255, 127, 127, 127], ignored: false },
  ])('counts marked pixels at the half-texel threshold: $pixels', ({ pixels, ignored }) => {
    // Two columns of land, two of water, then a partial land column; the last row is also partial.
    const width = 5;
    const height = 3;
    const mask = Uint8Array.from({ length: width * height }, (_, i) => (i % width === 2 || i % width === 3 ? 255 : 0));
    const ignore = new Uint8Array(mask.length);
    [0, 1, 5, 6].forEach((i, j) => (ignore[i] = pixels[j]!));
    ignore[4] = 128; // Half of the two valid pixels at the right edge.
    ignore[10] = 128; // Half of the two valid pixels at the bottom edge.
    ignore[14] = 128; // The single valid pixel in the bottom-right texel.
    const baseline = build(mask, width, height, 1, 2, precise);
    const field = build(mask, width, height, 1, 2, precise, ignore);
    expect(cells(field, 0, 0)).toBe(ignored ? SHORE_MIN : cells(baseline, 0, 0));
    expect(cells(field, 2, 0)).toBe(SHORE_MIN);
    expect(cells(field, 0, 1)).toBe(SHORE_MIN);
    expect(cells(field, 2, 1)).toBe(SHORE_MIN);
  });

  it('clamps water to SHORE_MAX when all land is ignored, even when water is marked too', () => {
    const width = 16;
    const mask = Uint8Array.from({ length: width * 8 }, (_, i) => (i % width < 4 ? 0 : 255));
    const field = build(mask, width, 8, 1, 2, precise, new Uint8Array(mask.length).fill(255));
    for (let y = 0; y < field.height; y++)
      for (let x = 0; x < field.width; x++) {
        expect(cells(field, x, y)).toBe(x < 2 ? SHORE_MIN : SHORE_MAX);
      }
  });

  it('keeps ignored land specks as water after speck filling', () => {
    const mask = new Uint8Array(20 * 20).fill(255);
    const ignore = new Uint8Array(mask.length);
    mask[10 * 20 + 10] = 0;
    ignore[10 * 20 + 10] = 255;
    const field = build(mask, 20, 20, 1, 1, precise, ignore);
    const baseline = build(mask, 20, 20, 1, 1, precise);
    expect(cells(field, 10, 10)).toBe(SHORE_MAX);
    expect(field.data).toEqual(baseline.data);
    expect(field.texture.image.data).toEqual(baseline.texture.image.data);
  });
});

describe('shore field byte compatibility', () => {
  // Captured from the pre-ignore implementation: anisotropic distances, a filled speck, partial texels and clamping.
  it.each([
    {
      precise: false,
      data: 'b99beaa39a9921052ee3c00a86a66f2171e95497ee8c1fc4eabeea84e5fe1ecd',
      texture: 'b99beaa39a9921052ee3c00a86a66f2171e95497ee8c1fc4eabeea84e5fe1ecd',
    },
    {
      precise: true,
      data: 'a0f589737e161ce31ff18cd85cf222e1b1e1555b8e0f945e90f3075a47088e98',
      texture: 'be9ae91355c1579c5f1e67645fc385d83726ee15a1cc3352a2307bce49a41e4d',
    },
  ])('preserves legacy bytes with absent or zero ignore (precise=$precise)', (expected) => {
    const rows = ['.........', '.~~~~~~..', '.~~.~~~..', '.~~~~~~..', '...~~~~..', '..~~~....', '.........'];
    const width = 17;
    const height = 13;
    const mask = Uint8Array.from({ length: width * height }, (_, i) =>
      rows[Math.floor(Math.floor(i / width) / 2)]![Math.floor((i % width) / 2)] === '~' ? 255 : 0,
    );
    for (const ignore of [undefined, new Uint8Array(mask.length)]) {
      const field = build(mask, width, height, 0.05, 2, expected.precise, ignore);
      expect(field.width).toBe(9);
      expect(field.height).toBe(7);
      expect(digest(field.data)).toBe(expected.data);
      expect(digest(field.texture.image.data as Uint8Array | Uint16Array)).toBe(expected.texture);
    }
  });
});
