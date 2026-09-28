import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  decodeRleZero,
  decodeRleZeroRows,
  ShpCompression,
} from './shpDecode.js';
import {
  MAX_SHP_FRAME_PIXELS,
  REMAP_INDEX_END,
  REMAP_INDEX_START,
  ShpFile,
  SHP_FRAME_HEADER_SIZE,
  SHP_HEADER_SIZE,
} from './shpFile.js';

/** Encode one mode-3 row: uint16 length prefix (incl. its own 2 bytes) + body. */
function encodeMode3Row(body: number[]): number[] {
  const len = body.length + 2;
  return [len & 0xff, (len >> 8) & 0xff, ...body];
}

interface FrameSpec {
  x?: number;
  y?: number;
  cx: number;
  cy: number;
  compression: ShpCompression;
  body: number[];
}

/** Assemble a synthetic SHP(TS) with the given bounding box and frame specs. */
function buildShp(cx: number, cy: number, specs: FrameSpec[]): Uint8Array {
  const headerBytes = SHP_HEADER_SIZE + specs.length * SHP_FRAME_HEADER_SIZE;
  // Lay out bodies immediately after the headers.
  const bodies: number[][] = specs.map((s) => s.body);
  const offsets: number[] = [];
  let cursor = headerBytes;
  for (const b of bodies) {
    offsets.push(b.length === 0 ? 0 : cursor);
    cursor += b.length;
  }
  const total = cursor;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0, true); // zero word
  dv.setUint16(2, cx, true);
  dv.setUint16(4, cy, true);
  dv.setUint16(6, specs.length, true);
  for (let i = 0; i < specs.length; i++) {
    const p = SHP_HEADER_SIZE + i * SHP_FRAME_HEADER_SIZE;
    const s = specs[i]!;
    dv.setInt16(p, s.x ?? 0, true);
    dv.setInt16(p + 2, s.y ?? 0, true);
    dv.setInt16(p + 4, s.cx, true);
    dv.setInt16(p + 6, s.cy, true);
    dv.setInt32(p + 8, s.compression, true);
    dv.setInt32(p + 20, offsets[i]!, true);
    buf.set(bodies[i]!, offsets[i]!);
  }
  return buf;
}

describe('decodeRleZero (mode 2)', () => {
  it('emits literals and expands zero-runs', () => {
    // literal 5, zero-run of 3, literal 9
    const src = new Uint8Array([5, 0, 3, 9]);
    const out = new Uint8Array(5);
    decodeRleZero(src, out);
    expect([...out]).toEqual([5, 0, 0, 0, 9]);
  });

  it('handles a zero-run at the exact end of output', () => {
    const src = new Uint8Array([7, 0, 2]);
    const out = new Uint8Array(3);
    decodeRleZero(src, out);
    expect([...out]).toEqual([7, 0, 0]);
  });

  it('throws on truncated zero-run and on overflow', () => {
    expect(() => decodeRleZero(new Uint8Array([0]), new Uint8Array(4))).toThrow(
      /truncated/,
    );
    expect(() =>
      decodeRleZero(new Uint8Array([1, 2, 3]), new Uint8Array(2)),
    ).toThrow(/overflow/);
  });
});

describe('decodeRleZeroRows (mode 3)', () => {
  it('decodes a simple row with a literal and a zero-run', () => {
    // width 4: literal 5, zero-run 2, literal 9 -> [5,0,0,9]
    const row = encodeMode3Row([5, 0, 2, 9]);
    const src = new Uint8Array(row);
    const out = new Uint8Array(4);
    decodeRleZeroRows(src, out, 4, 1);
    expect([...out]).toEqual([5, 0, 0, 9]);
  });

  it('decodes multiple rows independently', () => {
    // cx=3, cy=2. row0: [1,2,3]; row1: literal 0-run of 3 -> transparent row
    const row0 = encodeMode3Row([1, 2, 3]);
    const row1 = encodeMode3Row([0, 3]);
    const src = new Uint8Array([...row0, ...row1]);
    const out = new Uint8Array(6);
    decodeRleZeroRows(src, out, 3, 2);
    expect([...out]).toEqual([1, 2, 3, 0, 0, 0]);
  });

  it('clamps an over-long zero-run to the row width (XCC behavior)', () => {
    // cx=3: zero-run claims 10 but only 3 fit; must not overflow into next row.
    const row0 = encodeMode3Row([0, 10]);
    const row1 = encodeMode3Row([4, 5, 6]);
    const src = new Uint8Array([...row0, ...row1]);
    const out = new Uint8Array(6);
    decodeRleZeroRows(src, out, 3, 2);
    expect([...out]).toEqual([0, 0, 0, 4, 5, 6]);
  });

  it('handles a row shorter than cx by leaving the tail transparent', () => {
    // cx=4 but the row only encodes 2 literals; the rest stays 0.
    const row0 = encodeMode3Row([7, 8]);
    const src = new Uint8Array(row0);
    const out = new Uint8Array(4);
    decodeRleZeroRows(src, out, 4, 1);
    expect([...out]).toEqual([7, 8, 0, 0]);
  });

  it('handles a zero-run that exactly fills the row boundary', () => {
    // cx=2: literal then zero-run of exactly 1 to hit the boundary.
    const row0 = encodeMode3Row([9, 0, 1]);
    const src = new Uint8Array(row0);
    const out = new Uint8Array(2);
    decodeRleZeroRows(src, out, 2, 1);
    expect([...out]).toEqual([9, 0]);
  });

  it('throws on a truncated row header', () => {
    expect(() =>
      decodeRleZeroRows(new Uint8Array([5]), new Uint8Array(4), 4, 1),
    ).toThrow(/truncated row header/);
  });
});

describe('decodeFrame dispatch', () => {
  it('mode 0/1 copies raw bytes', () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    expect([...decodeFrame(raw, 2, 2, ShpCompression.None)]).toEqual([
      1, 2, 3, 4,
    ]);
    expect([...decodeFrame(raw, 2, 2, ShpCompression.Uncompressed)]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('returns an empty buffer for a zero-area frame', () => {
    expect(decodeFrame(new Uint8Array(0), 0, 5, ShpCompression.None).length).toBe(
      0,
    );
  });

  it('throws when an uncompressed body is too short', () => {
    expect(() =>
      decodeFrame(new Uint8Array([1, 2]), 2, 2, ShpCompression.None),
    ).toThrow(/too short/);
  });
});

describe('ShpFile.parse', () => {
  it('parses the file header and per-frame headers', () => {
    const shp = buildShp(4, 4, [
      {
        cx: 4,
        cy: 1,
        x: 1,
        y: 2,
        compression: ShpCompression.RleZeroRows,
        body: encodeMode3Row([5, 0, 2, 9]),
      },
    ]);
    const f = ShpFile.parse(shp);
    expect(f.cx).toBe(4);
    expect(f.cy).toBe(4);
    expect(f.count).toBe(1);
    const h = f.frameHeader(0);
    expect(h).toMatchObject({
      index: 0,
      x: 1,
      y: 2,
      cx: 4,
      cy: 1,
      compression: ShpCompression.RleZeroRows,
    });
    expect(h.offset).toBeGreaterThan(0);
  });

  it('decodes each compression mode through the frame() API', () => {
    // Mode 2 (RleZero) also carries the RLE bit, so like mode 3 it is decoded
    // per-row (XCC is_compressed == compression & 2 -> decode3), not whole-frame.
    const shp = buildShp(4, 4, [
      { cx: 4, cy: 1, compression: ShpCompression.None, body: [10, 11, 12, 13] },
      {
        cx: 4,
        cy: 1,
        compression: ShpCompression.RleZero,
        body: encodeMode3Row([5, 0, 3]),
      },
      {
        cx: 4,
        cy: 1,
        compression: ShpCompression.RleZeroRows,
        body: encodeMode3Row([1, 0, 2, 4]),
      },
    ]);
    const f = ShpFile.parse(shp);
    expect([...f.frame(0).pixels]).toEqual([10, 11, 12, 13]);
    // Per-row: literal 5, then zero-run of 3 -> [5,0,0,0].
    expect([...f.frame(1).pixels]).toEqual([5, 0, 0, 0]);
    expect([...f.frame(2).pixels]).toEqual([1, 0, 0, 4]);

    const all = f.decodeAll();
    expect(all).toHaveLength(3);
    expect(all.every((fr) => fr.pixels.length === 4)).toBe(true);
  });

  it('routes mode 2 through the per-row decoder like mode 3 (XCC parity)', () => {
    // Same body decoded as mode 2 and mode 3 must yield identical pixels, since
    // both set compression & 2 and XCC dispatches both to decode3.
    const body = encodeMode3Row([7, 0, 2, 8]);
    const shp = buildShp(4, 4, [
      { cx: 4, cy: 1, compression: ShpCompression.RleZero, body },
      { cx: 4, cy: 1, compression: ShpCompression.RleZeroRows, body },
    ]);
    const f = ShpFile.parse(shp);
    expect([...f.frame(0).pixels]).toEqual([...f.frame(1).pixels]);
    expect([...f.frame(0).pixels]).toEqual([7, 0, 0, 8]);
  });

  it('treats an offset-0 frame as empty (placeholder)', () => {
    const shp = buildShp(4, 4, [
      { cx: 4, cy: 1, compression: ShpCompression.None, body: [] },
    ]);
    const f = ShpFile.parse(shp);
    expect(f.frameHeader(0).offset).toBe(0);
    expect(f.frame(0).pixels.length).toBe(0);
  });

  it('rejects a non-SHP(TS) leading word', () => {
    const buf = new Uint8Array(SHP_HEADER_SIZE);
    new DataView(buf.buffer).setUint16(0, 7, true);
    expect(() => ShpFile.parse(buf)).toThrow(/not a SHP/);
  });

  it('rejects a truncated header table', () => {
    const buf = new Uint8Array(SHP_HEADER_SIZE + 4);
    const dv = new DataView(buf.buffer);
    dv.setUint16(6, 2, true); // claims 2 frames but no room for headers
    expect(() => ShpFile.parse(buf)).toThrow(/truncated/);
  });

  it('rejects out-of-range frame index access', () => {
    const shp = buildShp(1, 1, []);
    const f = ShpFile.parse(shp);
    expect(() => f.frameHeader(0)).toThrow(RangeError);
  });
});

describe('frame-dimension allocation guard (OOM defense)', () => {
  // A corrupt/oversized frame header (cx=cy=32767) would allocate ~1 GB in
  // decodeFrame BEFORE the body is validated. The parse-time bound rejects it
  // without ever allocating, so a mounted-but-corrupt MIX cannot OOM the server.
  it('rejects a frame larger than the sprite bounding box at PARSE time (no allocation)', () => {
    const buf = buildShp(2, 2, [
      { cx: 32767, cy: 32767, compression: ShpCompression.RleZeroRows, body: [] },
    ]);
    const before = process.memoryUsage().arrayBuffers;
    expect(() => ShpFile.parse(buf)).toThrow(/exceed the sprite bounds/);
    const delta = process.memoryUsage().arrayBuffers - before;
    expect(delta).toBeLessThan(50 * 1024 * 1024);
  });

  it('rejects a frame past the absolute pixel ceiling even when the sprite box is huge', () => {
    const buf = buildShp(32767, 32767, [
      { cx: 32767, cy: 32767, compression: ShpCompression.RleZeroRows, body: [] },
    ]);
    const before = process.memoryUsage().arrayBuffers;
    expect(() => ShpFile.parse(buf)).toThrow();
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
    expect(MAX_SHP_FRAME_PIXELS).toBe(4096 * 4096);
  });

  it('still accepts a normal frame filling the whole sprite box (no behavior change)', () => {
    const row = (a: number, b: number): number[] => [4, 0, a, b];
    const buf = buildShp(2, 2, [
      { cx: 2, cy: 2, compression: ShpCompression.RleZeroRows, body: [...row(1, 2), ...row(3, 4)] },
    ]);
    const f = ShpFile.parse(buf);
    expect(f.frameHeader(0).cx).toBe(2);
    expect(f.frameHeader(0).cy).toBe(2);
  });
});

describe('remap range re-export', () => {
  it('re-exports the 16..31 player-remap range from the palette layer', () => {
    expect(REMAP_INDEX_START).toBe(16);
    expect(REMAP_INDEX_END).toBe(31);
  });
});
