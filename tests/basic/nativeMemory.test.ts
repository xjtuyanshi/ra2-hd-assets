import { expect, it } from 'vitest';
import { NATIVE_MAX_PAGES } from '../../src/adapter/native/protocol';
import {
  NativeMirrorMemory,
  NativeMemoryMiss,
  NativeMemoryTransaction,
  NativeAllocationMiss,
  readNativeWithRetry,
  runNativeTransaction,
  type NativeTransactionHost,
} from '../../src/adapter/native/memory';
function page(address: number, value = 0) {
  return { address, bytes: new Uint8Array(4096).fill(value) };
}
it('publishes a complete 4097-page image without substituting or losing the last page', () => {
  const memory = new NativeMirrorMemory(),
    bytes = new Uint8Array(4096).fill(0x52);
  expect(
    memory.apply({
      frame: 12,
      flags: 2,
      pages: Array.from({ length: 4097 }, (_, index) => ({ address: index * 4096, bytes })),
    }),
  ).toBe(true);
  expect(memory.complete).toBe(true);
  expect(memory.read_memory(4096 * 4096, 1)[0]).toBe(0x52);
  expect(memory.publishedRanges).toEqual([{ address: 0, length: 4097 * 4096 }]);
});
it('sparse missing pages throw and remain observable when a reader swallows the exception', () => {
  const m = new NativeMirrorMemory();
  m.apply({ frame: 3, flags: 2, pages: [page(4096, 17)] });
  m.beginOperation();
  try {
    m.read_memory(8192, 2);
  } catch {}
  expect(m.operationMissed).toBe(true);
  expect(m.missingRanges).toEqual([{ address: 8192, length: 4096 }]);
  expect(() => m.read_memory(0, 1)).toThrow(NativeMemoryMiss);
  expect(m.read_memory(4096, 2)).toEqual(new Uint8Array([17, 17]));
});
it('optional availability probes cannot poison strict reads, subscribe pages, or retain working-set pages', () => {
  const requests: unknown[] = [],
    m = new NativeMirrorMemory((ranges) => requests.push(ranges));
  const available = m.accessor().isRangeAvailable!;
  expect(available(0, 0)).toBe(false);
  m.apply({ frame: 1, flags: 2, pages: [page(0x1000), page(0x2000), page(0xfffff000)] });
  m.beginOperation();
  expect(available(0x1fff, 2)).toBe(true);
  expect(available(0x2fff, 2)).toBe(false);
  expect(available(0xffffffff, 1)).toBe(true);
  expect(available(0x100000000, 0)).toBe(true);
  expect(available(0x4000, 0)).toBe(true);
  expect(available(0x4001, 0)).toBe(true);
  for (const [address, length] of [
    [-1, 0],
    [0, -1],
    [1.5, 1],
    [1, 1.5],
    [NaN, 1],
    [1, Infinity],
    [0xffffffff, 2],
    [0x100000001, 0],
  ])
    expect(available(address!, length!)).toBe(false);
  expect(m.misses).toBe(0);
  expect(m.operationMissed).toBe(false);
  expect(m.operationRanges).toEqual([]);
  expect(m.missingRanges).toEqual([]);
  expect(requests).toEqual([]);
  m.read_memory(0x1000, 1);
  expect(m.operationRanges).toEqual([{ address: 0x1000, length: 4096 }]);
  expect(() => m.read_memory(0x4000, 1)).toThrow(NativeMemoryMiss);
  expect(m.operationMissed).toBe(true);
  expect(available(0x2000, 1)).toBe(true);
  expect(m.operationMissed).toBe(true);
  expect(requests).toHaveLength(1);
  m.apply({ frame: 2, flags: 1, pages: [] });
  expect(available(0x1000, 1)).toBe(false);
});
it('cross-page read and frame updates retain exact bytes while incomplete snapshots are abandoned', () => {
  const m = new NativeMirrorMemory();
  m.apply({ frame: 8, flags: 2, pages: [page(4096, 17), page(8192, 33)] });
  expect(m.read_memory(8191, 2)).toEqual(new Uint8Array([17, 33]));
  expect(m.apply({ frame: 9, flags: 1, pages: [page(4096, 55)] })).toBe(false);
  expect(m.frame).toBe(8);
  expect(m.complete).toBe(false);
  m.apply({ frame: 10, flags: 0, pages: [page(8192, 44)] });
  expect(m.read_memory(8191, 2)).toEqual(new Uint8Array([17, 44]));
});
it('page removals retire allocations without resetting retained pages and allow later reallocation', () => {
  const m = new NativeMirrorMemory();
  m.apply({ frame: 1, flags: 2, pages: [page(0x1000, 17), page(0x2000, 33)] });
  m.apply({ frame: 2, flags: 8, pages: [page(0x3000, 44)], removedPages: [0x1000] });
  expect(m.read_memory(0x2000, 1)[0]).toBe(33);
  expect(m.read_memory(0x3000, 1)[0]).toBe(44);
  expect(() => m.read_memory(0x1000, 1)).toThrow(NativeMemoryMiss);
  m.apply({ frame: 3, flags: 0, pages: [page(0x1000, 55)] });
  expect(m.read_memory(0x1000, 1)[0]).toBe(55);
  expect(m.missingRanges).toEqual([]);
});
it('malformed pages and removals cannot partially change a published frame or its miss footprint', () => {
  const m = new NativeMirrorMemory();
  m.apply({ frame: 1, flags: 2, pages: [page(0x1000, 17), page(0x2000, 33)] });
  expect(() => m.read_memory(0x3000, 1)).toThrow(NativeMemoryMiss);
  const missing = m.missingRanges;
  for (const update of [
    { frame: 2, flags: 2, pages: [page(0x3000), page(0x4001)] },
    { frame: 2, flags: 8, pages: [page(0x3000), page(0x4001)], removedPages: [0x1000] },
    { frame: 2, flags: 8, pages: [], removedPages: [0x1000, 0x1000] },
    { frame: 2, flags: 8, pages: [], removedPages: [0x2000, 0x1000] },
    { frame: 2, flags: 8, pages: [page(0x1000)], removedPages: [0x1000] },
    {
      frame: 2,
      flags: 8,
      pages: [],
      removedPages: Array.from({ length: NATIVE_MAX_PAGES + 1 }, (_, index) => index * 4096),
    },
    { frame: 2, flags: 0, pages: [], removedPages: [0x1000] },
  ]) {
    expect(() => m.apply(update)).toThrow();
    expect(m.frame).toBe(1);
    expect(m.complete).toBe(true);
    expect(m.missingRanges).toEqual(missing);
    expect(m.read_memory(0x1000, 1)[0]).toBe(17);
    expect(m.read_memory(0x2000, 1)[0]).toBe(33);
  }
});
it('scalar accessors decode unaligned and cross-page values without calling the copying byte API', () => {
  const bytes = Uint8Array.from({ length: 8192 }, (_, index) => (index * 37 + 11) & 255),
    expected = new DataView(bytes.buffer),
    m = new NativeMirrorMemory();
  m.apply({
    frame: 1,
    flags: 2,
    pages: [
      { address: 0x80000000, bytes: bytes.subarray(0, 4096) },
      { address: 0x80001000, bytes: bytes.subarray(4096) },
    ],
  });
  const accessor = m.accessor();
  m.read_memory = () => {
    throw new Error('Scalar requested a byte copy');
  };
  m.beginOperation();
  for (const offset of [0, 1, 4092, 4093, 4094, 4095, 4096, 5001]) {
    const address = 0x80000000 + offset;
    expect(accessor.u8(address)).toBe(expected.getUint8(offset));
    expect(accessor.u16(address)).toBe(expected.getUint16(offset, true));
    expect(accessor.u32(address)).toBe(expected.getUint32(offset, true));
    expect(accessor.i32(address)).toBe(expected.getInt32(offset, true));
  }
  expect(m.operationRanges).toEqual([{ address: 0x80000000, length: 8192 }]);
  expect(m.misses).toBe(0);
  m.beginOperation();
  accessor.u32(0x80001000);
  accessor.u32(0x80001004);
  expect(m.operationRanges).toEqual([{ address: 0x80001000, length: 4096 }]);
});
it('scalar misses remain strict, coalesce both crossing pages and validate address-space boundaries', () => {
  const misses: unknown[] = [],
    m = new NativeMirrorMemory((ranges) => misses.push(ranges)),
    accessor = m.accessor();
  m.beginOperation();
  expect(() => accessor.u32(0x3fff)).toThrow(NativeMemoryMiss);
  expect(m.misses).toBe(1);
  expect(m.operationMissed).toBe(true);
  expect(m.operationRanges).toEqual([{ address: 0x3000, length: 8192 }]);
  expect(m.missingRanges).toEqual([{ address: 0x3000, length: 8192 }]);
  expect(misses).toEqual([[{ address: 0x3000, length: 8192 }]]);
  m.apply({ frame: 1, flags: 2, pages: [page(0xfffff000, 255)] });
  expect(accessor.u8(0xffffffff)).toBe(255);
  expect(accessor.u16(0xfffffffe)).toBe(65535);
  expect(accessor.u32(0xfffffffc)).toBe(0xffffffff);
  expect(accessor.i32(0xfffffffc)).toBe(-1);
  for (const address of [-1, 1.5, NaN, Infinity, 0x100000000, 0xfffffffd])
    expect(() => accessor.u32(address)).toThrow(RangeError);
});
it('scalar caches preserve snapshot bytes across update, removal and fetch', () => {
  const m = new NativeMirrorMemory(),
    input = page(0x1000, 17);
  m.apply({ frame: 1, flags: 2, pages: [input] });
  input.bytes.fill(99);
  const old = m.snapshot(),
    liveAccessor = m.accessor(),
    oldAccessor = old.accessor();
  m.beginOperation();
  old.beginOperation();
  expect(liveAccessor.u32(0x1000)).toBe(0x11111111);
  expect(oldAccessor.u32(0x1000)).toBe(0x11111111);
  expect(liveAccessor.u32(0x1004)).toBe(0x11111111);
  expect(m.operationRanges).toEqual([{ address: 0x1000, length: 4096 }]);
  expect(old.operationRanges).toEqual([{ address: 0x1000, length: 4096 }]);
  m.apply({ frame: 2, flags: 0, pages: [page(0x1000, 33)] });
  expect(liveAccessor.u32(0x1000)).toBe(0x21212121);
  expect(oldAccessor.u32(0x1000)).toBe(0x11111111);
  const copy = m.read_memory(0x1000, 4);
  copy.fill(0);
  expect(liveAccessor.u32(0x1000)).toBe(0x21212121);
  m.apply({ frame: 3, flags: 8, pages: [], removedPages: [0x1000] });
  expect(() => liveAccessor.u8(0x1000)).toThrow(NativeMemoryMiss);
  m.installFetchedPage(0x1000, new Uint8Array(4096).fill(44));
  expect(liveAccessor.u32(0x1000)).toBe(0x2c2c2c2c);
  expect(oldAccessor.u32(0x1000)).toBe(0x11111111);
  m.reset();
  expect(() => liveAccessor.u32(0x1000)).toThrow(NativeMemoryMiss);
});
it('reader retry abandons swallowed misses and returns previous good result when the range never arrives', async () => {
  const m = new NativeMirrorMemory();
  let discarded = 0,
    waits = 0,
    subscriptions = 0;
  const host = {
    subscribe: async () => {
      subscriptions++;
    },
    nextMirror: async () => {
      waits++;
    },
  };
  const value = await readNativeWithRetry(
    m,
    () => {
      try {
        m.read_memory(0x1000, 4);
      } catch {}
      return 'partial';
    },
    'previous',
    host,
    () => {
      discarded++;
    },
    2,
  );
  expect(value).toBe('previous');
  expect([discarded, waits, subscriptions]).toEqual([2, 2, 2]);
});
it('reader retry uses the next complete mirror and strict accessor never fabricates zero', async () => {
  const m = new NativeMirrorMemory();
  let discarded = 0;
  const host = {
    subscribe: async () => {},
    nextMirror: async () => {
      m.apply({ frame: 10, flags: 2, pages: [page(4096, 34)] });
    },
  };
  const value = await readNativeWithRetry(
    m,
    () => m.accessor().u32(4096),
    -1,
    host,
    () => discarded++,
  );
  expect(value).toBe(0x22222222);
  expect(discarded).toBe(1);
  expect(() => m.accessor().u8(0)).toThrow(NativeMemoryMiss);
});
it('transactions merge overlapping writes and preserve pre-transaction expected bytes', () => {
  const m = new NativeMirrorMemory();
  m.apply({ frame: 3, flags: 2, pages: [page(4096, 17)] });
  const tx = new NativeMemoryTransaction(m);
  tx.write_memory([20, 21, 22], 4100);
  tx.write_memory([30, 31], 4101);
  expect(tx.read_memory(4100, 3)).toEqual(new Uint8Array([20, 30, 31]));
  expect(tx.finish()).toEqual([
    { address: 4100, expected: new Uint8Array([17, 17, 17]), bytes: new Uint8Array([20, 30, 31]) },
  ]);
  expect(m.read_memory(4100, 3)).toEqual(new Uint8Array([17, 17, 17]));
});
it('transactions keep buffered writes after miss private, retry allocations as a whole and fetch only their private image', async () => {
  const m = new NativeMirrorMemory();
  let runs = 0,
    commits = 0,
    fetches = 0;
  const host: NativeTransactionHost = {
    fetchPage: async () => {
      fetches++;
      return new Uint8Array(4096);
    },
    alloc: async () => ({ address: 0x2000, size: 4096 }),
    free: async () => {},
    commit: async (writes) => {
      commits++;
      expect(writes).toEqual([{ address: 0x2000, expected: new Uint8Array([0]), bytes: new Uint8Array([3]) }]);
    },
    subscribe: async () => {},
    nextMirror: async () => {},
  };
  const result = await runNativeTransaction(
    m,
    (tx) => {
      runs++;
      const addr = tx.reserve(4096);
      tx.write_memory([3], addr);
      return addr;
    },
    host,
  );
  expect(result).toBe(8192);
  expect([runs, commits, fetches]).toEqual([2, 1, 1]);
  expect(() => m.read_memory(8192, 1)).toThrow(NativeMemoryMiss);
});
it('misses caught inside installers still prevent commit; uncertain commit outcomes retain executable reservations', async () => {
  const m = new NativeMirrorMemory();
  let commits = 0,
    frees = 0;
  const host: NativeTransactionHost = {
    fetchPage: async () => new Uint8Array(4096),
    alloc: async () => ({ address: 8192, size: 4096 }),
    free: async () => {
      frees++;
    },
    commit: async () => {
      commits++;
      throw new Error('Compare conflict');
    },
    subscribe: async () => {},
    nextMirror: async () => {},
  };
  await expect(
    runNativeTransaction(
      m,
      (tx) => {
        const addr = tx.reserve(4096);
        try {
          tx.read_memory(4096, 1);
        } catch {}
        tx.write_memory([3], addr);
      },
      host,
    ),
  ).rejects.toThrow('Compare conflict');
  expect(commits).toBe(1);
  expect(frees).toBe(0);
  expect(() => new NativeMemoryTransaction(m).reserve(4096)).toThrow(NativeAllocationMiss);
});
