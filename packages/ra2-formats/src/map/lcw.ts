// Ported from the XCC library by Olaf van der Spek (GPLv3) — 3rdParty/xcc/misc/shp_decode.cpp (decode80c)

/**
 * LCW ("format80") decompression.
 *
 * LCW is Westwood's Lempel-Ziv-style codec used throughout RA2/YR data. In map
 * files it wraps the `[OverlayPack]`/`[OverlayDataPack]` chunk payloads.
 *
 * The command byte grammar (bit 7 = command class):
 * ```
 * 0 copy   0cccpppp p         relative back-copy, run 3..10, 12-bit offset
 * 1 copy   10cccccc           literal copy of up to 63 bytes from source
 * 2 copy   11cccccc p p       absolute back-copy, run 3..64, 16-bit offset
 * 3 fill   11111110 c c v      run-length fill, 16-bit count, byte value
 * 4 copy   11111111 c c p p    absolute back-copy, 16-bit count + offset
 * ```
 * A `10000000` (command 1 with count 0) byte terminates the stream.
 *
 * This mirrors XCC's portable `decode80c` (not the x86 `_asm` `decode80`), which
 * is the byte-exact reference for the format.
 */

/**
 * Decompress an LCW/format80 stream into a caller-supplied destination buffer.
 *
 * Back-copy opcodes reference bytes relative to the start of the destination
 * window (`outputOffset`), so a single output buffer must be used across a
 * chunk's whole stream.
 *
 * @param input        the compressed bytes (one format80 stream, ideally ending
 *   with the `0x80` terminator).
 * @param output       destination buffer; must be large enough for the decoded
 *   data starting at `outputOffset`.
 * @param outputOffset starting write index within `output` (default 0). Also the
 *   base that command-2/4 absolute offsets are measured from.
 * @returns the number of bytes written.
 */
export function decodeLcwInto(
  input: Uint8Array,
  output: Uint8Array,
  outputOffset = 0,
): number {
  const out = output;
  const start = outputOffset;
  let r = 0;
  let w = start;

  for (;;) {
    if (r >= input.length) {
      // Ran out of input without an explicit terminator — stop cleanly rather
      // than reading past the buffer.
      break;
    }
    const code = input[r++]!;
    if ((~code & 0x80) !== 0) {
      // bit 7 == 0 — command 0 (0cccpppp p): relative back-copy.
      const count = (code >> 4) + 3;
      const offset = ((code & 0x0f) << 8) + input[r++]!;
      let copyp = w - offset;
      for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
    } else {
      // bit 7 == 1.
      const count6 = code & 0x3f;
      if ((~code & 0x40) !== 0) {
        // bit 6 == 0 — command 1 (10cccccc): literal copy, or terminator.
        if (count6 === 0) break; // end of stream
        for (let i = 0; i < count6; i++) out[w++] = input[r++]!;
      } else {
        // bit 6 == 1.
        if (count6 < 0x3e) {
          // command 2 (11cccccc p p): absolute back-copy.
          const count = count6 + 3;
          let copyp = start + (input[r]! | (input[r + 1]! << 8));
          r += 2;
          for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
        } else if (count6 === 0x3e) {
          // command 3 (11111110 c c v): run-length fill.
          const count = input[r]! | (input[r + 1]! << 8);
          r += 2;
          const value = input[r++]!;
          for (let i = 0; i < count; i++) out[w++] = value;
        } else {
          // count6 == 0x3f — command 4 (11111111 c c p p): absolute back-copy.
          const count = input[r]! | (input[r + 1]! << 8);
          r += 2;
          let copyp = start + (input[r]! | (input[r + 1]! << 8));
          r += 2;
          for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
        }
      }
    }
  }

  return w - start;
}

/**
 * Decompress an LCW/format80 stream and return exactly the decoded bytes.
 *
 * Convenience wrapper for callers that do not know the output length up front:
 * it grows an internal buffer and returns a tight copy. When you already know
 * the uncompressed size (e.g. from a chunk header) prefer {@link decodeLcwInto}
 * with a pre-sized buffer to avoid the extra allocation.
 */
export function decodeLcwToArray(input: Uint8Array): Uint8Array {
  // A grown buffer keeps the whole decoded window contiguous for back-copies.
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let r = 0;
  let w = 0;

  const ensure = (need: number): void => {
    if (w + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < w + need) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, w));
    out = grown;
  };

  for (;;) {
    if (r >= input.length) break;
    const code = input[r++]!;
    if ((~code & 0x80) !== 0) {
      const count = (code >> 4) + 3;
      const offset = ((code & 0x0f) << 8) + input[r++]!;
      let copyp = w - offset;
      ensure(count);
      for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
    } else {
      const count6 = code & 0x3f;
      if ((~code & 0x40) !== 0) {
        if (count6 === 0) break;
        ensure(count6);
        for (let i = 0; i < count6; i++) out[w++] = input[r++]!;
      } else if (count6 < 0x3e) {
        const count = count6 + 3;
        let copyp = input[r]! | (input[r + 1]! << 8);
        r += 2;
        ensure(count);
        for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
      } else if (count6 === 0x3e) {
        const count = input[r]! | (input[r + 1]! << 8);
        r += 2;
        const value = input[r++]!;
        ensure(count);
        for (let i = 0; i < count; i++) out[w++] = value;
      } else {
        const count = input[r]! | (input[r + 1]! << 8);
        r += 2;
        let copyp = input[r]! | (input[r + 1]! << 8);
        r += 2;
        ensure(count);
        for (let i = 0; i < count; i++) out[w++] = out[copyp++]!;
      }
    }
  }

  return out.slice(0, w);
}
