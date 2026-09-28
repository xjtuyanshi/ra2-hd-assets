import { describe, expect, it } from 'vitest';
import type { TileEntry } from '../src/manifest.ts';
import { buildWaterMaskBytes } from '../src/waterMask.ts';

const tile = (file: string, terrainType = 0): TileEntry => ({
  file,
  terrainType,
  subTile: 0,
  height: 0,
  rampType: 0,
  rect: [0, 0, 1, 1],
  anchor: [0, 0],
});
const blue = [20, 50, 100, 255];
const sand = [170, 145, 90, 255];
const transparent = [0, 0, 0, 0];

function classify(pixel: number[], entry: TileEntry, index = 0): number {
  return buildWaterMaskBytes(Uint8Array.from(pixel), 1, 1, Int32Array.of(index), [entry])[0]!;
}

describe('buildWaterMaskBytes classification', () => {
  it('treats land type 9 as water independently of colour or template family', () => {
    expect(classify(sand, tile('clear01.tem', 9))).toBe(255);
  });

  it.each(['water', 'shore', 'w-a-', 'w-b-', 'wbrdge', 'wtr', 'bank', 'WaTeR'])(
    'classifies blue pixels in the %s family',
    (family) => {
      expect(classify(blue, tile(`${family}01.tem`))).toBe(255);
    },
  );

  it('excludes sandy and bright pixels in water templates', () => {
    expect(classify(sand, tile('shore01.tem'))).toBe(0);
    expect(classify([20, 50, 192, 255], tile('water01.tem'))).toBe(0);
    expect(classify([0, 0, 0, 255], tile('water01.tem'))).toBe(0);
  });

  it('retains fractional colour scores', () => {
    const pixel = [50, 60, 66, 255];
    const blueness = (66 - 60 * 0.9) / 255;
    const saturation = (66 - 50) / 66;
    const expected = Math.round(((blueness - 0.02) / 0.08) * ((saturation - 0.12) / 0.15) * 255);
    expect(classify(pixel, tile('water01.tem'))).toBe(expected);
  });

  it('uses the attributed tile rather than the pixel colour alone', () => {
    const tiles = [tile('clear01.tem'), tile('water01.tem')];
    for (const [index, expected] of [
      [0, 0],
      [1, 255],
      [-1, 0],
      [2, 0],
    ]) {
      expect(buildWaterMaskBytes(Uint8Array.from(blue), 1, 1, Int32Array.of(index!), tiles)[0]).toBe(expected);
    }
  });

  it('includes alpha 128 but excludes alpha 127', () => {
    expect(classify([20, 50, 100, 128], tile('water01.tem'))).toBe(255);
    expect(classify([20, 50, 100, 127], tile('water01.tem'))).toBe(0);
  });
});

describe('buildWaterMaskBytes smoothing', () => {
  it('runs two 3x3 box passes on opaque pixels', () => {
    const result = buildWaterMaskBytes(Uint8Array.from([...blue, ...sand, ...sand]), 3, 1, Int32Array.of(0, 0, 0), [
      tile('shore01.tem'),
    ]);
    expect([...result]).toEqual([106, 71, 43]);
  });

  it('averages only opaque neighbours, including diagonals', () => {
    const result = buildWaterMaskBytes(
      Uint8Array.from([...blue, ...sand, ...transparent, ...sand]),
      2,
      2,
      Int32Array.of(0, 0, -1, 0),
      [tile('shore01.tem')],
    );
    expect([...result]).toEqual([85, 85, 85, 85]);
  });

  it('does not blur through a transparent gap before bleeding', () => {
    const result = buildWaterMaskBytes(
      Uint8Array.from([...blue, ...transparent, ...sand]),
      3,
      1,
      Int32Array.of(0, -1, 0),
      [tile('shore01.tem')],
    );
    expect([...result]).toEqual([255, 128, 0]);
  });

  it('bleeds exactly three synchronous steps and treats zero-valued donors as filled', () => {
    const result = buildWaterMaskBytes(
      Uint8Array.from([...blue, ...Array.from({ length: 5 }, () => transparent).flat(), ...sand]),
      7,
      1,
      Int32Array.of(0, -1, -1, -1, -1, -1, 0),
      [tile('shore01.tem')],
    );
    expect([...result]).toEqual([255, 255, 255, 128, 0, 0, 0]);
  });

  it('bleeds through four neighbours, stopping after Manhattan distance three', () => {
    const rgba = new Uint8Array(5 * 5 * 4);
    rgba.set(blue, (2 * 5 + 2) * 4);
    const tileAt = new Int32Array(25).fill(-1);
    tileAt[12] = 0;
    const result = buildWaterMaskBytes(rgba, 5, 5, tileAt, [tile('water01.tem')]);
    expect([...result]).toEqual([
      0, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255,
      0,
    ]);
  });

  it('leaves an entirely transparent image empty without mutating either input', () => {
    const rgba = Uint8Array.from([...transparent, ...transparent]);
    const tileAt = Int32Array.of(0, -1);
    const beforeRgba = rgba.slice();
    const beforeTileAt = tileAt.slice();
    expect([...buildWaterMaskBytes(rgba, 2, 1, tileAt, [tile('water01.tem')])]).toEqual([0, 0]);
    expect(rgba).toEqual(beforeRgba);
    expect(tileAt).toEqual(beforeTileAt);
  });

  it('rejects inconsistent dimensions and attribution', () => {
    expect(() => buildWaterMaskBytes(new Uint8Array(0), 0, 1, new Int32Array(0), [])).toThrow(
      'invalid water mask size',
    );
    expect(() => buildWaterMaskBytes(new Uint8Array(4), 1, 1, new Int32Array(0), [])).toThrow(
      'must match the image size',
    );
  });
});
