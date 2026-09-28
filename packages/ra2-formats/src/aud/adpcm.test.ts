import { describe, expect, it } from 'vitest';
import {
  IMA_INDEX_TABLE,
  IMA_STEP_TABLE,
  decodeImaBlock,
  decodeImaNibble,
  decodeWestwood,
  newImaState,
} from './adpcm.js';

/**
 * GOLDEN VECTOR for IMA-ADPCM, derived INDEPENDENTLY from the canonical IMA/DVI
 * fixed-point reference math (the published `vpdiff` additive form XCC's
 * aud_decode.cpp uses):
 *
 *   vpdiff = step >> 3
 *   if (delta & 4) vpdiff += step
 *   if (delta & 2) vpdiff += step >> 1
 *   if (delta & 1) vpdiff += step >> 2
 *   valpred += (delta & 8) ? -vpdiff : vpdiff  (clamped to int16)
 *   index  += index_table[delta]               (clamped 0..88)
 *
 * traced by hand over the 16-nibble input below (packed low-nibble-first into
 * bytes). These numbers are the reference math's output, so the parser reproducing
 * them proves the step/index tables and the accumulator are bit-exact.
 */
const IMA_NIBBLES = [0x8, 0x4, 0xc, 0x7, 0xf, 0x0, 0x2, 0xa, 0x5, 0xd, 0x1, 0x9, 0x6, 0xe, 0x3, 0xb];
const IMA_BYTES = Uint8Array.from([72, 124, 15, 162, 213, 145, 230, 179]);
const IMA_GOLDEN = [0, 7, -3, 16, -25, -19, 8, -17, 33, -41, -11, -38, 69, -122, 60, -105];

describe('IMA-ADPCM tables', () => {
  it('has the exact 89-entry step table and 16-entry index table', () => {
    expect(IMA_STEP_TABLE.length).toBe(89);
    expect(IMA_STEP_TABLE[0]).toBe(7);
    expect(IMA_STEP_TABLE[88]).toBe(32767);
    expect(IMA_INDEX_TABLE).toEqual([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]);
  });

  it('matches the canonical XCC ima_step_table VERBATIM (every entry)', () => {
    // Regression guard: the decode vectors below only traverse a SUBSET of the 89 step
    // indices (the ramp skips over some, e.g. index 8), so a single corrupted entry can
    // otherwise slip through undetected. Pin the whole table against the published values.
    // Transcribed from XCC aud_decode.cpp (ima_step_table) — must be bit-exact.
    expect([...IMA_STEP_TABLE]).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
      19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
      50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
      130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
      337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
      876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
      2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
      5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
      15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
    ]);
  });

  it('a decode vector that lands ON step index 8 depends on IMA_STEP_TABLE[8]', () => {
    // The main golden vector jumps 0->2->4->12, skipping index 8 entirely. Here we drive
    // the index to exactly 8 with two 0x4 codes (index_table[4]=+2, twice from a seeded
    // index 4), then decode a growth nibble whose output is a function of step[8]. This
    // makes step[8]==16 load-bearing under test (previously it was dead).
    const state = newImaState();
    state.index = 4; // seed so two +2 steps land exactly on 8
    decodeImaNibble(0x4, state); // index -> 6
    decodeImaNibble(0x4, state); // index -> 8, step now IMA_STEP_TABLE[8]
    expect(state.index).toBe(8);
    const predBefore = state.predictor;
    // Decode a positive-magnitude code at index 8: diff = step>>3 + (code&4?step:0) ...
    // With step[8]=16 and code 0x4 (bit2 set): diff = (16>>3) + 16 = 2 + 16 = 18 -> predictor += 18.
    const out = decodeImaNibble(0x4, state);
    expect(out - predBefore).toBe(18); // exactly (step[8]>>3) + step[8] = 2 + 16, load-bearing on step[8]==16
  });
});

describe('decodeImaNibble / decodeImaBlock', () => {
  it('reproduces the golden vector nibble-by-nibble', () => {
    const state = newImaState();
    const out: number[] = [];
    for (const code of IMA_NIBBLES) out.push(decodeImaNibble(code, state));
    expect(out).toEqual(IMA_GOLDEN);
  });

  it('reproduces the golden vector decoding packed bytes (low nibble first)', () => {
    const out = new Int16Array(IMA_NIBBLES.length);
    const state = newImaState();
    const wrote = decodeImaBlock(IMA_BYTES, 0, IMA_BYTES.length, state, out, 0);
    expect(wrote).toBe(IMA_NIBBLES.length);
    expect([...out]).toEqual(IMA_GOLDEN);
  });

  it('clamps the predictor to the signed 16-bit range under a sustained ramp', () => {
    // Repeated max-positive code (0x7) grows the predictor until it saturates at
    // +32767, then repeated max-negative code (0xF) drives it to -32768.
    const up = new Array(30).fill(0x7);
    const down = new Array(30).fill(0xf);
    const state = newImaState();
    let last = 0;
    for (const c of up) last = decodeImaNibble(c, state);
    expect(last).toBe(32767);
    for (const c of down) last = decodeImaNibble(c, state);
    expect(last).toBe(-32768);
  });

  it('clamps the step index to 0..88', () => {
    const state = newImaState();
    // Drive the index up with growth codes; it must never exceed 88.
    for (let i = 0; i < 200; i++) decodeImaNibble(0x7, state);
    expect(state.index).toBeLessThanOrEqual(88);
    expect(state.index).toBeGreaterThanOrEqual(0);
  });
});

describe('decodeWestwood', () => {
  it('repeats the running sample for opcode 3 (silence run at centre)', () => {
    // A single command byte: opcode 3 (0b11 << 6) with count 3 -> emit 4 samples of
    // the seeded centre sample (0x80). Centre maps to 0 in the (sample-0x80)<<8 output.
    const cmd = Uint8Array.from([(3 << 6) | 3]);
    const pcm = decodeWestwood(cmd, 4);
    expect([...pcm]).toEqual([0, 0, 0, 0]);
  });

  it('copies raw 8-bit samples for opcode 2 non-delta runs', () => {
    // opcode 2, count field with bit5 clear -> (count+1) raw bytes follow.
    // count=1 -> 2 raw samples: 0x80 (centre -> 0) and 0xC0 (+64 -> 0x40<<8).
    const cmd = Uint8Array.from([(2 << 6) | 1, 0x80, 0xc0]);
    const pcm = decodeWestwood(cmd, 2);
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(0x40 << 8);
  });

  it('stops at the declared sample count', () => {
    const cmd = Uint8Array.from([(3 << 6) | 0x3f]); // opcode 3, big count
    const pcm = decodeWestwood(cmd, 5);
    expect(pcm.length).toBe(5);
  });
});
