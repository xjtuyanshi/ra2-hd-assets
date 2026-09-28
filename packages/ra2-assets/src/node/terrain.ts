/** Shared terrain layout and painter passes for the preview and the unlit terrain map. */
import { CELL_H, projectCorner } from '../iso.ts';
import type { HdCacheManifest } from '../manifest.ts';
import type { PngImage } from './png.ts';

export interface CellDraw {
  x: number;
  y: number;
  z: number;
  t: number;
  sx: number;
  sy: number;
}

export function terrainLayout(m: HdCacheManifest): {
  cells: CellDraw[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
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
 * centred on the anchor column. Everything outside is drawn in the later extra-graphics pass.
 */
export function insideDiamond(px: number, py: number, anchor: readonly [number, number]): boolean {
  const dy = py - anchor[1];
  if (dy < 0 || dy >= CELL_H) return false;
  const half = dy < CELL_H / 2 ? 2 * (dy + 1) : 2 * (CELL_H - 1 - dy);
  const dx = px - anchor[0];
  return dx >= -half && dx < half;
}

interface TerrainTarget {
  put(x: number, y: number, r: number, g: number, b: number, alpha: number, tile: number): void;
}

/** The target owns alpha semantics: previews stay opaque, while terrain maps retain atlas alpha and attribution. */
export function drawTerrainTiles(
  m: HdCacheManifest,
  terrain: PngImage,
  cells: readonly CellDraw[],
  target: TerrainTarget,
  lightAt: (z: number) => readonly [number, number, number] = () => [1, 1, 1],
): void {
  if (terrain.channels !== 4) throw new Error('Terrain atlas must be an RGBA PNG');
  const clamp = (v: number): number => (v > 255 ? 255 : v);
  for (const pass of [0, 1]) {
    for (const c of cells) {
      const tile = m.tiles[c.t]!;
      const [rx, ry, rw, rh] = tile.rect;
      const [lr, lg, lb] = lightAt(c.z);
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          const s = ((ry + py) * terrain.width + rx + px) * 4;
          if (terrain.data[s + 3] === 0) continue;
          if (insideDiamond(px, py, tile.anchor) !== (pass === 0)) continue;
          target.put(
            c.sx + px,
            c.sy + py,
            clamp(terrain.data[s]! * lr),
            clamp(terrain.data[s + 1]! * lg),
            clamp(terrain.data[s + 2]! * lb),
            terrain.data[s + 3]!,
            c.t,
          );
        }
      }
    }
  }
}
