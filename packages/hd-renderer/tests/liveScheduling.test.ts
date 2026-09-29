import { describe, expect, it, vi } from 'vitest';
import { LiveView, type LiveSnapshot } from '../src/live/liveView';

/** Exercise presentation scheduling without a GPU, after construction has attached the scene's collaborators. */
function presentation(interpolating: boolean) {
  const art = { revision: 0 };
  const library = { revision: 0 };
  const applyObjects = vi.fn();
  const applyEffects = vi.fn();
  const hd = { seconds: () => 1, frame: vi.fn(), windowsWanted: () => false };
  const view = Object.assign(Object.create(LiveView.prototype) as object, {
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
    applyObjects,
    applyEffects,
  }) as unknown as LiveView;
  return { view, art, library, applyObjects, applyEffects, hd };
}

describe('live presentation scheduling', () => {
  it('accepts native painter reorder and layer changes while the engine frame is frozen', () => {
    const internals = {
      current: null as { snapshot: LiveSnapshot } | null,
      houseColour: new Map(),
      buildingAnimMatches: new Map(),
      effectDriver: {},
      warnedCells: true,
      ensureHouse: vi.fn(),
      trackMotion: vi.fn(),
      updateOverlays: vi.fn(),
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
    expect(state.current?.snapshot).toBe(reordered);
    const airborne = structuredClone(reordered);
    airborne.objects[0]!.renderOrder!.layer = 4;
    view.push(airborne, 40);
    expect(state.current?.snapshot).toBe(airborne);
    const resorted = structuredClone(airborne);
    resorted.objects[0]!.renderOrder!.ySort = 513;
    view.push(resorted, 50);
    expect(state.current?.snapshot).toBe(resorted);
    expect(state.trackMotion).toHaveBeenCalledTimes(4);
  });

  it('holds unchanged cards while art loads, and rebuilds once when art succeeds or fails', () => {
    const p = presentation(false);
    for (let i = 0; i < 144; i++) p.view.render(10 + i * (1000 / 144));
    expect(p.applyEffects).toHaveBeenCalledTimes(1);
    expect(p.applyObjects).toHaveBeenCalledTimes(1);
    expect(p.hd.frame).toHaveBeenCalledTimes(144);
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
});
