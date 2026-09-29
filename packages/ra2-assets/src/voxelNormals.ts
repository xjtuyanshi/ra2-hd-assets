/**
 * Which normal table a voxel section uses (pure, browser-safe).
 *
 * Every VXL section names its own table in its tailer (normalsMode 2 = the Tiberian Sun table of 36 normals, 4 = the
 * Red Alert 2 table of 244), and the engine decodes each section with its own. Models do mix them: in the stock YR
 * 1.001 install the Rhino (HTNK), Flak Track (HTK), Lasher (LTNK), UTNK and XCOMET have body and turret/barrel
 * sections of different modes. Caches extracted before VoxelSection.normalsMode was recorded carry only one mode per
 * model (the last section's), which decoded the Rhino's hull with the wrong table: normals pointing into the hull made
 * its top plates render dark instead of near white.
 *
 * For such sections the mode is inferred from the data: the stored normals of surface voxels point out through their
 * open faces with the right table and nearly at random with the wrong one. Checked against the install on all 129
 * sections of the 94 type-library voxel models: the inference matches the tailer on every one.
 */
import { lookupNormal, normalTableFor } from '../../ra2-formats/src/index';
import type { VoxelSection } from './manifest';

export type NormalsMode = 2 | 4;

/**
 * Normals mode of a section from its voxels (x, y, z, colour, normal quintuples): the table whose normals agree best
 * with the open faces of surface voxels. Falls back to `fallback` when no voxel has an open face.
 */
export function inferNormalsMode(
  size: readonly [number, number, number],
  voxels: Uint8Array,
  fallback: NormalsMode = 4,
): NormalsMode {
  const [sx, sy, sz] = size;
  const px = sx + 2;
  const pxy = px * (sy + 2);
  const cell = (x: number, y: number, z: number) => x + 1 + px * (y + 1) + pxy * (z + 1);
  const filled = new Uint8Array(pxy * (sz + 2));
  for (let i = 0; i < voxels.length; i += 5) filled[cell(voxels[i]!, voxels[i + 1]!, voxels[i + 2]!)] = 1;
  const ts = normalTableFor(2);
  const ra2 = normalTableFor(4);
  let agreeTs = 0;
  let agreeRa2 = 0;
  let count = 0;
  for (let i = 0; i < voxels.length; i += 5) {
    const k = cell(voxels[i]!, voxels[i + 1]!, voxels[i + 2]!);
    // Outward direction: the sum of this voxel's open faces.
    const dx = (filled[k + 1] ? 0 : 1) - (filled[k - 1] ? 0 : 1);
    const dy = (filled[k + px] ? 0 : 1) - (filled[k - px] ? 0 : 1);
    const dz = (filled[k + pxy] ? 0 : 1) - (filled[k - pxy] ? 0 : 1);
    const length = Math.hypot(dx, dy, dz);
    if (!length) continue;
    const a = lookupNormal(ts, voxels[i + 4]!);
    const b = lookupNormal(ra2, voxels[i + 4]!);
    agreeTs += (a[0] * dx + a[1] * dy + a[2] * dz) / length;
    agreeRa2 += (b[0] * dx + b[1] * dy + b[2] * dz) / length;
    count++;
  }
  if (!count || agreeTs === agreeRa2) return fallback;
  return agreeTs > agreeRa2 ? 2 : 4;
}

/** The section's normals mode: as recorded by the extractor, else inferred from its voxels (decoded by the caller). */
export function sectionNormalsMode(section: Pick<VoxelSection, 'normalsMode' | 'size'>, voxels: Uint8Array): number {
  return section.normalsMode ?? inferNormalsMode(section.size, voxels);
}
