import { describe, expect, it } from 'vitest';
import { AudioBank, BANK_FLAG_COMPRESSED, IDX_ENTRY_SIZE } from './audioBank.js';

const IMA_BYTES = Uint8Array.from([72, 124, 15, 162, 213, 145, 230, 179]);
const IMA_GOLDEN = [0, 7, -3, 16, -25, -19, 8, -17, 33, -41, -11, -38, 69, -122, 60, -105];

/** Build a synthetic IDX (with a GABA header + prefix noise) + BAG for one entry. */
function buildBank(opts: {
  name: string;
  body: Uint8Array;
  sampleRate?: number;
  flags?: number;
  chunkSize?: number;
  prefix?: number;
}): { idx: Uint8Array; bag: Uint8Array } {
  const sampleRate = opts.sampleRate ?? 22050;
  const flags = opts.flags ?? BANK_FLAG_COMPRESSED;
  const chunkSize = opts.chunkSize ?? 512;
  const prefix = opts.prefix ?? 5; // simulate the real idx's leading non-GABA bytes
  const idx = new Uint8Array(prefix + 12 + IDX_ENTRY_SIZE);
  const view = new DataView(idx.buffer);
  let p = prefix;
  idx[p] = 0x47; idx[p + 1] = 0x41; idx[p + 2] = 0x42; idx[p + 3] = 0x41; // "GABA"
  view.setInt32(p + 4, 1, true); // count (deliberately unreliable in real files)
  view.setInt32(p + 8, 0, true); // reserved
  p += 12;
  // entry: name[16], offset, size, rate, flags, chunkSize
  for (let i = 0; i < opts.name.length && i < 16; i++) idx[p + i] = opts.name.charCodeAt(i);
  view.setInt32(p + 16, 0, true); // offset
  view.setInt32(p + 20, opts.body.length, true);
  view.setInt32(p + 24, sampleRate, true);
  view.setInt32(p + 28, flags, true);
  view.setInt32(p + 32, chunkSize, true);
  return { idx, bag: opts.body.slice() };
}

describe('AudioBank.parse', () => {
  it('locates the GABA header past a leading prefix and reads the entry', () => {
    const { idx, bag } = buildBank({ name: 'ibruatta', body: IMA_BYTES });
    const bank = AudioBank.parse(idx, bag);
    expect(bank.count).toBe(1);
    expect(bank.has('IBRUATTA')).toBe(true); // case-insensitive
    const e = bank.entry('ibruatta')!;
    expect(e.offset).toBe(0);
    expect(e.size).toBe(IMA_BYTES.length);
    expect(e.sampleRate).toBe(22050);
    expect(e.chunkSize).toBe(512);
  });

  it('skips a malformed trailing record (offset/size outside the bag)', () => {
    const { idx, bag } = buildBank({ name: 'ok', body: IMA_BYTES });
    // Append a second entry pointing past the end of the bag.
    const grown = new Uint8Array(idx.length + IDX_ENTRY_SIZE);
    grown.set(idx, 0);
    const v = new DataView(grown.buffer);
    const q = idx.length;
    for (const ch of 'bad') grown[q + 'bad'.indexOf(ch)] = ch.charCodeAt(0);
    v.setInt32(q + 16, 999999, true); // offset outside bag
    v.setInt32(q + 20, 10, true);
    const bank = AudioBank.parse(grown, bag);
    expect(bank.count).toBe(1);
    expect(bank.has('bad')).toBe(false);
  });

  it('throws when no GABA header is present', () => {
    expect(() => AudioBank.parse(new Uint8Array(40), new Uint8Array(0))).toThrow(/GABA/);
  });
});

describe('AudioBank.decode', () => {
  it('decodes a compressed (IMA) entry to the golden PCM vector', () => {
    const { idx, bag } = buildBank({ name: 'sfx', body: IMA_BYTES });
    const bank = AudioBank.parse(idx, bag);
    const decoded = bank.decode('sfx')!;
    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.channels).toBe(1);
    expect([...decoded.samples]).toEqual(IMA_GOLDEN);
  });

  it('resets ADPCM state at each chunkSize block boundary', () => {
    // Two golden blocks back-to-back with chunkSize == one block: state resets, so
    // the second block's PCM equals the first's.
    const doubled = new Uint8Array(IMA_BYTES.length * 2);
    doubled.set(IMA_BYTES, 0);
    doubled.set(IMA_BYTES, IMA_BYTES.length);
    const { idx, bag } = buildBank({ name: 'sfx', body: doubled, chunkSize: IMA_BYTES.length });
    const bank = AudioBank.parse(idx, bag);
    const { samples } = bank.decode('sfx')!;
    const half = samples.length / 2;
    expect([...samples.slice(0, half)]).toEqual([...samples.slice(half)]);
    expect([...samples.slice(0, half)]).toEqual(IMA_GOLDEN);
  });

  it('reads an uncompressed (flags without the compressed bit) entry as raw PCM16', () => {
    const raw = new Int16Array([100, -200, 300, -400]);
    const body = new Uint8Array(raw.buffer.slice(0));
    const { idx, bag } = buildBank({ name: 'raw', body, flags: 0 });
    const bank = AudioBank.parse(idx, bag);
    const { samples } = bank.decode('raw')!;
    expect([...samples]).toEqual([100, -200, 300, -400]);
  });

  it('returns undefined for an absent name', () => {
    const { idx, bag } = buildBank({ name: 'sfx', body: IMA_BYTES });
    expect(AudioBank.parse(idx, bag).decode('missing')).toBeUndefined();
  });
});
