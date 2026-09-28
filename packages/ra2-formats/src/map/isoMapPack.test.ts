import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  decodeBase64Section,
  decodeIsoMapPack,
  decompressIsoMapPack,
  ISO_TILE_RECORD_SIZE,
  joinSectionLines,
  parseIsoTiles,
  readPackChunks,
} from './isoMapPack.js';

/** Build one 11-byte iso tile record. */
function record(
  x: number,
  y: number,
  tileNum: number,
  subTile: number,
  z: number,
  flags: number,
): Uint8Array {
  const b = Buffer.alloc(ISO_TILE_RECORD_SIZE);
  b.writeInt16LE(x, 0);
  b.writeInt16LE(y, 2);
  b.writeInt32LE(tileNum, 4);
  b.writeUInt8(subTile, 8);
  b.writeUInt8(z, 9);
  b.writeUInt8(flags, 10);
  return Uint8Array.from(b);
}

/** Wrap raw bytes as an all-literal LZO1X stream (first-byte literal form). */
function lzoLiterals(raw: Uint8Array): Uint8Array {
  // first byte = 17 + len (len must be < 238 for this simple encoding), then
  // the literal bytes, then the 0x11 00 00 end marker.
  return Uint8Array.from([17 + raw.length, ...raw, 0x11, 0, 0]);
}

/** Frame a compressed payload as a `[u16 in][u16 out]payload` chunk. */
function chunk(payload: Uint8Array, uncompressedSize: number): Uint8Array {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16LE(payload.length, 0);
  hdr.writeUInt16LE(uncompressedSize, 2);
  return Uint8Array.from(Buffer.concat([hdr, Buffer.from(payload)]));
}

describe('decodeBase64', () => {
  it('decodes clean base64', () => {
    expect(Buffer.from(decodeBase64('aGVsbG8=')).toString('latin1')).toBe('hello');
  });

  it('ignores embedded whitespace and stray characters', () => {
    expect(Buffer.from(decodeBase64('aGV\nsbG 8=')).toString('latin1')).toBe('hello');
  });

  it('joins and decodes numbered section lines', () => {
    const joined = joinSectionLines(['aGVs', 'bG8=']);
    expect(joined).toBe('aGVsbG8=');
    expect(Buffer.from(decodeBase64Section(['aGVs', 'bG8='])).toString('latin1')).toBe(
      'hello',
    );
  });
});

describe('readPackChunks', () => {
  it('splits a two-chunk stream by its size headers', () => {
    const a = chunk(Uint8Array.from([1, 2, 3]), 3);
    const b = chunk(Uint8Array.from([4, 5]), 2);
    const chunks = readPackChunks(Uint8Array.from(Buffer.concat([Buffer.from(a), Buffer.from(b)])));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.compressedSize).toBe(3);
    expect(chunks[0]!.uncompressedSize).toBe(3);
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 2, 3]);
    expect(Array.from(chunks[1]!.payload)).toEqual([4, 5]);
  });

  it('throws when a payload runs past the buffer', () => {
    // Header claims 10 payload bytes but only 2 are present.
    const bad = Uint8Array.from([10, 0, 10, 0, 1, 2]);
    expect(() => readPackChunks(bad)).toThrow(RangeError);
  });
});

describe('parseIsoTiles', () => {
  it('reads the 11-byte record layout', () => {
    const raw = Uint8Array.from(
      Buffer.concat([Buffer.from(record(3, 4, 505, 1, 2, 0))]),
    );
    const tiles = parseIsoTiles(raw, true);
    expect(tiles).toEqual([{ x: 3, y: 4, tileNum: 505, subTile: 1, z: 2, flags: 0 }]);
  });

  it('drops all-zero-coordinate padding records by default', () => {
    const raw = Uint8Array.from(
      Buffer.concat([
        Buffer.from(record(3, 4, 505, 1, 2, 0)),
        Buffer.from(record(0, 0, 0, 0, 0, 0)),
      ]),
    );
    expect(parseIsoTiles(raw)).toHaveLength(1);
    expect(parseIsoTiles(raw, true)).toHaveLength(2);
  });

  it('interprets negative coordinates as signed 16-bit', () => {
    const raw = record(-1, -2, 0, 0, 0, 0);
    const [t] = parseIsoTiles(raw, true);
    expect(t!.x).toBe(-1);
    expect(t!.y).toBe(-2);
  });
});

describe('decompressIsoMapPack + decodeIsoMapPack', () => {
  it('decompresses framed LZO chunks into raw records', () => {
    const raw = Uint8Array.from(
      Buffer.concat([
        Buffer.from(record(3, 4, 505, 1, 2, 0)),
        Buffer.from(record(-1, 7, 0, 0, 3, 1)),
      ]),
    );
    const stream = chunk(lzoLiterals(raw), raw.length);
    const out = decompressIsoMapPack(stream);
    expect(Array.from(out)).toEqual(Array.from(raw));

    const tiles = parseIsoTiles(out, true);
    expect(tiles).toEqual([
      { x: 3, y: 4, tileNum: 505, subTile: 1, z: 2, flags: 0 },
      { x: -1, y: 7, tileNum: 0, subTile: 0, z: 3, flags: 1 },
    ]);
  });

  it('runs the full section pipeline (join → base64 → LZO → records)', () => {
    const raw = record(9, 9, 42, 0, 1, 0);
    const stream = chunk(lzoLiterals(raw), raw.length);
    const b64 = Buffer.from(stream).toString('base64');
    // Split the base64 across two "lines" to exercise the join step.
    const mid = Math.floor(b64.length / 2);
    const { tiles, raw: decoded } = decodeIsoMapPack([b64.slice(0, mid), b64.slice(mid)]);
    expect(Array.from(decoded)).toEqual(Array.from(raw));
    expect(tiles).toEqual([{ x: 9, y: 9, tileNum: 42, subTile: 0, z: 1, flags: 0 }]);
  });

  it('rejects an implausible total decompressed size before allocating (OOM defense)', () => {
    // Many chunks each declaring uncompressedSize=65535 (u16 max) with an empty
    // payload: the summed total exceeds the 256 MiB ceiling. Guard fires before
    // `new Uint8Array(total)`, so a crafted map pack cannot OOM the loader.
    const N = 4200; // 4200 * 65535 ≈ 275 MiB > 256 MiB
    const stream = new Uint8Array(N * 4);
    const dv = new DataView(stream.buffer);
    for (let i = 0; i < N; i++) {
      dv.setUint16(i * 4, 0, true); // compressedSize = 0 (empty payload)
      dv.setUint16(i * 4 + 2, 65535, true); // uncompressedSize
    }
    const before = process.memoryUsage().arrayBuffers;
    expect(() => decompressIsoMapPack(stream)).toThrow(/exceeds the sane ceiling/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
  });
});
