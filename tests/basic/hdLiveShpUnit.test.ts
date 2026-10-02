/** HD live view: SHP vehicle frame layouts (terror drone, giant squid, dolphin) and their state/step choice. */
import { describe, expect, it } from 'vitest';
import { facingFrame } from '../../packages/ra2-assets/src/art';
import {
  shpUnitBlocks,
  shpUnitFrame,
  shpUnitPose,
  shpVehicleDirection,
} from '../../packages/hd-renderer/src/live/shpUnits';

// Type library records as extracted from YR 1.001's artmd.ini.
const DRON = { facings: 8, frames: { WalkFrames: 6, FiringFrames: 4 } };
const SQD = { facings: 8, frames: { WalkFrames: 20, FiringFrames: 16 } };

describe('shpUnitFrame', () => {
  it('lays the terror drone out as walk 0-47, stand 48-55, fire 56-87', () => {
    const b = shpUnitBlocks(DRON);
    expect(b.walk).toEqual({ start: 0, count: 6 });
    expect(b.stand).toEqual({ start: 48, count: 1 });
    expect(b.fire).toEqual({ start: 56, count: 4 });
    expect(shpUnitFrame(DRON, 0, 'stand', 0)).toBe(48 + shpVehicleDirection(0, 8));
    for (let f = 0; f < 256; f += 32) {
      expect(shpUnitFrame(DRON, f, 'stand', 99)).toBe(48 + shpVehicleDirection(f, 8));
      expect(shpUnitFrame(DRON, f, 'walk', 7)).toBe(6 * shpVehicleDirection(f, 8) + 1);
      expect(shpUnitFrame(DRON, f, 'fire', 2)).toBe(56 + 4 * shpVehicleDirection(f, 8) + 2);
    }
  });

  it('keeps every frame inside the SHP body (88 frames for the drone)', () => {
    for (let f = 0; f < 256; f++)
      for (const state of ['stand', 'walk', 'fire'] as const)
        for (let step = 0; step < 12; step++) {
          const frame = shpUnitFrame(DRON, f, state, step);
          expect(frame).toBeGreaterThanOrEqual(0);
          expect(frame).toBeLessThan(88);
        }
  });

  it('honours explicit start keys and falls back to standing when a state has no frames', () => {
    const custom = { facings: 8, frames: { StartStandFrame: 10, StandingFrames: 2, WalkFrames: 0 } };
    expect(shpUnitFrame(custom, 64, 'stand', 3)).toBe(10 + 2 * shpVehicleDirection(64, 8) + 1);
    // No walk or fire frames: both stand.
    expect(shpUnitFrame(custom, 64, 'walk', 3)).toBe(shpUnitFrame(custom, 64, 'stand', 3));
    expect(shpUnitFrame(custom, 64, 'fire', 3)).toBe(shpUnitFrame(custom, 64, 'stand', 3));
  });
});

describe('shpVehicleDirection', () => {
  it('runs clockwise from screen-up, as the engine drew live terror drones', () => {
    // Frame-matched on frozen live pairs: facing 0 (map north) -> direction 1, facings 32 and 40 -> direction 2.
    expect(shpVehicleDirection(0, 8)).toBe(1);
    expect(shpVehicleDirection(32, 8)).toBe(2);
    expect(shpVehicleDirection(40, 8)).toBe(2);
    expect([0, 32, 64, 96, 128, 160, 192, 224].map((f) => shpVehicleDirection(f, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    // The mirror of the infantry order.
    for (let f = 0; f < 256; f += 8) expect(shpVehicleDirection(f, 8)).toBe((8 - facingFrame(f, 8)) % 8);
  });
});

describe('shpUnitPose', () => {
  it('walks while moving, on WalkRate steps, and stands still otherwise', () => {
    expect(shpUnitPose(DRON, undefined, 100, true, null)).toEqual({ state: 'walk', step: 100 });
    expect(shpUnitPose(DRON, { walkRate: 2 }, 101, true, null)).toEqual({ state: 'walk', step: 50 });
    expect(shpUnitPose(DRON, undefined, 100, false, null)).toEqual({ state: 'stand', step: 0 });
  });

  it('keeps swimming animals animating on IdleRate while they stand', () => {
    expect(shpUnitPose(SQD, { walkRate: 2, idleRate: 4 }, 40, false, null)).toEqual({ state: 'walk', step: 10 });
  });

  it('plays the firing frames for a fresh shot only', () => {
    expect(shpUnitPose(DRON, undefined, 102, true, 100)).toEqual({ state: 'fire', step: 2 });
    expect(shpUnitPose(DRON, undefined, 104, true, 100)).toEqual({ state: 'walk', step: 104 });
  });
});
