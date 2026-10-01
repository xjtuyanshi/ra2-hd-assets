import { describe, expect, it } from 'vitest';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../../src/games/shared/memoryAccessor';
import {
  createYrOverlayReader,
  readYrOverlays,
  YR_OVERLAY_GLOBALS as G,
  YR_OVERLAY_OFFSETS as O,
  YR_OVERLAY_VTABLES as V,
} from '../../src/games/yr/overlayReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { YR_STATE_VTABLES } from '../../src/games/yr/stateReader';

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
  for (const [i, id] of ['GAWALL', 'TIB01', 'GEM01'].entries()) {
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
    i32(at + O.cellOverlayType, index);
    bytes[at + O.cellOverlayData] = data;
    u32(items + (y * 512 + x) * 4, at);
    return at;
  };
  const building = (id: string) => {
    const at = allocate(O.typeId + 24);
    u32(at, YR_STATE_VTABLES.buildingType);
    bytes.set(new TextEncoder().encode(id), at + O.typeId);
    return at;
  };
  return { bytes, memory, view, items, types, typePointers, u32, i32, cell, building };
}

describe('YR 1.001 overlay reader', () => {
  it('reads row-major live types, complete wall connection/damage frames and ore/gem growth', () => {
    const m = fixture();
    m.cell(3, 4, 0, 0x2f);
    m.cell(4, 4, 1, 11);
    m.cell(6, 7, 2, 4);
    m.cell(5, 5, -1, 255);
    const before = m.bytes.slice();
    const result = readYrOverlays(m.memory)!;
    expect(result).toMatchObject({ frame: 1234, originX: 3, originY: 4, width: 4, height: 4, revision: 1 });
    expect(result.types).toEqual(['GAWALL', 'TIB01', 'GEM01']);
    expect(Array.from(result.index)).toEqual([0, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2]);
    expect(Array.from(result.data)).toEqual([47, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    expect(result.counts).toEqual({
      cells: 4,
      overlays: 3,
      invalidCells: 0,
      invalidTypes: 0,
      invalidIndices: 0,
      invalidRubble: 0,
    });
    expect(result.rubble).toEqual([]);
    expect(Buffer.compare(m.bytes, before)).toBe(0);
  });

  it('reads IsRubble once per type and publishes only valid carriers in sorted local slots', () => {
    const m = fixture();
    const flag = m.typePointers[1]! + O.typeIsRubble;
    m.bytes[flag] = 2; // Any nonzero byte is true.
    const source = m.building('CAOILD');
    m.u32(m.cell(6, 7, 1) + O.cellRubbleType, source);
    m.u32(m.cell(5, 5, 1) + O.cellRubbleType, source);
    m.cell(3, 4, 1); // Other foundation cells have a null source.
    const invalid = m.building('CAOILD');
    m.u32(invalid, V.type);
    m.u32(m.cell(4, 4, 1) + O.cellRubbleType, invalid);
    m.u32(m.cell(5, 4, 0) + O.cellRubbleType, invalid); // Not IsRubble: ignore its pointer.
    const reads: number[] = [];
    const observed: GuestMemoryAccessor = {
      ...m.memory,
      u8: (address) => {
        reads.push(address);
        return m.memory.u8(address);
      },
    };
    const result = readYrOverlays(observed)!;
    expect(result.rubble).toEqual([
      { slot: 6, type: 'CAOILD' },
      { slot: 15, type: 'CAOILD' },
    ]);
    expect(result.counts).toMatchObject({ overlays: 5, invalidRubble: 1 });
    expect(reads.filter((address) => address === flag)).toHaveLength(1);
    expect(result.index[1]).toBe(1); // An invalid carrier does not remove its overlay cell.
  });

  it.each(['unaligned', 'out of range', 'truncated', 'bad vtable', 'empty ID', 'non-ASCII ID', 'unterminated ID'])(
    'omits and counts a rubble source with %s',
    (kind) => {
      const m = fixture();
      m.bytes[m.typePointers[1]! + O.typeIsRubble] = 1;
      let source = m.building('CAOILD');
      if (kind === 'unaligned') source++;
      if (kind === 'out of range') source = 0xfffffff0;
      if (kind === 'truncated') source = m.memory.size - 4;
      if (kind === 'bad vtable') m.u32(source, V.type);
      if (kind === 'empty ID') m.bytes[source + O.typeId] = 0;
      if (kind === 'non-ASCII ID') m.bytes[source + O.typeId] = 0x80;
      if (kind === 'unterminated ID') m.bytes.fill(0x41, source + O.typeId, source + O.typeId + 24);
      m.u32(m.cell(3, 4, 1) + O.cellRubbleType, source);
      const result = readYrOverlays(m.memory)!;
      expect(result.rubble).toEqual([]);
      expect(result.counts.invalidRubble).toBe(1);
    },
  );

  it('changes revision for rubble-only changes, but not a replacement pointer with the same source ID', () => {
    const m = fixture();
    const flag = m.typePointers[1]! + O.typeIsRubble;
    m.bytes[flag] = 1;
    const carrier = m.cell(3, 4, 1);
    m.u32(carrier + O.cellRubbleType, m.building('CAOILD'));
    const first = readYrOverlays(m.memory)!;
    const same = readYrOverlays(m.memory, { reuse: first })!;
    expect(same.revision).toBe(1);
    m.u32(carrier + O.cellRubbleType, m.building('CAOILD'));
    const replaced = readYrOverlays(m.memory, { reuse: same })!;
    expect(replaced.revision).toBe(1);
    m.u32(carrier + O.cellRubbleType, m.building('OTHER'));
    const changed = readYrOverlays(m.memory, { reuse: replaced })!;
    expect(changed.revision).toBe(2);
    expect(changed.rubble).toEqual([{ slot: 0, type: 'OTHER' }]);
    expect(first.rubble).toEqual([{ slot: 0, type: 'CAOILD' }]);
    m.u32(carrier + O.cellRubbleType, 0);
    const removed = readYrOverlays(m.memory, { reuse: changed })!;
    expect(removed.revision).toBe(3);
    expect(removed.counts.invalidRubble).toBe(0);
    expect(removed.rubble).toEqual([]);
    m.u32(carrier + O.cellRubbleType, m.building('CAOILD'));
    const restored = readYrOverlays(m.memory, { reuse: removed })!;
    expect(restored.revision).toBe(4);
    m.bytes[flag] = 0;
    expect(readYrOverlays(m.memory, { reuse: restored })).toMatchObject({ revision: 5, rubble: [] });
  });

  it('reuses arrays and changes revision only for observable overlay content', () => {
    const m = fixture();
    const wall = m.cell(3, 4, 0, 0x2f);
    const first = readYrOverlays(m.memory)!;
    m.i32(G.frame, 1250);
    const same = readYrOverlays(m.memory, { reuse: first })!;
    expect(same.index).toBe(first.index);
    expect(same.data).toBe(first.data);
    expect(same.types).toBe(first.types);
    expect(same.revision).toBe(1);
    expect(same.frame).toBe(1250);
    m.bytes[wall + O.cellOverlayData] = 0x21;
    const connected = readYrOverlays(m.memory, { reuse: same })!;
    expect(connected.revision).toBe(2);
    expect(connected.data[0]).toBe(0x21);
    m.i32(wall + O.cellOverlayType, -1);
    const removed = readYrOverlays(m.memory, { reuse: connected })!;
    expect(removed.revision).toBe(3);
    expect(removed.index[0]).toBe(-1);
    expect(removed.data[0]).toBe(0);
    m.bytes[wall + O.cellOverlayData] = 99; // No overlay: stale frame bytes do not change presentation.
    expect(readYrOverlays(m.memory, { reuse: removed })!.revision).toBe(3);
    m.cell(6, 7, 2, 1);
    const grown = readYrOverlays(m.memory, { reuse: removed })!;
    expect(grown.revision).toBe(4);
    m.u32(m.items + (7 * 512 + 6) * 4, 0);
    expect(readYrOverlays(m.memory, { reuse: grown })!.revision).toBe(5);
  });

  it('detects type ID changes, replaced pointers, origin shifts and resized bounds', () => {
    const m = fixture();
    m.cell(3, 4, 0);
    const first = readYrOverlays(m.memory)!;
    m.bytes[m.typePointers[0]! + O.typeId] = 'N'.charCodeAt(0);
    const renamed = readYrOverlays(m.memory, { reuse: first })!;
    expect(renamed.revision).toBe(2);
    expect(renamed.types[0]).toBe('NAWALL');
    m.cell(3, 4, 1, 3); // Same slot, new CellClass pointer after a load.
    const replaced = readYrOverlays(m.memory, { reuse: renamed })!;
    expect(replaced.revision).toBe(3);
    m.i32(G.map + O.mapCoordBounds, 4);
    m.i32(G.map + O.mapCoordBounds + 8, 7);
    const shifted = readYrOverlays(m.memory, { reuse: replaced })!;
    expect(shifted.index).toBe(replaced.index);
    expect(shifted.revision).toBe(4);
    m.i32(G.map + O.mapCoordBounds + 8, 8);
    const resized = readYrOverlays(m.memory, { reuse: shifted })!;
    expect(resized.index).not.toBe(shifted.index);
    expect(resized.revision).toBe(5);
  });

  it('normalizes no-overlay sentinels without narrowing invalid indices into valid types', () => {
    const m = fixture();
    [-1, 0xff, 0xffff, -2, 0x10000, 3].forEach((type, i) => m.cell(3 + (i % 4), 4 + Math.floor(i / 4), type, 7));
    const result = readYrOverlays(m.memory)!;
    expect(result.index.every((value) => value === -1)).toBe(true);
    expect(result.data.every((value) => value === 0)).toBe(true);
    expect(result.counts.invalidIndices).toBe(3);
  });

  it('rejects corrupt cells, wrong vtables and mismatched map coordinates', () => {
    const m = fixture();
    m.u32(m.items + (4 * 512 + 3) * 4, 0x123);
    m.u32(m.items + (4 * 512 + 4) * 4, 0xfffffff0);
    const wrongType = m.cell(5, 4, 1);
    m.u32(wrongType, V.type);
    const wrongCoords = m.cell(6, 4, 1);
    m.u32(wrongCoords + O.cellMapCoords, 0);
    const result = readYrOverlays(m.memory)!;
    expect(result.counts.invalidCells).toBe(4);
    expect(result.counts.overlays).toBe(0);
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
    const result = readYrOverlays(m.memory)!;
    expect(result.types).toEqual(['', '', '']);
    expect(result.counts.invalidTypes).toBe(3);
    expect(result.counts.invalidIndices).toBe(3);
    expect(result.counts.overlays).toBe(0);
  });

  it('validates global tables and handles bounded capacity, fallback bounds and edge slot 511,511', () => {
    const empty = createByteViewAccessor(new Uint8Array(16));
    expect(readYrOverlays(empty)).toBeNull();
    for (const [address, value] of [
      [G.map + O.cellItems, 0],
      [G.map + O.cellCapacity, -1],
      [G.map + O.cellCapacity, 0x40001],
      [G.types + O.vectorItems, 0xfffffff0],
      [G.types + O.vectorCount, 0],
      [G.types + O.vectorCount, 256],
      [G.types + O.vectorCapacity, 2],
    ]) {
      const m = fixture();
      m.i32(address!, value! | 0);
      expect(readYrOverlays(m.memory), `address ${address!.toString(16)}`).toBeNull();
    }
    const limited = fixture();
    limited.i32(G.map + O.cellCapacity, 1);
    expect(readYrOverlays(limited.memory)!.counts.cells).toBe(0);
    const fallback = fixture([-1, -1, -1, -1]);
    expect(readYrOverlays(fallback.memory)).toMatchObject({ originX: 0, originY: 0, width: 22, height: 22 });
    fallback.i32(G.map + O.mapRect + 8, 511);
    expect(readYrOverlays(fallback.memory)).toBeNull();
    const edge = fixture([511, 511, 511, 511]);
    edge.cell(511, 511, 2, 255);
    expect(readYrOverlays(edge.memory)?.data[0]).toBe(255);
  });

  it('guards the executable hash and loaded image and never throws on accessor/provider failure', () => {
    const m = fixture();
    expect(createYrOverlayReader(() => m.memory, 'other-image')).toBeNull();
    const reader = createYrOverlayReader(() => m.memory, YR_STARTUP_PAGE_HASH)!;
    expect(reader()).not.toBeNull();
    m.u32(V.type, 0);
    expect(createYrOverlayReader(() => m.memory, YR_STARTUP_PAGE_HASH)).toBeNull();
    const throwing: GuestMemoryAccessor = {
      ...m.memory,
      u32: () => {
        throw new Error('detached memory');
      },
    };
    expect(readYrOverlays(throwing)).toBeNull();
    expect(createYrOverlayReader(() => throwing, YR_STARTUP_PAGE_HASH)).toBeNull();
    expect(
      createYrOverlayReader(() => {
        throw new Error('no view');
      }, YR_STARTUP_PAGE_HASH),
    ).toBeNull();
    m.u32(V.type, 0x401000);
    let ready = true;
    const guarded = createYrOverlayReader(() => {
      if (!ready) throw new Error('memory grew');
      return m.memory;
    }, YR_STARTUP_PAGE_HASH)!;
    ready = false;
    expect(guarded()).toBeNull();
  });
});
