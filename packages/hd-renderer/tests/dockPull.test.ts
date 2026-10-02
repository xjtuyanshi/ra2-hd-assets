import { describe, expect, it } from 'vitest';
import { bucketDockBuildings, DOCK_PULL, dockPull } from '../src/ra2/dockPull';
import { painterObject, type PainterObject } from '../src/ra2/painterOrder';

const building = (index?: number): PainterObject => ({
  ...painterObject(2, 100, index),
  x: 10,
  z: 20,
  foundation: [4, 3],
});
const unit = (x = 14, z = 21, index?: number): PainterObject => ({ ...painterObject(2, 200, index), x, z });

describe('bounded voxel dock pull', () => {
  it.each([
    ['east front band', 14, 21],
    ['south front band', 12, 23],
    ['front corner', 14, 23],
    ['foundation centre pad', 12, 21],
  ] as const)('pulls a later unit on the %s', (_, x, z) => {
    expect(dockPull(unit(x, z), [building()])).toBe(DOCK_PULL);
  });

  it('does not pull a unit with an earlier fallback ySort', () => {
    expect(dockPull({ ...unit(), ySort: 50 }, [building()])).toBe(0);
  });

  it('uses registered order even when ySort implies the reverse', () => {
    const b = building(2);
    expect(dockPull(unit(14, 21, 1), [b])).toBe(0);
    expect(dockPull({ ...unit(14, 21, 3), ySort: 50 }, [b])).toBe(DOCK_PULL);
    expect(dockPull(unit(14, 21, 2), [b])).toBe(0);
  });

  it.each([
    ['two cells east', 15, 21],
    ['two cells south', 12, 24],
    ['north', 12, 19],
    ['west', 9, 21],
    ['northeast', 14, 19],
    ['southwest', 9, 23],
  ] as const)('does not pull a later unit %s of the foundation', (_, x, z) => {
    expect(dockPull(unit(x, z), [building()])).toBe(0);
  });

  it('applies the pull once across several qualifying buildings', () => {
    const buildings = [building(), { ...building(), x: 11 }, { ...building(), z: 21 }];
    expect(dockPull(unit(), buildings)).toBe(DOCK_PULL);
    expect(DOCK_PULL).toBe(1);
    expect(DOCK_PULL).toBeLessThanOrEqual(1.5);
  });

  it.each([0, 1, 3, 4])('does not pull a unit in layer %s', (layer) => {
    expect(dockPull({ ...unit(), layer }, [building()])).toBe(0);
  });

  it('ignores different-layer buildings and building-owned voxel painters', () => {
    expect(dockPull(unit(), [{ ...building(), layer: 3 }])).toBe(0);
    expect(dockPull({ ...unit(), foundation: [1, 1] }, [building()])).toBe(0);
  });

  it('ignores absent and empty foundations', () => {
    for (const foundation of [undefined, [0, 3], [4, 0]] as const)
      expect(dockPull(unit(), [{ ...building(), foundation }])).toBe(0);
    expect(dockPull(unit())).toBe(0);
  });

  it('buckets the expanded NW rectangle without scanning distant or ineligible buildings', () => {
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
    expect(cells.get(14)?.get(23)).toEqual([b, other]);
    expect(cells.get(10)?.get(19)).toBeUndefined();
    expect(cells.get(9)).toBeUndefined();
    expect(cells.get(14)?.get(24)).toBeUndefined();
    expect(cells.get(16)).toBeUndefined();
    expect(dockPull(unit(), cells.get(14)?.get(21))).toBe(DOCK_PULL);
    expect(dockPull(unit(16, 21), cells.get(16)?.get(21))).toBe(0);
  });
});
