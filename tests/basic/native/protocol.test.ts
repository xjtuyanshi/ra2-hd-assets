import { describe, expect, it } from 'vitest';
import {
  NativeMessageType,
  NativePictureDecoder,
  NATIVE_MAX_MESSAGE,
  NATIVE_PAGE_SIZE,
  decodePacket,
  encodePacket,
  encodeU32,
  decodeHello,
  decodeMirror,
  encodeSubscription,
  encodeBatch,
  encodeSamples,
} from '../../../src/adapter/native/protocol';
import type { NativeHello } from '../../../src/adapter/native/protocol';

export const syntheticHello: NativeHello = {
  protocol: 1,
  pid: 123,
  gameThreadId: 0,
  exe: { size: 1000, peTimestamp: 12345, sha256: 'a'.repeat(64), verified: true },
  surface: { width: 3, height: 2, bpp: 16, format: 'RGB565' },
  limits: { messageBytes: NATIVE_MAX_MESSAGE, pages: 4096, rules: 256 },
};
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function words(...values: number[]): Uint8Array {
  const result = new Uint8Array(values.length * 2),
    target = new DataView(result.buffer);
  values.forEach((value, index) => target.setUint16(index * 2, value, true));
  return result;
}
function picture(frame: number, width: number, height: number, rows: [number, Uint8Array][]): Uint8Array {
  return concat(
    encodeU32(frame, width, height, rows.length),
    ...rows.map(([y, encoded]) => concat(encodeU32(y, encoded.length), encoded)),
  );
}

describe('native binary protocol', () => {
  it('preserves headers and byte views for every message type', () => {
    for (let type = NativeMessageType.Hello; type <= NativeMessageType.Sample; type++) {
      const backing = new Uint8Array([99, 1, 2, 3, 98]);
      const encoded = encodePacket(type, 0xffffffff, backing.subarray(1, 4));
      const padded = concat(new Uint8Array(3), encoded, new Uint8Array(2));
      expect(decodePacket(padded.subarray(3, padded.length - 2))).toEqual({
        type,
        id: 0xffffffff,
        payload: new Uint8Array([1, 2, 3]),
      });
    }
  });
  it('rejects unknown versions, types, mismatched lengths and oversized messages', () => {
    const good = encodePacket(NativeMessageType.Read, 1, encodeU32(10));
    for (const [offset, value] of [
      [0, 0],
      [4, 2],
      [6, 255],
      [12, 9],
    ] as const) {
      const malformed = good.slice();
      malformed[offset] = value;
      expect(() => decodePacket(malformed)).toThrow();
    }
    expect(() => decodePacket(new Uint8Array(15))).toThrow('size');
    expect(() => encodePacket(NativeMessageType.Read, -1)).toThrow('request id');
    expect(() => encodePacket(NativeMessageType.Write, 1, new Uint8Array(NATIVE_MAX_MESSAGE + 1))).toThrow('limit');
  });
  it('validates identity, nested limits and binary JSON without choosing a game', () => {
    expect(decodeHello(json(syntheticHello))).toEqual(syntheticHello);
    expect(
      decodeHello(json({ ...syntheticHello, exe: { ...syntheticHello.exe, sha256: '', verified: false } })).exe
        .verified,
    ).toBe(false);
    expect(() => decodeHello(json({ ...syntheticHello, exe: undefined }))).toThrow();
    expect(() => decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, pages: 4097 } }))).toThrow();
    expect(() => decodeHello(new Uint8Array([0xff]))).toThrow('UTF-8');
  });
  it('encodes dynamic rules and rejects overflowing subscriptions before sending', () => {
    const bytes = encodeSubscription({
      ranges: [{ address: 0x4000, length: 17 }],
      rules: [{ kind: 2, source: 0x9000, bytes: 400, maxCount: 100, stride: 4 }],
      maxPages: 1024,
      budgetUs: 4000,
      sampleCount: 64,
    });
    expect([...new Uint32Array(bytes.buffer)]).toEqual([1, 1, 1024, 4000, 64, 0x4000, 17, 2, 0x9000, 400, 100, 4]);
    expect(() =>
      encodeSubscription({
        ranges: [{ address: 0xffffffff, length: 2 }],
        rules: [],
        maxPages: 1,
        budgetUs: 500,
        sampleCount: 0,
      }),
    ).toThrow('wraps');
    expect(() => encodeSubscription({ ranges: [], rules: [], maxPages: 4097, budgetUs: 500, sampleCount: 0 })).toThrow(
      'bounds',
    );
    expect(() => encodeSubscription({ ranges: [], rules: [], maxPages: 1, budgetUs: 5000, sampleCount: 0 })).toThrow(
      'bounds',
    );
  });
  it('decodes frame-boundary pages and same-frame samples with exact lengths', () => {
    const page = new Uint8Array(NATIVE_PAGE_SIZE);
    page[71] = 0xae;
    const payload = concat(
      encodeU32(100, 2, 1, 1),
      encodeU32(0x9000),
      page,
      encodeU32(0x9047, 1),
      new Uint8Array([0xae]),
    );
    const decoded = decodeMirror(payload);
    expect(decoded.frame).toBe(100);
    expect(decoded.pages[0]!.bytes[71]).toBe(0xae);
    expect(decoded.samples).toEqual([{ address: 0x9047, bytes: new Uint8Array([0xae]) }]);
    expect(() => decodeMirror(payload.subarray(0, payload.length - 1))).toThrow('sample');
    expect(() => decodeMirror(concat(payload, new Uint8Array([1])))).toThrow('Trailing');
    expect(() => decodeMirror(concat(encodeU32(1, 0, 2, 0), encodeU32(0x9000), page, encodeU32(0x9000), page))).toThrow(
      'duplicate',
    );
    expect(() => decodeMirror(concat(encodeU32(1, 0, 1, 0), encodeU32(0x9001), page))).toThrow('page');
  });
  it('encodes compare-and-write batches and enforces equal original byte signatures', () => {
    const bytes = encodeBatch([{ address: 0x4000, expected: new Uint8Array([1, 2]), bytes: new Uint8Array([3, 4]) }]);
    expect(bytes).toEqual(concat(encodeU32(1, 0x4000, 2), new Uint8Array([1, 2, 3, 4])));
    expect(() => encodeBatch([{ address: 1, expected: new Uint8Array(1), bytes: new Uint8Array(2) }])).toThrow(
      'signature',
    );
    expect(() => encodeBatch([])).toThrow('count');
    expect(() => encodeBatch([{ address: 1, expected: new Uint8Array(65537), bytes: new Uint8Array(65537) }])).toThrow(
      'limit',
    );
  });
  it('bounds deterministic same-frame sample requests', () => {
    expect(encodeSamples([{ address: 0x9000, length: 4 }])).toEqual(encodeU32(1, 0x9000, 4));
    expect(() => encodeSamples(Array.from({ length: 17 }, () => ({ address: 0x9000, length: 4 })))).toThrow('count');
    expect(() => encodeSamples([{ address: 0x9000, length: 65 }])).toThrow('length');
    expect(() => encodeSamples([{ address: 0xffffffff, length: 4 }])).toThrow('wraps');
  });
});

describe('native RGB565 picture decoding', () => {
  it('reconstructs sparse row deltas and key runs while keeping the baseline private', () => {
    const decoder = new NativePictureDecoder();
    const initial = decoder.apply(
      picture(1, 3, 2, [
        [0, words(1, 0x1234, 0x8002)],
        [1, words(3, 1, 2, 3)],
      ]),
    );
    expect([...initial.pixels]).toEqual([0x1234, 0xf81f, 0xf81f, 1, 2, 3]);
    initial.pixels.fill(9);
    const next = decoder.apply(picture(2, 3, 2, [[1, words(0x8003)]]));
    expect([...next.pixels]).toEqual([0x1234, 0xf81f, 0xf81f, 0xf81f, 0xf81f, 0xf81f]);
    expect([...decoder.apply(picture(3, 3, 2, [])).pixels]).toEqual([...next.pixels]);
  });
  it('rejects partial first frames, zero runs, short literals and invalid rows without corrupting a good image', () => {
    const decoder = new NativePictureDecoder();
    expect(() => decoder.apply(picture(0, 3, 2, [[0, words(0x8003)]]))).toThrow('every row');
    decoder.apply(picture(1, 3, 1, [[0, words(3, 1, 2, 3)]]));
    for (const bad of [words(0), words(3, 1, 2), words(0x8004), words(0x8002)]) {
      expect(() => decoder.apply(picture(2, 3, 1, [[0, bad]]))).toThrow();
    }
    expect(() => decoder.apply(picture(2, 3, 1, [[1, words(0x8003)]]))).toThrow('row');
    expect([...decoder.apply(picture(3, 3, 1, [])).pixels]).toEqual([1, 2, 3]);
    decoder.reset();
    expect(() => decoder.apply(picture(4, 3, 1, []))).toThrow('every row');
  });
});
