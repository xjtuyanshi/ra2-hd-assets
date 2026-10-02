import { describe, expect, it } from 'vitest';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../../src/games/shared/memoryAccessor';
import {
  createYrSmudgeReader,
  readYrSmudges,
  YR_SMUDGE_GLOBALS as G,
  YR_SMUDGE_OFFSETS as O,
  YR_SMUDGE_VTABLES as V,
} from '../../src/games/yr/smudgeReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';

function fixture(bounds: [number, number, number, number] = [3, 4, 6, 7]) {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  const memory = createByteViewAccessor(bytes);
  const u32 = (address: number, value: number) => view.setUint32(address, value >>> 0, true);
  const i32 = (address: number, value: number) => view.setInt32(address, value, true);
  const items = 0xb0_0000;
  const types = 0xc0_0000;
  let heap = 0xc0_1000;
  const allocate = (size: number) => {
    const at = heap;
    heap += (size + 15) & ~15;
    return at;
  };
  u32(G.map + O.cellItems, items);
  i32(G.map + O.cellCapacity, 512 * 512);
  bounds.forEach((value, i) => i32(G.map + O.mapCoordBounds + i * 4, value));
  i32(G.map + O.mapRect + 8, 10);
  i32(G.map + O.mapRect + 12, 10);
  i32(G.frame, 1234);
  u32(G.types + O.vectorItems, types);
  i32(G.types + O.vectorCapacity, 3);
  i32(G.types + O.vectorCount, 3);
  for (const address of Object.values(V)) u32(address, 0x401000);
  const typePointers: number[] = [];
  for (const [i, id] of ['CR1', 'SC1', 'BURN01'].entries()) {
    const at = allocate(0x2bc);
    u32(at, V.type);
    u32(types + i * 4, at);
    bytes.set(new TextEncoder().encode(id), at + O.typeId);
    typePointers.push(at);
  }
  const cell = (x: number, y: number, index: number, data = 0) => {
    const at = allocate(0x148);
    u32(at, V.cell);
    u32(at + O.cellMapCoords, (y << 16) | x);
    i32(at + O.cellSmudgeType, index);
    bytes[at + O.cellSmudgeData] = data;
    u32(items + (y * 512 + x) * 4, at);
    return at;
  };
  return { bytes, memory, view, items, types, typePointers, u32, i32, cell };
}

describe('YR 1.001 smudge reader', () => {
  it('reads row-major live crater, scorch and burn types with complete footprint selector bytes', () => {
    const m = fixture();
    m.cell(3, 4, 0, 0x2f);
    m.cell(4, 4, 1, 11);
    m.cell(6, 7, 2, 4);
    m.cell(5, 5, -1, 255);
    const before = m.bytes.slice();
    const result = readYrSmudges(m.memory)!;
    expect(result).toMatchObject({ frame: 1234, originX: 3, originY: 4, width: 4, height: 4, revision: 1 });
    expect(result.types).toEqual(['CR1', 'SC1', 'BURN01']);
    expect(Array.from(result.index)).toEqual([0, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2]);
    expect(Array.from(result.data)).toEqual([47, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    expect(result.counts).toEqual({ cells: 4, smudges: 3, invalidCells: 0, invalidTypes: 0, invalidIndices: 0 });
    expect(Buffer.compare(m.bytes, before)).toBe(0);
  });

  it('reuses arrays and changes revision only for observable smudge content', () => {
    const m = fixture();
    const crater = m.cell(3, 4, 0, 0x2f);
    const first = readYrSmudges(m.memory)!;
    m.i32(G.frame, 1250);
    const same = readYrSmudges(m.memory, { reuse: first })!;
    expect(same.index).toBe(first.index);
    expect(same.data).toBe(first.data);
    expect(same.types).toBe(first.types);
    expect(same.revision).toBe(1);
    expect(same.frame).toBe(1250);
    m.bytes[crater + O.cellSmudgeData] = 0x21;
    const advanced = readYrSmudges(m.memory, { reuse: same })!;
    expect(advanced.revision).toBe(2);
    expect(advanced.data[0]).toBe(0x21);
    m.i32(crater + O.cellSmudgeType, -1);
    const removed = readYrSmudges(m.memory, { reuse: advanced })!;
    expect(removed.revision).toBe(3);
    expect(removed.index[0]).toBe(-1);
    expect(removed.data[0]).toBe(0);
    m.bytes[crater + O.cellSmudgeData] = 99; // No smudge: stale selector bytes do not change presentation.
    expect(readYrSmudges(m.memory, { reuse: removed })!.revision).toBe(3);
    m.cell(6, 7, 2, 1);
    const grown = readYrSmudges(m.memory, { reuse: removed })!;
    expect(grown.revision).toBe(4);
    m.u32(m.items + (7 * 512 + 6) * 4, 0);
    expect(readYrSmudges(m.memory, { reuse: grown })!.revision).toBe(5);
  });

  it('detects type ID changes, replaced pointers, origin shifts and resized bounds', () => {
    const m = fixture();
    m.cell(3, 4, 0);
    const first = readYrSmudges(m.memory)!;
    m.bytes[m.typePointers[0]! + O.typeId] = 'N'.charCodeAt(0);
    const renamed = readYrSmudges(m.memory, { reuse: first })!;
    expect(renamed.revision).toBe(2);
    expect(renamed.types[0]).toBe('NR1');
    m.cell(3, 4, 1, 3); // Same slot, new CellClass pointer after a load.
    const replaced = readYrSmudges(m.memory, { reuse: renamed })!;
    expect(replaced.revision).toBe(3);
    m.i32(G.map + O.mapCoordBounds, 4);
    m.i32(G.map + O.mapCoordBounds + 8, 7);
    const shifted = readYrSmudges(m.memory, { reuse: replaced })!;
    expect(shifted.index).toBe(replaced.index);
    expect(shifted.revision).toBe(4);
    m.i32(G.map + O.mapCoordBounds + 8, 8);
    const resized = readYrSmudges(m.memory, { reuse: shifted })!;
    expect(resized.index).not.toBe(shifted.index);
    expect(resized.revision).toBe(5);
  });

  it('accepts only the engine no-smudge sentinel and never narrows invalid indices into valid types', () => {
    const m = fixture();
    [-1, 0xff, 0xffff, -2, 0x10000, 3].forEach((type, i) => m.cell(3 + (i % 4), 4 + Math.floor(i / 4), type, 7));
    const result = readYrSmudges(m.memory)!;
    expect(result.index.every((value) => value === -1)).toBe(true);
    expect(result.data.every((value) => value === 0)).toBe(true);
    expect(result.counts.invalidIndices).toBe(5);
  });

  it('preserves index 255 and the highest supported index instead of imposing overlay byte limits', () => {
    const m = fixture();
    const typeItems = 0xd0_0000;
    const count = 0x8000;
    m.u32(G.types + O.vectorItems, typeItems);
    m.i32(G.types + O.vectorCount, count);
    m.i32(G.types + O.vectorCapacity, count);
    for (let i = 0; i < count; i++) m.u32(typeItems + i * 4, m.typePointers[0]!);
    m.cell(3, 4, 0xff, 255);
    m.cell(4, 4, 0x7fff, 127);
    m.cell(5, 4, 0x100ff, 7);
    const result = readYrSmudges(m.memory)!;
    expect(Array.from(result.index.slice(0, 3))).toEqual([0xff, 0x7fff, -1]);
    expect(Array.from(result.data.slice(0, 3))).toEqual([255, 127, 0]);
    expect(result.counts).toEqual({ cells: 3, smudges: 2, invalidCells: 0, invalidTypes: 0, invalidIndices: 1 });
  });

  it('keeps raw footprint selectors independent from neighbouring overlay and visibility bytes', () => {
    const m = fixture();
    const cell = m.cell(3, 4, 2, 5); // A 3x2 burn footprint's last cell; the reader must not map this to SHP frame 5.
    m.bytes[cell + O.cellSmudgeData - 1] = 211;
    m.bytes[cell + O.cellSmudgeData + 1] = 254;
    const first = readYrSmudges(m.memory)!;
    expect(first.data[0]).toBe(5);
    m.bytes[cell + O.cellSmudgeData - 1] = 17;
    m.bytes[cell + O.cellSmudgeData + 1] = 255;
    const next = readYrSmudges(m.memory, { reuse: first })!;
    expect(next.data[0]).toBe(5);
    expect(next.revision).toBe(first.revision);
  });

  it('rejects corrupt cells, wrong vtables and mismatched map coordinates', () => {
    const m = fixture();
    m.u32(m.items + (4 * 512 + 3) * 4, 0x123);
    m.u32(m.items + (4 * 512 + 4) * 4, 0xfffffff0);
    const wrongType = m.cell(5, 4, 1);
    m.u32(wrongType, V.type);
    const wrongCoords = m.cell(6, 4, 1);
    m.u32(wrongCoords + O.cellMapCoords, 0);
    const result = readYrSmudges(m.memory)!;
    expect(result.counts.invalidCells).toBe(4);
    expect(result.counts.smudges).toBe(0);
    expect(result.index.every((value) => value === -1)).toBe(true);
  });

  it('preserves type table positions and omits invalid pointers/strings', () => {
    const m = fixture();
    m.cell(3, 4, 0);
    m.cell(4, 4, 1);
    m.cell(5, 4, 2);
    m.u32(m.types, 3);
    m.bytes.fill(0x41, m.typePointers[1]! + O.typeId, m.typePointers[1]! + O.typeId + 24);
    m.bytes[m.typePointers[2]! + O.typeId] = 0x80;
    const result = readYrSmudges(m.memory)!;
    expect(result.types).toEqual(['', '', '']);
    expect(result.counts.invalidTypes).toBe(3);
    expect(result.counts.invalidIndices).toBe(3);
    expect(result.counts.smudges).toBe(0);
  });

  it('validates global tables and handles bounded capacity, fallback bounds and edge slot 511,511', () => {
    const empty = createByteViewAccessor(new Uint8Array(16));
    expect(readYrSmudges(empty)).toBeNull();
    for (const [address, value] of [
      [G.map + O.cellItems, 0],
      [G.map + O.cellCapacity, -1],
      [G.map + O.cellCapacity, 0x40001],
      [G.types + O.vectorItems, 0xfffffff0],
      [G.types + O.vectorCount, 0],
      [G.types + O.vectorCount, 0x8001],
      [G.types + O.vectorCapacity, 2],
    ]) {
      const m = fixture();
      m.i32(address!, value! | 0);
      expect(readYrSmudges(m.memory), `address ${address!.toString(16)}`).toBeNull();
    }
    const limited = fixture();
    limited.i32(G.map + O.cellCapacity, 1);
    expect(readYrSmudges(limited.memory)!.counts.cells).toBe(0);
    const fallback = fixture([-1, -1, -1, -1]);
    expect(readYrSmudges(fallback.memory)).toMatchObject({ originX: 0, originY: 0, width: 22, height: 22 });
    fallback.i32(G.map + O.mapRect + 8, 511);
    expect(readYrSmudges(fallback.memory)).toBeNull();
    const edge = fixture([511, 511, 511, 511]);
    edge.cell(511, 511, 2, 255);
    expect(readYrSmudges(edge.memory)?.data[0]).toBe(255);
  });

  it('guards the executable hash and loaded image and never throws on accessor/provider failure', () => {
    const m = fixture();
    expect(createYrSmudgeReader(() => m.memory, 'other-image')).toBeNull();
    const reader = createYrSmudgeReader(() => m.memory, YR_STARTUP_PAGE_HASH)!;
    expect(reader()).not.toBeNull();
    m.u32(V.type, 0);
    expect(createYrSmudgeReader(() => m.memory, YR_STARTUP_PAGE_HASH)).toBeNull();
    const throwing: GuestMemoryAccessor = {
      ...m.memory,
      u32: () => {
        throw new Error('detached memory');
      },
    };
    expect(readYrSmudges(throwing)).toBeNull();
    expect(createYrSmudgeReader(() => throwing, YR_STARTUP_PAGE_HASH)).toBeNull();
    expect(
      createYrSmudgeReader(() => {
        throw new Error('no view');
      }, YR_STARTUP_PAGE_HASH),
    ).toBeNull();
    m.u32(V.type, 0x401000);
    let ready = true;
    const guarded = createYrSmudgeReader(() => {
      if (!ready) throw new Error('memory grew');
      return m.memory;
    }, YR_STARTUP_PAGE_HASH)!;
    ready = false;
    expect(guarded()).toBeNull();
  });
});
