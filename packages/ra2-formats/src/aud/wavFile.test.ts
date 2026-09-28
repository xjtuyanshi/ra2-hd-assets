import { describe, expect, it } from 'vitest';
import { decodeWav, looksLikeWav, WAVE_FORMAT_IMA_ADPCM, WAVE_FORMAT_PCM } from './wavFile.js';
import { encodeWavPcm16 } from './wavWrite.js';

const IMA_BYTES = Uint8Array.from([72, 124, 15, 162, 213, 145, 230, 179]);
const IMA_GOLDEN = [0, 7, -3, 16, -25, -19, 8, -17, 33, -41, -11, -38, 69, -122, 60, -105];

/** Assemble a minimal RIFF/WAVE from a fmt block and data payload. */
function buildWav(fmt: Uint8Array, data: Uint8Array): Uint8Array {
  const riffSize = 4 + (8 + fmt.length) + (8 + data.length);
  const out = new Uint8Array(8 + riffSize);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, riffSize, true);
  str(8, 'WAVE');
  let p = 12;
  str(p, 'fmt '); v.setUint32(p + 4, fmt.length, true); out.set(fmt, p + 8); p += 8 + fmt.length;
  str(p, 'data'); v.setUint32(p + 4, data.length, true); out.set(data, p + 8);
  return out;
}

/** A 16-byte fmt chunk. */
function fmtChunk(tag: number, channels: number, rate: number, blockAlign: number, bits: number): Uint8Array {
  const f = new Uint8Array(16);
  const v = new DataView(f.buffer);
  v.setUint16(0, tag, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, rate * blockAlign, true);
  v.setUint16(12, blockAlign, true);
  v.setUint16(14, bits, true);
  return f;
}

describe('looksLikeWav', () => {
  it('recognises a RIFF/WAVE signature', () => {
    const wav = buildWav(fmtChunk(WAVE_FORMAT_PCM, 1, 22050, 2, 16), new Uint8Array(4));
    expect(looksLikeWav(wav)).toBe(true);
    expect(looksLikeWav(Uint8Array.from([1, 2, 3, 4]))).toBe(false);
  });
});

describe('decodeWav (PCM)', () => {
  it('reads signed 16-bit PCM verbatim', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const data = new Uint8Array(samples.buffer.slice(0));
    const wav = buildWav(fmtChunk(WAVE_FORMAT_PCM, 1, 22050, 2, 16), data);
    const decoded = decodeWav(wav);
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleRate).toBe(22050);
    expect([...decoded.samples]).toEqual([0, 1000, -1000, 32767, -32768]);
  });
});

describe('decodeWav (IMA-ADPCM, mono)', () => {
  it('decodes a single mono block: init predictor + nibble run', () => {
    // Mono IMA block: 4-byte header (predictor=0, index=0, pad) then the golden
    // nibble bytes. The block's first output sample is the init predictor (0),
    // followed by the golden vector.
    const blockAlign = 4 + IMA_BYTES.length;
    const data = new Uint8Array(blockAlign);
    // header: predictor int16=0, index=0, reserved=0 (already zeroed)
    data.set(IMA_BYTES, 4);
    const wav = buildWav(fmtChunk(WAVE_FORMAT_IMA_ADPCM, 1, 22050, blockAlign, 4), data);
    const decoded = decodeWav(wav);
    // First sample is the init predictor (0), then the golden run.
    expect(decoded.samples[0]).toBe(0);
    expect([...decoded.samples.slice(1)]).toEqual(IMA_GOLDEN);
  });

  it('rejects an unsupported format tag', () => {
    const wav = buildWav(fmtChunk(0x0055, 1, 22050, 2, 16), new Uint8Array(4));
    expect(() => decodeWav(wav)).toThrow(/Unsupported WAVE format/);
  });

  it('rejects blockAlign=0 instead of looping forever (DoS defense)', () => {
    // With blockAlign=0 the block walk never advances `base`: an infinite loop
    // growing the output until the JS array ceiling (~4.3s spin then RangeError).
    // The framing guard must throw immediately instead.
    const wav = buildWav(fmtChunk(WAVE_FORMAT_IMA_ADPCM, 1, 22050, 0, 4), new Uint8Array(64));
    const t0 = performance.now();
    expect(() => decodeWav(wav)).toThrow(/Implausible IMA-ADPCM WAV framing/);
    expect(performance.now() - t0).toBeLessThan(500); // immediate, not a multi-second spin
  });

  it('rejects a blockAlign too small for the per-channel init headers', () => {
    // Stereo needs 8 header bytes per block; blockAlign=4 cannot frame it.
    const wav = buildWav(fmtChunk(WAVE_FORMAT_IMA_ADPCM, 2, 22050, 4, 4), new Uint8Array(64));
    expect(() => decodeWav(wav)).toThrow(/Implausible IMA-ADPCM WAV framing/);
  });

  it('rejects channels=0 IMA framing', () => {
    const wav = buildWav(fmtChunk(WAVE_FORMAT_IMA_ADPCM, 0, 22050, 512, 4), new Uint8Array(64));
    expect(() => decodeWav(wav)).toThrow(/Implausible IMA-ADPCM WAV framing/);
  });
});

describe('encodeWavPcm16 roundtrip', () => {
  it('writes a PCM16 WAV that decodes back to the same samples', () => {
    const audio = { samples: new Int16Array([5, -5, 12345, -12345, 0]), sampleRate: 22050, channels: 1 };
    const wav = encodeWavPcm16(audio);
    expect(looksLikeWav(wav)).toBe(true);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(22050);
    expect(back.channels).toBe(1);
    expect([...back.samples]).toEqual([5, -5, 12345, -12345, 0]);
  });

  it('encodes the correct RIFF/fmt/data header fields', () => {
    const wav = encodeWavPcm16({ samples: new Int16Array([1, 2]), sampleRate: 44100, channels: 2 });
    const v = new DataView(wav.buffer);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // channels
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16); // bits
    expect(String.fromCharCode(wav[36]!, wav[37]!, wav[38]!, wav[39]!)).toBe('data');
  });
});
