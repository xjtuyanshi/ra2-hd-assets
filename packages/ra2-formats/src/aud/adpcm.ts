// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/aud_decode.cpp.
//
// The two ADPCM decoders Westwood audio uses, extracted so both the AUD container
// (aud/audFile.ts) and the IDX/BAG audio bank (aud/audioBank.ts) can share them:
//
//   * IMA-ADPCM (the "type 99" AUD codec, and the codec inside the RA2/YR audio
//     bank chunks and the RIFF fmt-0x11 WAV speech/theme files). A 4-bit-per-sample
//     scheme with an 88-entry step-size table and a 16-entry index-adjust table.
//   * Westwood ADPCM (the "type 1" AUD codec used by older Westwood titles and some
//     RA2 sounds). A 2/4-bit delta scheme driven by a code table and a small
//     word-transform table.
//
// The step / index / code tables below are transcribed EXACTLY from aud_decode.cpp
// (the same constants IMA-ADPCM standardised in the IMA Digital Audio spec, which
// XCC reproduces). Getting a single table entry wrong silently corrupts every
// decoded sample, so they are kept verbatim and covered by golden-vector unit tests.

/**
 * IMA-ADPCM step-size table: 89 entries indexed by the running step index (0..88).
 * Transcribed verbatim from XCC aud_decode.cpp (`ima_step_table`).
 */
export const IMA_STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/**
 * IMA-ADPCM index-adjust table: how the step index moves for each 4-bit code
 * (the low 3 bits are the magnitude; bit 3 is sign, so entries mirror 0..7).
 * Transcribed verbatim from XCC aud_decode.cpp (`ima_index_table`).
 */
export const IMA_INDEX_TABLE: readonly number[] = [
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

/** Clamp a 32-bit accumulator to the signed 16-bit PCM range. */
function clampS16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

/**
 * Running state for an IMA-ADPCM stream: the current predicted sample and the
 * current step-table index. Both AUD (per-chunk reset) and the audio bank
 * (per-512-byte-block reset) drive the SAME nibble decoder over this state; the
 * container decides when to reset it.
 */
export interface ImaState {
  /** Current predicted sample (accumulates across nibbles). */
  predictor: number;
  /** Current index into {@link IMA_STEP_TABLE} (0..88). */
  index: number;
}

/** A fresh, zeroed IMA-ADPCM state (predictor 0, index 0). */
export function newImaState(): ImaState {
  return { predictor: 0, index: 0 };
}

/**
 * Decode ONE 4-bit IMA-ADPCM code into the next PCM sample, advancing `state`.
 * This is the exact inner step from XCC aud_decode.cpp: build the difference from
 * the current step size using the code's magnitude bits, apply the sign bit, clamp,
 * then move the step index by the index table (clamped to 0..88).
 */
export function decodeImaNibble(code: number, state: ImaState): number {
  const step = IMA_STEP_TABLE[state.index]!;
  // diff = step/8 + (b2?step/2:0) + (b1?step/4:0) + (b0?step/8 already in base).
  // XCC builds it additively from the high bit down; the equivalent bit tests:
  let diff = step >> 3;
  if (code & 1) diff += step >> 2;
  if (code & 2) diff += step >> 1;
  if (code & 4) diff += step;
  if (code & 8) diff = -diff;
  state.predictor = clampS16(state.predictor + diff);
  state.index += IMA_INDEX_TABLE[code & 0x0f]!;
  if (state.index < 0) state.index = 0;
  else if (state.index > 88) state.index = 88;
  return state.predictor;
}

/**
 * Decode a run of packed IMA-ADPCM bytes (two 4-bit codes per byte, low nibble
 * first) into `out` starting at `outPos`, over the shared {@link ImaState}. Returns
 * the number of samples written (== 2 * bytes). The caller resets `state` at the
 * boundaries its container defines (AUD chunk / WAV block / bag block).
 */
export function decodeImaBlock(
  data: Uint8Array,
  start: number,
  length: number,
  state: ImaState,
  out: Int16Array,
  outPos: number,
): number {
  let o = outPos;
  const end = start + length;
  for (let i = start; i < end; i++) {
    const byte = data[i]!;
    out[o++] = decodeImaNibble(byte & 0x0f, state);
    out[o++] = decodeImaNibble(byte >> 4, state);
  }
  return o - outPos;
}

// ---------------------------------------------------------------------------
// Westwood ADPCM ("type 1")
// ---------------------------------------------------------------------------

/**
 * Westwood-ADPCM 2-bit code -> word-delta transform, transcribed verbatim from XCC
 * aud_decode.cpp (`ws_table_2bit`). Used when the current code size is 2 bits.
 */
const WS_TABLE_2BIT: readonly number[] = [-2, -1, 0, 1];

/**
 * Westwood-ADPCM 4-bit code -> word-delta transform, transcribed verbatim from XCC
 * aud_decode.cpp (`ws_table_4bit`). Used when the current code size is 4 bits.
 */
const WS_TABLE_4BIT: readonly number[] = [
  -9, -8, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8,
];

/**
 * Decode Westwood-ADPCM ("type 1") compressed audio to signed 16-bit PCM. Ported
 * from XCC aud_decode.cpp (`aud_decode` type-1 branch). The stream is a series of
 * command bytes: the top 2 bits select an opcode and the low 6 bits a count; the
 * decoder maintains a running `sample` prediction adjusted by the 2/4-bit code
 * tables, with a shift that tracks amplitude.
 *
 * `outSamples` is the uncompressed sample count from the AUD (chunk) header, used to
 * size the output and to stop exactly on the sample boundary.
 */
export function decodeWestwood(data: Uint8Array, outSamples: number): Int16Array {
  const out = new Int16Array(outSamples);
  let sample = 0x80; // XCC seeds the running sample at 128 (8-bit centre)
  let ip = 0;
  let op = 0;
  while (op < outSamples && ip < data.length) {
    let count = data[ip]! & 0x3f;
    const opcode = data[ip]! >> 6;
    ip++;
    switch (opcode) {
      case 0: {
        // 2-bit delta: (count+1) codes follow, 4 codes per byte.
        count++;
        for (let c = 0; c < count && op < outSamples; c++) {
          const byte = data[ip++]!;
          for (let s = 0; s < 4 && op < outSamples; s++) {
            const code = (byte >> (s * 2)) & 0x03;
            sample += WS_TABLE_2BIT[code]!;
            sample = sample < 0 ? 0 : sample > 0xff ? 0xff : sample;
            out[op++] = (sample - 0x80) << 8;
          }
        }
        break;
      }
      case 1: {
        // 4-bit delta: (count+1) codes follow, 2 codes per byte.
        count++;
        for (let c = 0; c < count && op < outSamples; c++) {
          const byte = data[ip++]!;
          for (let s = 0; s < 2 && op < outSamples; s++) {
            const code = (byte >> (s * 4)) & 0x0f;
            sample += WS_TABLE_4BIT[code]!;
            sample = sample < 0 ? 0 : sample > 0xff ? 0xff : sample;
            out[op++] = (sample - 0x80) << 8;
          }
        }
        break;
      }
      case 2: {
        // Raw run vs. single delta. Bit 5 of count distinguishes:
        if (count & 0x20) {
          // Signed 5-bit delta applied once to the running sample.
          const delta = (count & 0x1f) << 3;
          // Sign-extend the 5-bit field (matches XCC's (char)(count << 3) >> 3 idiom).
          sample += (delta << 24) >> 27;
          sample = sample < 0 ? 0 : sample > 0xff ? 0xff : sample;
          out[op++] = (sample - 0x80) << 8;
        } else {
          // (count+1) raw 8-bit samples copied through.
          count++;
          for (let c = 0; c < count && op < outSamples; c++) {
            sample = data[ip++]!;
            out[op++] = (sample - 0x80) << 8;
          }
        }
        break;
      }
      default: {
        // opcode 3: repeat the current sample (count+1) times.
        count++;
        for (let c = 0; c < count && op < outSamples; c++) {
          out[op++] = (sample - 0x80) << 8;
        }
        break;
      }
    }
  }
  return out;
}
