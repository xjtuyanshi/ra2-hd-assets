import { describe, expect, it } from 'vitest';
import { depleteOre, growthGrid, mapOverlayGrid, polylinePosition } from '../sandbox/oreBench';

describe('ore bench polyline', () => {
  it('uses arc length, skips repeated vertices, turns at corners and holds the endpoint', () => {
    const path = [
      [10, 10],
      [10, 10],
      [13, 10],
      [13, 14],
    ] as const;
    expect(polylinePosition(path, 1, 2)).toEqual({ x: 12, y: 10, facingRaw: 16384, moving: true });
    expect(polylinePosition(path, 1.5, 2)).toEqual({ x: 13, y: 10, facingRaw: 32768, moving: true });
    expect(polylinePosition(path, 3.5, 2)).toEqual({ x: 13, y: 14, facingRaw: 32768, moving: false });
    expect(polylinePosition(path, 100, 2)).toEqual(polylinePosition(path, 3.5, 2));
    expect(
      polylinePosition(
        [
          [0, 0],
          [-3, -4],
        ],
        2.5,
        1,
      ),
    ).toMatchObject({ x: -1.5, y: -2, moving: true });
    expect(polylinePosition([[2, 3]], 20, 1)).toMatchObject({ x: 2, y: 3, moving: false });
    expect(polylinePosition(path, 10, 0)).toMatchObject({ x: 10, y: 10, moving: false });
  });
});

describe('ore bench grids', () => {
  it('preserves map overlay types and frames, ignores other objects and clips outside cells', () => {
    const grid = mapOverlayGrid(4, 4, [
      { kind: 'overlay', type: 'TIB01', x: 1, y: 1, z: 0, frame: 11 },
      { kind: 'overlay', type: 'TIB01', x: 2, y: 1, z: 0, frame: 2 },
      { kind: 'overlay', type: 'WALL', x: 3, y: 1, z: 0, frame: 15 },
      { kind: 'smudge', type: 'CRATER', x: 0, y: 0, z: 0 },
      { kind: 'overlay', type: 'OUTSIDE', x: -1, y: 0, z: 0 },
    ]);
    expect(grid.types).toEqual(['TIB01', 'WALL']);
    expect([...grid.index.slice(4, 8)]).toEqual([-1, 0, 0, 1]);
    expect([...grid.data.slice(4, 8)]).toEqual([0, 11, 2, 15]);
    expect(grid.index[0]).toBe(-1);
  });

  it('builds growth rows and non-overlapping dense blocks, clipping at the map edge', () => {
    const grid = growthGrid(40, 12, ['TIB01', 'GEM01'], 1, 2, 2, 3);
    for (let row = 0; row < 2; row++) {
      for (let frame = 0; frame < 12; frame++) {
        const slot = (2 + row * 2) * 40 + 1 + frame * 2;
        expect(grid.index[slot]).toBe(row);
        expect(grid.data[slot]).toBe(frame);
      }
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++) {
          const slot = (2 + row * 2 + dy) * 40 + 25 + row * 5 + dx;
          expect(grid.index[slot]).toBe(row);
          expect(grid.data[slot]).toBe(11);
        }
    }
    expect([...grid.index].filter((i) => i >= 0)).toHaveLength(42);
    expect([...growthGrid(3, 3, ['TIB01'], 2, 2).index].filter((i) => i >= 0)).toHaveLength(1);
    expect(() => growthGrid(3, 3, [], 0, 0, 0)).toThrow();
  });

  it('depletes only tiberium within Chebyshev radius 1, removes zero frames and revises only changes', () => {
    const grid = mapOverlayGrid(5, 5, [
      { kind: 'overlay', type: 'TIB01', x: 0, y: 0, z: 0, frame: 1 },
      { kind: 'overlay', type: 'GEM01', x: 2, y: 2, z: 0, frame: 0 },
      { kind: 'overlay', type: 'WALL', x: 1, y: 1, z: 0, frame: 11 },
      { kind: 'overlay', type: 'TIB01', x: 3, y: 1, z: 0, frame: 8 },
    ]);
    const resources = new Set(['TIB01', 'GEM01']);
    grid.originX = 10;
    grid.originY = 20;
    expect(depleteOre(grid, 11.9, 21.2, resources)).toBe(true);
    expect(grid.data[0]).toBe(0);
    expect(grid.index[0]).toBe(0);
    expect(grid.index[12]).toBe(-1);
    expect(grid.data[12]).toBe(0);
    expect(grid.data[6]).toBe(11);
    expect(grid.data[8]).toBe(8);
    expect(grid.revision).toBe(2);
    depleteOre(grid, 10, 20, resources);
    expect(grid.index[0]).toBe(-1);
    expect(grid.revision).toBe(3);
    expect(depleteOre(grid, 10, 20, resources)).toBe(false);
    expect(depleteOre(grid, -10, -10, resources)).toBe(false);
    expect(grid.revision).toBe(3);
  });
});
