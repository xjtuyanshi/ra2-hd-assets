/**
 * Engine tile depth for the HD cache (Node only): the raster painting shared with extraction, and the retrofit that
 * adds the depth atlas to a cache extracted before it existed, from the player's own install.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TmpFile, TmpTile } from 'ra2-formats';
import type { HdCacheManifest } from '../manifest.ts';
import { THEATERS } from '../theater.ts';
import { mergeTileRaster, type TileRaster, type TileRasterSource } from '../tileRaster.ts';
import { GameInstall } from './install.ts';
import { decodePng, encodePng } from './png.ts';

export const TERRAIN_DEPTH_FILE = 'terrain-depth.png';

/** A parsed TMP tile as the pure merge input: the packed z scanlines are expanded like the diamond bitmap. */
export function tmpTileSource(tmp: TmpFile, tile: TmpTile): TileRasterSource {
  return {
    x: tile.x,
    y: tile.y,
    hasZData: tile.hasZData,
    bitmap: tile.bitmap,
    ...(tile.zData ? { zBitmap: tmp.expandDiamond(tile.zData) } : {}),
    ...(tile.extra ? { extra: tile.extra } : {}),
  };
}

/** Paint one merged tile raster into the colour and depth atlases at (x, y). */
export function paintTileRaster(
  raster: TileRaster,
  x: number,
  y: number,
  palette: Uint8Array,
  rgba: Uint8Array,
  depth: Uint8Array,
  atlasWidth: number,
): void {
  for (let py = 0; py < raster.height; py++) {
    for (let px = 0; px < raster.width; px++) {
      const v = raster.index[py * raster.width + px]!;
      if (!v) continue;
      const d = (y + py) * atlasWidth + x + px;
      rgba[d * 4] = palette[v * 3]!;
      rgba[d * 4 + 1] = palette[v * 3 + 1]!;
      rgba[d * 4 + 2] = palette[v * 3 + 2]!;
      rgba[d * 4 + 3] = 255;
      depth[d] = raster.depth[py * raster.width + px]!;
    }
  }
}

export interface TerrainDepthBuild {
  manifest: HdCacheManifest;
  /** Terrain atlas colours after the engine's tile merge (equal to the cache's atlas unless `repainted` > 0). */
  rgba: Uint8Array;
  depth: Uint8Array;
  width: number;
  height: number;
  /** Tiles without TMP z-data (drawn without a depth test). */
  noDepth: number;
  /**
   * Atlas pixels whose colour changed: places where a tile's extra graphics lose the engine's depth test against
   * the same tile's diamond, which extraction used to paint extra-on-top.
   */
  repainted: number;
}

/**
 * Rebuild every manifest tile of an existing map cache from the install and derive its depth atlas, without writing.
 * Each tile must match the cache's atlas rectangle, anchor and pixels; a cache that came from different game files is
 * rejected rather than given depth that does not belong to its art. The returned manifest carries `terrainAtlas.depth`
 * and the tiles' `noDepth` flags.
 */
export function buildTerrainDepth(opts: { gameDir: string; cacheDir: string }): TerrainDepthBuild {
  const manifest = JSON.parse(readFileSync(join(opts.cacheDir, 'manifest.json'), 'utf8')) as HdCacheManifest;
  const theater = THEATERS[manifest.theater];
  if (!theater) throw new Error(`Unknown map theater: ${manifest.theater}`);
  const inst = GameInstall.open(opts.gameDir, manifest.theater);
  const palette = inst.palette(theater.isoPalette).rgb;
  const atlas = decodePng(readFileSync(join(opts.cacheDir, manifest.terrainAtlas.file)));
  if (atlas.channels !== 4) throw new Error('Terrain atlas must be an RGBA PNG');
  const { width, height } = atlas;
  const rgba = new Uint8Array(atlas.data);
  const depth = new Uint8Array(width * height);
  let noDepth = 0;
  let repainted = 0;
  manifest.tiles.forEach((entry, i) => {
    const name = `tile ${i} (${entry.file}#${entry.subTile})`;
    const tmp = inst.tmp(entry.file);
    const tile = tmp && entry.subTile < tmp.tileCount ? tmp.getTile(entry.subTile) : undefined;
    if (!tmp || !tile) throw new Error(`${name} is missing from the install`);
    const source = tmpTileSource(tmp, tile);
    const raster = mergeTileRaster(source, tmp.tileWidth, tmp.tileHeight);
    const [rx, ry, rw, rh] = entry.rect;
    if (
      rw !== raster.width ||
      rh !== raster.height ||
      entry.anchor[0] !== raster.anchor[0] ||
      entry.anchor[1] !== raster.anchor[1]
    )
      throw new Error(`${name} has a different shape in the install than in the cache`);
    // The cache's own pixels must be this tile as extraction painted it before the depth atlas existed (every extra
    // pixel over the diamond). The engine's rule differs from that only where an extra pixel loses to its own diamond.
    const legacy = mergeTileRaster({ ...source, hasZData: false }, tmp.tileWidth, tmp.tileHeight).index;
    for (let p = 0; p < rw * rh; p++) {
      const a = ((ry + Math.floor(p / rw)) * width + rx + (p % rw)) * 4;
      const matches = (v: number): boolean =>
        v === 0
          ? atlas.data[a + 3] === 0
          : atlas.data[a + 3] === 255 &&
            atlas.data[a] === palette[v * 3] &&
            atlas.data[a + 1] === palette[v * 3 + 1] &&
            atlas.data[a + 2] === palette[v * 3 + 2];
      if (matches(raster.index[p]!)) continue;
      if (!matches(legacy[p]!)) throw new Error(`${name} pixels differ between the install and the cache`);
      repainted++;
      if (!raster.index[p]) rgba.fill(0, a, a + 4);
    }
    paintTileRaster(raster, rx, ry, palette, rgba, depth, width);
    if (raster.depthTested) delete entry.noDepth;
    else {
      entry.noDepth = true;
      noDepth++;
    }
  });
  manifest.terrainAtlas = { ...manifest.terrainAtlas, depth: TERRAIN_DEPTH_FILE };
  return { manifest, rgba, depth, width, height, noDepth, repainted };
}

export interface TerrainDepthResult {
  file: string;
  tiles: number;
  noDepth: number;
  repainted: number;
}

/**
 * Add `terrain-depth.png` to a map cache extracted before extraction wrote it ({@link buildTerrainDepth}). The
 * terrain atlas is rewritten only when the engine's tile merge changes pixels; the manifest gains
 * `terrainAtlas.depth`, which makes prepare-map rebuild the terrain composite and its upscale.
 */
export function writeTerrainDepth(opts: { gameDir: string; cacheDir: string }): TerrainDepthResult {
  const built = buildTerrainDepth(opts);
  const { manifest, width, height } = built;
  const file = join(opts.cacheDir, TERRAIN_DEPTH_FILE);
  writeFileSync(file, encodePng({ width, height, channels: 1, data: built.depth }));
  if (built.repainted)
    writeFileSync(
      join(opts.cacheDir, manifest.terrainAtlas.file),
      encodePng({ width, height, channels: 4, data: built.rgba }),
    );
  writeFileSync(join(opts.cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { file, tiles: manifest.tiles.length, noDepth: built.noDepth, repainted: built.repainted };
}
