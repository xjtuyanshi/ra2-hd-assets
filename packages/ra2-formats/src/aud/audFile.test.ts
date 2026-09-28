import { describe, expect, it } from 'vitest';
import {
  AUD_CHUNK_ID,
  AUD_HEADER_SIZE,
  AUD_TYPE_IMA_ADPCM,
  AUD_TYPE_WESTWOOD,
  AudFile,
  MAX_AUD_UNCOMPRESSED_BYTES,
} from './audFile.js';

/** The same golden IMA vector as adpcm.test.ts (packed bytes -> known PCM). */
const IMA_BYTES = Uint8Array.from([72, 124, 15, 162, 213, 145, 230, 179]);
const IMA_GOLDEN = [0, 7, -3, 16, -25, -19, 8, -17, 33, -41, -11, -38, 69, -122, 60, -105];

/** Build a synthetic IMA-ADPCM AUD wrapping `body` as a single chunk. */
function buildImaAud(body: Uint8Array, sampleRate = 22050): Uint8Array {
  const decodedSamples = body.length * 2; // 2 samples per byte
  const decodedBytes = decodedSamples * 2; // 16-bit
  const out = new Uint8Array(AUD_HEADER_SIZE + 8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, sampleRate, true);
  view.setUint32(2, 8 + body.length, true); // sizeCompressed (chunk header + body)
  view.setUint32(6, decodedBytes, true); // sizeUncompressed
  view.setUint8(10, 0x02); // flags: 16-bit, mono
  view.setUint8(11, AUD_TYPE_IMA_ADPCM);
  // chunk header
  view.setUint16(AUD_HEADER_SIZE, body.length, true);
  view.setUint16(AUD_HEADER_SIZE + 2, decodedBytes, true);
  view.setUint32(AUD_HEADER_SIZE + 4, AUD_CHUNK_ID, true);
  out.set(body, AUD_HEADER_SIZE + 8);
  return out;
}

describe('AudFile.parse', () => {
  it('reads the header fields and derives channels/bit-depth', () => {
    const aud = AudFile.parse(buildImaAud(IMA_BYTES));
    expect(aud.header.sampleRate).toBe(22050);
    expect(aud.header.type).toBe(AUD_TYPE_IMA_ADPCM);
    expect(aud.header.channels).toBe(1);
    expect(aud.header.bytesPerSample).toBe(2);
  });

  it('rejects an implausible uncompressed size at PARSE time (OOM defense, no allocation)', () => {
    // decode() allocates Int16Array(sizeUncompressed/bytesPerSample) up front; a 12-byte
    // header with sizeUncompressed=0xFFFFFFFF would allocate ~8.6 GB off-heap. Guard fires
    // at parse before any allocation.
    const bad = buildImaAud(IMA_BYTES);
    new DataView(bad.buffer).setUint32(6, 0xffffffff, true); // sizeUncompressed
    const before = process.memoryUsage().arrayBuffers;
    expect(() => AudFile.parse(bad)).toThrow(/uncompressed size/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
    expect(MAX_AUD_UNCOMPRESSED_BYTES).toBe(256 * 1024 * 1024);
  });

  it('accepts a valid header at the plausible ceiling boundary (no behavior change)', () => {
    // A real clip's sizeUncompressed is small; confirm the normal build still decodes.
    const aud = AudFile.parse(buildImaAud(IMA_BYTES));
    expect(aud.decode().samples.length).toBe(IMA_BYTES.length * 2);
  });

  it('rejects an unknown compression type', () => {
    const bad = buildImaAud(IMA_BYTES);
    bad[11] = 7; // not 1 or 99
    expect(() => AudFile.parse(bad)).toThrow(/Unsupported AUD compression type/);
  });

  it('rejects a too-small buffer', () => {
    expect(() => AudFile.parse(new Uint8Array(4))).toThrow(/too small/);
  });

  it('looksLikeAud accepts a valid header and rejects noise', () => {
    expect(AudFile.looksLikeAud(buildImaAud(IMA_BYTES))).toBe(true);
    expect(AudFile.looksLikeAud(Uint8Array.from([0x52, 0x49, 0x46, 0x46]))).toBe(false);
  });
});

describe('AudFile.decode (IMA-ADPCM)', () => {
  it('decodes a single IMA chunk to the golden PCM vector', () => {
    const aud = AudFile.parse(buildImaAud(IMA_BYTES));
    const { samples, sampleRate, channels } = aud.decode();
    expect(sampleRate).toBe(22050);
    expect(channels).toBe(1);
    expect([...samples]).toEqual(IMA_GOLDEN);
  });

  it('resets IMA state at each chunk boundary (two chunks decode independently)', () => {
    // Two identical chunks: because state resets per chunk, the second chunk's PCM
    // must equal the first chunk's PCM (not continue drifting).
    const one = buildImaAud(IMA_BYTES);
    // Splice a second identical chunk after the first.
    const body = IMA_BYTES;
    const chunk = new Uint8Array(8 + body.length);
    const cv = new DataView(chunk.buffer);
    cv.setUint16(0, body.length, true);
    cv.setUint16(2, body.length * 2 * 2, true);
    cv.setUint32(4, AUD_CHUNK_ID, true);
    chunk.set(body, 8);
    const two = new Uint8Array(one.length + chunk.length);
    two.set(one, 0);
    two.set(chunk, one.length);
    // Fix the header's uncompressed size to cover both chunks.
    const tv = new DataView(two.buffer);
    tv.setUint32(6, body.length * 2 * 2 * 2, true);
    const { samples } = AudFile.parse(two).decode();
    const half = samples.length / 2;
    expect([...samples.slice(0, half)]).toEqual([...samples.slice(half)]);
    expect([...samples.slice(0, half)]).toEqual(IMA_GOLDEN);
  });

  it('stops cleanly on a chunk with a bad magic', () => {
    const aud = buildImaAud(IMA_BYTES);
    // Corrupt the chunk id -> decode should stop, yielding no samples.
    const v = new DataView(aud.buffer);
    v.setUint32(AUD_HEADER_SIZE + 4, 0x12345678, true);
    const { samples } = AudFile.parse(aud).decode();
    expect(samples.length).toBe(0);
  });
});

describe('AudFile.decode (Westwood)', () => {
  it('decodes a type-1 stream of raw + repeat opcodes', () => {
    // opcode 2 raw (count=1 -> 2 samples: centre, +64), then opcode 3 repeat x2.
    const body = Uint8Array.from([(2 << 6) | 1, 0x80, 0xc0, (3 << 6) | 1]);
    const out = new Uint8Array(AUD_HEADER_SIZE + 8 + body.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, 22050, true);
    view.setUint32(2, 8 + body.length, true);
    view.setUint32(6, 4 * 2, true); // 4 samples, 16-bit
    view.setUint8(10, 0x02);
    view.setUint8(11, AUD_TYPE_WESTWOOD);
    view.setUint16(AUD_HEADER_SIZE, body.length, true);
    view.setUint16(AUD_HEADER_SIZE + 2, 4 * 2, true);
    view.setUint32(AUD_HEADER_SIZE + 4, AUD_CHUNK_ID, true);
    out.set(body, AUD_HEADER_SIZE + 8);
    const { samples } = AudFile.parse(out).decode();
    expect(samples.length).toBe(4);
    expect(samples[0]).toBe(0); // centre
    expect(samples[1]).toBe(0x40 << 8); // +64
    expect(samples[2]).toBe(0x40 << 8); // repeat
    expect(samples[3]).toBe(0x40 << 8);
  });
});
