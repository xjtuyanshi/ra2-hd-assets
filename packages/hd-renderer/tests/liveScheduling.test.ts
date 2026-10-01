import { describe, expect, it, vi } from 'vitest';
import { Color, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { VolumetricBlastLayer } from '../src/volumetricBlasts';
import { LiveView, type LiveSnapshot } from '../src/live/liveView';

function pushView() {
  const internals = {
    current: null as { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveSnapshot['objects'][number]> } | null,
    previous: null,
    appearances: new Map(),
    houseColour: new Map(),
    buildingAnimMatches: new Map(),
    effectDriver: { push: vi.fn() },
    hd: { seconds: () => 1 },
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
    current: { snapshot: { frame: 2 }, at: 10 },
    previous: { snapshot: { frame: 1 }, at: 0 },
    lastRender: 10,
    library,
    effectArt: art,
    hd,
    effectDriver: { frame: vi.fn() },
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
