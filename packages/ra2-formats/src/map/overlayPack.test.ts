import { describe, expect, it } from 'vitest';
import {
  decodeOverlayPack,
  OVERLAY_ARRAY_SIZE,
  OVERLAY_EMPTY,
  OVERLAY_MAP_DIM,
  overlayAt,
} from './overlayPack.js';

/** Frame an LCW payload as a `[u16 in][u16 out]payload` chunk. */
function chunk(payload: Uint8Array, uncompressedSize: number): Buffer {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16LE(payload.length, 0);
  hdr.writeUInt16LE(uncompressedSize, 2);
  return Buffer.concat([hdr, Buffer.from(payload)]);
}

/** Base64 of a raw byte stream. */
function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

describe('decodeOverlayPack', () => {
  it('returns a full 262144-byte array filled with 0xFF for an empty section', () => {
    const out = decodeOverlayPack([]);
    expect(out.length).toBe(OVERLAY_ARRAY_SIZE);
    expect(out.every((b) => b === OVERLAY_EMPTY)).toBe(true);
  });

  it('decodes an LCW chunk into the array head, leaving the rest 0xFF', () => {
    // LCW: literal copy of 3 bytes [10, 20, 30], then terminator (0x80).
    const lcw = Uint8Array.from([0x83, 10, 20, 30, 0x80]);
    const stream = chunk(lcw, 3);
    const out = decodeOverlayPack([b64(stream)]);
    expect(out.length).toBe(OVERLAY_ARRAY_SIZE);
    expect(Array.from(out.subarray(0, 3))).toEqual([10, 20, 30]);
    // Everything past the decoded region stays at the empty sentinel.
    expect(out[3]).toBe(OVERLAY_EMPTY);
  });

  it('places consecutive chunks at running offsets', () => {
    const first = chunk(Uint8Array.from([0x82, 1, 2, 0x80]), 2);
    const second = chunk(Uint8Array.from([0x82, 3, 4, 0x80]), 2);
    const out = decodeOverlayPack([b64(Buffer.concat([first, second]))]);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('throws when the pack decodes to more than the array size', () => {
    // A single chunk's uncompressedSize is a u16, so overflow requires many
    // chunks. Five max-size fill chunks decode to 5*65535 > 262144 bytes.
    const fill = (v: number): Buffer =>
      // LCW command-3 fill: 0xFE, count(LE u16)=65535, value, terminator.
      Buffer.concat([Buffer.from([0xfe, 0xff, 0xff, v]), Buffer.from([0x80])]);
    const parts: Buffer[] = [];
    for (let i = 0; i < 5; i++) parts.push(chunk(Uint8Array.from(fill(i)), 65535));
    const stream = Buffer.concat(parts);
    expect(() => decodeOverlayPack([b64(stream)])).toThrow(RangeError);
  });
});

describe('overlayAt', () => {
  it('indexes cells as y*512+x across both arrays', () => {
    const overlay = new Uint8Array(OVERLAY_ARRAY_SIZE).fill(OVERLAY_EMPTY);
    const data = new Uint8Array(OVERLAY_ARRAY_SIZE).fill(0);
    const idx = 3 * OVERLAY_MAP_DIM + 7;
    overlay[idx] = 0x1b;
    data[idx] = 0x02;
    expect(overlayAt(overlay, data, 7, 3)).toEqual({ id: 0x1b, data: 0x02 });
  });
});
