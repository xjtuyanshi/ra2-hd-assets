/** Unlit whole-map terrain and open-water mask, derived only from the terrain atlas. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HdCacheManifest } from '../manifest.ts';
import { buildWaterMaskBytes } from '../waterMask.ts';
import { decodePng, encodePng } from './png.ts';
import { drawTerrainTiles, terrainLayout } from './terrain.ts';

export interface TerrainMapResult {
  file: string;
  waterMask: string;
  width: number;
  height: number;
  /** Engine screen coordinates of the top-left image pixel; image coordinates subtract this origin. */
  originX: number;
  originY: number;
  rgba: Uint8Array;
  /** Index into manifest.tiles of the last tile to write each pixel; -1 means uncovered. */
  tileAt: Int32Array;
}

export function renderTerrainMap(opts: { cacheDir: string; writeManifest?: boolean }): TerrainMapResult {
  const manifestFile = join(opts.cacheDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as HdCacheManifest;
  const terrain = decodePng(readFileSync(join(opts.cacheDir, manifest.terrainAtlas.file)));
  const { cells, minX, minY, maxX, maxY } = terrainLayout(manifest);
  // Include every extracted cell as in preview --full, without space reserved for sprites or model strips.
  const originX = Math.floor(minX);
  const originY = Math.floor(minY);
  const width = Math.ceil(maxX) - originX;
  const height = Math.ceil(maxY) - originY;
  const rgba = new Uint8Array(width * height * 4);
  const tileAt = new Int32Array(width * height).fill(-1);
  drawTerrainTiles(manifest, terrain, cells, {
    put(x, y, r, g, b, alpha, tile) {
      const px = Math.round(x) - originX;
      const py = Math.round(y) - originY;
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const i = py * width + px;
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = alpha;
      tileAt[i] = tile;
    },
  });
  const mask = buildWaterMaskBytes(rgba, width, height, tileAt, manifest.tiles);
  const file = join(opts.cacheDir, 'terrain-map.png');
  const waterMask = join(opts.cacheDir, 'terrain-water.png');
  writeFileSync(file, encodePng({ width, height, channels: 4, data: rgba }));
  writeFileSync(waterMask, encodePng({ width, height, channels: 1, data: mask }));
  if (opts.writeManifest !== false) {
    manifest.terrainMap = {
      file: 'terrain-map.png',
      waterMask: 'terrain-water.png',
      scale: 1,
      originX,
      originY,
      width,
      height,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }
  return { file, waterMask, width, height, originX, originY, rgba, tileAt };
}
