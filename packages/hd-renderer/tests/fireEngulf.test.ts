import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Group, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { DepthClass, TerrainDepth, objectDepthCombine } from '../src/terrainDepth';
import {
  FRONT_DISTANCE,
  FIRE_FOOTPRINT_MARGIN,
  classifyEngulf,
  engulfAnchor,
  type EngulfFire,
  type EngulfObject,
} from '../src/ra2/fireEngulf';
import { effectDisplayBounds, effectSphereRadius } from '../src/live/effectSprites';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { painterObject } from '../src/ra2/painterOrder';
import { LiveView } from '../src/live/liveView';
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
const classify = (point: Vector3, fires = [fire()], radius = 1) =>
  classifyEngulf(point, radius, fires, fires.length, right, up, toCamera);

describe('whole-object RA2 anchor classification', () => {
  it.each([0, 0.5, 1, 1.4, -0.5, -1, -1.4, -1.5, -2])('COVER at %s horizontal cells', (distance) => {
    expect(classify(anchor.clone().addScaledVector(horizontal, distance))).toBe(DepthClass.COVER);
  });
  it.each([1.5, 2])('FRONT at %s horizontal cells, including the exact boundary', (distance) => {
    expect(classify(anchor.clone().addScaledVector(horizontal, distance))).toBe(DepthClass.FRONT);
  });
  it('uses screen-plane overlap and COVER wins with multiple near fires in either order', () => {
    expect(classify(anchor.clone().addScaledVector(right, 30))).toBe(DepthClass.NONE);
    const frontFire = fire();
    const coverCard = blast();
    coverCard.anchor.addScaledVector(horizontal, 1.5);
    const coverFire = fire(coverCard);
    const object = anchor.clone().addScaledVector(horizontal, 2);
    for (const fires of [
      [frontFire, coverFire],
      [coverFire, frontFire],
    ])
      expect(classify(object, fires)).toBe(DepthClass.COVER);
  });
  it('buildings classify by foundation centre even when the NW draw corner is COVER', () => {
    const point = { x: 0, y: 0, z: 0 };
    engulfAnchor(anchor, [3, 3], anchor.x, anchor.z, point);
    expect(point).toEqual({ x: anchor.x + 1.5, y: anchor.y, z: anchor.z + 1.5 });
    expect(classify(anchor)).toBe(DepthClass.COVER);
    expect(classifyEngulf(point, 3, [fire()], 1, right, up, toCamera)).toBe(DepthClass.FRONT);
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
    expect(classify(distant, [fire(card)], 0.4)).toBe(DepthClass.COVER);
    expect(classify(distant, [fire()], 0.4)).toBe(DepthClass.NONE);
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
  it('proves old sphere slicing and engulfs every COVER sample, rejecting every FRONT sample', () => {
    const card = blast();
    const bounds = displayed(card);
    let mixedPlacements = 0;
    for (const distance of [0, 0.5, 1, 1.5, 2]) {
      const at = anchor.clone().addScaledVector(horizontal, distance);
      const classification = classify(at);
      expect(classification).toBe(distance < FRONT_DISTANCE ? DepthClass.COVER : DepthClass.FRONT);
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
        const cover = classification === DepthClass.COVER ? object : 1;
        const front = classification === DepthClass.FRONT ? object : 1;
        const combined = objectDepthCombine(base, cover, front, near, far);
        expect(combined < object, `d=${distance} surface=${local.toArray()}`).toBe(classification === DepthClass.COVER);
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
    expect(classify(at)).toBe(DepthClass.FRONT);
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
        expect(objectDepthCombine(base, 1, object, near, far)).toBeGreaterThan(object);
        samples++;
      }
    expect(samples).toBe(625);
  });
  it('uses the nearer class, FRONT on a tie, and unchanged fallback on empty ground', () => {
    expect(objectDepthCombine(0.4, 0.6, 0.5, near, far)).toBeGreaterThan(0.5);
    expect(objectDepthCombine(0.8, 0.4, 0.5, near, far)).toBeLessThan(0.4);
    expect(objectDepthCombine(0.1, 0.5, 0.5, near, far)).toBeGreaterThan(0.5);
    expect(objectDepthCombine(0.999999, 1, 1, near, far)).toBe(0.999999);
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

it('classifies live SHP owners across pages, shares building turret class, and clears stale classes when fire ends', () => {
  const cache = source();
  const depth = new TerrainDepth();
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
  const setClass = vi.fn();
  const view = {
    hd: {
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
    engulfToCamera: new Vector3(),
    engulfActive: false,
    engulfFires: [] as EngulfFire[],
    engulfBounds: { x: 0, y: 0, width: 0, height: 0 },
    effectInstances: [blast()],
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
    voxelUnits: { setCaptureClass: setClass, captureRadius: () => 0.6 },
    sprites,
    pageLayers: new Map([[0, { layer: page }]]),
    spriteCaptureClass: (instance: SpriteInstance) =>
      visuals.get(instance.painter?.uid ?? -1)?.engulf?.classification ?? DepthClass.NONE,
  };
  const update = (LiveView.prototype as unknown as { updateFireEngulf(this: typeof view): void }).updateFireEngulf;
  try {
    update.call(view);
    expect(visuals.get(1)!.engulf!.classification).toBe(DepthClass.FRONT);
    expect(visuals.get(2)!.engulf!.classification).toBe(DepthClass.COVER);
    expect(visuals.get(3)!.engulf!.classification).toBe(DepthClass.NONE);
    expect(setClass).toHaveBeenLastCalledWith(turret, DepthClass.COVER);
    expect(visuals.get(2)!.engulf!.radius).toBeGreaterThan(3);
    expect(visuals.get(2)!.engulf!.y).toBeCloseTo(anchor.y);
    const flags = (layer: SpriteLayer) =>
      (layer as unknown as { flags: { getComponent(i: number, j: number): number } }).flags;
    const classificationOf = (layer: SpriteLayer, instance: SpriteInstance) => {
      const records = (layer as unknown as { uploaded: SpriteInstance[] }).uploaded;
      return flags(layer).getComponent(records.indexOf(instance), 8);
    };
    expect(classificationOf(sprites, drone)).toBe(DepthClass.FRONT);
    expect(classificationOf(sprites, building)).toBe(DepthClass.COVER);
    expect(classificationOf(page, annex)).toBe(DepthClass.COVER);
    expect(classificationOf(sprites, aircraft)).toBe(DepthClass.NONE);
    const fireStorage = view.engulfFires[0];
    const objectStorage = visuals.get(1)!.engulf;
    update.call(view);
    expect(view.engulfFires[0]).toBe(fireStorage);
    expect(visuals.get(1)!.engulf).toBe(objectStorage);
    drone.anchor.copy(anchor).addScaledVector(horizontal, 0.5);
    update.call(view);
    expect(classificationOf(sprites, drone)).toBe(DepthClass.COVER);
    drone.anchor.copy(anchor).addScaledVector(horizontal, 2);
    update.call(view);
    expect(classificationOf(sprites, drone)).toBe(DepthClass.FRONT);
    view.effectInstances.length = 0;
    update.call(view);
    expect(classificationOf(sprites, drone)).toBe(DepthClass.NONE);
    expect(setClass).toHaveBeenLastCalledWith(turret, DepthClass.NONE);
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
  const depth = new TerrainDepth();
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
    setCaptureClass: VoxelUnits.prototype.setCaptureClass,
  };
  const setClass = VoxelUnits.prototype.setCaptureClass;
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
    for (const classification of [DepthClass.COVER, DepthClass.FRONT, DepthClass.NONE]) {
      setClass.call(driver as unknown as VoxelUnits, unit, classification);
      unit.root.partMeshes.forEach((mesh, i) => {
        expect(mesh.layers.isEnabled(31)).toBe(classification === DepthClass.COVER);
        expect(mesh.layers.isEnabled(30)).toBe(classification === DepthClass.FRONT);
        if (classification === DepthClass.NONE) expect(mesh.layers.mask).toBe(originals[i]);
      });
      expect(twins.map((mesh) => mesh.layers.mask)).toEqual(masks);
    }
    setClass.call(driver as unknown as VoxelUnits, unit, DepthClass.FRONT);
    VoxelUnits.prototype.dispose.call(driver as unknown as VoxelUnits, unit);
    expect(unit.root.partMeshes.map((mesh) => mesh.layers.mask)).toEqual(originals);
    expect(unit.root.captureRadius).toBeGreaterThan(0.8);
  } finally {
    depth.dispose();
    geometry.dispose();
    nodes.dispose();
  }
});
