// Framing verified against the FinalSun/FinalAlert 2 Mission Editor by Matthias
// Wagner (GPLv3) — MissionEditorPackLib/MissionEditorPackLib.cpp (DecodeF80,
// decode5 format 80) and MissionEditor/MapData.cpp (overlay unpacking to 512x512
// arrays). The per-chunk LCW payloads are decoded by lcw.ts, which is ported from
// XCC's decode80 (Olaf van der Spek, GPLv3).

import { decodeLcwInto } from './lcw.js';
import { decodeBase64Section, readPackChunks } from './isoMapPack.js';

/** Overlay grid dimension: RA2 maps address a fixed 512x512 cell space. */
export const OVERLAY_MAP_DIM = 512;

/** Total bytes in one overlay array (512 * 512). */
export const OVERLAY_ARRAY_SIZE = OVERLAY_MAP_DIM * OVERLAY_MAP_DIM; // 262144

/** Fill byte for cells with no overlay (0xFF == "none"). */
export const OVERLAY_EMPTY = 0xff;

/**
 * Decode an `[OverlayPack]` or `[OverlayDataPack]` section into a flat
 * 262144-byte (512x512) array.
 *
 * The stream is base64 → format80 (LCW) chunks of `[u16 in][u16 out][payload]`.
 * Each chunk's LCW payload decompresses into the output at a running offset,
 * exactly as XCC's `decode5(..., 80)` does. Cells not covered by the stream
 * remain `0xFF` (the "no overlay" sentinel).
 *
 * `[OverlayPack]` holds the overlay type per cell; `[OverlayDataPack]` holds the
 * overlay's frame/state per cell. Both use identical framing.
 *
 * @param lines the section's value lines in file order.
 * @returns a 262144-byte array indexed as `y * 512 + x`.
 */
export function decodeOverlayPack(lines: readonly string[]): Uint8Array {
  const out = new Uint8Array(OVERLAY_ARRAY_SIZE).fill(OVERLAY_EMPTY);
  if (lines.length === 0) return out;

  const data = decodeBase64Section(lines);
  if (data.length === 0) return out;

  const chunks = readPackChunks(data);
  let dp = 0;
  for (const c of chunks) {
    if (dp + c.uncompressedSize > OVERLAY_ARRAY_SIZE) {
      throw new RangeError(
        `Overlay pack decodes to more than ${OVERLAY_ARRAY_SIZE} bytes`,
      );
    }
    decodeLcwInto(c.payload, out, dp);
    dp += c.uncompressedSize;
  }
  return out;
}

/**
 * Read the overlay id and data for a single cell from decoded overlay arrays.
 *
 * @param overlay     the `[OverlayPack]` array from {@link decodeOverlayPack}.
 * @param overlayData the `[OverlayDataPack]` array.
 * @param x           cell X (0..511).
 * @param y           cell Y (0..511).
 */
export function overlayAt(
  overlay: Uint8Array,
  overlayData: Uint8Array,
  x: number,
  y: number,
): { id: number; data: number } {
  const i = y * OVERLAY_MAP_DIM + x;
  return { id: overlay[i]!, data: overlayData[i]! };
}
