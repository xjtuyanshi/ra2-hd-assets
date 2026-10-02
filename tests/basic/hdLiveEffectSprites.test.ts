/**
 * HD live view: the native effect card layer's bookkeeping (no GPU): one backdrop copy node for every page mesh,
 * opaque meshes without it, empty meshes hidden, failed pages settled and idle meshes evicted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EffectSpriteLayer,
  MESH_IDLE_SECONDS,
  type EffectInstance,
  type EffectPage,
} from '../../packages/hd-renderer/src/live/effectSprites';
import { ShroudLayer } from '../../packages/hd-renderer/src/live/shroud';
import { cellToWorld } from '../../packages/hd-renderer/src/world';
import type { Ra2Cache } from '../../packages/hd-renderer/src/ra2/cache';

/** Any texture will do for building node materials; the shroud layer owns a small DataTexture. */
const page = (): EffectPage => ({ texture: new ShroudLayer(1, 1).texture, width: 64, height: 64 });
const cache = { paletteAtlas: { image: { height: 4 } }, paletteRow: new Map([['fx:anim', 1]]) } as unknown as Ra2Cache;
const card = (pageIndex: number, alpha: number, pass: EffectInstance['pass'] = 'air'): EffectInstance => ({
  anchor: cellToWorld(1, 1, 0),
  frame: { rect: [0, 0, 8, 8], offset: [-4, -4], page: pageIndex },
  palette: 'fx:anim',
  alpha,
  push: 0.1,
  draw: 'card',
  pass,
  depth: 0,
  glow: false,
});
type Internal = {
  meshes: Map<string, { mesh: { visible: boolean; material: { colorNode: unknown } }; translucent: boolean }>;
};

describe('EffectSpriteLayer', () => {
  it('shares one backdrop node, uses it only for translucent cards and hides empty meshes', () => {
    const layer = new EffectSpriteLayer(cache, () => page());
    expect(layer.setInstances([card(0, 1), card(1, 0.5)], 10)).toBe(true);
    const meshes = (layer as unknown as Internal).meshes;
    const opaque = meshes.get('0:air')!;
    const translucent = meshes.get('1:air')!;
    expect(opaque.translucent).toBe(false);
    expect(translucent.translucent).toBe(true);
    expect(opaque.mesh.material).not.toBe(translucent.mesh.material);
    expect(layer.meshStats()).toEqual({ meshes: 2, visible: 2, translucent: 1 });
    // A translucent card appears on the opaque page: that mesh switches to its display-space material.
    layer.setInstances([card(0, 0.25), card(1, 1)], 11);
    expect(layer.meshStats()).toEqual({ meshes: 2, visible: 2, translucent: 1 });
    expect(meshes.get('0:air')!.translucent).toBe(true);
    layer.setInstances([], 12);
    expect(layer.meshStats()).toEqual({ meshes: 2, visible: 0, translucent: 0 });
  });

  it('keeps asking while a page loads, but settles a page that failed (no rebuild every frame)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let state: 'loading' | null = 'loading';
    const layer = new EffectSpriteLayer(cache, () => state);
    expect(layer.setInstances([card(3, 1)], 1)).toBe(false);
    state = null;
    expect(layer.setInstances([card(3, 1)], 2)).toBe(true);
    expect(layer.setInstances([card(3, 1)], 3)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('disposes meshes left empty for MESH_IDLE_SECONDS and releases pages no mesh uses', () => {
    const released: number[] = [];
    const layer = new EffectSpriteLayer(
      cache,
      () => page(),
      (p) => released.push(p),
    );
    layer.setInstances([card(0, 1, 'air'), card(0, 1, 'ground'), card(2, 1)], 0);
    // Page 0 is still drawn in the ground pass: its air mesh goes, the page stays.
    layer.setInstances([card(0, 1, 'ground')], MESH_IDLE_SECONDS + 1);
    expect(layer.meshStats().meshes).toBe(1);
    expect(released).toEqual([2]);
    layer.setInstances([], 2 * MESH_IDLE_SECONDS + 2);
    expect(layer.meshStats().meshes).toBe(0);
    expect(released).toEqual([2, 0]);
  });
});
