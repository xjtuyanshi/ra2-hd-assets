import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import { painterObject } from '../src/ra2/painterOrder';
import { cardPush, type SpriteInstance } from '../src/ra2/sprites';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry } from '../../ra2-assets/src/manifest';
import { LiveView, canvasFrame, indexBuildingAnims, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';

/**
 * The nuclear silo: a 3x3 building whose body SHP (238x202 canvas) has no pixels in any frame; the engine draws it as
 * one of its SuperAnim layers. Real libraryBuildingSprites, layer and queue paths; no GPU or game assets.
 */
function silo() {
  const empty = () => ({
    rect: [0, 0, 0, 0] as [number, number, number, number],
    offset: [-119, -101] as [number, number],
  });
  const body: SpriteEntry = { frames: [empty(), empty()], canvas: [238, 202], palette: 'unit', remap: true };
  // The layer's art reaches from 120 px above the draw point to 58 px below it.
  const layer: SpriteEntry = {
    frames: [{ rect: [10, 20, 147, 178], offset: [-73, -120], page: 0 }],
    canvas: [238, 202],
    palette: 'unit',
    remap: true,
  };
  const sprites: Record<string, SpriteEntry> = { 'building:SILO': body, 'anim:SILO_G': layer };
  const type: LibraryType = {
    kind: 'building',
    image: 'SILO',
    sprite: 'building:SILO',
    foundation: [3, 3],
    drawOffset: [0, -15],
    lighting: 'ambient',
    remap: true,
    building: { bodyFrames: 2, layers: [{ key: 'SuperAnimThree', sprite: 'anim:SILO_G', anim: {} }] },
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'building',
    type: 'SILO',
    owner: 0,
    x: 58 * 256 + 128,
    y: 91 * 256 + 128,
    z: 0,
    facingRaw: 0,
    health: 1,
    isSelected: false,
    buildState: 'done',
    buildingFrame: 0,
    buildingDamaged: false,
  };
  // The engine's own list: the silo's ready anim on the building's cell, flagged as a building anim.
  const anims = [
    { id: 9, uid: 9, type: 'SILO_G', x: object.x, y: object.y, z: 0, frame: 0, buildingAnim: true },
  ] as unknown as NonNullable<LiveSnapshot['effects']>['anims'];
  const pool = new SpritePool();
  const state = {
    library: { library: { sprites }, conditionYellow: 0.5, page: () => ({}), hasHdPage: () => false },
    cache: { paletteRow: new Map([['lib:unit@house0', 1]]), depthTemplate: { width: 396, height: 477 } },
    libraryPaletteKeys: new Map(),
    spritePool: pool,
    civilian: new Set(),
    appearances: new Map(),
    buildingAnimMatches: new Map(),
    buildingAnims: indexBuildingAnims(anims),
    firstFrame: 0,
  };
  const visual = { root: new Group(), libraryType: type, paletteKey: 'house0', firstFrame: 0 };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    libraryBuildingSprites(o: LiveObject, v: unknown, b: Map<number, SpriteInstance[]>, s: LiveSnapshot): boolean;
    queue(batch: Map<number, SpriteInstance[]>, instance: SpriteInstance, indexed?: boolean): void;
  };
  const queued = vi.spyOn(view, 'queue');
  pool.begin();
  pool.painter = { ...painterObject(2, 0, 0), x: 58, z: 91, foundation: type.foundation };
  view.libraryBuildingSprites(object, visual, new Map(), { frame: 1000, houses: [], objects: [object] });
  return { cards: queued.mock.calls.map((call) => call[1]), layer, body };
}

describe('a building whose body frame has no pixels', () => {
  it('stands in the whole SHP canvas, centred on the draw point', () => {
    expect(canvasFrame({ canvas: [238, 202] })).toEqual({ rect: [0, 0, 238, 202], offset: [-119, -101] });
    expect(canvasFrame({ canvas: [0, 202] })).toBeUndefined();
    expect(canvasFrame({})).toBeUndefined();
  });

  it('draws its layer in front of the ground: the push and the depth of the canvas, not of an empty rectangle', () => {
    const { cards, layer, body } = silo();
    // No body card (nothing to draw); the engine's layer is there.
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.frame).toBe(layer.frames[0]);
    expect(card.shadow).toBe(false);
    // The empty rectangle gave 0.03 + 0.01: the layer's 58 px below the draw point were behind the ground.
    const canvas = canvasFrame(body)!;
    expect(card.push).toBeCloseTo(cardPush(canvas) + 0.01, 6);
    expect(card.push).toBeGreaterThan(cardPush(layer.frames[0]!));
    // Body depth of a 3x3 building whose picture ends at the canvas bottom (+101), not at its top (-101).
    expect(card.nativeDepth).toMatchObject({ mode: 'body' });
    const depth = card.nativeDepth as { mode: 'body'; base: number; origin: readonly [number, number] };
    expect(depth.origin).toEqual([198, 446 - 15 * 4]);
    expect(depth.base).toBe(-101 + Math.min(202, 477 - (386 - 101)));
    expect(depth.base).toBeGreaterThan(0);
  });
});
