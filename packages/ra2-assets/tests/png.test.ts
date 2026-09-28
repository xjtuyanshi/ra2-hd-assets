/** PNG encoder round trip (the decoder is used by the preview compositor). */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, decodePng, encodePng, type PngChannels } from '../src/node/png.ts';

function pseudoRandom(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('png', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  for (const channels of [1, 3, 4] as PngChannels[]) {
    it(`round-trips ${channels}-channel images through every filter type`, () => {
      const width = 37;
      const height = 23;
      // Mix noise rows with smooth gradients so the adaptive filter picks several filter types.
      const data = pseudoRandom(width * height * channels, channels);
      for (let y = 0; y < height; y += 2) {
        for (let i = 0; i < width * channels; i++) data[y * width * channels + i] = (i * 3 + y) & 0xff;
      }
      const png = encodePng({ width, height, channels, data });
      const back = decodePng(png);
      expect(back.width).toBe(width);
      expect(back.height).toBe(height);
      expect(back.channels).toBe(channels);
      expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
    });
  }

  it('writes a standard signature, IHDR and zlib IDAT', () => {
    const png = encodePng({ width: 256, height: 1, channels: 3, data: pseudoRandom(768, 7) });
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
    const idatLen = new DataView(png.buffer, png.byteOffset).getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(1 + 768);
  });

  it('rejects mismatched buffers and corrupt chunks', () => {
    expect(() => encodePng({ width: 2, height: 2, channels: 4, data: new Uint8Array(3) })).toThrow();
    const png = encodePng({ width: 4, height: 4, channels: 4, data: new Uint8Array(64) });
    png[20] = (png[20]! + 1) & 0xff;
    expect(() => decodePng(png)).toThrow(/CRC/);
  });
});
