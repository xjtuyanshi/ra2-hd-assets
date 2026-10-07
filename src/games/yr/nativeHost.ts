import type { GuestMemory } from '../../vm86/win32';
import type { NativeGamePolicy, NativeHostFollowRule, NativeHostMetadata, NativeHostRange } from '../nativeHost';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { createYrCommandStateReaderFrom } from './commandState';
import { YR_EFFECTS_GLOBALS } from './effectsReader';
import { YR_BEAMS_GLOBALS } from './beamsReader';
import { createYrFrameReader } from './performance';
import { createYrRenderStateReader } from './renderState';
import { writeYrGameSpeed } from './runtimeHooks';
import { YR_SHROUD_GLOBALS, YR_SHROUD_OFFSETS } from './shroudReader';
import { YR_STATE_GLOBALS as G, YR_STATE_LIMITS as L } from './stateReader';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import { installYrTacticalPassthrough } from './tacticalPassthrough';

const PAGE_BYTES = 4096;
const MAX_CELL_SLOTS = 512 * 512;
const CELL_BYTES = 0x148;

const vector = (source: number, bytes: number, maxCount: number): NativeHostFollowRule => ({
  kind: 2,
  source,
  bytes,
  maxCount,
  stride: 4,
});
const pointer = (source: number, bytes: number): NativeHostFollowRule => ({
  kind: 1,
  source,
  bytes,
  maxCount: 1,
  stride: 0,
});

/** Mutable root pages, vtable tables and fixed reader tables of the pinned YR 1.001 image. */
export const YR_NATIVE_RANGES: readonly NativeHostRange[] = Object.freeze([
  { address: 0x7e0000, length: 0x20000 },
  { address: 0x870000, length: 0x40000 },
  { address: 0xa80000, length: 0x10000 },
  { address: 0xa9f000, length: 0x1000 },
  { address: 0xabc000, length: 0x5000 },
  { address: 0xb04000, length: 0x20000 },
  { address: 0xb45000, length: 0x2000 },
  { address: 0xb73000, length: 0x1000 },
]);

/**
 * The native agent resolves these on the game thread. Larger/nested optional blocks are discovered by strict reader
 * misses, never filled with zeros. Type and house tables are followed so adding a new object need not rediscover
 * its existing type or owner. Counts remain defensive reader bounds, not fabricated game capacities.
 */
export const YR_NATIVE_FOLLOW_RULES: readonly NativeHostFollowRule[] = Object.freeze([
  vector(G.technos, 0x800, L.objectsPerKind * 4),
  vector(G.units, 0x800, L.objectsPerKind),
  vector(G.infantry, 0x800, L.objectsPerKind),
  vector(G.buildings, 0x800, L.objectsPerKind),
  vector(G.aircraft, 0x800, L.objectsPerKind),
  vector(G.houses, 0x16060, L.houses),
  pointer(G.scenario, 0x3600),
  pointer(G.tactical, 0x200),
  pointer(0x8871e0, 0x1900), // RulesClass/Settings instance, used by tint/detail and speed policies.
  pointer(G.map + YR_SHROUD_OFFSETS.cellItems, MAX_CELL_SLOTS * 4),
  vector(0xa83c68, 0x1800, 4096), // BuildingTypeClass::Array.
  vector(0xa8e348, 0x1000, 4096), // InfantryTypeClass::Array.
  vector(0xa83ce0, 0x1000, 4096), // UnitTypeClass::Array.
  vector(0xa8b218, 0x1000, 4096), // AircraftTypeClass::Array.
  vector(0xa83d80, 0x2c0, 255), // OverlayTypeClass::Array.
  vector(0xa8ec18, 0x40, 0x8000), // SmudgeTypeClass::Array.
  vector(YR_EFFECTS_GLOBALS.anims, 0x1b0, 8192),
  vector(YR_EFFECTS_GLOBALS.bullets, 0x160, 4096),
  vector(YR_EFFECTS_GLOBALS.particleSystems, 0x110, 2048),
  vector(YR_EFFECTS_GLOBALS.lasers, 0x60, 1024),
  vector(YR_EFFECTS_GLOBALS.electricBolts, 0x40, 1024),
  vector(YR_EFFECTS_GLOBALS.voxelAnims, 0x150, 4096),
  vector(YR_BEAMS_GLOBALS.radBeams, 0x90, 1024),
  vector(YR_BEAMS_GLOBALS.waves, 0x1e0, 1024),
  vector(0xabca10, 0x4c, 4096), // LightSourceClass::Array (+4 Items, +16 Count).
  ...Array.from({ length: 5 }, (_, index) => vector(G.renderLayers + index * 0x18, 0x200, L.objectsPerLayer)),
]);

function pageRanges(pages: ReadonlySet<number>): NativeHostRange[] {
  const result: NativeHostRange[] = [];
  for (const address of [...pages].sort((a, b) => a - b)) {
    const last = result.at(-1);
    if (last && last.address + last.length === address) last.length += PAGE_BYTES;
    else result.push({ address, length: PAGE_BYTES });
  }
  return result;
}

/**
 * Map cells are VectorClass entries, whose capacity lives at +8 rather than a DynamicVectorClass count at +16.
 * Discover their page footprint once per map from a complete mirror, including the shroud's neighbouring cells.
 * Cell allocations stay fixed during that map; a scenario/pointer/bounds change or frame reset invalidates the cache.
 * Strict accessor failures intentionally escape: the host abandons the discovery and subscribes the missing range.
 */
export function createYrNativeCellDiscovery(accessor: () => GuestMemoryAccessor): () => readonly NativeHostRange[] {
  let key = '';
  let lastFrame = -1;
  let ranges: readonly NativeHostRange[] = [];
  return () => {
    const memory = accessor();
    const scenario = memory.u32(G.scenario);
    if (!scenario) return [];
    const frame = memory.u32(G.frame);
    const items = memory.u32(G.map + YR_SHROUD_OFFSETS.cellItems);
    const capacity = memory.i32(G.map + YR_SHROUD_OFFSETS.cellCapacity);
    if (capacity <= 0 || capacity > MAX_CELL_SLOTS || items < L.minPointer || items % 4) return [];
    const bounds = G.map + YR_SHROUD_OFFSETS.mapCoordBounds;
    let left = memory.i32(bounds),
      top = memory.i32(bounds + 4);
    let right = memory.i32(bounds + 8),
      bottom = memory.i32(bounds + 12);
    if (!(left >= 0 && top >= 0 && right >= left && bottom >= top && right < 512 && bottom < 512)) {
      const width = memory.i32(G.map + YR_SHROUD_OFFSETS.mapRect + 8);
      const height = memory.i32(G.map + YR_SHROUD_OFFSETS.mapRect + 12);
      if (!(width > 0 && height > 0 && width + height + 1 < 512)) return [];
      left = top = 0;
      right = bottom = width + height + 1;
    }
    const nextKey = `${scenario}:${items}:${capacity}:${left}:${top}:${right}:${bottom}`;
    if (key === nextKey && frame >= lastFrame) {
      lastFrame = frame;
      return ranges;
    }
    const bytes = memory.bytes(items, capacity * 4);
    const pointers = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pages = new Set<number>();
    const add = (address: number, length: number) => {
      if (address < L.minPointer || address % 4 || address + length > memory.size) return;
      for (let page = Math.floor(address / PAGE_BYTES) * PAGE_BYTES; page < address + length; page += PAGE_BYTES)
        pages.add(page);
    };
    add(YR_SHROUD_GLOBALS.invalidCell, CELL_BYTES);
    for (let y = Math.max(0, top - 1); y <= Math.min(511, bottom + 1); y++)
      for (let x = Math.max(0, left - 1); x <= Math.min(511, right + 1); x++) {
        const index = (y << 9) + x;
        if (index < capacity) add(pointers.getUint32(index * 4, true), CELL_BYTES);
      }
    // Cache only after all strict reads and discovery have completed.
    ranges = pageRanges(pages);
    key = nextKey;
    lastFrame = frame;
    return ranges;
  };
}

/** Native session composition; caller must verify the agent's full executable hash before selecting this policy. */
export function createYrNativeHostPolicy(
  memory: GuestMemory,
  accessor: () => GuestMemoryAccessor,
  hash: string,
  metadata: NativeHostMetadata,
): NativeGamePolicy {
  if (hash !== YR_STARTUP_PAGE_HASH) throw new Error('Native YR policy requires the pinned executable identity');
  return {
    ranges: YR_NATIVE_RANGES,
    rules: YR_NATIVE_FOLLOW_RULES,
    additionalRanges: createYrNativeCellDiscovery(accessor),
    createRenderReader: () => createYrRenderStateReader(memory, 0x100000000, hash, accessor),
    createCommandReader: () => createYrCommandStateReaderFrom(accessor, hash),
    createFrameReader: () => createYrFrameReader(memory, hash, metadata.verifiedNativeHook),
    installPassthrough: (transaction, reserve) => {
      if (!Number.isInteger(metadata.gameThreadId) || metadata.gameThreadId <= 0) return null;
      const result = installYrTacticalPassthrough(transaction, reserve, {
        fsOffset: 0x24,
        owner: metadata.gameThreadId,
      });
      return result.ok ? result.control : null;
    },
    setSpeed: writeYrGameSpeed,
  };
}
