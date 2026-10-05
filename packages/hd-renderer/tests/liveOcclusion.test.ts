import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Texture, Vector3 } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry } from '../../ra2-assets/src/manifest';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { BuildingLightGate } from '../src/live/buildingLights';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import type { EffectInstance } from '../src/live/effectSprites';
import { SpritePool } from '../src/live/spritePool';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { cardDepthPush } from '../src/ra2/cardDepth';
import { biasedDepth } from '../src/painterDepth';
import { painterObject, spritePainterBias, type PainterObject } from '../src/ra2/painterOrder';
import { cardPush, SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { VOXEL_CLEARANCE, VoxelUnit } from '../src/ra2/voxels';
import { VolumetricBlastLayer } from '../src/volumetricBlasts';
import { WeatherGroundMask } from '../src/weatherGroundMask';
import { IsoCamera, LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../src/world';

const object = (x: number): LiveObject => ({
  id: 1,
  uid: 1,
  kind: 'vehicle',
  type: 'TEST',
  owner: -1,
  x,
  y: 256,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
  renderOrder: { layer: 2, index: 1, ySort: x + 256 },
});
const snapshot = (frame: number, x: number): LiveSnapshot => ({
  frame,
  view: { x, y: 0 },
  houses: [],
  objects: [object(x)],
});
const dockSnapshot = (frame: number, x = 13952, y = 26240): LiveSnapshot => ({
  ...snapshot(frame, 0),
  objects: [
    { ...object(x), contactUid: 2, y, renderOrder: { layer: 2, index: 8, ySort: 40192 } },
    {
      ...object(51 * 256 + 128),
      uid: 2,
      type: 'TESTBUILD',
      kind: 'building',
      dock: true,
      y: 101 * 256 + 128,
      renderOrder: { layer: 2, index: 7, ySort: 38912 },
    },
  ],
});

/** Real push, render, applyCamera, applyObjects, applyEffects and applyPainterOrder; only resource/GPU edges are fakes. */
function presentation() {
  const frame = { rect: [0, 0, 16, 24] as [number, number, number, number], offset: [-8, -18] as [number, number] };
  const cache = {
    manifest: {
      sprites: { 'building:TESTBUILD': { frames: [frame], palette: 'unit', foundation: [4, 4] } },
      spriteAtlas: { width: 64, height: 64 },
      objects: [],
    },
    paletteAtlas: { image: { height: 1 } },
    spriteAtlas: new Texture(),
    paletteRow: new Map([['unit', 0]]),
  } as unknown as Ra2Cache;
  const staticCards = new SpriteLayer(cache, [
    { anchor: new Vector3(), frame, palette: 'unit', push: 0.2, shadow: false },
  ]);
  const cellLayer = new SpriteLayer(cache, []);
  const overlayLayer = new SpriteLayer(cache, []);
  const sprites = new SpriteLayer(cache, [], 8);
  const root = new VoxelUnit();
  const mesh = new Mesh();
  root.addSourceMesh(mesh);
  const visual = {
    root,
    mode: 'voxel',
    type: 'TEST',
    paletteKey: '',
    firstFrame: 1,
    lastMoveFrame: undefined as number | undefined,
    painter: undefined as PainterObject | undefined,
  };
  const shroud = { hidden: false, isLocationShrouded: () => shroud.hidden };
  const effectDriver = {
    frame: vi.fn(),
    skyFlash: () => 0,
    cards: vi.fn(() => ({ drawn: 0, missing: 0 })),
    smokeCards: vi.fn(),
    volumes: vi.fn(),
  };
  const effectSprites = { setInstances: vi.fn(), now: { value: 0 }, displayScale: { value: 1 } };
  const hd = {
    settings: { sourceLights: 0 },
    seconds: () => 1,
    meanExposure: 2,
    frame: vi.fn(),
    setSceneLighting: vi.fn(),
    setTopEffectsVisible: vi.fn(),
    windowsWanted: () => false,
    materialsWanted: () => false,
    view: new IsoCamera(),
  };
  const effectArt = { revision: 0, particle: () => ({ sprite: { frames: [frame] }, art: { translucency: 0 } }) };
  const state = {
    buildingLightGate: new BuildingLightGate(),
    current: null as null | { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveObject> },
    previous: null as null | { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveObject> },
    appearances: new Map(),
    houseColour: new Map(),
    housePaletteKeys: new Map(),
    buildingAnimMatches: new Map(),
    library: null as null | { revision: number },
    cache,
    hd,
    shroud,
    effectDriver,
    volumetricBlasts: new VolumetricBlastLayer({ light: staticCards.light, sunDirection: staticCards.toCamera }),
    volumeInstances: [],
    liveBeams: { update: vi.fn(), displayScale: { value: 1 } },
    effectSprites,
    effectArt,
    warnedCells: true,
    visuals: new Map([[1, visual]]),
    root: new Group(),
    world: { sprites: staticCards, terrain: { heightAt: () => 0 } },
    sprites,
    cellLayer,
    cellInstances: [],
    overlayLayers: new Map([[0, { layer: overlayLayer, materials: false }]]),
    overlayInstances: { instances: { pages: new Map([[0, overlayLayer.getInstances()]]) } },
    uploadedOverlays: new Map([[0, overlayLayer.getInstances()]]),
    pageLayers: new Map(),
    spriteBatch: new Map(),
    spritePool: new SpritePool(),
    particlePool: new SpritePool(),
    effectInstances: [] as EffectInstance[],
    painterObjects: [],
    painterDirty: false,
    effectsDirty: false,
    pose: { x: 0, y: 0, z: 0, facing: 0 },
    voxelUnits: {
      pose: VoxelUnits.prototype.pose,
      setPainterBias: VoxelUnits.prototype.setPainterBias,
      setNativeDepth: VoxelUnits.prototype.setNativeDepth,
      setGroundContact: VoxelUnits.prototype.setGroundContact,
      setOpacity: VoxelUnits.prototype.setOpacity,
    },
    viewWidth: 0,
    viewHeight: 0,
    lastRender: 0,
    cellsDirty: false,
    ensureHouse: vi.fn(),
    updateOverlays: vi.fn(),
    updateSmudges: vi.fn(),
    updateNightSources: vi.fn(),
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as LiveView;
  const live = view as unknown as typeof state & {
    applyPainterOrder(): void;
    applyEffects(snapshot: LiveSnapshot): void;
    particleCards(effects: NonNullable<LiveSnapshot['effects']>, out: EffectInstance[]): void;
  };
  const order = vi.spyOn(live, 'applyPainterOrder');
  const uploads = [staticCards, cellLayer, overlayLayer].map((layer) => vi.spyOn(layer, 'setInstances'));
  return { view, live, visual, mesh, order, uploads, effectSprites, effectDriver, effectArt, hd, shroud };
}

describe('LiveView ground motion', () => {
  /** Drive along +x at `step` leptons per logic frame; snapshots arrive at `arrivals` (ms), the display runs at 60 Hz. */
  function drive(arrivals: number[], step: number) {
    const p = presentation();
    const shown: number[] = [];
    let next = 0;
    for (let now = arrivals[0]!; now <= arrivals.at(-1)! + 120; now += 1000 / 60) {
      for (; next < arrivals.length && arrivals[next]! <= now; next++)
        p.view.push({ ...snapshot(next + 1, 0), objects: [object(256 + next * step)] }, arrivals[next]!);
      p.view.render(now);
      shown.push(p.visual.root.position.x * 256);
    }
    return { p, shown };
  }

  it('plays a drive at an even speed although snapshots arrive early and late', () => {
    // A 20 Hz logic delivered 35 to 60 ms apart, as the live bridge does most of the time (mean 50 ms).
    const gaps = [50, 35, 60, 50, 40, 60, 45, 55, 60, 40, 50, 35, 60, 50, 50, 40, 60, 50, 45, 55, 50, 60, 40, 50];
    const arrivals = gaps.reduce((times, gap) => [...times, times.at(-1)! + gap], [0]);
    const { shown } = drive(arrivals, 24);
    // Skip the start (the period is still being learned) and the stop.
    const from = shown.findIndex((x) => x > 256 + 6 * 24);
    const to = shown.findIndex((x) => x > 256 + (arrivals.length - 3) * 24);
    const steps = shown.slice(from + 1, to).map((x, i) => x - shown[from + i]!);
    expect(steps.length).toBeGreaterThan(40);
    const sorted = [...steps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    // 24 leptons per 50 ms logic frame at 60 Hz: 8 leptons per display frame.
    expect(median).toBeGreaterThan(6.5);
    expect(median).toBeLessThan(9.5);
    // No display frame without movement and no jump: interpolating over the last arrival interval stalled until a
    // late snapshot came and leapt forward when one came early (steps from 0 up to 3 times the median).
    expect(sorted[0]!).toBeGreaterThan(0.75 * median);
    expect(sorted.at(-1)!).toBeLessThan(1.25 * median);
    const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
    const deviation = Math.sqrt(steps.reduce((sum, step) => sum + (step - mean) ** 2, 0) / steps.length);
    expect(deviation / mean).toBeLessThan(0.1);
    // Never ahead of the newest snapshot, and at rest exactly on the last one.
    expect(shown.at(-1)).toBeCloseTo(256 + (arrivals.length - 1) * 24, 6);
    for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]! - 1e-9);
  });

  it('rests on the newest pose when a snapshot is very late and resumes from there without a jump', () => {
    const arrivals = [0, 50, 100, 150, 200, 250, 300, 420, 470, 520, 570, 620];
    const { shown } = drive(arrivals, 24);
    const at = (ms: number) => shown[Math.round(ms / (1000 / 60))]!;
    // The step that arrived at 300 ms is played out by 362.5 ms; nothing is extrapolated while waiting.
    expect(at(400)).toBeCloseTo(256 + 6 * 24, 6);
    expect(at(416)).toBeCloseTo(256 + 6 * 24, 6);
    const steps = shown.map((x, i) => (i ? x - shown[i - 1]! : 0));
    const resumed = steps.slice(Math.round(420 / (1000 / 60)) + 1, Math.round(600 / (1000 / 60)));
    expect(Math.min(...resumed)).toBeGreaterThan(3);
    expect(Math.max(...resumed)).toBeLessThan(12);
  });

  it('starts a unit first seen, hidden or teleported at its snapshot pose instead of sweeping it in', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.render(0);
    p.view.push(snapshot(2, 356), 50);
    p.view.push(snapshot(3, 456), 100);
    p.view.render(110);
    const before = p.visual.root.position.x;
    expect(before).toBeGreaterThan(256 / 256);
    expect(before).toBeLessThan(456 / 256);
    // Three cells or more in one logic frame is a teleport: shown at once.
    p.view.push(snapshot(4, 456 + 4 * 256), 150);
    p.view.render(151);
    expect(p.visual.root.position.x).toBeCloseTo((456 + 4 * 256) / 256, 9);
    // Hidden by the game for a while, then shown elsewhere nearby: no glide from the stale pose.
    p.view.push({ ...snapshot(5, 0), objects: [{ ...object(456 + 4 * 256 + 100), nativeHidden: true }] }, 200);
    p.view.render(210);
    p.view.push({ ...snapshot(6, 0), objects: [{ ...object(456 + 4 * 256 + 200), nativeHidden: true }] }, 250);
    p.view.render(260);
    p.view.push(snapshot(7, 456 + 4 * 256 + 300), 300);
    p.view.render(301);
    const reappeared = p.visual.root.position.x * 256;
    expect(reappeared).toBeGreaterThanOrEqual(456 + 4 * 256 + 200);
    expect(reappeared).toBeLessThanOrEqual(456 + 4 * 256 + 300);
  });

  it("tilts a vehicle with the game's own up vector, blended between logic frames, and with the ground without one", () => {
    const p = presentation();
    const pose = vi.spyOn(p.live.voxelUnits, 'pose');
    const contact = vi.spyOn(p.live.voxelUnits, 'setGroundContact');
    const tilted = (frame: number, x: number, tilt?: LiveObject['tilt']): LiveSnapshot => ({
      ...snapshot(frame, 0),
      objects: [{ ...object(x), ...(tilt ? { tilt } : {}) }],
    });
    // Engine axes (x, y, z up) become world axes (x, y up, z): a body leaning east and south.
    p.view.push(tilted(1, 256, { x: 0, y: 0, z: 1 }), 0);
    p.view.render(0);
    expect(pose.mock.lastCall![3]!.toArray()).toEqual([0, 1, 0]);
    // A level body leaves the shadow in the ground's own plane.
    expect(contact).toHaveBeenLastCalledWith(p.visual, true, undefined);
    const edge = { x: 0.4896, y: 0.2, z: Math.sqrt(1 - 0.4896 ** 2 - 0.04) };
    p.view.push(tilted(2, 280, edge), 50);
    p.view.push(tilted(3, 304, edge), 100);
    p.view.render(130);
    const between = pose.mock.lastCall![3]!.clone();
    expect(between.length()).toBeCloseTo(1, 9);
    expect(between.x).toBeGreaterThan(0);
    expect(between.x).toBeLessThan(edge.x);
    expect(between.z).toBeGreaterThan(0);
    expect(between.z).toBeLessThan(edge.y);
    p.view.render(400);
    const up = pose.mock.lastCall![3]!;
    expect(up.x).toBeCloseTo(edge.x, 9);
    expect(up.y).toBeCloseTo(edge.z, 9);
    expect(up.z).toBeCloseTo(edge.y, 9);
    // On the ramp the footprint shadow lies in the body's plane.
    expect(contact.mock.lastCall![1]).toBe(true);
    expect(contact.mock.lastCall![2]!.distanceTo(up)).toBe(0);
    const column = new Vector3().setFromMatrixColumn(p.visual.root.matrix, 1);
    p.visual.root.updateMatrix();
    expect(column.setFromMatrixColumn(p.visual.root.matrix, 1).distanceTo(up)).toBeLessThan(1e-9);
    // A unit the reader reports no tilt for (other locomotors) follows the renderer's own ground again.
    p.view.push(tilted(4, 304), 450);
    p.view.render(451);
    expect(pose.mock.lastCall![3]).toBeNull();
    expect(contact).toHaveBeenLastCalledWith(p.visual, true, undefined);
    p.visual.root.updateMatrix();
    expect(column.setFromMatrixColumn(p.visual.root.matrix, 1).toArray()).toEqual([0, 1, 0]);
  });

  it('keeps the ground card and the contact shadow all the way up a ramp, and drops both in the air', () => {
    const p = presentation();
    // A ramp rising one level per cell along +x: the grid lookup knows only the nodes at half cells.
    const surface = (x: number) => Math.max(0, x - 1) * LEVEL_HEIGHT;
    Object.assign(p.live.world.terrain, {
      heightAt: (x: number) => surface(Math.round(x * 2) / 2),
      surfaceHeightAt: (x: number) => surface(x),
    });
    const contact = vi.spyOn(p.live.voxelUnits, 'setGroundContact');
    const depth = vi.spyOn(p.live.voxelUnits, 'setNativeDepth');
    let frame = 1;
    const at = (cell: number, level: number, layer = 2) => {
      const unit = { ...object(cell * 256), z: Math.round(level * 104), renderOrder: { layer, index: 1, ySort: 0 } };
      p.view.push({ ...snapshot(frame, 0), objects: [unit] }, frame * 1000);
      p.view.render(frame++ * 1000 + 500);
      return [contact.mock.lastCall![1], depth.mock.lastCall![3]];
    };
    for (const cell of [1.05, 1.2, 1.3, 1.45, 1.55, 1.7, 1.8, 1.95]) expect(at(cell, cell - 1)).toEqual([true, true]);
    // The game's own ramp heights differ a little from the mesh on corner ramps.
    expect(at(1.5, 0.5 + 0.25)).toEqual([true, true]);
    expect(at(1.5, 0.5 + 0.4)).toEqual([false, false]);
    expect(at(1.5, 3)).toEqual([false, false]);
    expect(at(1.5, 0.5, 3)).toEqual([false, false]);
  });
});

describe('LiveView physical occlusion scheduling', () => {
  it('hides the whole native-hidden voxel root and restores it on the same logic frame', () => {
    const p = presentation();
    const snap = snapshot(1, 256);
    snap.objects[0]!.isSelected = true;
    p.view.push(snap, 0);
    p.view.render(0);
    const shadow = new Mesh();
    p.visual.root.add(shadow);
    p.view.push({ ...snap, objects: [{ ...snap.objects[0]!, nativeHidden: true }] }, 10);
    p.view.render(10);
    expect(p.visual.root.visible).toBe(false);
    expect(shadow.parent).toBe(p.visual.root);
    expect(p.live.painterObjects).toHaveLength(0);
    expect(p.live.sprites.getInstances()).toHaveLength(0);
    p.view.push({ ...snap }, 20);
    p.view.render(20);
    expect(p.visual.root.visible).toBe(true);
    expect(p.live.painterObjects).toHaveLength(1);
  });

  it('forwards and clears body opacity without rebuilding the voxel visual', () => {
    const p = presentation();
    const opacity = vi.spyOn(p.live.voxelUnits, 'setOpacity');
    const snap = snapshot(1, 256);
    snap.objects[0]!.translucent = 0.5;
    p.view.push(snap, 0);
    p.view.render(0);
    expect(opacity).toHaveBeenLastCalledWith(p.visual, 0.5);
    p.view.push({ ...snap, objects: [{ ...snap.objects[0]!, translucent: undefined }] }, 10);
    p.view.render(10);
    expect(opacity).toHaveBeenLastCalledWith(p.visual, 1);
    expect(p.live.visuals.get(1)).toBe(p.visual);
  });

  it.each([0, 0.5, 1])(
    'holds a vanished building body and shadow for one missing logic frame at health %s',
    (health) => {
      const p = presentation();
      const art = p.live.cache.manifest.sprites['building:TESTBUILD']!;
      art.shadows = [...art.frames];
      const weatherMask = new WeatherGroundMask(10, 10);
      Object.assign(p.hd, { weatherGroundMask: weatherMask });
      const building = { ...object(512), id: 2, uid: 2, kind: 'building' as const, type: 'TESTBUILD', health };
      p.view.push({ ...snapshot(10, 256), objects: [object(256), building] }, 0);
      p.view.render(0);
      const visual = p.live.visuals.get(2);
      const cards = p.live.sprites.getInstances().map((s) => ({ frame: s.frame, shadow: s.shadow }));
      expect(cards).toHaveLength(2);
      expect(weatherMask.texture.image.data[12]).toBe(255);
      p.view.push(snapshot(11, 256), 100);
      p.view.render(100);
      expect(p.live.visuals.get(2)).toBe(visual);
      expect(p.live.sprites.getInstances().map((s) => ({ frame: s.frame, shadow: s.shadow }))).toEqual(cards);
      // Roof art remains drawable for this frame, so rain/snow and wet-film exclusions must remain too.
      expect(weatherMask.texture.image.data[12]).toBe(255);
      const version = weatherMask.texture.version;
      p.view.render(110);
      expect(weatherMask.texture.version).toBe(version);
      // An art revision must refresh the retained footprint as well as the retained building cards.
      art.foundation = [3, 2];
      p.effectArt.revision++;
      p.view.render(115);
      expect(weatherMask.texture.image.data[24]).toBe(255);
      expect(weatherMask.texture.image.data[45]).toBe(0);
      const revisedVersion = weatherMask.texture.version;
      p.view.push(snapshot(11, 256), 120);
      p.view.render(120);
      expect(p.live.visuals.get(2)).toBe(visual);
      expect(weatherMask.texture.image.data[12]).toBe(255);
      expect(weatherMask.texture.version).toBe(revisedVersion);
      p.view.push(snapshot(12, 256), 200);
      p.view.render(200);
      expect(p.live.visuals.has(2)).toBe(false);
      expect(p.live.sprites.getInstances()).toHaveLength(0);
      expect(weatherMask.texture.image.data[12]).toBe(0);
      weatherMask.dispose();
    },
  );

  it.each([
    ['inside', 'infantry', 0.5, 1.5, true, 2, 0, true],
    ['light-sidecar inside', 'infantry', 0.5, 1.5, true, 2, 0, true],
    ['outside south', 'infantry', 0.5, 2.2, true, 2, 0, true],
    ['no building', 'infantry', 0.5, 1.5, false, 2, 0, true],
    ['inside vehicle', 'vehicle', 0.5, 1.5, true, 2, 0, true],
    ['inside aircraft', 'aircraft', 0.5, 1.5, true, 2, 0, true],
    ['air layer', 'infantry', 0.5, 1.5, true, 3, 0, true],
    ['airborne ground registration', 'infantry', 0.5, 1.5, true, 2, 104, true],
    ['outside west', 'infantry', -0.01, 1.5, true, 2, 0, true],
    ['outside east', 'infantry', 2.01, 1.5, true, 2, 0, true],
    ['outside north', 'infantry', 0.5, -0.01, true, 2, 0, true],
    ['west inset boundary', 'infantry', 0.05, 1.5, true, 2, 0, true],
    ['south inset boundary', 'infantry', 0.5, 1.95, true, 2, 0, true],
    ['past west inset', 'infantry', 0.051, 1.5, true, 2, 0, true],
  ] as const)('draws the expected body and shadow for %s', (label, kind, x, z, building, layer, altitude, drawn) => {
    const p = presentation();
    const frame = {
      rect: [0, 0, 21, 30] as [number, number, number, number],
      offset: [-15, -25] as [number, number],
      page: 0,
    };
    const art: SpriteEntry = { frames: [frame], shadows: [frame], canvas: [32, 64], palette: 'unit', remap: true };
    const unitType: LibraryType = {
      kind,
      image: 'TEST',
      sprite: 'unit',
      drawOffset: [0, 0],
      lighting: 'ambient',
      remap: true,
      shpUnit: { facings: 1, frames: { WalkFrames: 1 } },
    };
    const buildingType: LibraryType = {
      kind: 'building',
      image: 'TESTBUILD',
      sprite: 'body',
      foundation: [2, 2],
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
      building: { bodyFrames: 1, layers: [] },
    };
    const weatherMask = label === 'light-sidecar inside' ? new WeatherGroundMask(70, 20) : null;
    if (weatherMask) {
      // The sidecar knows the weather footprint while resolved art still has no depth foundation.
      delete buildingType.foundation;
      Object.assign(p.hd, { weatherGroundMask: weatherMask });
      Object.assign(p.live.cache, { lights: { types: { TESTBUILD: { foundation: [3, 2] } } } });
    }
    Object.assign(p.live, {
      libraryPaletteKeys: new Map(),
      library: {
        revision: 0,
        conditionYellow: 0.5,
        type: (id: string) => (id === 'TESTBUILD' ? buildingType : unitType),
        library: { sprites: { body: art, unit: art } },
        page: () => ({}),
        hasHdPage: () => false,
      },
    });
    Object.assign(p.effectArt, { storesOre: () => false });
    Object.assign(p.visual, { mode: 'library-sprite', libraryType: unitType });
    vi.spyOn(p.live as unknown as { pageLayer(key: number): SpriteLayer }, 'pageLayer').mockReturnValue(p.live.sprites);
    const snap = snapshot(1, (67 + x) * 256);
    Object.assign(snap.objects[0]!, {
      kind,
      y: (14 + z) * 256,
      z: altitude,
      shpUnitPose: { state: 'walk', step: 0 },
      renderOrder: { layer, index: 56, ySort: 21248 },
    });
    if (building)
      snap.objects.push({
        ...object(67.5 * 256),
        uid: 2,
        kind: 'building',
        type: 'TESTBUILD',
        y: 14.5 * 256,
        buildState: 'done',
        buildingFrame: 0,
      });
    p.view.push(snap, 0);
    const queue = vi.spyOn(p.view as unknown as { queue(batch: unknown, instance: SpriteInstance): void }, 'queue');
    p.view.render(0);
    const unitCards = (p.live.spriteBatch.get(0) ?? []).filter((s) => s.frame === frame && !s.painter?.foundation);
    // Shadows have no painter, so distinguish their anchor from the building's NW corner.
    const own = unitCards.filter(
      (s) => Math.abs(s.anchor.x - (67 + x)) < 0.001 && Math.abs(s.anchor.z - (14 + z)) < 0.001,
    );
    expect(own.filter((s) => !s.shadow)).toHaveLength(drawn ? 1 : 0);
    expect(own.filter((s) => s.shadow)).toHaveLength(drawn ? 1 : 0);
    expect(p.visual.root.visible).toBe(drawn);
    if (weatherMask) {
      expect(weatherMask.texture.image.data[15 * 70 + 67]).toBe(255);
      expect(p.live.visuals.get(2)?.painter?.foundation).toBeUndefined();
      expect(p.live).not.toHaveProperty('foundationIndex');
    }
    if (!drawn) expect(queue.mock.calls.every((call) => call[1].anchor.x === 67 && call[1].anchor.z === 14)).toBe(true);
    // Opaque body/template pixels decide visibility; no instance-level spawn hiding remains.
    if (kind === 'infantry')
      expect(own.find((card) => !card.shadow)?.nativeDepth?.mode).toBe(
        layer === 2 && altitude === 0 ? 'card' : undefined,
      );
    const cardsForUnit = () =>
      (p.live.spriteBatch.get(0) ?? []).filter(
        (s) => Math.abs(s.anchor.x - (67 + x)) < 0.001 && Math.abs(s.anchor.z - (14 + z)) < 0.001,
      );
    const chrono = {
      ...snap,
      objects: snap.objects.map((o) => ({ ...o, translucent: o.uid === 1 ? 0.5 : undefined })),
    };
    p.view.push(chrono, 10);
    p.view.render(10);
    expect(cardsForUnit().find((s) => !s.shadow)?.opacity).toBe(0.5);
    expect(cardsForUnit().find((s) => s.shadow)?.opacity).toBeUndefined();
    const hiddenUnit = { ...chrono, objects: chrono.objects.map((o) => ({ ...o, nativeHidden: o.uid === 1 })) };
    p.view.push(hiddenUnit, 20);
    p.view.render(20);
    expect(cardsForUnit()).toHaveLength(0);
    expect(p.visual.root.visible).toBe(false);
    p.view.push({ ...snap }, 30);
    p.view.render(30);
    expect(cardsForUnit()).toHaveLength(2);
    expect(cardsForUnit().every((s) => s.opacity === undefined)).toBe(true);
    weatherMask?.dispose();
  });

  it.each([
    ['A: west foundation cell', 67.5, 15.5, true, 0.810132945],
    ['B: foundation centre', 68, 15, true, 1.626629525],
    ['C: northwest foundation cell', 67.5, 14.5, true, 2.443126106],
    ['D: outside south', 67.5, 16.2, false, -0.332962269],
  ] as const)('reconstructs an upright library card at %s', (_, x, z, hidden, margin) => {
    const p = presentation();
    const buildingType: LibraryType = {
      kind: 'building',
      image: 'TESTBUILD',
      sprite: 'body',
      foundation: [2, 2],
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
      building: { bodyFrames: 1, height: 9 },
    };
    const infantryType: LibraryType = {
      kind: 'infantry',
      image: 'TEST',
      sprite: 'unit',
      drawOffset: [0, 0],
      lighting: 'ambient',
      remap: true,
    };
    // Synthetic atlas rectangles with the observed bottom padding; no original pixels or atlas positions.
    const bodyFrame = { rect: [0, 0, 90, 163] as const, offset: [-46, -111] as const };
    const unitFrame = { rect: [0, 0, 21, 30] as const, offset: [-15, -25] as const };
    const art = (frame: typeof bodyFrame | typeof unitFrame): SpriteEntry => ({
      frames: [{ rect: [...frame.rect], offset: [...frame.offset] }],
      shadows: [{ rect: [...frame.rect], offset: [...frame.offset] }],
      canvas: [96, 176],
      palette: 'unit',
      remap: true,
    });
    Object.assign(p.live, {
      libraryPaletteKeys: new Map(),
      library: {
        revision: 0,
        conditionYellow: 0.5,
        type: (id: string) => (id === 'TESTBUILD' ? buildingType : infantryType),
        library: { sprites: { body: art(bodyFrame), unit: art(unitFrame) } },
        page: () => ({}),
        hasHdPage: () => false,
      },
    });
    Object.assign(p.effectArt, { storesOre: () => false });
    Object.assign(p.visual, { mode: 'library-sprite', libraryType: infantryType });
    // Retain the real queue, pool, material and buffer upload paths; replace only the atlas/GPU boundary.
    vi.spyOn(p.live as unknown as { pageLayer(key: number): SpriteLayer }, 'pageLayer').mockReturnValue(p.live.sprites);
    const snap = snapshot(1, x * 256);
    snap.objects = [
      { ...object(x * 256), kind: 'infantry', y: z * 256, z: 208, renderOrder: { layer: 2, index: 56, ySort: 21248 } },
      {
        ...object(67.5 * 256),
        uid: 2,
        kind: 'building',
        type: 'TESTBUILD',
        y: 14.5 * 256,
        z: 208,
        buildState: 'done',
        buildingFrame: 0,
        renderOrder: { layer: 2, index: 41, ySort: 20736 },
      },
    ];
    p.view.push(snap, 0);
    p.view.render(0);
    const cards = p.live.spriteBatch.get(0)! as SpriteInstance[];
    const unit = cards.find((s) => !s.shadow && !s.painter?.foundation)!;
    const body = cards.find((s) => !s.shadow && s.painter?.foundation)!;
    expect(body.anchor.toArray()).toEqual([67, 2 * LEVEL_HEIGHT, 14]);
    expect(unit.anchor.x).toBeCloseTo(x, 10);
    expect(unit.anchor.y).toBe(2 * LEVEL_HEIGHT);
    expect(unit.anchor.z).toBeCloseTo(z, 10);
    expect([body.push, unit.push]).toEqual([cardPush(body.frame), cardPush(unit.frame)]);
    expect(body).toMatchObject({ flat: false, shadow: false, painterPart: 0, painter: { bias: 0 } });
    expect(unit).toMatchObject({ flat: false, shadow: false, painterPart: 0 });
    expect(unit.painter!.afterEqual).toBeUndefined();
    expect(spritePainterBias(unit.painter)).toBeCloseTo((0.01 * 56) / 88, 12);
    for (const shadow of cards.filter((s) => s.shadow)) {
      expect(shadow.flat).toBe(true);
      expect(shadow.painter).toBeUndefined();
    }
    const uploaded = p.live.sprites as unknown as {
      orderedCards: SpriteInstance[];
      flags: DirtyAttribute;
      params: DirtyAttribute;
    };
    const index = (s: SpriteInstance) => cards.filter((c) => c.shadow).length + uploaded.orderedCards.indexOf(s);
    const profile = (s: SpriteInstance) =>
      Array.from(
        uploaded.flags.array.slice(index(s) * uploaded.flags.itemSize + 4, index(s) * uploaded.flags.itemSize + 8),
      );
    expect(profile(body)).toEqual([2, 2, 0, 0]);
    expect(profile(unit)).toEqual([0, 0, 0, 0]);
    const camera = new IsoCamera();
    camera.target.copy(body.anchor);
    camera.update();
    const range = camera.camera.far - camera.camera.near;
    const right = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 1);
    const toward = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 2);
    const screen = (s: Vector3) => [
      30 * (s.x - s.z),
      15 * (s.x + s.z) - s.y * Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE,
    ];
    const depth = (s: SpriteInstance, pixel: number[]) => {
      const at = screen(s.anchor);
      const px = pixel[0]! - at[0]!;
      const py = pixel[1]! - at[1]!;
      const i = index(s);
      const placement = uploaded.params.array[i * 4 + 3]!;
      const placed = s.anchor
        .clone()
        .addScaledVector(right, px / PIXELS_PER_CELL_EDGE)
        .addScaledVector(up, -py / PIXELS_PER_CELL_EDGE)
        .addScaledVector(toward, placement);
      const physical = (-placed.applyMatrix4(camera.camera.matrixWorldInverse).z - camera.camera.near) / range;
      const [w, h, dx, ds] = profile(s);
      return biasedDepth(
        physical,
        cardDepthPush(px, py, w, h, dx, ds) - placement + uploaded.flags.array[i * uploaded.flags.itemSize + 3]!,
        range,
      );
    };
    // Check both the anchor and an opaque body row, cancelling the actual uploaded placementPush.
    for (const py of [0, -10]) {
      const pixel = screen(unit.anchor);
      pixel[1]! += py;
      const difference = (depth(unit, pixel) - depth(body, pixel)) * range;
      expect(difference > 0).toBe(hidden);
      if (py === -10) expect(difference).toBeCloseTo(margin, 6);
    }
  });

  it('uses native cards only on terrain or a present bridge deck in Ground', () => {
    const p = presentation();
    const live = p.view as unknown as {
      groundCard(object: LiveObject): boolean;
      harvesterBonus(object: LiveObject): number;
    };
    const o = object(256);
    expect(live.groundCard(o)).toBe(true);
    o.z = 104;
    expect(live.groundCard(o)).toBe(false);
    o.z = 416;
    expect(live.groundCard(o)).toBe(false);
    p.live.cache.manifest.objects.push({ kind: 'overlay', type: 'BRIDGE1', x: 1, y: 1, z: 0 });
    expect(live.groundCard(o)).toBe(true);
    o.renderOrder!.layer = 4;
    expect(live.groundCard(o)).toBe(false);
    Object.assign(p.live, {
      library: { type: (type: string) => ({ harvester: type === 'TEST' }) },
      refineryCells: new Set(['1,1']),
    });
    o.imageType = 'UNLOADING';
    expect(live.harvesterBonus(o)).toBe(13);
  });

  it('uses current refinery cells without contact or settlement and keeps painter bias bounded', () => {
    const p = presentation();
    const unitType = { harvester: true };
    const buildingType = { refinery: true, foundation: [4, 3] };
    Object.assign(p.live, {
      library: { revision: 0, type: (id: string) => (id === 'TEST' ? unitType : buildingType) },
    });
    const snap = dockSnapshot(1);
    delete snap.objects[0]!.contactUid;
    p.view.push(snap, 0);
    p.view.render(0);
    expect(p.visual.root.nativeDepth.bonus).toBe(13);
    expect(p.visual.root.nativeDepth.enabled).toBe(1);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(VOXEL_CLEARANCE + spritePainterBias(p.visual.painter));
    const calls = p.order.mock.calls.length;
    p.view.render(50);
    expect(p.order).toHaveBeenCalledTimes(calls);
    expect(p.visual.root.nativeDepth.bonus).toBe(13);
    // Radio contact may persist while leaving; only the current cell decides the bonus.
    p.view.push(dockSnapshot(2, 55 * 256, 26240), 100);
    p.view.render(110);
    expect(p.visual.root.nativeDepth.bonus).toBe(0);
    p.view.push(dockSnapshot(3), 200);
    p.view.render(210);
    expect(p.visual.root.nativeDepth.bonus).toBe(13);
    unitType.harvester = false;
    p.view.push(dockSnapshot(4), 300);
    p.view.render(310);
    expect(p.visual.root.nativeDepth.bonus).toBe(0);
  });

  it.each([
    ['aircraft', 4],
    ['building', 2],
  ] as const)('keeps the ordinary bias for a voxel %s in layer %s', (kind, layer) => {
    const p = presentation();
    const snap = snapshot(1, 0);
    snap.objects = [
      { ...object(4 * 256 + 128), kind, y: 2 * 256 + 128, renderOrder: { layer, index: 8, ySort: 2000 } },
      {
        ...object(1 * 256 + 128),
        uid: 2,
        type: 'TESTBUILD',
        kind: 'building',
        y: 1 * 256 + 128,
        renderOrder: { layer: 2, index: 7, ySort: 1000 },
      },
    ];
    p.view.push(snap, 0);
    p.view.render(0);
    p.view.push({ ...snap, frame: 7 }, 100);
    p.view.render(100);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(VOXEL_CLEARANCE + spritePainterBias(p.visual.painter));
  });

  it('runs real object and painter updates only on changed inputs while units still interpolate each presentation', () => {
    const p = presentation();
    const withBuilding = (frame: number, x: number) => {
      const snap = snapshot(frame, x);
      snap.objects.push({ ...object(512), uid: 2, type: 'TESTBUILD', kind: 'building' });
      return snap;
    };
    const sort = vi.spyOn((p.live.sprites as unknown as { orderedCards: unknown[] }).orderedCards, 'sort');
    p.view.push(withBuilding(1, 256), 0);
    p.view.render(0);
    expect(p.effectSprites.displayScale.value).toBeCloseTo(1 / p.hd.meanExposure);
    p.view.push(withBuilding(2, 356), 100);
    p.view.render(120);
    // The step is due a period and a quarter after its arrival (225 ms) and starts from the poses last presented,
    // capped at 40 ms before the arrival (60 ms).
    expect(p.visual.root.position.x).toBeCloseTo((256 + (100 * (120 - 60)) / (225 - 60)) / 256);
    const bias = p.mesh.userData.painterDepth.bias;
    const count = p.order.mock.calls.length;
    const sorts = sort.mock.calls.length;
    expect(sorts).toBeGreaterThan(0);
    p.effectSprites.setInstances.mockClear();
    p.hd.seconds = () => 1.5;
    for (const [at, exposure] of [
      [140, 2],
      [160, 0.5],
      [180, 4],
      [200, 1],
      [230, 1],
    ] as const) {
      p.hd.meanExposure = exposure;
      p.view.render(at);
      expect(p.effectSprites.displayScale.value).toBeCloseTo(1 / exposure);
    }
    expect(p.visual.root.position.x).toBeCloseTo(356 / 256);
    expect(p.order).toHaveBeenCalledTimes(count);
    expect(sort).toHaveBeenCalledTimes(sorts);
    expect(p.mesh.userData.painterDepth.bias).toBe(bias);
    expect(p.effectSprites.setInstances).not.toHaveBeenCalled();
    expect(p.effectSprites.now.value).toBe(p.hd.seconds());
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
    p.effectArt.revision++;
    p.view.render(240);
    expect(p.order).toHaveBeenCalledTimes(count + 1);
    expect(p.effectSprites.setInstances).toHaveBeenCalledTimes(1);
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
  });

  it('updates same-frame registration in place without snapping units or a scrolling camera', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.push(snapshot(2, 356), 100);
    p.view.render(125);
    const bias = p.mesh.userData.painterDepth.bias;
    const current = p.live.current;
    const previous = p.live.previous;
    const reordered = snapshot(2, 356);
    reordered.objects[0]!.renderOrder!.index = 8;
    p.view.push(reordered, 140);
    p.view.render(150);
    expect(p.live.current).toBe(current);
    expect(p.live.previous).toBe(previous);
    expect(p.live.current?.at).toBe(100);
    // Units play the step until it is due at 225 ms; the camera keeps the arrival interval.
    const first = 256 + (100 * (150 - 60)) / (225 - 60);
    expect(p.visual.root.position.x).toBeCloseTo(first / 256);
    expect(p.hd.view.target.x).toBeCloseTo(306 / 60);
    expect(p.live.current?.byUid.get(1)?.renderOrder?.index).toBe(8);
    expect(p.live.current?.byUid.get(1)?.x).toBe(356);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(bias);
    p.view.push(snapshot(3, 456), 200);
    p.view.render(250);
    // The next step (due at 325 ms) starts from the pose on screen at the last presentation (150 ms), not from the
    // previous snapshot: no jump at its arrival.
    expect(p.visual.root.position.x).toBeCloseTo((first + ((456 - first) * (250 - 160)) / (325 - 160)) / 256);
    expect(p.hd.view.target.x).toBeCloseTo(406 / 60);
  });

  it('updates a same-frame pose endpoint without restarting interpolation', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.push(snapshot(2, 356), 100);
    p.view.push(snapshot(2, 456), 140);
    p.view.render(150);
    expect(p.live.current?.at).toBe(100);
    expect(p.live.previous?.snapshot.objects[0]!.x).toBe(256);
    expect(p.visual.root.position.x).toBeCloseTo((256 + (200 * (150 - 60)) / (225 - 60)) / 256);
    p.view.render(200);
    expect(p.visual.root.position.x).toBeCloseTo((256 + (200 * (200 - 60)) / (225 - 60)) / 256);
    p.view.render(225);
    expect(p.visual.root.position.x).toBeCloseTo(456 / 256);
  });

  it('keeps shrouded-anchor art for the per-pixel mask and still hides InvisibleInGame types', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.render(0);
    p.shroud.hidden = true;
    p.view.push(snapshot(2, 256), 100);
    p.view.render(100);
    expect(p.visual.root.visible).toBe(true);
    expect(p.live.painterObjects).toHaveLength(1);
    p.shroud.hidden = false;
    p.view.push(snapshot(3, 256), 200);
    p.view.render(200);
    expect(p.visual.root.visible).toBe(true);
    expect(p.live.painterObjects).toHaveLength(1);
    Object.assign(p.visual, { libraryType: { invisible: true } });
    p.view.push(snapshot(4, 256), 300);
    p.view.render(300);
    expect(p.visual.root.visible).toBe(false);
    expect(p.live.painterObjects).toHaveLength(0);
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
  });

  it('sweeps old native projectiles when the effects publication becomes unavailable', () => {
    const p = presentation();
    const update = vi.fn();
    Object.assign(p.live, { projectiles: { update } });
    const snap = snapshot(1, 256);
    const bullets = [{ id: 2, uid: 2, type: 'TEST', x: 0, y: 0, z: 0 }];
    p.live.applyEffects({ ...snap, effects: { anims: [], bullets, particleSystems: [] } });
    expect(update.mock.calls[0]![0]).toBe(bullets);
    p.live.applyEffects({ ...snap, effects: null });
    expect(update.mock.calls[1]!.slice(0, 2)).toEqual([[], []]);
  });

  it('keeps particle positions when an object/turret rebuild borrows more sprite anchors', () => {
    const p = presentation();
    const effects = { particleSystems: [{ particles: [{ type: 'TEST', x: 256, y: 512, z: 104 }] }] } as NonNullable<
      LiveSnapshot['effects']
    >;
    p.live.particleCards(effects, p.live.effectInstances);
    const particle = p.live.effectInstances[0]!;
    const original = particle.anchor.clone();
    p.live.spritePool.begin();
    for (let i = 0; i < 20; i++) p.live.spritePool.anchor().set(100 + i, 200, 300);
    p.live.effectsDirty = true;
    p.live.applyPainterOrder();
    expect(particle.anchor.equals(original)).toBe(true);
    expect(p.effectSprites.setInstances).toHaveBeenCalledWith(p.live.effectInstances, 1);
  });
});
