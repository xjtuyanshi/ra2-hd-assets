import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Texture, Vector3 } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry } from '../../ra2-assets/src/manifest';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { BuildingLightGate } from '../src/live/buildingLights';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import type { EffectInstance } from '../src/live/effectSprites';
import { SpritePool } from '../src/live/spritePool';
import { FoundationIndex } from '../src/live/foundationIndex';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { cardDepthPush, foundationPointPush } from '../src/ra2/cardDepth';
import { biasedDepth } from '../src/painterDepth';
import { MAX_PAINTER_BIAS, painterObject, spritePainterBias, type PainterObject } from '../src/ra2/painterOrder';
import { cardPush, SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { VOXEL_CLEARANCE, VoxelUnit } from '../src/ra2/voxels';
import { VolumetricBlastLayer } from '../src/volumetricBlasts';
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
    voxelUnits: { pose: VoxelUnits.prototype.pose, setPainterBias: VoxelUnits.prototype.setPainterBias },
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

describe('LiveView physical occlusion scheduling', () => {
  it.each([
    ['inside', 'infantry', 0.5, 1.5, true, 2, 0, false],
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
    ['past west inset', 'infantry', 0.051, 1.5, true, 2, 0, false],
  ] as const)('draws the expected body and shadow for %s', (_, kind, x, z, building, layer, altitude, drawn) => {
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
    if (!drawn) expect(queue.mock.calls.every((call) => call[1].anchor.x === 67 && call[1].anchor.z === 14)).toBe(true);
    // Containment uses the exact new endpoint even while the pose is interpolated, and refreshes on removal.
    if (!drawn) {
      const outside = {
        ...snap,
        frame: 2,
        objects: snap.objects.map((o) => (o.uid === 1 ? { ...o, y: 16.2 * 256 } : o)),
      };
      p.view.push(outside, 100);
      p.view.render(100);
      expect(p.visual.root.visible).toBe(true);
      const inside = { ...snap, frame: 3 };
      p.view.push(inside, 200);
      p.view.render(200);
      expect(p.visual.root.visible).toBe(false);
      buildingType.invisible = true;
      p.view.push({ ...inside }, 205);
      p.view.render(205);
      expect(p.visual.root.visible).toBe(true);
      buildingType.invisible = false;
      p.view.push({ ...inside }, 207);
      p.view.render(207);
      expect(p.visual.root.visible).toBe(false);
      // A publication can remove a foundation without advancing the logic frame.
      p.view.push({ ...inside, objects: [inside.objects[0]!] }, 210);
      p.view.render(210);
      expect(p.visual.root.visible).toBe(true);
    }
  });

  it('unions overlapping foundations in constant-time cell queries without filling empty corners', () => {
    const index = new FoundationIndex();
    for (let i = 0; i < 1000; i++) {
      index.add(0, 0, 2, 2);
      index.add(1, 1, 2, 2);
    }
    expect(index.contains(1, 1)).toBe(true); // Internal cell seam, not an exterior edge.
    expect(index.contains(1.99, 1.99)).toBe(true); // Inside the second despite the first's inset.
    expect(index.contains(0.5, 2.2)).toBe(false);
    expect(index.contains(2.2, 0.5)).toBe(false);
    expect(index.contains(0.05, 0.5)).toBe(false);
    expect(index.contains(0.0501, 0.5)).toBe(true);
    expect(index.contains(2.95, 2.5)).toBe(false);
    expect(index.contains(2.9499, 2.5)).toBe(true);
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
    expect(body).toMatchObject({ flat: false, shadow: false, painterPart: 0, painter: { bias: 0, pull: 0 } });
    expect(unit).toMatchObject({ flat: false, shadow: false, painterPart: 0, painter: { pull: 0 } });
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
    const profile = (s: SpriteInstance) => Array.from(uploaded.flags.array.slice(index(s) * 8 + 4, index(s) * 8 + 8));
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
        cardDepthPush(px, py, w, h, dx, ds) - placement + uploaded.flags.array[i * 8 + 3]!,
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

  it.each(['infantry', 'vehicle'] as const)(
    'uploads propagated pull for a passing sprite %s and removes it behind the dock',
    (kind) => {
      const p = presentation();
      p.live.cache.manifest.sprites['building:TESTBUILD']!.foundation = [4, 3];
      p.view.push(dockSnapshot(1), 0);
      p.view.render(0);
      const passing: LiveObject = { ...object(13952 + 256), uid: 3, kind, y: 26240 };
      p.live.current!.byUid.set(passing.uid, passing);
      const painter = { ...painterObject(2, 0, 9), uid: 3, x: 55, z: 102 };
      p.live.visuals.set(3, { ...p.visual, mode: 'library-sprite', root: new VoxelUnit(), painter });
      // The same pooled upright record used by both infantry and SHP vehicle draw paths.
      const pool = new SpritePool();
      pool.painter = painter;
      const frame = p.live.cache.manifest.sprites['building:TESTBUILD']!.frames[0]!;
      const card = pool.take(new Vector3(passing.x / 256, 0, passing.y / 256), frame, 'unit', 0.2, false);
      p.live.spriteBatch.get('map')!.push(card);
      p.live.applyPainterOrder();
      const uploaded = p.live.sprites as unknown as { orderedCards: (typeof card)[]; flags: { array: Float32Array } };
      const bias = () => uploaded.flags.array[uploaded.orderedCards.indexOf(card) * 8 + 3]!;
      const docked = p.visual.painter!;
      expect(painter.pull).toBeGreaterThan(0);
      expect(bias()).toBeCloseTo(spritePainterBias(painter), 6);
      expect((passing.x / 256 + passing.y / 256) * Math.sqrt(3 / 8) + bias()).toBeGreaterThan(
        (13952 / 256 + 26240 / 256) * Math.sqrt(3 / 8) + spritePainterBias(docked),
      );
      expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(VOXEL_CLEARANCE + spritePainterBias(docked));
      painter.index = 6;
      p.live.applyPainterOrder();
      expect(painter.pull).toBe(0);
      expect(bias()).toBeCloseTo(painter.bias, 6);
    },
  );

  it('pulls the measured dock footprint immediately, keeps turret bias, and refreshes only on changed inputs', () => {
    const p = presentation();
    p.live.cache.manifest.sprites['building:TESTBUILD']!.foundation = [4, 3];
    const expectedPull = foundationPointPush(2.5, 1.5, 4, 3) + 0.5;
    p.view.push(dockSnapshot(1), 0);
    p.view.render(0);
    const normalBias = () => VOXEL_CLEARANCE + (p.visual.painter?.bias ?? 0);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);
    const calls = p.order.mock.calls.length;
    p.view.render(50);
    expect(p.order).toHaveBeenCalledTimes(calls);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);
    p.view.push(dockSnapshot(6), 60);
    p.view.render(60);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);
    p.view.push(dockSnapshot(7), 70);
    p.view.render(70);
    expect(p.visual.firstFrame).toBe(1);
    expect(p.visual.painter).toMatchObject({ x: 54, z: 102 });
    expect(p.mesh.userData.painterDepth.bias - normalBias()).toBeCloseTo(expectedPull);
    expect(expectedPull).toBeCloseTo(3.00949, 5);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(MAX_PAINTER_BIAS);
    const settledCalls = p.order.mock.calls.length;
    p.view.render(80);
    expect(p.order).toHaveBeenCalledTimes(settledCalls);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);

    const building = p.live.visuals.get(2)!;
    expect(building.painter).toMatchObject({ x: 51, z: 101, foundation: [4, 3] });
    const turretRoot = new VoxelUnit();
    const turretMesh = new Mesh();
    turretRoot.addSourceMesh(turretMesh);
    Object.assign(building, { buildingTurret: { root: turretRoot } });
    p.live.applyPainterOrder();
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);
    expect(turretMesh.userData.painterDepth.bias).toBeCloseTo(
      VOXEL_CLEARANCE + spritePainterBias(building.painter, 0.4),
    );

    const reordered = dockSnapshot(8);
    reordered.objects[0]!.renderOrder!.index = 6;
    p.view.push(reordered, 90);
    p.view.render(90);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias());

    p.view.push(dockSnapshot(9), 100);
    p.view.render(100);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias() + expectedPull);
    Object.assign(building, { libraryType: { invisible: true } });
    p.view.push(dockSnapshot(10), 110);
    p.view.render(110);
    expect(building.root.visible).toBe(false);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(normalBias());
  });

  it.each([
    ['x', 8, 0],
    ['y', 0, 8],
  ] as const)('keeps the pull while backing in on a %s move', (_, dx, dy) => {
    const p = presentation();
    p.live.cache.manifest.sprites['building:TESTBUILD']!.foundation = [4, 3];
    const normalBias = () => VOXEL_CLEARANCE + (p.visual.painter?.bias ?? 0);
    p.view.push(dockSnapshot(1), 0);
    p.view.render(0);
    p.view.push(dockSnapshot(7), 100);
    p.view.render(100);
    expect(p.mesh.userData.painterDepth.bias - normalBias()).toBeCloseTo(3.00949, 5);
    p.view.push(dockSnapshot(8, 13952 + dx, 26240 + dy), 200);
    p.view.render(250);
    expect(p.visual.lastMoveFrame).toBe(8);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(normalBias() + 2.9);
    p.view.push(dockSnapshot(13, 13952 + dx, 26240 + dy), 300);
    p.view.render(300);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(normalBias() + 2.9);
    p.view.push(dockSnapshot(14, 13952 + dx, 26240 + dy), 400);
    p.view.render(400);
    expect(p.mesh.userData.painterDepth.bias - normalBias()).toBeGreaterThan(2.9);
  });

  it.each([
    ['east', 57 * 256 + 128, 26240],
    ['south', 13952, 106 * 256 + 128],
  ] as const)('keeps a settled voxel outside the %s foundation boundary at ordinary bias', (_, x, y) => {
    const p = presentation();
    p.live.cache.manifest.sprites['building:TESTBUILD']!.foundation = [4, 3];
    p.view.push(dockSnapshot(1, x, y), 0);
    p.view.render(0);
    p.view.push(dockSnapshot(7, x, y), 100);
    p.view.render(100);
    expect(p.mesh.userData.painterDepth.bias).toBeCloseTo(VOXEL_CLEARANCE + spritePainterBias(p.visual.painter));
  });

  it('uses only the contacted host among overlapping visible buildings', () => {
    const p = presentation();
    const refineryArt = p.live.cache.manifest.sprites['building:TESTBUILD']!;
    refineryArt.foundation = [4, 3];
    p.live.cache.manifest.sprites['building:SMALLBUILD'] = { ...refineryArt, foundation: [4, 2] };
    const snap = dockSnapshot(1);
    const smaller: LiveObject = {
      ...snap.objects[1]!,
      uid: 3,
      type: 'SMALLBUILD',
      renderOrder: { layer: 2, index: 6, ySort: 38912 },
    };
    snap.objects.splice(1, 0, smaller);
    p.view.push(snap, 0);
    p.view.render(0);
    p.view.push({ ...snap, frame: 7 }, 100);
    p.view.render(100);
    expect(p.live.visuals.get(3)!.root.visible).toBe(true);
    expect(p.mesh.userData.painterDepth.bias - VOXEL_CLEARANCE - (p.visual.painter?.bias ?? 0)).toBeCloseTo(3.00949, 5);
  });

  it('caps a settled voxel pull at 3.5 even under a taller part of the facade', () => {
    const p = presentation();
    p.live.cache.manifest.sprites['building:TESTBUILD']!.foundation = [4, 3];
    p.view.push(dockSnapshot(1, 52 * 256 + 128, 101 * 256 + 128), 0);
    p.view.render(0);
    p.view.push(dockSnapshot(7, 52 * 256 + 128, 101 * 256 + 128), 100);
    p.view.render(100);
    expect(p.mesh.userData.painterDepth.bias - VOXEL_CLEARANCE - (p.visual.painter?.bias ?? 0)).toBeCloseTo(3.5);
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
    expect(p.visual.root.position.x).toBeCloseTo(276 / 256);
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
    p.view.render(210);
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
    expect(p.visual.root.position.x).toBeCloseTo(306 / 256);
    expect(p.hd.view.target.x).toBeCloseTo(306 / 60);
    expect(p.live.current?.byUid.get(1)?.renderOrder?.index).toBe(8);
    expect(p.live.current?.byUid.get(1)?.x).toBe(356);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(bias);
    p.view.push(snapshot(3, 456), 200);
    p.view.render(250);
    expect(p.visual.root.position.x).toBeCloseTo(406 / 256);
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
    expect(p.visual.root.position.x).toBeCloseTo(356 / 256);
    p.view.render(200);
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
