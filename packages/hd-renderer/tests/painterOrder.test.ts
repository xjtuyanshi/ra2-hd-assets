import { describe, expect, it, vi } from 'vitest';
import { Texture, Vector3, type MeshBasicNodeMaterial } from 'three/webgpu';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { SpritePool } from '../src/live/spritePool';
import { LiveView } from '../src/live/liveView';
import { createPainterDepth, meshPainterDepth, VOXEL_PAINTER_SPAN } from '../src/painterDepth';
import type { Ra2Cache } from '../src/ra2/cache';
import {
  assignPainterDepth,
  comparePainterOrder,
  objectYSort,
  painterObject,
  spritePainterDepth,
} from '../src/ra2/painterOrder';
import { cardPush, SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';

describe('YR object painter order', () => {
  it('places the frozen SHK behind CAMIAM01 and the nearby CAMISC04 by their native keys', () => {
    // Numeric positions from the frozen snapshot; no original art is stored in this fixture.
    const shk = painterObject(2, objectYSort(13248, 20544));
    const camiam01 = painterObject(2, objectYSort(14208, 21888, true));
    const camisc04 = painterObject(2, objectYSort(13696, 20864, true));
    expect([shk.ySort, camisc04.ySort, camiam01.ySort]).toEqual([33792, 34304, 35840]);
    // CAMIAM01's 4x2 drawing centre adds 512 leptons to the key; it is not its sorting anchor.
    expect(objectYSort(14208 + 3 * 128, 21888 + 128, true)).toBe(36352);
    expect(comparePainterOrder(shk, camiam01)).toBeLessThan(0);
    const objects = [camiam01, shk, camisc04];
    assignPainterDepth(objects);
    expect(objects).toEqual([shk, camisc04, camiam01]);
    expect(shk.depth).toBeGreaterThan(camisc04.depth);
    expect(camisc04.depth).toBeGreaterThan(camiam01.depth);
  });

  it('sorts buildings at the northwest foundation corner independently of centre and front edge', () => {
    const raw = { x: 10.5 * 256, y: 20.5 * 256 };
    const buildingKey = objectYSort(raw.x, raw.y, true);
    expect(buildingKey).toBe(30 * 256);
    for (const [width, height] of [
      [1, 1],
      [2, 3],
      [4, 2],
      [4, 6],
    ]) {
      const centre = {
        x: raw.x + (width! - 1) * 128,
        y: raw.y + (height! - 1) * 128,
      };
      const front = { x: (10 + width!) * 256, y: (20 + height!) * 256 };
      const inside = objectYSort(raw.x + 1, raw.y + 1);
      expect(inside).toBeGreaterThan(buildingKey);
      expect(objectYSort(front.x, front.y)).toBeGreaterThan(buildingKey);
      if (width! + height! > 2) expect(objectYSort(centre.x, centre.y, true)).toBeGreaterThan(buildingKey);
      expect(objectYSort(raw.x, raw.y, true)).toBe(buildingKey);
    }
  });

  it.each([
    ['inside the foundation', 10.75, 20.75, 1],
    ['along its northwest X edge', 10, 20.25, 1],
    ['along its northwest Y edge', 10.25, 20, 1],
    ['along its southeast X edge', 13, 20.25, 1],
    ['along its southeast Y edge', 10.25, 24, 1],
    ['next to the north edge, beyond the sort line', 12, 19.5, 1],
    ['immediately behind the sort line', 10, 20 - 1 / 256, -1],
    ['on the sort line', 10, 20, 0],
    ['immediately in front of the sort line', 10, 20 + 1 / 256, 1],
  ])('handles a unit %s by X+Y rather than footprint containment', (_label, x, y, sign) => {
    const building = painterObject(2, objectYSort(10.5 * 256, 20.5 * 256, true));
    const unit = painterObject(2, objectYSort(x * 256, y * 256));
    expect(Math.sign(comparePainterOrder(unit, building))).toBe(sign);
  });

  it('uses building voxel turret and gate flags without treating their art as sorting geometry', () => {
    expect(objectYSort(5000, 6000, true)).toBe(10744);
    expect(objectYSort(5000, 6000, true, true)).toBe(10776);
    expect(objectYSort(5000, 6000, true, false, true)).toBe(10728);
    expect(objectYSort(5000, 6000, true, true, true)).toBe(10760);
    expect(objectYSort(5000, 6000, false, true, true)).toBe(11000);
  });

  it('ignores world altitude for the Ground key and orders airborne layers after every Ground object', () => {
    const elevated = { x: 13248, y: 20544, z: 1040 };
    const onGround = { ...elevated, z: 0 };
    expect(objectYSort(elevated.x, elevated.y)).toBe(objectYSort(onGround.x, onGround.y));
    const groundBuilding = painterObject(2, 100000, 500);
    const air = painterObject(3, -100000, 0);
    const top = painterObject(4, -1000000, 0);
    const below = painterObject(0, 200000, 0);
    const objects = [top, groundBuilding, air, below];
    assignPainterDepth(objects);
    expect(objects).toEqual([below, groundBuilding, air, top]);
  });

  it('restores physical depth for Underground and Surface without consuming upright slots', () => {
    const tunnel = painterObject(2, 100, 1);
    const surface = painterObject(2, 200, 2);
    assignPainterDepth([tunnel, surface]);
    expect(tunnel.depth).toBeGreaterThan(0);
    expect(surface.depth).toBeGreaterThan(0);
    tunnel.layer = 0;
    surface.layer = 1;
    const ground = painterObject(2, 300, 3);
    const air = painterObject(3, 0, 4);
    const objects = [air, surface, ground, tunnel];
    assignPainterDepth(objects);
    expect(objects).toEqual([tunnel, surface, ground, air]);
    for (const physical of [tunnel, surface]) {
      expect(physical).toMatchObject({ depth: -1, slotWidth: 0 });
      expect(spritePainterDepth(physical, 0.1)).toBe(-1);
      expect(meshPainterDepth(physical.depth, physical.slotWidth, 0.4, -Infinity)).toBe(-1);
    }
    const uprightOnly = [painterObject(2, ground.ySort, ground.index), painterObject(3, air.ySort, air.index)];
    assignPainterDepth(uprightOnly);
    expect(ground.depth).toBe(uprightOnly[0]!.depth);
    expect(ground.slotWidth).toBe(uprightOnly[0]!.slotWidth);
    expect(air.depth).toBe(uprightOnly[1]!.depth);
    expect(air.slotWidth).toBe(uprightOnly[1]!.slotWidth);
    assignPainterDepth([surface, tunnel]);
    expect(surface.depth).toBe(-1);
    expect(tunnel.depth).toBe(-1);
  });

  it('preserves native stable tie indices and uses registered indices within unsorted air buckets', () => {
    const first = painterObject(2, 12345, 3);
    const second = painterObject(2, 12345, 9);
    const airFirst = painterObject(4, 90000, 2);
    const airSecond = painterObject(4, 1, 5);
    const objects = [airSecond, second, airFirst, first];
    assignPainterDepth(objects);
    expect(objects).toEqual([first, second, airFirst, airSecond]);
    const fallbackFirst = painterObject(2, 10);
    const fallbackSecond = painterObject(2, 10);
    const older = [fallbackSecond, fallbackFirst];
    assignPainterDepth(older);
    expect(older).toEqual([fallbackSecond, fallbackFirst]);
  });

  it('preserves a partially sorted native Ground traversal while merging key-only static cards', () => {
    // The engine swaps adjacent inversions; a captured list need not already be globally sorted by key.
    const first = painterObject(2, 10000, 1);
    const second = painterObject(2, 100, 2);
    const third = painterObject(2, 12000, 3);
    const lower = painterObject(2, 0);
    const middle = painterObject(2, 5000);
    const upper = painterObject(2, 13000);
    expect(comparePainterOrder(first, second)).toBeLessThan(0);
    const objects = [upper, third, second, middle, lower, first];
    assignPainterDepth(objects);
    expect(objects).toEqual([lower, middle, first, second, third, upper]);
    expect(objects.filter((object) => object.index !== undefined)).toEqual([first, second, third]);
    expect(objects.filter((object) => object.index === undefined)).toEqual([lower, middle, upper]);
    expect(first.depth).toBeGreaterThan(second.depth);
    expect(second.depth).toBeGreaterThan(third.depth);
    assignPainterDepth(objects);
    expect(objects).toEqual([lower, middle, first, second, third, upper]);
  });

  it.each([false, true])(
    'draws equal-key ground effects after native bodies when the list is partially sorted=%s',
    (partial) => {
      const before = painterObject(2, partial ? 200 : 50, 0);
      const first = painterObject(2, 100, 1);
      const second = painterObject(2, 100, 2);
      const staticCard = painterObject(2, 100);
      const effect = painterObject(2, 100);
      effect.afterEqual = true;
      const objects = [effect, second, staticCard, before, first];
      assignPainterDepth(objects);
      expect(objects.filter((object) => object.index !== undefined)).toEqual([before, first, second]);
      expect(objects.indexOf(staticCard)).toBeLessThan(objects.indexOf(first));
      expect(objects.indexOf(effect)).toBeGreaterThan(objects.indexOf(second));
      expect(effect.depth).toBeLessThan(first.depth);
      expect(effect.depth).toBeLessThan(second.depth);
    },
  );

  it('compresses physical voxel depth monotonically within its reserved slot interval', () => {
    const physicalDepths = [-Infinity, -1e6, -100, -1, 0, 1, 100, 1e6, Infinity];
    const slot = 0.15;
    const width = 0.001;
    for (const part of [0, 0.1, 0.4]) {
      const centre = slot - part * width;
      const encoded = physicalDepths.map((physical) => meshPainterDepth(slot, width, part, physical));
      expect(encoded[0]).toBeCloseTo(centre - VOXEL_PAINTER_SPAN * width, 12);
      expect(encoded.at(-1)).toBeCloseTo(centre + VOXEL_PAINTER_SPAN * width, 12);
      expect(meshPainterDepth(slot, width, part, 0)).toBe(centre);
      for (let index = 0; index < encoded.length; index++) {
        const value = encoded[index]!;
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value - centre)).toBeLessThanOrEqual(VOXEL_PAINTER_SPAN * width + Number.EPSILON);
        if (index) expect(value).toBeGreaterThan(encoded[index - 1]!);
      }
    }
    expect(meshPainterDepth(-1, width, 0.4, Infinity)).toBe(-1);
    expect(meshPainterDepth(slot, 0, 0.4, Infinity)).toBe(slot);
  });

  it('keeps voxel bodies, turrets and sprite animations inside neighbouring object slots', () => {
    const objects = Array.from({ length: 1024 }, (_, index) => painterObject(2, index));
    assignPainterDepth(objects);
    for (let index = 0; index < objects.length - 1; index++) {
      const behind = objects[index]!;
      const front = objects[index + 1]!;
      expect(spritePainterDepth(behind, 0.1)).toBeLessThan(spritePainterDepth(behind));
      expect(spritePainterDepth(behind, 0.1)).toBeGreaterThan(spritePainterDepth(front));
      const nearestBehind = Math.min(
        spritePainterDepth(behind),
        spritePainterDepth(behind, 0.1),
        ...[0, 0.1, 0.4].map((part) => meshPainterDepth(behind.depth, behind.slotWidth, part, -Infinity)),
      );
      const farthestFront = Math.max(
        spritePainterDepth(front),
        spritePainterDepth(front, 0.1),
        ...[0, 0.1, 0.4].map((part) => meshPainterDepth(front.depth, front.slotWidth, part, Infinity)),
      );
      expect(nearestBehind).toBeGreaterThan(farthestFront);
      expect(Math.fround(nearestBehind)).toBeGreaterThan(Math.fround(farthestFront));
      // Even its physically farthest point, a building's separate voxel turret draws over its own body and anim.
      const farthestTurret = meshPainterDepth(behind.depth, behind.slotWidth, 0.4, Infinity);
      expect(farthestTurret).toBeLessThan(spritePainterDepth(behind));
      expect(farthestTurret).toBeLessThan(spritePainterDepth(behind, 0.1));
    }
    expect(spritePainterDepth(undefined)).toBe(-1);
    expect(spritePainterDepth(painterObject(2, 1))).toBe(-1);
    expect(() => assignPainterDepth([])).not.toThrow();
  });

  it('creates independent disabled mesh depth slots and origins', () => {
    const first = createPainterDepth();
    const second = createPainterDepth();
    expect(first).toMatchObject({ depth: -1, slotWidth: 0, part: 0 });
    first.origin.set(10, 20, 30);
    expect(second.origin.toArray()).toEqual([0, 0, 0]);
  });
});

type Buffers = { anchor: DirtyAttribute; params: DirtyAttribute; flags: DirtyAttribute };

describe('painter depth across sprite atlas layers', () => {
  it('runs LiveView scene-wide assignment across pages and voxel bodies, excluding decals and shadows', () => {
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['unit', 0]]),
      manifest: { spriteAtlas: { width: 32, height: 32 } },
      spriteAtlas: new Texture(),
    } as unknown as Ra2Cache;
    const behind = painterObject(2, 100, 1);
    const front = painterObject(2, 200, 2);
    const air = painterObject(4, 0, 0);
    const make = (painter: typeof behind, extra: Partial<SpriteInstance> = {}): SpriteInstance => ({
      anchor: new Vector3(1, 0, 1),
      frame: { rect: [0, 0, 8, 8], offset: [0, 0] },
      palette: 'unit',
      push: 0,
      shadow: false,
      painter,
      ...extra,
    });
    const a = [make(behind), make(front, { shadow: true }), make(front, { flat: true })];
    const b = [make(front), make(behind, { painterPart: 0.1 })];
    const layerA = new SpriteLayer(cache, a);
    const layerB = new SpriteLayer(cache, b);
    const voxel = { root: { visible: true }, painter: air, mode: 'voxel' };
    const state = {
      painterDirty: true,
      painterObjects: [],
      visuals: new Map([[1, voxel]]),
      world: {},
      cellInstances: [],
      cellLayer: { setInstances: vi.fn() },
      overlayInstances: { instances: { pages: new Map() } },
      overlayLayers: new Map(),
      spriteBatch: new Map([
        [0, a],
        [1, b],
      ]),
      effectInstances: [],
      voxelUnits: { setPainterDepth: vi.fn() },
      flushSprites: () => {
        layerA.setInstances(a);
        layerB.setInstances(b);
      },
    };
    const view = Object.assign(Object.create(LiveView.prototype), state) as typeof state & {
      applyPainterOrder(): void;
    };
    try {
      view.applyPainterOrder();
      expect(view.painterDirty).toBe(false);
      expect(view.painterObjects).toEqual([behind, front, air]);
      expect(behind.depth).toBeGreaterThan(front.depth);
      expect(front.depth).toBeGreaterThan(air.depth);
      expect(state.voxelUnits.setPainterDepth).toHaveBeenCalledWith(voxel, air.depth, air.slotWidth);
      const flagsA = (layerA as unknown as Buffers).flags;
      const flagsB = (layerB as unknown as Buffers).flags;
      expect(flagsA.array[3]).toBe(-1);
      expect(flagsA.array[7]).toBe(-1);
      expect(flagsA.array[11]).toBeCloseTo(behind.depth, 7);
      expect(flagsB.array[7]).toBeCloseTo(front.depth, 7);
      // Frozen-frame native reordering must reach each atlas buffer on the next assignment.
      behind.index = 3;
      view.applyPainterOrder();
      expect(view.painterObjects).toEqual([front, behind, air]);
      expect(flagsA.array[11]).toBeLessThan(flagsB.array[3]!);
    } finally {
      for (const layer of [layerA, layerB]) {
        layer.mesh.geometry.dispose();
        (layer.mesh.material as MeshBasicNodeMaterial).dispose();
      }
      cache.spriteAtlas.dispose();
    }
  });

  it('uploads a cell-centred lighting override independently of geometry and clears it on reuse', () => {
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['iso', 0]]),
      manifest: { spriteAtlas: { width: 32, height: 32 } },
      spriteAtlas: new Texture(),
    } as unknown as Ra2Cache;
    const instance: SpriteInstance = {
      anchor: new Vector3(10, 2, 20),
      frame: { rect: [0, 0, 8, 8], offset: [0, 0] },
      palette: 'iso',
      push: 0,
      flat: true,
      shadow: false,
      lighting: 'full',
      lightSample: [11.5, 21.5],
    };
    const layer = new SpriteLayer(cache, [instance]);
    try {
      const buffers = layer as unknown as Buffers;
      const position = Array.from(buffers.anchor.array).slice(0, 3);
      const sample = () => Array.from(buffers.anchor.array).slice(3, 5);
      const shared = buffers.anchor.interleaved();
      expect(sample()).toEqual([11.5, 21.5]);
      expect(shared.array).toBe(buffers.anchor.array);
      expect(shared.updateRanges).toBe(buffers.anchor.updateRanges);
      const version = shared.version;
      layer.setInstances([instance]);
      expect(shared.version).toBe(version);
      shared.clearUpdateRanges();
      layer.setInstances([{ ...instance, lightSample: [10.5, 20.5] }]);
      expect(sample()).toEqual([10.5, 20.5]);
      expect(shared.version).toBe(version + 1);
      expect(shared.updateRanges).toEqual([{ start: 3, count: 2 }]);
      layer.setInstances([{ ...instance, lightSample: undefined }]);
      expect(sample()).toEqual([10, 20]);
      expect(Array.from(buffers.anchor.array).slice(0, 3)).toEqual(position);
    } finally {
      layer.mesh.geometry.dispose();
      (layer.mesh.material as MeshBasicNodeMaterial).dispose();
      cache.spriteAtlas.dispose();
    }
  });

  it('clears reused sprite painter owners and component offsets before the next frame', () => {
    const pool = new SpritePool();
    const frame: SpriteFrame = { rect: [0, 0, 16, 24], offset: [-8, -18] };
    const owner = painterObject(2, 100);
    const nextOwner = painterObject(2, 200);
    const anchor = new Vector3(10, 1, 20);
    pool.begin();
    pool.painter = owner;
    const first = pool.take(anchor, frame, 'unit', cardPush(frame), false, false, 1, 'ambient', 0.4);
    expect(first.painter).toBe(owner);
    expect(first.painterPart).toBe(0.4);
    pool.begin();
    expect(pool.painter).toBeUndefined();
    const next = pool.take(anchor, frame, 'unit', cardPush(frame), false);
    expect(next).toBe(first);
    expect(next.painter).toBeUndefined();
    expect(next.painterPart).toBe(0);
    pool.begin();
    pool.painter = nextOwner;
    const reassigned = pool.take(anchor, frame, 'unit', cardPush(frame), false, false, 1, 'ambient', 0.1);
    expect(reassigned).toBe(first);
    expect(reassigned.painter).toBe(nextOwner);
    expect(reassigned.painterPart).toBe(0.1);
    for (const [flat, shadow] of [
      [true, false],
      [false, true],
    ]) {
      pool.begin();
      pool.painter = nextOwner;
      const ground = pool.take(anchor, frame, 'unit', 0, shadow!, flat!);
      expect(ground).toBe(first);
      expect(ground.painter).toBeUndefined();
      expect(ground.painterPart).toBe(0);
    }
  });

  it('encodes one shared object order across separate atlases while frame offsets and cardPush retain placement', () => {
    const atlasA = new Texture();
    const atlasB = new Texture();
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['unit', 0]]),
      manifest: { spriteAtlas: { width: 256, height: 256 } },
      spriteAtlas: atlasA,
    } as unknown as Ra2Cache;
    const shk = painterObject(2, objectYSort(13248, 20544));
    const building = painterObject(2, objectYSort(14208, 21888, true));
    assignPainterDepth([building, shk]);
    const troopFrame: SpriteFrame = { rect: [0, 0, 16, 120], offset: [-8, 0] };
    const buildingFrame: SpriteFrame = { rect: [0, 0, 80, 100], offset: [-40, -100] };
    const troop: SpriteInstance = {
      anchor: new Vector3(50, 1, 80),
      frame: troopFrame,
      palette: 'unit',
      push: cardPush(troopFrame),
      shadow: false,
      painter: shk,
    };
    const structure: SpriteInstance = {
      anchor: new Vector3(58, 1, 88),
      frame: buildingFrame,
      palette: 'unit',
      push: cardPush(buildingFrame),
      shadow: false,
      painter: building,
    };
    const unitLayer = new SpriteLayer(cache, [troop]);
    const buildingLayer = new SpriteLayer(cache, [structure], 1, { texture: atlasB, width: 256, height: 256 });
    try {
      const unitBuffers = unitLayer as unknown as Buffers;
      const buildingBuffers = buildingLayer as unknown as Buffers;
      expect(troop.push).toBeGreaterThan(structure.push);
      expect(unitBuffers.flags.array[3]).toBeGreaterThan(buildingBuffers.flags.array[3]!);
      expect(unitBuffers.flags.array[3]).toBeCloseTo(shk.depth, 7);
      expect(buildingBuffers.flags.array[3]).toBeCloseTo(building.depth, 7);
      for (const layer of [unitLayer, buildingLayer]) {
        const material = layer.mesh.material as MeshBasicNodeMaterial;
        expect(material.depthTest).toBe(true);
        expect(material.depthWrite).toBe(true);
        expect(material.depthNode).not.toBeNull();
      }
      const placement = [Array.from(unitBuffers.anchor.array), Array.from(unitBuffers.params.array)];
      shk.ySort = building.ySort + 1;
      assignPainterDepth([building, shk]);
      unitLayer.setInstances([troop]);
      buildingLayer.setInstances([structure]);
      expect(unitBuffers.flags.array[3]).toBeLessThan(buildingBuffers.flags.array[3]!);
      expect([Array.from(unitBuffers.anchor.array), Array.from(unitBuffers.params.array)]).toEqual(placement);
      unitLayer.setInstances([{ ...troop, painterPart: 0.1 }]);
      expect(unitBuffers.flags.array[3]).toBeCloseTo(spritePainterDepth(shk, 0.1), 7);
      expect(unitBuffers.flags.array[3]).toBeLessThan(shk.depth);
      expect([Array.from(unitBuffers.anchor.array), Array.from(unitBuffers.params.array)]).toEqual(placement);
      const shadow = { ...troop, shadow: true, painterPart: 0.1 };
      const flat = { ...troop, flat: true, painterPart: 0.1 };
      unitLayer.setInstances([shadow]);
      expect(unitBuffers.flags.array[0]).toBe(2);
      expect(unitBuffers.flags.array[3]).toBe(-1);
      unitLayer.setInstances([flat]);
      expect(unitBuffers.flags.array[0]).toBe(1);
      expect(unitBuffers.flags.array[3]).toBe(-1);
      unitLayer.setInstances([{ ...troop, painter: undefined }]);
      expect(unitBuffers.flags.array[3]).toBe(-1);
    } finally {
      for (const layer of [unitLayer, buildingLayer]) {
        layer.mesh.geometry.dispose();
        (layer.mesh.material as MeshBasicNodeMaterial).dispose();
      }
      atlasA.dispose();
      atlasB.dispose();
    }
  });
});
