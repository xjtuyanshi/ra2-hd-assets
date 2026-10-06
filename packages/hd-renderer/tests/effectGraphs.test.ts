import { describe, expect, it } from 'vitest';
import { DataTexture, LinearFilter, type Mesh, type MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import { EffectSpriteLayer, MESH_IDLE_SECONDS, type EffectInstance, type EffectPage } from '../src/live/effectSprites';
import type { InstancedQuad } from '../src/instancedQuad';
import { bindSlots, hasSlotBinder } from '../src/materialSlots';
import type { Ra2Cache } from '../src/ra2/cache';

/** three r186's builder cache key of a mesh: node graph, material state, geometry layout, pass, uuid when count > 1. */
const builderKey = (mesh: Mesh): number =>
  RenderObject.prototype.getMaterialCacheKey.call({
    object: mesh,
    material: mesh.material,
    geometry: mesh.geometry,
    renderer: { backend: { isWebGPUBackend: true } },
    clippingContextCacheKey: '',
    context: { id: 3 },
    getGeometryCacheKey: RenderObject.prototype.getGeometryCacheKey,
  });

function page(width: number, height: number, filtered = false): EffectPage {
  const texture = new DataTexture(new Uint8Array(width * height * 4), width, height);
  if (filtered) texture.magFilter = texture.minFilter = LinearFilter;
  return { texture, width, height };
}

function card(pageIndex: number, pass: EffectInstance['pass'] = 'air', alpha = 1): EffectInstance {
  return {
    anchor: new Vector3(1, 0, 1),
    frame: { rect: [0, 0, 16, 16], offset: [-8, -8], page: pageIndex },
    palette: 'fx:anim',
    alpha,
    push: 0,
    draw: 'card',
    pass,
    depth: 0,
    glow: false,
  };
}

function hdCard(pageIndex: number): EffectInstance {
  return {
    ...card(0),
    hd: {
      frame: { page: pageIndex, rect: [0, 0, 32, 32], offset: [-8, -8] },
      next: null,
      scale: 2,
      blend0: 0,
      t0: 0,
      stageSeconds: 0.1,
    },
  };
}

function fixture() {
  const palette = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  const cache = { paletteAtlas: palette, paletteRow: new Map([['fx:anim', 0]]) } as unknown as Ra2Cache;
  // Effect pages differ in height (the library's 48 pages have 40 different sizes).
  const pages = [page(4096, 828), page(4096, 3908), page(1024, 512)];
  const hdPages = [page(4096, 2048, true), page(4096, 256, true)];
  const released: number[] = [];
  const layer = new EffectSpriteLayer(
    cache,
    (index) => pages[index] ?? null,
    (index) => void released.push(index),
    (index) => hdPages[index] ?? null,
  );
  const meshes = () => layer.root.children as InstancedQuad[];
  return { layer, pages, hdPages, released, meshes };
}

describe('effect pages share shader graphs', () => {
  it('draws pages of every size with clones of one material per kind and pass', () => {
    const { layer, meshes } = fixture();
    layer.setInstances([card(0), card(1), card(2), card(0, 'ground'), hdCard(0), hdCard(1)], 0);
    const air = meshes().filter((mesh) => mesh.name === 'live-effects-air');
    const ground = meshes().filter((mesh) => mesh.name === 'live-effects-ground');
    const hd = meshes().filter((mesh) => mesh.name === 'live-effects-hd-air');
    expect([air.length, ground.length, hd.length]).toEqual([3, 1, 2]);
    for (const group of [air, hd]) {
      for (const mesh of group) {
        expect(hasSlotBinder(mesh.material)).toBe(true);
        // Three builds one shader for the whole group: same node graph, state and attribute layout, no uuid.
        expect(builderKey(mesh)).toBe(builderKey(group[0]!));
        expect(mesh.count).toBe(1);
        expect(mesh.instances).toBe(1);
      }
      expect(new Set(group.map((mesh) => mesh.material)).size).toBe(group.length);
      expect(new Set(group.map((mesh) => mesh.geometry)).size).toBe(group.length);
    }
    // Another pass and another kind of page are other shaders.
    expect(builderKey(ground[0]!)).not.toBe(builderKey(air[0]!));
    expect(builderKey(hd[0]!)).not.toBe(builderKey(air[0]!));
    // Translucent cards switch the mesh to the translucent graph's clone: one more shader, shared the same way.
    layer.setInstances([card(0, 'air', 0.5), card(1, 'air', 0.5), card(2)], 1);
    const [a, b, c] = meshes().filter((mesh) => mesh.name === 'live-effects-air') as [Mesh, Mesh, Mesh];
    expect(builderKey(a)).toBe(builderKey(b));
    expect(builderKey(a)).not.toBe(builderKey(c));
    layer.setInstances([], Infinity);
  });

  it('binds each mesh to its own page and atlas size before it is drawn', () => {
    const { layer, pages, meshes } = fixture();
    layer.setInstances([card(0), card(1)], 0);
    const [first, second] = meshes() as [InstancedQuad, InstancedQuad];
    const read = (mesh: InstancedQuad) => {
      (mesh.onBeforeRender as unknown as (...args: unknown[]) => void).call(
        mesh,
        null,
        null,
        null,
        null,
        mesh.material,
      );
      const graph = (
        layer as unknown as { graphs: Map<string, { atlas: { value: unknown }; atlasSize: { value: Vector3 } }> }
      ).graphs;
      const [entry] = [...graph.values()];
      return { texture: entry!.atlas.value, size: [entry!.atlasSize.value.x, entry!.atlasSize.value.y] };
    };
    expect(read(first)).toEqual({ texture: pages[0]!.texture, size: [4096, 828] });
    expect(read(second)).toEqual({ texture: pages[1]!.texture, size: [4096, 3908] });
    expect(read(first)).toEqual({ texture: pages[0]!.texture, size: [4096, 828] });
    layer.setInstances([], Infinity);
  });

  it('keeps an idle mesh for the next page of its kind instead of disposing it', () => {
    const { layer, pages, released, meshes } = fixture();
    layer.setInstances([card(0), hdCard(0)], 0);
    const [indexed, hd] = meshes() as [InstancedQuad, InstancedQuad];
    const disposed: string[] = [];
    for (const mesh of [indexed, hd]) {
      mesh.material.addEventListener('dispose', () => disposed.push(mesh.name));
      mesh.geometry.addEventListener('dispose', () => disposed.push(`${mesh.name} geometry`));
    }
    // Idle for longer than MESH_IDLE_SECONDS: out of the scene, pages released, nothing disposed.
    layer.setInstances([], 1);
    layer.setInstances([], MESH_IDLE_SECONDS + 2);
    expect(meshes()).toHaveLength(0);
    expect(released).toEqual([0]);
    expect(disposed).toEqual([]);
    // Another page of the same kind and pass draws with the same mesh and material (three keeps its built shader).
    layer.setInstances([card(1)], MESH_IDLE_SECONDS + 3);
    expect(meshes()).toEqual([indexed]);
    expect(indexed.instances).toBe(1);
    expect(indexed.visible).toBe(true);
    bindSlots(indexed.material);
    const graphs = (
      layer as unknown as { graphs: Map<string, { atlas: { value: unknown }; atlasSize: { value: Vector3 } }> }
    ).graphs;
    const air = [...graphs.entries()].find(([key]) => key.startsWith('indexed:air'))![1];
    expect(air.atlas.value).toBe(pages[1]!.texture);
    expect([air.atlasSize.value.x, air.atlasSize.value.y]).toEqual([4096, 3908]);
    // A page in another pass is another kind of mesh: the spare one is not taken for it.
    layer.setInstances([card(1), card(2, 'ground')], MESH_IDLE_SECONDS + 4);
    expect(meshes()).toHaveLength(2);
    expect(meshes()[1]).not.toBe(hd);
    // Emptying the layer for good disposes what is drawn and what was kept.
    layer.setInstances([], Infinity);
    expect(meshes()).toHaveLength(0);
    expect(disposed).toEqual(
      expect.arrayContaining(['live-effects-air', 'live-effects-air geometry', 'live-effects-hd-air']),
    );
  });
});
