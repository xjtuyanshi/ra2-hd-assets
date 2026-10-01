import { DataUtils, HalfFloatType, LinearFilter, RedFormat, type DataTexture } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCliffField, buildShoreField, CLIFF_FIELD_MAX } from '../src/ra2/shoreField';

const textures: DataTexture[] = [];
// Half-float spacing just below 1 is 1/2048; allow that quantisation after decoding back to cells.
const CELL_EPSILON = CLIFF_FIELD_MAX / 2048 + 1e-7;
function build(...args: Parameters<typeof buildCliffField>) {
  const field = buildCliffField(...args);
  textures.push(field.texture);
  return field;
}

afterEach(() => {
  for (const texture of textures.splice(0)) texture.dispose();
});

function unit(field: ReturnType<typeof buildCliffField>, x: number, y: number): number {
  return DataUtils.fromHalfFloat(field.data[y * field.texture.image.width + x]!);
}

describe('cliff contact distance field', () => {
  it.each([
    { scale: 1, downsample: 1 },
    { scale: 2, downsample: 2 },
    { scale: 8 / 3, downsample: 2 },
    { scale: 1, downsample: 4 },
  ])(
    'measures cells from a vertical wall and clamps at 1.5 (scale=$scale, step=$downsample)',
    ({ scale, downsample }) => {
      const width = Math.ceil((80 * scale) / downsample) * downsample;
      const height = 3 * downsample;
      const wall = 2;
      const mask = new Uint8Array(width * height);
      const ignore = new Uint8Array(mask.length);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          if (x >= (wall + 1) * downsample) mask[y * width + x] = 255;
          if (Math.floor(x / downsample) === wall) ignore[y * width + x] = 128;
        }
      const originalMask = mask.slice();
      const originalIgnore = ignore.slice();
      const field = build(mask, ignore, width, height, scale, downsample);
      expect(CLIFF_FIELD_MAX).toBe(1.5);
      expect(unit(field, wall, 1)).toBe(0);
      let previous = 0;
      for (let x = wall + 1; x < field.texture.image.width; x++) {
        const cells = ((x - wall) * downsample * Math.SQRT2) / (scale * 60);
        const actual = unit(field, x, 1) * CLIFF_FIELD_MAX;
        expect(Math.abs(actual - Math.min(1.5, cells))).toBeLessThanOrEqual(CELL_EPSILON);
        expect(actual).toBeGreaterThanOrEqual(previous);
        previous = actual;
      }
      expect(previous).toBe(1.5);
      expect(mask).toEqual(originalMask);
      expect(ignore).toEqual(originalIgnore);
    },
  );

  it('matches a nearest-wall oracle in world cells, including vertical and diagonal distances', () => {
    const width = 13;
    const height = 11;
    const scale = 0.25;
    const mask = new Uint8Array(width * height).fill(255);
    const ignore = new Uint8Array(mask.length);
    const walls = [
      [2, 2],
      [10, 8],
    ] as const;
    for (const [x, y] of walls) ignore[y * width + x] = 255;
    const field = build(mask, ignore, width, height, scale, 1);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const expected = Math.min(
          1.5,
          ...walls.map(([wx, wy]) => {
            // Invert the engine's screen projection (30 * (x - z), 15 * (x + z)).
            const dx = (x - wx) / scale;
            const dy = (y - wy) / scale;
            return Math.hypot((dx + 2 * dy) / 60, (2 * dy - dx) / 60);
          }),
        );
        expect(Math.abs(unit(field, x, y) * 1.5 - expected)).toBeLessThanOrEqual(CELL_EPSILON);
      }
    expect(unit(field, 2, 3)).toBeCloseTo(unit(field, 3, 2) * 2, 3);
    // Ignore targets survive even when the water mask also marks them as water.
    expect(unit(field, 2, 2)).toBe(0);
  });

  it.each([
    { pixels: [128, 128, 0, 0], marked: true },
    { pixels: [255, 0, 0, 0], marked: false },
    { pixels: [127, 127, 127, 127], marked: false },
  ])('shares the shore field majority threshold and partial edge blocks: $pixels', ({ pixels, marked }) => {
    const width = 5;
    const height = 3;
    const mask = new Uint8Array(width * height).fill(255);
    const ignore = new Uint8Array(mask.length);
    [0, 1, 5, 6].forEach((index, i) => (ignore[index] = pixels[i]!));
    ignore[4] = 128;
    ignore[10] = 128;
    ignore[14] = 128;
    const field = build(mask, ignore, width, height, 1, 2);
    expect(unit(field, 0, 0) === 0).toBe(marked);
    expect(unit(field, 2, 0)).toBe(0);
    expect(unit(field, 0, 1)).toBe(0);
    expect(unit(field, 2, 1)).toBe(0);
  });

  it.each([0, 255])('keeps a uniform ignore mask finite and normalised (value=%s)', (value) => {
    const mask = new Uint8Array(35).fill(255);
    const field = build(mask, new Uint8Array(mask.length).fill(value), 7, 5, 2, 2);
    expect(Array.from(field.data, DataUtils.fromHalfFloat)).toEqual(new Array(12).fill(value ? 0 : 1));
  });

  it('uses the precise shore texture format, resolution, orientation and linear filtering without mipmaps', () => {
    const mask = new Uint8Array(35).fill(255);
    const ignore = new Uint8Array(mask.length);
    const field = build(mask, ignore, 7, 5, 2, 2);
    const shore = buildShoreField(mask, 7, 5, 2, 2, true, ignore);
    textures.push(shore.texture);
    expect(field.texture.image.data).toBe(field.data);
    expect(field.data).toBeInstanceOf(Uint16Array);
    expect([field.texture.image.width, field.texture.image.height]).toEqual([shore.width, shore.height]);
    expect(field.texture.type).toBe(HalfFloatType);
    expect(field.texture.type).toBe(shore.texture.type);
    expect(field.texture.format).toBe(RedFormat);
    expect(field.texture.minFilter).toBe(LinearFilter);
    expect(field.texture.magFilter).toBe(LinearFilter);
    expect(field.texture.generateMipmaps).toBe(false);
    expect(field.texture.flipY).toBe(shore.texture.flipY);
    expect(field.texture.version).toBe(1);
  });
});
