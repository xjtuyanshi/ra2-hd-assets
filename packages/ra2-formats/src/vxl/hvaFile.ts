// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/hva_file.cpp,
// misc/hva_file.h, misc/cc_structures.h.
//
// Parser for the HVA animation file that accompanies a VXL model. An .hva holds,
// per animation FRAME and per VXL SECTION, a 3x4 transform matrix that positions
// (and animates) that section. For a body-only vehicle there is a single section
// and a single frame; turreted or barreled models carry more.
//
// FILE LAYOUT (all little-endian) — t_hva_header + bodies:
//
//   header (24 bytes):
//     char   id[16]        name (often "NONE" or the model name; padded)
//     int32  frameCount
//     int32  sectionCount
//
//   sectionCount * 16-byte section name (parallel to the VXL section order)
//
//   per-frame, per-section 3x4 float matrices, stored FRAME-major:
//     matrix[12*(sectionCount*j + i) + x + 4*y]  for section i, frame j
//     i.e. every section's matrix for frame 0, then all sections of frame 1, ...
//   (Local fix, see NOTICE.md: upstream read [section][frame], which swaps
//   sections' matrices on multi-section, multi-frame files such as ytnktur.hva.
//   The real files are frame-major, as read by XCC, OpenRA and Chrono Divide.)
//   Each matrix is a row-major 3x4 (12 floats): three rows of
//     [m00 m01 m02 m03][m10 m11 m12 m13][m20 m21 m22 m23]
//   the last column being translation (in VXL voxel units; scale by the section
//   tailer's scale + bounds to get world coordinates, as the retail renderer does).
//
// XCC's is_valid() checks the exact size identity
//   sizeof(header) + (48*frameCount + 16) * sectionCount == fileSize
// which this parser reproduces.

/** Size in bytes of the HVA header (id + frameCount + sectionCount). */
export const HVA_HEADER_SIZE = 24;
/** Size in bytes of each section-name field. */
export const HVA_SECTION_NAME_SIZE = 16;
/** Size in bytes of one 3x4 float transform matrix (12 * 4). */
export const HVA_MATRIX_SIZE = 48;

/**
 * A parsed HVA animation. Exposes the per-frame, per-section transform matrices.
 * Parse with {@link parse}.
 */
export class HvaFile {
  private constructor(
    /** Animation frame count. */
    readonly frameCount: number,
    /** Section count (parallels the VXL's sections). */
    readonly sectionCount: number,
    /** Section names in order (16-byte fields, NUL-trimmed). */
    readonly sectionNames: readonly string[],
    /**
     * Matrix store: `matrices[section][frame]` is a length-12 row-major 3x4
     * matrix (regrouped from the file's frame-major order).
     */
    private readonly matrices: readonly (readonly (readonly number[])[])[],
  ) {}

  /**
   * The 3x4 transform matrix (12 floats, row-major) for `section` at `frame`.
   * Throws if either index is out of range.
   */
  matrix(section: number, frame: number): readonly number[] {
    const s = this.matrices[section];
    if (!s) throw new RangeError(`HVA section index out of range: ${section}`);
    const m = s[frame];
    if (!m) throw new RangeError(`HVA frame index out of range: ${frame}`);
    return m;
  }

  /**
   * Parse an HVA byte buffer. Throws on a malformed file (zero frames/sections or
   * the XCC size identity failing / truncation).
   */
  static parse(bytes: Uint8Array): HvaFile {
    if (bytes.length < HVA_HEADER_SIZE) {
      throw new Error(`HVA too small: ${bytes.length} < ${HVA_HEADER_SIZE} byte header`);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameCount = dv.getInt32(16, true);
    const sectionCount = dv.getInt32(20, true);
    if (frameCount <= 0) throw new Error(`HVA frameCount is ${frameCount}, expected > 0`);
    if (sectionCount <= 0) throw new Error(`HVA sectionCount is ${sectionCount}, expected > 0`);

    // XCC size identity: header + (48*frames + 16) * sections == fileSize.
    const expected = HVA_HEADER_SIZE + (HVA_MATRIX_SIZE * frameCount + HVA_SECTION_NAME_SIZE) * sectionCount;
    if (expected !== bytes.length) {
      throw new Error(`HVA size mismatch: layout implies ${expected}, file is ${bytes.length}`);
    }

    // Section names.
    const namesStart = HVA_HEADER_SIZE;
    const sectionNames: string[] = new Array<string>(sectionCount);
    for (let i = 0; i < sectionCount; i++) {
      const p = namesStart + i * HVA_SECTION_NAME_SIZE;
      sectionNames[i] = decodeCString(bytes.subarray(p, p + HVA_SECTION_NAME_SIZE));
    }

    // Matrices, stored frame-major in the file (all sections of frame 0 first).
    const matricesStart = namesStart + sectionCount * HVA_SECTION_NAME_SIZE;
    const matrices: number[][][] = new Array<number[][]>(sectionCount);
    for (let i = 0; i < sectionCount; i++) {
      const perFrame: number[][] = new Array<number[]>(frameCount);
      for (let j = 0; j < frameCount; j++) {
        const base = matricesStart + (sectionCount * j + i) * HVA_MATRIX_SIZE;
        const m: number[] = new Array<number>(12);
        for (let k = 0; k < 12; k++) m[k] = dv.getFloat32(base + k * 4, true);
        perFrame[j] = m;
      }
      matrices[i] = perFrame;
    }

    return new HvaFile(frameCount, sectionCount, sectionNames, matrices);
  }
}

/** Decode a fixed-width, NUL-terminated latin1 C string field. */
function decodeCString(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end === -1) end = field.length;
  return new TextDecoder('latin1').decode(field.subarray(0, end));
}
