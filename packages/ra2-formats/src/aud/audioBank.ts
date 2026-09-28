// Ported from the XCC library by Olaf van der Spek (GPLv3) — the IDX/BAG audio-bank
// structures (XCC `sound_bag` / idx file). The RA2/YR sound effects and unit voices
// live in an `audio.idx` + `audio.bag` pair (and an `audiomd.*` variant for Yuri's
// Revenge, which stores most YR sounds):
//
//   audio.idx (index): after an optional prefix, a "GABA" header
//       char  magic[4]   'GABA'
//       int32 count      (unreliable in the shipped YR idx — see note below)
//       int32 reserved
//     then `count` entries of 36 bytes each:
//       char  name[16]   NUL-padded sample name (lower-cased on read)
//       int32 offset     byte offset of the sample in audio.bag
//       int32 size       compressed byte size in audio.bag
//       int32 sampleRate samples/second (e.g. 22050)
//       int32 flags      codec flags (bit3 0x08 = compressed/IMA-ADPCM)
//       int32 chunkSize  ADPCM block size in bytes (e.g. 512); state resets each block
//
//   audio.bag: the concatenated compressed sample bodies the idx offsets point into.
//
// NOTE on `count`: the retail YR audio.idx carries a small/garbage count field and a
// leading non-GABA prefix; the ROBUST parse (which XCC-derived tools also use) is to
// locate the "GABA" magic and read fixed 36-byte entries to the end of the idx. Every
// resulting entry self-validates (ascending offsets inside the bag, printable names,
// sane sample rates), so a bad count never yields bad data.
//
// Bag samples are IMA-ADPCM packed in `chunkSize`-byte blocks with the predictor/index
// reset at each block boundary (verified against the real install: continuous decode
// clips, per-block reset yields clean speech/SFX levels). The shared IMA nibble decoder
// (aud/adpcm.ts) does the work.

import { decodeImaBlock, newImaState } from './adpcm.js';
import type { DecodedAudio } from './audFile.js';

/** Size in bytes of each IDX entry. */
export const IDX_ENTRY_SIZE = 36;
/** Size in bytes of the GABA header (magic + count + reserved). */
export const IDX_HEADER_SIZE = 12;
/** Codec flag bit: the sample body is IMA-ADPCM compressed. */
export const BANK_FLAG_COMPRESSED = 0x08;

/** One entry in an audio bank index. */
export interface AudioBankEntry {
  /** Lower-cased sample name (e.g. `ibruatta`, `csof048`). */
  readonly name: string;
  /** Byte offset of the compressed body within the bag. */
  readonly offset: number;
  /** Compressed body size in bytes. */
  readonly size: number;
  /** Sample rate in Hz. */
  readonly sampleRate: number;
  /** Codec flags (see {@link BANK_FLAG_COMPRESSED}). */
  readonly flags: number;
  /** ADPCM block size in bytes (predictor/index reset each block). */
  readonly chunkSize: number;
}

/**
 * A parsed audio bank: the IDX entries keyed by name plus a reference to the BAG
 * body. Construct via {@link parse}; decode a sample with {@link decode}.
 */
export class AudioBank {
  private readonly entries: Map<string, AudioBankEntry>;
  private readonly bag: Uint8Array;

  private constructor(entries: Map<string, AudioBankEntry>, bag: Uint8Array) {
    this.entries = entries;
    this.bag = bag;
  }

  /**
   * Parse an IDX + BAG pair. Locates the "GABA" magic in the idx and reads fixed
   * 36-byte entries to the end; entries whose (offset,size) fall outside the bag or
   * whose name is empty are skipped (defensive against a trailing partial record).
   */
  static parse(idx: Uint8Array, bag: Uint8Array): AudioBank {
    const gaba = AudioBank.findGaba(idx);
    if (gaba < 0) throw new Error('audio.idx: no GABA header found');
    const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const start = gaba + IDX_HEADER_SIZE;
    const count = Math.floor((idx.length - start) / IDX_ENTRY_SIZE);
    const entries = new Map<string, AudioBankEntry>();
    for (let i = 0; i < count; i++) {
      const q = start + i * IDX_ENTRY_SIZE;
      const name = AudioBank.readName(idx, q);
      const offset = view.getInt32(q + 16, true);
      const size = view.getInt32(q + 20, true);
      const sampleRate = view.getInt32(q + 24, true);
      const flags = view.getInt32(q + 28, true);
      const chunkSize = view.getInt32(q + 32, true);
      if (name.length === 0 || offset < 0 || size <= 0 || offset + size > bag.length) {
        continue; // skip a malformed / trailing record
      }
      entries.set(name, { name, offset, size, sampleRate, flags, chunkSize });
    }
    return new AudioBank(entries, bag);
  }

  /** Locate the byte offset of the "GABA" magic in the idx, or -1 if absent. */
  private static findGaba(idx: Uint8Array): number {
    for (let i = 0; i + 4 <= idx.length; i++) {
      if (idx[i] === 0x47 && idx[i + 1] === 0x41 && idx[i + 2] === 0x42 && idx[i + 3] === 0x41) {
        return i;
      }
    }
    return -1;
  }

  /** Read a 16-byte NUL-padded name at `pos`, lower-cased and trimmed. */
  private static readName(idx: Uint8Array, pos: number): string {
    let end = pos;
    const limit = pos + 16;
    while (end < limit && idx[end] !== 0) end++;
    let s = '';
    for (let i = pos; i < end; i++) s += String.fromCharCode(idx[i]!);
    return s.toLowerCase();
  }

  /** Number of samples in the bank. */
  get count(): number {
    return this.entries.size;
  }

  /** All sample names, in insertion (file) order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** True if the bank contains a sample by name (case-insensitive). */
  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** The index entry for a sample, or undefined if absent. */
  entry(name: string): AudioBankEntry | undefined {
    return this.entries.get(name.toLowerCase());
  }

  /**
   * Decode a bank sample to interleaved signed-16-bit PCM, or undefined if the name
   * is absent. Compressed (IMA-ADPCM) bodies are decoded in `chunkSize`-byte blocks
   * with per-block state reset; an uncompressed body is read as raw signed 16-bit.
   */
  decode(name: string): DecodedAudio | undefined {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return undefined;
    const body = this.bag.subarray(e.offset, e.offset + e.size);
    const channels = 1; // the RA2/YR banks are mono SFX/voices
    if ((e.flags & BANK_FLAG_COMPRESSED) === 0) {
      // Uncompressed 16-bit PCM.
      const n = body.length >> 1;
      const out = new Int16Array(n);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
      return { samples: out, sampleRate: e.sampleRate, channels };
    }
    // IMA-ADPCM in chunkSize-byte blocks; 2 samples per byte.
    const out = new Int16Array(body.length * 2);
    const chunk = e.chunkSize > 0 ? e.chunkSize : body.length;
    let outPos = 0;
    for (let base = 0; base < body.length; base += chunk) {
      const len = Math.min(chunk, body.length - base);
      const state = newImaState();
      outPos += decodeImaBlock(body, base, len, state, out, outPos);
    }
    const samples = outPos === out.length ? out : out.subarray(0, outPos);
    return { samples, sampleRate: e.sampleRate, channels };
  }
}
