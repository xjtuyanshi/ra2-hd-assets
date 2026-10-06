import { describe, expect, it, vi } from 'vitest';
import { Texture, Vector3, type MeshBasicNodeMaterial } from 'three/webgpu';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { SpritePool } from '../src/live/spritePool';
import { biasedDepth, createPainterDepth } from '../src/painterDepth';
import { HIGH_BRIDGE_HEIGHT, isHighBridge } from '../src/ra2/bridgeDepth';
import {
  CARD_CLEARANCE,
  EFFECT_DECAL_LIFT,
  SPRITE_DECAL_LIFT,
  SPRITE_DECAL_LIFT_ROWS,
  cardDepthPush,
  foundationPointPush,
} from '../src/ra2/cardDepth';
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
import { TerrainDepth } from '../src/terrainDepth';
import { groundPush, nativeCardPush, TERRAIN_OBJECT_DEPTH_BONUS, terrainObjectDepth } from '../src/ra2/nativeDepth';
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

  it.each([SPRITE_DECAL_LIFT, EFFECT_DECAL_LIFT])(
    'keeps connected wall lower rows ahead of shadow/decal planes lifted by %s',
    (lift) => {
      // Synthetic end/middle/end wall cards, with the same NW draw-point convention as live wall overlays.
      // Above py=0 the card stands vertically; below it the depth model follows the ground. Both must pass.
      for (const x of [50, 51, 52]) {
        const anchor = objectAnchor({ kind: 'overlay', type: 'WALL', x, y: 50, z: 0, drawOffset: [0, 0] });
        for (const px of [-15, 0, 15])
          for (const py of [-12, 0, 12, 24]) {
            const pixel: [number, number] = [screen(anchor)[0] + px, screen(anchor)[1] + py];
            // Intersect the SAME view ray with the lifted ground plane, including the projected height shift.
            // Comparing depth at the same world X/Z instead would miss the original 0.03 vs 0.04 failure.
            const sum = (pixel[1] + lift * Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE) / 15;
            const diff = pixel[0] / 30;
            const shadow = new Vector3((sum + diff) / 2, lift, (sum - diff) / 2);
            expect(screen(shadow)[0]).toBeCloseTo(pixel[0], 8);
            expect(screen(shadow)[1]).toBeCloseTo(pixel[1], 8);
            expect(cardAt(anchor, pixel)).toBeLessThan(depthAt(shadow));
          }
      }
    },
  );

  it('composites Air over coincident Ground units but still hides it behind trees and both building faces', () => {
    const anchor = new Vector3(50, 0, 50);
    const pixel = screen(new Vector3(50, 0.3, 50));
    const unit = painterObject(2, 25600, 1000);
    assignPainterBias([unit]);
    const air = cardAt(anchor, pixel, 0, 0, MAX_PAINTER_BIAS);
    expect(air).toBeLessThan(cardAt(anchor, pixel, 0, 0, spritePainterBias(unit, 1)));
    expect(air).toBeLessThan(biasedDepth(depthAt(new Vector3(50, 0.3, 50)), VOXEL_CLEARANCE + unit.bias, range));
    const far = new Vector3(49.5, 0, 49.5);
    expect(cardAt(far, pixel, 0, 0, MAX_PAINTER_BIAS)).toBeGreaterThan(cardAt(anchor, pixel));
    for (const [x, z] of [
      [49.5, 52.5],
      [52.5, 49.5],
    ]) {
      const behind = new Vector3(x!, 0, z!);
      const at = screen(new Vector3(x!, 0.3, z!));
      expect(cardAt(behind, at, 0, 0, MAX_PAINTER_BIAS)).toBeGreaterThan(cardAt(anchor, at, 4, 4));
    }
  });

  it('keeps a lifted ground decal on the screen pixels of the unlifted art and on the same lifted plane', () => {
    // Raised straight up, a decal sits 0.73 native px above the engine's picture; every flat overlay, ore cell and
    // smudge measured one pixel high against the original. Sliding the art SPRITE_DECAL_LIFT_ROWS down its plane
    // lifts it along the view ray instead.
    expect(SPRITE_DECAL_LIFT_ROWS).toBeCloseTo(0.735, 3);
    for (const [x, z, y] of [
      [50, 50, 0],
      [37.25, 61.5, 0.8],
    ] as const)
      for (const [px, py] of [
        [0, 0],
        [-29, 14],
        [17, -6],
      ] as const) {
        const ground = new Vector3(x + px / 60 + py / 30, y, z + py / 30 - px / 60);
        const straightUp = ground.clone().setY(y + SPRITE_DECAL_LIFT);
        const k = SPRITE_DECAL_LIFT_ROWS / 30;
        const placed = new Vector3(ground.x + k, y + SPRITE_DECAL_LIFT, ground.z + k);
        expect(screen(ground)[1] - screen(straightUp)[1]).toBeCloseTo(SPRITE_DECAL_LIFT_ROWS, 9);
        expect(screen(placed)[0]).toBeCloseTo(screen(ground)[0], 9);
        expect(screen(placed)[1]).toBeCloseTo(screen(ground)[1], 9);
        // Still exactly SPRITE_DECAL_LIFT / sin 30 degrees nearer than the ground under the same pixel.
        expect(depthAt(ground) - depthAt(placed)).toBeCloseTo(SPRITE_DECAL_LIFT / Math.sin(Math.PI / 6) / range, 9);
      }
  });

  it('tests under/on bridge units against one elevated plane across neighbouring deck cells', () => {
    // Engine draw points of a bridge owner: (0, -1) for the first direction, (0, -16) for the second. The deck's
    // depth plane is four levels over the owner cells wherever on that ground plane the draw point lies, so both
    // directions (and the former 60 px offset) give one plane.
    const deck = (x: number, drawOffset: [number, number] = [0, -1]) =>
      objectAnchor({ kind: 'overlay', type: 'BRIDGE1', x, y: 10, z: 0, drawOffset });
    for (const height of [0.3, HIGH_BRIDGE_HEIGHT, HIGH_BRIDGE_HEIGHT + 0.3]) {
      const unit = new Vector3(22, height, 10.5);
      const pixel = screen(unit);
      const depths = [21, 22, 23].map((x) => cardAt(deck(x), pixel, -1, HIGH_BRIDGE_HEIGHT));
      expect(depths[0]).toBe(depths[1]);
      expect(depths[1]).toBe(depths[2]);
      expect(cardAt(deck(22, [0, -16]), pixel, -1, HIGH_BRIDGE_HEIGHT)).toBeCloseTo(depths[0]!, 6);
      expect(cardAt(deck(22, [0, -60]), pixel, -1, HIGH_BRIDGE_HEIGHT)).toBeCloseTo(depths[0]!, 6);
      if (height < HIGH_BRIDGE_HEIGHT) expect(depthAt(unit)).toBeGreaterThan(depths[0]!);
      else expect(biasedDepth(depthAt(unit), VOXEL_CLEARANCE, range)).toBeLessThan(depths[0]!);
    }
    // The deck surface drawn at a pixel is the point of that plane under the pixel: four levels up, in front of the
    // water below it and behind a unit standing on it.
    const surface = new Vector3(22.5, HIGH_BRIDGE_HEIGHT, 10.5);
    const water = new Vector3(22.5 - 2, 0, 10.5 - 2);
    expect(screen(water)[1]).toBeCloseTo(screen(surface)[1], 6);
    expect(cardAt(deck(22), screen(surface), -1, HIGH_BRIDGE_HEIGHT)).toBeLessThan(depthAt(water));
    expect(cardAt(deck(22), screen(surface), -1, HIGH_BRIDGE_HEIGHT)).toBeLessThan(depthAt(surface));
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

type Buffers = { anchor: DirtyAttribute; params: DirtyAttribute; flags: DirtyAttribute };

describe('sprite depth attributes', () => {
  it('keeps grade exemption, capture codes, native profiles and body opacity independent across retained uploads', () => {
    const atlas = new Texture();
    const capture = new TerrainDepth(1.5);
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map(),
      manifest: { spriteAtlas: { width: 32, height: 32 } },
      spriteAtlas: atlas,
    } as unknown as Ra2Cache;
    const body: SpriteInstance = {
      anchor: new Vector3(4.5, 2, 6.25),
      frame: { rect: [0, 0, 20, 40], offset: [-10, -30] },
      palette: '',
      push: 0.5,
      shadow: false,
      lightSample: [9.5, 10.5],
      gradeExempt: true,
      opacity: 0.25,
      nativeDepth: { mode: 'body', origin: [198, 386], base: 91, offset: [12, 9], anchorPush: 0.5 },
    };
    const unit: SpriteInstance = {
      ...body,
      anchor: new Vector3(7, 3, 8),
      lightSample: undefined,
      gradeExempt: false,
      opacity: 1,
      nativeDepth: { mode: 'card', bottom: 3, bonus: 12 },
    };
    const layer = new SpriteLayer(cache, [body, unit], 2, undefined, null, null, null, capture);
    const buffers = layer as unknown as Buffers & { uploaded: SpriteInstance[] };
    const row = (attribute: DirtyAttribute, instance: SpriteInstance) => {
      const index = buffers.uploaded.indexOf(instance);
      expect(index).toBeGreaterThanOrEqual(0);
      return Array.from(attribute.array.slice(index * attribute.itemSize, (index + 1) * attribute.itemSize));
    };
    try {
      expect(buffers.anchor.itemSize).toBe(6);
      expect(buffers.flags.itemSize).toBe(17);
      layer.updateCaptureCodes((instance) => (instance === body ? 23 : 7));
      expect(row(buffers.anchor, body)).toEqual([4.5, 2, 6.25, 9.5, 10.5, 1]);
      expect(row(buffers.anchor, unit)).toEqual([7, 3, 8, 7, 8, 0]);
      // Translucent art deliberately stays out of capture, while its neighboring opaque card keeps its code.
      expect(row(buffers.flags, body).slice(8)).toEqual([-65504, 1, 198, 386, 91, 12, 9, 0.5, 3.25]);
      expect(row(buffers.flags, unit).slice(8)).toEqual([7, 3, 3, 12, 0, 0, 0, 0, 2]);
      expect(layer.translucentMesh.visible).toBe(true);
      expect(layer.unitMesh.layers.isEnabled(31)).toBe(true);
      const params = row(buffers.params, body);
      body.opacity = 1;
      // The same pooled records are uploaded without sorting; every independent field must be reset.
      layer.setInstances([body, unit], false);
      expect(row(buffers.flags, body).slice(8)).toEqual([-65504, 1, 198, 386, 91, 12, 9, 0.5, 0]);
      expect(row(buffers.anchor, body)).toEqual([4.5, 2, 6.25, 9.5, 10.5, 1]);
      expect(row(buffers.params, body)).toEqual(params);
      expect(layer.translucentMesh.visible).toBe(false);
      layer.updateCaptureCodes((instance) => (instance === body ? 31 : 11));
      expect(row(buffers.flags, body).slice(8)).toEqual([31, 1, 198, 386, 91, 12, 9, 0.5, 0]);
      expect(row(buffers.flags, unit).slice(8)).toEqual([11, 3, 3, 12, 0, 0, 0, 0, 2]);
      body.gradeExempt = false;
      body.opacity = 0.5;
      layer.setInstances([body, unit], false);
      layer.updateCaptureCodes((instance) => (instance === body ? 31 : 11));
      expect(row(buffers.anchor, body)).toEqual([4.5, 2, 6.25, 9.5, 10.5, 0]);
      expect(row(buffers.flags, body).slice(8)).toEqual([-65504, 1, 198, 386, 91, 12, 9, 0.5, 3.5]);
      expect(row(buffers.flags, unit).slice(8)).toEqual([11, 3, 3, 12, 0, 0, 0, 0, 2]);
      expect(row(buffers.params, body)).toEqual(params);
    } finally {
      layer.mesh.geometry.dispose();
      layer.mesh.material.dispose();
      layer.mesh.dispose();
      capture.dispose();
      atlas.dispose();
    }
  });

  it('packs native modes and owner offsets without changing capture codes or depth-writing ordinary cards', () => {
    const atlas = new Texture();
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['unit', 0]]),
      manifest: { spriteAtlas: { width: 256, height: 256 } },
      spriteAtlas: atlas,
    } as unknown as Ra2Cache;
    const card: SpriteInstance = {
      anchor: new Vector3(),
      frame: { rect: [0, 0, 20, 40], offset: [-10, -30] },
      palette: 'unit',
      push: 0,
      shadow: false,
      nativeDepth: { mode: 'body', origin: [198, 386], base: 91, offset: [12, 9], anchorPush: 0.5 },
    };
    const layer = new SpriteLayer(cache, [card]);
    const flags = (layer as unknown as Buffers).flags;
    try {
      expect(flags.itemSize).toBe(16);
      expect(Array.from(flags.array.slice(8, 16))).toEqual([1, 198, 386, 91, 12, 9, 0.5, 0]);
      expect(layer.readOnlyMesh.visible).toBe(false);
      layer.setInstances([{ ...card, nativeDepth: { mode: 'ground', bonus: 6 }, depthWrite: false }]);
      expect(Array.from(flags.array.slice(8, 16))).toEqual([2, 0, 0, 6, 0, 0, 0, 1]);
      expect(layer.readOnlyMesh.visible).toBe(true);
      expect(layer.readOnlyMesh.instances).toBe(1);
      expect(layer.readOnlyMesh.material.depthWrite).toBe(false);
      expect(layer.mesh.material.depthWrite).toBe(true);
      expect(layer.readOnlyMesh.geometry).toBe(layer.mesh.geometry);
      layer.mesh.renderOrder = 8;
      expect(layer.readOnlyMesh.renderOrder).toBeCloseTo(8.001, 8);
      layer.setInstances([{ ...card, nativeDepth: { mode: 'card', bottom: 9, bonus: 12 } }]);
      expect(Array.from(flags.array.slice(8, 16))).toEqual([3, 9, 12, 0, 0, 0, 0, 2]);
      expect(layer.unitMesh.visible).toBe(true);
      expect(layer.readOnlyMesh.visible).toBe(false);
      layer.setInstances([{ ...card, shadow: true }]);
      expect(Array.from(flags.array.slice(8, 16))).toEqual(new Array(8).fill(0));
    } finally {
      layer.mesh.geometry.dispose();
      layer.mesh.material.dispose();
      layer.mesh.dispose();
      atlas.dispose();
    }
  });

  it('draws native units after test-only doors and retains unit capture metadata in their late pass', () => {
    const atlas = new Texture();
    const capture = new TerrainDepth(1.5);
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map(),
      manifest: { spriteAtlas: { width: 32, height: 32 } },
      spriteAtlas: atlas,
    } as unknown as Ra2Cache;
    const frame: SpriteFrame = { rect: [0, 0, 20, 20], offset: [-10, -16] };
    const unit: SpriteInstance = {
      anchor: new Vector3(),
      frame,
      palette: '',
      push: 0,
      shadow: false,
      nativeDepth: { mode: 'card', bottom: 3, bonus: 0 },
    };
    const door: SpriteInstance = { ...unit, nativeDepth: { mode: 'ground', bonus: 6 }, depthWrite: false };
    const layer = new SpriteLayer(cache, [door, unit], 2, undefined, null, null, null, capture);
    try {
      // e=3 clears UnderDoor(k=1), but Door(k=6) is nearer. Test-only depth without scheduling would paint it over.
      expect(nativeCardPush(0, 3)).toBeGreaterThan(groundPush(0, 1));
      expect(nativeCardPush(0, 3)).toBeLessThan(groundPush(0, 6));
      expect(layer.mesh.renderOrder).toBeLessThan(layer.readOnlyMesh.renderOrder);
      expect(layer.readOnlyMesh.renderOrder).toBeLessThan(layer.unitMesh.renderOrder);
      expect(layer.unitMesh.material.transparent).toBe(true);
      expect(layer.unitMesh.material.depthWrite).toBe(true);
      expect(layer.unitMesh.geometry).toBe(layer.mesh.geometry);
      expect(layer.unitMesh.material.userData.objectDepthCodeNode).toBe(
        layer.mesh.material.userData.objectDepthCodeNode,
      );
      layer.updateCaptureCodes(() => 7);
      expect(layer.unitMesh.layers.isEnabled(31)).toBe(true);
      expect(layer.readOnlyMesh.layers.isEnabled(31)).toBe(false);
      const flags = (layer as unknown as Buffers).flags;
      expect(flags.itemSize).toBe(17);
      expect(flags.getComponent(0, 8)).toBe(-65504);
      expect(flags.getComponent(1, 8)).toBe(7);
      layer.mesh.dispose();
      expect(layer.unitMesh.layers.isEnabled(31)).toBe(false);
    } finally {
      layer.mesh.geometry.dispose();
      layer.mesh.material.dispose();
      capture.dispose();
      atlas.dispose();
    }
  });

  it('keeps a Z-writing terrain object card in the body pass, where later units are tested against it', () => {
    const atlas = new Texture();
    const capture = new TerrainDepth(1.5);
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map(),
      manifest: { spriteAtlas: { width: 32, height: 32 } },
      spriteAtlas: atlas,
    } as unknown as Ra2Cache;
    const tree: SpriteInstance = {
      anchor: new Vector3(),
      frame: { rect: [0, 0, 40, 60], offset: [-20, -58] },
      palette: '',
      push: 0,
      shadow: false,
      nativeDepth: terrainObjectDepth({ rect: [0, 0, 40, 60], offset: [-20, -58] }),
    };
    const unit: SpriteInstance = { ...tree, nativeDepth: { mode: 'card', bottom: 3, bonus: 0 } };
    const layer = new SpriteLayer(cache, [tree], 2, undefined, null, null, null, capture);
    try {
      expect(tree.nativeDepth).toEqual({ mode: 'card', bottom: 1, bonus: TERRAIN_OBJECT_DEPTH_BONUS, writer: true });
      const flags = (layer as unknown as Buffers).flags;
      // Card mode with its bottom and bonus, drawn by the depth-writing main pass (0), not the late unit pass (2).
      expect([9, 10, 11, 16].map((component) => flags.getComponent(0, component))).toEqual([3, 1, 12, 0]);
      expect(layer.unitMesh.visible).toBe(false);
      layer.updateCaptureCodes(() => 7);
      expect(layer.unitMesh.layers.isEnabled(31)).toBe(false);
      expect(layer.mesh.layers.isEnabled(31)).toBe(true);
      layer.setInstances([tree, unit]);
      const uploaded = (layer as unknown as { uploaded: SpriteInstance[] }).uploaded;
      expect(flags.getComponent(uploaded.indexOf(tree), 16)).toBe(0);
      expect(flags.getComponent(uploaded.indexOf(unit), 16)).toBe(2);
      expect(layer.unitMesh.visible).toBe(true);
      // The rule the card encodes, for draw points on one screen row: a vehicle (bonus 0) is nearer than the tree
      // only when its bitmap bottom is more than nine rows below the tree's, so it passes behind the crown.
      const nearer = (unitBottom: number, treeBottom: number, row: number) =>
        nativeCardPush(row, unitBottom) > nativeCardPush(row, treeBottom, TERRAIN_OBJECT_DEPTH_BONUS);
      for (const row of [-40, -39, -38, -20, -5]) {
        expect(nearer(0, 0, row)).toBe(false);
        expect(nearer(6, 0, row)).toBe(false);
        expect(nearer(9, 0, row)).toBe(false);
        expect(nearer(10, 0, row)).toBe(true);
        expect(nearer(12, 2, row)).toBe(true);
      }
    } finally {
      layer.mesh.geometry.dispose();
      layer.mesh.material.dispose();
      layer.mesh.dispose();
      capture.dispose();
      atlas.dispose();
    }
  });

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
      expect(Array.from(buffers.flags.array.slice(4, 8))).toEqual([4, 2, 0, 0]);
      const placement = Array.from(buffers.params.array);
      const anchor = Array.from(buffers.anchor.array);
      layer.setInstances([{ ...card, nativeDepth: { mode: 'ground', bonus: 1 } }]);
      expect(Array.from(buffers.flags.array.slice(4, 8))).toEqual([4, 2, 0, 0]);
      expect(buffers.anchor.itemSize).toBe(6);
      expect(Array.from(buffers.anchor.array)).toEqual(anchor);
      expect(Array.from(buffers.params.array)).toEqual(placement);
      layer.setInstances([{ ...card, anchor: new Vector3(50.75, 0, 50.25) }]);
      expect(Array.from(buffers.flags.array.slice(4, 8))).toEqual([4, 2, 0.5, -1]);
      layer.setInstances([{ ...card, painterPart: 0.1 }]);
      expect(Array.from(buffers.flags.array.slice(4, 7))).toEqual([4, 2, 0]);
      expect(buffers.flags.array[7]).toBeCloseTo(0, 12);
      expect(buffers.flags.array[3]).toBeGreaterThan(0);
      expect(Array.from(buffers.params.array)).toEqual(placement);
      for (const mode of [{ shadow: true }, { flat: true }]) {
        layer.setInstances([{ ...card, ...mode, painterPart: 0.4 }]);
        expect(buffers.flags.array[3]).toBe(0);
      }
      layer.setInstances([{ ...card, painter: undefined, deckHeight: HIGH_BRIDGE_HEIGHT }]);
      expect(buffers.flags.array[4]).toBe(-1);
      expect(buffers.flags.array[5]).toBeCloseTo(HIGH_BRIDGE_HEIGHT, 6);
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

  it('clears pooled owners, component bias, bridge profiles and native depth between uses', () => {
    const pool = new SpritePool();
    const frame: SpriteFrame = { rect: [0, 0, 16, 24], offset: [-8, -18] };
    pool.painter = painterObject(2, 10);
    pool.deckHeight = HIGH_BRIDGE_HEIGHT;
    const first = pool.take(new Vector3(), frame, 'unit', 0, false, false, 1, 'ambient', 0.4);
    first.nativeDepth = { mode: 'ground', bonus: 1 };
    first.depthWrite = false;
    expect(first.painter).toBeDefined();
    pool.begin();
    const next = pool.take(new Vector3(), frame, 'unit', 0, false);
    expect(next).toBe(first);
    expect(next.painter).toBeUndefined();
    expect(next.painterPart).toBe(0);
    expect(next.deckHeight).toBeUndefined();
    expect(next.nativeDepth).toBeUndefined();
    expect(next.depthWrite).toBeUndefined();
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
