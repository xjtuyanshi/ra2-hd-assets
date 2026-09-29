import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/**
 * Read-only cell smudges for the pinned Yuri's Revenge 1.001 image. No guest code, state writes or game assets.
 * Layout leads are Phobos-developers/YRpp, phobos-dev: CellClass.h, MapClass.h, SmudgeTypeClass.h and
 * AbstractTypeClass.h (facts only; no implementation copied). Independently checked against the player's
 * gamemd.exe, SHA-256 7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6:
 *
 * - CellClass constructor 0x47BBF0: 0x47BC24 (`89 46 48`) writes -1 to +0x48 (SmudgeTypeIndex, i32),
 *   0x47BD22 (`88 9E 1F 01 00 00`) clears +0x11F (SmudgeData, u8), and 0x47BD5C installs vtable 0x7E4EEC.
 * - SmudgeType placement routine 0x6B6080 reads the type's ArrayIndex (+0x294) at 0x6B60DE and writes the
 *   cell's +0x48 at 0x6B60EA (`89 51 48`). The nested footprint loop computes dy * Width (+0x298) + dx
 *   at 0x6B60ED..0x6B60F3, writes the byte to +0x11F at 0x6B60F5 (`88 81 1F 01 00 00`), then marks redraw.
 *   Clearing at 0x543573 (`C7 46 48 FF FF FF FF`) restores type=-1; 0x54357D clears data.
 * - SmudgeTypeClass constructor 0x6B5260 installs vtable 0x7F3528 at 0x6B529B. It reads array count
 *   0xA8EC28 at 0x6B52E1, capacity 0xA8EC20 at 0x6B52E6, and items 0xA8EC1C at 0x6B532C. ID lookup
 *   0x6B5440 indexes that same table at 0x6B5453..0x6B5459 and adds +0x24 at 0x6B545C before comparing.
 * - Cell drawing tests type against -1 at 0x48049E, looks up 0xA8EC1C at 0x4804C8, and zero-extends the
 *   complete data byte at 0x4804E6..0x4804EE. SmudgeType::DrawIt 0x6B55F0 divides data by Width at
 *   0x6B562C / 0x6B5637 to offset back to the footprint origin, then passes SHP frame 0 at 0x6B56B1.
 *   Thus data is the engine's footprint selector, not an independently advancing SHP animation frame.
 *   Only -1 is a no-smudge sentinel here; do not import the overlay map pack's 0xFF/0xFFFF sentinels.
 * - DrawIt has no crater/burn branch or per-cell diamond clip. Cell draw 0x480350 forwards its Rectangle
 *   unchanged at 0x4804F3; callers 0x6D7FC6 / 0x6D81FB pass the global rectangle 0x886FA0, while 0x6D77EE
 *   uses its caller's dirty rectangle. DrawIt forwards that rectangle at 0x6B5691 / 0x6B56AC for the full SHP.
 *   Multiple occupied footprint cells therefore describe the same positioned sprite, not separate SHP frames.
 *
 * Confidence: high for these widths/offsets, table/ID mapping and data semantics (header facts plus independent
 * instruction reads/writes). Synthetic tests validate the observer, not visual acceptance in a live match.
 * Map slot/bounds conventions and scan/revision semantics intentionally match overlayReader.ts.
 */

export const YR_SMUDGE_GLOBALS = Object.freeze({ frame: 0xa8ed84, map: 0x87f7e8, types: 0xa8ec18 });
export const YR_SMUDGE_OFFSETS = Object.freeze({
  mapRect: 0xec,
  mapCoordBounds: 0x124,
  cellItems: 0x13c,
  cellCapacity: 0x140,
  cellMapCoords: 0x24,
  cellSmudgeType: 0x48,
  cellSmudgeData: 0x11f,
  vectorItems: 0x4,
  vectorCapacity: 0x8,
  vectorCount: 0x10,
  typeId: 0x24,
});
export const YR_SMUDGE_VTABLES = Object.freeze({ cell: 0x7e4eec, type: 0x7f3528 });

const MAX_CELLS = 512 * 512;
/** Observer safety bound: every accepted index must remain nonnegative in the Int16Array contract. */
const MAX_TYPES = 0x8000;
const TYPE_ID_LENGTH = 0x18;

export interface YrSmudges {
  frame: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Row-major type-table indices; -1 means no valid smudge. */
  index: Int16Array;
  /** The engine's complete footprint selector byte; zero when index is -1. */
  data: Uint8Array;
  /** Array positions are preserved; an invalid type is represented by an empty ID. */
  types: string[];
  /** Starts at 1; increases only when bounds, IDs, indices or data differ from the supplied reuse snapshot. */
  revision: number;
  counts: { cells: number; smudges: number; invalidCells: number; invalidTypes: number; invalidIndices: number };
}

export interface ReadYrSmudgeOptions {
  /** Reuses typed arrays and the type table. Their previous contents become invalid as soon as the poll starts. */
  reuse?: YrSmudges | null;
}

function pointer(memory: GuestMemoryAccessor, address: number, span: number): boolean {
  return address >= 0x10000 && (address & 3) === 0 && address + span <= memory.size;
}

function typeId(memory: GuestMemoryAccessor, address: number): string {
  let id = '';
  for (let i = 0; i < TYPE_ID_LENGTH; i++) {
    const byte = memory.u8(address + i);
    if (byte === 0) return id;
    if (byte < 0x20 || byte > 0x7e) return '';
    id += String.fromCharCode(byte);
  }
  return ''; // A complete fixed-size ID must contain its terminator.
}

function read(memory: GuestMemoryAccessor, reuse: YrSmudges | null | undefined): YrSmudges | null {
  const g = YR_SMUDGE_GLOBALS;
  const o = YR_SMUDGE_OFFSETS;
  if (memory.size < Math.max(g.frame + 4, g.map + o.cellCapacity + 4, g.types + o.vectorCount + 4)) return null;
  const items = memory.u32(g.map + o.cellItems);
  const capacity = memory.i32(g.map + o.cellCapacity);
  if (!(capacity > 0 && capacity <= MAX_CELLS) || !pointer(memory, items, capacity * 4)) return null;
  const typeItems = memory.u32(g.types + o.vectorItems);
  const typeCount = memory.i32(g.types + o.vectorCount);
  const typeCapacity = memory.i32(g.types + o.vectorCapacity);
  if (
    !(typeCount > 0 && typeCount <= MAX_TYPES && typeCapacity >= typeCount && typeCapacity <= MAX_CELLS) ||
    !pointer(memory, typeItems, typeCapacity * 4)
  )
    return null;

  const bounds = g.map + o.mapCoordBounds;
  let left = memory.i32(bounds);
  let top = memory.i32(bounds + 4);
  let right = memory.i32(bounds + 8);
  let bottom = memory.i32(bounds + 12);
  if (!(left >= 0 && top >= 0 && right >= left && bottom >= top && right < 512 && bottom < 512)) {
    const mapWidth = memory.i32(g.map + o.mapRect + 8);
    const mapHeight = memory.i32(g.map + o.mapRect + 12);
    if (!(mapWidth > 0 && mapHeight > 0 && mapWidth + mapHeight + 1 < 512)) return null;
    left = top = 0;
    right = bottom = mapWidth + mapHeight + 1;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const size = width * height;
  const sameArrays =
    reuse?.width === width && reuse.height === height && reuse.index.length === size && reuse.data.length === size;
  const index = sameArrays ? reuse.index : new Int16Array(size).fill(-1);
  const data = sameArrays ? reuse.data : new Uint8Array(size);
  const types = reuse?.types.length === typeCount ? reuse.types : new Array<string>(typeCount).fill('');
  let changed = !sameArrays || reuse?.originX !== left || reuse.originY !== top || types !== reuse.types;
  const counts = { cells: 0, smudges: 0, invalidCells: 0, invalidTypes: 0, invalidIndices: 0 };
  for (let i = 0; i < typeCount; i++) {
    const type = memory.u32(typeItems + i * 4);
    const id =
      pointer(memory, type, o.typeId + TYPE_ID_LENGTH) && memory.u32(type) === YR_SMUDGE_VTABLES.type
        ? typeId(memory, type + o.typeId)
        : '';
    if (!id) counts.invalidTypes++;
    if (types[i] !== id) changed = true;
    types[i] = id;
  }
  // One slot read per bounded cell, but field reads only for existing, validated cells. Keeping the table scan
  // detects newly allocated/removed cells and load-game pointer replacements without a stale-pointer cache.
  for (let y = top, out = 0; y <= bottom; y++) {
    for (let x = left; x <= right; x++, out++) {
      const slot = y * 512 + x;
      const cell = slot < capacity ? memory.u32(items + slot * 4) : 0;
      let nextIndex = -1;
      let nextData = 0;
      if (cell !== 0) {
        if (
          !pointer(memory, cell, o.cellSmudgeData + 1) ||
          memory.u32(cell) !== YR_SMUDGE_VTABLES.cell ||
          memory.u32(cell + o.cellMapCoords) !== ((y << 16) | x) >>> 0
        )
          counts.invalidCells++;
        else {
          counts.cells++;
          const candidate = memory.i32(cell + o.cellSmudgeType);
          if (candidate >= 0 && candidate < typeCount && types[candidate]) {
            nextIndex = candidate;
            nextData = memory.u8(cell + o.cellSmudgeData);
            counts.smudges++;
          } else if (candidate !== -1) counts.invalidIndices++;
        }
      }
      if (index[out] !== nextIndex || data[out] !== nextData) changed = true;
      index[out] = nextIndex;
      data[out] = nextData;
    }
  }
  return {
    frame: memory.i32(g.frame),
    originX: left,
    originY: top,
    width,
    height,
    index,
    data,
    types,
    revision: (reuse?.revision ?? 0) + (changed ? 1 : 0),
    counts,
  };
}

/**
 * Pure observer. Invalid global tables return null; invalid cells/types are counted and omitted. Never throws,
 * including if a memory view is detached between polls. A null result invalidates any supplied reuse buffers.
 * Exact comparisons during the scan avoid digest collisions and let the bridge forward unchanged revisions cheaply.
 * Cost is O(bounded slots + existing cells + types), with 3 bytes per bounded slot and no per-cell allocations.
 */
export function readYrSmudges(memory: GuestMemoryAccessor, options: ReadYrSmudgeOptions = {}): YrSmudges | null {
  try {
    return read(memory, options.reuse);
  } catch {
    return null;
  }
}

/** Guard by the pinned image hash and loaded-image vtables, even before the first map exists. */
export function createYrSmudgeReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): ((options?: ReadYrSmudgeOptions) => YrSmudges | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  try {
    const accessor = memory();
    for (const vtable of Object.values(YR_SMUDGE_VTABLES)) {
      const firstMethod = accessor.u32(vtable);
      if (firstMethod < 0x401000 || firstMethod >= 0x800000) return null;
    }
  } catch {
    return null;
  }
  return (options) => {
    try {
      return readYrSmudges(memory(), options);
    } catch {
      return null;
    }
  };
}
