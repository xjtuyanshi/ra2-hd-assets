import { describe, expect, it } from 'vitest';
import { decodeLcwInto, decodeLcwToArray } from './lcw.js';

// Hand-crafted format80 streams. Command grammar (bit 7 selects class):
//   0cccpppp p       relative back-copy (count 3..10, 12-bit offset)
//   10cccccc         literal copy (count 1..63); 0x80 terminates
//   11cccccc p p     absolute back-copy (count 3..64, 16-bit offset)
//   11111110 c c v   run-length fill
//   11111111 c c p p absolute back-copy (16-bit count + offset)

describe('decodeLcw', () => {
  it('copies a literal run then terminates', () => {
    // 0x85 = literal copy of 5 bytes, then terminator.
    const stream = Uint8Array.from([0x85, 72, 69, 76, 76, 79, 0x80]);
    expect(Buffer.from(decodeLcwToArray(stream)).toString('latin1')).toBe('HELLO');
  });

  it('handles a relative back-copy (command 0)', () => {
    // Literal "HELLO", then command-0 copy of 3 bytes from offset 5.
    const stream = Uint8Array.from([0x85, 72, 69, 76, 76, 79, 0x00, 0x05, 0x80]);
    // Back-copy walks forward from (w-5): H, E, L.
    expect(Buffer.from(decodeLcwToArray(stream)).toString('latin1')).toBe('HELLOHEL');
  });

  it('handles an absolute back-copy (command 2)', () => {
    // Literal "ABC", then absolute copy of 3 bytes from offset 0.
    const stream = Uint8Array.from([0x83, 65, 66, 67, 0xc0, 0, 0, 0x80]);
    expect(Buffer.from(decodeLcwToArray(stream)).toString('latin1')).toBe('ABCABC');
  });

  it('handles a run-length fill (command 3)', () => {
    // 0xFE fill: count=4 (LE), value 'A'.
    const stream = Uint8Array.from([0xfe, 4, 0, 0x41, 0x80]);
    expect(Buffer.from(decodeLcwToArray(stream)).toString('latin1')).toBe('AAAA');
  });

  it('handles a large fill via command 3 count>255', () => {
    // count = 300 (0x012C) little-endian.
    const stream = Uint8Array.from([0xfe, 0x2c, 0x01, 0x58, 0x80]);
    const out = decodeLcwToArray(stream);
    expect(out.length).toBe(300);
    expect(out.every((b) => b === 0x58)).toBe(true);
  });

  it('handles command 4 (16-bit count + absolute offset)', () => {
    // Fill 4 'A's, then command-4 copy of 4 bytes from absolute offset 0.
    const stream = Uint8Array.from([0xfe, 4, 0, 0x41, 0xff, 4, 0, 0, 0, 0x80]);
    expect(Buffer.from(decodeLcwToArray(stream)).toString('latin1')).toBe('AAAAAAAA');
  });

  it('stops at end-of-input without an explicit terminator', () => {
    const stream = Uint8Array.from([0x83, 1, 2, 3]);
    expect(Array.from(decodeLcwToArray(stream))).toEqual([1, 2, 3]);
  });

  it('decodeLcwInto writes at an offset and returns the byte count', () => {
    const stream = Uint8Array.from([0x83, 9, 8, 7, 0x80]);
    const out = new Uint8Array(10).fill(0xee);
    const n = decodeLcwInto(stream, out, 2);
    expect(n).toBe(3);
    expect(Array.from(out.subarray(2, 5))).toEqual([9, 8, 7]);
    // Bytes before the offset are untouched.
    expect(out[0]).toBe(0xee);
  });

  it('decodeLcwInto measures absolute offsets from outputOffset', () => {
    // At offset 4: literal "AB", absolute copy of 3 bytes (command-2 minimum)
    // from base offset 0 — reads relative to outputOffset, not buffer start.
    const stream = Uint8Array.from([0x82, 65, 66, 0xc0, 0, 0, 0x80]);
    const out = new Uint8Array(16).fill(0);
    const n = decodeLcwInto(stream, out, 4);
    expect(n).toBe(5);
    expect(Buffer.from(out.subarray(4, 9)).toString('latin1')).toBe('ABABA');
  });
});
