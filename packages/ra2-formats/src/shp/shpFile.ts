// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/shp_ts_file.h, misc/cc_structures.h
//
// Parser for the SHP(TS) sprite container used by Red Alert 2 / Yuri's Revenge
// and Tiberian Sun. Layout:
//
//   file header (8 bytes):
//     uint16 zero        always 0 in TS/RA2 SHPs (distinguishes from Dune2 SHP)
//     uint16 cx          bounding-box width of the sprite
//     uint16 cy          bounding-box height
//     uint16 c_images    frame count
//
//   c_images * frame header (24 bytes each):
//     int16  x           frame's left offset within the cx*cy bounding box
//     int16  y           frame's top offset
//     int16  cx          frame width
//     int16  cy          frame height
//     int32  compression codec selector (see ShpCompression; the RLE bit,
//                        compression & 2, selects per-row RLE vs. raw)
//     int32  unknown     (radar/zero color hint in XCC; unused here)
//     int32  zero
//     int32  offset      absolute byte offset of the frame body in the file
//
// A frame with offset 0 (or cx*cy == 0) is empty: some SHPs carry placeholder
// frames with no pixel data. We surface those as zero-sized frames rather than
// throwing, matching how the game skips them.

import { decodeFrame, ShpCompression } from './shpDecode.js';

/** Size in bytes of the SHP(TS) file header. */
export const SHP_HEADER_SIZE = 8;
/** Size in bytes of each per-frame header. */
export const SHP_FRAME_HEADER_SIZE = 24;

/**
 * Absolute per-frame pixel ceiling (4096*4096 = 16M). A frame's decode buffer is
 * `cx*cy` bytes allocated BEFORE its (possibly corrupt/truncated) body is validated,
 * so an unbounded int16 `cx`/`cy` (max 32767 each ≈ 1 GB) lets a single crafted or
 * truncated frame header trigger a gigabyte allocation inside the dev asset route
 * (a mounted-but-corrupt MIX would OOM the server). Real RA2 SHPs never approach this
 * ceiling — the largest building sprites are a few hundred px per side — so rejecting
 * anything larger changes nothing for valid data while bounding the worst case.
 */
export const MAX_SHP_FRAME_PIXELS = 4096 * 4096;

/**
 * Player-remap palette index range for SHP art (re-exported from the palette
 * layer). Palette indices {@link REMAP_INDEX_START}..{@link REMAP_INDEX_END}
 * (16..31) are replaced with the owning player's house color at draw time.
 */
export { REMAP_INDEX_START, REMAP_INDEX_END } from '../pal/palFile.js';

/**
 * SHADOW FRAMES — the SHP(TS) shadow convention (verified against the real RA2
 * install, stage 3): a directional/animated SHP stores its drop shadows as the
 * SECOND HALF of its frame list. For a sprite with an EVEN frame count `n`, the
 * shadow of body frame `i` (0 <= i < n/2) is frame `i + n/2`. Shadow-frame pixels
 * are a single low palette index (index 1 in the buildings probed — ngcnst/ngpowr/
 * ngweap all decode their shadow half to nothing but index-1 pixels) positioned at
 * the shadow's own frame offset, so the engine can blit them as a flat dark decal
 * projected down-right of the body. Some SHPs (e.g. cons.shp conscripts) carry the
 * shadow-half HEADERS but leave them empty (0x0) — the caller must treat an empty
 * shadow frame as "no baked shadow" and fall back to a synthetic blob.
 *
 * Returns the shadow frame index for body frame `i`, or `undefined` when the sprite
 * has an odd frame count (no clean split) or `i` is not in the body half. Pure —
 * unit tested; the render layer's shadow pass is the only consumer.
 */
export function shadowFrameIndex(bodyIndex: number, frameCount: number): number | undefined {
  if (frameCount <= 0 || frameCount % 2 !== 0) return undefined;
  const half = frameCount / 2;
  if (bodyIndex < 0 || bodyIndex >= half) return undefined;
  return bodyIndex + half;
}

/** Parsed metadata for one SHP frame (before or after pixel decode). */
export interface ShpFrameHeader {
  /** Frame index within the file. */
  readonly index: number;
  /** Left offset of this frame within the sprite bounding box. */
  readonly x: number;
  /** Top offset of this frame within the sprite bounding box. */
  readonly y: number;
  /** Frame width in pixels. */
  readonly cx: number;
  /** Frame height in pixels. */
  readonly cy: number;
  /** Raw compression selector from the header. */
  readonly compression: ShpCompression;
  /** Absolute byte offset of the frame body within the file (0 if empty). */
  readonly offset: number;
}

/** A decoded SHP frame: palette-indexed pixels plus its {@link ShpFrameHeader}. */
export interface ShpFrame extends ShpFrameHeader {
  /**
   * Palette-indexed pixels, row-major, length `cx*cy`. Index 0 is the
   * sprite-transparent color; indices {@link REMAP_INDEX_START}..
   * {@link REMAP_INDEX_END} are player-remap colors. Empty (length 0) for a
   * placeholder frame.
   */
  readonly pixels: Uint8Array;
}

/**
 * A parsed SHP(TS) file. Holds the backing buffer and per-frame headers; frame
 * pixels are decoded lazily via {@link decodeFrame} / {@link frame}.
 */
export class ShpFile {
  private readonly data: Uint8Array;

  /** Bounding-box width shared by all frames. */
  readonly cx: number;
  /** Bounding-box height shared by all frames. */
  readonly cy: number;
  /** Per-frame headers, in file order. */
  readonly frames: readonly ShpFrameHeader[];

  private constructor(
    data: Uint8Array,
    cx: number,
    cy: number,
    frames: readonly ShpFrameHeader[],
  ) {
    this.data = data;
    this.cx = cx;
    this.cy = cy;
    this.frames = frames;
  }

  /** Number of frames in the sprite. */
  get count(): number {
    return this.frames.length;
  }

  /**
   * Parse a SHP(TS) file from a byte buffer. Validates the leading zero word and
   * that every frame header fits within the buffer. Throws on a malformed file.
   */
  static parse(bytes: Uint8Array): ShpFile {
    if (bytes.length < SHP_HEADER_SIZE) {
      throw new Error('SHP too small to contain a header');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const zero = dv.getUint16(0, true);
    if (zero !== 0) {
      // A nonzero first word is the Dune2 SHP frame count; those are a different
      // format the RA2 engine does not use.
      throw new Error(`not a SHP(TS): leading word is ${zero}, expected 0`);
    }
    const cx = dv.getUint16(2, true);
    const cy = dv.getUint16(4, true);
    const count = dv.getUint16(6, true);

    const headersEnd = SHP_HEADER_SIZE + count * SHP_FRAME_HEADER_SIZE;
    if (headersEnd > bytes.length) {
      throw new Error(
        `SHP truncated: ${count} frame headers need ${headersEnd} bytes, have ${bytes.length}`,
      );
    }

    const frames: ShpFrameHeader[] = [];
    for (let i = 0; i < count; i++) {
      const p = SHP_HEADER_SIZE + i * SHP_FRAME_HEADER_SIZE;
      const fx = dv.getInt16(p, true);
      const fy = dv.getInt16(p + 2, true);
      const fcx = dv.getInt16(p + 4, true);
      const fcy = dv.getInt16(p + 6, true);
      const compression = dv.getInt32(p + 8, true);
      const offset = dv.getInt32(p + 20, true);
      if (fcx < 0 || fcy < 0) {
        throw new Error(`SHP frame ${i} has negative dimensions`);
      }
      // Bound the frame's decode allocation (fcx*fcy bytes) BEFORE anyone calls
      // frame(i): a valid frame fits inside the sprite bounding box, and no real
      // SHP exceeds the absolute ceiling. This rejects the corrupt/oversized-header
      // OOM vector (cx=cy=32767 ⇒ ~1 GB alloc) without touching valid decodes.
      if (fcx > cx || fcy > cy || fcx * fcy > MAX_SHP_FRAME_PIXELS) {
        throw new Error(
          `SHP frame ${i} dimensions ${fcx}x${fcy} exceed the sprite bounds ${cx}x${cy} / ceiling`,
        );
      }
      if (offset < 0 || offset > bytes.length) {
        throw new Error(`SHP frame ${i} offset ${offset} out of range`);
      }
      frames.push({
        index: i,
        x: fx,
        y: fy,
        cx: fcx,
        cy: fcy,
        compression: compression as ShpCompression,
        offset,
      });
    }

    return new ShpFile(bytes, cx, cy, frames);
  }

  /** The header for frame `index`. Throws if out of range. */
  frameHeader(index: number): ShpFrameHeader {
    const h = this.frames[index];
    if (!h) throw new RangeError(`SHP frame index out of range: ${index}`);
    return h;
  }

  /**
   * Decode frame `index` into palette-indexed pixels. A frame with offset 0 or
   * zero area is returned with an empty pixel buffer. Throws if the frame body
   * is malformed or runs past the end of the file.
   */
  frame(index: number): ShpFrame {
    const h = this.frameHeader(index);
    if (h.offset === 0 || h.cx === 0 || h.cy === 0) {
      return { ...h, pixels: new Uint8Array(0) };
    }
    // Bound the body by the start of the next non-empty frame, since the RLE
    // modes have no explicit end marker and would otherwise consume the
    // following frame's bytes. Frames are not required to be stored in offset
    // order, so scan for the smallest offset strictly greater than this one.
    let end = this.data.length;
    for (const other of this.frames) {
      if (other.offset > h.offset && other.offset < end) end = other.offset;
    }
    const body = this.data.subarray(h.offset, end);
    const pixels = decodeFrame(body, h.cx, h.cy, h.compression);
    return { ...h, pixels };
  }

  /** Decode every frame. Convenience over calling {@link frame} in a loop. */
  decodeAll(): ShpFrame[] {
    const out: ShpFrame[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.frame(i));
    return out;
  }
}
