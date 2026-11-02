import { describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  Group,
  LinearFilter,
  type Mesh,
  NearestFilter,
  RedFormat,
  type Texture,
  UnsignedByteType,
} from 'three/webgpu';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import { AtmosphereNodes } from '../src/atmosphere';
import type { InstancedQuad } from '../src/instancedQuad';
import { LiveView } from '../src/live/liveView';
import { hasSlotBinder, samplingClass } from '../src/materialSlots';
import type { HdAtlas, Ra2Cache } from '../src/ra2/cache';
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
const keys = (layer: SpriteLayer): number[] => passes(layer).map(builderKey);

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

/** A filtered page as loadHdTexture / loadSpriteMaterialAtlas make them (the mask of an HD pair has one channel). */
function filtered(red = false): Texture {
  const texture = red
    ? new DataTexture(new Uint8Array(4), 2, 2, RedFormat, UnsignedByteType)
    : new DataTexture(new Uint8Array(16), 2, 2);
  texture.magFilter = texture.minFilter = LinearFilter;
  return texture;
}
const hdAtlas = (paintSaturation = 1, scale?: number): HdAtlas => ({
  color: filtered(),
  remap: filtered(true),
  paintSaturation,
  ...(scale ? { scale } : {}),
});

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

type Look = { paintSaturation: number; materials: boolean; windows: boolean; supersample?: boolean };

/** The view's own warm-up and layer selection over real sprite layers; pages and masks arrive when the test says. */
function view(options: { night?: boolean; materials?: boolean; looks?: Look[] } = {}) {
  const pages = new Map<number, ReturnType<typeof indexedPage>>();
  const hd = new Map<number, HdAtlas>();
  const masks = new Map<number, Texture>();
  const normals = new Map<number, { texture: Texture }>();
  const library = {
    windows: { pages: { '3': 'windows-3.png' }, frames: {} },
    hdPageLooks: vi.fn(() => options.looks ?? []),
    page: vi.fn((page: number) => pages.get(page) ?? null),
    hdPage: vi.fn((page: number) => hd.get(page) ?? null),
    hasHdPage: vi.fn(() => true),
    hasWindowsPage: vi.fn(() => true),
    windowsPage: vi.fn((page: number) => masks.get(page) ?? null),
    hasMaterialsPage: vi.fn(() => true),
    materialsPage: vi.fn((page: number) => normals.get(page) ?? null),
  };
  const terrainDepth = new TerrainDepth(1);
  const root = new Group();
  const live = Object.assign(Object.create(LiveView.prototype), {
    hd: { windowsWanted: () => !!options.night, materialsWanted: () => options.materials !== false, terrainDepth },
    library,
    cache: cache(),
    root,
    world: {},
    pageLayers: new Map(),
    standInWarm: new Map(),
    standInWarmPage: null,
    standInWarmHd: null,
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
  return { live, library, pages, hd, masks, normals, root, terrainDepth };
}

const PLAIN: Look = { paintSaturation: 1, materials: false, windows: false };
const WITH_MATERIALS: Look = { paintSaturation: 1, materials: true, windows: false };

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
    const warmKeys = warm.map(builderKey);
    expect(new Set(warmKeys).size).toBe(6);
    // A building is placed: its indexed page is in, its HD art is not. The view builds the page's indexed layer.
    pages.set(3, indexedPage(4096));
    const standIn = live.pageLayer(-4);
    expect(standIn).not.toBeNull();
    expect(library.hdPage).not.toHaveBeenCalled();
    passes(standIn!).forEach((mesh, pass) => {
      // The same builder key as the warm layer's pass: three finds the built shader, and with the same shader text,
      // material state and vertex layout the compiled pipeline.
      expect(builderKey(mesh), mesh.name).toBe(warmKeys[pass]);
      expect(mesh.material, mesh.name).not.toBe(warm[pass]!.material);
      expect(Object.keys(mesh.geometry.attributes).sort(), mesh.name).toEqual(
        Object.keys(warm[pass]!.geometry.attributes).sort(),
      );
    });
    // Another page's stand-in, of another size: still the same shaders.
    pages.set(7, indexedPage(2048));
    expect(keys(live.pageLayer(-8)!)).toEqual(warmKeys);
  });

  it("builds the stand-in of a live overlay or smudge page with the warm cell layer's shaders", () => {
    const { live } = view();
    live.warmStandIns();
    const warmKeys = keys(live.standInWarm.get('cells')!);
    // flushSmudgePages / flushOverlayPages: the page's indexed atlas, no HD art yet, no capture code of its own.
    const smudges = new SpriteLayer(live.cache, [], 64, indexedPage(1024), null);
    const overlays = new SpriteLayer(live.cache, [], 512, indexedPage(4096), null, null, null);
    for (const layer of [smudges, overlays]) expect(keys(layer)).toEqual(warmKeys);
    // Not the page graph: a page layer carries a capture code per instance.
    expect(warmKeys[0]).not.toBe(builderKey(live.standInWarm.get('page')!.mesh));
  });

  it('warms the lit-window variant as well once the hour wants the masks', () => {
    const night = view({ night: true });
    night.live.warmStandIns();
    expect([...night.live.standInWarm.keys()]).toEqual(['page', 'page-windows', 'cells']);
    const lit = keys(night.live.standInWarm.get('page-windows')!);
    // A night map: the page's stand-in is first built without its mask (a shown view does not wait for it) ...
    night.pages.set(3, indexedPage(4096));
    const plain = keys(night.live.standInWarm.get('page')!);
    expect(keys(night.live.pageLayer(-4)!)).toEqual(plain);
    // ... and rebuilt with it when the mask is in before the HD art: the other warm graph.
    night.masks.set(3, mask());
    expect(keys(night.live.pageLayer(-4)!)).toEqual(lit);
    expect(lit[0]).not.toBe(plain[0]);
  });

  it('gives the warm layers up with the view', () => {
    const { live, root, terrainDepth } = view({ looks: [WITH_MATERIALS] });
    live.warmStandIns();
    const layers = [...live.standInWarm.values()];
    expect(layers).toHaveLength(8);
    for (const layer of layers) live.disposeOverlayLayer(layer);
    expect(root.children).toHaveLength(0);
    for (const layer of layers) expect(layer.mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(false);
    terrainDepth.dispose();
  });
});

describe('the final layers of a library page draw with shaders built behind the loading screen', () => {
  it('keeps a hidden layer for every look the HD pages of the library can have', () => {
    // Some pages have a material page and some do not (the stock libraries: 22 to 24 pages with, 6 to 9 without).
    const day = view({ looks: [WITH_MATERIALS, PLAIN] });
    day.live.warmStandIns();
    day.live.warmStandIns();
    expect([...day.live.standInWarm.keys()]).toEqual([
      'page',
      'cells',
      // The stand-ins with a material page that came before the HD art.
      'page-materials',
      'cells-materials',
      'page-hd1',
      'cells-hd1',
      'page-hd1-materials',
      'cells-hd1-materials',
    ]);
    for (const layer of day.live.standInWarm.values()) {
      expect(layer.mesh.visible).toBe(false);
      for (const mesh of passes(layer)) expect(mesh.instances, mesh.name).toBe(0);
    }
    // A look that does not want material pages (faithful) builds none of their shaders.
    const faithful = view({ looks: [WITH_MATERIALS], materials: false });
    faithful.live.warmStandIns();
    expect([...faithful.live.standInWarm.keys()]).toEqual(['page', 'cells', 'page-hd1', 'cells-hd1']);
    // A library without HD art has only the stand-in graphs, which are then the final ones.
    const indexedOnly = view();
    indexedOnly.live.warmStandIns();
    expect([...indexedOnly.live.standInWarm.keys()]).toEqual(['page', 'cells']);
    // Another house-paint saturation is another shader.
    const muted = view({ looks: [PLAIN, { ...PLAIN, paintSaturation: 0.7 }], materials: false });
    muted.live.warmStandIns();
    expect([...muted.live.standInWarm.keys()]).toEqual([
      'page',
      'cells',
      'page-hd1',
      'cells-hd1',
      'page-hd0.7',
      'cells-hd0.7',
    ]);
    expect(keys(muted.live.standInWarm.get('page-hd0.7')!)).not.toEqual(keys(muted.live.standInWarm.get('page-hd1')!));
  });

  it("moves a page from its stand-in to the HD layer with the warm layer's shaders, then to the material one", () => {
    const { live, pages, hd, normals } = view({ looks: [WITH_MATERIALS] });
    live.warmStandIns();
    const plain = keys(live.standInWarm.get('page-hd1')!);
    const lit = keys(live.standInWarm.get('page-hd1-materials')!);
    expect(new Set([...plain, ...lit]).size).toBe(12);
    pages.set(3, indexedPage(4096));
    // The HD art arrives after the view was shown, its material page later still: the layer is built without the
    // material page first (a shown view does not wait for it) and once more with it. Both are warm graphs.
    hd.set(3, hdAtlas());
    const first = live.pageLayer(3)!;
    expect(keys(first)).toEqual(plain);
    normals.set(3, { texture: filtered() });
    const second = live.pageLayer(3)!;
    expect(second).not.toBe(first);
    expect(keys(second)).toEqual(lit);
    // Their vertex layout is the warm layer's too (the capture code is one more scalar per instance).
    passes(second).forEach((mesh, pass) =>
      expect(Object.keys(mesh.geometry.attributes).sort(), mesh.name).toEqual(
        Object.keys(passes(live.standInWarm.get('page-hd1-materials')!)[pass]!.geometry.attributes).sort(),
      ),
    );
  });

  it('warms the supersampled graph of pages above 2x and builds a 4x page layer with it', () => {
    const { live, pages, hd } = view({ looks: [PLAIN, { ...PLAIN, supersample: true }], materials: false });
    live.warmStandIns();
    expect([...live.standInWarm.keys()]).toEqual([
      'page',
      'cells',
      'page-hd1',
      'cells-hd1',
      'page-hd1-ss',
      'cells-hd1-ss',
    ]);
    const plain = keys(live.standInWarm.get('page-hd1')!);
    const supersampled = keys(live.standInWarm.get('page-hd1-ss')!);
    expect(supersampled).not.toEqual(plain);
    pages.set(3, indexedPage(4096));
    hd.set(3, hdAtlas(1, 4));
    expect(keys(live.pageLayer(3)!)).toEqual(supersampled);
    pages.set(5, indexedPage(4096));
    // A declared 2x page (and one without a declared scale) keeps the single-sample shader.
    hd.set(5, hdAtlas(1, 2));
    expect(keys(live.pageLayer(5)!)).toEqual(plain);
  });

  it("builds the HD layer of an overlay or smudge page with the warm cell layers' shaders", () => {
    const { live } = view({ looks: [WITH_MATERIALS] });
    live.warmStandIns();
    // flushSmudgePages: atlas + HD art; flushOverlayPages: the same, and with the material page once it is in.
    const smudges = new SpriteLayer(live.cache, [], 64, indexedPage(1024), hdAtlas());
    const overlays = new SpriteLayer(live.cache, [], 512, indexedPage(4096), hdAtlas(), null, null);
    const shaded = new SpriteLayer(live.cache, [], 512, indexedPage(4096), hdAtlas(), null, { texture: filtered() });
    expect(keys(smudges)).toEqual(keys(live.standInWarm.get('cells-hd1')!));
    expect(keys(overlays)).toEqual(keys(live.standInWarm.get('cells-hd1')!));
    expect(keys(shaded)).toEqual(keys(live.standInWarm.get('cells-hd1-materials')!));
    for (const key of ['cells-hd1', 'cells-hd1-materials'])
      expect(live.standInWarm.get(key)!.mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER)).toBe(true);
  });

  it('adds the lit-window looks at night, for the pages that have a mask', () => {
    const looks = [{ ...WITH_MATERIALS, windows: true }, PLAIN];
    const night = view({ night: true, looks });
    night.live.warmStandIns();
    expect([...night.live.standInWarm.keys()]).toEqual([
      'page',
      'page-windows',
      'cells',
      'page-materials',
      'cells-materials',
      'page-windows-materials',
      'page-hd1',
      'cells-hd1',
      'page-hd1-materials',
      'cells-hd1-materials',
      'page-hd1-windows',
      'page-hd1-windows-materials',
    ]);
    night.pages.set(3, indexedPage(4096));
    night.hd.set(3, hdAtlas());
    night.masks.set(3, mask());
    night.normals.set(3, { texture: filtered() });
    expect(keys(night.live.pageLayer(3)!)).toEqual(keys(night.live.standInWarm.get('page-hd1-windows-materials')!));
    // By day the same library warms no mask shader.
    const day = view({ looks });
    day.live.warmStandIns();
    expect([...day.live.standInWarm.keys()].filter((key) => key.includes('windows'))).toEqual([]);
  });
});
