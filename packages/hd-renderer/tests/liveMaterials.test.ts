import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Group, InstancedMesh, MeshBasicMaterial, Texture } from 'three/webgpu';
import { HdRenderer } from '../src/HdRenderer';
import { LiveView } from '../src/live/liveView';
import { SpriteLayer } from '../src/ra2/sprites';

vi.mock('../src/ra2/sprites', async (original) => ({
  ...(await original<typeof import('../src/ra2/sprites')>()),
  SpriteLayer: vi.fn(
    class {
      readonly mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 1);
      readonly capacity = 64;
      readonly setInstances = vi.fn();
    },
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

/** Run the real layer selection with only SpriteLayer construction replaced; no GPU or game art is needed. */
function presentation() {
  const look = { windows: false, materials: false };
  const available = { windows: null as Texture | null, materials: null as { texture: Texture } | null };
  const atlas = { texture: new Texture(), width: 32, height: 40 };
  const hd = { color: new Texture(), remap: new Texture() };
  const library = {
    page: vi.fn(() => atlas),
    hdPage: vi.fn(() => hd),
    hasHdPage: vi.fn(() => true),
    hasWindowsPage: vi.fn(() => true),
    windowsPage: vi.fn(() => available.windows),
    hasMaterialsPage: vi.fn(() => true),
    materialsPage: vi.fn(() => available.materials),
  };
  const view = Object.assign(Object.create(LiveView.prototype), {
    hd: { windowsWanted: () => look.windows, materialsWanted: () => look.materials },
    library,
    cache: {},
    root: new Group(),
    pageLayers: new Map(),
    overlayLayers: new Map(),
    overlayInstances: { instances: { pages: new Map([[0, []]]) } },
    uploadedOverlays: new Map(),
    overlayPagesDirty: true,
    world: {},
  }) as {
    pageLayer(key: number): SpriteLayer | null;
    root: Group;
    flushOverlayPages(): void;
    overlayLayers: Map<number, { layer: SpriteLayer; materials: boolean }>;
    overlayInstances: { instances: { pages: Map<number, unknown[]> } };
    overlayPagesDirty: boolean;
  };
  return { view, library, look, available, atlas, hd };
}

describe('live page material selection', () => {
  it('does not request materials in faithful mode or on indexed-only keys', () => {
    const p = presentation();
    p.view.pageLayer(0);
    expect(vi.mocked(SpriteLayer).mock.calls[0]!.slice(3)).toEqual([p.atlas, p.hd, null, null]);
    p.look.materials = true;
    p.view.pageLayer(-1);
    expect(vi.mocked(SpriteLayer).mock.calls[1]!.slice(3)).toEqual([p.atlas, null, null, null]);
    expect(p.library.hasMaterialsPage).not.toHaveBeenCalled();
    expect(p.library.materialsPage).not.toHaveBeenCalled();
  });

  it('keeps drawing while material data loads, then replaces and disposes the old mesh once', () => {
    const p = presentation();
    const first = p.view.pageLayer(0)!;
    const geometry = vi.spyOn(first.mesh.geometry, 'dispose');
    const material = vi.spyOn(first.mesh.material as MeshBasicMaterial, 'dispose');
    const mesh = vi.spyOn(first.mesh, 'dispose');
    p.look.materials = true;
    expect(p.view.pageLayer(0)).toBe(first);
    expect(p.view.pageLayer(0)).toBe(first);
    expect(mesh).not.toHaveBeenCalled();
    p.available.materials = { texture: new Texture() };
    const enhanced = p.view.pageLayer(0)!;
    expect(enhanced).not.toBe(first);
    expect(vi.mocked(SpriteLayer).mock.calls[1]![6]).toBe(p.available.materials);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(mesh).toHaveBeenCalledTimes(1);
    expect(p.view.root.children).toEqual([enhanced.mesh]);
    expect(p.view.pageLayer(0)).toBe(enhanced);
    p.look.materials = false;
    expect(p.view.pageLayer(0)).toBe(enhanced);
    expect(SpriteLayer).toHaveBeenCalledTimes(2);
  });

  it('draws available colour on first enhanced use and tolerates missing or failed materials', () => {
    const p = presentation();
    p.look.materials = true;
    const first = p.view.pageLayer(0)!;
    expect(first).not.toBeNull();
    expect(vi.mocked(SpriteLayer).mock.calls[0]![6]).toBeNull();
    p.library.hasMaterialsPage.mockReturnValue(false);
    expect(p.view.pageLayer(0)).toBe(first);
    expect(p.library.materialsPage).toHaveBeenCalledTimes(1);
  });

  it('keeps both masks when windows and materials arrive in either order', () => {
    for (const first of ['windows', 'materials'] as const) {
      const p = presentation();
      p.look[first] = true;
      p.available.windows = new Texture();
      p.available.materials = { texture: new Texture() };
      p.view.pageLayer(0);
      p.look[first] = false;
      p.look[first === 'windows' ? 'materials' : 'windows'] = true;
      const combined = p.view.pageLayer(0);
      const args = vi.mocked(SpriteLayer).mock.calls.at(-1)!;
      expect(args[5]).toBe(p.available.windows);
      expect(args[6]).toBe(p.available.materials);
      expect(p.view.pageLayer(0)).toBe(combined);
    }
  });

  it('keeps the existing layer while a night mask and materials are both pending', () => {
    const p = presentation();
    const first = p.view.pageLayer(0);
    p.look.windows = p.look.materials = true;
    expect(p.view.pageLayer(0)).toBe(first);
    p.available.windows = new Texture();
    expect(p.view.pageLayer(0)).toBe(first);
    p.available.materials = { texture: new Texture() };
    expect(p.view.pageLayer(0)).not.toBe(first);
    expect(SpriteLayer).toHaveBeenCalledTimes(2);
  });
});

describe('live overlay page materials', () => {
  it('draws while loading, upgrades unchanged instances once, and retains materials after disabling the look', () => {
    const p = presentation();
    p.view.flushOverlayPages();
    const first = p.view.overlayLayers.get(0)!.layer;
    expect(p.library.materialsPage).not.toHaveBeenCalled();
    const dispose = vi.spyOn(first.mesh, 'dispose');
    const geometry = vi.spyOn(first.mesh.geometry, 'dispose');
    const material = vi.spyOn(first.mesh.material as MeshBasicMaterial, 'dispose');
    p.look.materials = true;
    p.view.flushOverlayPages();
    p.view.flushOverlayPages();
    expect(p.view.overlayPagesDirty).toBe(true);
    expect(p.view.overlayLayers.get(0)!.layer).toBe(first);
    expect(first.setInstances).toHaveBeenCalledTimes(1);
    p.available.materials = { texture: new Texture() };
    p.view.flushOverlayPages();
    const enhanced = p.view.overlayLayers.get(0)!.layer;
    expect(enhanced).not.toBe(first);
    expect(vi.mocked(SpriteLayer).mock.calls.at(-1)![6]).toBe(p.available.materials);
    expect(enhanced.setInstances).toHaveBeenCalledTimes(1);
    for (const spy of [dispose, geometry, material]) expect(spy).toHaveBeenCalledTimes(1);
    expect(p.view.root.children).toEqual([enhanced.mesh]);
    p.view.flushOverlayPages();
    p.look.materials = false;
    p.view.flushOverlayPages();
    expect(p.view.overlayPagesDirty).toBe(false);
    expect(SpriteLayer).toHaveBeenCalledTimes(2);
    expect(enhanced.setInstances).toHaveBeenCalledTimes(1);
    // Capacity growth must retain the already loaded sidecar even after the enhanced look is disabled.
    p.view.overlayInstances.instances.pages.set(0, Array(65).fill({}));
    p.view.flushOverlayPages();
    expect(vi.mocked(SpriteLayer).mock.calls.at(-1)![6]).toBe(p.available.materials);
  });

  it('stops retrying absent/failed material pages without rebuilding the colour-only layer', () => {
    const p = presentation();
    p.look.materials = true;
    p.view.flushOverlayPages();
    const first = p.view.overlayLayers.get(0)!.layer;
    expect(p.view.overlayPagesDirty).toBe(true);
    p.library.hasMaterialsPage.mockReturnValue(false);
    p.view.flushOverlayPages();
    expect(p.view.overlayPagesDirty).toBe(false);
    expect(p.view.overlayLayers.get(0)!.layer).toBe(first);
    expect(SpriteLayer).toHaveBeenCalledTimes(1);
  });
});

describe('material demand before the renderer frame', () => {
  it('requires relight, occlusion, specular or glass; shadow-only and faithful settings cost no material page', () => {
    const settings = {
      relight: 0,
      occlusion: 0,
      specular: 0,
      glass: 0,
      shadowFollow: 1,
      shadowSoftness: 1,
      wetReflections: 1,
    };
    const renderer = Object.assign(Object.create(HdRenderer.prototype), { settings }) as HdRenderer;
    expect(renderer.materialsWanted()).toBe(false);
    for (const key of ['relight', 'occlusion', 'specular', 'glass'] as const) {
      settings[key] = 0.1;
      expect(renderer.materialsWanted()).toBe(true);
      settings[key] = 0;
    }
  });
});
