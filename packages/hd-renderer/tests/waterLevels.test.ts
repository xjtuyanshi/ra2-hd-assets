import { describe, expect, it } from 'vitest';
import { groupWaterCells, selectWaterMirrorLevels, type WaterCell } from '../src/ra2/waterLevels';

const cellsAt = (level: number, count: number): WaterCell[] =>
  Array.from({ length: count }, (_, x) => ({ level, x, y: level }));

describe('water levels and mirror selection', () => {
  it('groups disconnected water at the same base level and preserves its complete cell bounds', () => {
    const cells = Object.freeze(
      [
        { level: 4, x: 3, y: 7 },
        { level: 0, x: 9, y: 2 },
        { level: 4, x: -2, y: 1 },
        { level: 0, x: 6, y: 8 },
        { level: 4, x: 20, y: 4 },
      ].map((cell) => Object.freeze(cell)),
    );
    expect(groupWaterCells(cells)).toEqual([
      { level: 4, count: 3, minX: -2, maxX: 20, minY: 1, maxY: 7 },
      { level: 0, count: 2, minX: 6, maxX: 9, minY: 2, maxY: 8 },
    ]);
  });

  it('has no mirror for absent water or fewer than 12 cells at every level', () => {
    expect(groupWaterCells([])).toEqual([]);
    expect(selectWaterMirrorLevels([])).toEqual([]);
    const groups = groupWaterCells([...cellsAt(0, 11), ...cellsAt(4, 11)]);
    expect(groups).toHaveLength(2); // Small levels remain available to the legacy lowest-plane policy.
    expect(selectWaterMirrorLevels(groups)).toEqual([]);
  });

  it('includes exactly 12 cells and selects at most four levels by largest count, not lowest height', () => {
    const groups = groupWaterCells([
      ...cellsAt(0, 11),
      ...cellsAt(1, 12),
      ...cellsAt(2, 20),
      ...cellsAt(3, 30),
      ...cellsAt(4, 40),
      ...cellsAt(5, 50),
    ]);
    expect(selectWaterMirrorLevels(groups.slice(0, 2)).map(({ level }) => level)).toEqual([1]);
    const before = groups.slice();
    // The four largest, returned lowest level first (their render order).
    expect(selectWaterMirrorLevels(Object.freeze(groups)).map(({ level, count }) => [level, count])).toEqual([
      [2, 20],
      [3, 30],
      [4, 40],
      [5, 50],
    ]);
    expect(groups).toEqual(before);
  });

  it('breaks equal-count ties by level so selection is independent of cell traversal order', () => {
    const groups = groupWaterCells([8, 4, 12, 0, 16].flatMap((level) => cellsAt(level, 12)));
    expect(selectWaterMirrorLevels(groups).map(({ level }) => level)).toEqual([0, 4, 8, 12]);
    expect(selectWaterMirrorLevels([...groups].reverse())).toEqual(selectWaterMirrorLevels(groups));
  });

  it('selects all four RiverRam water terraces, lowest first (a higher mirror rendered first blacked out the rest)', () => {
    const groups = groupWaterCells([...cellsAt(0, 477), ...cellsAt(4, 38), ...cellsAt(8, 63), ...cellsAt(12, 665)]);
    expect(selectWaterMirrorLevels(groups).map(({ level, count }) => [level, count])).toEqual([
      [0, 477],
      [4, 38],
      [8, 63],
      [12, 665],
    ]);
  });
});
