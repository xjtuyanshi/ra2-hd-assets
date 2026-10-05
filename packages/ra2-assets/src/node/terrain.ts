/** Shared terrain layout and tile resolution for the preview, the unlit terrain map and the light previews. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CELL_H, projectCorner } from '../iso.ts';
import type { HdCacheManifest } from '../manifest.ts';
import { compareTileSweep, tileDepthBase } from '../tileRaster.ts';
import { decodePng, type PngImage } from './png.ts';

export interface CellDraw {
  x: number;
  y: number;
  z: number;
  t: number;
  sx: number;
  sy: number;
}

export interface TerrainLayout {
  cells: CellDraw[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function terrainLayout(m: HdCacheManifest): TerrainLayout {
  const exists = Buffer.from(m.cells.exists, 'base64');
  const heights = Buffer.from(m.cells.height, 'base64');
  const tileBytes = Buffer.from(m.cells.tile, 'base64');
  const cells: CellDraw[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < exists.length; i++) {
    if (!exists[i]) continue;
    const t = tileBytes.readUInt16LE(i * 2);
    if (t === 0xffff) continue;
    const x = i % m.grid.width;
    const y = Math.floor(i / m.grid.width);
    const z = heights[i]!;
    const tile = m.tiles[t]!;
    const c = projectCorner(x, y, z);
    const sx = c.sx - tile.anchor[0];
    const sy = c.sy - tile.anchor[1];
    cells.push({ x, y, z, t, sx, sy });
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx + tile.rect[2]);
    maxY = Math.max(maxY, sy + tile.rect[3]);
  }
  if (!cells.length) throw new Error('Cannot render terrain: the cache has no terrain cells');
  cells.sort((a, b) => a.x + a.y - (b.x + b.y) || a.z - b.z || a.x - b.x);
  return { cells, minX, minY, maxX, maxY };
}

/**
 * TMP scanlines: rows 0..14 are 4, 8, .., 60 px wide; rows 15..29 are 56, 52, .., 0 px wide,
 * centred on the anchor column. The legacy painter draws everything outside in its later extra-graphics pass.
 */
export function insideDiamond(px: number, py: number, anchor: readonly [number, number]): boolean {
  const dy = py - anchor[1];
  if (dy < 0 || dy >= CELL_H) return false;
  const half = dy < CELL_H / 2 ? 2 * (dy + 1) : 2 * (CELL_H - 1 - dy);
  const dx = px - anchor[0];
  return dx >= -half && dx < half;
}

/** The cache's tile-depth atlas, or undefined for a cache extracted before it existed. */
export function loadTerrainDepth(cacheDir: string, m: HdCacheManifest): PngImage | undefined {
  const file = m.terrainAtlas.depth;
  if (!file) return undefined;
  const depth = decodePng(readFileSync(join(cacheDir, file)));
  if (depth.channels !== 1 || depth.width !== m.terrainAtlas.width || depth.height !== m.terrainAtlas.height)
    throw new Error(`Terrain depth atlas ${file} must be single-channel and the size of the terrain atlas`);
  return depth;
}

export interface TerrainResolve {
  /** Engine screen coordinates of pixel (0, 0); the frame covers every tile raster of the layout. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Per pixel: index into the layout's `cells` of the cell whose tile is visible there; -1 where nothing drew. */
  cell: Int32Array;
  /** Per pixel: pixel index into the terrain atlas of the visible texel (meaningful where `cell` >= 0). */
  texel: Int32Array;
}

/**
 * Decide which tile pixel is visible at every screen pixel.
 *
 * With the cache's depth atlas this is the engine's own rule (tileRaster.ts): cells in sweep order, each opaque tile
 * pixel written when its depth is not farther than what is already there, tiles without z-data written
 * unconditionally. Without it (caches extracted before the atlas existed) the legacy painter runs instead: all
 * diamonds by cell depth, then everything outside the diamonds on top. That approximation lets a cliff face cover
 * ground in front of it, so such caches should be given their depth atlas (terrain-depth CLI) and recomposited.
 */
export function resolveTerrain(
  m: HdCacheManifest,
  terrain: PngImage,
  layout: TerrainLayout,
  depth?: PngImage,
): TerrainResolve {
  if (terrain.channels !== 4) throw new Error('Terrain atlas must be an RGBA PNG');
  const originX = Math.floor(layout.minX);
  const originY = Math.floor(layout.minY);
  const width = Math.ceil(layout.maxX) - originX;
  const height = Math.ceil(layout.maxY) - originY;
  const cell = new Int32Array(width * height).fill(-1);
  const texel = new Int32Array(width * height);
  const { cells } = layout;
  if (depth) {
    const order = cells.map((_, i) => i).sort((a, b) => compareTileSweep(cells[a]!, cells[b]!));
    const nearest = new Int32Array(width * height).fill(0x7fffffff);
    for (const k of order) {
      const c = cells[k]!;
      const tile = m.tiles[c.t]!;
      const [rx, ry, rw, rh] = tile.rect;
      const base = tileDepthBase(c.x, c.y);
      const x0 = Math.round(c.sx) - originX;
      const y0 = Math.round(c.sy) - originY;
      for (let py = 0; py < rh; py++) {
        const Y = y0 + py;
        if (Y < 0 || Y >= height) continue;
        for (let px = 0; px < rw; px++) {
          const X = x0 + px;
          if (X < 0 || X >= width) continue;
          const s = (ry + py) * terrain.width + rx + px;
          if (terrain.data[s * 4 + 3] === 0) continue;
          const i = Y * width + X;
          if (!tile.noDepth) {
            const candidate = base + depth.data[s]!;
            if (candidate > nearest[i]!) continue;
            nearest[i] = candidate;
          }
          cell[i] = k;
          texel[i] = s;
        }
      }
    }
    return { originX, originY, width, height, cell, texel };
  }
  for (const pass of [0, 1]) {
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]!;
      const tile = m.tiles[c.t]!;
      const [rx, ry, rw, rh] = tile.rect;
      const x0 = Math.round(c.sx) - originX;
      const y0 = Math.round(c.sy) - originY;
      for (let py = 0; py < rh; py++) {
        const Y = y0 + py;
        if (Y < 0 || Y >= height) continue;
        for (let px = 0; px < rw; px++) {
          const X = x0 + px;
          if (X < 0 || X >= width) continue;
          const s = (ry + py) * terrain.width + rx + px;
          if (terrain.data[s * 4 + 3] === 0) continue;
          if (insideDiamond(px, py, tile.anchor) !== (pass === 0)) continue;
          const i = Y * width + X;
          cell[i] = k;
          texel[i] = s;
        }
      }
    }
  }
  return { originX, originY, width, height, cell, texel };
}

interface TerrainTarget {
  put(x: number, y: number, r: number, g: number, b: number, alpha: number, tile: number): void;
}

/** The target owns alpha semantics: previews stay opaque, while terrain maps retain atlas alpha and attribution. */
export function drawTerrainTiles(
  m: HdCacheManifest,
  terrain: PngImage,
  layout: TerrainLayout,
  target: TerrainTarget,
  lightAt: (z: number) => readonly [number, number, number] = () => [1, 1, 1],
  depth?: PngImage,
): TerrainResolve {
  const resolved = resolveTerrain(m, terrain, layout, depth);
  const { originX, originY, width, height, cell, texel } = resolved;
  const clamp = (v: number): number => (v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = cell[y * width + x]!;
      if (k < 0) continue;
      const c = layout.cells[k]!;
      const s = texel[y * width + x]! * 4;
      const [lr, lg, lb] = lightAt(c.z);
      target.put(
        x + originX,
        y + originY,
        clamp(terrain.data[s]! * lr),
        clamp(terrain.data[s + 1]! * lg),
        clamp(terrain.data[s + 2]! * lb),
        terrain.data[s + 3]!,
        c.t,
      );
    }
  }
  return resolved;
}
