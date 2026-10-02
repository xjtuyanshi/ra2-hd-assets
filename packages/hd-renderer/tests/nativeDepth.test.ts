import { describe, expect, it } from 'vitest';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import {
  GROUND_DEPTH,
  VERTICAL_DEPTH,
  addRefineryFoundation,
  attachedBodyDepth,
  bodyTemplateOrigin,
  bodyTemplatePush,
  buildingDepthProfile,
  cardPushRows,
  frameInclusiveBottom,
  groundPush,
  harvesterRefineryBonus,
  nativeCardPush,
  signedDepthSample,
  transformRawDepthSample,
} from '../src/ra2/nativeDepth';

const dimensions = { width: 396, height: 477 };
const frame = (bottom: number): SpriteFrame => ({ rect: [0, 0, 200, bottom + 151], offset: [-100, -150] });

/** Synthetic box ridge only: one signed depth unit per three rows/columns, with a flat apron outside it. */
function ridge(): Uint8Array {
  const bytes = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < dimensions.height; y++)
    for (let x = 0; x < dimensions.width; x++)
      bytes[y * dimensions.width + x] = Math.max(0, Math.floor((476 - y) / 3) - Math.floor(Math.abs(x - 198) / 3));
  return bytes;
}

describe('original building depth equations', () => {
  it('maps foundation size and point moves, skips moves for construction/selling, and only rejects width eight', () => {
    expect(bodyTemplateOrigin(4, 3, [30, 15])).toEqual([198, 386]);
    expect(bodyTemplateOrigin(5, 3, [30, 15])).toEqual([168, 371]);
    expect(bodyTemplateOrigin(4, 3)).toEqual([168, 371]);
    for (const state of ['building', 'selling']) expect(bodyTemplateOrigin(4, 3, [30, 15], state)).toEqual([168, 371]);
    expect(bodyTemplateOrigin(8, 1)).toBeUndefined();
    expect(bodyTemplateOrigin(2, 8)).toEqual([378, 326]);
    expect(VERTICAL_DEPTH).toBe(GROUND_DEPTH / 3);
  });

  it('distinguishes already-transformed int8 library bytes from raw BUILDNGZ palette indices', () => {
    expect([0, 32, 65, 192, 193, 222].map(transformRawDepthSample)).toEqual([0, -33, 0, 127, -128, -99]);
    expect([0, 65, 127, 128, 223, 255].map(signedDepthSample)).toEqual([0, 65, 127, -128, -33, -1]);
  });

  it('uses the clipped inclusive frame bottom and normal adjustment, with explicit delivery substitutions', () => {
    const shape = { pointMove: [30, 15] as const, normalZAdjust: 7 };
    expect(frameInclusiveBottom(frame(120))).toBe(120);
    expect(buildingDepthProfile(frame(120), [4, 3], shape, undefined, undefined, dimensions)).toEqual({
      mode: 'body',
      origin: [198, 386],
      base: 84,
    });
    expect(buildingDepthProfile(frame(120), [4, 3], shape, undefined, 'door', dimensions)).toMatchObject({ base: 111 });
    expect(buildingDepthProfile(frame(120), [4, 3], shape, undefined, 'roof', dimensions)).toMatchObject({ base: 131 });
    expect(buildingDepthProfile(frame(120), [8, 3], shape, undefined, undefined, dimensions)).toEqual({
      mode: 'card',
      bottom: 120,
      bonus: -6,
    });
    expect(buildingDepthProfile(frame(120), [4, 3], shape, undefined, undefined, undefined)).toBeUndefined();
  });

  it('matches the constant body baseline plus signed samples, including zero and clamped HD fringe pixels', () => {
    const bytes = new Uint8Array([0, 127, 128, 255, 223, 3]);
    for (const [px, py, sample] of [
      [-0.1, -0.1, 0],
      [0.9, 0.9, -33],
      [20, 20, 3],
      [-20, -20, 0],
    ]) {
      expect(bodyTemplatePush(bytes, 3, 2, [1, 1], 42, px!, py!)).toBe((42 + sample!) * GROUND_DEPTH);
    }
    // No independent screen-row ramp appears in a shape-backed draw.
    expect(bodyTemplatePush(new Uint8Array(12), 3, 4, [1, 1], 42, 0, 0)).toBe(
      bodyTemplatePush(new Uint8Array(12), 3, 4, [1, 1], 42, 0, 2),
    );
  });

  it('keeps shifted attached art on the owner body profile after cancelling physical anchor travel', () => {
    const body = buildingDepthProfile(frame(90), [4, 3], { pointMove: [30, 15] }, undefined, undefined, dimensions)!;
    expect(body.mode).toBe('body');
    if (body.mode !== 'body') throw new Error('Expected body fixture');
    const layer = attachedBodyDepth(body, [12, 9], 9 * GROUND_DEPTH);
    expect(layer).toMatchObject({ mode: 'body', base: 91, offset: [12, 9], anchorPush: 9 * GROUND_DEPTH });
    const bytes = ridge();
    const ownerPush = bodyTemplatePush(bytes, dimensions.width, dimensions.height, body.origin, body.base, 30, 40);
    const shiftedPush =
      bodyTemplatePush(bytes, dimensions.width, dimensions.height, body.origin, body.base, 18 + 12, 31 + 9) -
      layer.anchorPush!;
    expect(shiftedPush + layer.anchorPush!).toBeCloseTo(ownerPush, 12);
  });
});

describe('ground planes and test-only bitmap cards', () => {
  it.each([1, 2, 6])('uses the native gradient-zero plane constant %i', (bonus) => {
    for (const py of [-30.5, 0, 40]) expect(groundPush(py, bonus)).toBe((py + bonus) * GROUND_DEPTH);
  });

  it('uses inclusive bitmap bottom, bonus and floor, including pixels below that bottom', () => {
    expect(cardPushRows(0, 4, 13)).toBe(18);
    expect(cardPushRows(1, 4, 13)).toBe(18);
    expect(cardPushRows(1.1, 4, 13)).toBe(17);
    expect(cardPushRows(4.1, 4, 13)).toBe(16);
    expect(nativeCardPush(-5, 4, 12)).toBe(19 * GROUND_DEPTH);
  });

  it('grants harvester depth only in a current refinery foundation cell', () => {
    const cells = new Set<string>();
    addRefineryFoundation(cells, true, 51, 101, [4, 3]);
    addRefineryFoundation(cells, false, 70, 80, [5, 3]);
    expect(cells.size).toBe(12);
    expect(harvesterRefineryBonus(true, 13952, 26240, cells)).toBe(13);
    expect(harvesterRefineryBonus(true, 55 * 256, 102 * 256, cells)).toBe(0);
    expect(harvesterRefineryBonus(true, 54 * 256, 104 * 256, cells)).toBe(0);
    expect(harvesterRefineryBonus(false, 13952, 26240, cells)).toBe(0);
    expect(harvesterRefineryBonus(true, 70 * 256, 80 * 256, cells)).toBe(0);
  });
});

describe('synthetic native overlap scenes (not original-art pixel acceptance)', () => {
  const bytes = ridge();
  const bodyPush = (foundation: readonly [number, number], bottom: number, px: number, py: number, door = false) => {
    const profile = buildingDepthProfile(
      frame(bottom),
      foundation,
      { pointMove: foundation[0] === 2 ? [0, 0] : [30, 15] },
      undefined,
      door ? 'door' : undefined,
      dimensions,
    )!;
    if (profile.mode !== 'body') throw new Error('Expected template fixture');
    return bodyTemplatePush(bytes, dimensions.width, dimensions.height, profile.origin, profile.base, px, py);
  };

  it('lets the dock harvester beat the apron with c13, loses without it, and hides a unit behind the body', () => {
    for (const px of [-4, 0, 4])
      for (const py of [-2, 0, 2]) {
        const body = bodyPush([4, 3], 90, 60 + px, 75 + py);
        const anchor = 75 * GROUND_DEPTH;
        expect(anchor + nativeCardPush(py, 4, 13)).toBeGreaterThan(body);
        expect(anchor + nativeCardPush(py, 4, 0)).toBeLessThan(body);
      }
    expect(-15 * GROUND_DEPTH + nativeCardPush(0, 4, 0)).toBeLessThan(bodyPush([4, 3], 90, 0, -15));
  });

  it('puts a unit inside the war factory ahead of UnderDoor but behind deploying body posts', () => {
    const unit = 60 * GROUND_DEPTH + nativeCardPush(0, 3);
    expect(unit).toBeGreaterThan(groundPush(60, 1));
    expect(unit).toBeLessThan(bodyPush([5, 3], 90, 30, 60, true));
  });

  it('hides centre-spawn infantry and reveals its card on front stairs outside the box', () => {
    const center = 30 * GROUND_DEPTH + nativeCardPush(0, 3, 12);
    expect(center).toBeLessThan(bodyPush([2, 2], 60, 0, 30));
    const stairs = 72 * GROUND_DEPTH + nativeCardPush(0, 3, 12);
    expect(stairs).toBeGreaterThan(bodyPush([2, 2], 60, 12, 72));
  });
});
