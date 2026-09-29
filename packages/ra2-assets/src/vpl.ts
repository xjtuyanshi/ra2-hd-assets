/**
 * Voxel lighting table (voxels.vpl) and the sidecar the HD renderer reads (contract only; no Node APIs here).
 *
 * The engine shades a voxel by picking one of `sectionCount` lookup rows from how much its normal faces the voxel light,
 * then remapping the voxel's palette index through that row: row `sectionCount / 4` is (almost) the identity, lower rows
 * darken towards the shadow side and higher rows brighten, up to white. The remap is what makes original vehicles read
 * brighter than their raw palette colours and gives them their crisp, painted highlights.
 *
 * File layout (little endian): 16-byte header { remapStart, remapEnd, sectionCount, unknown } (u32 each), a 768-byte
 * palette (unused by the engine's unit drawing), then `sectionCount` rows of 256 palette indices.
 *
 * Sidecar written by `pnpm hd:materials` into <library>/common/: voxels-vpl.png (256 x sectionCount, 8-bit greyscale,
 * pixel (i, s) = the remapped index of palette index i in section s) and voxels-vpl.json (VoxelLightingFile).
 */
export const VPL_HEADER_BYTES = 16;
export const VPL_PALETTE_BYTES = 768;

export interface VplTable {
  remapStart: number;
  remapEnd: number;
  sectionCount: number;
  /** The fourth header word; its meaning is not known (0xCDCDCDCD in the retail file). */
  unknown: number;
  /** 256 RGB triples as stored (0-255 or 6-bit values; not used for rendering). */
  palette: Uint8Array;
  /** sectionCount x 256 palette indices, row-major by section. */
  table: Uint8Array;
}

/** Parse voxels.vpl; throws on a truncated or inconsistent file rather than guessing. */
export function parseVpl(bytes: Uint8Array): VplTable {
  if (bytes.byteLength < VPL_HEADER_BYTES + VPL_PALETTE_BYTES)
    throw new Error(`voxels.vpl: ${bytes.byteLength} bytes is shorter than its header and palette`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remapStart = view.getUint32(0, true);
  const remapEnd = view.getUint32(4, true);
  const sectionCount = view.getUint32(8, true);
  const unknown = view.getUint32(12, true);
  if (sectionCount < 1 || sectionCount > 256) throw new Error(`voxels.vpl: implausible section count ${sectionCount}`);
  const expected = VPL_HEADER_BYTES + VPL_PALETTE_BYTES + sectionCount * 256;
  if (bytes.byteLength < expected)
    throw new Error(`voxels.vpl: ${bytes.byteLength} bytes, ${expected} needed for ${sectionCount} sections`);
  const start = VPL_HEADER_BYTES + VPL_PALETTE_BYTES;
  return {
    remapStart,
    remapEnd,
    sectionCount,
    unknown,
    palette: bytes.slice(VPL_HEADER_BYTES, start),
    table: bytes.slice(start, start + sectionCount * 256),
  };
}

/**
 * How the engine turns a voxel normal into a section (YR 1.001 @0x7586F0, see the renderer's ra2/vpl.ts):
 * section = int(sectionScale * (max(0, N.L) + max(0, b / (p - (p - 1) b)))) with b = N.H, H = normalize(L + up) and
 * `up` the model's own up axis. Recorded with the table for reference; the renderer carries the same engine constants.
 */
export interface VoxelLightingFit {
  /** Light direction in HD world axes (x = map x, y = up, z = map y); absent = the renderer's derived default. */
  light?: [number, number, number];
  /** Sections per unit of shade (the engine's 16.0). */
  sectionScale?: number;
  /** The highlight parameter p (the engine's 3.0). */
  specular?: number;
  /** Earlier linear fit (section = bias + scale * N.L), written by older versions; ignored by the renderer. */
  bias?: number;
  scale?: number;
  /** Where the numbers come from. */
  source: string;
}

export interface VoxelLightingFile {
  version: 1;
  /** Source file inside the install. */
  source: string;
  header: { remapStart: number; remapEnd: number; sectionCount: number; unknown: number };
  /** The table image next to this file. */
  table: { file: string; width: 256; height: number };
  fit: VoxelLightingFit;
}
