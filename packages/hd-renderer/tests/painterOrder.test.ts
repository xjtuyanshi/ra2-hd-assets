import { describe, expect, it, vi } from 'vitest';
import { Texture, Vector3, type MeshBasicNodeMaterial } from 'three/webgpu';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { SpritePool } from '../src/live/spritePool';
import { biasedDepth, createPainterDepth } from '../src/painterDepth';
import { HIGH_BRIDGE_HEIGHT, isHighBridge } from '../src/ra2/bridgeDepth';
import { CARD_CLEARANCE, cardDepthPush, foundationPointPush } from '../src/ra2/cardDepth';
import type { Ra2Cache } from '../src/ra2/cache';
import { Ra2NightDressing } from '../src/ra2/nightDressing';
import {
  assignPainterBias,
  comparePainterOrder,
  MAX_PAINTER_BIAS,
  objectYSort,
  painterObject,
  spritePainterBias,
} from '../src/ra2/painterOrder';
import { cardPush, objectAnchor, SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { VOXEL_CLEARANCE } from '../src/ra2/voxels';
import { IsoCamera, PIXELS_PER_CELL_EDGE } from '../src/world';

const view = new IsoCamera();
view.target.set(50, 0, 50);
view.update();
const range = view.camera.far - view.camera.near;
const depthAt = (p: Vector3): number =>
  (-p.clone().applyMatrix4(view.camera.matrixWorldInverse).z - view.camera.near) / range;
const screen = (p: Vector3): [number, number] => [
  (p.x - p.z) * 30,
  (p.x + p.z) * 15 - p.y * Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE,
];
function cardAt(anchor: Vector3, pixel: [number, number], w = 0, h = 0, bias = 0): number {
  const at = screen(anchor);
  return Math.fround(
    biasedDepth(depthAt(anchor), cardDepthPush(pixel[0] - at[0], pixel[1] - at[1], w, h) + bias, range),
  );
}

describe('YR traversal and physical occlusion', () => {
  it('keeps the verified sort keys, without using them as building occlusion planes', () => {
    expect(objectYSort(13248, 20544)).toBe(33792);
    expect(objectYSort(14208, 21888, true)).toBe(35840);
    expect(objectYSort(5000, 6000, true, true)).toBe(10776);
    expect(objectYSort(5000, 6000, true, false, true)).toBe(10728);
    expect(objectYSort(5000, 6000, true, true, true)).toBe(10760);
    const building = painterObject(2, objectYSort(50.5 * 256, 50.5 * 256, true), 0);
    const tank = painterObject(2, objectYSort(52.5 * 256, 49.5 * 256), 1);
    expect(comparePainterOrder(building, tank)).toBeLessThan(0);
    // A later traversal entry still fails the building's Z test at the back face.
    building.foundation = [4, 4];
    assignPainterBias([building, tank]);
    const point = new Vector3(52.5, 0.3, 49.5);
    expect(cardAt(new Vector3(50, 0, 50), screen(point), 4, 4)).toBeLessThan(
      biasedDepth(depthAt(point), tank.bias, range),
    );
  });

  it.each([
    [49.5, 52.5],
    [52.5, 49.5],
  ])('hides a unit behind either back face at (%s,%s)', (x, z) => {
    const unit = new Vector3(x, 0.3, z);
    const building = cardAt(new Vector3(50, 0, 50), screen(unit), 4, 4);
    const infantry = cardAt(new Vector3(x, 0, z), screen(unit), 0, 0, MAX_PAINTER_BIAS);
    expect(building).toBeLessThan(infantry);
    expect(building).toBeLessThan(biasedDepth(depthAt(unit), MAX_PAINTER_BIAS, range));
  });

  it.each([
    [54.5, 51.5],
    [51.5, 54.5],
  ])('keeps a unit in front of the facade at (%s,%s)', (x, z) => {
    const unit = new Vector3(x, 0.3, z);
    expect(cardAt(new Vector3(x, 0, z), screen(unit))).toBeLessThan(cardAt(new Vector3(50, 0, 50), screen(unit), 4, 4));
  });

  it('uses different depths across a wide facade instead of one frontmost card plane', () => {
    expect(cardDepthPush(0, 0, 4, 4)).toBeGreaterThan(cardDepthPush(90, 0, 4, 4));
    expect(cardDepthPush(0, 0, 4, 4)).toBeGreaterThan(cardDepthPush(-90, 0, 4, 4));
    // A layer shifted on screen still samples the owner's same facade.
    const shiftX = 0.5;
    const shiftZ = 0.25;
    const shiftedAnchor = new Vector3(50 + shiftX, 0, 50 + shiftZ);
    const pixel: [number, number] = [20, 1460];
    const at = screen(shiftedAnchor);
    const push = cardDepthPush(pixel[0] - at[0], pixel[1] - at[1], 4, 4, shiftX - shiftZ, -shiftX - shiftZ);
    expect(biasedDepth(depthAt(shiftedAnchor), push, range)).toBeCloseTo(
      cardAt(new Vector3(50, 0, 50), pixel, 4, 4),
      7,
    );
  });

  it('interleaves a physical beam, rain or lamp head with a unit at the same screen pixel', () => {
    const surface = new Vector3(50, 0.3, 50);
    const towardCamera = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
    const nearBeam = surface.clone().addScaledVector(towardCamera, 0.2);
    const farBeam = surface.clone().addScaledVector(towardCamera, -0.2);
    const unitDepth = cardAt(new Vector3(50, 0, 50), screen(surface), 0, 0, MAX_PAINTER_BIAS);
    expect(depthAt(nearBeam)).toBeLessThan(unitDepth);
    expect(depthAt(farBeam)).toBeGreaterThan(unitDepth);
    expect(depthAt(nearBeam)).toBeLessThan(biasedDepth(depthAt(surface), MAX_PAINTER_BIAS, range));
    expect(unitDepth).toBeGreaterThan(0.3); // No global 0.1..0.2 band.
  });

  it('places a map lamp head just in front of its own foundation profile', () => {
    const cache = {
      lights: null,
      manifest: {
        sprites: {
          'building:GALITE': {
            foundation: [1, 1],
            frames: [{ rect: [0, 0, 24, 60], offset: [-12, -45] }],
          },
        },
      },
    } as unknown as Ra2Cache;
    const dressing = new Ra2NightDressing({ cache, objects: [], root: view.camera, heightAt: () => 0 });
    const { lampHead, headPush } = dressing as unknown as { lampHead: number; headPush: number };
    const globe = new Vector3(50.5, lampHead, 50.5);
    expect(biasedDepth(depthAt(globe), headPush, range)).toBeLessThan(
      cardAt(new Vector3(50, 0, 50), screen(globe), 1, 1),
    );
  });

  it.each([-45, 0, 30])('places an offset turret in front of the body at screen row %s', (py) => {
    const point = new Vector3(50 + py / 30, 0, 50 + py / 30);
    const push = foundationPointPush(point.x - 50, point.z - 50, 2, 2) + 0.45;
    const body = cardAt(new Vector3(50, 0, 50), screen(point), 2, 2);
    // A turret part extending 0.3 world units behind its root still clears the body at its draw point.
    expect(biasedDepth(depthAt(point), push - 0.3, range)).toBeLessThan(body);
    expect(biasedDepth(depthAt(point), push - 0.45, range)).toBeCloseTo(body, 7);
  });

  it('hides an explosion behind a tree regardless of its sprite frame size', () => {
    const tree = new Vector3(50, 0, 50);
    const explosion = new Vector3(49.5, 0, 49.5);
    const pixel = screen(new Vector3(50, 1, 50));
    const farEffect = cardAt(explosion, pixel, 0, 0, MAX_PAINTER_BIAS);
    expect(farEffect).toBeGreaterThan(cardAt(tree, pixel));
    // cardPush still places geometry for lighting, but the depth shader cancels it before reconstructing depth.
    const py = pixel[1] - screen(explosion)[1];
    for (const height of [20, 200, 600]) {
      const placement = cardPush({ rect: [0, 0, 100, height], offset: [-50, -10] });
      const placedDepth = biasedDepth(depthAt(explosion), placement, range);
      expect(biasedDepth(placedDepth, cardDepthPush(0, py) - placement + MAX_PAINTER_BIAS, range)).toBeCloseTo(
        farEffect,
        7,
      );
    }
  });

  it.each([-30, 0, 10, 30])('keeps a unit card above its own ground at pixel row %s', (py) => {
    const groundPush = (py * Math.sqrt(3)) / PIXELS_PER_CELL_EDGE;
    expect(cardDepthPush(0, py)).toBeGreaterThan(groundPush);
  });

  it('tests under/on bridge units against one elevated plane across neighbouring deck cells', () => {
    const deck = (x: number) =>
      objectAnchor({ kind: 'overlay', type: 'BRIDGE1', x, y: 10, z: 0, drawOffset: [0, -60] });
    for (const height of [0.3, HIGH_BRIDGE_HEIGHT, HIGH_BRIDGE_HEIGHT + 0.3]) {
      const unit = new Vector3(22, height, 10.5);
      const pixel = screen(unit);
      const depths = [21, 22, 23].map((x) => cardAt(deck(x), pixel, -1, HIGH_BRIDGE_HEIGHT));
      expect(depths[0]).toBe(depths[1]);
      expect(depths[1]).toBe(depths[2]);
      if (height < HIGH_BRIDGE_HEIGHT) expect(depthAt(unit)).toBeGreaterThan(depths[0]!);
      else expect(biasedDepth(depthAt(unit), VOXEL_CLEARANCE, range)).toBeLessThan(depths[0]!);
    }
    expect(isHighBridge('BRIDGEB2')).toBe(true);
    expect(isHighBridge('RAILBRDG1')).toBe(true);
    expect(isHighBridge('GASAND')).toBe(false);
  });

  it('keeps mixed native and fallback comparison transitive even during a partial native sort', () => {
    const a = painterObject(2, 900, 1);
    const b = painterObject(2, 100, 2);
    const fallback = painterObject(2, 500);
    for (const input of [
      [a, fallback, b],
      [b, a, fallback],
      [fallback, b, a],
    ])
      expect(input.sort(comparePainterOrder)).toEqual([fallback, a, b]);
  });

  it('preserves native registration ties and bounded part biases without occupancy-dependent slots', () => {
    const a = painterObject(2, 10000, 1);
    const b = painterObject(2, 100, 2);
    const tree = painterObject(2, 5000);
    assignPainterBias([a, b, tree]);
    expect(comparePainterOrder(a, b)).toBeLessThan(0); // Partially sorted native list.
    expect(a.bias).toBeLessThan(b.bias);
    const before = [a.bias, b.bias, tree.bias];
    const effects = Array.from({ length: 1000 }, (_, index) => painterObject(2, index));
    assignPainterBias([...effects, b, tree, a]);
    expect([a.bias, b.bias, tree.bias]).toEqual(before);
    for (const layer of [0, 1, 2, 3, 4]) {
      const object = painterObject(layer, 100, 100000);
      assignPainterBias([object]);
      expect(spritePainterBias(object, 0.4)).toBeLessThan(MAX_PAINTER_BIAS);
      if (layer < 2) expect(spritePainterBias(object, 0.4)).toBe(0);
    }
    expect(spritePainterBias(a, 0.4)).toBeGreaterThan(spritePainterBias(a));
    // Full voxel geometry depth stays monotonic and uncompressed.
    expect(biasedDepth(0.36, a.bias, range) - biasedDepth(0.35, a.bias, range)).toBeCloseTo(0.01, 12);
    const one = createPainterDepth();
    const two = createPainterDepth();
    one.bias = 0.01;
    expect(two.bias).toBe(0);
    expect(CARD_CLEARANCE).toBeGreaterThan(0);
  });
});

type Buffers = { anchor: DirtyAttribute; params: DirtyAttribute; flags: DirtyAttribute; occlusion: DirtyAttribute };

describe('sprite depth attributes', () => {
  it('uploads foundation profiles and biases across atlases while keeping shadows, ore and placement physical', () => {
    const atlas = new Texture();
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['unit', 0]]),
      manifest: { spriteAtlas: { width: 256, height: 256 } },
      spriteAtlas: atlas,
    } as unknown as Ra2Cache;
    const building = painterObject(2, 100, 2);
    building.foundation = [4, 2];
    building.x = 50;
    building.z = 50;
    const frame: SpriteFrame = { rect: [0, 0, 100, 160], offset: [-50, -100] };
    const card: SpriteInstance = {
      anchor: new Vector3(50, 0, 50),
      frame,
      palette: 'unit',
      push: cardPush(frame),
      shadow: false,
      painter: building,
    };
    const layer = new SpriteLayer(cache, [card]);
    try {
      const buffers = layer as unknown as Buffers;
      expect(Array.from(buffers.occlusion.array)).toEqual([4, 2, 0, 0]);
      const placement = Array.from(buffers.params.array);
      layer.setInstances([{ ...card, painterPart: 0.1 }]);
      expect(buffers.flags.array[3]).toBeGreaterThan(0);
      expect(Array.from(buffers.params.array)).toEqual(placement);
      for (const mode of [{ shadow: true }, { flat: true }]) {
        layer.setInstances([{ ...card, ...mode, painterPart: 0.4 }]);
        expect(buffers.flags.array[3]).toBe(0);
      }
      layer.setInstances([{ ...card, painter: undefined, deckHeight: HIGH_BRIDGE_HEIGHT }]);
      expect(buffers.occlusion.array[0]).toBe(-1);
      expect(buffers.occlusion.array[1]).toBeCloseTo(HIGH_BRIDGE_HEIGHT, 6);
      const material = layer.mesh.material as MeshBasicNodeMaterial;
      expect(material.depthTest && material.depthWrite).toBe(true);
      expect(material.depthNode).not.toBeNull();
      const sort = vi.spyOn((layer as unknown as { orderedCards: SpriteInstance[] }).orderedCards, 'sort');
      // Interpolation changes anchors on retained pool records, not the layer's order or membership.
      card.anchor.x += 0.1;
      layer.setInstances([card]);
      sort.mockClear();
      card.anchor.x += 0.1;
      layer.setInstances([card], false);
      expect(sort).not.toHaveBeenCalled();
      expect(buffers.anchor.array[0]).toBeCloseTo(card.anchor.x, 5);
    } finally {
      layer.mesh.geometry.dispose();
      (layer.mesh.material as MeshBasicNodeMaterial).dispose();
      atlas.dispose();
    }
  });

  it('clears pooled owners, component bias and bridge profiles between uses', () => {
    const pool = new SpritePool();
    const frame: SpriteFrame = { rect: [0, 0, 16, 24], offset: [-8, -18] };
    pool.painter = painterObject(2, 10);
    pool.deckHeight = HIGH_BRIDGE_HEIGHT;
    const first = pool.take(new Vector3(), frame, 'unit', 0, false, false, 1, 'ambient', 0.4);
    expect(first.painter).toBeDefined();
    pool.begin();
    const next = pool.take(new Vector3(), frame, 'unit', 0, false);
    expect(next).toBe(first);
    expect(next.painter).toBeUndefined();
    expect(next.painterPart).toBe(0);
    expect(next.deckHeight).toBeUndefined();
  });
});

describe('sprite lighting samples', () => {
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
});
