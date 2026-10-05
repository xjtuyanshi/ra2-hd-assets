import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, type BufferGeometry, Group, Mesh, Vector3 } from 'three/webgpu';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { AtmosphereNodes } from '../src/atmosphere';
import type { HdRenderer } from '../src/HdRenderer';
import type { EffectArt } from '../src/live/effectArt';
import type { LiveBullet } from '../src/live/effects';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { Projectiles } from '../src/live/projectiles';
import { VoxelUnits, type VoxelUnit } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { VOXEL_TO_WORLD } from '../src/ra2/voxelScale';
import { VoxelShadowMesh } from '../src/ra2/voxelShadow';
import { smoothVoxelOptions } from '../src/ra2/voxelSmooth';
import {
  buildStandInVoxelParts,
  hasSmoothVoxelGeometry,
  smoothVoxelPartGeometries,
} from '../src/ra2/voxelSmoothGeometry';
import { SmoothVoxelPool, type SmoothWorkerLike } from '../src/ra2/voxelSmoothPool';
import { answerSmoothSection, type SmoothSectionReply, type SmoothSectionRequest } from '../src/ra2/voxelSmoothWorker';
import { VoxelUnit as VoxelRoot, buildVoxelGeometry, voxelShape } from '../src/ra2/voxels';
import type { HdWorld } from '../src/ra2/world';
import { syntheticSection } from './fixtures/syntheticVoxels';

const OPTIONS = smoothVoxelOptions({ aoRays: 0, supersample: 2 });
const PALETTE = 'lib:unit@house0';

/** A Worker that answers with the Worker module's own handler, only when the test lets it. */
class FakeWorker implements SmoothWorkerLike {
  onmessage: ((event: MessageEvent<SmoothSectionReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: SmoothSectionRequest[] = [];

  postMessage(message: SmoothSectionRequest): void {
    this.requests.push(structuredClone(message));
  }

  terminate(): void {}

  answer(): void {
    const { reply } = answerSmoothSection(this.requests.shift()!);
    this.onmessage?.({ data: reply } as MessageEvent<SmoothSectionReply>);
  }

  fail(message: string): void {
    this.requests.shift();
    this.onerror?.({ message } as ErrorEvent);
  }
}

/** A tank: body, turret and barrel, each its own part of one model (synthetic voxels, no game data). */
const tank = (id: string): VoxelModel => ({
  id,
  palette: 'unit',
  normalsMode: 4,
  turretOffset: 64,
  parts: [
    { role: 'body', sections: [syntheticSection(8, true)] },
    { role: 'turret', sections: [syntheticSection(4)] },
    { role: 'barrel', sections: [syntheticSection(2, true)] },
  ],
});

function harness() {
  const workers: FakeWorker[] = [];
  const pool = new SmoothVoxelPool(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    1,
    60_000,
  );
  const nodes = new AtmosphereNodes();
  const hd = {
    nodes,
    settings: { voxelLook: 'engine' },
    terrainDepth: { setCaptured: vi.fn() },
  } as unknown as HdRenderer;
  const cache = {
    paletteRgb: new Map([
      [PALETTE, new Uint8Array(768).fill(90)],
      ['lib:unit@house1', new Uint8Array(768).fill(160)],
    ]),
    voxels: new Map<string, VoxelModel>(),
    manifest: { sprites: {} as Record<string, { frames: unknown[] }> },
    paletteRow: new Map([
      [PALETTE, 0],
      ['lib:unit@house1', 1],
    ]),
  } as unknown as Ra2Cache;
  const world = { voxelLook: 'remaster', smoothVoxel: OPTIONS } as HdWorld;
  const voxels = new VoxelUnits(hd, world, cache, undefined, { smoothBuilder: pool });
  /** Let the Workers answer everything asked so far, and what that makes the pool ask next, until all is built. */
  const finishMeshes = async () => {
    await vi.waitFor(() => {
      for (const worker of workers) while (worker.requests.length) worker.answer();
      expect(voxels.loading).toBe(0);
    });
  };
  return {
    nodes,
    cache,
    voxels,
    workers,
    finishMeshes,
    dispose() {
      voxels.disposeAll();
      nodes.dispose();
    },
  };
}

/** The real visual selection of LiveView on top of real VoxelUnits; only the scene around them is absent. */
function liveView(h: ReturnType<typeof harness>, models: Map<string, VoxelModel>) {
  const types = new Map<string, LibraryType>();
  for (const id of models.keys())
    types.set(id, { kind: 'vehicle', image: id, voxel: id, drawOffset: [0, 0], lighting: 'full', remap: true });
  const loaded = new Set(models.keys());
  const state = {
    newArtPerFrame: Infinity,
    newArt: 0,
    waitingArt: 0,
    library: {
      loading: 0,
      type: (id: string) => types.get(id),
      voxel: (id: string) => (loaded.has(id) ? (models.get(id) ?? null) : null),
      voxelType: (voxel: string) => (types.has(voxel) ? voxel : undefined),
      voxelFailed: () => false,
    },
    effectArt: { loading: 0 },
    cache: h.cache,
    voxelUnits: h.voxels,
    root: new Group(),
    visuals: new Map<number, unknown>(),
    appearances: new Map<number, { frame: number }>(),
    housePaletteKeys: new Map([
      [0, 'house0'],
      [1, 'house1'],
    ]),
    libraryPaletteKeys: new Map<string, string>(),
    warnedTypes: new Set<string>(),
    options: {},
    // What diagnostics() reads besides the visuals.
    effectStats: { drawn: 0, missing: 0 },
    volumetricBlasts: { stats: () => ({ count: 0 }) },
    effectDriver: { unknownTypes: new Set<string>(), logicFps: 0 },
    overlayInstances: { active: false },
    smudgeInstances: { active: false, instances: { missingTypes: new Set<string>() } },
    cellsFromEngine: false,
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as unknown as {
    outOfSight: boolean;
    objectsFor: unknown;
    visualFor(
      object: LiveObject,
      colorIndex: number,
      frame: number,
    ): VoxelUnit & {
      type: string;
      mode: string;
      pending?: boolean;
    };
    loadingArt(): number;
    diagnostics(): { standInVoxels: number; pendingArt: number; placeholders: number };
  };
  return { view, types, loaded, root: state.root };
}

const vehicle = (uid: number, type: string, extra: Partial<LiveObject> = {}): LiveObject => ({
  id: uid,
  uid,
  kind: 'vehicle',
  type,
  owner: 0,
  x: 256,
  y: 512,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
  ...extra,
});

const partGeometries = (unit: VoxelUnit) => (unit.root as VoxelRoot).partMeshes.map((mesh) => mesh.geometry);
/** What three keys a compiled shader and pipeline on (r186 RenderObject.getGeometryCacheKey). */
const layoutKey = (geometry: BufferGeometry): string =>
  (RenderObject.prototype.getGeometryCacheKey as () => string).call({ geometry });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a voxel unit whose smooth mesh is still being built', () => {
  it('is drawn at once from a stand-in mesh, never as nothing, with the materials and shader layout of the final mesh', () => {
    const h = harness();
    const model = tank('TANK');
    // No geometryReady() first: a caller with something to show just builds.
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    expect(h.voxels.isStandIn(unit)).toBe(true);
    expect(h.voxels.standInUnits).toBe(1);
    // The smooth mesh was asked of the Workers, not built here.
    expect(h.voxels.loading).toBe(1);
    expect(h.workers[0]!.requests).toHaveLength(1);
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(false);
    const root = unit.root as VoxelRoot;
    expect(root.partMeshes).toHaveLength(3);
    expect(unit.turret?.children).toEqual([root.partMeshes[1], root.partMeshes[2]]);
    const material = voxelPbrMaterialFor(h.cache.paletteRgb.get(PALETTE)!, h.nodes);
    for (const mesh of root.partMeshes) {
      expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(mesh.geometry.getIndex()!.count).toBeGreaterThan(0);
      expect(mesh.material).toBe(material);
      expect(mesh.visible).toBe(true);
    }
    // Every shadow twin draws the stand-in too: the unit has its contact shadow from the first frame.
    const twins = root.children.filter((child) => child instanceof VoxelShadowMesh) as VoxelShadowMesh[];
    expect(twins.length).toBeGreaterThanOrEqual(3);
    for (const twin of twins) expect(twin.geometry).toBe(twin.source.geometry);
    expect(root.captureRadius).toBeGreaterThan(0);
    h.dispose();
  });

  it('has the attribute layout of the smooth mesh, so the change of geometry needs no new shader', async () => {
    const h = harness();
    const model = tank('TANK');
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    const standIn = partGeometries(unit);
    const keys = standIn.map(layoutKey);
    await h.finishMeshes();
    const smooth = smoothVoxelPartGeometries(model, OPTIONS)!;
    expect(smooth).toHaveLength(3);
    expect(smooth.map(layoutKey)).toEqual(keys);
    for (const name of ['position', 'normal', 'pindex', 'pshade', 'occlusion', 'curvature', 'vpos'])
      expect(standIn[0]!.getAttribute(name).itemSize).toBe(smooth[0]!.getAttribute(name).itemSize);
    h.dispose();
  });

  it('carries the plain mesh: same faces as the engine look, the palette index as shade, no curvature', () => {
    const model = tank('TANK');
    const [body] = buildStandInVoxelParts(model, voxelShape);
    const nodes = new AtmosphereNodes();
    const [plain] = buildVoxelGeometry(tank('PLAIN'), null, nodes, voxelShape);
    for (const name of ['position', 'normal', 'pindex', 'occlusion'])
      expect(body!.geometry.getAttribute(name).array).toEqual(plain!.geometry.getAttribute(name).array);
    expect(body!.geometry.getIndex()!.array).toEqual(plain!.geometry.getIndex()!.array);
    expect(body!.geometry.getAttribute('pshade').array).toEqual(body!.geometry.getAttribute('pindex').array);
    expect(new Set(body!.geometry.getAttribute('curvature').array)).toEqual(new Set([0]));
    // Lattice positions lie on the section's own grid (8 voxels a side here), like the smooth mesh's.
    const lattice = body!.geometry.getAttribute('vpos').array as Float32Array;
    expect(Math.min(...lattice)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lattice)).toBeLessThanOrEqual(8);
    // The engine-look geometry itself is left as it was.
    expect(plain!.geometry.getAttribute('pshade')).toBeUndefined();
    body!.geometry.dispose();
    plain!.geometry.dispose();
    nodes.dispose();
  });

  it('changes to the smooth mesh in place: the same unit, at the same place, facing and turret angle', async () => {
    const h = harness();
    const model = tank('TANK');
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    const scene = new Group();
    scene.add(unit.root);
    h.voxels.pose(unit, { x: 700, y: 900, z: 104, facing: 1.1 }, 0.4);
    h.voxels.setOpacity(unit, 1);
    h.voxels.setPainterBias(unit, 0.02);
    scene.updateMatrixWorld(true);
    const root = unit.root as VoxelRoot;
    const before = {
      root,
      turret: unit.turret,
      meshes: [...root.partMeshes],
      materials: root.partMeshes.map((mesh) => mesh.material),
      children: [...root.children],
      position: root.position.clone(),
      yaw: root.rotation.y,
      turretYaw: unit.turret!.rotation.y,
      turretAt: unit.turret!.position.clone(),
      matrices: root.partMeshes.map((mesh) => mesh.matrixWorld.clone()),
      depthBias: root.depthBias,
      radius: root.captureRadius,
      geometries: partGeometries(unit),
    };
    const boxes = before.geometries.map((geometry) => {
      geometry.computeBoundingBox();
      return geometry.boundingBox!.clone();
    });
    const released = before.geometries.map((geometry) => {
      const listener = vi.fn();
      geometry.addEventListener('dispose', listener);
      return listener;
    });
    const revision = h.voxels.revision;
    await h.finishMeshes();
    // The view redraws its objects when this changes.
    expect(h.voxels.revision).toBeGreaterThan(revision);
    expect(h.voxels.isStandIn(unit)).toBe(false);
    expect(h.voxels.standInUnits).toBe(0);
    const smooth = smoothVoxelPartGeometries(model, OPTIONS)!;
    // The same objects throughout: nothing was removed, rebuilt or placed again.
    expect(unit.root).toBe(before.root);
    expect(unit.turret).toBe(before.turret);
    expect(root.partMeshes).toEqual(before.meshes);
    expect(root.children).toEqual(before.children);
    expect(root.parent).toBe(scene);
    expect(partGeometries(unit)).toEqual(smooth);
    expect(root.partMeshes.map((mesh) => mesh.material)).toEqual(before.materials);
    for (const twin of root.children.filter((child) => child instanceof VoxelShadowMesh) as VoxelShadowMesh[])
      expect(twin.geometry).toBe(twin.source.geometry);
    expect(root.position.equals(before.position)).toBe(true);
    expect(root.rotation.y).toBe(before.yaw);
    expect(unit.turret!.rotation.y).toBe(before.turretYaw);
    expect(unit.turret!.position.equals(before.turretAt)).toBe(true);
    expect(root.depthBias).toBe(before.depthBias);
    scene.updateMatrixWorld(true);
    root.partMeshes.forEach((mesh, index) => expect(mesh.matrixWorld.equals(before.matrices[index]!)).toBe(true));
    // No pop in size: every part's bounds agree within one voxel of the section (its diagonal on the lattice).
    model.parts.forEach((part, index) => {
      const section = part.sections[0]!;
      const m = section.transform;
      const step = [0, 1, 2].map((a) => (section.maxBounds[a]! - section.minBounds[a]!) / section.size[a]!);
      const voxel =
        VOXEL_TO_WORLD *
        Math.hypot(...[0, 1, 2].map((row) => [0, 1, 2].reduce((n, a) => n + Math.abs(m[row * 4 + a]! * step[a]!), 0)));
      const geometry = smooth[index]!;
      geometry.computeBoundingBox();
      const now: Box3 = geometry.boundingBox!;
      const was = boxes[index]!;
      expect(now.min.distanceTo(was.min)).toBeLessThan(voxel);
      expect(now.max.distanceTo(was.max)).toBeLessThan(voxel);
      expect(now.getCenter(new Vector3()).distanceTo(was.getCenter(new Vector3()))).toBeLessThan(voxel / 2);
    });
    expect(Math.abs(root.captureRadius - before.radius)).toBeLessThan(before.radius * 0.2);
    // The stand-in is released once nothing draws it.
    for (const listener of released) expect(listener).toHaveBeenCalledOnce();
    // A unit built from now on is the final look from its first frame.
    const next = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    expect(h.voxels.isStandIn(next)).toBe(false);
    expect(partGeometries(next)).toEqual(smooth);
    h.dispose();
  });

  it('changes every placed unit of the model, in every house colour, and leaves removed ones alone', async () => {
    const h = harness();
    const model = tank('TANK');
    const red = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    const blue = h.voxels.build(model, 'lib:unit@house1', 'TANK@lib:unit@house1');
    const gone = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    // One stand-in per model, whatever the palette; one build asked.
    expect(partGeometries(blue)).toEqual(partGeometries(red));
    expect((blue.root as VoxelRoot).partMeshes[0]!.material).not.toBe((red.root as VoxelRoot).partMeshes[0]!.material);
    expect(h.voxels.loading).toBe(1);
    expect(h.voxels.standInUnits).toBe(3);
    const standIn = partGeometries(gone);
    h.voxels.dispose(gone);
    expect(h.voxels.standInUnits).toBe(2);
    await h.finishMeshes();
    const smooth = smoothVoxelPartGeometries(model, OPTIONS)!;
    expect(partGeometries(red)).toEqual(smooth);
    expect(partGeometries(blue)).toEqual(smooth);
    expect(partGeometries(gone)).toEqual(standIn);
    expect(h.voxels.standInUnits).toBe(0);
    h.dispose();
  });

  it('is not the final look: prepare() answers false until the mesh is there', async () => {
    const h = harness();
    const model = tank('TANK');
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    expect(h.voxels.built(`TANK@${PALETTE}`)).toBe(true);
    expect(h.voxels.geometryReady(model)).toBe(false);
    expect(h.voxels.prepare(model, PALETTE, `TANK@${PALETTE}`)).toBe(false);
    await h.finishMeshes();
    expect(h.voxels.prepare(model, PALETTE, `TANK@${PALETTE}`)).toBe(true);
    expect(h.voxels.isStandIn(unit)).toBe(false);
    h.dispose();
  });

  it('gets its smooth mesh even when the Worker fails (built in place once, with a warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const model = tank('TANK');
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    h.workers[0]!.fail('crashed');
    await vi.waitFor(() => expect(h.voxels.loading).toBe(0));
    expect(warn).toHaveBeenCalledOnce();
    expect(h.voxels.isStandIn(unit)).toBe(false);
    expect(partGeometries(unit)).toEqual(smoothVoxelPartGeometries(model, OPTIONS));
    h.dispose();
  });

  it('releases its stand-ins with the view, and an answer that comes later changes nothing', async () => {
    const h = harness();
    const model = tank('TANK');
    const unit = h.voxels.build(model, PALETTE, `TANK@${PALETTE}`);
    const standIn = partGeometries(unit);
    const released = vi.fn();
    standIn[0]!.addEventListener('dispose', released);
    h.voxels.disposeAll();
    expect(released).toHaveBeenCalledOnce();
    expect(h.voxels.standInUnits).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(partGeometries(unit)).toEqual(standIn);
    h.nodes.dispose();
  });
});

describe('the live view never leaves a shown voxel object undrawn while its mesh is built', () => {
  it('draws a new kind in its first frame and keeps that visual when the mesh arrives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const model = tank('HTNK');
    const { view, root } = liveView(h, new Map([['HTNK', model]]));
    const object = vehicle(1, 'HTNK');
    const visual = view.visualFor(object, 0, 5);
    expect(visual.mode).toBe('voxel');
    expect(visual.pending).toBeFalsy();
    expect(root.children).toEqual([visual.root]);
    expect((visual.root as VoxelRoot).partMeshes).toHaveLength(3);
    expect(h.voxels.isStandIn(visual)).toBe(true);
    expect(view.diagnostics()).toMatchObject({ standInVoxels: 1, pendingArt: 0, placeholders: 0 });
    // The final look is still on its way: a host that waits for complete frames keeps waiting.
    expect(view.loadingArt()).toBe(1);
    expect(view.visualFor(object, 0, 6)).toBe(visual);
    await h.finishMeshes();
    // Same visual, same scene object: nothing is rebuilt, so nothing can jump.
    expect(view.visualFor(object, 0, 7)).toBe(visual);
    expect(root.children).toEqual([visual.root]);
    expect(h.voxels.isStandIn(visual)).toBe(false);
    expect(view.diagnostics().standInVoxels).toBe(0);
    expect(view.loadingArt()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    h.dispose();
  });

  it('keeps the current image while the alternate image is not final, then swaps once to the final look', async () => {
    const h = harness();
    const models = new Map([
      ['HARV', tank('HARV')],
      ['HORV', tank('HORV')],
    ]);
    const { view, root } = liveView(h, models);
    const miner = vehicle(1, 'HARV');
    const travelling = view.visualFor(miner, 0, 10);
    expect(travelling).toMatchObject({ type: 'HARV', mode: 'voxel' });
    await h.finishMeshes();
    expect(h.voxels.isStandIn(travelling)).toBe(false);
    // The engine selects the unloading image, whose mesh has never been asked for.
    miner.imageType = 'HORV';
    expect(view.visualFor(miner, 0, 11)).toBe(travelling);
    expect(root.children).toEqual([travelling.root]);
    expect(h.voxels.loading).toBe(1);
    expect(hasSmoothVoxelGeometry(models.get('HORV')!, OPTIONS)).toBe(false);
    // No stand-in is made for an image nobody draws yet.
    expect(h.voxels.standInUnits).toBe(0);
    expect(h.voxels.built(`HORV@${PALETTE}`)).toBe(false);
    expect(view.visualFor(miner, 0, 12)).toBe(travelling);
    await h.finishMeshes();
    const unloading = view.visualFor(miner, 0, 13);
    expect(unloading).not.toBe(travelling);
    expect(unloading).toMatchObject({ type: 'HORV', mode: 'voxel' });
    expect(h.voxels.isStandIn(unloading)).toBe(false);
    expect(root.children).toEqual([unloading.root]);
    h.dispose();
  });

  it('draws an object first seen with an alternate image that is not final as its usual image, not as nothing', () => {
    const h = harness();
    const { view } = liveView(
      h,
      new Map([
        ['HARV', tank('HARV')],
        ['HORV', tank('HORV')],
      ]),
    );
    const first = view.visualFor(vehicle(1, 'HARV', { imageType: 'HORV' }), 0, 10);
    expect(first).toMatchObject({ type: 'HARV', mode: 'voxel' });
    expect(h.voxels.isStandIn(first)).toBe(true);
    h.dispose();
  });

  it('waits for the mesh out of sight (nothing built twice) and draws at once when the view is shown', () => {
    const h = harness();
    const model = tank('HTNK');
    const { view, root } = liveView(h, new Map([['HTNK', model]]));
    view.outOfSight = true;
    const object = vehicle(1, 'HTNK');
    const waiting = view.visualFor(object, 0, 1);
    expect(waiting).toMatchObject({ mode: 'placeholder', pending: true });
    // Asking started the build; no stand-in was made for a picture nobody sees.
    expect(h.voxels.loading).toBe(1);
    expect(h.voxels.standInUnits).toBe(0);
    expect(h.voxels.built(`HTNK@${PALETTE}`)).toBe(false);
    expect(view.loadingArt()).toBeGreaterThan(0);
    // Later frames keep the same placeholder instead of making a new one each time.
    expect(view.visualFor(object, 0, 2)).toBe(waiting);
    // The view is shown before the mesh is there (the host's deadline): the next frame draws the unit.
    view.objectsFor = 'drawn';
    view.outOfSight = false;
    expect(view.objectsFor).toBeNull();
    const shown = view.visualFor(object, 0, 2);
    expect(shown).not.toBe(waiting);
    expect(shown.mode).toBe('voxel');
    expect(h.voxels.isStandIn(shown)).toBe(true);
    expect(root.children).toEqual([shown.root]);
    // Setting the same value again asks for nothing.
    view.objectsFor = 'drawn';
    view.outOfSight = false;
    expect(view.objectsFor).toBe('drawn');
    h.dispose();
  });

  it('builds the final look out of sight once the mesh is there', async () => {
    const h = harness();
    const { view } = liveView(h, new Map([['HTNK', tank('HTNK')]]));
    view.outOfSight = true;
    const object = vehicle(1, 'HTNK');
    expect(view.visualFor(object, 0, 1).mode).toBe('placeholder');
    await h.finishMeshes();
    const built = view.visualFor(object, 0, 2);
    expect(built.mode).toBe('voxel');
    expect(h.voxels.isStandIn(built)).toBe(false);
    h.dispose();
  });
});

describe('building turrets and voxel shells while their mesh is built', () => {
  /** buildingTurret() up to the point where the turret unit exists (posing is covered by liveBuildingTurret.test). */
  function turretView(h: ReturnType<typeof harness>, model: VoxelModel, outOfSight: boolean) {
    const state = {
      newArtPerFrame: Infinity,
      newArt: 0,
      waitingArt: 0,
      cache: h.cache,
      voxelUnits: h.voxels,
      library: { voxel: () => model, voxelFailed: () => false },
      libraryPaletteKeys: new Map<string, string>(),
    };
    const view = Object.assign(Object.create(LiveView.prototype), state) as unknown as {
      outOfSight: boolean;
      buildingTurret(object: LiveObject, visual: unknown, facing: number | null): void;
    };
    view.outOfSight = outOfSight;
    const visual = {
      root: new Group(),
      paletteKey: 'house0',
      turretState: undefined as string | undefined,
      buildingTurret: undefined as VoxelUnit | undefined,
      libraryType: {
        remap: true,
        drawOffset: [0, 0],
        building: { turretVoxel: { voxel: 'NAFLAK:turret', offset: [0, 0] } },
      },
    };
    const object = { ...vehicle(7, 'NAFLAK'), kind: 'building' } as LiveObject;
    return { view, visual, object };
  }

  it('draws a shown turret from its stand-in (facing null: only the unit is made, as while the building is sold)', async () => {
    const h = harness();
    const model = tank('NAFLAK:turret');
    const { view, visual, object } = turretView(h, model, false);
    view.buildingTurret(object, visual, null);
    expect(visual.turretState).toBe('ready');
    expect(visual.buildingTurret).toBeDefined();
    expect(visual.root.children).toEqual([visual.buildingTurret!.root]);
    expect(h.voxels.isStandIn(visual.buildingTurret!)).toBe(true);
    const unit = visual.buildingTurret!;
    await h.finishMeshes();
    view.buildingTurret(object, visual, null);
    expect(visual.buildingTurret).toBe(unit);
    expect(h.voxels.isStandIn(unit)).toBe(false);
    h.dispose();
  });

  it('counts a turret out of sight as loading until its mesh is there', async () => {
    const h = harness();
    const model = tank('NAFLAK:turret');
    const { view, visual, object } = turretView(h, model, true);
    view.buildingTurret(object, visual, null);
    expect(visual.turretState).toBe('loading');
    expect(visual.buildingTurret).toBeUndefined();
    expect(h.voxels.standInUnits).toBe(0);
    await h.finishMeshes();
    view.buildingTurret(object, visual, null);
    expect(visual.turretState).toBe('ready');
    expect(h.voxels.isStandIn(visual.buildingTurret!)).toBe(false);
    h.dispose();
  });

  it('draws a voxel shell in flight at once, where it is', async () => {
    const h = harness();
    const model = tank('V3ROCKET');
    const art = {
      bullet: () => ({ art: { voxel: 'V3ROCKET' } }),
      voxel: () => model,
    } as unknown as EffectArt;
    const parent = new Group();
    const projectiles = new Projectiles(art, h.voxels, parent, () => PALETTE);
    const shell: LiveBullet = {
      id: 1,
      uid: 1,
      type: 'V3ROCKET',
      x: 512,
      y: 768,
      z: 208,
      velocity: { x: 256, y: 0, z: 0 },
    };
    projectiles.update([shell], [], () => false, []);
    const [entry] = [...projectiles.painterEntries()];
    expect(entry).toBeDefined();
    expect(parent.children).toEqual([entry!.root]);
    expect(entry!.root.position.toArray()).toEqual([2, expect.any(Number), 3]);
    expect((entry!.root as VoxelRoot).partMeshes).toHaveLength(3);
    expect(h.voxels.standInUnits).toBe(1);
    const root = entry!.root;
    await h.finishMeshes();
    projectiles.update([{ ...shell, x: 768 }], [], () => false, []);
    const [later] = [...projectiles.painterEntries()];
    expect(later!.root).toBe(root);
    expect(root.position.x).toBe(3);
    expect(h.voxels.standInUnits).toBe(0);
    h.dispose();
  });
});
