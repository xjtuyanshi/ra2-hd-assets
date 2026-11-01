import { afterEach, describe, expect, it } from 'vitest';
import { DataTexture, Vector3 } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { NO_TILE, type Ra2Cache } from '../src/ra2/cache';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { groundFromHeights } from '../src/ra2/voxelShadow';
import { LEVEL_HEIGHT } from '../src/world';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One row of cells: level-0 ground, a ramp up to level 1, level-1 ground and a level-3 plateau behind a cliff. */
function terrain(ref = { width: 128, height: 64, scale: 1 }) {
  const width = 4;
  const exists = new Uint8Array(width).fill(1);
  const levels = new Uint8Array([0, 0, 1, 3]);
  const tile = new Uint16Array([0, 1, 0, 0]);
  const texture = new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
  const nodes = new AtmosphereNodes();
  const cache = {
    nodes,
    exists,
    height: levels,
    tile,
    mapLight: null,
    manifest: {
      grid: { width, height: 1 },
      tiles: [
        { terrainType: 0, rampType: 0, file: 'clear01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] },
        { terrainType: 0, rampType: 1, file: 'ramp01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] },
      ],
    },
    terrainMap: {
      texture,
      waterMask: texture,
      shore: texture,
      cliff: null,
      waterBed: false,
      waterDetail: texture,
      waterSurface: null,
      ref: { file: 'terrain.png', ...ref, originX: 0, originY: 0 },
    },
  } as unknown as Ra2Cache;
  expect(tile.includes(NO_TILE)).toBe(false);
  const build = buildRa2Terrain(cache);
  cleanups.push(() => {
    const materials = Array.isArray(build.mesh.material) ? build.mesh.material : [build.mesh.material];
    for (const material of materials) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    texture.dispose();
    nodes.dispose();
  });
  return build;
}

describe('terrain surface height', () => {
  it('follows a ramp continuously where the grid lookup answers with the nearest node', () => {
    const build = terrain();
    const surface = build.surfaceHeightAt!;
    for (const [x, level] of [
      [0.5, 0],
      [1, 0],
      [1.1, 0.1],
      [1.25, 0.25],
      [1.5, 0.5],
      [1.75, 0.75],
      [1.95, 0.95],
      [2.5, 1],
    ])
      expect(surface(x!, 0.5)).toBeCloseTo(level! * LEVEL_HEIGHT, 6);
    // The grid has two nodes per cell: a unit a quarter of the way up the ramp reads a quarter level off.
    expect(Math.abs(build.heightAt(1.2, 0.5) - surface(1.2, 0.5))).toBeCloseTo(0.2 * LEVEL_HEIGHT, 6);
    expect(Math.abs(build.heightAt(1.3, 0.5) - surface(1.3, 0.5))).toBeCloseTo(0.2 * LEVEL_HEIGHT, 6);
    // A cliff keeps each side's level up to the shared edge, and points off the map fall back to the grid.
    expect(surface(2.99, 0.5)).toBeCloseTo(LEVEL_HEIGHT, 6);
    expect(surface(3.01, 0.5)).toBeCloseTo(3 * LEVEL_HEIGHT, 6);
    expect(surface(-2, 0.5)).toBe(surface(0, 0.5));
  });

  it('gives the ramp its real slope as the ground normal and treats the cliff as flat', () => {
    const build = terrain();
    const ground = groundFromHeights(build.surfaceHeightAt!, LEVEL_HEIGHT * 1.5);
    const normal = new Vector3();
    const slope = new Vector3(-LEVEL_HEIGHT, 1, 0).normalize();
    for (const x of [1.3, 1.5, 1.7]) expect(ground.normal!(x, 0.5, normal).distanceTo(slope)).toBeLessThan(1e-6);
    const up = new Vector3(0, 1, 0);
    expect(ground.normal!(0.5, 0.5, normal).distanceTo(up)).toBe(0);
    expect(ground.normal!(3, 0.5, normal).distanceTo(up)).toBe(0);
  });
});

describe('terrain composite at a fractional scale', () => {
  it('samples every surface point at the same engine position as the scale-1 composite', () => {
    // A map too wide for 2x is fitted to 451/256 with each side rounded up (packages/ra2-assets terrainScale).
    const scale = 451 / 256;
    const fitted = { width: Math.ceil(128 * scale), height: Math.ceil(64 * scale), scale };
    const base = terrain().mesh.geometry.getAttribute('atlasUv');
    const wide = terrain(fitted).mesh.geometry.getAttribute('atlasUv');
    expect(wide.count).toBe(base.count);
    for (let i = 0; i < base.count; i++) {
      // Back from normalized texture coordinates to engine pixels: uv * image size / scale.
      expect((wide.getX(i) * fitted.width) / scale).toBeCloseTo(base.getX(i) * 128, 3);
      expect((wide.getY(i) * fitted.height) / scale).toBeCloseTo(base.getY(i) * 64, 3);
    }
  });
});
