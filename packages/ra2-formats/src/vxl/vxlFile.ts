// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/vxl_file.cpp,
// misc/vxl_file.h, misc/cc_structures.h.
//
// Parser for the Westwood VXL voxel model container used by Red Alert 2 /
// Yuri's Revenge and Tiberian Sun. A .vxl holds one or more voxel "sections"
// (body / turret / barrel), each a dense 3D grid of colored, surface-normalled
// voxels stored as run-length-encoded columns.
//
// FILE LAYOUT (all little-endian):
//
//   header (802 bytes) — t_vxl_header:
//     char   id[16]              "Voxel Animation\0" (padded)
//     int32  one                 always 1
//     uint32 sectionHeaderCount  number of section headers
//     uint32 sectionTailerCount  number of section tailers (== headers)
//     uint32 bodySize            byte length of the span-body block
//     int16  unknown             always 0x1f10
//     palette[256*3]             embedded 8-bit RGB palette (768 bytes)
//
// The embedded palette is a PREVIEW palette (full 8-bit channels, verified 0..255
// in retail htnk/harv/smcv.vxl — it is NOT 6-bit VGA like a .pal). The RA2 engine
// draws voxels with the theater UNIT palette (unittem.pal) keyed by the voxel's
// `color` index, not with this embedded palette; we expose the embedded bytes
// verbatim for tooling/debugging and leave the final color resolution to the
// renderer (which uses unittem.pal per the stage spec).
//
//   sectionHeaderCount * section header (28 bytes) — t_vxl_section_header:
//     char   id[16]              section name (e.g. "DUMMY01")
//     int32  index               section index
//     int32  one                 always 1
//     int32  zero                always 0
//
//   body block (bodySize bytes): for each section, in tailer order,
//     spanStartList  cx*cy int32 — byte offset (from spanDataOfs) of each
//                    column's span data, or -1 if the column is empty
//     spanEndList    cx*cy int32 — end offsets (parallel to spanStartList)
//     spanData       the RLE voxel bytes the two lists point into
//
//   sectionTailerCount * section tailer (92 bytes) — t_vxl_section_tailer:
//     int32  spanStartOfs        offset (within body block) of this section's
//     int32  spanEndOfs          span-start list / span-end list / span data.
//     int32  spanDataOfs
//     float  scale               voxel -> world scale
//     float  transform[3][4]     section transform (row-major 3x4)
//     float  minBounds[3]        model bounding box (x,y,z) min
//     float  maxBounds[3]        and max
//     uint8  cx, cy, cz          voxel grid dimensions
//     uint8  normalsMode         normal class (2 = TS table, 4 = RA2 table)
//
// SPAN RLE (per column, XCC vxl_file.cpp extract_as_text):
//   z = 0
//   while z < cz:
//     z += skip          // skip byte: this many empty voxels up the column
//     count = next byte  // this many solid voxels follow
//     repeat count times: read (color, normal) byte pair; z += 1
//     read one trailing byte (a duplicate count; ignored)
//
// The parser validates the header the same way XCC's is_valid() does (id, the
// `one` field, header==tailer count, the body-size identity, and the 0x1f10
// magic), then exposes decoded voxels per section.

import { normalTableFor, lookupNormal, type NormalVec } from './vxlNormals.js';

/** Size in bytes of the VXL file header (id + counts + magic + palette). */
export const VXL_HEADER_SIZE = 802;
/** Size in bytes of each per-section header. */
export const VXL_SECTION_HEADER_SIZE = 28;
/** Size in bytes of each per-section tailer. */
export const VXL_SECTION_TAILER_SIZE = 92;
/** The fixed `id` string a VXL header carries (before NUL padding). */
export const VXL_ID = 'Voxel Animation';
/** The fixed `unknown` magic in the header (t_vxl_header.unknown). */
export const VXL_MAGIC = 0x1f10;
/** Number of palette entries embedded in a VXL header. */
export const VXL_PALETTE_ENTRIES = 256;

/**
 * One decoded solid voxel: its grid coordinate, palette color index, and the
 * surface-normal index into the section's normal table.
 */
export interface Voxel {
  /** Grid X (0..cx-1). */
  readonly x: number;
  /** Grid Y (0..cy-1). */
  readonly y: number;
  /** Grid Z (0..cz-1). */
  readonly z: number;
  /** Palette color index (0..255) into the file's embedded palette. */
  readonly color: number;
  /** Surface-normal index into the section's normal table (see normalsMode). */
  readonly normal: number;
}

/** Parsed metadata + decoded voxels for one VXL section. */
export interface VxlSection {
  /** Section index (file order). */
  readonly index: number;
  /** Section name (e.g. "DUMMY01"). */
  readonly name: string;
  /** Voxel grid width. */
  readonly cx: number;
  /** Voxel grid depth. */
  readonly cy: number;
  /** Voxel grid height. */
  readonly cz: number;
  /** Voxel -> world uniform scale from the tailer. */
  readonly scale: number;
  /**
   * The section transform as a row-major 3x4 matrix (12 floats): rows are
   * `[m00 m01 m02 m03][m10 m11 m12 m13][m20 m21 m22 m23]`, the last column being
   * translation. Applied together with the HVA per-frame matrix.
   */
  readonly transform: readonly number[];
  /** Bounding-box minimum (x, y, z) in world units. */
  readonly minBounds: readonly [number, number, number];
  /** Bounding-box maximum (x, y, z) in world units. */
  readonly maxBounds: readonly [number, number, number];
  /** Normal class selecting which normal table lights this section (2 or 4). */
  readonly normalsMode: number;
  /**
   * The solid voxels, in column-scan order (x fastest within a y row). Empty
   * columns contribute nothing.
   */
  readonly voxels: readonly Voxel[];
}

/** A single embedded palette entry (raw 8-bit RGB channels, 0..255). */
export interface VxlPaletteEntry {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * A parsed VXL file. Holds the header palette and every section's metadata +
 * decoded voxels. Parse with {@link parse}.
 */
export class VxlFile {
  private constructor(
    /** The embedded 256-entry preview palette (raw 8-bit RGB channels). */
    readonly palette: readonly VxlPaletteEntry[],
    /** The decoded sections. */
    readonly sections: readonly VxlSection[],
  ) {}

  /** Number of sections in the model. */
  get sectionCount(): number {
    return this.sections.length;
  }

  /**
   * Resolve a voxel's lit normal vector from a section's normal table. Convenience
   * over calling {@link normalTableFor}/{@link lookupNormal} directly.
   */
  static normalVec(section: VxlSection, normalIndex: number): NormalVec {
    return lookupNormal(normalTableFor(section.normalsMode), normalIndex);
  }

  /**
   * Parse a VXL byte buffer. Throws on a malformed file (bad id/magic, mismatched
   * section counts, a body-size identity violation, or truncation).
   */
  static parse(bytes: Uint8Array): VxlFile {
    if (bytes.length < VXL_HEADER_SIZE) {
      throw new Error(`VXL too small: ${bytes.length} < ${VXL_HEADER_SIZE} byte header`);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const id = decodeCString(bytes.subarray(0, 16));
    if (id !== VXL_ID) {
      throw new Error(`not a VXL: id is '${id}', expected '${VXL_ID}'`);
    }
    const one = dv.getInt32(16, true);
    const sectionHeaderCount = dv.getUint32(20, true);
    const sectionTailerCount = dv.getUint32(24, true);
    const bodySize = dv.getUint32(28, true);
    const magic = dv.getUint16(32, true);

    if (one !== 1) throw new Error(`VXL header 'one' field is ${one}, expected 1`);
    if (magic !== VXL_MAGIC) {
      throw new Error(`VXL header magic is 0x${magic.toString(16)}, expected 0x${VXL_MAGIC.toString(16)}`);
    }
    if (sectionHeaderCount !== sectionTailerCount) {
      throw new Error(
        `VXL section header/tailer count mismatch: ${sectionHeaderCount} != ${sectionTailerCount}`,
      );
    }

    // Header body-size identity (mirrors XCC is_valid): the declared body size
    // must equal the file minus the fixed header and the header/tailer blocks.
    const expectedBody =
      bytes.length -
      VXL_HEADER_SIZE -
      sectionHeaderCount * VXL_SECTION_HEADER_SIZE -
      sectionTailerCount * VXL_SECTION_TAILER_SIZE;
    if (bodySize !== expectedBody) {
      throw new Error(
        `VXL body-size mismatch: header says ${bodySize}, layout implies ${expectedBody}`,
      );
    }

    // Palette: 256 RGB triples at offset 34 (raw 8-bit RGB preview channels — see
    // the file-header note above; NOT 6-bit VGA like a .pal).
    const palette: VxlPaletteEntry[] = new Array<VxlPaletteEntry>(VXL_PALETTE_ENTRIES);
    for (let i = 0; i < VXL_PALETTE_ENTRIES; i++) {
      const p = 34 + i * 3;
      palette[i] = { r: bytes[p]!, g: bytes[p + 1]!, b: bytes[p + 2]! };
    }

    const headersStart = VXL_HEADER_SIZE;
    const bodyStart = headersStart + sectionHeaderCount * VXL_SECTION_HEADER_SIZE;
    const tailersStart = bodyStart + bodySize;
    if (tailersStart + sectionTailerCount * VXL_SECTION_TAILER_SIZE > bytes.length) {
      throw new Error('VXL truncated: section tailers run past end of file');
    }

    const sections: VxlSection[] = [];
    for (let i = 0; i < sectionHeaderCount; i++) {
      const hp = headersStart + i * VXL_SECTION_HEADER_SIZE;
      const name = decodeCString(bytes.subarray(hp, hp + 16));

      const tp = tailersStart + i * VXL_SECTION_TAILER_SIZE;
      const spanStartOfs = dv.getInt32(tp, true);
      const spanEndOfs = dv.getInt32(tp + 4, true);
      const spanDataOfs = dv.getInt32(tp + 8, true);
      const scale = dv.getFloat32(tp + 12, true);
      const transform: number[] = new Array<number>(12);
      for (let k = 0; k < 12; k++) transform[k] = dv.getFloat32(tp + 16 + k * 4, true);
      const minBounds: [number, number, number] = [
        dv.getFloat32(tp + 64, true),
        dv.getFloat32(tp + 68, true),
        dv.getFloat32(tp + 72, true),
      ];
      const maxBounds: [number, number, number] = [
        dv.getFloat32(tp + 76, true),
        dv.getFloat32(tp + 80, true),
        dv.getFloat32(tp + 84, true),
      ];
      const cx = bytes[tp + 88]!;
      const cy = bytes[tp + 89]!;
      const cz = bytes[tp + 90]!;
      const normalsMode = bytes[tp + 91]!;

      const voxels = decodeSection(
        dv,
        bytes,
        bodyStart,
        { spanStartOfs, spanEndOfs, spanDataOfs, cx, cy, cz },
      );

      sections.push({
        index: i,
        name,
        cx,
        cy,
        cz,
        scale,
        transform,
        minBounds,
        maxBounds,
        normalsMode,
        voxels,
      });
    }

    return new VxlFile(palette, sections);
  }
}

/** The per-section offsets/dims needed to decode its span columns. */
interface SectionSpanInfo {
  readonly spanStartOfs: number;
  readonly spanEndOfs: number;
  readonly spanDataOfs: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/**
 * Decode one section's RLE columns into solid voxels. Offsets are relative to the
 * body block start. Mirrors XCC's span-walk exactly: per column, alternately skip
 * empty voxels and read `count` (color, normal) pairs, consuming a trailing count
 * byte, until the whole `cz` column is covered.
 */
function decodeSection(
  dv: DataView,
  bytes: Uint8Array,
  bodyStart: number,
  info: SectionSpanInfo,
): Voxel[] {
  const { spanStartOfs, spanDataOfs, cx, cy, cz } = info;
  const startList = bodyStart + spanStartOfs;
  const dataBase = bodyStart + spanDataOfs;
  const voxels: Voxel[] = [];

  let column = 0;
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < cx; x++, column++) {
      const spanOffset = dv.getInt32(startList + column * 4, true);
      // -1 marks an empty column (no span data).
      if (spanOffset === -1) continue;

      let r = dataBase + spanOffset;
      let z = 0;
      while (z < cz) {
        // Skip empty voxels.
        z += bytes[r++]!;
        // Read `count` solid voxels as (color, normal) pairs.
        let count = bytes[r++]!;
        while (count-- > 0) {
          const color = bytes[r++]!;
          const normal = bytes[r++]!;
          if (z < cz) voxels.push({ x, y, z, color, normal });
          z++;
        }
        // Trailing duplicate-count byte (ignored, matching XCC).
        r++;
      }
    }
  }
  return voxels;
}

/** Decode a fixed-width, NUL-terminated latin1 C string field. */
function decodeCString(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end === -1) end = field.length;
  return new TextDecoder('latin1').decode(field.subarray(0, end));
}
