import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/**
 * Read-only cell overlays for the pinned Yuri's Revenge 1.001 image. No guest code, state writes or game assets.
 * Layout sources are Phobos-developers/YRpp, phobos-dev: CellClass.h, MapClass.h, OverlayTypeClass.h and
 * AbstractTypeClass.h (facts only; no implementation copied). Offsets were independently checked by disassembling
 * the player's gamemd.exe, SHA-256 7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6:
 *
 * - CellClass constructor 0x47BBF0: 0x47BC21 (`89 46 44`) writes -1 to +0x44 (OverlayTypeIndex),
 *   0x47BD1C (`88 9E 1E 01 00 00`) clears +0x11E
 *   (OverlayData), and 0x47BD5C installs vtable 0x7E4EEC. Overlay placement writes the type at 0x5FC71E and clears
 *   data at 0x5FC717 before calling the connection update at 0x480630. That update preserves data's upper nibble
 *   and replaces the four connection bits at 0x480870..0x48088D. Do not mask the upper damage-frame bits away.
 * - ReduceTiberium 0x480A80 subtracts growth at 0x480BBD; exhaustion writes type=-1 at 0x480BCE
 *   (`C7 46 44 FF FF FF FF`) and data=0 at
 *   0x480BD5. IncreaseTiberium 0x487190 writes growth at 0x4872A0 / 0x4873FE and clamps it at 0x487418.
 * - OverlayTypeClass constructor 0x5FE250 installs vtable 0x7EF600 at 0x5FE2F1, reads array count 0xA83D90 at
 *   0x5FE32A, capacity 0xA83D88 at 0x5FE32F and items 0xA83D84 at 0x5FE372. The ID lookup at 0x5FE470 reads
 *   the same array and adds +0x24 to each type pointer at 0x5FE48C before its string comparison.
 * - DrawOverlay 0x47F6A0 reads type +0x44 at 0x47F6A9 and indexes 0xA83D84. The Tiberium branch (+0x2A9 at
 *   0x47F852) passes data +0x11E as the SHP frame at 0x47F939 / 0x47FA54 and uses convert 0x87F6B8. The Wall
 *   branch (+0x2A8 at 0x47F96A) passes the complete data byte at 0x47F99C. It selects CurrentPlayer 0xA83D4C
 *   at 0x47F9A4, that house's ColorSchemeIndex +0x16054, and its ColorScheme light convert +0x30C: walls use the
 *   local player's remap, NOT CellClass::WallOwnerIndex (+0x50). This is vanilla-engine presentation behavior.
 *
 * Confidence: high for the listed widths/offsets, index/ID mapping, growth, connection and draw-frame semantics
 * (matching header facts and independent instruction reads/writes). Synthetic tests validate the observer, not
 * visual acceptance in a running match. Map slot/bounds conventions are the same as shroudReader.ts.
 */

export const YR_OVERLAY_GLOBALS = Object.freeze({ frame: 0xa8ed84, map: 0x87f7e8, types: 0xa83d80 });
export const YR_OVERLAY_OFFSETS = Object.freeze({
  mapRect: 0xec,
  mapCoordBounds: 0x124,
  cellItems: 0x13c,
  cellCapacity: 0x140,
  cellMapCoords: 0x24,
  cellOverlayType: 0x44,
  cellOverlayData: 0x11e,
  vectorItems: 0x4,
  vectorCapacity: 0x8,
  vectorCount: 0x10,
  typeId: 0x24,
});
export const YR_OVERLAY_VTABLES = Object.freeze({ cell: 0x7e4eec, type: 0x7ef600 });

const MAX_CELLS = 512 * 512;
/** The vanilla map's overlay-index byte reserves 0xFF for no overlay. */
const MAX_TYPES = 255;
const TYPE_ID_LENGTH = 0x18;

export interface YrOverlays {
  frame: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Row-major type-table indices; -1 means no valid overlay. */
  index: Int16Array;
  /** The engine's complete frame/growth/connection byte; zero when index is -1. */
  data: Uint8Array;
  /** Array positions are preserved; an invalid type is represented by an empty ID. */
  types: string[];
  /** Starts at 1; increases only when bounds, IDs, indices or data differ from the supplied reuse snapshot. */
  revision: number;
  counts: { cells: number; overlays: number; invalidCells: number; invalidTypes: number; invalidIndices: number };
}

export interface ReadYrOverlayOptions {
  /** Reuses typed arrays and the type table. Their previous contents become invalid as soon as the poll starts. */
  reuse?: YrOverlays | null;
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

function read(memory: GuestMemoryAccessor, reuse: YrOverlays | null | undefined): YrOverlays | null {
  const g = YR_OVERLAY_GLOBALS;
  const o = YR_OVERLAY_OFFSETS;
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
  const counts = { cells: 0, overlays: 0, invalidCells: 0, invalidTypes: 0, invalidIndices: 0 };
  for (let i = 0; i < typeCount; i++) {
    const type = memory.u32(typeItems + i * 4);
    const id =
      pointer(memory, type, o.typeId + TYPE_ID_LENGTH) && memory.u32(type) === YR_OVERLAY_VTABLES.type
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
          !pointer(memory, cell, o.cellOverlayData + 1) ||
          memory.u32(cell) !== YR_OVERLAY_VTABLES.cell ||
          memory.u32(cell + o.cellMapCoords) !== ((y << 16) | x) >>> 0
        )
          counts.invalidCells++;
        else {
          counts.cells++;
          const candidate = memory.i32(cell + o.cellOverlayType);
          if (candidate >= 0 && candidate < typeCount && types[candidate]) {
            nextIndex = candidate;
            nextData = memory.u8(cell + o.cellOverlayData);
            counts.overlays++;
          } else if (candidate !== -1 && candidate !== 0xff && candidate !== 0xffff) counts.invalidIndices++;
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
export function readYrOverlays(memory: GuestMemoryAccessor, options: ReadYrOverlayOptions = {}): YrOverlays | null {
  try {
    return read(memory, options.reuse);
  } catch {
    return null;
  }
}

/** Guard by the pinned image hash and loaded-image vtables, even before the first map exists. */
export function createYrOverlayReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): ((options?: ReadYrOverlayOptions) => YrOverlays | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  try {
    const accessor = memory();
    for (const vtable of Object.values(YR_OVERLAY_VTABLES)) {
      const firstMethod = accessor.u32(vtable);
      if (firstMethod < 0x401000 || firstMethod >= 0x800000) return null;
    }
  } catch {
    return null;
  }
  return (options) => {
    try {
      return readYrOverlays(memory(), options);
    } catch {
      return null;
    }
  };
}
