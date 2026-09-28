// Original Vanguard code: build a canonical PCM16 RIFF/WAVE file from decoded
// audio. Used by the dev asset server to hand the browser a plain WAV it can feed
// to the WebAudio decoder (no bespoke client-side ADPCM). Little-endian, 16-bit.

import type { DecodedAudio } from './audFile.js';

/** Byte size of the fixed PCM RIFF/WAVE header preceding the sample data. */
export const WAV_PCM_HEADER_SIZE = 44;

/**
 * Encode interleaved signed-16-bit PCM as a RIFF/WAVE (fmt 0x0001, PCM) byte
 * buffer. `channels`/`sampleRate` come from the decoded audio.
 */
export function encodeWavPcm16(audio: DecodedAudio): Uint8Array {
  const { samples, sampleRate, channels } = audio;
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(WAV_PCM_HEADER_SIZE + dataBytes);
  const view = new DataView(out.buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // RIFF chunk size
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Sample payload.
  let p = WAV_PCM_HEADER_SIZE;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(p, samples[i]!, true);
    p += 2;
  }
  return out;
}
