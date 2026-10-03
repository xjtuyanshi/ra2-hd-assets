import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three/webgpu';
import type { MapObject } from '../../ra2-assets/src/manifest';
import { AtmosphereNodes } from '../src/atmosphere';
import type { Ra2Cache } from '../src/ra2/cache';
import type { SpriteInstance } from '../src/ra2/sprites';
import { VoxelUnit } from '../src/ra2/voxels';
import { loadRa2World } from '../src/ra2/world';
import { LEVEL_HEIGHT } from '../src/world';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const fixture = vi.hoisted(() => ({ cache: null as unknown as Ra2Cache, sprites: [] as SpriteInstance[] }));

vi.mock('../src/ra2/cache', async (original) => ({
  ...(await original<object>()),
  loadRa2Cache: async () => fixture.cache,
}));
vi.mock('../src/ra2/vpl', async (original) => ({
  ...(await original<object>()),
  loadVoxelLighting: async () => {},
}));
vi.mock('../src/ra2/terrain', () => ({
  buildRa2Terrain: () => ({ heightAt: (x: number) => (x >= 13 ? LEVEL_HEIGHT : 0), waterY: null }),
}));
vi.mock('../src/ra2/nightDressing', () => ({ Ra2NightDressing: class {} }));
vi.mock('../src/ra2/sprites', async (original) => ({
  ...(await original<object>()),
  SpriteLayer: class {
    readonly mesh = new Object3D();
    constructor(_cache: Ra2Cache, sprites: SpriteInstance[]) {
      fixture.sprites = sprites;
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function object(kind: MapObject['kind'], x: number, z = 0, voxel = false): MapObject {
  return { kind, type: `${kind}-${x}`, x, y: 1, z, ...(voxel ? { voxel: 'SYNTHETIC' } : { sprite: 'unit' }) };
}

describe('static map native ground cards', () => {
  it('enables only ground/deck units and preserves non-unit art, airborne objects and shadow/reflection cards', async () => {
    const nodes = new AtmosphereNodes();
    const objects = [
      object('vehicle', 1, 0, true),
      object('aircraft', 2, 0, true),
      object('aircraft', 3, 2, true),
      object('vehicle', 4, 4, true),
      { ...object('overlay', 4), type: 'BRIDGE1', sprite: undefined },
      object('vehicle', 5, 4, true),
      object('building', 6, 0, true),
      object('vehicle', 7),
      object('infantry', 8),
      object('aircraft', 9, 2),
      object('tree', 10),
      object('overlay', 11),
      object('building', 12),
      object('vehicle', 13, 0, true),
    ];
    fixture.cache = {
      nodes,
      manifest: {
        grid: { width: 16, height: 16 },
        objects,
        sprites: {
          unit: {
            palette: 'unit',
            remap: false,
            frames: [{ rect: [0, 0, 20, 30], offset: [-10, -25] }],
            shadows: [{ rect: [20, 0, 20, 8], offset: [-10, -4] }],
          },
        },
        waypoints: [],
      },
      lights: { hiddenObjects: [], cells: { surface: Buffer.from(new Uint8Array(256)).toString('base64') } },
      voxels: new Map([['SYNTHETIC', syntheticModel([syntheticSection(2, true)])]]),
      paletteRgb: new Map([['unit', new Uint8Array(768)]]),
      paletteRow: new Map(),
    } as unknown as Ra2Cache;
    const world = await loadRa2World('/synthetic', { nodes, spriteMaterials: false });
    const voxelAt = (x: number) =>
      world.root.children.find(
        (child): child is VoxelUnit => child instanceof VoxelUnit && child.position.x === x + 0.5,
      )!;
    for (const x of [1, 2, 4, 13]) {
      expect(voxelAt(x).nativeDepth.enabled, `ground voxel ${x}`).toBe(1);
      expect(voxelAt(x).nativeDepth.bonus).toBe(0);
      expect(voxelAt(x).nativeDepth.anchor).toEqual(voxelAt(x).position);
    }
    for (const x of [3, 5, 6]) expect(voxelAt(x).nativeDepth.enabled, `physical voxel ${x}`).toBe(0);
    expect(voxelAt(13).nativeDepth.anchor.y).toBe(LEVEL_HEIGHT);
    const spriteAt = (x: number) =>
      fixture.sprites.find((sprite) => sprite.anchor.x === x + 0.5 && !sprite.shadow && !sprite.kind)!;
    expect(spriteAt(7).nativeDepth).toEqual({ mode: 'card', bottom: 4, bonus: 0 });
    expect(spriteAt(8).nativeDepth).toEqual({ mode: 'card', bottom: 4, bonus: 12 });
    for (const x of [9, 10, 11, 12]) expect(spriteAt(x).nativeDepth).toBeUndefined();
    for (const sprite of fixture.sprites.filter((s) => s.shadow || s.kind === 'reflection'))
      expect(sprite.nativeDepth).toBeUndefined();
    for (const child of world.root.children)
      if (child instanceof VoxelUnit) for (const mesh of child.partMeshes) mesh.geometry.dispose();
    world.surfaceTexture!.dispose();
    nodes.dispose();
  });
});
