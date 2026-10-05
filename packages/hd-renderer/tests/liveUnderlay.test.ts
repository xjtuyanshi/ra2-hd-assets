/** Object underlays (the ore-gathering sparks under a miner): the engine's frame as a ground decal under the body. */
import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { EffectHdAnim } from '../../ra2-assets/src/effects';
import type { SpriteEntry } from '../../ra2-assets/src/manifest';
import type { ResolvedAnim } from '../src/live/effectArt';
import { engineAnchor } from '../src/live/effectSprites';
import { objectUnderlayCard, UNDERLAY_DEPTH_PULL } from '../src/live/liveView';
import { CARD_CLEARANCE, EFFECT_DECAL_LIFT, GROUND_DEPTH } from '../src/ra2/cardDepth';
import { nativeCardPush } from '../src/ra2/nativeDepth';
import { VOXEL_CARD_KAPPA } from '../src/ra2/voxelNativeDepth';
import { SHADOW_COPIES, SHADOW_LIFT } from '../src/ra2/voxelShadow';

/** 120 frames like the native art: frame i sits on page 5 with a distinct rect; frame 44 is empty. */
function art(options: { hd?: EffectHdAnim; hdPage?: 'ready' | 'loading' | 'failed' } = {}) {
  const frames = Array.from({ length: 120 }, (_, i) => ({
    rect: [i * 10, 0, i === 44 ? 0 : 8, 6] as [number, number, number, number],
    offset: [-20 + (i % 15), -10] as [number, number],
    page: 5,
  }));
  const sprite = { palette: 'anim', canvas: [144, 80], frames } as unknown as SpriteEntry;
  const resolved = { id: 'SPARKS', art: {}, sprite, palette: 'fx:anim', remap: false } as unknown as ResolvedAnim;
  const asked: string[] = [];
  return {
    asked,
    anim: (type: string) => (asked.push(type), type === 'SPARKS' ? resolved : null),
    hdAnim: (type: string) => (type === 'SPARKS' ? (options.hd ?? null) : null),
    hdPageState: () =>
      options.hdPage === 'failed'
        ? null
        : options.hdPage === 'loading'
          ? ('loading' as const)
          : { texture: {} as never, width: 256, height: 256 },
  };
}

const shown = () => false;
/** The fixed dimetric view (world.ts IsoCamera): unit vector from the scene to the camera. */
const toCamera = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
const underlay = { art: 'SPARKS', frame: 47, x: 40 * 256 + 128, y: 60 * 256 + 158, z: 208 };

describe('live object underlay', () => {
  it('draws the engine frame as a ground decal at the engine point, opaque and under upright things', () => {
    const library = art();
    const card = objectUnderlayCard({ underlay }, library, false, shown, toCamera)!;
    expect(card.frame.rect).toEqual([470, 0, 8, 6]);
    expect(card).toMatchObject({ draw: 'flat', pass: 'ground', alpha: 1, push: 0, palette: 'fx:anim', glow: false });
    expect(card.hd).toBeUndefined();
    // The layer lifts a decal EFFECT_DECAL_LIFT above its anchor. That point is the engine's ground point moved straight
    // towards the camera: the canvas centre stays on the engine's pixel (no art offset of its own, no lift shift) and
    // only its depth comes forward.
    const drawn = card.anchor.clone().setY(card.anchor.y + EFFECT_DECAL_LIFT);
    const ground = engineAnchor(underlay.x, underlay.y, underlay.z);
    const moved = drawn.clone().sub(ground);
    expect(moved.clone().cross(toCamera).length()).toBeLessThan(1e-9);
    expect(moved.dot(toCamera)).toBeCloseTo(UNDERLAY_DEPTH_PULL, 9);
    expect(card.depth).toBeCloseTo(((underlay.x + underlay.y) * 15) / 256 - (underlay.z / 104) * 15, 9);
    expect(library.asked).toEqual(['SPARKS']);
  });

  it('lies in front of unit shadow planes and ordinary decals, and behind a unit body above its two lowest rows', () => {
    // At the same screen pixel a horizontal plane lifted h above the ground is h / sin(30 degrees) nearer than the ground.
    const nearness = (lift: number) => lift / Math.sin(Math.PI / 6);
    const highestShadow = nearness(SHADOW_LIFT + Math.max(...SHADOW_COPIES.map((copy) => copy.lift)));
    // Shadow planes are written at the nearest depth inside a pixel: clear them by a pixel of ground slope at 2x.
    expect(UNDERLAY_DEPTH_PULL).toBeGreaterThan(highestShadow + GROUND_DEPTH / 2);
    expect(UNDERLAY_DEPTH_PULL).toBeGreaterThan(nearness(EFFECT_DECAL_LIFT));
    expect(UNDERLAY_DEPTH_PULL).toBeGreaterThan(CARD_CLEARANCE);
    // A unit's body is drawn with the depth of a card standing on its lowest bitmap row (nativeDepth.ts; a voxel body
    // keeps 1 - VOXEL_CARD_KAPPA of it and is physically in front of the ground behind each of its pixels). From three
    // rows above that row the body is in front of the underlay; the two rows under it are where the card meets the ground.
    const bottom = 13;
    const bodyOverGround = (rowsUp: number) =>
      (1 - VOXEL_CARD_KAPPA) * (nativeCardPush(bottom - rowsUp, bottom) - (bottom - rowsUp) * GROUND_DEPTH);
    for (let rowsUp = 3; rowsUp <= 40; rowsUp++) expect(bodyOverGround(rowsUp)).toBeGreaterThan(UNDERLAY_DEPTH_PULL);
    expect(bodyOverGround(2)).toBeLessThan(UNDERLAY_DEPTH_PULL);
  });

  it('draws nothing without an underlay, for a hidden owner or point, an empty or missing frame, or unknown art', () => {
    const library = art();
    expect(objectUnderlayCard({}, library, false, shown, toCamera)).toBeNull();
    expect(library.asked).toEqual([]);
    expect(objectUnderlayCard({ underlay, nativeHidden: true }, library, false, shown, toCamera)).toBeNull();
    expect(objectUnderlayCard({ underlay }, library, false, () => true, toCamera)).toBeNull();
    expect(objectUnderlayCard({ underlay: { ...underlay, frame: 44 } }, library, false, shown, toCamera)).toBeNull();
    expect(objectUnderlayCard({ underlay: { ...underlay, frame: 120 } }, library, false, shown, toCamera)).toBeNull();
    expect(objectUnderlayCard({ underlay: { ...underlay, art: 'OTHER' } }, library, false, shown, toCamera)).toBeNull();
  });

  it('uses a redrawn frame only in the HD style, holds it for the stage and falls back to the native frame', () => {
    const hdFrames = Array.from({ length: 120 }, (_, i) =>
      i === 48
        ? null
        : { page: 2, rect: [i, 0, 16, 12] as [number, number, number, number], offset: [-20, -10] as [number, number] },
    );
    const hd: EffectHdAnim = { scale: 2, frames: hdFrames };
    const faithful = objectUnderlayCard({ underlay }, art({ hd }), false, shown, toCamera)!;
    expect(faithful.hd).toBeUndefined();
    const enhanced = objectUnderlayCard({ underlay }, art({ hd }), true, shown, toCamera)!;
    expect(enhanced.hd).toMatchObject({ frame: hdFrames[47], next: null, scale: 2, blend0: 0 });
    expect(enhanced).toMatchObject({ draw: 'flat', pass: 'ground', alpha: 1 });
    // The page is still loading: the HD instance waits on it (the layer skips it until then).
    expect(objectUnderlayCard({ underlay }, art({ hd, hdPage: 'loading' }), true, shown, toCamera)!.hd).toBeDefined();
    // A failed page or a frame the redraw does not hold keeps the native pixels.
    expect(objectUnderlayCard({ underlay }, art({ hd, hdPage: 'failed' }), true, shown, toCamera)!.hd).toBeUndefined();
    expect(
      objectUnderlayCard({ underlay: { ...underlay, frame: 48 } }, art({ hd }), true, shown, toCamera)!.hd,
    ).toBeUndefined();
    expect(objectUnderlayCard({ underlay }, art(), true, shown, toCamera)!.hd).toBeUndefined();
  });
});
