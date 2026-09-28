/**
 * Crude voxel splatting for verification images (Node only): the same projection as preview.ts' map compositor —
 * model units -> leptons (8 per unit), rotated by the engine facing, iso-projected, painter-sorted — as a reusable
 * function returning points instead of drawing them. Not the engine's voxel renderer: no HVA animation, no
 * per-pixel normals shading beyond a fixed light, turret turned with the body.
 */
import { lookupNormal, normalTableFor } from 'ra2-formats';
import type { VoxelModel } from '../manifest.ts';

export interface SplatPoint {
  /** Screen offset from the model's origin (its draw point). */
  x: number;
  y: number;
  /** Painter depth (larger = nearer). */
  d: number;
  /** Palette index. */
  index: number;
  /** Brightness factor from the voxel normal (0.55..1). */
  lum: number;
}

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** Every voxel of `model` at engine facing `facing` (0 = north, clockwise), sorted back to front. */
export function voxelSplat(model: VoxelModel, facing: number): SplatPoint[] {
  const ang = (facing / 256) * Math.PI * 2;
  // Facing 0 = north = cell -Y; model +X is the vehicle's front.
  const fx = Math.sin(ang);
  const fy = -Math.cos(ang);
  const light: [number, number, number] = [0.2, -0.5, 0.85];
  const table = normalTableFor(model.normalsMode);
  const pts: SplatPoint[] = [];
  for (const part of model.parts) {
    const partShift = part.role === 'body' ? 0 : (model.turretOffset ?? 0) / 8;
    for (const s of part.sections) {
      const vox = fromB64(s.voxels);
      const t = s.transform;
      const sc = [0, 1, 2].map((k) => (s.maxBounds[k]! - s.minBounds[k]!) / Math.max(1, s.size[k]!));
      for (let i = 0; i < vox.length; i += 5) {
        const p = [0, 1, 2].map((k) => s.minBounds[k]! + (vox[i + k]! + 0.5) * sc[k]!);
        const wx = t[0]! * p[0]! + t[1]! * p[1]! + t[2]! * p[2]! + t[3]! + partShift;
        const wy = t[4]! * p[0]! + t[5]! * p[1]! + t[6]! * p[2]! + t[7]!;
        const wz = t[8]! * p[0]! + t[9]! * p[1]! + t[10]! * p[2]! + t[11]!;
        // Model (front x, left y) -> cell space.
        const cx = (wx * fx + wy * fy) * 8;
        const cy = (wx * fy - wy * fx) * 8;
        const n = lookupNormal(table, vox[i + 4]!);
        pts.push({
          x: ((cx - cy) * 30) / 256,
          y: ((cx + cy) * 15) / 256 - (wz * 8 * 15) / 104,
          d: cx + cy + wz * 0.01,
          index: vox[i + 3]!,
          lum: 0.55 + 0.45 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]),
        });
      }
    }
  }
  pts.sort((a, b) => a.d - b.d);
  return pts;
}
