import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RepeatWrapping, LinearMipmapLinearFilter, NoColorSpace } from 'three/webgpu';
import { OCEAN_NORMAL, oceanNormalTile, oceanNormalTexture } from '../src/proceduralTextures';

const size = OCEAN_NORMAL.size;
const tile = oceanNormalTile();

describe('procedural ocean normal tile', () => {
  it('is deterministic, seed-local and cached independently of legacy textures', () => {
    oceanNormalTile(32, 123);
    expect(oceanNormalTile()).toEqual(tile);
    // Approved prototype A (seed 777), checked byte-for-byte against its standalone synthesis.
    expect(createHash('sha256').update(tile).digest('hex')).toBe(
      '965fb121d0e165bcb9d62835651c9d2d00ac8bb1b207389535697fef85a8ee17',
    );
    expect(oceanNormalTile(size, 778)).not.toEqual(tile);
    const texture = oceanNormalTexture();
    expect(oceanNormalTexture()).toBe(texture);
    expect(texture.image.data).toEqual(tile);
    expect(texture.wrapS).toBe(RepeatWrapping);
    expect(texture.wrapT).toBe(RepeatWrapping);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.generateMipmaps).toBe(true);
  });

  it('encodes unit upward normals at the specified RMS slope and sparse long-wave caps', () => {
    let slopes = 0,
      nonzero = 0,
      strong = 0;
    for (let i = 0; i < size * size; i++) {
      const x = tile[i * 4]! / 127.5 - 1;
      const z = tile[i * 4 + 1]! / 127.5 - 1;
      const y = tile[i * 4 + 2]! / 127.5 - 1;
      // Each decoded channel has at most 1/255 quantisation error.
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(Math.sqrt(3) / 255);
      expect(y).toBeGreaterThan(0.5);
      slopes += (x * x + z * z) / (y * y);
      if (tile[i * 4 + 3]! > 0) nonzero++;
      if (tile[i * 4 + 3]! > 240) strong++;
    }
    expect(Math.sqrt(slopes / (size * size))).toBeCloseTo(0.24, 2);
    expect(nonzero / (size * size)).toBeCloseTo(0.15, 2);
    expect(strong / (size * size)).toBeLessThan(0.01);
    expect(26 / OCEAN_NORMAL.foamCycles).toBeCloseTo(0.8667, 4);
  });

  it('has no boundary jump: wrap-edge differences follow the interior neighbour distribution on both axes', () => {
    // A periodic sampled field need not duplicate the first/last texels: those are one texel apart.
    // A clamped nonperiodic noise tile would introduce a large discontinuity at either wrap seam.
    for (const axis of [0, 1]) {
      let interior = 0,
        seam = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const nx = axis === 0 ? (x + 1) % size : x;
          const ny = axis === 1 ? (y + 1) % size : y;
          const wrap = axis === 0 ? x === size - 1 : y === size - 1;
          for (const channel of [0, 1, 3]) {
            const d = tile[(y * size + x) * 4 + channel]! - tile[(ny * size + nx) * 4 + channel]!;
            if (wrap) seam += d * d;
            else interior += d * d;
          }
        }
      const ratio = seam / size / (interior / (size * (size - 1)));
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(1.8);
    }
  });

  it('rejects dimensions unsupported by radix-2 synthesis', () => {
    for (const size of [0, 7, 63, 255, 2048, 32.5]) expect(() => oceanNormalTile(size)).toThrow(RangeError);
  });
});
