// Original Vanguard code (no XCC logic): a minimal RIFF/WAVE reader for the two
// wave formats the RA2/YR install actually ships inside its audio mixes:
//
//   * fmt 0x0001 (PCM)          — raw signed 16-bit (or unsigned 8-bit) samples.
//   * fmt 0x0011 (IMA ADPCM)    — the EVA speech (mono, blockAlign 512) and the
//                                 music themes (stereo, blockAlign 1024). Each
//                                 block starts with a per-channel init header
//                                 (int16 predictor + uint8 step index + pad) then
//                                 packs 4-bit nibbles; channels interleave in
//                                 4-byte (dword) groups per the IMA WAV spec.
//
// The shared IMA nibble decoder (aud/adpcm.ts) is reused; only the WAV block framing
// lives here. Output is always interleaved signed-16-bit PCM.

import { decodeImaNibble, newImaState, type ImaState } from './adpcm.js';
import type { DecodedAudio } from './audFile.js';

/** WAVE format tag: uncompressed PCM. */
export const WAVE_FORMAT_PCM = 0x0001;
/** WAVE format tag: IMA / DVI ADPCM. */
export const WAVE_FORMAT_IMA_ADPCM = 0x0011;

/** True if a buffer starts with a RIFF/WAVE signature. */
export function looksLikeWav(data: Uint8Array): boolean {
  return (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && // "RIFF"
    data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45 // "WAVE"
  );
}

interface WavFmt {
  formatTag: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/** Find a named RIFF sub-chunk, returning its data offset and size, or undefined. */
function findChunk(data: Uint8Array, id: string): { offset: number; size: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 12; // skip "RIFF" + size + "WAVE"
  while (p + 8 <= data.length) {
    const cid = String.fromCharCode(data[p]!, data[p + 1]!, data[p + 2]!, data[p + 3]!);
    const size = view.getUint32(p + 4, true);
    if (cid === id) return { offset: p + 8, size };
    p += 8 + size + (size & 1); // chunks are word-aligned
  }
  return undefined;
}

/** Parse the "fmt " chunk. Throws if absent or too small. */
function parseFmt(data: Uint8Array): WavFmt {
  const fmt = findChunk(data, 'fmt ');
  if (!fmt || fmt.size < 16) throw new Error('WAV missing/short fmt chunk');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const o = fmt.offset;
  return {
    formatTag: view.getUint16(o, true),
    channels: view.getUint16(o + 2, true),
    sampleRate: view.getUint32(o + 4, true),
    blockAlign: view.getUint16(o + 12, true),
    bitsPerSample: view.getUint16(o + 14, true),
  };
}

/**
 * Decode a RIFF/WAVE buffer (PCM or IMA-ADPCM) to interleaved signed-16-bit PCM.
 * Throws for an unsupported format tag.
 */
export function decodeWav(data: Uint8Array): DecodedAudio {
  if (!looksLikeWav(data)) throw new Error('not a RIFF/WAVE file');
  const fmt = parseFmt(data);
  const dataChunk = findChunk(data, 'data');
  if (!dataChunk) throw new Error('WAV missing data chunk');
  const body = data.subarray(dataChunk.offset, dataChunk.offset + dataChunk.size);

  if (fmt.formatTag === WAVE_FORMAT_PCM) {
    return decodePcm(body, fmt);
  }
  if (fmt.formatTag === WAVE_FORMAT_IMA_ADPCM) {
    return decodeImaWav(body, fmt);
  }
  throw new Error(`Unsupported WAVE format tag 0x${fmt.formatTag.toString(16)}`);
}

/** Decode raw PCM (8-bit unsigned or 16-bit signed) to Int16 samples. */
function decodePcm(body: Uint8Array, fmt: WavFmt): DecodedAudio {
  if (fmt.bitsPerSample === 16) {
    const n = body.length >> 1;
    const out = new Int16Array(n);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
    return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels };
  }
  if (fmt.bitsPerSample === 8) {
    const out = new Int16Array(body.length);
    for (let i = 0; i < body.length; i++) out[i] = (body[i]! - 128) << 8;
    return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels };
  }
  throw new Error(`Unsupported PCM bit depth ${fmt.bitsPerSample}`);
}

/**
 * Decode IMA-ADPCM WAV blocks. Each blockAlign-byte block begins with `channels`
 * 4-byte init headers (int16 predictor, uint8 step index, uint8 reserved); the
 * remaining bytes hold nibbles grouped in 4-byte (dword) runs that interleave the
 * channels — 8 samples per channel per dword. Mono is the common case (one channel,
 * one init header, then a flat nibble stream).
 */
function decodeImaWav(body: Uint8Array, fmt: WavFmt): DecodedAudio {
  const channels = fmt.channels;
  const blockAlign = fmt.blockAlign;
  // A valid IMA block holds at least the per-channel 4-byte init headers. A corrupt
  // blockAlign of 0 would never advance `base` — an infinite loop growing outChunks
  // until the JS array ceiling — so reject implausible framing before the block walk.
  if (channels < 1 || blockAlign < channels * 4) {
    throw new Error(
      `Implausible IMA-ADPCM WAV framing: blockAlign ${blockAlign}, channels ${channels}`,
    );
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const outChunks: number[] = [];

  for (let base = 0; base + channels * 4 <= body.length; base += blockAlign) {
    const blockEnd = Math.min(base + blockAlign, body.length);
    const states: ImaState[] = [];
    // Per-channel init headers.
    for (let c = 0; c < channels; c++) {
      const predictor = view.getInt16(base + c * 4, true);
      let index = body[base + c * 4 + 2]!;
      if (index > 88) index = 88;
      const st = newImaState();
      st.predictor = predictor;
      st.index = index;
      states.push(st);
      // The predictor sample IS the first decoded sample of the block for each channel.
    }
    // Emit the init predictor samples (interleaved).
    const blockSamples: number[][] = states.map((s) => [s.predictor]);

    // Nibble data begins after the headers.
    let p = base + channels * 4;
    if (channels === 1) {
      const st = states[0]!;
      const samples = blockSamples[0]!;
      for (; p < blockEnd; p++) {
        const byte = body[p]!;
        samples.push(decodeImaNibble(byte & 0x0f, st));
        samples.push(decodeImaNibble(byte >> 4, st));
      }
    } else {
      // Interleaved: 4 bytes per channel per dword-group; 8 samples/channel/group.
      // Within a channel's 4 bytes: low nibble first, byte order low->high.
      while (p + 4 * channels <= blockEnd) {
        for (let c = 0; c < channels; c++) {
          const st = states[c]!;
          const samples = blockSamples[c]!;
          for (let b = 0; b < 4; b++) {
            const byte = body[p + c * 4 + b]!;
            samples.push(decodeImaNibble(byte & 0x0f, st));
            samples.push(decodeImaNibble(byte >> 4, st));
          }
        }
        p += 4 * channels;
      }
    }

    // Interleave this block's per-channel samples into the flat output.
    const perCh = Math.min(...blockSamples.map((s) => s.length));
    for (let i = 0; i < perCh; i++) {
      for (let c = 0; c < channels; c++) outChunks.push(blockSamples[c]![i]!);
    }
  }

  return { samples: Int16Array.from(outChunks), sampleRate: fmt.sampleRate, channels };
}
