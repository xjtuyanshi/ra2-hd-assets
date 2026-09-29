/** Builder from 4695ab2, frozen as a synthetic equivalence oracle; never used by production. */
import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { lookupNormal, normalTableFor } from '../../../ra2-formats/src/index';
import type { VoxelSection } from '../../../ra2-assets/src/manifest';
import { sectionNormalsMode } from '../../../ra2-assets/src/voxelNormals';
import { VOXEL_TO_WORLD, voxelShape } from '../../src/ra2/voxels';
import { decodeBase64 } from '../../src/ra2/cache';

const FACES: { dir: [number, number, number]; corners: [number, number, number][] }[] = [
  {
    dir: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    dir: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    dir: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    dir: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    dir: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
  {
    dir: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
];

/** Padded-cell offset of the voxel just outside each face, for row pitch px and slice pitch pxy. */
const FACE_OFFSET = FACES.map(
  ({ dir: [dx, dy, dz] }) =>
    (px: number, pxy: number) =>
      dx + px * dy + pxy * dz,
);

/**
 * Per face and corner, the two in-plane unit steps (towards the corner along each of the face's two lattice axes) whose
 * cells, with their diagonal, decide that corner's ambient occlusion.
 */
const FACE_AO = FACES.map((face) => {
  const axes = [0, 1, 2].filter((a) => face.dir[a] === 0);
  return face.corners.map((corner) => {
    const u: [number, number, number] = [0, 0, 0];
    const w: [number, number, number] = [0, 0, 0];
    u[axes[0]!] = corner[axes[0]!] ? 1 : -1;
    w[axes[1]!] = corner[axes[1]!] ? 1 : -1;
    return [u, w] as const;
  });
});

/** The 26-neighbourhood (normal blending weighs each by normalBlend / distance). */
const NEIGHBOURS: [number, number, number][] = [];
for (let dz = -1; dz <= 1; dz++)
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) NEIGHBOURS.push([dx, dy, dz]);

/*
 * Model-local frame used by the renderer: +x forward (the vehicle's nose), +y up, +z to the vehicle's right. Voxel
 * space is +X forward, +Y to the left, +Z up, so (X, Y, Z) maps to (x, z, -y), a proper rotation (no mirror), scaled by
 * VOXEL_TO_WORLD for positions.
 */

/**
 * Build-time shape refinement (once per model, shared by every house colour; no per-frame cost):
 * - cornerRelax: each lattice corner moves this far towards the centroid of the occupancy-edge crossings of its
 *   2x2x2 neighbourhood (surface nets), rounding the stair-stepped cubes that read as "old 3D" when one voxel covers
 *   several screen pixels. Kept at or below 0.7 so one-voxel features (antennas, barrels) survive.
 * - normalBlend: each stored normal is blended with its exposed neighbours' (weight / distance). The engine shades
 *   every voxel by its own stored normal (vpl.ts); blending calms the per-voxel mottling at HD zoom but flattens the
 *   original's highlights and creases, so it stays small.
 * - Occlusion per corner from the three outside neighbours touching it (AO_LEVELS), stored raw in the 'occlusion'
 *   attribute; the material applies it with its own strength (vpl.ts voxelOcclusion).
 * Review tooling may change these before the first model is built (geometry is cached per model).
 */
const AO_LEVELS = [0.35, 0.6, 0.8, 1] as const;

export function buildLegacyPartGeometry(sections: readonly VoxelSection[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const pindices: number[] = [];
  const occlusion: number[] = [];
  const indices: number[] = [];
  for (const section of sections) addSection(section);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('pindex', new BufferAttribute(new Float32Array(pindices), 1));
  geometry.setAttribute('occlusion', new BufferAttribute(new Float32Array(occlusion), 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;

  function addSection(section: VoxelSection) {
    const raw = decodeBase64(section.voxels);
    // Each section has its own normal table; models such as the Rhino mix them (see voxelNormals.ts).
    const table = normalTableFor(sectionNormalsMode(section, raw));
    const [sx, sy, sz] = section.size;
    // Dense occupancy with a two-voxel empty border, so every lookup below (neighbours of a face's outside voxel
    // included) stays in range without bounds checks.
    const px = sx + 4;
    const py = sy + 4;
    const pxy = px * py;
    const cell = (x: number, y: number, z: number) => x + 2 + px * (y + 2 + py * (z + 2));
    const filled = new Uint8Array(pxy * (sz + 4));
    for (let i = 0; i < raw.length; i += 5) filled[cell(raw[i]!, raw[i + 1]!, raw[i + 2]!)] = 1;
    const step0 = (section.maxBounds[0] - section.minBounds[0]) / Math.max(1, sx);
    const step1 = (section.maxBounds[1] - section.minBounds[1]) / Math.max(1, sy);
    const step2 = (section.maxBounds[2] - section.minBounds[2]) / Math.max(1, sz);
    const m = section.transform;

    // Surface-nets corner offsets (voxel units), cached per lattice corner so neighbouring faces stay watertight.
    const cx1 = sx + 1;
    const cy1 = sy + 1;
    const cornerDone = new Uint8Array(cx1 * cy1 * (sz + 1));
    const cornerOff = new Float32Array(cornerDone.length * 3);
    const cornerOffset = (cx: number, cy: number, cz: number): number => {
      const k = cx + cx1 * (cy + cy1 * cz);
      if (cornerDone[k]) return k * 3;
      let n = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      const o = cell(cx - 1, cy - 1, cz - 1);
      const v = (dx: number, dy: number, dz: number) => filled[o + dx + px * dy + pxy * dz];
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          if (v(0, a, b) !== v(1, a, b)) {
            ay += a - 0.5;
            az += b - 0.5;
            n++;
          }
          if (v(a, 0, b) !== v(a, 1, b)) {
            ax += a - 0.5;
            az += b - 0.5;
            n++;
          }
          if (v(a, b, 0) !== v(a, b, 1)) {
            ax += a - 0.5;
            ay += b - 0.5;
            n++;
          }
        }
      }
      if (n) {
        cornerOff[k * 3] = ax / n;
        cornerOff[k * 3 + 1] = ay / n;
        cornerOff[k * 3 + 2] = az / n;
      }
      cornerDone[k] = 1;
      return k * 3;
    };

    // Stored normals of exposed voxels, for neighbour blending (dense, by padded cell; unset = not exposed).
    const exposedNormal = new Float32Array(filled.length * 3);
    const isExposed = new Uint8Array(filled.length);
    for (let i = 0; i < raw.length; i += 5) {
      const k = cell(raw[i]!, raw[i + 1]!, raw[i + 2]!);
      if (filled[k + 1] && filled[k - 1] && filled[k + px] && filled[k - px] && filled[k + pxy] && filled[k - pxy])
        continue;
      const n = lookupNormal(table, raw[i + 4]!);
      exposedNormal[k * 3] = n[0];
      exposedNormal[k * 3 + 1] = n[1];
      exposedNormal[k * 3 + 2] = n[2];
      isExposed[k] = 1;
    }
    const neighbourOffsets = NEIGHBOURS.map(([dx, dy, dz]) => dx + px * dy + pxy * dz);
    const neighbourWeights = NEIGHBOURS.map(([dx, dy, dz]) => voxelShape.normalBlend / Math.hypot(dx, dy, dz));
    const relax = voxelShape.cornerRelax;

    for (let i = 0; i < raw.length; i += 5) {
      const vx = raw[i]!;
      const vy = raw[i + 1]!;
      const vz = raw[i + 2]!;
      const c = raw[i + 3]!;
      const own = lookupNormal(table, raw[i + 4]!);
      const k = cell(vx, vy, vz);
      let bx = own[0];
      let by = own[1];
      let bz = own[2];
      for (let j = 0; j < neighbourOffsets.length; j++) {
        const q = k + neighbourOffsets[j]!;
        if (!isExposed[q]) continue;
        const w = neighbourWeights[j]!;
        bx += exposedNormal[q * 3]! * w;
        by += exposedNormal[q * 3 + 1]! * w;
        bz += exposedNormal[q * 3 + 2]! * w;
      }
      // Rotate by the section transform, then voxel (X fwd, Y left, Z up) to model (x fwd, y up, z right).
      const rx = m[0]! * bx + m[1]! * by + m[2]! * bz;
      const ry = m[4]! * bx + m[5]! * by + m[6]! * bz;
      const rz = m[8]! * bx + m[9]! * by + m[10]! * bz;
      const nl = Math.hypot(rx, ry, rz) || 1;
      const nx0 = rx / nl;
      const ny0 = rz / nl;
      const nz0 = -ry / nl;
      for (let f = 0; f < FACES.length; f++) {
        const face = FACES[f]!;
        const outside = k + FACE_OFFSET[f]!(px, pxy);
        if (filled[outside]) continue;
        const base = positions.length / 3;
        for (let corner = 0; corner < 4; corner++) {
          const [cx, cy, cz] = face.corners[corner]!;
          const o = cornerOffset(vx + cx, vy + cy, vz + cz);
          const bxp = section.minBounds[0] + (vx + cx + relax * cornerOff[o]!) * step0;
          const byp = section.minBounds[1] + (vy + cy + relax * cornerOff[o + 1]!) * step1;
          const bzp = section.minBounds[2] + (vz + cz + relax * cornerOff[o + 2]!) * step2;
          const X = m[0]! * bxp + m[1]! * byp + m[2]! * bzp + m[3]!;
          const Y = m[4]! * bxp + m[5]! * byp + m[6]! * bzp + m[7]!;
          const Z = m[8]! * bxp + m[9]! * byp + m[10]! * bzp + m[11]!;
          positions.push(X * VOXEL_TO_WORLD, Z * VOXEL_TO_WORLD, -Y * VOXEL_TO_WORLD);
          // The engine lights a voxel by its stored normal, not its cube faces: this keeps the smooth retail look.
          normals.push(nx0, ny0, nz0);
          pindices.push(c);
          // Corner ambient occlusion: the two edge neighbours and the diagonal one, just outside this face.
          const [u, w] = FACE_AO[f]![corner]!;
          const s1 = filled[outside + u[0] + px * u[1] + pxy * u[2]]!;
          const s2 = filled[outside + w[0] + px * w[1] + pxy * w[2]]!;
          const sc = filled[outside + u[0] + w[0] + px * (u[1] + w[1]) + pxy * (u[2] + w[2])]!;
          const level = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
          occlusion.push(1 - AO_LEVELS[level]!);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
}
