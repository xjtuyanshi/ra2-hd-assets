import { describe, expect, it } from 'vitest';
import { compareTileSweep, mergeTileRaster, tileDepthBase, type TileRasterSource } from '../src/tileRaster.ts';

/** A 4x2 "tile box" keeps the fixtures readable; the merge takes the tile size as a parameter. */
const W = 4;
const H = 2;

function source(over: Partial<TileRasterSource> = {}): TileRasterSource {
  return {
    x: 0,
    y: 0,
    hasZData: true,
    // Row 0: . 1 1 .   Row 1: 1 1 1 1
    bitmap: Uint8Array.from([0, 1, 1, 0, 1, 1, 1, 1]),
    zBitmap: Uint8Array.from([0, 20, 20, 0, 10, 10, 10, 10]),
    ...over,
  };
}

describe('mergeTileRaster', () => {
  it('keeps the diamond and its z bytes when the tile has no extra graphics', () => {
    const r = mergeTileRaster(source(), W, H);
    expect([r.width, r.height, r.anchor, r.depthTested]).toEqual([4, 2, [2, 0], true]);
    expect(Array.from(r.index)).toEqual([0, 1, 1, 0, 1, 1, 1, 1]);
    expect(Array.from(r.depth)).toEqual([0, 20, 20, 0, 10, 10, 10, 10]);
  });

  it('lets an extra pixel replace its own diamond only when it is not farther, as the engine draws it', () => {
    // Extra: 2 px wide, 3 rows, starting one row above the diamond box at its second column.
    const r = mergeTileRaster(
      source({
        extra: {
          x: 1,
          y: -1,
          width: 2,
          height: 3,
          bitmap: Uint8Array.from([7, 7, 7, 7, 7, 0]),
          // Row 0 (above the diamond): free. Row 1 over z 20: 20 passes (equal), 21 fails. Row 2 over z 10: 9 passes.
          zData: Uint8Array.from([29, 29, 20, 21, 9, 0]),
        },
      }),
      W,
      H,
    );
    expect([r.width, r.height, r.anchor]).toEqual([4, 3, [2, 1]]);
    expect(Array.from(r.index)).toEqual([0, 7, 7, 0, /**/ 0, 7, 1, 0, /**/ 1, 7, 1, 1]);
    expect(Array.from(r.depth)).toEqual([0, 29, 29, 0, /**/ 0, 20, 20, 0, /**/ 10, 9, 10, 10]);
  });

  it('paints every extra pixel over the diamond and stores no depth for a tile without z-data', () => {
    const r = mergeTileRaster(
      source({
        hasZData: false,
        extra: { x: 0, y: 0, width: 2, height: 1, bitmap: Uint8Array.from([0, 9]), zData: Uint8Array.from([0, 250]) },
      }),
      W,
      H,
    );
    expect(r.depthTested).toBe(false);
    expect(Array.from(r.index)).toEqual([0, 9, 1, 0, 1, 1, 1, 1]);
    expect(Array.from(r.depth)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('treats a missing z raster as depth 0 so the pixel is never hidden by its own tile', () => {
    const r = mergeTileRaster(
      source({ extra: { x: 0, y: 0, width: 2, height: 1, bitmap: Uint8Array.from([0, 9]) } }),
      W,
      H,
    );
    expect(Array.from(r.index)).toEqual([0, 9, 1, 0, 1, 1, 1, 1]);
    expect(Array.from(r.depth)).toEqual([0, 0, 20, 0, 10, 10, 10, 10]);
  });
});

describe('tile depth order', () => {
  it('moves the baseline 15 nearer per ground row and ignores which cell of the row it is', () => {
    expect(tileDepthBase(3, 4) - tileDepthBase(3, 5)).toBe(15);
    expect(tileDepthBase(5, 2)).toBe(tileDepthBase(2, 5));
    // A flat diamond stores 29 - row, so depth is continuous across the shared edge of two ground rows.
    expect(tileDepthBase(1, 1) + (29 - 15)).toBe(tileDepthBase(1, 2) + 29);
  });

  it('sweeps rows of constant x + y from the top down and left to right inside a row', () => {
    const cells = [
      { x: 2, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 1, y: 0 },
      { x: 0, y: 3 },
      { x: 0, y: 1 },
    ];
    expect(cells.sort(compareTileSweep).map((c) => `${c.x},${c.y}`)).toEqual([
      '0,0',
      '0,1',
      '1,0',
      '0,3',
      '1,2',
      '2,1',
    ]);
  });
});
