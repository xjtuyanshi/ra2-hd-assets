import { describe, expect, it } from 'vitest';
import {
  NativeMessageType,
  NativePictureDecoder,
  NATIVE_MAX_MESSAGE,
  NATIVE_MAX_PAGES,
  NATIVE_MAX_PICTURE_PIXELS,
  NATIVE_PAGE_SIZE,
  decodePacket,
  encodePacket,
  encodeU32,
  decodeHello,
  decodeMenuSnapshot,
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
    expect(() =>
      decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, pages: NATIVE_MAX_PAGES + 1 } })),
    ).toThrow();
    expect(() => decodeHello(new Uint8Array([0xff]))).toThrow('UTF-8');
  });
  it('preserves unknown menu metadata for whole-picture fallback and rejects malformed rectangles', () => {
    const snapshot = {
      width: 800,
      height: 600,
      dialogHwnd: 12,
      complete: false,
      moviePlaying: null,
      pointer: { x: 20, y: 30 },
      controls: [
        {
          hwnd: 13,
          parent: 12,
          id: 100,
          className: 'Button',
          style: 0,
          text: 'GUI:OriginalKey',
          textComplete: false,
          rect: { x: 10, y: 20, width: 30, height: 40 },
          visible: true,
          enabled: false,
          focused: true,
          pressed: false,
        },
      ],
    };
    expect(decodeMenuSnapshot(json(null))).toBeNull();
    expect(decodeMenuSnapshot(json(snapshot))).toEqual(snapshot);
    expect(() =>
      decodeMenuSnapshot(
        json({ ...snapshot, controls: [{ ...snapshot.controls[0], rect: { x: 10, y: 20, width: -1, height: 40 } }] }),
      ),
    ).toThrow('menu snapshot');
    expect(() =>
      decodeMenuSnapshot(json({ ...snapshot, controls: new Array(129).fill(snapshot.controls[0]) })),
    ).toThrow('menu snapshot');
    expect(() =>
      decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, menuSnapshot: 1 } })),
    ).toThrow('menu-snapshot');
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
    expect(() =>
      encodeSubscription({ ranges: [], rules: [], maxPages: NATIVE_MAX_PAGES + 1, budgetUs: 500, sampleCount: 0 }),
    ).toThrow('bounds');
    expect(() => encodeSubscription({ ranges: [], rules: [], maxPages: 1, budgetUs: 20001, sampleCount: 0 })).toThrow(
      'bounds',
    );
  });
  it('accepts a complete 4097-page mirror within the existing wire limit', () => {
    const bytes = new Uint8Array(NATIVE_PAGE_SIZE).fill(0x52),
      payload = concat(
        encodeU32(12, 2 | 16, 4097, 0),
        ...Array.from({ length: 4097 }, (_, index) => [encodeU32(index * NATIVE_PAGE_SIZE), bytes]).flat(),
        encodeU32(1),
      );
    expect(payload.byteLength).toBeLessThan(NATIVE_MAX_MESSAGE);
    expect(decodeMirror(payload).pages).toHaveLength(4097);
  });
  it('derives its page bound from the unchanged maximum wire-capacity budget', () => {
    const metadataBytes = 16 + 4 + 4,
      sampleBytes = 64 * (8 + NATIVE_PAGE_SIZE),
      pageBytes = NATIVE_PAGE_SIZE + 4 + 4,
      expected = Math.floor((NATIVE_MAX_MESSAGE - metadataBytes - sampleBytes) / pageBytes);
    expect(NATIVE_MAX_MESSAGE).toBe(32 * 1024 * 1024);
    expect(NATIVE_MAX_PAGES).toBe(expected);
    expect(metadataBytes + sampleBytes + NATIVE_MAX_PAGES * pageBytes).toBeLessThanOrEqual(NATIVE_MAX_MESSAGE);
    expect(metadataBytes + sampleBytes + (NATIVE_MAX_PAGES + 1) * pageBytes).toBeGreaterThan(NATIVE_MAX_MESSAGE);
  });
  it('preserves nested follow offsets in the five-word rule layout and validates optional capabilities', () => {
    const rules = ([4, 5, 6, 7, 8] as const).map((kind) => ({
      kind,
      source: 0x9000,
      bytes: 0x800,
      maxCount: 4096,
      stride: kind >= 7 ? 0x58 * 0x10000 + 0x53bc : 0xbc,
    }));
    const bytes = encodeSubscription({ ranges: [], rules, maxPages: 4096, budgetUs: 4000, sampleCount: 0 });
    expect(bytes.length).toBe(20 + 5 * 20);
    expect([...new Uint32Array(bytes.buffer)].slice(5)).toEqual(
      rules.flatMap((rule) => [rule.kind, rule.source, rule.bytes, rule.maxCount, rule.stride]),
    );
    expect(() =>
      encodeSubscription({
        ranges: [],
        rules: [{ ...rules[0]!, stride: 0xfffffff0 }],
        maxPages: 4096,
        budgetUs: 4000,
        sampleCount: 0,
      }),
    ).toThrow('follow rule');
    const limits = { ...syntheticHello.limits, followRuleKinds: [1, 2, 3, 4, 5, 6, 7, 8] };
    expect(decodeHello(json({ ...syntheticHello, limits })).limits.followRuleKinds).toEqual(limits.followRuleKinds);
    for (const followRuleKinds of [[0], [9], [4, 4], [1.5], '1,2'])
      expect(() => decodeHello(json({ ...syntheticHello, limits: { ...limits, followRuleKinds } }))).toThrow(
        'capabilities',
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
  it('opts into page removals while preserving the legacy subscription and hello contract', () => {
    const options = { ranges: [], rules: [], maxPages: 4096, budgetUs: 4000, sampleCount: 64 };
    expect([...new Uint32Array(encodeSubscription(options).buffer)]).toEqual([0, 0, 4096, 4000, 64]);
    expect([...new Uint32Array(encodeSubscription({ ...options, pageRemovals: true }).buffer)]).toEqual([
      0, 0, 4096, 4000, 0x80000040,
    ]);
    expect(
      decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, pageRemovals: true } })).limits
        .pageRemovals,
    ).toBe(true);
    expect(() =>
      decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, pageRemovals: 1 } })),
    ).toThrow('capability');
  });
  it('negotiates a bounded second mirror credit without changing legacy subscription words', () => {
    const options = { ranges: [], rules: [], maxPages: 4096, budgetUs: 4000, sampleCount: 64, pageRemovals: true };
    expect([...new Uint32Array(encodeSubscription({ ...options, mirrorWindow: 1 }).buffer)]).toEqual([
      0, 0, 4096, 4000, 0x80000040,
    ]);
    expect([...new Uint32Array(encodeSubscription({ ...options, mirrorWindow: 2 }).buffer)]).toEqual([
      0, 0, 4096, 4000, 0xc0000040,
    ]);
    expect(() => encodeSubscription({ ...options, pageRemovals: false, mirrorWindow: 2 })).toThrow('bounds');
    for (const mirrorWindow of [1, 2] as const)
      expect(
        decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, mirrorWindow } })).limits
          .mirrorWindow,
      ).toBe(mirrorWindow);
    for (const mirrorWindow of [0, 3, 1.5, true, '2']) {
      expect(() =>
        decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, mirrorWindow } })),
      ).toThrow('mirror-window');
      expect(() => encodeSubscription({ ...options, mirrorWindow: mirrorWindow as 2 })).toThrow('bounds');
    }
    expect(decodeHello(json(syntheticHello)).limits.mirrorWindow).toBeUndefined();
  });
  it('decodes sorted removals after samples and rejects malformed removal tails', () => {
    const page = new Uint8Array(NATIVE_PAGE_SIZE).fill(0x42);
    const payload = concat(
      encodeU32(101, 8, 1, 1),
      encodeU32(0x9000),
      page,
      encodeU32(0x9001, 1),
      new Uint8Array([0x42]),
      encodeU32(2, 0x1000, 0x8000),
    );
    expect(decodeMirror(payload)).toMatchObject({
      frame: 101,
      removedPages: [0x1000, 0x8000],
      samples: [{ address: 0x9001, bytes: new Uint8Array([0x42]) }],
    });
    expect(decodeMirror(encodeU32(102, 8, 0, 0, 0)).removedPages).toEqual([]);
    expect(decodeMirror(encodeU32(102, 0, 0, 0))).not.toHaveProperty('removedPages');
    for (const tail of [
      encodeU32(4097),
      encodeU32(1),
      encodeU32(2, 0x1000, 0x1000),
      encodeU32(2, 0x8000, 0x1000),
      encodeU32(1, 0x1001),
    ])
      expect(() => decodeMirror(concat(encodeU32(102, 8, 0, 0), tail))).toThrow('removal');
    expect(() => decodeMirror(encodeU32(102, 8, 0, 0))).toThrow('removal');
    expect(() => decodeMirror(concat(encodeU32(102, 8, 1, 0), encodeU32(0x9000), page, encodeU32(1, 0x9000)))).toThrow(
      'removal',
    );
    expect(() => decodeMirror(encodeU32(102, 10, 0, 0, 0))).toThrow('bounds');
    expect(() => decodeMirror(encodeU32(102, 0, 0, 0, 0))).toThrow('Trailing');
  });
  it('bounds advertised capture budgets and accepts the negotiated full-map bootstrap budget', () => {
    const limits = { ...syntheticHello.limits, maxBudgetUs: 20000 };
    expect(decodeHello(json({ ...syntheticHello, limits })).limits.maxBudgetUs).toBe(20000);
    for (const maxBudgetUs of [99, 20001, 1.5, '20000'])
      expect(() => decodeHello(json({ ...syntheticHello, limits: { ...limits, maxBudgetUs } }))).toThrow('budget');
    expect([
      ...new Uint32Array(
        encodeSubscription({ ranges: [], rules: [], maxPages: 4096, budgetUs: 12000, sampleCount: 0 }).buffer,
      ),
    ]).toEqual([0, 0, 4096, 12000, 0]);
  });
  it('decodes the negotiated revision after both samples and removals, including initial reset', () => {
    expect(decodeMirror(encodeU32(100, 18, 0, 0, 7))).toMatchObject({ flags: 18, subscriptionRevision: 7 });
    expect(
      decodeMirror(concat(encodeU32(101, 24, 0, 1, 0x2000, 1), new Uint8Array([33]), encodeU32(1, 0x1000, 8))),
    ).toMatchObject({ removedPages: [0x1000], subscriptionRevision: 8 });
    expect(() => decodeMirror(encodeU32(101, 16, 0, 0))).toThrow('revision');
    expect(() => decodeMirror(encodeU32(101, 17, 0, 0, 8))).toThrow('bounds');
    expect(() => decodeMirror(encodeU32(101, 20, 0, 0, 8))).toThrow('bounds');
    expect(() =>
      decodeHello(json({ ...syntheticHello, limits: { ...syntheticHello.limits, subscribeRevision: 1 } })),
    ).toThrow('revision');
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
  it('decodes a complete Wide fullscreen frame and preserves its baseline after an oversized delta', () => {
    const decoder = new NativePictureDecoder();
    const width = 2056,
      height = 1290;
    const rows: [number, Uint8Array][] = Array.from({ length: height }, (_, y) => [y, words(0x8000 | width)]);
    const initial = decoder.apply(picture(1, width, height, rows));
    expect(initial.pixels).toHaveLength(width * height);
    expect(initial.pixels[width * height - 1]).toBe(0xf81f);
    expect(NATIVE_MAX_PICTURE_PIXELS).toBe(3 * 1024 * 1024);
    expect(NATIVE_MAX_PICTURE_PIXELS * 4 + 4096 * 8 + 16).toBeLessThan(NATIVE_MAX_MESSAGE);
    expect(() => decoder.apply(picture(2, 2048, 1537, []))).toThrow('dimensions');
    const next = decoder.apply(picture(3, width, height, [[height - 1, words(1, 0x1234, 0x8000 | (width - 1))]]));
    expect(next.pixels[(height - 1) * width]).toBe(0x1234);
    expect(next.pixels[0]).toBe(0xf81f);
  });
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
