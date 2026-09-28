import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HdCacheManifest } from '../src/manifest.ts';
import { decodePng, encodePng } from '../src/node/png.ts';
import { renderPreview } from '../src/node/preview.ts';
import { renderTerrainMap, type TerrainMapResult } from '../src/node/terrainMap.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function syntheticCache(): { cacheDir: string; manifest: HdCacheManifest } {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ra2-terrain-map-'));
  directories.push(cacheDir);
  const tile = Buffer.alloc(8);
  [1, 2, 0xffff, 0].forEach((value, index) => tile.writeUInt16LE(value, index * 2));
  const manifest: HdCacheManifest = {
    version: 1,
    name: 'Synthetic terrain',
    source: 'synthetic.map',
    theater: 'temperate',
    grid: { width: 2, height: 2 },
    mapSize: { width: 2, height: 2 },
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    cells: {
      exists: Buffer.from([1, 1, 0, 1]).toString('base64'),
      height: Buffer.from([0, 1, 0, 2]).toString('base64'),
      tile: tile.toString('base64'),
    },
    tiles: [0, 1, 2].map((index) => ({
      file: index === 0 ? 'water01.tem' : 'grass01.tem',
      subTile: 0,
      height: 4,
      rampType: 0,
      terrainType: index === 0 ? 9 : 0,
      rect: [index * 64, 0, 64, 48],
      anchor: [30, 2],
    })),
    terrainAtlas: { file: 'terrain.png', width: 192, height: 48 },
    // These deliberately do not exist: terrain compositing must not load any object resources.
    spriteAtlas: { file: 'sprites.png', width: 2, height: 2 },
    palettes: { unit: 'unit.png' },
    sprites: {
      fixture: {
        palette: 'unit',
        remap: false,
        canvas: [2, 2],
        frames: [{ rect: [0, 0, 2, 2], offset: [0, 0] }],
        shadows: [{ rect: [0, 0, 2, 2], offset: [0, 1] }],
      },
    },
    voxels: { fixture: 'missing-voxel.json' },
    objects: [
      { kind: 'smudge', type: 'SMUDGE', x: 0, y: 0, z: 0, sprite: 'fixture', flat: true },
      { kind: 'overlay', type: 'ORE', x: 0, y: 0, z: 0, sprite: 'fixture', flat: true },
      { kind: 'tree', type: 'TREE', x: 1, y: 1, z: 2, sprite: 'fixture' },
      { kind: 'vehicle', type: 'TANK', x: 0, y: 0, z: 0, voxel: 'fixture' },
    ],
    waypoints: [],
    lighting: { ambient: 0.3, red: 0.5, green: 0.7, blue: 0.2, ground: 0, level: 0.1 },
    extractor: { tool: 'synthetic', counts: { terrain: 3 }, warnings: ['keep me'] },
  };
  const atlas = new Uint8Array(192 * 48 * 4);
  const put = (tileIndex: number, x: number, y: number, colour: readonly number[]): void => {
    atlas.set(colour, (y * 192 + tileIndex * 64 + x) * 4);
  };
  const blue = [12, 32, 112, 255];
  const red = [180, 70, 25, 255];
  const green = [30, 150, 50, 255];
  // Tile 0 is the deepest cell, elevated onto tile 1's screen origin. Its own height field is informational.
  put(0, 30, 2, blue);
  put(1, 30, 2, red);
  put(1, 30, 3, red);
  // The shallow cell's extra graphics cover the neighbouring cell's diamond in the second pass.
  put(1, 60, 2, red);
  put(2, 30, 2, green);
  put(2, 31, 2, green);
  // Extra graphics are also ordered by cell depth.
  put(1, 31, 35, red);
  put(0, 31, 35, blue);
  put(0, 63, 47, [12, 32, 112, 128]);
  writeFileSync(join(cacheDir, 'terrain.png'), encodePng({ width: 192, height: 48, channels: 4, data: atlas }));
  writeFileSync(
    join(cacheDir, 'manifest.json'),
    JSON.stringify({ ...manifest, futureField: { nested: ['preserve', 42] } }, null, 2),
  );
  return { cacheDir, manifest };
}

function pixelAt(result: TerrainMapResult, x: number, y: number): { rgba: number[]; tile: number } {
  const index = (y - result.originY) * result.width + x - result.originX;
  return { rgba: Array.from(result.rgba.subarray(index * 4, index * 4 + 4)), tile: result.tileAt[index]! };
}

describe('terrain map', () => {
  it('composites both terrain passes unlit with original alpha and last-writer tile attribution', () => {
    const { cacheDir } = syntheticCache();
    const result = renderTerrainMap({ cacheDir });
    // Full tile raster bounds, independent of visibleRect and without preview sprite margins.
    expect([result.width, result.height, result.originX, result.originY]).toEqual([94, 48, -30, -2]);
    expect(pixelAt(result, -30, -2)).toEqual({ rgba: [0, 0, 0, 0], tile: -1 });
    expect(pixelAt(result, 0, 0)).toEqual({ rgba: [12, 32, 112, 255], tile: 0 });
    expect(pixelAt(result, 0, 1)).toEqual({ rgba: [180, 70, 25, 255], tile: 1 });
    expect(pixelAt(result, 30, 0)).toEqual({ rgba: [180, 70, 25, 255], tile: 1 });
    expect(pixelAt(result, 31, 0)).toEqual({ rgba: [30, 150, 50, 255], tile: 2 });
    expect(pixelAt(result, 1, 33)).toEqual({ rgba: [12, 32, 112, 255], tile: 0 });
    expect(pixelAt(result, 33, 45)).toEqual({ rgba: [12, 32, 112, 128], tile: 0 });
    expect(pixelAt(result, 0, 15)).toEqual({ rgba: [0, 0, 0, 0], tile: -1 });
    expect(result.tileAt).toHaveLength(result.width * result.height);

    const image = decodePng(readFileSync(result.file));
    expect(image).toEqual({ width: 94, height: 48, channels: 4, data: result.rgba });
    const mask = decodePng(readFileSync(result.waterMask));
    expect([mask.width, mask.height, mask.channels]).toEqual([94, 48, 1]);
    expect(mask.data[(33 + 2) * 94 + 1 + 30]).toBe(255);
    expect(mask.data[0]).toBe(0);
  });

  it('updates only terrainMap and preserves unrecognized manifest fields', () => {
    const { cacheDir } = syntheticCache();
    const manifestFile = join(cacheDir, 'manifest.json');
    const original: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
    renderTerrainMap({ cacheDir });
    const saved = readFileSync(manifestFile, 'utf8');
    expect(JSON.parse(saved)).toEqual({
      ...(original as object),
      terrainMap: {
        file: 'terrain-map.png',
        waterMask: 'terrain-water.png',
        scale: 1,
        originX: -30,
        originY: -2,
        width: 94,
        height: 48,
      },
    });
    expect(saved).toBe(JSON.stringify(JSON.parse(saved), null, 2));
  });

  it('leaves manifest bytes unchanged when writeManifest is false', () => {
    const { cacheDir } = syntheticCache();
    const manifestFile = join(cacheDir, 'manifest.json');
    const original = `${JSON.stringify(JSON.parse(readFileSync(manifestFile, 'utf8')))}\n`;
    writeFileSync(manifestFile, original);
    const result = renderTerrainMap({ cacheDir, writeManifest: false });
    expect(readFileSync(manifestFile, 'utf8')).toBe(original);
    expect(decodePng(readFileSync(result.file)).channels).toBe(4);
    expect(decodePng(readFileSync(result.waterMask)).channels).toBe(1);
  });

  it.each([
    { full: true, lighting: true, hash: '66e3db7c695b8a906325a53fe8c95fad07b827af1bdef93164b7f546e8753be2' },
    { full: true, lighting: false, hash: 'cd0fc1df3901e709acf0dd26b275a49b48732f0c998e925d17a61ef4c67690fd' },
    { full: false, lighting: true, hash: 'd3a9b3ea4254808bb073ac74ab3c021e7aed26d2d5de8769ed19c8acd03a1b08' },
  ])('keeps preview PNG bytes identical (full=$full, lighting=$lighting)', ({ full, lighting, hash }) => {
    const { cacheDir, manifest } = syntheticCache();
    manifest.objects = manifest.objects.filter((object) => !object.voxel);
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(
      join(cacheDir, 'sprites.png'),
      encodePng({
        width: 2,
        height: 2,
        channels: 4,
        data: Uint8Array.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 0, 0, 0, 0]),
      }),
    );
    const palette = new Uint8Array(256 * 3);
    palette.set([255, 10, 90, 30, 220, 50, 20, 70, 250], 3);
    writeFileSync(join(cacheDir, 'unit.png'), encodePng({ width: 256, height: 1, channels: 3, data: palette }));
    // Golden hashes were captured from the pre-refactor compositor with this synthetic cache.
    const result = renderPreview({ cacheDir, full, lighting });
    expect(createHash('sha256').update(readFileSync(result.file)).digest('hex')).toBe(hash);
  });
});
