// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/shp_decode.cpp
//
// Frame decoders for the SHP(TS) sprite format used by Red Alert 2 / Yuri's
// Revenge and Tiberian Sun. Each frame declares a `compression` mode in its
// 24-byte header. XCC (Cshp_ts_file::is_compressed, shp_ts_file.h:82-85)
// tests only the RLE bit — `compression & 2` — and dispatches accordingly:
//
//   compression & 2 == 0  raw: cx*cy palette-indexed bytes copied verbatim.
//   compression & 2 != 0  RLE-zero, per-row (XCC decode3): each row is prefixed
//                          by a uint16 byte-count; within a row a zero byte is
//                          followed by a zero-run length, clamped to the row
//                          width. This is the common RA2 mode.
//
// Concretely, of the four low-bit modes: 0 and 1 are raw, and BOTH 2 and 3 set
// the RLE bit and are decoded by decode3 (per-row). XCC never uses its
// whole-frame decode2 for SHP(TS) frames, so we match it: modes 2 and 3 both
// route through decodeRleZeroRows. `decodeRleZero` (XCC's decode2) is retained
// as a standalone building block but is not on the SHP(TS) frame decode path.
//
// All decoders write into a zero-filled cx*cy buffer, so any pixels the stream
// does not touch remain palette index 0 (the sprite-transparent color).

/**
 * SHP(TS) frame compression modes as stored in the per-frame header. XCC keys
 * only off the RLE bit (`compression & 2`): modes 0 and 1 are raw, while both
 * modes 2 and 3 are decoded per-row (decode3). See the file header for details.
 */
export enum ShpCompression {
  /** Raw cx*cy palette-indexed bytes. */
  None = 0,
  /** Raw cx*cy bytes (uncompressed variant with bit 0 set). */
  Uncompressed = 1,
  /** RLE-zero with the RLE bit set but bit 0 clear; decoded per-row like mode 3. */
  RleZero = 2,
  /** Per-row RLE-zero with a uint16 length prefix per row (RA2 default). */
  RleZeroRows = 3,
}

/**
 * Decode a whole-frame RLE-zero stream (XCC decode2). A nonzero byte is emitted
 * literally; a zero byte is followed by a count of zero pixels to emit.
 *
 * NOTE: XCC does not use this codec for SHP(TS) frames — {@link decodeFrame}
 * routes every RLE frame (modes 2 and 3) through {@link decodeRleZeroRows}
 * (decode3). This function is exported as a reusable building block for other
 * Westwood streams that genuinely use the whole-frame variant.
 *
 * The output buffer is pre-zeroed by the caller, so the zero-run bytes need not
 * be written explicitly — we simply advance the write cursor. Reads are bounds
 * checked so a truncated or malformed stream throws rather than reading past the
 * source or writing past `cx*cy`.
 */
export function decodeRleZero(src: Uint8Array, out: Uint8Array): void {
  const total = out.length;
  let r = 0;
  let w = 0;
  const rEnd = src.length;
  while (r < rEnd) {
    const v = src[r++] as number;
    if (v !== 0) {
      if (w >= total) throw new Error('SHP mode 2: output overflow');
      out[w++] = v;
    } else {
      if (r >= rEnd) throw new Error('SHP mode 2: truncated zero-run');
      const run = src[r++] as number;
      if (w + run > total) throw new Error('SHP mode 2: zero-run overflow');
      w += run; // out already zero-filled
    }
  }
}

/**
 * Decode a per-row RLE-zero frame (XCC decode3). Each of the `cy` rows begins
 * with a little-endian uint16 giving the number of encoded bytes in the row
 * *including* the 2-byte length field. Within a row, a nonzero byte is a literal
 * pixel; a zero byte is followed by a run length of transparent (index 0)
 * pixels. Runs that would exceed the row width are clamped to the remaining
 * width, exactly as XCC does, which tolerates the slightly over-long runs some
 * encoders emit at row ends.
 */
export function decodeRleZeroRows(
  src: Uint8Array,
  out: Uint8Array,
  cx: number,
  cy: number,
): void {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let r = 0;
  let w = 0;
  for (let y = 0; y < cy; y++) {
    if (r + 2 > src.length) throw new Error('SHP mode 3: truncated row header');
    // `count` is the number of encoded bytes after the 2-byte length prefix.
    let count = dv.getUint16(r, true) - 2;
    r += 2;
    if (count < 0) throw new Error('SHP mode 3: bad row length');
    let x = 0;
    while (count-- > 0) {
      if (r >= src.length) throw new Error('SHP mode 3: truncated row body');
      const v = src[r++] as number;
      if (v !== 0) {
        x++;
        out[w++] = v;
      } else {
        // A zero pixel consumes one more source byte (the run length).
        count--;
        if (r >= src.length) throw new Error('SHP mode 3: truncated zero-run');
        let run = src[r++] as number;
        if (x + run > cx) run = cx - x; // clamp to row width, per XCC
        x += run;
        w += run; // out already zero-filled
      }
    }
    // Advance to the exact start of the next row: the row's pixel span is cx.
    // XCC leaves `w` wherever the row's literals/runs landed it, but a
    // well-formed row fills exactly cx pixels. Realign defensively so a row that
    // under-fills (shorter than cx) does not shift subsequent rows.
    w = (y + 1) * cx;
  }
}

/**
 * Copy an uncompressed frame's raw bytes. The source must hold at least `cx*cy`
 * bytes; extra trailing bytes (padding) are ignored.
 */
export function decodeUncompressed(src: Uint8Array, out: Uint8Array): void {
  if (src.length < out.length) {
    throw new Error(
      `SHP uncompressed frame too short: need ${out.length}, have ${src.length}`,
    );
  }
  out.set(src.subarray(0, out.length));
}

/**
 * Decode one SHP(TS) frame body into a freshly allocated, zero-filled
 * palette-indexed `cx*cy` buffer. `compression` is the raw value from the frame
 * header; dispatch mirrors XCC exactly — the RLE bit (`compression & 2`)
 * selects the per-row decoder (decode3), otherwise the frame is raw. A
 * zero-area frame (cx or cy == 0) yields an empty buffer.
 */
export function decodeFrame(
  src: Uint8Array,
  cx: number,
  cy: number,
  compression: number,
): Uint8Array {
  const out = new Uint8Array(cx * cy);
  if (out.length === 0) return out;
  // XCC's Cshp_ts_file::is_compressed tests only the RLE bit (compression & 2):
  // set -> decode3 (per-row); clear -> raw bytes. Modes 2 and 3 both hit decode3.
  if (compression & 0x2) {
    decodeRleZeroRows(src, out, cx, cy);
  } else {
    decodeUncompressed(src, out);
  }
  return out;
}
