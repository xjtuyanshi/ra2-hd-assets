// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/aud_file.h,
// misc/aud_decode.cpp.
//
// Parser for the Westwood AUD container (Red Alert 2 / Yuri's Revenge and earlier
// Westwood titles). An AUD is a tiny header followed by a stream of independently
// compressed chunks:
//
//   header (12 bytes):
//     uint16 sampleRate      samples/second (e.g. 22050)
//     uint32 sizeCompressed  total compressed body size (all chunk bodies + headers)
//     uint32 sizeUncompressed decoded PCM byte count (samples * bytesPerSample * chans)
//     uint8  flags           bit0 = stereo, bit1 = 16-bit samples
//     uint8  type            1 = Westwood ADPCM, 99 = IMA-ADPCM
//
//   then chunks, each:
//     uint16 chunkSizeCompressed
//     uint16 chunkSizeUncompressed
//     uint32 id              always 0x0000DEAF ("chunk magic") in a valid AUD
//     <chunkSizeCompressed bytes of compressed data>
//
// IMA-ADPCM chunks reset the predictor/index at each chunk boundary (Westwood packs
// one self-contained IMA block per chunk); Westwood-ADPCM chunks are self-contained
// runs. Both decoders live in aud/adpcm.ts and are unit-tested against golden vectors.

import { decodeImaBlock, decodeWestwood, newImaState } from './adpcm.js';

/** Byte size of the AUD file header. */
export const AUD_HEADER_SIZE = 12;
/** Byte size of each per-chunk header. */
export const AUD_CHUNK_HEADER_SIZE = 8;
/** The magic id stamped into every valid AUD chunk header. */
export const AUD_CHUNK_ID = 0x0000deaf;

/** AUD compression type: Westwood ADPCM. */
export const AUD_TYPE_WESTWOOD = 1;
/** AUD compression type: IMA-ADPCM. */
export const AUD_TYPE_IMA_ADPCM = 99;

/**
 * Ceiling on an AUD's declared uncompressed byte count (256 MiB ≈ 24 min of stereo
 * 16-bit @ 22 kHz — far above any RA2 sound/EVA/theme clip). `decode()` allocates an
 * `Int16Array(sizeUncompressed / bytesPerSample)` up front, so an unbounded uint32
 * `sizeUncompressed` (max 4 GiB ⇒ ~8.6 GB off-heap) lets a 12-byte corrupt header
 * OOM the process. Rejecting an implausible value at parse time — alongside the
 * existing type/sampleRate checks — bounds the allocation with no effect on real files.
 */
export const MAX_AUD_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

/** AUD flag bit: the stream is stereo (2 interleaved channels). */
export const AUD_FLAG_STEREO = 0x01;
/** AUD flag bit: samples are 16-bit (else 8-bit). */
export const AUD_FLAG_16BIT = 0x02;

/** Decoded audio: interleaved signed-16-bit PCM plus its format. */
export interface DecodedAudio {
  /** Interleaved signed 16-bit PCM samples (per-channel count = length / channels). */
  readonly samples: Int16Array;
  /** Sample rate in Hz. */
  readonly sampleRate: number;
  /** Channel count (1 = mono, 2 = stereo). */
  readonly channels: number;
}

/** Parsed AUD header fields. */
export interface AudHeader {
  readonly sampleRate: number;
  readonly sizeCompressed: number;
  readonly sizeUncompressed: number;
  readonly flags: number;
  readonly type: number;
  readonly channels: number;
  /** Bytes per sample per channel (1 for 8-bit, 2 for 16-bit). */
  readonly bytesPerSample: number;
}

/**
 * A parsed Westwood AUD file. Holds the header and a reference to the backing
 * buffer; {@link decode} walks the chunks lazily into a single PCM buffer.
 */
export class AudFile {
  private constructor(
    readonly header: AudHeader,
    private readonly data: Uint8Array,
  ) {}

  /** Parse an AUD from a byte buffer. Throws if the header is malformed. */
  static parse(data: Uint8Array): AudFile {
    if (data.length < AUD_HEADER_SIZE) {
      throw new Error('AUD too small to contain a header');
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sampleRate = view.getUint16(0, true);
    const sizeCompressed = view.getUint32(2, true);
    const sizeUncompressed = view.getUint32(6, true);
    const flags = view.getUint8(10);
    const type = view.getUint8(11);
    if (type !== AUD_TYPE_WESTWOOD && type !== AUD_TYPE_IMA_ADPCM) {
      throw new Error(`Unsupported AUD compression type ${type}`);
    }
    if (sampleRate <= 0 || sampleRate > 96000) {
      throw new Error(`Implausible AUD sample rate ${sampleRate}`);
    }
    if (sizeUncompressed > MAX_AUD_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Implausible AUD uncompressed size ${sizeUncompressed} (> ${MAX_AUD_UNCOMPRESSED_BYTES})`,
      );
    }
    const channels = flags & AUD_FLAG_STEREO ? 2 : 1;
    const bytesPerSample = flags & AUD_FLAG_16BIT ? 2 : 1;
    const header: AudHeader = {
      sampleRate,
      sizeCompressed,
      sizeUncompressed,
      flags,
      type,
      channels,
      bytesPerSample,
    };
    return new AudFile(header, data);
  }

  /** True if a buffer looks like an AUD (plausible header + known codec type). */
  static looksLikeAud(data: Uint8Array): boolean {
    if (data.length < AUD_HEADER_SIZE) return false;
    const type = data[11]!;
    const rate = data[0]! | (data[1]! << 8);
    return (type === AUD_TYPE_WESTWOOD || type === AUD_TYPE_IMA_ADPCM) && rate > 0 && rate <= 96000;
  }

  /**
   * Decode the whole file to interleaved signed-16-bit PCM. Walks each chunk,
   * validates its magic, and decodes its body with the header's codec. IMA chunks
   * reset ADPCM state per chunk; Westwood chunks are self-contained.
   */
  decode(): DecodedAudio {
    const { type, channels, sampleRate, sizeUncompressed } = this.header;
    // Total decoded 16-bit sample count. IMA/Westwood both emit one Int16 per input
    // sample slot; the header's uncompressed byte count / bytesPerSample gives it.
    // We always emit 16-bit PCM regardless of the source bit depth.
    const totalSamples = Math.floor(sizeUncompressed / this.header.bytesPerSample);
    const out = new Int16Array(totalSamples);
    let outPos = 0;

    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    let p = AUD_HEADER_SIZE;
    while (p + AUD_CHUNK_HEADER_SIZE <= this.data.length && outPos < totalSamples) {
      const cSizeCompressed = view.getUint16(p, true);
      const cSizeUncompressed = view.getUint16(p + 2, true);
      const id = view.getUint32(p + 4, true);
      p += AUD_CHUNK_HEADER_SIZE;
      if (id !== AUD_CHUNK_ID) {
        // Corrupt / truncated chunk stream — stop rather than emit garbage.
        break;
      }
      const bodyEnd = Math.min(p + cSizeCompressed, this.data.length);
      if (type === AUD_TYPE_IMA_ADPCM) {
        // Each IMA chunk is a self-contained block: reset state, decode nibbles.
        const state = newImaState();
        const wrote = decodeImaBlock(this.data, p, bodyEnd - p, state, out, outPos);
        // Trust the chunk's declared uncompressed sample count when it is shorter
        // (a partial trailing chunk), else take whatever the nibbles produced.
        const declared = Math.floor(cSizeUncompressed / this.header.bytesPerSample);
        outPos += declared > 0 ? Math.min(wrote, declared) : wrote;
      } else {
        const declared = Math.floor(cSizeUncompressed / this.header.bytesPerSample);
        const chunkPcm = decodeWestwood(this.data.subarray(p, bodyEnd), declared);
        out.set(chunkPcm.subarray(0, Math.min(chunkPcm.length, totalSamples - outPos)), outPos);
        outPos += Math.min(chunkPcm.length, totalSamples - outPos);
      }
      p = bodyEnd;
    }

    // If the header over-declared, trim to what we actually decoded.
    const samples = outPos === totalSamples ? out : out.subarray(0, outPos);
    return { samples, sampleRate, channels };
  }
}
