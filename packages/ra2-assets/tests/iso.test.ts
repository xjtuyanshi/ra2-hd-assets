/** Screen projection, tile anchor and draw-offset math. */
import { describe, expect, it } from 'vitest';
import {
  cutoffTileHeight,
  drawOffsetFor,
  leptonDelta,
  localScreenRect,
  mapLightMultipliers,
  mapSizeCells,
  mergeTileExtra,
  projectCellCentre,
  projectCorner,
  projectSubCell,
  shpFrameOffset,
  tileAnchor,
  tileRasterOrigin,
} from '../src/iso.ts';
import { insideDiamond } from '../src/node/preview.ts';

describe('projection', () => {
  it('projects cell corners with the engine formula', () => {
    expect(projectCorner(0, 0, 0)).toEqual({ sx: 0, sy: 0 });
    expect(projectCorner(1, 0, 0)).toEqual({ sx: 30, sy: 15 });
    expect(projectCorner(0, 1, 0)).toEqual({ sx: -30, sy: 15 });
    expect(projectCorner(10, 4, 2)).toEqual({ sx: 180, sy: 180 });
    expect(projectCellCentre(3, 3, 0)).toEqual({ sx: 0, sy: 105 });
  });

  it('maps leptons to pixels (256 per cell, 104 per level)', () => {
    expect(leptonDelta(256, 0)).toEqual({ sx: 30, sy: 15 });
    expect(leptonDelta(128, 128)).toEqual({ sx: 0, sy: 15 });
    expect(leptonDelta(0, 0, 104)).toEqual({ sx: 0, sy: -15 });
  });

  it('places infantry sub-cells around the cell centre', () => {
    const c = projectCorner(5, 5, 0);
    expect(projectSubCell(5, 5, 0, 0)).toEqual({ sx: c.sx, sy: c.sy + 15 });
    expect(projectSubCell(5, 5, 0, 1).sy).toBeLessThan(c.sy + 15);
    expect(projectSubCell(5, 5, 0, 2).sx).toBeGreaterThan(c.sx);
    expect(projectSubCell(5, 5, 0, 3).sx).toBeLessThan(c.sx);
    expect(projectSubCell(5, 5, 0, 4).sy).toBeGreaterThan(c.sy + 15);
  });
});

describe('tile anchors', () => {
  it('anchors a plain diamond at its top corner (30, 0)', () => {
    const p = mergeTileExtra({ x: 0, y: 0 }, undefined);
    expect(p).toEqual({ diamond: [0, 0], extra: [0, 0], width: 60, height: 30 });
    expect(tileAnchor(...p.diamond)).toEqual([30, 0]);
  });

  it('grows the raster for extra graphics above and left of the diamond (cliff face)', () => {
    // Tile diamond at block offset (60, 45); its extra art starts 20 px left of and 40 px above it.
    const p = mergeTileExtra({ x: 60, y: 45 }, { x: 40, y: 5, width: 90, height: 60 });
    expect(p.diamond).toEqual([20, 40]);
    expect(p.extra).toEqual([0, 0]);
    expect(p.width).toBe(90);
    expect(p.height).toBe(70);
    expect(tileAnchor(...p.diamond)).toEqual([50, 40]);
  });

  it('grows the raster for extra graphics below the diamond (water bank)', () => {
    const p = mergeTileExtra({ x: 0, y: 0 }, { x: 10, y: 20, width: 30, height: 25 });
    expect(p).toEqual({ diamond: [0, 0], extra: [10, 20], width: 60, height: 45 });
  });

  it('draws a tile raster so its anchor lands on the projected cell corner', () => {
    const anchor: [number, number] = [50, 40];
    const o = tileRasterOrigin(7, 3, 2, anchor);
    const c = projectCorner(7, 3, 2);
    expect([o.sx + anchor[0], o.sy + anchor[1]]).toEqual([c.sx, c.sy]);
  });

  it('classifies diamond pixels relative to the anchor', () => {
    // Row 0 spans x 28..31, row 14 the full 0..59, row 15 x 2..57, row 29 is empty (TMP scanline layout).
    expect(insideDiamond(28, 0, [30, 0])).toBe(true);
    expect(insideDiamond(32, 0, [30, 0])).toBe(false);
    expect(insideDiamond(0, 14, [30, 0])).toBe(true);
    expect(insideDiamond(59, 14, [30, 0])).toBe(true);
    expect(insideDiamond(1, 15, [30, 0])).toBe(false);
    expect(insideDiamond(57, 15, [30, 0])).toBe(true);
    expect(insideDiamond(30, 29, [30, 0])).toBe(false);
    let area = 0;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) if (insideDiamond(x, y, [30, 0])) area++;
    expect(area).toBe(900);
  });
});

describe('sprite offsets', () => {
  it('measures frame offsets from the SHP canvas centre', () => {
    expect(shpFrameOffset([60, 60], { x: 7, y: 31 })).toEqual([-23, 1]);
    expect(shpFrameOffset([91, 65], { x: 0, y: 0 })).toEqual([-45, -32]);
  });

  it('puts cell-bound art on the top corner and movable objects on the cell centre', () => {
    expect(drawOffsetFor('overlay')).toEqual([0, 0]);
    expect(drawOffsetFor('smudge')).toEqual([0, 0]);
    expect(drawOffsetFor('building')).toEqual([0, 0]);
    expect(drawOffsetFor('vehicle')).toEqual([0, 15]);
    expect(drawOffsetFor('infantry')).toEqual([0, 15]);
  });

  it('draws rocks and ordinary trees at the cell centre, tiberium trees on the top corner', () => {
    expect(drawOffsetFor('overlay', { isARock: true })).toEqual([0, 15]);
    expect(drawOffsetFor('tree')).toEqual([0, 15]);
    expect(drawOffsetFor('tree', { spawnsTiberium: true })).toEqual([0, 0]);
  });
});

describe('mapSizeCells', () => {
  it('enumerates the [Map] Size rhombus', () => {
    const cells = mapSizeCells(3, 2);
    // Rows alternate width and width - 1 cells: 3 + 2 + 3 + 2.
    expect(cells).toHaveLength(10);
    expect(new Set(cells.map((c) => `${c.x},${c.y}`)).size).toBe(10);
    expect(cells[0]).toEqual({ x: 1, y: 3 });
    // Every cell satisfies the inverse transform bounds.
    for (const { x, y } of cells) {
      const dx = x - y + 3 - 1;
      const dy = x + y - 3 - 1;
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dx).toBeLessThanOrEqual(4);
      expect(dy).toBeGreaterThanOrEqual(0);
      expect(dy).toBeLessThan(4);
      expect((dx + dy) % 2).toBe(0);
    }
  });
});

describe('map lighting', () => {
  const l = { ambient: 0.9, red: 1, green: 0.9, blue: 0.9, ground: 0.05, level: 0.008 };

  it('lights full-class art by (ambient + ground + level * (z - 1)) * RGB', () => {
    const [r1, g1, b1] = mapLightMultipliers(l, 1);
    expect(r1).toBeCloseTo(0.95);
    expect(g1).toBeCloseTo(0.855);
    expect(b1).toBeCloseTo(0.855);
    expect(mapLightMultipliers(l, 0)[0]).toBeCloseTo(0.942);
    expect(mapLightMultipliers(l, 11, 'full')[0]).toBeCloseTo(1.03);
    expect(mapLightMultipliers({ ambient: 1, red: 1, green: 1, blue: 1, ground: 0, level: 0 }, 7)).toEqual([1, 1, 1]);
  });

  it('skips the RGB tint for ambient-class art and all lighting for unlit art', () => {
    const [r, g, b] = mapLightMultipliers(l, 1, 'ambient');
    expect(r).toBeCloseTo(0.95);
    expect(g).toBeCloseTo(0.95);
    expect(b).toBeCloseTo(0.95);
    expect(mapLightMultipliers(l, 5, 'none')).toEqual([1, 1, 1]);
  });
});

describe('visible map area', () => {
  it('ports the engine camera limits from [Map] Size and LocalSize', () => {
    // RiverRam: Size 52x61, LocalSize 2,6,48,49.
    expect(localScreenRect({ width: 52, height: 61 }, { x: 2, y: 6, width: 48, height: 49 }, 0)).toEqual({
      x: -1440,
      y: 900,
      width: 2880,
      height: 1590,
    });
    // LocalSize.x is clamped to 2 and the width to Size.width - 2 - x; a high cutoff shortens the view.
    const r = localScreenRect({ width: 20, height: 20 }, { x: 0, y: 3, width: 30, height: 30 }, 12);
    expect(r.x).toBe(4 * 30 - 20 * 30);
    expect(r.width).toBe(2 * 16 * 30);
    expect(r.height).toBe((40 - 0 - 12 - 1) * 15);
  });

  it('finds the cutoff height on the bottom-most display row', () => {
    // Size 4x3: the display row dy = x + y - 5; bottom row dy = 5 holds (4,6), (5,5), (6,4) with dx 1, 3, 5.
    const cells = mapSizeCells(4, 3).map((c) => ({ ...c, z: c.x + c.y === 10 && c.x === 4 ? 6 : 1 }));
    // Display columns 1 <= dx < 7 - 4 count, so (4,6) (dx 1, z 6) decides.
    expect(cutoffTileHeight({ width: 4, height: 3 }, cells)).toBe(6);
    expect(cutoffTileHeight({ width: 4, height: 3 }, [])).toBe(0);
  });
});
