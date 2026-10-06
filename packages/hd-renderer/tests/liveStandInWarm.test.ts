import { describe, expect, it, vi } from 'vitest';
import { DataTexture, Group, type Mesh, NearestFilter, RedFormat, type Texture, UnsignedByteType } from 'three/webgpu';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import { AtmosphereNodes } from '../src/atmosphere';
import type { InstancedQuad } from '../src/instancedQuad';
import { LiveView } from '../src/live/liveView';
import { hasSlotBinder, samplingClass } from '../src/materialSlots';
import type { Ra2Cache } from '../src/ra2/cache';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { SpriteLayer } from '../src/ra2/sprites';
import { TERRAIN_DEPTH_LAYER, TerrainDepth } from '../src/terrainDepth';

/** three r186's builder cache key of a mesh: node graph, material state, geometry layout, pass, uuid when count > 1. */
const builderKey = (mesh: Mesh): number =>
  RenderObject.prototype.getMaterialCacheKey.call({
    object: mesh,
    material: mesh.material,
    geometry: mesh.geometry,
    renderer: { backend: { isWebGPUBackend: true } },
    clippingContextCacheKey: '',
    context: { id: 5 },
    getGeometryCacheKey: RenderObject.prototype.getGeometryCacheKey,
  });

const passes = (layer: SpriteLayer): InstancedQuad[] => [
  layer.mesh,
  layer.readOnlyMesh,
  layer.unitMesh,
  layer.translucentMesh,
  ...layer.groundPasses,
];

/** An indexed library page as loadIndexedPage makes it: one channel, never filtered. */
function indexedPage(size: number) {
  const texture = new DataTexture(new Uint8Array(size * size), size, size, RedFormat, UnsignedByteType);
  texture.magFilter = texture.minFilter = NearestFilter;
  return { texture, width: size, height: size };
}

/** A lit-window mask as loadMaskTexture makes it. */
function mask(): Texture {
  const texture = new DataTexture(new Uint8Array(16 * 4), 4, 4);
  texture.magFilter = texture.minFilter = NearestFilter;
  return texture;
}

function cache(): Ra2Cache {
  const atlas = new DataTexture(new Uint8Array(256 * 4 * 4), 256, 4);
  return {
    nodes: new AtmosphereNodes(),
    manifest: {
      grid: { width: 2, height: 2 },
      theater: 'temperate',
      sprites: {},
      spriteAtlas: { width: 256, height: 4 },
    },
    spriteAtlas: atlas,
    paletteAtlas: atlas,
    paletteRow: new Map(),
    mapLight: new MapLightGrade(
      { width: 2, height: 2, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
      { ambient: 1, level: 0, ground: 0, red: 1, green: 1, blue: 1 },
    ),
  } as unknown as Ra2Cache;
}

/** The view's own warm-up and layer selection over real sprite layers; pages and masks arrive when the test says. */
function view(night = false) {
  const pages = new Map<number, ReturnType<typeof indexedPage>>();
  const masks = new Map<number, Texture>();
  const library = {
    windows: { pages: { '3': 'windows-3.png' }, frames: {} },
    page: vi.fn((page: number) => pages.get(page) ?? null),
    hdPage: vi.fn(() => null),
    hasHdPage: vi.fn(() => true),
    hasWindowsPage: vi.fn(() => true),
    windowsPage: vi.fn((page: number) => masks.get(page) ?? null),
    hasMaterialsPage: vi.fn(() => true),
    materialsPage: vi.fn(() => null),
  };
  const terrainDepth = new TerrainDepth(1);
  const root = new Group();
  const live = Object.assign(Object.create(LiveView.prototype), {
    hd: { windowsWanted: () => night, materialsWanted: () => true, terrainDepth },
    library,
    cache: cache(),
    root,
    world: {},
    pageLayers: new Map(),
    standInWarm: new Map(),
    standInWarmPage: null,
    hiddenFromSight: false,
    newArt: 0,
    newArtPerFrame: 1,
    waitingArt: 0,
  }) as unknown as {
    warmStandIns(): void;
    pageLayer(key: number): SpriteLayer | null;
    disposeOverlayLayer(layer: SpriteLayer): void;
    standInWarm: Map<string, SpriteLayer>;
    cache: Ra2Cache;
  };
  return { live, library, pages, masks, root, terrainDepth };
}

describe('the indexed stand-in layers draw with shaders built behind the loading screen', () => {
  it('keeps one hidden, empty layer of each stand-in graph in the scene for the warm frames', () => {
    const { live, root } = view();
    live.warmStandIns();
    live.warmStandIns();
    expect([...live.standInWarm.keys()]).toEqual(['page', 'cells']);
    expect(root.children.map((child) => child.name)).toEqual(['live-warm-page', 'live-warm-cells']);
    for (const layer of live.standInWarm.values()) {
      // Hidden: an ordinary frame does not meet it. A warm frame shows what is hidden (HdRenderer.renderWarmFrame),
      // and three builds the shader and the pipeline of a mesh it meets even when it has no instance to draw.
      expect(layer.mesh.visible).toBe(false);
      expect(root.children).toContain(layer.mesh);
      for (const mesh of passes(layer)) {
        expect(mesh.instances, mesh.name).toBe(0);
        expect(hasSlotBinder(mesh.material), mesh.name).toBe(true);
      }
    }
    // The capture pass draws by layer mask: an empty sprite layer is on it only because the warm-up says so. Both
    // captured meshes of a page layer, and the mesh of a cell layer (overlay pages are registered as occluders).
    const page = live.standInWarm.get('page')!;
    const cells = live.standInWarm.get('cells')!;
    expect(page.mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(true);
    expect(page.unitMesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(true);
    expect(cells.mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(true);
    // The warm page is of an indexed page's sampling class: the shader reads it with a texel load.
    expect(samplingClass(indexedPage(4).texture)).toBe('nearest');
  });

  it("builds a page's stand-in layer with the warm layer's shaders: no new shader, no new pipeline", () => {
    const { live, pages, library } = view();
    live.warmStandIns();
    const warm = passes(live.standInWarm.get('page')!);
    const keys = warm.map(builderKey);
    expect(new Set(keys).size).toBe(6);
    // A building is placed: its indexed page is in, its HD art is not. The view builds the page's indexed layer.
    pages.set(3, indexedPage(4096));
    const standIn = live.pageLayer(-4);
    expect(standIn).not.toBeNull();
    expect(library.hdPage).not.toHaveBeenCalled();
    passes(standIn!).forEach((mesh, pass) => {
      // The same builder key as the warm layer's pass: three finds the built shader, and with the same shader text,
      // material state and vertex layout the compiled pipeline.
      expect(builderKey(mesh), mesh.name).toBe(keys[pass]);
      expect(mesh.material, mesh.name).not.toBe(warm[pass]!.material);
      expect(Object.keys(mesh.geometry.attributes).sort(), mesh.name).toEqual(
        Object.keys(warm[pass]!.geometry.attributes).sort(),
      );
    });
    // Another page's stand-in, of another size: still the same shaders.
    pages.set(7, indexedPage(2048));
    passes(live.pageLayer(-8)!).forEach((mesh, pass) => expect(builderKey(mesh), mesh.name).toBe(keys[pass]));
  });

  it("builds the stand-in of a live overlay or smudge page with the warm cell layer's shaders", () => {
    const { live } = view();
    live.warmStandIns();
    const keys = passes(live.standInWarm.get('cells')!).map(builderKey);
    // flushSmudgePages / flushOverlayPages: the page's indexed atlas, no HD art yet, no capture code of its own.
    const smudges = new SpriteLayer(live.cache, [], 64, indexedPage(1024), null);
    const overlays = new SpriteLayer(live.cache, [], 512, indexedPage(4096), null, null, null);
    for (const layer of [smudges, overlays])
      passes(layer).forEach((mesh, pass) => expect(builderKey(mesh), mesh.name).toBe(keys[pass]));
    // Not the page graph: a page layer carries a capture code per instance.
    expect(keys[0]).not.toBe(builderKey(live.standInWarm.get('page')!.mesh));
  });

  it('warms the lit-window variant as well once the hour wants the masks', () => {
    const night = view(true);
    night.live.warmStandIns();
    expect([...night.live.standInWarm.keys()]).toEqual(['page', 'page-windows', 'cells']);
    const keys = passes(night.live.standInWarm.get('page-windows')!).map(builderKey);
    // A night map: the page's stand-in is first built without its mask (a shown view does not wait for it) ...
    night.pages.set(3, indexedPage(4096));
    const plain = passes(night.live.standInWarm.get('page')!).map(builderKey);
    passes(night.live.pageLayer(-4)!).forEach((mesh, pass) => expect(builderKey(mesh), mesh.name).toBe(plain[pass]));
    // ... and rebuilt with it when the mask is in before the HD art: the other warm graph.
    night.masks.set(3, mask());
    const lit = night.live.pageLayer(-4)!;
    passes(lit).forEach((mesh, pass) => expect(builderKey(mesh), mesh.name).toBe(keys[pass]));
    expect(keys[0]).not.toBe(plain[0]);
  });

  it('gives the warm layers up with the view', () => {
    const { live, root, terrainDepth } = view();
    live.warmStandIns();
    const layers = [...live.standInWarm.values()];
    for (const layer of layers) live.disposeOverlayLayer(layer);
    expect(root.children).toHaveLength(0);
    for (const layer of layers) expect(layer.mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(false);
    terrainDepth.dispose();
  });
});
