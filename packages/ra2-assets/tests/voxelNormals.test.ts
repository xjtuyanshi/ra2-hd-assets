/** Per-section normal table inference on synthetic voxel blocks (no game data). */
import { describe, expect, it } from 'vitest';
import { lookupNormal, normalTableFor } from '../../ra2-formats/src/index';
import { inferNormalsMode, sectionNormalsMode } from '../src/voxelNormals.ts';

/** Index of the table entry closest to `dir`. */
function nearest(mode: number, dir: [number, number, number]): number {
  const table = normalTableFor(mode);
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < table.length; i++) {
    const n = lookupNormal(table, i);
    const d = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (d > bestDot) [best, bestDot] = [i, d];
  }
  return best;
}

/** A solid box whose surface voxels store the outward normal encoded for `mode` (interior voxels: index 0). */
function box(size: [number, number, number], mode: number): Uint8Array {
  const [sx, sy, sz] = size;
  const out: number[] = [];
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const dir: [number, number, number] = [
          x === sx - 1 ? 1 : x === 0 ? -1 : 0,
          y === sy - 1 ? 1 : y === 0 ? -1 : 0,
          z === sz - 1 ? 1 : z === 0 ? -1 : 0,
        ];
        const length = Math.hypot(...dir);
        const normal = length ? nearest(mode, [dir[0] / length, dir[1] / length, dir[2] / length]) : 0;
        out.push(x, y, z, 100, normal);
      }
  return new Uint8Array(out);
}

describe('inferNormalsMode', () => {
  it('recognises Tiberian Sun and Red Alert 2 encoded normals', () => {
    expect(inferNormalsMode([6, 5, 4], box([6, 5, 4], 2))).toBe(2);
    expect(inferNormalsMode([6, 5, 4], box([6, 5, 4], 4))).toBe(4);
  });

  it('falls back when nothing has an open face', () => {
    expect(inferNormalsMode([1, 1, 1], new Uint8Array(0))).toBe(4);
    expect(inferNormalsMode([1, 1, 1], new Uint8Array(0), 2)).toBe(2);
  });

  it('prefers the mode the extractor recorded', () => {
    const voxels = box([4, 4, 4], 2);
    expect(sectionNormalsMode({ size: [4, 4, 4], normalsMode: 4 }, voxels)).toBe(4);
    expect(sectionNormalsMode({ size: [4, 4, 4] }, voxels)).toBe(2);
  });
});
