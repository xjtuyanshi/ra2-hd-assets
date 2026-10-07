import { expect, it } from 'vitest';
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
