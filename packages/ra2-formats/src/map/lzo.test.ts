import { describe, expect, it } from 'vitest';
import { decodeLzo1x, LzoError } from './lzo.js';

// Hand-crafted LZO1X-1 streams. The leading byte, when > 17, encodes (t-17)
// literals; when that count is >= 4 the decoder copies them and jumps to match
// parsing. The end-of-stream marker is opcode 0x11 followed by 0x00 0x00 (a
// zero distance that makes m_pos === op).

describe('decodeLzo1x', () => {
  it('decodes a plain leading literal run', () => {
    // 21 = 17 + 4 -> 4 literals, then the end marker.
    const stream = Uint8Array.from([21, 1, 2, 3, 4, 0x11, 0, 0]);
    expect(Array.from(decodeLzo1x(stream, 4))).toEqual([1, 2, 3, 4]);
  });

  it('decodes a back-reference match after literals', () => {
    // 4 literals "ABCD" (op=4), then a short match (t=0x40): length 3 from
    // distance 1 -> repeats the last byte 'D' three times.
    const stream = Uint8Array.from([21, 65, 66, 67, 68, 0x40, 0x00, 0x11, 0, 0]);
    expect(Buffer.from(decodeLzo1x(stream, 7)).toString('latin1')).toBe('ABCDDDD');
  });

  it('validates the decoded size when provided', () => {
    const stream = Uint8Array.from([21, 1, 2, 3, 4, 0x11, 0, 0]);
    expect(() => decodeLzo1x(stream, 5)).toThrow(LzoError);
  });

  it('returns an empty array for empty input', () => {
    expect(decodeLzo1x(new Uint8Array(0)).length).toBe(0);
  });

  it('grows its output buffer when no size hint is given', () => {
    const stream = Uint8Array.from([21, 65, 66, 67, 68, 0x40, 0x00, 0x11, 0, 0]);
    // Without a hint the decoder still produces the correct bytes.
    expect(Buffer.from(decodeLzo1x(stream)).toString('latin1')).toBe('ABCDDDD');
  });

  it('throws on truncated input', () => {
    // Claims 4 leading literals but only supplies 2 bytes.
    const stream = Uint8Array.from([21, 1, 2]);
    expect(() => decodeLzo1x(stream, 4)).toThrow(LzoError);
  });
});
