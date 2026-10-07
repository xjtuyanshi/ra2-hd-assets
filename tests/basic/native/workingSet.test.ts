import { describe, expect, it } from 'vitest';
import { NativeMirrorMemory, NativeReaderWorkingSet } from '../../../src/adapter/native/memory';

const page = (address: number) => ({ address, bytes: new Uint8Array(4096) });

describe('native reader allocation working set', () => {
  it('records all requested pages including a caught cross-page miss', () => {
    const memory = new NativeMirrorMemory();
    memory.apply({ frame: 1, flags: 2, pages: [page(0x10000)] });
    memory.beginOperation();
    expect(() => memory.read_memory(0x10ffc, 8)).toThrow('missing');
    expect(memory.operationRanges).toEqual([{ address: 0x10000, length: 8192 }]);
    expect(memory.operationMissed).toBe(true);
    memory.beginOperation();
    expect(memory.operationRanges).toEqual([]);
    expect(memory.operationMissed).toBe(false);
  });

  it('retires relocated heap pages after a complete cold pass while preserving other owners', () => {
    const memory = new NativeMirrorMemory(),
      working = new NativeReaderWorkingSet();
    working.learn('render', [{ address: 0x20000, length: 8192 }]);
    working.learn('command', [{ address: 0x21000, length: 4096 }]);
    working.learn('installer', [{ address: 0x30000, length: 4096 }]);
    working.learn('render', [{ address: 0x40000, length: 4096 }]);
    memory.apply({ frame: 20, flags: 2, pages: [page(0x40000)] });
    memory.beginOperation();
    memory.read_memory(0x40010, 4);
    expect(working.complete('render', memory, true)).toBe(true);
    expect(working.ranges).toEqual([
      { address: 0x21000, length: 4096 },
      { address: 0x30000, length: 4096 },
      { address: 0x40000, length: 4096 },
    ]);
  });

  it('keeps cached dependencies on warm passes and cannot prune after invalid snapshots or caught misses', () => {
    const memory = new NativeMirrorMemory(),
      working = new NativeReaderWorkingSet();
    working.learn('render', [{ address: 0x20000, length: 8192 }]);
    memory.apply({ frame: 1, flags: 2, pages: [page(0x21000)] });
    memory.beginOperation();
    memory.read_memory(0x21000, 4);
    expect(working.complete('render', memory, false)).toBe(true);
    expect(working.ranges).toEqual([{ address: 0x20000, length: 8192 }]);
    memory.beginOperation();
    expect(() => memory.read_memory(0x30000, 4)).toThrow();
    expect(working.complete('render', memory, true)).toBe(false);
    expect(working.ranges).toEqual([{ address: 0x20000, length: 8192 }]);
    memory.apply({ frame: 2, flags: 4, pages: [] });
    memory.beginOperation();
    expect(working.complete('render', memory, true)).toBe(false);
    expect(working.ranges).toEqual([{ address: 0x20000, length: 8192 }]);
  });

  it('bounds individual learned pages without partially retaining an over-budget request', () => {
    const working = new NativeReaderWorkingSet(2);
    working.learn('render', [{ address: 0x10000, length: 4096 }]);
    expect(() => working.learn('render', [{ address: 0x20000, length: 8192 }])).toThrow('page limit');
    expect(working.ranges).toEqual([{ address: 0x10000, length: 4096 }]);
    working.clear();
    expect(working.ranges).toEqual([]);
  });
});
