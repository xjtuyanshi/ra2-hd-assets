/** Tile-slot resolution and clear-tile substitution (synthetic theater INIs; no game files). */
import { describe, expect, it } from 'vitest';
import { parseIni } from 'ra2-formats';
import {
  CLEAR_TILE_SENTINEL,
  THEATERS,
  buildTileTable,
  clearSubTile,
  resolveCellTile,
  theaterFromMap,
  type TemplateShape,
} from '../src/theater.ts';

const THEATER_INI = `
[General]
ClearTile=2

[TileSet0000]
SetName=Blank
FileName=blank
TilesInSet=0

[TileSet0001]
SetName=Cliffs
FileName=cliff
TilesInSet=3

[TileSet0002]
SetName=Clear
FileName=clear
TilesInSet=1

[TileSet0003]
SetName=Water
FileName=water
TilesInSet=2

; TileSet0004 is missing: the engine stops here, so 0005 must be ignored.
[TileSet0005]
SetName=Unreachable
FileName=ghost
TilesInSet=5
`;

const shape = (bx: number, by: number, empty: number[] = []): TemplateShape => ({
  blocksX: bx,
  blocksY: by,
  isEmpty: (i) => empty.includes(i),
});

describe('buildTileTable', () => {
  const table = buildTileTable(parseIni(THEATER_INI), 'tem');

  it('numbers templates sequentially across sets and stops at the first missing set', () => {
    expect(table.sets.map((s) => [s.index, s.start, s.count])).toEqual([
      [0, 0, 0],
      [1, 0, 3],
      [2, 3, 1],
      [3, 4, 2],
    ]);
    expect(table.slots.map((s) => s.file)).toEqual([
      'cliff01.tem',
      'cliff02.tem',
      'cliff03.tem',
      'clear01.tem',
      'water01.tem',
      'water02.tem',
    ]);
    expect(table.slots.every((s, i) => s.tileNum === i)).toBe(true);
  });

  it('resolves [General] ClearTile (a set number) to the first global tile of that set', () => {
    expect(table.clearTileNum).toBe(3);
  });

  it('uses the theater extension table', () => {
    expect(THEATERS.urban.ext).toBe('urb');
    expect(theaterFromMap('TEMPERATE')).toBe('temperate');
    expect(theaterFromMap('NEWURBAN')).toBe('newurban');
    expect(theaterFromMap('mars')).toBeUndefined();
  });
});

describe('clear-tile substitution', () => {
  const table = buildTileTable(parseIni(THEATER_INI), 'tem');
  const shapes = new Map<number, TemplateShape>([
    [0, shape(2, 1)],
    [1, shape(1, 1)],
    [3, shape(2, 2, [3])],
    [4, shape(1, 1)],
  ]);
  const shapeOf = (n: number): TemplateShape | undefined => shapes.get(n);

  it('replaces the 0xffff sentinel with the clear template, choosing the sub-tile by cell position', () => {
    const at = (x: number, y: number) =>
      resolveCellTile({ x, y, tileNum: CLEAR_TILE_SENTINEL, subTile: 0 }, table, shapeOf);
    expect(at(10, 20)).toEqual({ tileNum: 3, subTile: 0, substituted: true });
    expect(at(11, 20)).toEqual({ tileNum: 3, subTile: 1, substituted: true });
    expect(at(10, 21)).toEqual({ tileNum: 3, subTile: 2, substituted: true });
    // Slot 3 of the 2x2 clear pattern is empty, so the engine-safe fallback is slot 0.
    expect(at(11, 21)).toEqual({ tileNum: 3, subTile: 0, substituted: true });
  });

  it('treats out-of-range tile numbers, missing templates and empty sub-tiles as clear ground', () => {
    expect(resolveCellTile({ x: 0, y: 0, tileNum: 999, subTile: 0 }, table, shapeOf)?.substituted).toBe(true);
    expect(resolveCellTile({ x: 0, y: 0, tileNum: 2, subTile: 0 }, table, shapeOf)?.tileNum).toBe(3);
    expect(resolveCellTile({ x: 0, y: 0, tileNum: 0, subTile: 5 }, table, shapeOf)?.tileNum).toBe(3);
  });

  it('keeps a valid explicit tile and sub-tile', () => {
    expect(resolveCellTile({ x: 5, y: 6, tileNum: 0, subTile: 1 }, table, shapeOf)).toEqual({
      tileNum: 0,
      subTile: 1,
      substituted: false,
    });
  });

  it('returns undefined only when even the clear template is unavailable', () => {
    expect(
      resolveCellTile({ x: 0, y: 0, tileNum: CLEAR_TILE_SENTINEL, subTile: 0 }, table, () => undefined),
    ).toBeUndefined();
  });

  it('wraps negative coordinates into the pattern', () => {
    expect(clearSubTile(-1, -1, shape(2, 2))).toBe(3);
    expect(clearSubTile(7, 3, shape(1, 1))).toBe(0);
  });
});
