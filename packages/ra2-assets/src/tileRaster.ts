/**
 * One TMP tile as a single raster with the engine's per-pixel depth (pure).
 *
 * The engine does not paint terrain back to front. Its tile rasterizer (YR 1.001 `0x547CF0`, see
 * docs/remaster/research/painter-order.md) depth-tests every pixel of the 60x30 diamond and of the extra graphics
 * (cliff faces, bank art) against the software Z-buffer:
 *
 *   candidate = zByte + baseline,   baseline = K - (ground screen y of the cell's top corner) - 30
 *   write colour and depth when candidate <= existing            (smaller is nearer; equal passes)
 *
 * The cell's height level cancels out of the baseline, so the depth of a tile pixel relative to any other tile pixel
 * is `zByte - 15 * (x + y)` ({@link tileDepthBase}). A flat diamond stores 29 - row; cliff faces store 15..29 however
 * far above the cell they reach, which is what lets ground in front of a cliff cover the face's lower part.
 * A tile whose TMP header has no z-data flag is drawn unconditionally and writes no depth.
 *
 * This module merges a tile's diamond and extra graphics by that same rule and keeps the winning z byte per pixel, so
 * a compositor can resolve whole maps exactly like the engine without the game files.
 */
import { CELL_H, CELL_W, mergeTileExtra } from './iso.ts';

export interface TileRasterSource {
  /** Screen offset of the diamond box inside its template block (TMP image header x/y). */
  x: number;
  y: number;
  /** TMP z-data flag. False: the engine neither tests nor writes depth for this tile. */
  hasZData: boolean;
  /** Dense tileW x tileH palette indices of the diamond, 0 outside it. */
  bitmap: Uint8Array;
  /** Dense tileW x tileH z bytes of the diamond (the packed scanlines expanded like `bitmap`). */
  zBitmap?: Uint8Array;
  extra?: {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Row-major palette indices, 0 = transparent. */
    bitmap: Uint8Array;
    /** Row-major z bytes, same layout as `bitmap`. */
    zData?: Uint8Array;
  };
}

export interface TileRaster {
  width: number;
  height: number;
  /** Pixel inside the raster where the cell's top corner sits (see tileAnchor). */
  anchor: [number, number];
  /** Palette index per pixel, 0 = transparent. */
  index: Uint8Array;
  /** Engine z byte of every opaque pixel (0 where transparent, and everywhere when `depthTested` is false). */
  depth: Uint8Array;
  /** False when the TMP tile carries no z-data. */
  depthTested: boolean;
}

/**
 * Merge the diamond with the extra graphics in the engine's order: diamond first, then every non-zero extra pixel
 * that passes `extraZ <= diamondZ` (or lands where the diamond drew nothing). Without z-data the extra always wins.
 */
export function mergeTileRaster(src: TileRasterSource, tileW = CELL_W, tileH = CELL_H): TileRaster {
  const place = mergeTileExtra(src, src.extra, tileW, tileH);
  const index = new Uint8Array(place.width * place.height);
  const depth = new Uint8Array(place.width * place.height);
  const tested = src.hasZData;
  for (let py = 0; py < tileH; py++) {
    for (let px = 0; px < tileW; px++) {
      const v = src.bitmap[py * tileW + px]!;
      if (!v) continue;
      const d = (py + place.diamond[1]) * place.width + px + place.diamond[0];
      index[d] = v;
      if (tested) depth[d] = src.zBitmap?.[py * tileW + px] ?? 0;
    }
  }
  const e = src.extra;
  if (e && e.width > 0 && e.height > 0) {
    for (let py = 0; py < e.height; py++) {
      for (let px = 0; px < e.width; px++) {
        const v = e.bitmap[py * e.width + px]!;
        if (!v) continue;
        const d = (py + place.extra[1]) * place.width + px + place.extra[0];
        const z = tested ? (e.zData?.[py * e.width + px] ?? 0) : 0;
        if (tested && index[d] && z > depth[d]!) continue;
        index[d] = v;
        depth[d] = z;
      }
    }
  }
  return {
    width: place.width,
    height: place.height,
    // tileAnchor for this tile size: the top corner is the middle of the diamond box's top edge.
    anchor: [place.diamond[0] + tileW / 2, place.diamond[1]],
    index,
    depth,
    depthTested: tested,
  };
}

/**
 * Depth baseline of cell (x, y), to which a pixel's z byte is added. Only differences matter: a pixel of one cell
 * covers a pixel of another at the same screen position when its `tileDepthBase + zByte` is smaller, or equal and
 * drawn later.
 */
export function tileDepthBase(x: number, y: number): number {
  return -(x + y) * (CELL_H / 2);
}

/**
 * The engine's terrain sweep order (`0x6D7560` / `0x6D71E0`): rows of constant x + y from the top of the screen
 * down, and x ascending (left to right) inside a row. Height does not take part.
 */
export function compareTileSweep(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x + a.y - (b.x + b.y) || a.x - b.x;
}
