import { describe, expect, it } from 'vitest';
import { TmpFile } from './tmpFile.js';

const TILE_W = 60;
const TILE_H = 30;
const DIAMOND_BYTES = (TILE_W * TILE_H) >> 1; // 900
const IMAGE_HEADER_SIZE = 52;

/** Options controlling a synthetic tile built by {@link makeTile}. */
interface TileOpts {
  x?: number;
  y?: number;
  height?: number;
  terrainType?: number;
  rampType?: number;
  radarLeft?: [number, number, number];
  radarRight?: [number, number, number];
  /** Fill byte for the diamond data (defaults to a per-tile marker). */
  fill?: number;
  withZData?: boolean;
  /** [x, y, w, h, fillByte] for an extra-graphics overlay. */
  extra?: [number, number, number, number, number];
  /** Fill byte for an extra z-data raster stored after the extra graphics (needs `withZData` and `extra`). */
  extraZ?: number;
}

/**
 * Build one tile's on-disk bytes: 52-byte header, 900-byte diamond, optional
 * z-data and extra graphics. Returns the concatenated buffer; offsets inside
 * the header are relative to the tile start (matching the real format).
 */
function makeTile(opts: TileOpts): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(IMAGE_HEADER_SIZE);
  const hv = new DataView(header.buffer);

  let flags = 0;
  const zOfs = IMAGE_HEADER_SIZE + DIAMOND_BYTES; // z-data right after diamond
  let cursor = IMAGE_HEADER_SIZE + DIAMOND_BYTES;
  if (opts.withZData) {
    flags |= 0x2;
    cursor += DIAMOND_BYTES;
  }
  let extraOfs = 0;
  let extraZOfs = 0;
  if (opts.extra) {
    flags |= 0x1;
    extraOfs = cursor;
    cursor += opts.extra[2] * opts.extra[3];
    if (opts.extraZ !== undefined) extraZOfs = cursor;
  }

  hv.setInt32(0, opts.x ?? 0, true);
  hv.setInt32(4, opts.y ?? 0, true);
  hv.setInt32(8, extraOfs, true);
  hv.setInt32(12, opts.withZData ? zOfs : 0, true);
  hv.setInt32(16, extraZOfs, true);
  hv.setInt32(20, opts.extra ? opts.extra[0] : 0, true);
  hv.setInt32(24, opts.extra ? opts.extra[1] : 0, true);
  hv.setInt32(28, opts.extra ? opts.extra[2] : 0, true);
  hv.setInt32(32, opts.extra ? opts.extra[3] : 0, true);
  hv.setUint32(36, flags, true);
  hv.setInt8(40, opts.height ?? 0);
  hv.setInt8(41, opts.terrainType ?? 0);
  hv.setInt8(42, opts.rampType ?? 0);
  const rl = opts.radarLeft ?? [0, 0, 0];
  const rr = opts.radarRight ?? [0, 0, 0];
  hv.setUint8(43, rl[0]);
  hv.setUint8(44, rl[1]);
  hv.setUint8(45, rl[2]);
  hv.setUint8(46, rr[0]);
  hv.setUint8(47, rr[1]);
  hv.setUint8(48, rr[2]);
  parts.push(header);

  const diamond = new Uint8Array(DIAMOND_BYTES).fill(opts.fill ?? 0x11);
  parts.push(diamond);

  if (opts.withZData) {
    parts.push(new Uint8Array(DIAMOND_BYTES).fill(0x7f));
  }
  if (opts.extra) {
    const [, , w, h, ef] = opts.extra;
    parts.push(new Uint8Array(w * h).fill(ef));
    if (opts.extraZ !== undefined) parts.push(new Uint8Array(w * h).fill(opts.extraZ));
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Assemble a full TMP(TS) file: 16-byte header, offset table, then the tile
 * blobs. A `null` slot leaves the offset at 0 (an empty tile).
 */
function makeTmp(blocksX: number, blocksY: number, tiles: (Uint8Array | null)[]): Uint8Array {
  const count = blocksX * blocksY;
  expect(tiles.length).toBe(count);
  const headerSize = 16 + 4 * count;
  const present = tiles.filter((t): t is Uint8Array => t !== null);
  const totalTileBytes = present.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(headerSize + totalTileBytes);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, blocksX, true);
  dv.setInt32(4, blocksY, true);
  dv.setInt32(8, TILE_W, true);
  dv.setInt32(12, TILE_H, true);

  let cursor = headerSize;
  for (let i = 0; i < count; i++) {
    const t = tiles[i];
    if (t === null || t === undefined) {
      dv.setInt32(16 + 4 * i, 0, true);
      continue;
    }
    dv.setInt32(16 + 4 * i, cursor, true);
    out.set(t, cursor);
    cursor += t.length;
  }
  return out;
}

describe('TmpFile.parse', () => {
  it('parses the file header and reports tile dimensions', () => {
    const tmp = makeTmp(2, 1, [makeTile({ fill: 0x22 }), null]);
    const f = TmpFile.parse(tmp);
    expect(f.blocksX).toBe(2);
    expect(f.blocksY).toBe(1);
    expect(f.tileWidth).toBe(60);
    expect(f.tileHeight).toBe(30);
    expect(f.tileCount).toBe(2);
    expect(f.diamondByteCount).toBe(900);
  });

  it('rejects an oversized tile dimension at PARSE time (OOM defense, no allocation)', () => {
    // 46340x23170 passes the `2*h==w` invariant but expandDiamond would allocate
    // ~1 GB (46340*23170). The ceiling rejects it before any tile decode.
    const buf = new Uint8Array(16 + 4); // header + one offset slot
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, 1, true); // blocksX
    dv.setInt32(4, 1, true); // blocksY
    dv.setInt32(8, 46340, true); // tileWidth
    dv.setInt32(12, 23170, true); // tileHeight (== width/2)
    const before = process.memoryUsage().arrayBuffers;
    expect(() => TmpFile.parse(buf)).toThrow(/tile dimensions/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
  });

  it('flags empty tile slots and returns undefined for them', () => {
    const tmp = makeTmp(2, 1, [makeTile({}), null]);
    const f = TmpFile.parse(tmp);
    expect(f.isEmpty(0)).toBe(false);
    expect(f.isEmpty(1)).toBe(true);
    expect(f.getTile(1)).toBeUndefined();
    expect(f.getTile(0)).toBeDefined();
    // Only the present tile is yielded.
    expect([...f.tiles()].map((t) => t.index)).toEqual([0]);
  });

  it('expands the diamond into a dense raster with the correct scanline widths', () => {
    // Fill the whole diamond with a single value; every in-diamond pixel must
    // equal it and every out-of-diamond pixel must be 0.
    const tmp = makeTmp(1, 1, [makeTile({ fill: 0x55 })]);
    const tile = TmpFile.parse(tmp).getTile(0)!;
    expect(tile.bitmap.length).toBe(TILE_W * TILE_H);

    // Row 0 (top): 4 px centred; row 14 (last of top half): 60 px full width.
    // Verify the classic diamond widths: row r (0-based, top half) has 4*(r+1).
    for (let row = 0; row < TILE_H; row++) {
      // Top half widens 4px/row (row 0 = 4px .. row 14 = 60px); the bottom half
      // narrows, starting at 56px on row 15 down to 0px on the last row.
      const half = TILE_H >> 1;
      const expectedWidth = row < half ? 4 * (row + 1) : 4 * (TILE_H - 1 - row);
      const start = (TILE_W - expectedWidth) >> 1;
      let filled = 0;
      let firstFilled = -1;
      for (let col = 0; col < TILE_W; col++) {
        const v = tile.bitmap[row * TILE_W + col];
        if (v === 0x55) {
          if (firstFilled < 0) firstFilled = col;
          filled++;
        } else {
          expect(v).toBe(0);
        }
      }
      expect(filled).toBe(expectedWidth);
      if (expectedWidth > 0) {
        expect(firstFilled).toBe(start);
      }
    }
  });

  it('exposes height, ramp, terrain and both radar colours', () => {
    const tmp = makeTmp(1, 1, [
      makeTile({
        height: 5,
        rampType: 3,
        terrainType: 13,
        radarLeft: [10, 20, 30],
        radarRight: [40, 50, 60],
      }),
    ]);
    const tile = TmpFile.parse(tmp).getTile(0)!;
    expect(tile.height).toBe(5);
    expect(tile.rampType).toBe(3);
    expect(tile.terrainType).toBe(13);
    expect(tile.radarLeft).toEqual({ red: 10, green: 20, blue: 30 });
    expect(tile.radarRight).toEqual({ red: 40, green: 50, blue: 60 });
    expect(tile.hasExtraData).toBe(false);
    expect(tile.hasZData).toBe(false);
    expect(tile.zData).toBeUndefined();
    expect(tile.extra).toBeUndefined();
  });

  it('reads z-data when the flag is set', () => {
    const tmp = makeTmp(1, 1, [makeTile({ withZData: true })]);
    const tile = TmpFile.parse(tmp).getTile(0)!;
    expect(tile.hasZData).toBe(true);
    expect(tile.zData).toBeDefined();
    expect(tile.zData!.length).toBe(DIAMOND_BYTES);
    expect(tile.zData!.every((b) => b === 0x7f)).toBe(true);
  });

  it('flags and reads extra overlay graphics', () => {
    const tmp = makeTmp(1, 1, [
      makeTile({ extra: [30, -1, 30, 8, 0x99] }),
    ]);
    const tile = TmpFile.parse(tmp).getTile(0)!;
    expect(tile.hasExtraData).toBe(true);
    expect(tile.extra).toBeDefined();
    expect(tile.extra!.x).toBe(30);
    expect(tile.extra!.y).toBe(-1);
    expect(tile.extra!.width).toBe(30);
    expect(tile.extra!.height).toBe(8);
    expect(tile.extra!.bitmap.length).toBe(30 * 8);
    expect(tile.extra!.bitmap.every((b) => b === 0x99)).toBe(true);
  });

  it('handles a tile with both z-data and extra graphics', () => {
    const tmp = makeTmp(1, 1, [
      makeTile({ withZData: true, extra: [0, -1, 30, 8, 0x42] }),
    ]);
    const tile = TmpFile.parse(tmp).getTile(0)!;
    expect(tile.hasZData).toBe(true);
    expect(tile.hasExtraData).toBe(true);
    expect(tile.zData!.every((b) => b === 0x7f)).toBe(true);
    expect(tile.extra!.bitmap.every((b) => b === 0x42)).toBe(true);
    expect(tile.extra!.zData).toBeUndefined();
  });

  it('reads extra z-data only when the tile carries the z-data flag', () => {
    const withZ = TmpFile.parse(
      makeTmp(1, 1, [makeTile({ withZData: true, extra: [0, -4, 6, 5, 0x42], extraZ: 0x15 })]),
    ).getTile(0)!;
    expect(withZ.extra!.zData).toHaveLength(30);
    expect(withZ.extra!.zData!.every((b) => b === 0x15)).toBe(true);
    expect(withZ.extra!.bitmap.every((b) => b === 0x42)).toBe(true);
    // Without the flag the header's extra z offset is not meaningful (stock files leave it uninitialised).
    const noFlag = TmpFile.parse(makeTmp(1, 1, [makeTile({ extra: [0, -4, 6, 5, 0x42], extraZ: 0x15 })])).getTile(0)!;
    expect(noFlag.extra!.zData).toBeUndefined();
  });

  it('expands packed diamond scanlines such as z-data into a dense raster', () => {
    const file = TmpFile.parse(makeTmp(1, 1, [makeTile({ withZData: true })]));
    const dense = file.expandDiamond(file.getTile(0)!.zData!);
    expect(dense).toHaveLength(TILE_W * TILE_H);
    expect(dense[0 * TILE_W + 28]).toBe(0x7f);
    expect(dense[0 * TILE_W + 27]).toBe(0);
    expect(dense[14 * TILE_W + 0]).toBe(0x7f);
    expect(dense[29 * TILE_W + 30]).toBe(0);
  });
});

describe('TmpFile.parse validation', () => {
  it('rejects a truncated file header', () => {
    expect(() => TmpFile.parse(new Uint8Array(8))).toThrow(RangeError);
  });

  it('rejects invalid tile dimensions (height not half width)', () => {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, 1, true);
    dv.setInt32(4, 1, true);
    dv.setInt32(8, 60, true);
    dv.setInt32(12, 40, true); // 2*40 !== 60
    expect(() => TmpFile.parse(buf)).toThrow(/height must be half width/);
  });

  it('rejects a zero block count', () => {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, 0, true);
    dv.setInt32(4, 1, true);
    dv.setInt32(8, 60, true);
    dv.setInt32(12, 30, true);
    expect(() => TmpFile.parse(buf)).toThrow(/block count/);
  });

  it('rejects an offset table that overruns the buffer', () => {
    // Claims 4 tiles but only provides room for the header.
    const buf = new Uint8Array(16 + 4); // room for one offset only
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, 2, true);
    dv.setInt32(4, 2, true);
    dv.setInt32(8, 60, true);
    dv.setInt32(12, 30, true);
    expect(() => TmpFile.parse(buf)).toThrow(/offset table/);
  });

  it('rejects a tile offset pointing outside the buffer', () => {
    const tmp = makeTmp(1, 1, [makeTile({})]);
    const dv = new DataView(tmp.buffer);
    dv.setInt32(16, tmp.length + 100, true); // corrupt the offset
    expect(() => TmpFile.parse(tmp)).toThrow(/points outside/);
  });

  it('rejects out-of-range tile indices', () => {
    const f = TmpFile.parse(makeTmp(1, 1, [makeTile({})]));
    expect(() => f.getTile(-1)).toThrow(RangeError);
    expect(() => f.getTile(5)).toThrow(RangeError);
    expect(() => f.isEmpty(5)).toThrow(RangeError);
  });
});
