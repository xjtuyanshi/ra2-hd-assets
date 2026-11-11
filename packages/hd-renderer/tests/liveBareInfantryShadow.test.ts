import { describe, expect, it } from 'vitest';
import { Texture, Vector3 } from 'three/webgpu';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import {
  INFANTRY_SHADOW_SOFT_OPACITY,
  infantryFootprintOpacity,
  shadowDisplayRatio,
  SpriteLayer,
  type SpriteInstance,
} from '../src/ra2/sprites';
import { hdInfantryPageIsBare } from '../src/ra2/infantryArt';
import { LOOK_PRESETS } from '../src/HdRenderer';
import { ENGINE_SHADOW_OPACITY } from '../src/ra2/voxelShadow';
import type { Ra2Cache } from '../src/ra2/cache';
import type { DirtyAttribute } from '../src/dirtyAttribute';

const body = { rect: [0, 0, 10, 20] as [number, number, number, number], offset: [-5, -18] as [number, number], page: 0 };
const shadow = { rect: [2, 2, 12, 7] as [number, number, number, number], offset: [-6, -2] as [number, number], page: 7 };
const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['library:unit', 0]]),
  manifest: { spriteAtlas: { width: 64, height: 64 } },
  spriteAtlas: new Texture(),
} as unknown as Ra2Cache;

function footprint(image: string): SpriteInstance {
  const pool = new SpritePool();
  const entry = { frames: [body], shadows: [shadow], palette: 'unit', remap: true };
  const library = { library: { sprites: { 'infantry:T': entry } }, page: () => ({}), hasHdPage: () => true };
  const view = Object.assign(Object.create(LiveView.prototype), {
    cache,
    library,
    spritePool: pool,
    libraryPaletteKeys: new Map(),
    world: { terrain: { heightAt: () => 0 } },
  }) as { libraryInfantrySprites(...args: unknown[]): void };
  const visual = {
    libraryType: {
      image,
      sprite: 'infantry:T',
      remap: true,
      drawOffset: [0, 0],
      infantry: { sequences: { Ready: { start: 0, count: 1, facingMultiplier: 0 } } },
    },
  };
  const object = { kind: 'infantry', x: 512, y: 768, z: 0 } as LiveObject;
  const batch = new Map<number, SpriteInstance[]>();
  view.libraryInfantrySprites(object, { x: 512, y: 768, z: 0, facing: 0 }, visual, batch, 1);
  return batch.get(7)![0]!;
}

describe('infantry footprint of art without its own HD contact shadow', () => {
  it('marks animal art (by image, so YDOG/YADOG follow DOG/ADOG) and leaves soldiers alone', () => {
    for (const image of ['DOG', 'ADOG', 'COW', 'POLARB', 'dog']) expect(hdInfantryPageIsBare(image)).toBe(true);
    for (const image of ['GI', 'E2', 'MUMY', '', undefined]) expect(hdInfantryPageIsBare(image)).toBe(false);
    expect(footprint('DOG')).toMatchObject({ infantryShadow: true, infantryBare: true });
    expect(footprint('GI').infantryBare).toBeUndefined();
  });

  it('uploads code 2 for a bare footprint, 1 for a soldier, and clears the mark on pool reuse', () => {
    const pool = new SpritePool();
    const dog = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    dog.infantryShadow = true;
    dog.infantryBare = true;
    const gi = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    gi.infantryShadow = true;
    const layer = new SpriteLayer(cache, [dog, gi]);
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    expect([0, 1].map((i) => flags.array[i * flags.itemSize + 3])).toEqual([2, 1]);
    pool.begin();
    expect(pool.take(new Vector3(), shadow, 'library:unit', 0, true, true).infantryBare).toBeUndefined();
    layer.mesh.geometry.dispose();
    layer.mesh.material.dispose();
    layer.mesh.dispose();
    for (const mesh of layer.groundPasses) {
      mesh.material.dispose();
      mesh.dispose();
    }
  });

  it('gives animals the cinematic shadow opacity of buildings and vehicles, soldiers keep the soft footprint', () => {
    const cinematic = LOOK_PRESETS.cinematic.settings;
    const soft = cinematic.infantryShadow;
    expect(soft).toBe(INFANTRY_SHADOW_SOFT_OPACITY);
    const darkness = cinematic.shadowDarkness;
    const animal = infantryFootprintOpacity(soft, true, darkness);
    expect(animal).toBeCloseTo(Math.min(0.9, darkness * ENGINE_SHADOW_OPACITY), 12);
    // Before: the ground under a dog stayed at over 0.75 of its brightness (no visible shadow); now at most half.
    expect(shadowDisplayRatio(soft)).toBeGreaterThan(0.75);
    expect(shadowDisplayRatio(animal)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(infantryFootprintOpacity(soft, false, darkness)).toBe(soft);
    // Faithful looks stay solid black for everybody.
    expect(infantryFootprintOpacity(1, true, 1)).toBe(1);
  });
});
