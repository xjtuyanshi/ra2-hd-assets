import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { HdRenderer } from '../src/HdRenderer';
import { BuildingVisualHistory } from '../src/live/buildingVisualHistory';
import {
  cellLayerCapacity,
  LiveView,
  type LiveObject,
  type LiveSnapshot,
  type LiveWarmType,
} from '../src/live/liveView';

interface TestVisual {
  type: string;
  root: Group;
  mode: string;
  libraryType?: LibraryType;
  pending?: boolean;
  turretState?: string;
}

const vehicle = (uid: number, type: string, owner = 0, extra: Partial<LiveObject> = {}): LiveObject => ({
  id: uid,
  uid,
  kind: 'vehicle',
  type,
  owner,
  x: 256,
  y: 512,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
  ...extra,
});

/** The real visual selection with the voxel collaborators replaced: models load and meshes build on demand. */
function visualView() {
  const types = new Map<string, LibraryType>();
  const models = new Map<string, VoxelModel>();
  for (const id of ['HTNK', 'MTNK']) {
    types.set(id, { kind: 'vehicle', image: id, voxel: id, drawOffset: [0, 0], lighting: 'full', remap: true });
    models.set(id, { id, palette: 'unit', normalsMode: 4, parts: [] });
  }
  const loaded = new Set<string>(['HTNK', 'MTNK']);
  const failed = new Set<string>();
  const meshed = new Set<VoxelModel>();
  const built = new Set<string>();
  const state = {
    outOfSight: false,
    newArtPerFrame: Infinity,
    newArt: 0,
    waitingArt: 0,
    library: {
      loading: 0,
      type: vi.fn((id: string) => types.get(id)),
      voxel: vi.fn((id: string) => (loaded.has(id) ? (models.get(id) ?? null) : null)),
      voxelType: vi.fn(() => undefined),
      voxelFailed: vi.fn((id: string) => failed.has(id)),
    },
    effectArt: { loading: 0 },
    cache: {
      voxels: new Map<string, VoxelModel>(),
      manifest: { sprites: {} as Record<string, { frames: unknown[] }> },
      paletteRow: new Map([['lib:unit@house0', 0]]),
    },
    voxelUnits: {
      loading: 0,
      geometryReady: vi.fn((model: VoxelModel) => meshed.has(model)),
      prepare: vi.fn(() => true),
      built: vi.fn((key: string) => built.has(key)),
      build: vi.fn((_model: VoxelModel, _palette: string, key: string) => {
        built.add(key);
        return { root: new Group() };
      }),
      dispose: vi.fn((unit: { root: Group }) => unit.root.removeFromParent()),
    },
    root: new Group(),
    visuals: new Map<number, TestVisual>(),
    appearances: new Map<number, { frame: number }>(),
    housePaletteKeys: new Map([[0, 'house0']]),
    libraryPaletteKeys: new Map<string, string>(),
    warnedTypes: new Set<string>(),
    options: {},
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as unknown as {
    visualFor(object: LiveObject, colorIndex: number, frame: number): TestVisual;
    loadingArt(): number;
  };
  return { view, state, models, loaded, failed, meshed, built };
}

describe('live voxel meshes built off the main thread', () => {
  it('builds a shown unit at once although its mesh is not there (VoxelUnits draws its stand-in), without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = visualView();
    const tank = vehicle(1, 'HTNK');
    const drawn = h.view.visualFor(tank, 0, 5);
    expect(drawn.mode).toBe('voxel');
    expect(drawn.pending).toBeFalsy();
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(1);
    expect(h.state.voxelUnits.build).toHaveBeenCalledWith(
      h.models.get('HTNK'),
      'lib:unit@house0',
      'HTNK@lib:unit@house0',
    );
    // Later frames, and the mesh arriving, keep the visual: VoxelUnits changes its geometry in place.
    expect(h.view.visualFor(tank, 0, 6)).toBe(drawn);
    h.meshed.add(h.models.get('HTNK')!);
    expect(h.view.visualFor(tank, 0, 7)).toBe(drawn);
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('out of sight draws nothing for a model until its mesh is there, without warning, then builds the unit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = visualView();
    (h.view as unknown as { outOfSight: boolean }).outOfSight = true;
    const tank = vehicle(1, 'HTNK');
    const waiting = h.view.visualFor(tank, 0, 5);
    expect(waiting).toMatchObject({ mode: 'placeholder', pending: true });
    expect(h.state.voxelUnits.geometryReady).toHaveBeenCalledWith(h.models.get('HTNK'));
    expect(h.state.voxelUnits.build).not.toHaveBeenCalled();
    expect(h.view.loadingArt()).toBe(1);
    // Asked again on later frames: the same placeholder, still no instance.
    expect(h.view.visualFor(tank, 0, 6)).toBe(waiting);
    h.meshed.add(h.models.get('HTNK')!);
    const built = h.view.visualFor(tank, 0, 7);
    expect(built.mode).toBe('voxel');
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(1);
    expect(h.view.loadingArt()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('out of sight treats a map-cache model whose mesh is not there like one that is still loading', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = visualView();
    (h.view as unknown as { outOfSight: boolean }).outOfSight = true;
    const model: VoxelModel = { id: 'TRUCK', palette: 'unit', normalsMode: 4, parts: [] };
    h.state.cache.voxels.set('TRUCK', model);
    h.state.cache.paletteRow.set('unit@house0', 1);
    const truck = vehicle(2, 'TRUCK');
    expect(h.view.visualFor(truck, 0, 1)).toMatchObject({ mode: 'placeholder', pending: true });
    expect(warn).not.toHaveBeenCalled();
    expect(h.view.loadingArt()).toBe(1);
    h.meshed.add(model);
    expect(h.view.visualFor(truck, 0, 2).mode).toBe('voxel');
    warn.mockRestore();
  });

  it('draws what waited out of sight in the frame after the view is shown, mesh or no mesh', () => {
    const h = visualView();
    const fields = h.view as unknown as { outOfSight: boolean; objectsFor: unknown };
    fields.outOfSight = true;
    const tank = vehicle(1, 'HTNK');
    const waiting = h.view.visualFor(tank, 0, 5);
    expect(waiting).toMatchObject({ mode: 'placeholder', pending: true });
    // Objects were applied for the current snapshot; showing the view asks for them again (no new snapshot needed).
    fields.objectsFor = { snapshot: {} };
    fields.outOfSight = false;
    expect(fields.objectsFor).toBeNull();
    const shown = h.view.visualFor(tank, 0, 5);
    expect(shown).not.toBe(waiting);
    expect(shown.mode).toBe('voxel');
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(1);
  });
});

describe('new kinds of art while another picture is on screen', () => {
  it('adds one kind per frame out of sight and keeps the rest pending, but never holds back a shown view', () => {
    const h = visualView();
    for (const model of h.models.values()) h.meshed.add(model);
    // The view object owns these fields (the fixture's `state` only seeded them).
    const fields = h.view as unknown as {
      outOfSight: boolean;
      newArtPerFrame: number;
      newArt: number;
      waitingArt: number;
    };
    Object.assign(fields, { outOfSight: true, newArtPerFrame: 1 });
    const heavy = vehicle(1, 'HTNK');
    const second = vehicle(2, 'HTNK');
    const medium = vehicle(3, 'MTNK');
    // Frame 1: the first kind is built; another object of that kind costs nothing more; a second kind waits.
    expect(h.view.visualFor(heavy, 0, 1).mode).toBe('voxel');
    expect(h.view.visualFor(second, 0, 1).mode).toBe('voxel');
    expect(h.view.visualFor(medium, 0, 1)).toMatchObject({ mode: 'placeholder', pending: true });
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(2);
    expect(fields.waitingArt).toBe(1);
    expect(h.view.loadingArt()).toBeGreaterThan(0);
    // Frame 2 (render() clears the frame's counters): now it is the second kind's turn.
    Object.assign(fields, { newArt: 0, waitingArt: 0 });
    expect(h.view.visualFor(medium, 0, 2).mode).toBe('voxel');
    expect(h.view.loadingArt()).toBe(0);
    // A shown view draws whatever it can at once.
    const shown = visualView();
    for (const model of shown.models.values()) shown.meshed.add(model);
    Object.assign(shown.view, { outOfSight: false, newArtPerFrame: 1 });
    expect(shown.view.visualFor(heavy, 0, 1).mode).toBe('voxel');
    expect(shown.view.visualFor(medium, 0, 1).mode).toBe('voxel');
    expect((shown.view as unknown as { waitingArt: number }).waitingArt).toBe(0);
  });
});

describe('art still on its way', () => {
  it('counts files, meshes and objects that cannot draw yet, but not a model that failed to load', () => {
    const h = visualView();
    expect(h.view.loadingArt()).toBe(0);
    h.state.library.loading = 3;
    h.state.effectArt.loading = 2;
    h.state.voxelUnits.loading = 1;
    expect(h.view.loadingArt()).toBe(6);
    Object.assign(h.state.library, { loading: 0 });
    Object.assign(h.state.effectArt, { loading: 0 });
    Object.assign(h.state.voxelUnits, { loading: 0 });
    // The model file is still being fetched.
    h.loaded.delete('MTNK');
    const waiting = h.view.visualFor(vehicle(3, 'MTNK'), 0, 1);
    expect(waiting.pending).toBe(true);
    expect(h.view.loadingArt()).toBe(1);
    // It failed: the object stays tracked (diagnostics report it) and no longer counts as on its way.
    h.failed.add('MTNK');
    expect(h.view.loadingArt()).toBe(0);
    // A building whose turret model loads counts as well.
    h.state.visuals.set(9, { type: 'GAP', root: new Group(), mode: 'library-sprite', turretState: 'loading' });
    expect(h.view.loadingArt()).toBe(1);
  });
});

/** push()/render() bookkeeping with every collaborator stubbed (see liveScheduling.test.ts). */
function timeline() {
  const internals = {
    previous: null as unknown,
    current: null as { snapshot: LiveSnapshot } | null,
    warming: false,
    settled: 0,
    objectsFor: null as unknown,
    effectsFor: null as unknown,
    objectsAlpha: 1,
    painterDirty: false,
    firstFrame: null as number | null,
    firstMissingCellsAt: undefined as number | undefined,
    publishedCells: false,
    warnedCells: false,
    sceneMedianZ: 0,
    viewWidth: 600,
    viewHeight: 400,
    appearances: new Map<number, { frame: number; afterGap: boolean; lastSeen: number }>(),
    houseColour: new Map<number, number>(),
    civilian: new Set<number>(),
    buildingAnimMatches: new Map(),
    buildingVisualHistory: new BuildingVisualHistory(),
    visuals: new Map<number, TestVisual>(),
    effectDriver: { push: vi.fn() },
    liveBeams: { update: vi.fn(), displayScale: { value: 1 } },
    hd: { seconds: () => 1, setSceneLighting: vi.fn() },
    world: {},
    library: null,
    // A 4 x 3 grid whose only existing cells are (3, 0) and (1, 2), at levels 0 and 2.
    cache: {
      manifest: { grid: { width: 4, height: 3 }, theater: 'urban' },
      exists: Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]),
      height: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0]),
      voxels: new Map(),
    },
    ensureHouse: vi.fn(),
    trackMotion: vi.fn(),
    updateOverlays: vi.fn(),
    updateSmudges: vi.fn(),
    updateNightSources: vi.fn(),
    scheduleMotion: vi.fn(),
  };
  const view = Object.assign(Object.create(LiveView.prototype), internals) as LiveView;
  return { view, state: view as unknown as typeof internals };
}

const TYPES: LiveWarmType[] = [
  { kind: 'vehicle', type: 'HTNK', colorIndex: 21 },
  { kind: 'vehicle', type: 'MTNK', colorIndex: 17 },
  { kind: 'vehicle', type: 'HARV', imageType: 'HORV', colorIndex: 21 },
  { kind: 'building', type: 'CAOILD', colorIndex: -1, civilian: true },
];

describe('preparing art before the match', () => {
  it('draws one object of each listed kind at the existing cell nearest the middle of the map', () => {
    const { view, state } = timeline();
    expect(view.theater).toBe('urban');
    view.warm(TYPES);
    const snapshot = state.current!.snapshot;
    // Houses and UIDs lie outside what a match uses (indices from a million up, negative UIDs).
    expect(snapshot.objects.map((o) => [o.kind, o.type, o.imageType, o.owner, o.buildState])).toEqual([
      ['vehicle', 'HTNK', undefined, 1_000_000, undefined],
      ['vehicle', 'MTNK', undefined, 1_000_001, undefined],
      ['vehicle', 'HARV', 'HORV', 1_000_000, undefined],
      ['building', 'CAOILD', undefined, -1, undefined],
      // A building once more, under construction: its build-up art is on other pages than its body.
      ['building', 'CAOILD', undefined, -1, 'building'],
    ]);
    expect(snapshot.houses).toEqual([
      { index: 1_000_000, colorIndex: 21, civilian: false },
      { index: 1_000_001, colorIndex: 17, civilian: false },
    ]);
    expect(snapshot.objects.every((o) => o.uid < -1)).toBe(true);
    expect(new Set(snapshot.objects.map((o) => o.uid)).size).toBe(5);
    expect(new Set(snapshot.objects.map((o) => o.id)).size).toBe(5);
    // Cell (1, 2) is nearer the middle (2, 1.5) than (3, 0); it lies two levels up.
    for (const object of snapshot.objects) expect([object.x, object.y, object.z]).toEqual([1.5 * 256, 2.5 * 256, 208]);
    // The view whose centre is that cell at its own height: engine pixels (cx - cy) * 30 and (cx + cy) * 15 - z.
    expect(snapshot.view).toEqual({ x: (1 - 2) * 30 - 300, y: (1 + 2) * 15 - 30 - 200 });
    // No effects, cells or shroud: nothing but the listed art is asked for.
    expect(snapshot.effects ?? null).toBeNull();
    expect(snapshot.overlays ?? null).toBeNull();
    expect(view.warmTypes()).toEqual([]);
  });

  it('starts the match on its own timeline: nothing is carried over from the prepared list', () => {
    const { view, state } = timeline();
    view.warm([{ kind: 'building', type: 'GAPOWR', colorIndex: 21 }]);
    // The listed building, standing and under construction.
    expect(state.appearances.size).toBe(2);
    state.settled = 5;
    state.objectsFor = state.current;
    const match: LiveSnapshot = {
      frame: 0,
      view: { x: 10, y: 20 },
      houses: [{ index: 0, colorIndex: 21 }],
      objects: [{ ...vehicle(77, 'GAPOWR'), kind: 'building' }],
    };
    view.push(match, 100);
    expect(state.current!.snapshot).toBe(match);
    // The prepared list is no earlier state of the match: no interpolation from it, no building "appearing" after it.
    expect(state.previous).toBeNull();
    expect(state.scheduleMotion).not.toHaveBeenCalled();
    expect([...state.appearances.keys()]).toEqual([77]);
    expect(state.firstFrame).toBe(0);
    expect(state.settled).toBe(0);
    expect(state.objectsFor).toBeNull();
    // From here on the view is in a match: its kinds are reported, and a late list is ignored.
    expect(view.warmTypes()).toEqual([{ kind: 'building', type: 'GAPOWR', colorIndex: 21 }]);
    view.warm(TYPES);
    expect(state.current!.snapshot).toBe(match);
  });

  it('keeps an unfinished list alongside the first match snapshots while they are out of sight', () => {
    const { view, state } = timeline();
    const fields = view as unknown as { outOfSight: boolean; settled: number; finishWarmList(): void };
    fields.outOfSight = true;
    view.warm(TYPES);
    // The scenario's first objects arrive before the list was drawn completely (settled is still 0).
    const first: LiveSnapshot = {
      frame: 0,
      view: { x: 60 - 300, y: 90 - 200 },
      houses: [{ index: 0, colorIndex: 21 }],
      objects: [vehicle(7, 'HTNK')],
    };
    view.push(first, 10);
    const merged = state.current!.snapshot;
    expect(merged).not.toBe(first);
    expect(merged.frame).toBe(0);
    expect(merged.objects[0]).toBe(first.objects[0]);
    expect(merged.objects).toHaveLength(1 + 5);
    expect(merged.houses.map((house) => house.index)).toEqual([0, 1_000_000, 1_000_001]);
    // The list stands at the existing cell nearest the middle of the view: (60, 90) px is cell (4, 2), so (3, 0).
    for (const object of merged.objects.slice(1)) expect([object.x, object.y]).toEqual([3.5 * 256, 0.5 * 256]);
    // Such frames are not frames of the match, whatever was drawn; the match's own kinds are reported as they are.
    fields.settled = 4;
    expect(view.settledFrames).toBe(0);
    expect(view.warmTypes()).toEqual([{ kind: 'vehicle', type: 'HTNK', colorIndex: 21 }]);
    // The same publication again changes nothing; another one of the same logic frame keeps the list.
    view.push(first, 20);
    expect(state.current!.snapshot).toBe(merged);
    const second: LiveSnapshot = { ...first, objects: [vehicle(7, 'HTNK'), vehicle(8, 'MTNK')] };
    view.push(second, 30);
    expect(state.current!.snapshot.objects).toHaveLength(2 + 5);
    // The list has been drawn completely: the match snapshot is published again alone, on the same logic frame.
    fields.finishWarmList();
    expect(state.current!.snapshot).toBe(second);
    expect(fields.settled).toBe(0);
    expect(view.settledFrames).toBe(0);
    fields.settled = 3;
    expect(view.settledFrames).toBe(3);
    // From then on snapshots are the match's own.
    const third: LiveSnapshot = { ...first, frame: 1 };
    view.push(third, 40);
    expect(state.current!.snapshot).toBe(third);
  });

  it('drops an unfinished list when the match runs or the view is shown', () => {
    for (const end of ['frame', 'shown'] as const) {
      const { view, state } = timeline();
      const fields = view as unknown as { outOfSight: boolean; settled: number };
      fields.outOfSight = true;
      view.warm([{ kind: 'building', type: 'GAPOWR', colorIndex: 21 }]);
      const first: LiveSnapshot = { frame: 0, view: { x: 0, y: 0 }, houses: [], objects: [vehicle(7, 'HTNK')] };
      view.push(first, 10);
      expect(state.current!.snapshot.objects).toHaveLength(3);
      fields.settled = 2;
      if (end === 'shown') fields.outOfSight = false;
      const next: LiveSnapshot = { ...first, frame: end === 'frame' ? 1 : 0 };
      view.push(next, 20);
      expect(state.current!.snapshot).toBe(next);
      // The frames drawn with the list do not count, and none of its buildings lingers as just destroyed.
      expect(fields.settled).toBe(0);
      expect(state.buildingVisualHistory.retained.size).toBe(0);
      // Nothing of the list returns later.
      fields.outOfSight = true;
      const later: LiveSnapshot = { ...first, frame: next.frame };
      view.push(later, 30);
      expect(state.current!.snapshot).toBe(later);
    }
  });

  it('replaces an empty loading-screen snapshot, and does nothing with an empty list or a map without cells', () => {
    const { view, state } = timeline();
    view.warm([]);
    expect(state.current).toBeNull();
    const loading: LiveSnapshot = { frame: 0, view: { x: 0, y: 0 }, houses: [], objects: [] };
    view.push(loading, 0);
    view.warm(TYPES);
    expect(state.current!.snapshot.objects).toHaveLength(5);
    const empty = timeline();
    empty.state.cache.exists.fill(0);
    empty.view.warm(TYPES);
    expect(empty.state.current).toBeNull();
  });

  it('lists each kind of the match once, with its owner colours and whether a civilian house owns it', () => {
    const { view, state } = timeline();
    view.push(
      {
        frame: 3,
        view: { x: 0, y: 0 },
        houses: [
          { index: 0, colorIndex: 21 },
          { index: 1, colorIndex: 5 },
          { index: 2, colorIndex: 5 },
        ],
        objects: [
          vehicle(1, 'HTNK'),
          vehicle(2, 'HTNK'),
          vehicle(3, 'HARV', 0, { imageType: 'HORV' }),
          vehicle(4, 'HARV', 0),
          vehicle(5, 'CAR', 1),
          vehicle(6, 'HTNK', 7),
          vehicle(7, 'CAR', 2),
        ],
      },
      0,
    );
    // push() derives the civilian houses itself; this fixture names house 1.
    state.civilian = new Set([1]);
    expect(view.warmTypes()).toEqual([
      { kind: 'vehicle', type: 'HTNK', colorIndex: 21 },
      { kind: 'vehicle', type: 'HARV', imageType: 'HORV', colorIndex: 21 },
      { kind: 'vehicle', type: 'HARV', colorIndex: 21 },
      { kind: 'vehicle', type: 'CAR', colorIndex: 5, civilian: true },
      { kind: 'vehicle', type: 'HTNK', colorIndex: -1 },
      // Same art and colours, owned by a house that is not civilian: another kind.
      { kind: 'vehicle', type: 'CAR', colorIndex: 5 },
    ]);
  });

  it('gives civilian and player owners of one colour scheme their own flagged houses', () => {
    const { view, state } = timeline();
    view.warm([
      { kind: 'vehicle', type: 'CAR', colorIndex: 5 },
      { kind: 'building', type: 'CAOILD', colorIndex: 5, civilian: true },
      { kind: 'building', type: 'CATS01', colorIndex: 5, civilian: true },
    ]);
    const snapshot = state.current!.snapshot;
    expect(snapshot.houses).toEqual([
      { index: 1_000_000, colorIndex: 5, civilian: false },
      { index: 1_000_001, colorIndex: 5, civilian: true },
    ]);
    expect(snapshot.objects.map((o) => o.owner)).toEqual([1_000_000, 1_000_001, 1_000_001, 1_000_001, 1_000_001]);
    // The flags decide, not what the houses happen to own in the list.
    expect([...state.civilian]).toEqual([1_000_001]);
  });
});

describe('cell layer capacity', () => {
  it('leaves room for twice the sprites a layer starts with and never shrinks', () => {
    expect(cellLayerCapacity(0)).toBe(64);
    expect(cellLayerCapacity(1)).toBe(64);
    expect(cellLayerCapacity(32)).toBe(64);
    expect(cellLayerCapacity(33)).toBe(128);
    // The measured case: 256 ore cells, two more a second into the match.
    expect(cellLayerCapacity(256)).toBe(512);
    expect(cellLayerCapacity(258)).toBeGreaterThanOrEqual(512);
    expect(cellLayerCapacity(257)).toBe(1024);
    expect(cellLayerCapacity(10, 4096)).toBe(4096);
    for (const count of [1, 63, 64, 65, 500, 4097]) expect(cellLayerCapacity(count)).toBeGreaterThanOrEqual(2 * count);
  });
});

describe('top-layer pass of the post graph', () => {
  function renderer() {
    const state = {
      pipeline: {},
      settings: { antialias: 'msaa4', toneMapper: 'faithful', sharpness: 0, debugView: 'none', clarity: 0 },
      bufferScale: 2,
      world: null,
      topEffectsVisible: false,
      topEffectsPass: false,
      topEffectsStale: false,
      warmMist: null,
      mist: { amount: { value: 0 } },
      renderer: { getPixelRatio: () => 1, backend: {} },
    };
    const hd = Object.assign(Object.create(HdRenderer.prototype), state) as HdRenderer;
    const build = vi
      .spyOn(hd as unknown as { buildPipeline(): void }, 'buildPipeline')
      .mockImplementation(() => undefined);
    const key = () => (hd as unknown as { settingsPipelineKey(): string }).settingsPipelineKey();
    return { hd, build, key };
  }

  it('joins the graph with the first top-layer art and stays: showing and hiding art rebuilds nothing', () => {
    const { hd, build, key } = renderer();
    const without = key();
    expect(hd.topEffectsEnabled).toBe(false);
    hd.setTopEffectsVisible(false);
    expect(build).not.toHaveBeenCalled();
    hd.setTopEffectsVisible(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(hd.topEffectsEnabled).toBe(true);
    const withPass = key();
    expect(withPass).not.toBe(without);
    for (const visible of [false, true, false, true, true, false]) hd.setTopEffectsVisible(visible);
    expect(build).toHaveBeenCalledTimes(1);
    expect(key()).toBe(withPass);
  });

  it('can be enabled before any art shows, once', () => {
    const { hd, build, key } = renderer();
    hd.enableTopEffects();
    hd.enableTopEffects();
    expect(build).toHaveBeenCalledTimes(1);
    expect(hd.topEffectsEnabled).toBe(true);
    const withPass = key();
    hd.setTopEffectsVisible(true);
    hd.setTopEffectsVisible(false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(key()).toBe(withPass);
  });
});
