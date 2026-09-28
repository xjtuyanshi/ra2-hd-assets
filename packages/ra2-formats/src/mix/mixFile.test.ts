import { describe, expect, it } from 'vitest';
import { idFromName } from './crc.js';
import { MIX_FLAG_CHECKSUM, MixFile } from './mixFile.js';

interface SynthEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Build a synthetic, unencrypted RA2-flagged MIX from named byte blobs. Layout:
 * [flags:4][c_files:2][bodySize:4][index: c_files*12][body][checksum?].
 * All bytes are constructed here — no game files are copied.
 */
function buildPlainMix(entries: SynthEntry[], opts: { checksum?: boolean } = {}): Uint8Array {
  const cbIndex = entries.length * 12;
  const bodySize = entries.reduce((n, e) => n + e.data.length, 0);
  const checksum = opts.checksum ?? false;
  const total = 4 + 6 + cbIndex + bodySize + (checksum ? 20 : 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 0 | (checksum ? MIX_FLAG_CHECKSUM : 0), true);
  view.setUint16(4, entries.length, true);
  view.setInt32(6, bodySize, true);

  let indexP = 4 + 6;
  let bodyOffset = 0; // relative to start of body
  const bodyBase = 4 + 6 + cbIndex;
  for (const e of entries) {
    view.setUint32(indexP, idFromName(e.name) >>> 0, true);
    view.setInt32(indexP + 4, bodyOffset, true);
    view.setInt32(indexP + 8, e.data.length, true);
    buf.set(e.data, bodyBase + bodyOffset);
    indexP += 12;
    bodyOffset += e.data.length;
  }
  return buf;
}

const asString = (u: Uint8Array | undefined): string | undefined =>
  u ? new TextDecoder().decode(u) : undefined;

describe('MixFile (unencrypted synthetic)', () => {
  const entries: SynthEntry[] = [
    { name: 'rules.ini', data: new TextEncoder().encode('[General]\nName=Test\n') },
    { name: 'art.ini', data: new TextEncoder().encode('[ArtStuff]\n') },
    { name: 'data.bin', data: Uint8Array.from([1, 2, 3, 4, 5]) },
  ];

  it('parses flags, count, and index', () => {
    const mix = MixFile.parse(buildPlainMix(entries));
    expect(mix.encrypted).toBe(false);
    expect(mix.checksum).toBe(false);
    expect(mix.count).toBe(3);
    expect(mix.list()).toHaveLength(3);
  });

  it('reads files by name', () => {
    const mix = MixFile.parse(buildPlainMix(entries));
    expect(asString(mix.read('rules.ini'))).toBe('[General]\nName=Test\n');
    expect(asString(mix.read('RULES.INI'))).toBe('[General]\nName=Test\n'); // case-insensitive
    expect([...(mix.read('data.bin') ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads files by id', () => {
    const mix = MixFile.parse(buildPlainMix(entries));
    expect(asString(mix.readById(idFromName('art.ini')))).toBe('[ArtStuff]\n');
  });

  it('returns undefined for missing files', () => {
    const mix = MixFile.parse(buildPlainMix(entries));
    expect(mix.read('nope.dat')).toBeUndefined();
    expect(mix.getEntry('nope.dat')).toBeUndefined();
  });

  it('exposes correct offsets and sizes in the index', () => {
    const mix = MixFile.parse(buildPlainMix(entries));
    const e = mix.getEntry('data.bin');
    expect(e).toBeDefined();
    expect(e!.size).toBe(5);
    // Offset should point at real data within the buffer.
    expect([...mix.buffer.subarray(e!.offset, e!.offset + e!.size)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses archives carrying the checksum flag', () => {
    const mix = MixFile.parse(buildPlainMix(entries, { checksum: true }));
    expect(mix.checksum).toBe(true);
    expect(mix.count).toBe(3);
    expect(asString(mix.read('rules.ini'))).toBe('[General]\nName=Test\n');
  });

  it('rejects unknown flag bits', () => {
    const buf = buildPlainMix(entries);
    new DataView(buf.buffer).setUint32(0, 0x00040000, true);
    expect(() => MixFile.parse(buf)).toThrow(/Unsupported MIX flags/);
  });

  it('rejects a truncated buffer', () => {
    const buf = buildPlainMix(entries).subarray(0, 20);
    expect(() => MixFile.parse(buf)).toThrow();
  });

  it('handles an empty archive', () => {
    const mix = MixFile.parse(buildPlainMix([]));
    expect(mix.count).toBe(0);
    expect(mix.read('anything')).toBeUndefined();
  });
});
