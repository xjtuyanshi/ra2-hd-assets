import { describe, expect, it } from 'vitest';
import {
  PAL_FILE_SIZE,
  PALETTE_ENTRY_COUNT,
  Palette,
  REMAP_INDEX_END,
  REMAP_INDEX_START,
} from './palFile.js';

/** Build a synthetic 768-byte PAL from 256 [r,g,b] 6-bit triplets. */
function buildPal(triplets: Array<[number, number, number]>): Uint8Array {
  const bytes = new Uint8Array(PAL_FILE_SIZE);
  for (let i = 0; i < triplets.length; i++) {
    const [r, g, b] = triplets[i]!;
    bytes[i * 3] = r;
    bytes[i * 3 + 1] = g;
    bytes[i * 3 + 2] = b;
  }
  return bytes;
}

describe('Palette.parse', () => {
  it('scales 6-bit VGA channels to 8-bit via XCC (c*255/63)', () => {
    const triplets: Array<[number, number, number]> = [];
    triplets.push([0, 0, 0]); // black
    triplets.push([63, 63, 63]); // max 6-bit -> 255
    triplets.push([32, 16, 1]); // 129, 64, 4 (integer-truncated)
    for (let i = triplets.length; i < PALETTE_ENTRY_COUNT; i++) {
      triplets.push([0, 0, 0]);
    }
    const pal = Palette.parse(buildPal(triplets));

    expect(pal.length).toBe(256);
    expect(pal.color(0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(pal.color(1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(pal.color(2)).toEqual({ r: 129, g: 64, b: 4 });
  });

  it('masks stray high bits to 6 bits before scaling', () => {
    // 0xff has bits above the 6-bit VGA range; must mask to 0x3f (63) -> 255.
    const bytes = new Uint8Array(PAL_FILE_SIZE).fill(0xff);
    const pal = Palette.parse(bytes);
    expect(pal.color(0)).toEqual({ r: 255, g: 255, b: 255 });
    expect(pal.color(255)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('rejects buffers that are not exactly 768 bytes', () => {
    expect(() => Palette.parse(new Uint8Array(767))).toThrow(/768/);
    expect(() => Palette.parse(new Uint8Array(769))).toThrow(/768/);
    expect(() => Palette.parse(new Uint8Array(0))).toThrow(/768/);
  });
});

describe('Palette.rgba', () => {
  it('appends an opaque alpha by default and honors an explicit alpha', () => {
    const triplets: Array<[number, number, number]> = new Array(256).fill([
      0, 0, 0,
    ]);
    triplets[5] = [10, 20, 30];
    const pal = Palette.parse(buildPal(triplets));
    // (c*255/63) truncated: 10->40, 20->80, 30->121.
    expect(pal.rgba(5)).toEqual([40, 80, 121, 255]);
    expect(pal.rgba(5, 0)).toEqual([40, 80, 121, 0]);
    expect(pal.rgba(5, 0x1ff)).toEqual([40, 80, 121, 0xff]);
  });

  it('throws for out-of-range indices', () => {
    const pal = Palette.parse(new Uint8Array(PAL_FILE_SIZE));
    expect(() => pal.color(-1)).toThrow(RangeError);
    expect(() => pal.color(256)).toThrow(RangeError);
    expect(() => pal.color(1.5)).toThrow(RangeError);
  });
});

describe('Palette.rgb view', () => {
  it('exposes a 768-byte packed view matching color()', () => {
    const triplets: Array<[number, number, number]> = new Array(256).fill([
      1, 2, 3,
    ]);
    triplets[100] = [63, 0, 32];
    const pal = Palette.parse(buildPal(triplets));
    const view = pal.rgb;
    expect(view.length).toBe(PAL_FILE_SIZE);
    // 63->255, 0->0, 32->129 (integer-truncated (c*255/63)).
    expect([view[300], view[301], view[302]]).toEqual([255, 0, 129]);
    const c = pal.color(100);
    expect([c.r, c.g, c.b]).toEqual([255, 0, 129]);
  });
});

describe('remap index constants', () => {
  it('documents the 16..31 player-remap range', () => {
    expect(REMAP_INDEX_START).toBe(16);
    expect(REMAP_INDEX_END).toBe(31);
  });
});
