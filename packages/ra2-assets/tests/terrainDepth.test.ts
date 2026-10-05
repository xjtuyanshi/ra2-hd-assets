import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Palette, TmpFile } from 'ra2-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HdCacheManifest, TileEntry } from '../src/manifest.ts';
import { GameInstall } from '../src/node/install.ts';
import { decodePng, encodePng } from '../src/node/png.ts';
import { insideDiamond, loadTerrainDepth, resolveTerrain, terrainLayout } from '../src/node/terrain.ts';
import { buildTerrainDepth, TERRAIN_DEPTH_FILE, writeTerrainDepth } from '../src/node/terrainDepth.ts';
import { renderTerrainMap, type TerrainMapResult } from '../src/node/terrainMap.ts';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SNOW = [230, 240, 250, 255] as const;
const CLIFF = [40, 70, 120, 255] as const;
const ROAD = [90, 90, 90, 255] as const;

interface Cell {
  x: number;
  y: number;
  z: number;
  tile: number;
}

/**
 * A cliff foot with ground behind and in front of it, on a 3x3 grid:
 *   tile 0  flat ground: the 60x30 diamond, z byte 29 - row (what every stock flat tile stores)
 *   tile 1  cliff foot: the same diamond plus a 60x60 face above it (anchor [30, 60]) at z byte `faceZ`
 *   tile 2  flat ground without z-data (`noDepth`)
 * The face of the cell at (1, 1) reaches 60 px up the screen. A cell one row in front of it and four levels up,
 * (1, 2, z = 4), puts the right half of its diamond inside the face's rectangle: the engine draws that ground in
 * front of the face, and painting faces after all diamonds leaves a wedge of cliff with a straight vertical edge.
 */
function cliffCache(cells: Cell[], opts: { faceZ?: number; depth?: boolean } = {}): string {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ra2-terrain-depth-'));
  directories.push(cacheDir);
  const tiles: TileEntry[] = [
    { file: 'clear01.sno', subTile: 0, height: 0, rampType: 0, terrainType: 13, rect: [0, 0, 60, 30], anchor: [30, 0] },
    {
      file: 'cliff01.sno',
      subTile: 0,
      height: 0,
      rampType: 0,
      terrainType: 15,
      rect: [60, 0, 60, 90],
      anchor: [30, 60],
    },
    {
      file: 'road01.sno',
      subTile: 0,
      height: 0,
      rampType: 0,
      terrainType: 11,
      rect: [120, 0, 60, 30],
      anchor: [30, 0],
      noDepth: true,
    },
  ];
  const width = 180;
  const height = 90;
  const rgba = new Uint8Array(width * height * 4);
  const depth = new Uint8Array(width * height);
  const put = (x: number, y: number, colour: readonly number[], z: number): void => {
    rgba.set(colour, (y * width + x) * 4);
    depth[y * width + x] = z;
  };
  for (let py = 0; py < 30; py++) {
    for (let px = 0; px < 60; px++) {
      if (!insideDiamond(px, py, [30, 0])) continue;
      put(px, py, SNOW, 29 - py);
      put(60 + px, 60 + py, CLIFF, 29 - py);
      put(120 + px, py, ROAD, 0);
    }
  }
  for (let py = 0; py < 60; py++) for (let px = 0; px < 60; px++) put(60 + px, py, CLIFF, opts.faceZ ?? 15);
  const grid = { width: 3, height: 3 };
  const exists = new Uint8Array(9);
  const heights = new Uint8Array(9);
  const tile = Buffer.alloc(18, 0xff);
  for (const c of cells) {
    const i = c.y * grid.width + c.x;
    exists[i] = 1;
    heights[i] = c.z;
    tile.writeUInt16LE(c.tile, i * 2);
  }
  const manifest = {
    version: 1,
    name: 'Synthetic cliff',
    source: 'synthetic.map',
    theater: 'snow',
    grid,
    cells: {
      exists: Buffer.from(exists).toString('base64'),
      height: Buffer.from(heights).toString('base64'),
      tile: tile.toString('base64'),
    },
    tiles,
    terrainAtlas: {
      file: 'terrain.png',
      width,
      height,
      ...(opts.depth === false ? {} : { depth: TERRAIN_DEPTH_FILE }),
    },
  } as unknown as HdCacheManifest;
  writeFileSync(join(cacheDir, 'terrain.png'), encodePng({ width, height, channels: 4, data: rgba }));
  writeFileSync(join(cacheDir, TERRAIN_DEPTH_FILE), encodePng({ width, height, channels: 1, data: depth }));
  writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify(manifest));
  return cacheDir;
}

function pixelAt(result: TerrainMapResult, x: number, y: number): { rgba: number[]; tile: number } {
  const index = (y - result.originY) * result.width + x - result.originX;
  return { rgba: Array.from(result.rgba.subarray(index * 4, index * 4 + 4)), tile: result.tileAt[index]! };
}

// Screen positions: cliff foot (1, 1, 0) has its top corner at (0, 30) and its face over x -30..29, y -30..29.
const FOOT: Cell = { x: 1, y: 1, z: 0, tile: 1 };
// One row in front, four levels up: top corner (-30, -15), diamond over x -60..-1, y -15..14.
const FRONT: Cell = { x: 1, y: 2, z: 4, tile: 0 };
// One row behind, four levels up: top corner (30, -45), diamond over x 0..59, y -45..-16.
const BEHIND: Cell = { x: 1, y: 0, z: 4, tile: 0 };

describe('terrain composite with the engine tile depth', () => {
  it('draws ground in front of a cliff face over the face and the face over ground behind it', () => {
    const result = renderTerrainMap({ cacheDir: cliffCache([FOOT, FRONT, BEHIND]) });
    // Right half of the front cell's diamond, inside the face rectangle: ground, not a wedge of cliff.
    expect(pixelAt(result, -10, 0)).toEqual({ rgba: [...SNOW], tile: 0 });
    expect(pixelAt(result, -29, -1)).toEqual({ rgba: [...SNOW], tile: 0 });
    // The face still covers the plateau behind it (its diamond row 15 at x 20) and shows wherever nothing nearer
    // was drawn.
    expect(pixelAt(result, 20, -30)).toEqual({ rgba: [...CLIFF], tile: 1 });
    expect(pixelAt(result, 10, 10)).toEqual({ rgba: [...CLIFF], tile: 1 });
    // Outside the face rectangle both cells are simply themselves.
    expect(pixelAt(result, -40, 0)).toEqual({ rgba: [...SNOW], tile: 0 });
    expect(pixelAt(result, 40, -30)).toEqual({ rgba: [...SNOW], tile: 0 });
  });

  it('resolves face pixels against the ground behind per pixel, with equal depth going to the later cell', () => {
    // A face at z byte 29 is as far as the foot cell's own top row: relative depth 29 - 30 = -1. The plateau behind
    // stores 29 - row - 15, so its upper rows (down to row 15, depth -1) are farther or equal and the face, drawn
    // later, covers them; from row 16 on the plateau is nearer and stays.
    const result = renderTerrainMap({ cacheDir: cliffCache([FOOT, BEHIND], { faceZ: 29 }) });
    expect(pixelAt(result, 20, -45 + 15)).toEqual({ rgba: [...CLIFF], tile: 1 });
    expect(pixelAt(result, 20, -45 + 16)).toEqual({ rgba: [...SNOW], tile: 0 });
    expect(pixelAt(result, 20, -45 + 20)).toEqual({ rgba: [...SNOW], tile: 0 });
  });

  it('draws a tile without z-data over anything and lets later tested tiles ignore it', () => {
    // The road cell sits where FRONT sat. Without z-data it is drawn unconditionally, after the cliff foot.
    const road: Cell = { ...FRONT, tile: 2 };
    const over = renderTerrainMap({ cacheDir: cliffCache([FOOT, road]) });
    expect(pixelAt(over, -10, 0)).toEqual({ rgba: [...ROAD], tile: 2 });
    // A second cliff foot one row further front, (2, 2, 0), has its face over x -30..29, y 0..59. With z byte 40 the
    // face's depth there is -60 + 40 = -20: farther than ground at the road's place would be (-31), nearer than
    // the first face (-30 + 40 = 10).
    const second: Cell = { x: 2, y: 2, z: 0, tile: 1 };
    // Tested ground keeps the second face behind it.
    const tested = renderTerrainMap({ cacheDir: cliffCache([FOOT, FRONT, second], { faceZ: 40 }) });
    expect(pixelAt(tested, -10, 0)).toEqual({ rgba: [...SNOW], tile: 0 });
    // The road wrote no depth, so the second face only meets the first face's depth and draws over the road.
    const untested = renderTerrainMap({ cacheDir: cliffCache([FOOT, road, second], { faceZ: 40 }) });
    expect(pixelAt(untested, -10, 0)).toEqual({ rgba: [...CLIFF], tile: 1 });
    expect(pixelAt(untested, -40, 0)).toEqual({ rgba: [...ROAD], tile: 2 });
  });

  it('falls back to the diamonds-then-extras painter for a cache without a depth atlas', () => {
    const cacheDir = cliffCache([FOOT, FRONT, BEHIND], { depth: false });
    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8')) as HdCacheManifest;
    expect(loadTerrainDepth(cacheDir, manifest)).toBeUndefined();
    const result = renderTerrainMap({ cacheDir });
    // The known defect of the fallback: the face covers the ground in front of it.
    expect(pixelAt(result, -10, 0)).toEqual({ rgba: [...CLIFF], tile: 1 });
    expect(pixelAt(result, -40, 0)).toEqual({ rgba: [...SNOW], tile: 0 });
  });

  it('reports the visible cell of every pixel for consumers that attribute pixels to cells', () => {
    const cacheDir = cliffCache([FOOT, FRONT, BEHIND]);
    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8')) as HdCacheManifest;
    const layout = terrainLayout(manifest);
    const terrain = decodePng(readFileSync(join(cacheDir, 'terrain.png')));
    const resolved = resolveTerrain(manifest, terrain, layout, loadTerrainDepth(cacheDir, manifest));
    const cellOf = (x: number, y: number): string => {
      const k = resolved.cell[(y - resolved.originY) * resolved.width + x - resolved.originX]!;
      return k < 0 ? 'none' : `${layout.cells[k]!.x},${layout.cells[k]!.y}`;
    };
    expect([cellOf(-10, 0), cellOf(20, -20), cellOf(40, -30), cellOf(-59, -30)]).toEqual(['1,2', '1,1', '1,0', 'none']);
  });

  it('rejects a depth atlas that does not match the terrain atlas', () => {
    const cacheDir = cliffCache([FOOT]);
    writeFileSync(
      join(cacheDir, TERRAIN_DEPTH_FILE),
      encodePng({ width: 2, height: 2, channels: 1, data: new Uint8Array(4) }),
    );
    expect(() => renderTerrainMap({ cacheDir })).toThrow(/depth atlas/);
  });
});

// ---------------------------------------------------------------- depth atlas for an existing cache

const DIAMOND_BYTES = 900;

/** One 60x30 TMP tile with z-data and a 6x4 extra one row above the diamond box, as on-disk bytes. */
function tmpBytes(opts: { zData: boolean; extraZ: number; extraColour: number }): Uint8Array {
  const header = new Uint8Array(16 + 4 + 52);
  const dv = new DataView(header.buffer);
  dv.setInt32(0, 1, true);
  dv.setInt32(4, 1, true);
  dv.setInt32(8, 60, true);
  dv.setInt32(12, 30, true);
  dv.setInt32(16, 20, true);
  const base = 20;
  const zOfs = 52 + DIAMOND_BYTES;
  const extraOfs = zOfs + DIAMOND_BYTES;
  dv.setInt32(base + 8, extraOfs, true);
  dv.setInt32(base + 12, zOfs, true);
  dv.setInt32(base + 16, extraOfs + 24, true);
  dv.setInt32(base + 20, 27, true); // x_extra: columns 27..32 of the diamond box
  dv.setInt32(base + 24, -1, true); // y_extra: rows -1..2
  dv.setInt32(base + 28, 6, true);
  dv.setInt32(base + 32, 4, true);
  dv.setUint32(base + 36, opts.zData ? 3 : 1, true);
  const diamond = new Uint8Array(DIAMOND_BYTES).fill(5);
  const z = new Uint8Array(DIAMOND_BYTES);
  // Packed scanlines: row r holds 4, 8, .., 60, 56, .., 0 bytes; flat tiles store 29 - r.
  let cursor = 0;
  for (let r = 0; r < 30; r++) {
    const n = r < 15 ? 4 * (r + 1) : 4 * (29 - r);
    z.fill(29 - r, cursor, cursor + n);
    cursor += n;
  }
  const extra = new Uint8Array(24).fill(opts.extraColour);
  const extraZ = new Uint8Array(24).fill(opts.extraZ);
  const out = new Uint8Array(header.length + DIAMOND_BYTES * 2 + 48);
  out.set(header, 0);
  out.set(diamond, header.length);
  out.set(z, header.length + DIAMOND_BYTES);
  out.set(extra, header.length + DIAMOND_BYTES * 2);
  out.set(extraZ, header.length + DIAMOND_BYTES * 2 + 24);
  return out;
}

function installWith(files: Record<string, Uint8Array>): void {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i >> 2, (i >> 2) ^ 1, 63 - (i >> 2)], i * 3);
  const opened = {
    palette: () => Palette.parse(pal),
    tmp: (name: string) => (files[name] ? TmpFile.parse(files[name]) : undefined),
  };
  vi.spyOn(GameInstall, 'open').mockReturnValue(opened as unknown as GameInstall);
}

/** A cache holding the single tile as extraction painted it before the depth atlas existed: extra over diamond. */
function legacyTileCache(extraColour: number, palette: Uint8Array): string {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ra2-terrain-depth-'));
  directories.push(cacheDir);
  const width = 60;
  const height = 31;
  const rgba = new Uint8Array(width * height * 4);
  const paint = (x: number, y: number, v: number): void => {
    rgba.set([palette[v * 3]!, palette[v * 3 + 1]!, palette[v * 3 + 2]!, 255], (y * width + x) * 4);
  };
  for (let py = 0; py < 30; py++)
    for (let px = 0; px < 60; px++) if (insideDiamond(px, py, [30, 0])) paint(px, py + 1, 5);
  for (let py = 0; py < 4; py++) for (let px = 27; px < 33; px++) paint(px, py, extraColour);
  writeFileSync(join(cacheDir, 'terrain.png'), encodePng({ width, height, channels: 4, data: rgba }));
  writeFileSync(
    join(cacheDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      theater: 'snow',
      grid: { width: 1, height: 1 },
      cells: { exists: 'AQ==', height: 'AA==', tile: 'AAA=' },
      tiles: [
        {
          file: 'bank01.sno',
          subTile: 0,
          height: 0,
          rampType: 0,
          terrainType: 13,
          rect: [0, 0, 60, 31],
          anchor: [30, 1],
        },
      ],
      terrainAtlas: { file: 'terrain.png', width, height },
      futureField: 'kept',
    }),
  );
  return cacheDir;
}

describe('terrain depth for an existing cache', () => {
  const palette = (): Uint8Array => {
    installWith({});
    return GameInstall.open('', 'snow').palette('').rgb;
  };

  it('writes the depth atlas, flags the manifest and leaves an atlas that already matches untouched', () => {
    const pal = palette();
    const cacheDir = legacyTileCache(9, pal);
    const before = readFileSync(join(cacheDir, 'terrain.png'));
    // The extra's z (3) is nearer than every diamond row it overlaps (29, 28, 27): the engine agrees with the cache.
    installWith({ 'bank01.sno': tmpBytes({ zData: true, extraZ: 3, extraColour: 9 }) });
    const result = writeTerrainDepth({ gameDir: 'unused', cacheDir });
    expect(result).toMatchObject({ tiles: 1, noDepth: 0, repainted: 0 });
    expect(readFileSync(join(cacheDir, 'terrain.png')).equals(before)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8')) as HdCacheManifest;
    expect(manifest.terrainAtlas).toEqual({ file: 'terrain.png', width: 60, height: 31, depth: TERRAIN_DEPTH_FILE });
    expect(manifest.tiles[0]!.noDepth).toBeUndefined();
    expect((manifest as unknown as { futureField: string }).futureField).toBe('kept');
    const depth = decodePng(readFileSync(join(cacheDir, TERRAIN_DEPTH_FILE)));
    expect([depth.width, depth.height, depth.channels]).toEqual([60, 31, 1]);
    expect(depth.data[0 * 60 + 27]).toBe(3); // extra, above the diamond
    expect(depth.data[1 * 60 + 29]).toBe(3); // extra over diamond row 0
    expect(depth.data[2 * 60 + 26]).toBe(28); // diamond row 1 beside the extra
    expect(depth.data[16 * 60 + 5]).toBe(14); // diamond row 15
    expect(depth.data[0]).toBe(0); // transparent
  });

  it('repaints atlas pixels where an extra loses the depth test to its own diamond', () => {
    const pal = palette();
    const cacheDir = legacyTileCache(9, pal);
    // z 28: passes over diamond row 0 (29) and row 1 (28), fails over row 2 (27): one 6 px row returns to the diamond.
    installWith({ 'bank01.sno': tmpBytes({ zData: true, extraZ: 28, extraColour: 9 }) });
    const built = buildTerrainDepth({ gameDir: 'unused', cacheDir });
    expect(built.repainted).toBe(6);
    const at = (x: number, y: number): number[] =>
      Array.from(built.rgba.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 3));
    expect(at(29, 2)).toEqual([pal[27]!, pal[28]!, pal[29]!]);
    expect(at(29, 3)).toEqual([pal[15]!, pal[16]!, pal[17]!]);
    expect([built.depth[2 * 60 + 29], built.depth[3 * 60 + 29]]).toEqual([28, 27]);
    expect(writeTerrainDepth({ gameDir: 'unused', cacheDir }).repainted).toBe(6);
    // Idempotent: the rewritten atlas now equals the engine merge.
    expect(writeTerrainDepth({ gameDir: 'unused', cacheDir }).repainted).toBe(0);
  });

  it('marks tiles without z-data and rejects a cache that is not this install', () => {
    const pal = palette();
    const cacheDir = legacyTileCache(9, pal);
    installWith({ 'bank01.sno': tmpBytes({ zData: false, extraZ: 200, extraColour: 9 }) });
    const built = buildTerrainDepth({ gameDir: 'unused', cacheDir });
    expect([built.noDepth, built.repainted, built.manifest.tiles[0]!.noDepth]).toEqual([1, 0, true]);
    expect(built.depth.every((v) => v === 0)).toBe(true);

    installWith({ 'bank01.sno': tmpBytes({ zData: true, extraZ: 3, extraColour: 12 }) });
    expect(() => buildTerrainDepth({ gameDir: 'unused', cacheDir })).toThrow(/pixels differ/);
    installWith({});
    expect(() => buildTerrainDepth({ gameDir: 'unused', cacheDir })).toThrow(/missing from the install/);
  });
});
