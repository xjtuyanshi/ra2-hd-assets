import { BuildingLightGate } from '../../packages/hd-renderer/src/live/buildingLights';
import { describe, expect, it, vi } from 'vitest';
import type { LibraryOverlay, LibrarySmudge, TypeLibrary } from '../../packages/ra2-assets/src/library';
import type { MapObject, SpriteEntry, SpriteFrame } from '../../packages/ra2-assets/src/manifest';
import type { Ra2Cache } from '../../packages/hd-renderer/src/ra2/cache';
import { SpriteLayer, type SpriteInstance } from '../../packages/hd-renderer/src/ra2/sprites';
import { LiveView, type LiveSnapshot } from '../../packages/hd-renderer/src/live/liveView';
import { OverlayInstanceCache, type OverlayTerrain } from '../../packages/hd-renderer/src/live/overlays';
import { ShroudLayer } from '../../packages/hd-renderer/src/live/shroud';
import { SpritePool } from '../../packages/hd-renderer/src/live/spritePool';
import {
  buildSmudgeInstances,
  SmudgeInstanceCache,
  type LiveSmudgeCells,
  type SmudgePage,
} from '../../packages/hd-renderer/src/live/smudges';
import { VolumetricBlastLayer } from '../../packages/hd-renderer/src/volumetricBlasts';
import { LEVEL_HEIGHT } from '../../packages/hd-renderer/src/world';

const frame = (page: number, n = 0): SpriteFrame => ({ rect: [n * 8, 0, 8, 8], offset: [-4, 0], page });
const sprite = (page: number): SpriteEntry => ({
  palette: 'iso',
  remap: false,
  canvas: [60, 30],
  frames: [frame(page), frame(page, 1)],
});
const smudge = (id: string, width = 1, height = 1): LibrarySmudge => ({
  sprite: `smudge:${id}`,
  width,
  height,
  frames: 2,
  palette: 'iso',
  remap: false,
  flat: true,
  drawOffset: [0, 0],
  lighting: 'full',
});
const library = () => ({
  smudges: { CR1: smudge('CR1'), BURN: smudge('BURN', 2, 2) },
  sprites: { 'smudge:CR1': sprite(1), 'smudge:BURN': sprite(2) },
});
const terrain = (): OverlayTerrain => ({
  width: 8,
  height: 8,
  levels: new Uint8Array(64).fill(2),
  exists: new Uint8Array(64).fill(1),
});
const cells = (): LiveSmudgeCells => ({
  originX: 1,
  originY: 2,
  width: 2,
  height: 2,
  index: new Int16Array([0, -1, -1, -1]),
  data: new Uint8Array(4),
  types: ['CR1', 'BURN'],
  revision: 1,
});
const palette = (key: string, fromLibrary: boolean): string => `${fromLibrary ? 'lib:' : ''}${key}`;
const instances = (built: ReturnType<typeof buildSmudgeInstances>): SpriteInstance[] =>
  [...built.pages.values()].flat();

describe('native smudge instances', () => {
  it('draws body frame zero with the theater palette, terrain height/light and no remap', () => {
    const art = library();
    const built = buildSmudgeInstances(cells(), art, terrain(), {}, palette);
    const mark = instances(built)[0]!;
    expect(mark.frame).toBe(art.sprites['smudge:CR1'].frames[0]);
    expect(mark.anchor.toArray()).toEqual([1, 2 * LEVEL_HEIGHT, 2]);
    expect(mark.lightSample).toEqual([1.5, 2.5]);
    expect(mark).toMatchObject({ flat: true, push: 0, palette: 'lib:iso', lighting: 'full', shadow: false });
    expect(built.missingTypes.size).toBe(0);
  });

  it('reconstructs and deduplicates a burn footprint; partial removal matches native whole-SHP drawing', () => {
    const state = cells();
    state.index.fill(1);
    state.data.set([0, 1, 2, 3]);
    const art = library();
    let built = buildSmudgeInstances(state, art, terrain(), {}, palette);
    expect(instances(built)).toHaveLength(1);
    expect(instances(built)[0]!.frame).toBe(art.sprites['smudge:BURN'].frames[0]);
    expect(instances(built)[0]!.anchor.toArray()).toEqual([1, 2 * LEVEL_HEIGHT, 2]);
    expect(instances(built)[0]!.lightSample).toEqual([2.5, 3.5]);
    // Native DrawIt clips to a tactical/dirty rectangle, not the current footprint cell. The remaining cell still
    // draws the complete source image. Removing every selector is required to remove the complete burn mark.
    state.index.set([-1, -1, -1, 1]);
    built = buildSmudgeInstances(state, art, terrain(), {}, palette);
    expect(instances(built)).toHaveLength(1);
    expect(instances(built)[0]!.anchor.toArray()).toEqual([1, 2 * LEVEL_HEIGHT, 2]);
    state.index.fill(-1);
    expect(instances(buildSmudgeInstances(state, art, terrain(), {}, palette))).toHaveLength(0);
  });

  it('rejects invalid footprint selectors instead of using them as frames or wrapping them', () => {
    const state = cells();
    state.index.set([0, 1, -1, -1]);
    state.data.set([1, 4, 0, 0]);
    const built = buildSmudgeInstances(state, library(), terrain(), {}, palette);
    expect(instances(built)).toHaveLength(0);
    expect([...built.missingTypes]).toEqual(['CR1', 'BURN']);
  });

  it('samples the bottommost surviving footprint cell rather than the last row-major entry', () => {
    const state = cells();
    state.width = 3;
    state.index = new Int16Array([1, 1, 1, 1, -1, -1]);
    state.data = new Uint8Array([0, 1, 2, 3, 0, 0]);
    const art = library();
    art.smudges.BURN.width = 3;
    const built = buildSmudgeInstances(state, art, terrain(), {}, palette);
    expect(instances(built)).toHaveLength(1);
    expect(instances(built)[0]!.lightSample).toEqual([3.5, 2.5]);
    state.index[2] = -1;
    state.index[3] = -1;
    expect(instances(buildSmudgeInstances(state, art, terrain(), {}, palette))[0]!.lightSample).toEqual([2.5, 2.5]);
  });

  it('keeps independently anchored marks and height planes distinct', () => {
    const state = cells();
    state.index.set([0, 0, 1, 1]);
    state.data.set([0, 0, 2, 3]);
    const ground = terrain();
    ground.levels[3 * ground.width + 2] = 3;
    const built = buildSmudgeInstances(state, library(), ground, {}, palette);
    expect(instances(built)).toHaveLength(4);
    expect(built.pages.get(1)).toHaveLength(2);
    expect(built.pages.get(2)?.map((mark) => mark.anchor.y)).toEqual([2 * LEVEL_HEIGHT, 3 * LEVEL_HEIGHT]);
  });

  it('clips to existing map cells and tolerates truncated arrays', () => {
    const state = cells();
    state.index.fill(0);
    state.data = state.data.subarray(0, 3);
    const ground = terrain();
    ground.exists[2 * ground.width + 1] = 0;
    expect(instances(buildSmudgeInstances(state, library(), ground, {}, palette))).toHaveLength(2);
    state.originX = 8;
    expect(instances(buildSmudgeInstances(state, library(), ground, {}, palette))).toHaveLength(0);
  });

  it('uses available map art with an old library and reports unknown footprint dimensions', () => {
    const map = { 'smudge:CR1': sprite(0), 'smudge:BURN': sprite(0) };
    // A reduced cache must resolve source frame zero, never accidentally use exported slot zero as another frame.
    map['smudge:CR1'].sourceFrames = [5, 0];
    const state = cells();
    state.index[1] = 1;
    state.data[1] = 1;
    const built = buildSmudgeInstances(state, { sprites: {} }, terrain(), map, palette);
    expect(built.pages.get('map')).toHaveLength(1);
    expect(built.pages.get('map')![0]).toMatchObject({ frame: map['smudge:CR1'].frames[1], palette: 'iso' });
    expect([...built.missingTypes]).toEqual(['BURN']);
  });

  it('retains a matching shadow on its atlas page without duplicating a footprint', () => {
    const art = library();
    art.sprites['smudge:BURN'].shadows = [frame(9)];
    const state = cells();
    state.index.fill(1);
    state.data.set([0, 1, 2, 3]);
    const built = buildSmudgeInstances(state, art, terrain(), {}, palette);
    expect(built.pages.get(2)).toHaveLength(1);
    expect(built.pages.get(9)).toHaveLength(1);
    expect(built.pages.get(9)![0]).toMatchObject({ shadow: true, flat: true, lighting: 'full' });
    expect(built.pages.get(9)![0]!.anchor).toBe(built.pages.get(2)![0]!.anchor);
    expect(built.pages.get(9)![0]!.lightSample).toBe(built.pages.get(2)![0]!.lightSample);
    expect(built.pages.get(2)![0]!.lightSample).toEqual([2.5, 3.5]);
  });
});

describe('smudge revision cache', () => {
  it('reuses structured clones and rescans only revisions, bounds or art sources', () => {
    const cache = new SmudgeInstanceCache(terrain(), {});
    const state = cells();
    const art = library();
    const resolve = vi.fn(palette);
    expect(cache.update(state, art, resolve)).toBe(true);
    const original = cache.instances;
    resolve.mockClear();
    expect(cache.update(structuredClone(state), art, resolve)).toBe(false);
    expect(cache.instances).toBe(original);
    expect(resolve).not.toHaveBeenCalled();
    state.index.fill(-1);
    state.revision++;
    expect(cache.update(state, art, resolve)).toBe(true);
    expect(cache.active).toBe(true);
    expect(cache.instances.pages.size).toBe(0);
    expect(cache.update(state, { ...art }, resolve)).toBe(true);
    expect(cache.update({ ...state, originX: 2 }, art, resolve)).toBe(true);
    expect(cache.update(null, art, resolve)).toBe(true);
    expect(cache.active).toBe(false);
  });

  it('keeps an empty live grid authoritative even without a smudge library', () => {
    const cache = new SmudgeInstanceCache(terrain(), { 'smudge:CR1': sprite(0) });
    const state = cells();
    cache.update(state, null, palette);
    expect(cache.active).toBe(true);
    expect(cache.instances.pages.has('map')).toBe(true);
    state.index.fill(-1);
    state.revision++;
    cache.update(state, null, palette);
    expect(cache.active).toBe(true);
    expect(cache.instances.pages.size).toBe(0);
    cache.update(null, null, palette);
    expect(cache.active).toBe(false);
  });
});

/** Use real CPU sprite buffers and LiveView methods after construction, without starting a browser/GPU or match. */
function presentation(withLibrary = true) {
  const ground = terrain();
  const art = library();
  const cache = {
    paletteAtlas: { image: { height: 2 } },
    paletteRow: new Map([
      ['iso', 0],
      ['lib:iso', 1],
    ]),
    manifest: {
      grid: { width: 8, height: 8 },
      spriteAtlas: { width: 64, height: 64 },
      sprites: { 'smudge:CR1': sprite(0), 'overlay:TIB01': sprite(0) },
    },
    height: ground.levels,
    exists: ground.exists,
    spriteAtlas: new ShroudLayer(1, 1).texture,
    spriteAtlasHd: null,
  } as unknown as Ra2Cache;
  const mapObjects: MapObject[] = [
    { kind: 'smudge', type: 'CR1', x: 1, y: 2, z: 2, sprite: 'smudge:CR1', flat: true },
    { kind: 'overlay', type: 'TIB01', x: 2, y: 2, z: 2, sprite: 'overlay:TIB01', flat: true },
  ];
  const available = { indexed: true, hd: true, failed: false };
  const typeLibrary: Pick<TypeLibrary, 'smudges' | 'overlays' | 'sprites' | 'types'> = {
    ...(withLibrary ? art : { sprites: {} }),
    types: {},
  };
  const liveLibrary = {
    library: typeLibrary,
    revision: 0,
    page: vi.fn(() => (available.indexed ? { texture: cache.spriteAtlas, width: 64, height: 64 } : null)),
    hdPage: vi.fn(() => null),
    hasHdPage: () => !available.hd,
    pageFailed: () => available.failed,
    disposeMaterials: vi.fn(),
    disposeDepthTemplate: vi.fn(),
  };
  const cellLayer = new SpriteLayer(cache, [], 8);
  const backing = {
    buildingLightGate: new BuildingLightGate(),
    cache,
    library: liveLibrary,
    current: null,
    previous: null,
    firstFrame: null,
    appearances: new Map(),
    houseColour: new Map(),
    buildingAnimMatches: new Map(),
    visuals: new Map(),
    warnedTypes: new Set(),
    warnedSmudgeTypes: new Set(),
    warnedSmudgePages: new Set(),
    warnedOverlayTypes: new Set(),
    warnedOverlayPages: new Set(),
    overlayInstances: new OverlayInstanceCache(ground),
    smudgeInstances: new SmudgeInstanceCache(ground, cache.manifest.sprites),
    overlayLayers: new Map<number, { layer: SpriteLayer; materials: boolean }>(),
    uploadedOverlays: new Map(),
    smudgeLayers: new Map<SmudgePage, SpriteLayer>(),
    uploadedSmudges: new Map(),
    cellObjects: new Map([[1, mapObjects]]),
    cellInstances: [],
    cellPool: new SpritePool(),
    cellLayer,
    root: { add: vi.fn(), remove: vi.fn() },
    hd: {
      meanExposure: 2,
      settings: { sourceLights: 0 },
      seconds: () => 1,
      frame: vi.fn(),
      windowsWanted: () => false,
      materialsWanted: () => false,
      dispose: vi.fn(),
      renderer: { setAnimationLoop: vi.fn() },
      // Overlay pages register as always-covered terrain-class occluders for Air fire (P-L5H-3b).
      terrainDepth: { register: vi.fn(), setCaptured: vi.fn() },
    },
    effectDriver: { frame: vi.fn(), unknownTypes: new Set(), logicFps: 30 },
    volumetricBlasts: new VolumetricBlastLayer({ light: cellLayer.light, sunDirection: cellLayer.toCamera }),
    liveBeams: { update: vi.fn(), displayScale: { value: 1 }, dispose: vi.fn() },
    effectStats: { drawn: 0, missing: 0 },
    cellsFromEngine: false,
    cellsDirty: true,
    painterObjects: [],
    painterDirty: false,
    lastRender: 0,
    ensureHouse: vi.fn(),
    trackMotion: vi.fn(),
    updateNightSources: vi.fn(),
    shareSpriteUniforms: vi.fn(),
    applyCamera: vi.fn(),
    applyObjects: vi.fn(),
    applyEffects: vi.fn(),
    effectInstances: [],
    spriteBatch: new Map(),
    sprites: { mesh: { count: 0 } },
    pageLayers: new Map(),
  };
  const view = Object.assign(Object.create(LiveView.prototype), backing) as LiveView;
  const state = (): LiveSnapshot => ({ frame: 1, view: null, houses: [], objects: [], smudges: cells() });
  return { view, backing, state, available, liveLibrary, cellLayer };
}

describe('LiveView smudge integration', () => {
  it('applies ground crystal policy only to unlit flat map overlays and resets pooled records', () => {
    const p = presentation();
    const mapOre = p.backing.cellObjects.get(1)![1]!;
    mapOre.lighting = 'none';
    const shadow = p.backing.cache.manifest.sprites['overlay:TIB01']!.frames[0]!;
    p.backing.cache.manifest.sprites['overlay:TIB01']!.shadows = [shadow];
    const flush = () => (p.view as unknown as { flushCells(): void }).flushCells();
    flush();
    const instances = p.cellLayer.getInstances();
    expect(instances.map((s) => s.glint)).toEqual([undefined, undefined, 1]);
    mapOre.lighting = 'full';
    flush();
    expect(p.cellLayer.getInstances().every((s) => s.glint === undefined)).toBe(true);
    mapOre.lighting = 'none';
    mapOre.flat = false;
    flush();
    expect(p.cellLayer.getInstances().every((s) => s.glint === undefined)).toBe(true);
    p.view.dispose();
  });

  it('updates live overlay and smudge grids independently on the same logic frame', () => {
    const p = presentation();
    const overlay: LibraryOverlay = {
      sprite: 'overlay:TIB01',
      frames: 2,
      palette: 'iso',
      wall: false,
      tiberium: true,
      remap: false,
      flat: true,
      drawOffset: [0, 0],
      lighting: 'none',
    };
    p.liveLibrary.library.overlays = { TIB01: overlay };
    p.liveLibrary.library.sprites['overlay:TIB01'] = sprite(3);
    const state = { ...p.state(), overlays: { ...cells(), types: ['TIB01'], data: new Uint8Array([1, 0, 0, 0]) } };
    p.view.push(state);
    p.view.render(1);
    const ore = p.backing.overlayLayers.get(3)!.layer;
    const crater = p.backing.smudgeLayers.get(1)!;
    expect([ore.mesh.count, crater.mesh.count, p.cellLayer.mesh.count]).toEqual([1, 1, 0]);
    const oreUploads = vi.spyOn(ore, 'setInstances');
    p.view.push({ ...state, smudges: { ...state.smudges!, revision: 2, index: new Int16Array(4).fill(-1) } });
    p.view.render(2);
    expect([ore.mesh.count, crater.mesh.count]).toEqual([1, 0]);
    expect(oreUploads).not.toHaveBeenCalled();
    p.view.push({ ...state, overlays: { ...state.overlays, revision: 2, index: new Int16Array(4).fill(-1) } });
    p.view.render(3);
    expect([ore.mesh.count, crater.mesh.count]).toEqual([0, 1]);
    expect(p.view.diagnostics()).toMatchObject({ overlaysFromEngine: true, smudgesFromEngine: true });
    p.view.dispose();
  });

  it('forwards rubble through LiveView and uploads building frame three on its body and shadow pages', () => {
    const p = presentation();
    p.liveLibrary.library.overlays = {
      DEBRIS: {
        rubble: true,
        frames: 0,
        palette: 'iso',
        wall: false,
        tiberium: false,
        remap: false,
        flat: true,
        drawOffset: [0, 0],
        lighting: 'full',
      },
    };
    p.liveLibrary.library.types['SOURCE'] = {
      kind: 'building',
      image: 'SOURCE',
      sprite: 'building:SOURCE',
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
    };
    const body: SpriteEntry = {
      ...sprite(3),
      palette: 'unit',
      remap: true,
      frames: Array.from({ length: 4 }, (_, n) => frame(3, n)),
      shadows: Array.from({ length: 4 }, (_, n) => frame(4, n)),
    };
    p.liveLibrary.library.sprites['building:SOURCE'] = body;
    const overlays = { ...cells(), types: ['DEBRIS'], rubble: [{ slot: 0, type: 'SOURCE' }] };
    p.view.push(structuredClone({ ...p.state(), overlays }));
    p.view.render(1);
    const debris = p.backing.overlayLayers.get(3)!.layer;
    const shadow = p.backing.overlayLayers.get(4)!.layer;
    expect([debris.mesh.count, shadow.mesh.count]).toEqual([1, 1]);
    expect(debris.getInstances()[0]).toMatchObject({ frame: body.frames[3], palette: 'lib:iso', flat: true });
    expect(shadow.getInstances()[0]).toMatchObject({ frame: body.shadows![3], shadow: true });
    p.view.push({ ...p.state(), overlays: { ...overlays, revision: 2, rubble: [] } });
    p.view.render(2);
    expect([debris.mesh.count, shadow.mesh.count]).toEqual([0, 0]);
    expect(p.backing.smudgeLayers.get(1)!.mesh.count).toBe(1);
    p.view.dispose();
  });

  it('replaces map-start marks, accepts same-frame smudge revisions and leaves static overlays intact', () => {
    const p = presentation();
    const state = p.state();
    p.view.push(state);
    p.view.render(1);
    expect(p.cellLayer.mesh.count).toBe(1); // Map overlay remains; the map-start crater is suppressed.
    const layer = p.backing.smudgeLayers.get(1)!;
    expect(layer.mesh.count).toBe(1);
    expect(layer.mesh.renderOrder).toBeLessThan(p.cellLayer.mesh.renderOrder);
    const upload = vi.spyOn(layer, 'setInstances');
    const changed = { ...state, smudges: { ...state.smudges!, index: new Int16Array(4).fill(-1), revision: 2 } };
    p.view.push(changed);
    p.view.render(2);
    expect(layer.mesh.count).toBe(0);
    expect(p.cellLayer.mesh.count).toBe(1);
    expect(p.view.diagnostics()).toMatchObject({
      cellsFromEngine: true,
      smudgesFromEngine: true,
      overlaysFromEngine: false,
    });
    p.view.push(structuredClone(changed));
    p.view.render(3);
    expect(upload).toHaveBeenCalledTimes(1);
    p.view.push({ ...state, smudges: null });
    p.view.render(4);
    expect(p.cellLayer.mesh.count).toBe(2);
    expect(p.view.diagnostics().smudgesFromEngine).toBe(false);
    p.view.dispose();
  });

  it('warns once for a legacy library and tracks authoritative additions/removals with map art', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = presentation(false);
      const state = p.state();
      p.view.push(state);
      p.view.render(1);
      expect(p.backing.smudgeLayers.get('map')!.mesh.count).toBe(1);
      const missing = { ...state, frame: 2, smudges: { ...state.smudges!, types: ['NEW-CRATER'], revision: 2 } };
      p.view.push(missing);
      p.view.render(2);
      p.view.push({ ...missing, frame: 3, smudges: { ...missing.smudges!, revision: 3 } });
      p.view.render(3);
      expect(warning.mock.calls.filter(([text]) => String(text).includes('no smudges section'))).toHaveLength(1);
      expect(warning.mock.calls.filter(([text]) => String(text).includes('NEW-CRATER'))).toHaveLength(1);
      expect(p.backing.smudgeLayers.get('map')!.mesh.count).toBe(0);
      expect(p.cellLayer.mesh.count).toBe(1);
      expect(p.view.diagnostics().smudgeTypesWithoutArt).toEqual(['NEW-CRATER']);
      p.view.dispose();
    } finally {
      warning.mockRestore();
    }
  });

  it('retries pending pages without rebuilding the grid and disposes owned layers', () => {
    const p = presentation();
    p.available.indexed = false;
    p.view.push(p.state());
    const built = p.backing.smudgeInstances.instances;
    p.view.render(1);
    p.view.render(2);
    expect(p.backing.smudgeLayers.size).toBe(0);
    expect(p.backing.smudgeInstances.instances).toBe(built);
    p.available.indexed = true;
    p.available.hd = false;
    p.view.render(3);
    expect(p.backing.smudgeLayers.size).toBe(0);
    p.available.hd = true;
    p.view.render(4);
    const layer = p.backing.smudgeLayers.get(1)!;
    expect(layer.mesh.count).toBe(1);
    expect(p.backing.shareSpriteUniforms).toHaveBeenCalledWith(layer);
    const upload = vi.spyOn(layer, 'setInstances');
    p.view.render(5);
    expect(upload).not.toHaveBeenCalled();
    const dispose = vi.spyOn(layer.mesh.geometry, 'dispose');
    const meshDispose = vi.spyOn(layer.mesh, 'dispose');
    p.view.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(meshDispose).toHaveBeenCalledTimes(1);
    expect(p.backing.root.remove).toHaveBeenCalledWith(layer.mesh);
    expect(p.backing.smudgeLayers.size).toBe(0);
    expect(p.backing.uploadedSmudges.size).toBe(0);
    expect(p.liveLibrary.disposeMaterials).toHaveBeenCalledTimes(1);
    expect(p.liveLibrary.disposeDepthTemplate).toHaveBeenCalledTimes(1);
  });

  it('grows a page without truncating marks and disposes the replaced mesh', () => {
    const p = presentation();
    p.view.push(p.state());
    p.view.render(1);
    const before = p.backing.smudgeLayers.get(1)!;
    const disposed = vi.spyOn(before.mesh.geometry, 'dispose');
    p.liveLibrary.library.sprites['smudge:CR1']!.shadows = [frame(1)];
    const smudges = {
      ...cells(),
      originX: 0,
      originY: 0,
      width: 8,
      height: 8,
      index: new Int16Array(64),
      data: new Uint8Array(64),
      revision: 2,
    };
    p.view.push({ ...p.state(), smudges });
    p.view.render(2);
    const after = p.backing.smudgeLayers.get(1)!;
    expect(after).not.toBe(before);
    expect(after.mesh.count).toBe(128);
    expect(after.capacity).toBeGreaterThanOrEqual(128);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(p.backing.root.remove).toHaveBeenCalledWith(before.mesh);
    p.view.dispose();
  });

  it('warns once for a failed atlas page without retrying every presentation frame', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = presentation();
      p.available.indexed = false;
      p.available.failed = true;
      const state = p.state();
      p.view.push(state);
      p.view.render(1);
      p.view.render(2);
      expect(p.liveLibrary.page).toHaveBeenCalledTimes(1);
      p.view.push({ ...state, smudges: { ...state.smudges!, revision: 2 } });
      p.view.render(3);
      expect(warning.mock.calls.filter(([text]) => String(text).includes('smudge atlas page 1 failed'))).toHaveLength(
        1,
      );
      expect(p.backing.smudgeLayers.size).toBe(0);
      expect(p.cellLayer.mesh.count).toBe(1);
      p.view.dispose();
    } finally {
      warning.mockRestore();
    }
  });
});
