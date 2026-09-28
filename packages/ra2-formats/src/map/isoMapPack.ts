// Framing and record layout verified against the FinalSun/FinalAlert 2 Mission
// Editor by Matthias Wagner (GPLv3) — MissionEditorPackLib/MissionEditorPackLib.cpp
// (DecodeIsoMapPack5) and MissionEditor/MapData.cpp; the 11-byte tile record
// layout follows FinalAlert2's MAPFIELDDATA (MissionEditor/MapData.h). tileNum is
// read as a 32-bit value at offset 4 (the community/OpenRA convention; FA2's
// struct names the low word wGround with the next byte reserved).

import { decodeLzo1x } from './lzo.js';

/** Number of bytes in a single packed IsoMapPack5 tile record. */
export const ISO_TILE_RECORD_SIZE = 11;

/**
 * One decoded terrain cell from `[IsoMapPack5]`.
 *
 * Coordinates are in RA2 iso "diamond" space (X grows down-right, Y grows
 * down-left). `tileNum` indexes the theater's tile template; `subTile` selects
 * the cell within a multi-cell template. `z` is the cell height level.
 */
export interface IsoTile {
  /** Iso X coordinate (signed 16-bit). */
  readonly x: number;
  /** Iso Y coordinate (signed 16-bit). */
  readonly y: number;
  /**
   * Tile template index (read as a signed 32-bit LE value at offset 4). In real
   * RA2/YR maps the high two bytes are always 0, so this equals FA2's 16-bit
   * `wGround`; a clear/empty cell is therefore `65535` (`0xFFFF`), not `-1`.
   */
  readonly tileNum: number;
  /** Sub-tile index within the template (unsigned 8-bit). */
  readonly subTile: number;
  /** Height level of the cell (unsigned 8-bit). */
  readonly z: number;
  /** Per-cell flags byte (unsigned 8-bit). */
  readonly flags: number;
}

/**
 * Concatenate the numbered value lines of an `[IsoMapPack5]`/overlay section and
 * base64-decode them into the raw chunked byte stream.
 *
 * The engine stores the payload split across `1=`, `2=`, ... lines that must be
 * joined in order with no separators before decoding. Pass the section's value
 * list (already in file order); {@link joinSectionLines} handles the join.
 */
export function decodeBase64Section(lines: readonly string[]): Uint8Array {
  return decodeBase64(joinSectionLines(lines));
}

/** Join numbered section value lines in order into one base64 string. */
export function joinSectionLines(lines: readonly string[]): string {
  return lines.join('');
}

/**
 * Base64-decode a string, ignoring whitespace and any non-alphabet characters
 * (matching XCC's lenient `decode64`, which skips bytes with no table entry).
 */
export function decodeBase64(text: string): Uint8Array {
  // Strip everything that is not a base64 alphabet character or padding. This
  // tolerates embedded newlines/spaces the way the reference decoder does.
  // Portable decoder (no Node Buffer / browser atob) so the package runs in both
  // Node and browsers. Padding and any trailing partial group are handled the
  // way Node's lenient decoder does: a final group of 2 or 3 symbols yields 1 or
  // 2 bytes, a lone trailing symbol is ignored, and decoding stops at '='.
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const eq = cleaned.indexOf('=');
  const body = eq >= 0 ? cleaned.slice(0, eq) : cleaned;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i++) {
    acc = (acc << 6) | BASE64_LOOKUP[body.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Char code -> 6-bit value for the standard base64 alphabet (other codes unused). */
const BASE64_LOOKUP: Uint8Array = (() => {
  const table = new Uint8Array(128);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

/**
 * A single compression chunk: `[u16 compressedSize][u16 uncompressedSize][payload]`.
 * Shared framing between IsoMapPack5 (LZO payload) and OverlayPack (LCW payload).
 */
export interface PackChunk {
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** The compressed payload bytes (length === compressedSize). */
  readonly payload: Uint8Array;
}

/**
 * Split a chunked pack stream into its `[u16 in][u16 out][payload]` chunks.
 *
 * @throws {RangeError} if a chunk header or payload runs past the buffer.
 */
export function readPackChunks(data: Uint8Array): PackChunk[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks: PackChunk[] = [];
  let p = 0;
  while (p + 4 <= data.length) {
    const compressedSize = view.getUint16(p, true);
    const uncompressedSize = view.getUint16(p + 2, true);
    p += 4;
    if (p + compressedSize > data.length) {
      throw new RangeError(
        `IsoMapPack chunk payload (${compressedSize} bytes) runs past end of stream`,
      );
    }
    chunks.push({
      compressedSize,
      uncompressedSize,
      payload: data.subarray(p, p + compressedSize),
    });
    p += compressedSize;
  }
  return chunks;
}

/**
 * Decode an `[IsoMapPack5]` payload (already base64-decoded chunk stream) into
 * the flat, uncompressed byte buffer of 11-byte tile records.
 *
 * Each chunk's LZO1X payload is decompressed to exactly `uncompressedSize`
 * bytes and appended.
 */
export function decompressIsoMapPack(data: Uint8Array): Uint8Array {
  const chunks = readPackChunks(data);
  let total = 0;
  for (const c of chunks) total += c.uncompressedSize;
  // Bound the output allocation: each chunk's uncompressedSize is an unchecked u16,
  // so a crafted many-chunk pack could sum to gigabytes and OOM the map loader before
  // any LZO decode runs. 256 MiB of 11-byte tile records is ~24M cells — vastly larger
  // than any real RA2 map — so this never rejects valid data.
  if (total > 256 * 1024 * 1024) {
    throw new RangeError(`IsoMapPack decompressed size ${total} exceeds the sane ceiling`);
  }
  const out = new Uint8Array(total);
  let dp = 0;
  for (const c of chunks) {
    const decoded = decodeLzo1x(c.payload, c.uncompressedSize);
    out.set(decoded, dp);
    dp += c.uncompressedSize;
  }
  return out;
}

/**
 * Parse a flat IsoMapPack5 byte buffer (from {@link decompressIsoMapPack}) into
 * tile records. Records whose `x` and `y` are both 0 are dropped: the engine
 * writes trailing all-zero padding records that carry no real cell.
 *
 * @param includeEmpty keep `(0,0)` padding records instead of dropping them.
 */
export function parseIsoTiles(raw: Uint8Array, includeEmpty = false): IsoTile[] {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = Math.floor(raw.length / ISO_TILE_RECORD_SIZE);
  const tiles: IsoTile[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * ISO_TILE_RECORD_SIZE;
    const x = view.getInt16(base, true);
    const y = view.getInt16(base + 2, true);
    const tileNum = view.getInt32(base + 4, true);
    const subTile = view.getUint8(base + 8);
    const z = view.getUint8(base + 9);
    const flags = view.getUint8(base + 10);
    if (!includeEmpty && x === 0 && y === 0) continue;
    tiles.push({ x, y, tileNum, subTile, z, flags });
  }
  return tiles;
}

/**
 * Full `[IsoMapPack5]` decode: join lines → base64 → LZO chunks → tile records.
 *
 * @param lines the section's value lines in file order.
 * @returns the parsed tiles and the raw decompressed byte buffer.
 */
export function decodeIsoMapPack(lines: readonly string[]): {
  tiles: IsoTile[];
  raw: Uint8Array;
} {
  const raw = decompressIsoMapPack(decodeBase64Section(lines));
  return { tiles: parseIsoTiles(raw), raw };
}
