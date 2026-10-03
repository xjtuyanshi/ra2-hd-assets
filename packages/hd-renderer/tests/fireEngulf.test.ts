import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Group, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { TerrainDepth } from '../src/terrainDepth';
import {
  NOT_CAPTURED_CODE,
  ALWAYS_COVER_CODE,
  objectDepthCombine,
  reduceObjectDepth,
  encodeAnchorCode,
} from '../src/objectDepth';
import {
  FRONT_DISTANCE,
  FIRE_FOOTPRINT_MARGIN,
  isNearEngulfFire,
  engulfAnchor,
  type EngulfFire,
  type EngulfObject,
} from '../src/ra2/fireEngulf';
import { effectDisplayBounds, effectSphereRadius } from '../src/live/effectSprites';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { painterObject } from '../src/ra2/painterOrder';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { BuildingVisualHistory } from '../src/live/buildingVisualHistory';
import { VoxelUnits } from '../src/live/voxelUnits';
import { instantiateVoxel, VoxelUnit } from '../src/ra2/voxels';
import { createVoxelMaterial } from '../src/ra2/voxels';
import type { Ra2Cache } from '../src/ra2/cache';
import { AtmosphereNodes } from '../src/atmosphere';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { CARD_CLEARANCE, cardDepthPush } from '../src/ra2/cardDepth';
import { PIXELS_PER_CELL_EDGE, LEVEL_HEIGHT } from '../src/world';
import { anchor, blast, crops, displayed, fireDepth, horizontal, right, toCamera, up } from './fixtures/fireball';

const near = 0.1;
const far = 400;
const normalized = (nearness: number) => (150 - near - nearness) / (far - near);
function fire(card = blast()): EngulfFire {
  const bounds = { x: 0, y: 0, width: 0, height: 0 };
  effectDisplayBounds(card, bounds);
  return {
    ...card.anchor,
    screenX: card.anchor.dot(right) + bounds.x + bounds.width / 2,
    screenY: card.anchor.dot(up) - bounds.y - bounds.height / 2,
    radius: Math.hypot(bounds.width, bounds.height) / 2 + FIRE_FOOTPRINT_MARGIN,
  };
}
const code = (point: { x: number; z: number }) =>
  (point.x - anchor.x) * horizontal.x + (point.z - anchor.z) * horizontal.z;
const isNear = (point: Vector3, fires = [fire()], radius = 1) =>
  isNearEngulfFire(point, radius, fires, fires.length, right, up);
const combine = (base: number, surface: number, objectCode: number, fireCode = 0) => {
  const [r, g] = encodeAnchorCode(objectCode, 1);
  return objectDepthCombine(
    base,
    reduceObjectDepth([{ depth: surface, r, g }], near, far, 150),
    fireCode,
    FRONT_DISTANCE,
    near,
    far,
    150,
  );
};

describe('whole-object RA2 anchor membership', () => {
  it('uses generous screen-plane overlap, independently of the per-fire direction decision', () => {
    expect(isNear(anchor.clone().addScaledVector(right, 30))).toBe(false);
    const other = blast();
    other.anchor.addScaledVector(horizontal, 1.5);
    const object = anchor.clone().addScaledVector(horizontal, 2);
    for (const fires of [
      [fire(), fire(other)],
      [fire(other), fire()],
    ])
      expect(isNear(object, fires)).toBe(true);
  });
  it('uses the foundation centre for every building component', () => {
    const point = { x: 0, y: 0, z: 0 };
    engulfAnchor(anchor, [3, 3], anchor.x, anchor.z, point);
    expect(point).toEqual({ x: anchor.x + 1.5, y: anchor.y, z: anchor.z + 1.5 });
    expect(code(point)).toBeGreaterThan(FRONT_DISTANCE);
    engulfAnchor(anchor, undefined, 100, 100, point);
    expect(point).toEqual({ x: anchor.x, y: anchor.y, z: anchor.z });
  });
  it('uses uncapped HD union dimensions and merge size, holding different-page successors', () => {
    const card = blast();
    card.hd!.size = 4;
    card.hd!.next = { ...card.hd!.frame, rect: [0, 0, 240, 280], offset: [-70, -90] };
    const bounds = { x: 0, y: 0, width: 0, height: 0 };
    effectDisplayBounds(card, bounds);
    expect(bounds.width).toBeCloseTo((4 * 120) / PIXELS_PER_CELL_EDGE);
    expect(bounds.height).toBeCloseTo((4 * 140) / PIXELS_PER_CELL_EDGE);
    expect(fire(card).radius).toBeGreaterThan(effectSphereRadius(card) * 4);
    const distant = anchor.clone().addScaledVector(right, 5);
    expect(isNear(distant, [fire(card)], 0.4)).toBe(true);
    expect(isNear(distant, [fire()], 0.4)).toBe(false);
    card.hd!.next = { ...card.hd!.next!, page: 99 };
    effectDisplayBounds(card, bounds);
    expect(bounds.width).toBeCloseTo((4 * crops[0]!.width) / PIXELS_PER_CELL_EDGE);
  });
});

/** Exposed faces of a one-cell-long vehicle: hull, taller turret, forward narrow barrel, with finite height/volume. */
function vehicleSamples(): Vector3[] {
  const samples: Vector3[] = [];
  for (const [length, width, y0, y1, centre] of [
    [1, 0.55, 0.06, 0.34, 0],
    [0.4, 0.4, 0.34, 0.68, 0],
    [0.55, 0.1, 0.5, 0.6, 0.4],
  ]) {
    for (let i = 0; i <= 10; i++)
      for (let j = 0; j <= 10; j++)
        for (let face = 0; face < 6; face++) {
          const u = i / 10;
          const v = j / 10;
          const along = (face < 2 ? face : u) * length! - length! / 2 + centre!;
          const across = (face >= 2 && face < 4 ? face - 2 : face < 2 ? u : v) * width! - width! / 2;
          const y = y0! + (y1! - y0!) * (face >= 4 ? face - 4 : v);
          samples.push(new Vector3().addScaledVector(horizontal, along).addScaledVector(right, across).setY(y));
        }
  }
  return samples;
}

describe('whole-object combination across a synthetic 3D hull/turret/barrel', () => {
  it('proves old sphere slicing and makes one decision across every hull/turret/barrel sample', () => {
    const card = blast();
    const bounds = displayed(card);
    let mixedPlacements = 0;
    for (const distance of [0, 0.5, 1, 1.4, 1.5, 2]) {
      const at = anchor.clone().addScaledVector(horizontal, distance);
      expect(isNear(at)).toBe(true);
      let basePass = 0;
      let baseFail = 0;
      let coveredSamples = 0;
      for (const local of vehicleSamples()) {
        const sample = at.clone().add(local);
        const relative = sample.clone().sub(anchor);
        const sx = relative.dot(right);
        const sy = relative.dot(up);
        if (sx < bounds.lo.x || sx > bounds.lo.x + bounds.width || sy > bounds.lo.y || sy < bounds.lo.y - bounds.height)
          continue;
        coveredSamples++;
        const object = normalized(sample.dot(toCamera) + CARD_CLEARANCE);
        const base = normalized(fireDepth(card, sx, sy));
        if (base < object) basePass++;
        else baseFail++;
        const combined = combine(base, object, code(at));
        expect(combined < object, `d=${distance} surface=${local.toArray()}`).toBe(distance < FRONT_DISTANCE);
      }
      // At 2 cells only the lower card rim overlaps the vehicle; still require a nontrivial surface grid.
      expect(coveredSamples).toBeGreaterThan(100);
      if (distance < FRONT_DISTANCE && basePass && baseFail) mixedPlacements++;
    }
    expect(mixedPlacements, 'the old sphere must actually slice at least one COVER volume').toBeGreaterThan(0);
  });
  it('keeps every pixel of the SHP terror drone 1.5 cells south in front, even at the card corners', () => {
    const card = blast();
    const at = anchor.clone().addScaledVector(horizontal, FRONT_DISTANCE);
    expect(code(at)).toBeCloseTo(FRONT_DISTANCE);
    let samples = 0;
    for (let x = -12; x <= 12; x++)
      for (let y = -20; y <= 4; y++) {
        const pixel = at
          .clone()
          .addScaledVector(right, x / PIXELS_PER_CELL_EDGE)
          .addScaledVector(up, -y / PIXELS_PER_CELL_EDGE);
        const offset = pixel.clone().sub(anchor);
        const object = normalized(at.dot(toCamera) + cardDepthPush(x, y));
        const base = normalized(fireDepth(card, offset.dot(right), offset.dot(up)));
        expect(combine(base, object, code(at))).toBeGreaterThan(object);
        samples++;
      }
    expect(samples).toBe(625);
  });
  it('covers a tree in front of a FRONT unit and leaves empty pixels exactly unchanged', () => {
    expect(combine(0.8, 0.4, ALWAYS_COVER_CODE)).toBeLessThan(0.4);
    const empty = reduceObjectDepth([{ depth: 1, r: 0, g: 0 }], near, far, 150);
    expect(objectDepthCombine(0.999999, empty, 0, FRONT_DISTANCE, near, far, 150)).toBe(0.999999);
  });
  it('decides Rhino 5009 independently for EXPLOLRG and TWLT050 in the same frame', () => {
    const tank = new Vector3(63, 0, 63.6);
    const big = new Vector3(60.8, 0, 63.2);
    const small = new Vector3(64, 0, 63.8);
    expect(code(tank) - code(big)).toBeCloseTo(1.8384776);
    expect(code(tank) - code(small)).toBeCloseTo(-0.8485281);
    for (const local of vehicleSamples()) {
      const surface = normalized(tank.clone().add(local).dot(toCamera));
      expect(combine(0.2, surface, code(tank), code(big))).toBeGreaterThan(surface);
      expect(combine(0.8, surface, code(tank), code(small))).toBeLessThan(surface);
    }
  });
});

function source(): Ra2Cache {
  const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  return {
    nodes: new AtmosphereNodes(),
    spriteAtlas: texture,
    paletteAtlas: texture,
    paletteRow: new Map([['unit', 0]]),
    manifest: { spriteAtlas: { width: 256, height: 1 } },
    mapLight: new MapLightGrade(
      { width: 2, height: 2, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
      { ambient: 1, level: 0, ground: 0, red: 1, green: 1, blue: 1 },
    ),
  } as unknown as Ra2Cache;
}

it.each([false, true])('captures SHP pages and turrets with retained death frame: %s', (retained) => {
  const cache = source();
  const depth = new TerrainDepth(FRONT_DISTANCE);
  const sprites = new SpriteLayer(cache, [], 8, undefined, null, null, null, depth);
  const page = new SpriteLayer(cache, [], 8, undefined, null, null, null, depth);
  const dronePainter = { ...painterObject(2, 0), uid: 1 };
  const buildingPainter = { ...painterObject(2, 0), uid: 2, x: anchor.x, z: anchor.z, foundation: [1, 1] as const };
  const aircraftPainter = { ...painterObject(4, 0), uid: 3 };
  const make = (painter: typeof dronePainter, at: Vector3): SpriteInstance => ({
    anchor: at,
    frame: { rect: [0, 0, 24, 30], offset: [-12, -26] },
    palette: 'unit',
    push: 0,
    shadow: false,
    painter,
  });
  const drone = make(dronePainter, anchor.clone().addScaledVector(horizontal, 1.5));
  const building = make(buildingPainter, anchor.clone());
  const aircraft = make(aircraftPainter, anchor.clone().add(new Vector3(0, 3, 0)));
  const annex = { ...building, frame: { rect: [0, 0, 40, 140], offset: [100, -130] } } as SpriteInstance;
  annex.anchor = building.anchor.clone().add(new Vector3(0, 1, 0));
  sprites.setInstances([drone, building, aircraft]);
  page.setInstances([annex]);
  const turret = { root: new VoxelUnit() };
  const visuals = new Map([
    [1, { root: new Group(), mode: 'library-sprite', painter: dronePainter }],
    [2, { root: new Group(), mode: 'library-sprite', painter: buildingPainter, buildingTurret: turret }],
    [3, { root: new Group(), mode: 'library-sprite', painter: aircraftPainter }],
  ]) as Map<number, { root: Group; mode: string; painter: typeof dronePainter; engulf?: EngulfObject }>;
  const setCode = vi.fn();
  const view = {
    hd: {
      terrainDepth: depth,
      effects: { appendExplosionFootprints: (_fires: unknown, count: number) => count },
      view: {
        camera: {
          matrixWorld: {
            elements: [
              right.x,
              right.y,
              right.z,
              0,
              up.x,
              up.y,
              up.z,
              0,
              toCamera.x,
              toCamera.y,
              toCamera.z,
              0,
              0,
              0,
              0,
              1,
            ],
          },
        },
      },
    },
    engulfRight: new Vector3(),
    engulfUp: new Vector3(),
    engulfActive: false,
    engulfFires: [] as EngulfFire[],
    engulfBounds: { x: 0, y: 0, width: 0, height: 0 },
    effectInstances: [blast()],
    buildingVisualHistory: new BuildingVisualHistory(),
    visuals,
    spriteBatch: new Map<string, SpriteInstance[]>([
      ['map', [drone, building, aircraft]],
      ['page', [annex]],
    ]),
    current: {
      byUid: new Map([
        [1, { kind: 'vehicle' }],
        [2, { kind: 'building', z: (anchor.y / LEVEL_HEIGHT) * 104 }],
        [3, { kind: 'aircraft' }],
      ]),
    },
    world: { terrain: { heightAt: () => 0 } },
    voxelUnits: { setCaptureCode: setCode, captureRadius: () => 0.6 },
    sprites,
    pageLayers: new Map([[0, { layer: page }]]),
    spriteCaptureCode: (instance: SpriteInstance) =>
      visuals.get(instance.painter?.uid ?? -1)?.engulf?.code ?? NOT_CAPTURED_CODE,
  };
  const update = (LiveView.prototype as unknown as { updateFireEngulf(this: typeof view): void }).updateFireEngulf;
  try {
    if (retained) {
      const last: LiveObject = {
        id: 100,
        uid: 2,
        kind: 'building',
        type: 'TEST',
        owner: 0,
        health: 0,
        isSelected: false,
        x: anchor.x * 256,
        y: anchor.z * 256,
        z: (anchor.y / LEVEL_HEIGHT) * 104,
        facingRaw: 0,
      };
      view.buildingVisualHistory.update({ frame: 10, objects: [last], houses: [], view: null });
      view.buildingVisualHistory.update({ frame: 11, objects: [], houses: [], view: null });
      view.current.byUid.delete(2);
    }
    depth.reference.value.copy(anchor);
    depth.horizontal.value.set(horizontal.x, horizontal.z);
    update.call(view);
    expect(visuals.get(1)!.engulf!.code).toBeCloseTo(1.5);
    expect(visuals.get(2)!.engulf!.code).toBeCloseTo(Math.SQRT1_2);
    expect(visuals.get(3)!.engulf!.code).toBe(NOT_CAPTURED_CODE);
    expect(setCode).toHaveBeenLastCalledWith(turret, expect.closeTo(Math.SQRT1_2));
    expect(visuals.get(2)!.engulf!.radius).toBeGreaterThan(3);
    expect(visuals.get(2)!.engulf!.y).toBeCloseTo(anchor.y);
    const flags = (layer: SpriteLayer) =>
      (layer as unknown as { flags: { getComponent(i: number, j: number): number } }).flags;
    const codeOf = (layer: SpriteLayer, instance: SpriteInstance) => {
      const records = (layer as unknown as { uploaded: SpriteInstance[] }).uploaded;
      return flags(layer).getComponent(records.indexOf(instance), 8);
    };
    expect(codeOf(sprites, drone)).toBeCloseTo(code(drone.anchor));
    expect(codeOf(sprites, building)).toBeCloseTo(Math.SQRT1_2);
    expect(codeOf(page, annex)).toBeCloseTo(Math.SQRT1_2);
    expect(codeOf(sprites, aircraft)).toBe(NOT_CAPTURED_CODE);
    const fireStorage = view.engulfFires[0];
    const objectStorage = visuals.get(1)!.engulf;
    update.call(view);
    expect(view.engulfFires[0]).toBe(fireStorage);
    expect(visuals.get(1)!.engulf).toBe(objectStorage);
    drone.anchor.copy(anchor).addScaledVector(horizontal, 0.5);
    update.call(view);
    expect(codeOf(sprites, drone)).toBeCloseTo(0.5);
    drone.anchor.copy(anchor).addScaledVector(horizontal, 2);
    update.call(view);
    expect(codeOf(sprites, drone)).toBeCloseTo(code(drone.anchor));
    if (retained) {
      // Once the compensating frame expires, stale cards/turrets cannot keep an object-capture code.
      view.buildingVisualHistory.update({ frame: 12, objects: [], houses: [], view: null });
      update.call(view);
      expect(codeOf(sprites, building)).toBe(NOT_CAPTURED_CODE);
      expect(codeOf(page, annex)).toBe(NOT_CAPTURED_CODE);
      expect(setCode).toHaveBeenLastCalledWith(turret, NOT_CAPTURED_CODE);
      expect(codeOf(sprites, drone)).toBeCloseTo(code(drone.anchor));
    }
    view.effectInstances.length = 0;
    update.call(view);
    expect(codeOf(sprites, drone)).toBe(NOT_CAPTURED_CODE);
    expect(setCode).toHaveBeenLastCalledWith(turret, NOT_CAPTURED_CODE);
  } finally {
    for (const layer of [sprites, page]) {
      layer.mesh.geometry.dispose();
      (layer.mesh.material as MeshBasicNodeMaterial).dispose();
      layer.mesh.dispose();
    }
    depth.dispose();
    cache.nodes!.dispose();
    cache.spriteAtlas.dispose();
  }
});

it('toggles capture layers on voxel body/turret/barrel originals only and restores on removal', () => {
  const depth = new TerrainDepth(FRONT_DISTANCE);
  const nodes = new AtmosphereNodes();
  const geometry = new BoxGeometry(1, 0.7, 0.5);
  const material = createVoxelMaterial(nodes);
  const unit = instantiateVoxel(
    (['body', 'turret', 'barrel'] as const).map((role) => ({ role, geometry, turretOffset: 0.2 })),
    material,
    nodes,
  );
  const driver = {
    hd: { terrainDepth: depth },
    pending: new Map(),
    setCaptureCode: VoxelUnits.prototype.setCaptureCode,
  };
  const setCode = VoxelUnits.prototype.setCaptureCode;
  const twins: Mesh[] = [];
  unit.root.traverse((mesh) => {
    if (mesh instanceof Mesh && !unit.root.partMeshes.includes(mesh)) twins.push(mesh);
  });
  expect(twins.length).toBeGreaterThan(3);
  const masks = twins.map((mesh) => mesh.layers.mask);
  try {
    expect(unit.root.partMeshes).toHaveLength(3);
    unit.root.partMeshes[0]!.layers.enable(12);
    const originals = unit.root.partMeshes.map((mesh) => mesh.layers.mask);
    for (const value of [0, 2, NOT_CAPTURED_CODE]) {
      setCode.call(driver as unknown as VoxelUnits, unit, value);
      unit.root.partMeshes.forEach((mesh, i) => {
        expect(mesh.layers.isEnabled(31)).toBe(value !== NOT_CAPTURED_CODE);
        if (value === NOT_CAPTURED_CODE) expect(mesh.layers.mask).toBe(originals[i]);
      });
      expect(twins.map((mesh) => mesh.layers.mask)).toEqual(masks);
    }
    setCode.call(driver as unknown as VoxelUnits, unit, 2);
    VoxelUnits.prototype.dispose.call(driver as unknown as VoxelUnits, unit);
    expect(unit.root.partMeshes.map((mesh) => mesh.layers.mask)).toEqual(originals);
    expect(unit.root.captureRadius).toBeGreaterThan(0.8);
  } finally {
    depth.dispose();
    geometry.dispose();
    nodes.dispose();
  }
});
