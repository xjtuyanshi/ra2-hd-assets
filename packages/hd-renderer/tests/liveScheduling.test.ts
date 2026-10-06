import { describe, expect, it, vi } from 'vitest';
import { Color, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { VolumetricBlastLayer } from '../src/volumetricBlasts';
import { ra2SceneLighting } from '../src/ra2/sceneLighting';
import { BuildingLightGate } from '../src/live/buildingLights';
import { LiveView, type LiveSnapshot } from '../src/live/liveView';

function pushView() {
  const internals = {
    current: null as { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveSnapshot['objects'][number]> } | null,
    previous: null,
    world: { mapLight: { lighting: { ambient: 1, ground: 0, level: 0, red: 1, green: 0.8, blue: 0.68 } } },
    sceneMedianZ: 0,
    appearances: new Map(),
    houseColour: new Map(),
    buildingAnimMatches: new Map(),
    effectDriver: { push: vi.fn() },
    liveBeams: { update: vi.fn(), displayScale: { value: 1 } },
    hd: { seconds: () => 1, setSceneLighting: vi.fn() },
    ensureHouse: vi.fn(),
    trackMotion: vi.fn(),
    updateOverlays: vi.fn(),
    updateSmudges: vi.fn(),
    updateNightSources: vi.fn(),
  };
  const view = Object.assign(Object.create(LiveView.prototype), internals) as LiveView;
  return { view, state: view as unknown as typeof internals };
}

/** Exercise presentation scheduling without a GPU, after construction has attached the scene's collaborators. */
function presentation(interpolating: boolean) {
  const art = { revision: 0 };
  const library = { revision: 0 };
  const applyObjects = vi.fn();
  const applyEffects = vi.fn();
  const flushOverlayPages = vi.fn(function (this: { overlayPagesDirty: boolean }) {
    this.overlayPagesDirty = false;
  });
  const hd = {
    meanExposure: 2,
    settings: { sourceLights: 0 },
    seconds: () => 1,
    frame: vi.fn(),
    warm: vi.fn(),
    warming: false,
    quality: 0,
    pendingPipelines: 0,
    setSceneLighting: vi.fn(),
    windowsWanted: () => false,
    materialsWanted: vi.fn(() => false),
  };
  const volumetricBlasts = new VolumetricBlastLayer({
    light: uniform(new Color(1, 1, 1)),
    sunDirection: uniform(new Vector3(0, 1, 0)),
  });
  const updateVolumes = vi.spyOn(volumetricBlasts, 'update');
  const view = Object.assign(Object.create(LiveView.prototype) as object, {
    volumetricBlasts,
    buildingLightGate: new BuildingLightGate(),
    voxelUnits: { revision: 0, loading: 0 },
    pageUploads: { step: vi.fn() },
    aheadPages: new Set<number>(),
    aheadVoxels: new Set<string>(),
    visuals: new Map(),
    current: { snapshot: { frame: 2, objects: [] }, at: 10 },
    previous: { snapshot: { frame: 1, objects: [] }, at: 0 },
    lastRender: 10,
    library,
    effectArt: art,
    hd,
    effectDriver: { frame: vi.fn(), skyFlash: () => 0 },
    liveBeams: { update: vi.fn(), displayScale: { value: 1 } },
    cellsDirty: false,
    objectsInterpolate: interpolating,
    applyCamera: vi.fn(),
    flushOverlayPages,
    applyObjects,
    applyEffects,
    applyPainterOrder: vi.fn(),
  }) as unknown as LiveView;
  return { view, art, library, applyObjects, applyEffects, flushOverlayPages, hd, volumetricBlasts, updateVolumes };
}

describe('live presentation scheduling', () => {
  it('hides owner-attached effects and restores them on a same-frame unhide while retaining independent effects', () => {
    const { view, state } = pushView();
    const owner = { id: 100, uid: 10, kind: 'vehicle' as const };
    const point = { x: 256, y: 256, z: 0 };
    const snapshot: LiveSnapshot = {
      frame: 20,
      view: null,
      houses: [],
      objects: [
        {
          ...owner,
          ...point,
          type: 'TEST',
          owner: 0,
          facingRaw: 0,
          health: 1,
          isSelected: false,
          nativeHidden: true,
        },
      ],
      effects: {
        anims: [
          { id: 200, uid: 20, type: 'FIRE01', ...point, attachedTo: owner },
          { id: 201, uid: 21, type: 'TWLT070', ...point, attachedTo: null },
        ],
        particleSystems: [
          { id: 300, uid: 30, behaviour: 'smoke', ...point, attachedTo: owner },
          { id: 301, uid: 31, behaviour: 'smoke', ...point },
        ],
        bullets: [{ id: 400, uid: 40, type: 'CANNON', ...point }],
        fireEvents: [
          { id: owner.id, uid: owner.uid, frame: 20 },
          { id: 101, uid: 11, frame: 20 },
        ],
      },
    };
    view.push(snapshot, 100);
    const timed = state.current;
    const filtered = state.effectDriver.push.mock.calls.at(-1)![0];
    expect(filtered.anims).toEqual([snapshot.effects!.anims[1]]);
    expect(filtered.particleSystems).toEqual([snapshot.effects!.particleSystems[1]]);
    expect(filtered.fireEvents).toEqual([snapshot.effects!.fireEvents![1]]);
    expect(filtered.bullets).toEqual(snapshot.effects!.bullets);
    expect(snapshot.effects!.anims).toHaveLength(2);
    expect(snapshot.effects!.particleSystems).toHaveLength(2);
    expect(snapshot.effects!.fireEvents).toHaveLength(2);

    view.push({ ...snapshot, objects: [{ ...snapshot.objects[0]!, nativeHidden: false }] }, 120);
    expect(state.current).toBe(timed);
    expect(state.current?.at).toBe(100);
    expect(state.effectDriver.push.mock.calls.at(-1)![0]).toEqual(snapshot.effects);

    view.push({ ...snapshot, effects: { anims: [], particleSystems: [], bullets: [], fireEvents: [] } }, 140);
    expect(state.effectDriver.push.mock.calls.at(-1)![0]).toEqual({
      anims: [],
      particleSystems: [],
      bullets: [],
      fireEvents: [],
    });
  });

  it.each([
    { field: 'pointer', attachedTo: { id: 101, uid: 10, kind: 'vehicle' } },
    { field: 'UID', attachedTo: { id: 100, uid: 11, kind: 'vehicle' } },
  ])('keeps attached effects when the hidden owner has a different $field', ({ attachedTo }) => {
    const { view, state } = pushView();
    const point = { x: 256, y: 256, z: 0 };
    const snapshot: LiveSnapshot = {
      frame: 20,
      view: null,
      houses: [],
      objects: [
        {
          id: 100,
          uid: 10,
          kind: 'vehicle',
          ...point,
          type: 'TEST',
          owner: 0,
          facingRaw: 0,
          health: 1,
          isSelected: false,
          nativeHidden: true,
        },
      ],
      effects: {
        anims: [{ id: 200, uid: 20, type: 'FIRE01', ...point, attachedTo }],
        particleSystems: [{ id: 300, uid: 30, behaviour: 'smoke', ...point, attachedTo }],
        bullets: [],
        fireEvents: [{ id: attachedTo.id, uid: attachedTo.uid, frame: 20 }],
      },
    };
    view.push(snapshot, 100);
    expect(state.effectDriver.push.mock.calls.at(-1)![0]).toEqual(snapshot.effects);
  });

  it('forwards snapshot lighting immediately, including clearing an absent or unknown field', () => {
    const { view, state } = pushView();
    const lighting = {
      ambient: 0.87,
      ground: 0,
      level: 0,
      tint: [1, 0.8, 0.68] as [number, number, number],
      override: [0.3, 0.4, 0.75] as [number, number, number],
      event: 'storm' as const,
    };
    const snapshot: LiveSnapshot = { frame: 1, view: null, houses: [], objects: [], lighting };
    view.push(snapshot, 1);
    expect(state.hd.setSceneLighting).toHaveBeenLastCalledWith(
      ra2SceneLighting(state.world.mapLight.lighting, lighting, 0),
    );
    view.push({ ...snapshot, frame: 2, lighting: null }, 2);
    expect(state.hd.setSceneLighting).toHaveBeenLastCalledWith(null);
    view.push({ frame: 3, view: null, houses: [], objects: [] }, 3);
    expect(state.hd.setSceneLighting).toHaveBeenLastCalledWith(null);
  });
  it('accepts death/prone steps, damage and effect removal in the same frame without restarting its timestamp', () => {
    const { view, state } = pushView();
    const snapshot: LiveSnapshot = {
      frame: 20,
      view: null,
      houses: [],
      objects: [
        {
          id: 1,
          uid: 1,
          kind: 'infantry',
          type: 'TEST',
          owner: 0,
          x: 0,
          y: 0,
          z: 0,
          facingRaw: 0,
          health: 0,
          isSelected: false,
          infantrySequence: 'Die1',
          sequenceFrame: 0,
        },
      ],
      effects: {
        anims: [{ id: 2, uid: 2, type: 'TEST', frame: 1, x: 0, y: 0, z: 0 }],
        bullets: [],
        particleSystems: [],
      },
    };
    view.push(snapshot, 100);
    const timed = state.current;
    const changed = structuredClone(snapshot);
    changed.objects[0]!.sequenceFrame = 2;
    changed.effects!.anims = [];
    view.push(changed, 120);
    expect(state.current).toBe(timed);
    expect(state.current?.at).toBe(100);
    expect(state.current?.byUid.get(1)).toMatchObject({ health: 0, sequenceFrame: 2 });
    expect(state.effectDriver.push.mock.calls.at(-1)![0].anims).toEqual([]);
    const prone = structuredClone(changed);
    Object.assign(prone.objects[0]!, { infantrySequence: 'FireProne', sequenceFrame: 0, health: 1 });
    view.push(prone, 140);
    expect(state.current?.byUid.get(1)?.infantrySequence).toBe('FireProne');
    view.push({ ...prone, objects: [], effects: null }, 160);
    expect(state.current?.byUid.size).toBe(0);
    expect(state.effectDriver.push.mock.calls.at(-1)![0]).toEqual({ anims: [], bullets: [], particleSystems: [] });
  });

  it('waits five seconds for cell publication and warns once only when it never arrives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base: LiveSnapshot = { frame: 10, objects: [], houses: [], view: null };
      const missing = pushView();
      missing.view.push({ ...base }, 0);
      missing.view.push({ ...base }, 4999);
      expect(warn).not.toHaveBeenCalled();
      missing.view.push({ ...base }, 5000);
      missing.view.push({ ...base }, 9000);
      expect(warn).toHaveBeenCalledTimes(1);
      const delayed = pushView();
      delayed.view.push({ ...base }, 0);
      const empty = {
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
        revision: 1,
        index: new Int16Array([-1]),
        data: new Uint8Array(1),
        types: [],
      };
      delayed.view.push({ ...base, overlays: empty, smudges: empty }, 250);
      delayed.view.push({ ...base }, 10000);
      expect(warn).toHaveBeenCalledTimes(1);
      delayed.view.push({ ...base, frame: 1 }, 11000);
      delayed.view.push({ ...base, frame: 1 }, 16000);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
  it('accepts native painter reorder and layer changes while the engine frame is frozen', () => {
    const internals = {
      current: null as { snapshot: LiveSnapshot; at: number } | null,
      appearances: new Map(),
      houseColour: new Map(),
      buildingAnimMatches: new Map(),
      effectDriver: {},
      hd: { setSceneLighting: vi.fn() },
      liveBeams: { update: vi.fn() },
      warnedCells: true,
      ensureHouse: vi.fn(),
      trackMotion: vi.fn(),
      updateOverlays: vi.fn(),
      updateSmudges: vi.fn(),
      updateNightSources: vi.fn(),
    };
    const view = Object.assign(Object.create(LiveView.prototype), internals) as LiveView;
    const state = view as unknown as typeof internals;
    const snapshot: LiveSnapshot = {
      frame: 14,
      view: { x: 0, y: 0 },
      houses: [],
      objects: [
        {
          id: 1,
          uid: 2,
          kind: 'aircraft',
          type: 'TEST',
          owner: 0,
          x: 256,
          y: 256,
          z: 0,
          facingRaw: 0,
          health: 1,
          isSelected: false,
          renderOrder: { layer: 2, index: 1, ySort: 512 },
        },
      ],
    };
    view.push(snapshot, 10);
    const original = state.current;
    view.push(structuredClone(snapshot), 20);
    expect(state.current).toBe(original);
    const reordered = structuredClone(snapshot);
    reordered.objects[0]!.renderOrder!.index = 3;
    view.push(reordered, 30);
    expect(state.current).toBe(original);
    expect(state.current?.at).toBe(10);
    expect(state.current?.snapshot).toEqual(reordered);
    const airborne = structuredClone(reordered);
    airborne.objects[0]!.renderOrder!.layer = 4;
    view.push(airborne, 40);
    expect(state.current?.snapshot).toEqual(airborne);
    const resorted = structuredClone(airborne);
    resorted.objects[0]!.renderOrder!.ySort = 513;
    view.push(resorted, 50);
    expect(state.current?.snapshot).toEqual(resorted);
    expect(state.trackMotion).toHaveBeenCalledTimes(1);
  });

  it('holds unchanged cards while art loads, and rebuilds once when art succeeds or fails', () => {
    const p = presentation(false);
    for (let i = 0; i < 144; i++) p.view.render(10 + i * (1000 / 144));
    expect(p.applyEffects).toHaveBeenCalledTimes(1);
    expect(p.applyObjects).toHaveBeenCalledTimes(1);
    expect(p.hd.frame).toHaveBeenCalledTimes(144);
    expect(p.updateVolumes).toHaveBeenCalledTimes(144);
    expect(p.volumetricBlasts.displayScale.value).toBe(0.5);
    p.art.revision++;
    p.view.render(1100);
    p.view.render(1110);
    expect(p.applyEffects).toHaveBeenCalledTimes(2);
    // Voxel completions matter even when no SHP card had an outstanding page.
    p.art.revision++;
    p.view.render(1120);
    expect(p.applyEffects).toHaveBeenCalledTimes(3);
    p.library.revision++;
    p.view.render(1130);
    expect(p.applyObjects).toHaveBeenCalledTimes(4);
    expect(p.applyEffects).toHaveBeenCalledTimes(3);
  });

  it('keeps presentation-rate movement interpolation until the newest logic pose is reached', () => {
    const p = presentation(true);
    p.view.render(12);
    p.view.render(16);
    p.view.render(20);
    p.view.render(24);
    expect(p.applyObjects.mock.calls.map((call) => call[2])).toEqual([0.2, 0.6, 1]);
    expect(p.applyEffects).toHaveBeenCalledTimes(1);
  });

  it('revisits library layers on look changes without a new engine snapshot, then sleeps until art arrives', () => {
    const p = presentation(false);
    p.view.render(10);
    p.hd.materialsWanted.mockReturnValue(true);
    p.view.render(20);
    p.view.render(30);
    expect(p.applyObjects).toHaveBeenCalledTimes(2);
    expect(p.flushOverlayPages).toHaveBeenCalledTimes(2);
    p.library.revision++;
    p.view.render(40);
    p.view.render(50);
    expect(p.applyObjects).toHaveBeenCalledTimes(3);
    expect(p.flushOverlayPages).toHaveBeenCalledTimes(3);
    expect(p.applyEffects).toHaveBeenCalledTimes(1);
  });
});

describe('live preparation pace', () => {
  it('gives a late frame the upload pixels of the frame that did not come, and no more than two frames worth', () => {
    const p = presentation(false);
    const fields = p.view as unknown as {
      lastRender: number;
      outOfSight: boolean;
      hiddenUploadPixels: number;
      pageUploads: { step: ReturnType<typeof vi.fn> };
    };
    const MP = 1 << 20;
    Object.assign(fields, { outOfSight: false, hiddenUploadPixels: 8 * MP });
    // A shown view at 60 Hz: 8 M pixels of atlas pages per frame.
    fields.lastRender = 1000;
    p.view.render(1000 + 1000 / 60);
    expect(fields.pageUploads.step).toHaveBeenLastCalledWith(8 * MP);
    // At 40 frames a second: one and a half frames' worth.
    fields.lastRender = 2000;
    p.view.render(2025);
    expect(fields.pageUploads.step.mock.lastCall![0]).toBeCloseTo(12 * MP, 0);
    // Out of sight at 8 frames a second, or after a second without a frame: twice, never more.
    fields.outOfSight = true;
    for (const late of [125, 1000]) {
      fields.lastRender = 3000;
      p.view.render(3000 + late);
      expect(fields.pageUploads.step).toHaveBeenLastCalledWith(16 * MP);
    }
    // A faster display never gets less than one frame's share.
    fields.lastRender = 5000;
    p.view.render(5004);
    expect(fields.pageUploads.step).toHaveBeenLastCalledWith(8 * MP);
    // A host that sets no pace (a loading screen) keeps none.
    fields.hiddenUploadPixels = Infinity;
    fields.lastRender = 6000;
    p.view.render(6016);
    expect(fields.pageUploads.step).toHaveBeenLastCalledWith(Infinity);
  });
});

describe('warm-up out of sight', () => {
  it('warms once with the scene and once when the opening is in, and counts no warm frame as a frame of the match', () => {
    const p = presentation(false);
    const fields = p.view as unknown as {
      outOfSight: boolean;
      current: { snapshot: { frame: number; objects: unknown[] } };
      voxelUnits: { loading: number };
      effectSprites: { warm: () => void; now: { value: number }; displayScale: { value: number } };
    };
    const hd = p.hd as unknown as { warm: ReturnType<typeof vi.fn>; warming: boolean };
    const effects = vi.fn();
    fields.effectSprites = { warm: effects, now: { value: 0 }, displayScale: { value: 1 } };
    // A shown view never spends a frame on it.
    p.view.render(20);
    expect(hd.warm).not.toHaveBeenCalled();

    // Out of sight behind the loading screen (the scenario's frame 0): the first frame asks for a warm-up.
    fields.outOfSight = true;
    fields.current.snapshot.frame = 0;
    fields.voxelUnits.loading = 1;
    p.view.render(30);
    expect(hd.warm).toHaveBeenCalledTimes(1);
    expect(effects).toHaveBeenCalledTimes(1);
    p.view.render(40);
    expect(hd.warm).toHaveBeenCalledTimes(1);

    // The match runs and its art is still arriving: nothing yet. Then the opening is in: once more.
    fields.current.snapshot.frame = 5;
    p.view.render(50);
    expect(hd.warm).toHaveBeenCalledTimes(1);
    fields.voxelUnits.loading = 0;
    p.view.render(60);
    expect(p.view.settledFrames).toBe(1);
    expect(hd.warm).toHaveBeenCalledTimes(1);
    p.view.render(70);
    expect(hd.warm).toHaveBeenCalledTimes(2);
    // While the renderer draws its warm frames the view does not count as settled, and asks for nothing more.
    hd.warming = true;
    p.view.render(80);
    p.view.render(90);
    expect(p.view.settledFrames).toBe(0);
    expect(hd.warm).toHaveBeenCalledTimes(2);
    hd.warming = false;
    for (const at of [100, 110, 120]) p.view.render(at);
    expect(p.view.settledFrames).toBe(3);
    expect(hd.warm).toHaveBeenCalledTimes(2);

    // The safeguard's tier reaches the effect layer: from tier 1 on its translucent cards read no copy of the frame.
    const layer = fields.effectSprites as unknown as { backdropMix?: boolean };
    expect(layer.backdropMix).toBe(true);
    (hd as unknown as { quality: number }).quality = 1;
    p.view.render(125);
    expect(layer.backdropMix).toBe(false);
    (hd as unknown as { quality: number }).quality = 0;

    // Shown, then out of sight again (the next match on this map): the stages start over.
    fields.outOfSight = false;
    p.view.render(130);
    fields.outOfSight = true;
    p.view.render(140);
    expect(hd.warm).toHaveBeenCalledTimes(3);
  });
});

describe('voxel model files ahead of their first use', () => {
  it('asks for them once the opening is in or the view is shown, a step per frame, until all are requested', () => {
    const p = presentation(false);
    const fields = p.view as unknown as {
      outOfSight: boolean;
      fetchAhead: (() => boolean) | null;
      voxelUnits: { loading: number };
    };
    let answer = false;
    const ahead = vi.fn(() => answer);
    fields.fetchAhead = ahead;
    // Out of sight with art still on its way: the opening comes first.
    fields.outOfSight = true;
    fields.voxelUnits.loading = 1;
    p.view.render(20);
    expect(ahead).not.toHaveBeenCalled();
    // The opening has been drawn completely once: fetch ahead, out of sight or not.
    fields.voxelUnits.loading = 0;
    p.view.render(30);
    expect(ahead).toHaveBeenCalledTimes(1);
    // A shown view does not wait for anything to settle.
    fields.outOfSight = false;
    fields.voxelUnits.loading = 1;
    p.view.render(40);
    expect(ahead).toHaveBeenCalledTimes(2);
    // Everything requested: never asked again.
    answer = true;
    p.view.render(50);
    expect(ahead).toHaveBeenCalledTimes(3);
    expect(fields.fetchAhead).toBeNull();
    p.view.render(60);
    expect(ahead).toHaveBeenCalledTimes(3);
  });
});

describe('live staging hour', () => {
  it("applies a preset's day hour to every map but authored dusk; an explicit time wins", async () => {
    const { liveTimeOfDay } = await import('../src/live/liveView');
    expect(liveTimeOfDay({ kind: 'day', hour: 12 }, { dayHour: 16.5 })).toBe(16.5);
    // Night maps are lit like day maps (the engine grade is their night), so they take the look's hour as well.
    expect(liveTimeOfDay({ kind: 'night', hour: 12 }, { dayHour: 16.5 })).toBe(16.5);
    expect(liveTimeOfDay({ kind: 'night', hour: 12 }, {})).toBe(12);
    expect(liveTimeOfDay({ kind: 'dusk', hour: 19 }, { dayHour: 16.5 })).toBe(19);
    expect(liveTimeOfDay({ kind: 'night', hour: 12 }, { timeOfDay: 22, dayHour: 16.5 })).toBe(22);
    expect(liveTimeOfDay({ kind: 'day', hour: 12 }, {})).toBe(12);
    // Airless maps keep their noon brightness at any hour, so the look's hour gives them its sun as well.
    expect(liveTimeOfDay({ kind: 'day', hour: 12, airless: true }, { dayHour: 16.5 })).toBe(16.5);
    expect(liveTimeOfDay({ kind: 'day', hour: 12, airless: true }, {})).toBe(12);
    expect(liveTimeOfDay({ kind: 'day', hour: 12, airless: true }, { timeOfDay: 10, dayHour: 16.5 })).toBe(10);
  });
});

describe('engine light sources', () => {
  const lamp = {
    x: 15232,
    y: 17536,
    z: 208,
    radius: 4000,
    intensity: 0.5,
    tint: [0.05, 0.05, 0.01] as [number, number, number],
  };
  const snapshot = (sources?: (typeof lamp)[]): LiveSnapshot =>
    ({
      frame: 1,
      objects: [],
      houses: [],
      view: null,
      lighting: {
        ambient: 1,
        ground: 0,
        level: 0,
        tint: [1, 0.8, 0.68],
        override: null,
        event: null,
        ...(sources ? { sources } : {}),
      },
    }) as unknown as LiveSnapshot;
  function nightView(
    dressing: {
      setSources: ReturnType<typeof vi.fn>;
      setBlockedCells: ReturnType<typeof vi.fn>;
      setWindowBuildings?: ReturnType<typeof vi.fn>;
    } | null,
    types?: Record<string, unknown>,
  ) {
    const setSources = vi.fn();
    const internals = {
      world: { mapLight: { setSources }, dressing, width: 8 },
      cache: { lights: types ? { types } : undefined },
      shroud: { isLocationShrouded: () => false },
      library: null,
      lightKey: null,
      lightKeyEngine: false,
      engineLightKey: null,
      windowKey: null,
      blockedKey: null,
    };
    const view = Object.assign(Object.create(LiveView.prototype), internals) as unknown as {
      updateNightSources(snapshot: LiveSnapshot): void;
    };
    return { view, setSources };
  }

  it("feeds the map light grade from the game's own list on a map without a light sidecar", () => {
    const { view, setSources } = nightView(null);
    view.updateNightSources(snapshot([lamp]));
    expect(setSources).toHaveBeenCalledTimes(1);
    expect(setSources).toHaveBeenLastCalledWith([
      { position: [15232, 17536, 208], radius: 4000, intensity: 0.5, tint: [0.05, 0.05, 0.01] },
    ]);
    // Unchanged list: no recomputation of the cell grid.
    view.updateNightSources(snapshot([{ ...lamp, tint: [0.05, 0.05, 0.01] }]));
    expect(setSources).toHaveBeenCalledTimes(1);
    // The engine switched the light off (or its building is gone): the grade follows.
    view.updateNightSources(snapshot([]));
    expect(setSources).toHaveBeenCalledTimes(2);
    expect(setSources).toHaveBeenLastCalledWith([]);
    // A host that reports no list leaves the grade as it is (the sidecar's sources, if any).
    view.updateNightSources(snapshot());
    expect(setSources).toHaveBeenCalledTimes(2);
  });

  it('keeps the sidecar type table for the dressing only while the game supplies the list', () => {
    const dressing = { setSources: vi.fn(), setBlockedCells: vi.fn(), setWindowBuildings: vi.fn() };
    const types = {
      INGALITE: { foundation: [1, 1], radius: 4000, intensity: 0.5, tint: [0.05, 0.05, 0.01], invisible: true },
    };
    const { view, setSources } = nightView(dressing, types);
    const post = { kind: 'building', type: 'INGALITE', x: 59 * 256, y: 68 * 256, z: 208, health: 1 };
    const withPost = (sources?: (typeof lamp)[]) =>
      ({ ...snapshot(sources), objects: [post] }) as unknown as LiveSnapshot;
    view.updateNightSources(withPost([lamp]));
    expect(setSources).toHaveBeenCalledTimes(1);
    // The dressing learns the typed source (lamp head, forced-night pools) but must not overwrite the grade.
    expect(dressing.setSources).toHaveBeenCalledTimes(1);
    expect(dressing.setSources.mock.calls[0]![1]).toBe(false);
    expect(dressing.setSources.mock.calls[0]![0]).toMatchObject([{ type: 'INGALITE', cell: [59, 68], radius: 4000 }]);
    // Without the game's list the sidecar types feed the grade again, through the dressing.
    view.updateNightSources(withPost());
    expect(dressing.setSources).toHaveBeenCalledTimes(2);
    expect(dressing.setSources.mock.calls[1]![1]).toBe(true);
  });
});
