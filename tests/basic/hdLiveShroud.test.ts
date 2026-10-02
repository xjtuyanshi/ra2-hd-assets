/** HD live view: shroud corner field and edge opacity. */
import { describe, expect, it } from 'vitest';
import { EDGE_INSET, ShroudLayer, shroudCorners, shroudOpacity } from '../../packages/hd-renderer/src/live/shroud';

const SHROUD = 0;
const FOG = 1;
const VISIBLE = 2;

/** A 4x3 grid from rows of states (0xff outside). */
function grid(rows: number[][]): (x: number, y: number) => number {
  return (x, y) => rows[y]?.[x] ?? 0xff;
}

describe('shroudCorners', () => {
  it('lights a corner only when all four cells around it are mapped / visible', () => {
    const state = grid([
      [VISIBLE, VISIBLE, FOG, SHROUD],
      [VISIBLE, VISIBLE, FOG, SHROUD],
      [VISIBLE, VISIBLE, VISIBLE, SHROUD],
    ]);
    const c = shroudCorners(4, 3, state);
    const at = (i: number, j: number) => [c[(j * 5 + i) * 2], c[(j * 5 + i) * 2 + 1]];
    // Map border corners touch missing cells: dark.
    expect(at(0, 0)).toEqual([0, 0]);
    // Between four visible cells.
    expect(at(1, 1)).toEqual([255, 255]);
    // Between visible and fogged cells: mapped, not visible.
    expect(at(2, 1)).toEqual([255, 0]);
    // Touching a shrouded cell: not mapped.
    expect(at(3, 1)).toEqual([0, 0]);
    expect(at(3, 2)).toEqual([0, 0]);
  });
});

describe('shroudOpacity', () => {
  it('is black under shroud, half under fog, clear when visible', () => {
    expect(shroudOpacity(0, 0)).toBeCloseTo(1, 6);
    expect(shroudOpacity(1, 0)).toBeCloseTo(0.5, 6);
    expect(shroudOpacity(1, 1)).toBeCloseTo(0, 6);
  });

  it('fades across the first revealed cell, black at the shroud and clear at its far side', () => {
    // Along a straight edge the corner field rises linearly by 1 per cell.
    expect(shroudOpacity(0, 1)).toBe(1);
    expect(shroudOpacity(1, 1)).toBeCloseTo(0, 6);
    const mid = shroudOpacity(0.5 + EDGE_INSET, 1);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    // Monotonic in the field.
    let last = 2;
    for (let m = 0; m <= 1.0001; m += 0.05) {
      const o = shroudOpacity(m, 1);
      expect(o).toBeLessThanOrEqual(last + 1e-9);
      last = o;
    }
  });
});

describe('ShroudLayer.update', () => {
  /** The reference definition: a corner is lit when all four cells around it are (missing cells are shrouded). */
  function naive(width: number, height: number, state: (x: number, y: number) => number): Uint8Array {
    const out = new Uint8Array((width + 1) * (height + 1) * 2);
    for (let j = 0; j <= height; j++)
      for (let i = 0; i <= width; i++) {
        const around = [state(i - 1, j - 1), state(i, j - 1), state(i - 1, j), state(i, j)];
        out[(j * (width + 1) + i) * 2] = around.every((c) => c === FOG || c === VISIBLE) ? 255 : 0;
        out[(j * (width + 1) + i) * 2 + 1] = around.every((c) => c === VISIBLE) ? 255 : 0;
      }
    return out;
  }

  it('fills the same corner field as the definition, for a reader box offset inside the map', () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 3;
    const cells = { originX: 3, originY: 2, width: 17, height: 11, cells: new Uint8Array(17 * 11) };
    for (let i = 0; i < cells.cells.length; i++) cells.cells[i] = Math.floor(random());
    const state = (x: number, y: number) => {
      const sx = x - cells.originX;
      const sy = y - cells.originY;
      return sx < 0 || sy < 0 || sx >= cells.width || sy >= cells.height ? 0xff : cells.cells[sy * cells.width + sx]!;
    };
    const layer = new ShroudLayer(24, 16);
    layer.update(cells);
    const data = (layer as unknown as { data: Uint8Array }).data;
    expect([...data]).toEqual([...naive(24, 16, state)]);
    expect([...shroudCorners(24, 16, state)]).toEqual([...naive(24, 16, state)]);
  });

  it('skips an unchanged shroud and applies a changed one', () => {
    const layer = new ShroudLayer(4, 4);
    const texture = (layer as unknown as { texture: { version: number } }).texture;
    const cells = { originX: 0, originY: 0, width: 4, height: 4, cells: new Uint8Array(16).fill(VISIBLE) };
    layer.update(cells);
    const version = texture.version;
    layer.update({ ...cells, cells: cells.cells.slice() });
    expect(texture.version).toBe(version);
    const changed = cells.cells.slice();
    changed[5] = SHROUD;
    layer.update({ ...cells, cells: changed });
    expect(texture.version).toBeGreaterThan(version);
    expect(layer.isLocationShrouded(1 * 256 + 10, 1 * 256 + 10, 0)).toBe(true);
  });
});

describe('ShroudLayer.mask', () => {
  it('hands the renderer the corner field with its extent and the edge shaping', () => {
    const layer = new ShroudLayer(40, 30);
    // Texel (i, j) is centred on world (i, j): the texture spans -0.5 .. width + 0.5 edge to edge.
    expect(layer.mask.texture).toBe(layer.texture);
    expect(layer.mask.origin).toEqual([-0.5, -0.5]);
    expect(layer.mask.size).toEqual([41, 31]);
    expect(typeof layer.mask.shape).toBe('function');
  });
});
