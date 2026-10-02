import { describe, expect, it } from 'vitest';
import { foundationPointPush } from '../src/ra2/cardDepth';
import {
  bucketDockBuildings,
  DOCK_PULL_MARGIN,
  DOCK_PULL_MAX,
  DOCK_SETTLE_FRAMES,
  dockPull,
} from '../src/ra2/dockPull';
import { painterObject, type PainterObject } from '../src/ra2/painterOrder';

const building = (index?: number): PainterObject => ({
  ...painterObject(2, 100, index),
  x: 10,
  z: 20,
  foundation: [4, 3],
});
const unit = (x = 13, z = 21, index?: number): PainterObject => ({ ...painterObject(2, 200, index), x, z });
const anchor = (u: PainterObject) => ({ x: u.x + 0.5, z: u.z + 0.5 });
const settledPull = (u: PainterObject, buildings?: readonly PainterObject[]) =>
  dockPull(u, anchor(u), DOCK_SETTLE_FRAMES, buildings);

describe('bounded voxel dock pull', () => {
  it('matches the measured War Miner footprint at the Soviet refinery with exact lepton coordinates', () => {
    const refinery = { ...building(), x: 51, z: 101 };
    const exact = { x: 13952 / 256, z: 26240 / 256 };
    const miner = unit(Math.floor(exact.x), Math.floor(exact.z));
    const samplePushes = (
      [
        [0, 0],
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const
    ).map(([dx, dz]) => foundationPointPush(exact.x + dx - refinery.x, exact.z + dz - refinery.z, 4, 3));
    const pull = dockPull(miner, exact, DOCK_SETTLE_FRAMES, [refinery]);
    expect(Math.abs(pull - (Math.max(...samplePushes) + 0.5))).toBeLessThan(0.05);
    expect(pull).toBeCloseTo(3.00949, 5);
    expect(DOCK_PULL_MARGIN).toBe(0.5);
  });

  it('uses subcell anchors without changing floored painter coordinates', () => {
    const u = unit();
    const west = dockPull(u, { x: 13.25, z: 21.5 }, DOCK_SETTLE_FRAMES, [building()]);
    const east = dockPull(u, { x: 13.75, z: 21.5 }, DOCK_SETTLE_FRAMES, [building()]);
    expect(west).toBeGreaterThan(east);
    expect(u).toMatchObject({ x: 13, z: 21 });
  });

  it.each([0, 1, 5])('does not pull a unit stationary for only %s logic frames', (stationaryFrames) => {
    const u = unit();
    expect(dockPull(u, anchor(u), stationaryFrames, [building()])).toBe(0);
  });

  it.each([6, 7, 100])('pulls a unit stationary for %s logic frames', (stationaryFrames) => {
    const u = unit();
    expect(dockPull(u, anchor(u), stationaryFrames, [building()])).toBeCloseTo(3.00949, 5);
    expect(DOCK_SETTLE_FRAMES).toBe(6);
  });

  it('does not pull a unit with an earlier fallback ySort', () => {
    expect(settledPull({ ...unit(), ySort: 50 }, [building()])).toBe(0);
  });

  it('uses registered order even when ySort implies the reverse', () => {
    const b = building(2);
    expect(settledPull(unit(13, 21, 1), [b])).toBe(0);
    expect(settledPull({ ...unit(13, 21, 3), ySort: 50 }, [b])).toBeGreaterThan(0);
    expect(settledPull(unit(13, 21, 2), [b])).toBe(0);
  });

  it.each([
    ['east boundary', 14, 21],
    ['south boundary', 12, 23],
    ['front corner', 14, 23],
    ['two cells east', 15, 21],
    ['two cells south', 12, 24],
    ['north', 12, 19],
    ['west', 9, 21],
    ['northeast', 14, 19],
    ['southwest', 9, 23],
  ] as const)('does not pull a later unit outside the foundation at the %s', (_, x, z) => {
    expect(settledPull(unit(x, z), [building()])).toBe(0);
  });

  it('includes the northwest boundary of the foundation', () => {
    const u = unit(10, 20);
    expect(dockPull(u, { x: 10, z: 20 }, DOCK_SETTLE_FRAMES, [building()])).toBeGreaterThan(0);
  });

  it('caps a tall facade footprint at 3.5 camera-space world units', () => {
    expect(foundationPointPush(0.5, 0.5, 4, 3) + DOCK_PULL_MARGIN).toBeGreaterThan(DOCK_PULL_MAX);
    expect(settledPull(unit(10, 20), [building()])).toBe(3.5);
    expect(DOCK_PULL_MAX).toBe(3.5);
  });

  it('takes the largest qualifying building pull, never a sum or just the first', () => {
    const u = unit();
    const lower = { ...building(), foundation: [4, 2] as const };
    const higher = building();
    const lowerPull = settledPull(u, [lower]);
    const higherPull = settledPull(u, [higher]);
    expect(lowerPull).toBeGreaterThan(0);
    expect(higherPull).toBeGreaterThan(lowerPull);
    expect(lowerPull + higherPull).toBeGreaterThan(DOCK_PULL_MAX);
    expect(settledPull(u, [lower, higher])).toBe(higherPull);
    expect(settledPull(u, [higher, lower])).toBe(higherPull);
    expect(settledPull(u, [higher, higher])).toBe(higherPull);
  });

  it.each([0, 1, 3, 4])('does not pull a unit in layer %s', (layer) => {
    expect(settledPull({ ...unit(), layer }, [building()])).toBe(0);
  });

  it('ignores different-layer buildings and building-owned voxel painters', () => {
    expect(settledPull(unit(), [{ ...building(), layer: 3 }])).toBe(0);
    expect(settledPull({ ...unit(), foundation: [1, 1] }, [building()])).toBe(0);
  });

  it('ignores absent and empty foundations', () => {
    for (const foundation of [undefined, [0, 3], [4, 0]] as const)
      expect(settledPull(unit(), [{ ...building(), foundation }])).toBe(0);
    expect(settledPull(unit())).toBe(0);
  });

  it('buckets only the NW foundation rectangle without scanning distant or ineligible buildings', () => {
    const b = building();
    const other = { ...building(), x: 11 };
    const far = { ...building(), x: 100, z: 200 };
    const cells = bucketDockBuildings([
      b,
      other,
      far,
      { ...building(), layer: 3 },
      { ...building(), foundation: undefined },
      { ...building(), foundation: [0, 3] },
    ]);
    expect(cells.get(10)?.get(20)).toEqual([b]);
    expect(cells.get(13)?.get(22)).toEqual([b, other]);
    expect(cells.get(14)?.get(21)).toEqual([other]);
    expect(cells.get(13)?.get(23)).toBeUndefined();
    expect(cells.get(10)?.get(19)).toBeUndefined();
    expect(cells.get(9)).toBeUndefined();
    expect(cells.get(15)).toBeUndefined();
    expect(settledPull(unit(), cells.get(13)?.get(21))).toBe(settledPull(unit(), [b, other]));
    expect(settledPull(unit(15, 21), cells.get(15)?.get(21))).toBe(0);
  });
});
