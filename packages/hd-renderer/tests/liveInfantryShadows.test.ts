import { describe, expect, it } from 'vitest';
import { DataTexture, Mesh, OrthographicCamera, Scene, Texture, Vector3, WebGPURenderer } from 'three/webgpu';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import {
  INFANTRY_SHADOW_OPACITY,
  INFANTRY_SHADOW_RAMP,
  INFANTRY_SHADOW_SOFT_OPACITY,
  GROUND_PULL,
  infantryShadowAlpha,
  shadowDisplayRatio,
  SpriteLayer,
  type SpriteInstance,
} from '../src/ra2/sprites';
import type { Ra2Cache } from '../src/ra2/cache';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { applyLookPreset, LOOK_PRESETS, type HdSettings } from '../src/HdRenderer';
import { AtmosphereNodes } from '../src/atmosphere';
import { CARD_CLEARANCE } from '../src/ra2/cardDepth';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { CONTACT_SHADOW_OPACITY, ENGINE_SHADOW_OPACITY } from '../src/ra2/voxelShadow';

const body = {
  rect: [0, 0, 10, 20] as [number, number, number, number],
  offset: [-5, -18] as [number, number],
  page: 0,
};
const shadow = {
  rect: [2, 2, 12, 7] as [number, number, number, number],
  offset: [-6, -2] as [number, number],
  page: 7,
};
const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['library:unit', 0]]),
  manifest: { spriteAtlas: { width: 64, height: 64 } },
  spriteAtlas: new Texture(),
} as unknown as Ra2Cache;

describe('live infantry footprint', () => {
  it('queues the selected shadow on its dedicated page at the body anchor through the real pool and queue', () => {
    const pool = new SpritePool();
    const entry = { frames: [body, body], shadows: [shadow, shadow], palette: 'unit', remap: true };
    const library = { library: { sprites: { 'infantry:TEST': entry } }, page: () => ({}), hasHdPage: () => true };
    const view = Object.assign(Object.create(LiveView.prototype), {
      cache,
      library,
      spritePool: pool,
      libraryPaletteKeys: new Map(),
      world: { terrain: { heightAt: () => 0 } },
    }) as {
      libraryInfantrySprites(...args: unknown[]): void;
    };
    const visual = {
      libraryType: {
        sprite: 'infantry:TEST',
        remap: true,
        drawOffset: [0, 0],
        infantry: { sequences: { Walk: { start: 0, count: 2, facingMultiplier: 0 } } },
      },
    };
    const object = { kind: 'infantry', x: 512, y: 768, z: 0, infantrySequence: 'Walk', sequenceFrame: 1 } as LiveObject;
    const batch = new Map<number, SpriteInstance[]>();
    view.libraryInfantrySprites(object, { x: 512, y: 768, z: 0, facing: 0 }, visual, batch, 1);
    const sh = batch.get(7)![0]!;
    const art = batch.get(0)![0]!;
    expect(sh).toMatchObject({ frame: shadow, shadow: true, flat: true, infantryShadow: true, push: 0 });
    expect(art.frame).toBe(body);
    expect(sh.anchor.toArray()).toEqual(art.anchor.toArray());
    expect(art.infantryShadow).toBeUndefined();
    entry.shadows[1] = { ...shadow, rect: [0, 0, 0, 0] };
    pool.begin();
    batch.clear();
    view.libraryInfantrySprites(object, { x: 512, y: 768, z: 0, facing: 0 }, visual, batch, 1);
    expect(batch.has(7)).toBe(false);
    expect(batch.get(0)).toHaveLength(1);
  });

  it('uploads an infantry-only marker without changing building/vehicle flags and clears it on pool reuse', () => {
    const pool = new SpritePool();
    const infantry = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    infantry.infantryShadow = true;
    const building = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    const vehicle = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    const layer = new SpriteLayer(cache, [infantry, building, vehicle]);
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    expect([0, 1, 2].map((i) => flags.array[i * flags.itemSize + 3])).toEqual([1, 0, 0]);
    for (const i of [1, 2])
      expect(Array.from(flags.array.slice(i * flags.itemSize, i * flags.itemSize + 8))).toEqual([
        2, 1, 0, 0, 0, 0, 0, 0,
      ]);
    expect(layer.groundPasses).toHaveLength(2);
    expect(layer.groundPasses.every((mesh) => mesh.count === 3)).toBe(true);
    const settings = {} as HdSettings;
    applyLookPreset(settings, 'cinematic');
    expect(settings.shadowFollow).toBeGreaterThan(0);
    expect(settings.shadowSoftness).toBeGreaterThan(0);
    expect(settings.shadowLength).toBeGreaterThan(1);
    expect(INFANTRY_SHADOW_OPACITY).toBe(1);
    expect(settings.infantryShadow).toBe(INFANTRY_SHADOW_SOFT_OPACITY);
    applyLookPreset(settings, 'faithful');
    expect(settings.infantryShadow).toBe(1);
    pool.begin();
    expect(pool.take(new Vector3(), shadow, 'library:unit', 0, true, true)).toBe(infantry);
    expect(infantry.infantryShadow).toBeUndefined();
    layer.mesh.geometry.dispose();
    layer.mesh.material.dispose();
    layer.mesh.dispose();
    for (const mesh of layer.groundPasses) {
      mesh.material.dispose();
      mesh.dispose();
    }
  });

  it('ramps infantry shadow coverage to a solid core at the original blob edge and keeps a soft outer fringe', () => {
    expect(infantryShadowAlpha(0)).toBe(0);
    expect(infantryShadowAlpha(INFANTRY_SHADOW_RAMP.from)).toBe(0);
    // The upscaled mask is ~0.5 at the original blob's edge: that edge is already the full core opacity.
    expect(infantryShadowAlpha(0.5)).toBeCloseTo(INFANTRY_SHADOW_OPACITY, 10);
    expect(infantryShadowAlpha(1)).toBeCloseTo(INFANTRY_SHADOW_OPACITY, 10);
    const fringe = infantryShadowAlpha(0.2);
    expect(fringe).toBeGreaterThan(0);
    expect(fringe).toBeLessThan(INFANTRY_SHADOW_OPACITY);
    let previous = 0;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const a = infantryShadowAlpha(c);
      expect(a).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = a;
    }
  });

  it('leaves no bright ground in a covered palette-index-12 contact core', () => {
    // Alpha is applied in linear light. Even 0.96 transmits bright pavement; the native indexed pixel is solid.
    for (const ground of [0.05, 0.5, 1, 4]) {
      for (const coverage of [INFANTRY_SHADOW_RAMP.to, 0.5, 1]) {
        expect(ground * (1 - infantryShadowAlpha(coverage))).toBe(0);
      }
      expect(ground * (1 - infantryShadowAlpha(0))).toBe(ground);
    }
  });

  it("keeps the original's solid footprint in the faithful looks and draws it as a shadow in the cinematic one", () => {
    // Frozen same-frame pairs (snow and temperate): the original's footprint is black, 0.00 of the ground.
    expect(INFANTRY_SHADOW_OPACITY).toBe(1);
    expect(shadowDisplayRatio(infantryShadowAlpha(1))).toBe(0);
    for (const preset of ['faithful', 'golden'] as const) expect(LOOK_PRESETS[preset].settings.infantryShadow).toBe(1);
    // The cinematic look: half the displayed ground, the engine's shadow, exactly like a vehicle's contact shadow.
    const soft = LOOK_PRESETS.cinematic.settings.infantryShadow;
    expect(soft).toBe(INFANTRY_SHADOW_SOFT_OPACITY);
    expect(soft).toBe(ENGINE_SHADOW_OPACITY);
    expect(soft).toBe(CONTACT_SHADOW_OPACITY);
    for (const coverage of [INFANTRY_SHADOW_RAMP.to, 0.5, 1]) {
      const alpha = infantryShadowAlpha(coverage, soft);
      expect(alpha).toBeCloseTo(soft, 12);
      expect(shadowDisplayRatio(alpha)).toBeCloseTo(0.5, 12);
      // Whatever the ground: snow, grass, sand or paving transmit the same share, never none.
      for (const ground of [0.05, 0.5, 1, 4]) expect(ground * (1 - alpha)).toBeCloseTo(ground * 0.5 ** 2.2, 12);
    }
    // Shape and fringe are the footprint's own in both: only the core's opacity differs.
    for (const coverage of [0, 0.02, 0.1, 0.2, 0.5, 1])
      expect(infantryShadowAlpha(coverage, soft)).toBeCloseTo(infantryShadowAlpha(coverage) * soft, 12);
  });

  it('reads the footprint opacity in the sprite shader, from the look of the renderer that owns the sprites', () => {
    const nodes = new AtmosphereNodes();
    const look = spriteLookFor(nodes);
    expect(look.infantryShadow.value).toBe(1);
    const pool = new SpritePool();
    const infantry = pool.take(new Vector3(), shadow, 'library:unit', 0, true, true);
    infantry.infantryShadow = true;
    const paletteAtlas = new DataTexture(new Uint8Array(256 * 4), 256, 1);
    const layer = new SpriteLayer({ ...cache, nodes, paletteAtlas } as unknown as Ra2Cache, [infantry]);
    // r186's own WGSL builder (no device): the uniforms the fragment shader binds are the ones its code reads.
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const backend = renderer.backend as unknown as {
      createNodeBuilder(
        mesh: Mesh,
        renderer: WebGPURenderer,
      ): {
        camera: OrthographicCamera;
        scene: Scene;
        build(): void;
        fragmentShader: string;
        getBindings(): { bindings: { uniforms?: { nodeUniform?: { node: unknown } }[] }[] }[];
      };
    };
    const builder = backend.createNodeBuilder(new Mesh(layer.mesh.geometry, layer.mesh.material), renderer);
    builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    builder.scene = new Scene();
    builder.build();
    const read = builder
      .getBindings()
      .flatMap((group) => group.bindings)
      .flatMap((binding) => (binding.uniforms ?? []).map((uniform) => uniform.nodeUniform?.node));
    expect(read).toContain(look.infantryShadow);
    expect(builder.fragmentShader).toContain('spriteInfantryShadowAlpha');
    // Another renderer's look is another uniform: its setting does not reach these sprites.
    const other = new AtmosphereNodes();
    expect(read).not.toContain(spriteLookFor(other).infantryShadow);
    other.dispose();
    layer.mesh.geometry.dispose();
    layer.mesh.material.dispose();
    layer.mesh.dispose();
    for (const mesh of layer.groundPasses) {
      mesh.material.dispose();
      mesh.dispose();
    }
    paletteAtlas.dispose();
    nodes.dispose();
  });

  it('places the solid core ahead of ordinary shadows but behind reflections and upright feet', () => {
    // LessDepth must admit an infantry core after a fully covered building/vehicle SHP shadow on the same plane.
    const range = 400;
    const depth = (pull: number) => 0.5 - pull / range;
    expect(depth(GROUND_PULL.infantryCore)).toBeLessThan(depth(GROUND_PULL.shadow[1]));
    expect(depth(GROUND_PULL.infantryCore)).toBeGreaterThan(depth(GROUND_PULL.reflection));
    expect(depth(GROUND_PULL.infantryCore)).toBeGreaterThan(depth(CARD_CLEARANCE));
  });
});
