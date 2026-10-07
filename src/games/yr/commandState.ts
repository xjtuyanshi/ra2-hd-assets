import type { GameCommandObject, GameCommandRef, GameCommandState, GameCommandStateReader } from '../commandState';
import type { GameRenderSidebar } from '../renderState';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../shared/memoryAccessor';
import type { GuestMemory } from '../../vm86/win32';
import { createYrSidebarReader } from './sidebarReader';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import {
  isPlausiblePointer,
  readAsciiZ,
  readPointerVector,
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS as L,
  YR_STATE_OFFSETS as O,
  YR_STATE_VTABLES as V,
} from './stateReader';

/**
 * Read-only order state of Yuri's Revenge 1.001 (gamemd.exe, SHA-256 in YR_STARTUP_PAGE_HASH) for practice sessions:
 * selection, control groups, each object's mission and what it points at. Evidence, live verification and limits:
 * docs/remaster/research/yr-command-state.md. Like stateReader.ts it only reads guest memory and validates every
 * pointer; anything implausible is skipped, never thrown.
 */
export const YR_COMMAND_OFFSETS = Object.freeze({
  /** MissionClass::CurrentMission (int). Getter `mov eax,[ecx+0xAC]; ret` at 0x46B5B0. */
  mission: 0xac,
  /** MissionClass::QueuedMission (int, -1 none). Getter at 0x4A5950. */
  queuedMission: 0xb4,
  /** TechnoClass::Group (int, -1 none). The team-creation routine 0x731060 stores it at 0x7310BF. */
  group: 0x214,
  /** TechnoClass::Focus (AbstractClass*). Setter `mov [ecx+0x218],eax; ret 4` at 0x70C614. */
  focus: 0x218,
  /** TechnoClass::Target (AbstractClass*). TechnoClass::SetTarget reads it at 0x6FCDBE. */
  target: 0x2b4,
  /** FootClass::Destination (AbstractClass*). FootClass::SetDestination stores it at 0x4D9510. */
  destination: 0x5a4,
  /** CellClass::MapCoords (two shorts: X, Y). */
  cellCoords: 0x24,
});

/**
 * The ring of the eight newest radar event cells (CellStruct each) and the index of the newest (-1 none). The
 * "centre on radar event" command reads them through the getter at 0x660BB0.
 */
export const YR_RADAR_EVENTS = Object.freeze({ cells: 0xb04d48, newest: 0xb04d88, count: 8 });

/** CellClass primary vtable: an order pointer whose first dword is this address names a map cell. */
export const YR_CELL_VTABLE = 0x7e4eec;

/** Instruction bytes the loaded image must hold at these addresses; a different build yields no reader. */
export const YR_COMMAND_SIGNATURES: ReadonlyArray<{ address: number; bytes: readonly number[] }> = Object.freeze([
  { address: 0x46b5b0, bytes: [0x8b, 0x81, 0xac, 0x00, 0x00, 0x00, 0xc3] },
  { address: 0x4a5950, bytes: [0x8b, 0x81, 0xb4, 0x00, 0x00, 0x00, 0xc3] },
  { address: 0x7310bf, bytes: [0x89, 0x86, 0x14, 0x02, 0x00, 0x00] },
  { address: 0x70c614, bytes: [0x89, 0x81, 0x18, 0x02, 0x00, 0x00] },
  { address: 0x6fcdbe, bytes: [0x8b, 0x86, 0xb4, 0x02, 0x00, 0x00] },
  { address: 0x4d9510, bytes: [0x89, 0xb5, 0xa4, 0x05, 0x00, 0x00] },
  { address: 0x660bb0, bytes: [0x8b, 0xc1, 0x8b, 0x0d, 0x88, 0x4d, 0xb0, 0x00, 0x83, 0xf9, 0xff] },
]);

/** The engine's mission numbers (YRpp `Mission`), by value. */
export const YR_MISSIONS: readonly string[] = Object.freeze([
  'Sleep',
  'Attack',
  'Move',
  'QMove',
  'Retreat',
  'Guard',
  'Sticky',
  'Enter',
  'Capture',
  'Eaten',
  'Harvest',
  'Area_Guard',
  'Return',
  'Stop',
  'Ambush',
  'Hunt',
  'Unload',
  'Sabotage',
  'Construction',
  'Selling',
  'Repair',
  'Rescue',
  'Missile',
  'Harmless',
  'Open',
  'Patrol',
  'ParadropApproach',
  'ParadropOverfly',
  'Wait',
  'AttackMove',
  'SpyplaneApproach',
  'SpyplaneOverfly',
]);

const KINDS = [
  { kind: 'building', vtable: V.building, type: O.buildingType, mobile: false },
  { kind: 'vehicle', vtable: V.unit, type: O.unitType, mobile: true },
  { kind: 'infantry', vtable: V.infantry, type: O.infantryType, mobile: true },
  { kind: 'aircraft', vtable: V.aircraft, type: O.aircraftType, mobile: true },
] as const;

function readRef(memory: GuestMemoryAccessor, pointer: number): GameCommandRef | null {
  if (!isPlausiblePointer(memory, pointer, 0x28)) return null;
  const vtable = memory.u32(pointer);
  if (vtable === YR_CELL_VTABLE) {
    const x = (memory.u16(pointer + YR_COMMAND_OFFSETS.cellCoords) << 16) >> 16;
    const y = (memory.u16(pointer + YR_COMMAND_OFFSETS.cellCoords + 2) << 16) >> 16;
    return x >= 0 && y >= 0 && x < 512 && y < 512 ? { kind: 'cell', x, y } : null;
  }
  if (KINDS.some((entry) => entry.vtable === vtable)) return { kind: 'object', uid: memory.u32(pointer + O.uniqueId) };
  return null;
}

function readLastEvent(memory: GuestMemoryAccessor): { x: number; y: number } | null {
  const newest = memory.i32(YR_RADAR_EVENTS.newest);
  if (newest < 0 || newest >= YR_RADAR_EVENTS.count) return null;
  const x = (memory.u16(YR_RADAR_EVENTS.cells + newest * 4) << 16) >> 16;
  const y = (memory.u16(YR_RADAR_EVENTS.cells + newest * 4 + 2) << 16) >> 16;
  return x > 0 && y > 0 && x < 512 && y < 512 ? { x, y } : null;
}

/** One snapshot of the order state; null outside a battle or when a global is implausible. */
export function readYrCommandState(
  memory: GuestMemoryAccessor,
  sidebar: GameRenderSidebar | null = null,
): GameCommandState | null {
  const technos = readPointerVector(memory, G.technos, L.objectsPerKind * 4);
  const houses = readPointerVector(memory, G.houses, L.houses);
  if (!technos || !houses || !houses.length) return null;
  const houseIndex = new Map<number, number>();
  for (const house of houses) {
    if (isPlausiblePointer(memory, house, O.houseArrayIndex + 4))
      houseIndex.set(house, memory.i32(house + O.houseArrayIndex));
  }
  const objects: GameCommandObject[] = [];
  for (const pointer of technos) {
    if (!isPlausiblePointer(memory, pointer, 0x6c8)) continue;
    const vtable = memory.u32(pointer);
    const entry = KINDS.find((candidate) => candidate.vtable === vtable);
    if (!entry || memory.u8(pointer + O.inLimbo)) continue;
    const typePointer = memory.u32(pointer + entry.type);
    if (!isPlausiblePointer(memory, typePointer, O.typeStrength + 4)) continue;
    const type = readAsciiZ(memory, typePointer + O.typeId, 0x18);
    const owner = houseIndex.get(memory.u32(pointer + O.owner));
    if (!type || owner === undefined) continue;
    const x = memory.i32(pointer + O.location);
    const y = memory.i32(pointer + O.location + 4);
    const z = memory.i32(pointer + O.location + 8);
    if (Math.abs(x) > L.maxCoordinate || Math.abs(y) > L.maxCoordinate) continue;
    const strength = memory.i32(typePointer + O.typeStrength);
    const mission = memory.i32(pointer + YR_COMMAND_OFFSETS.mission);
    const queued = memory.i32(pointer + YR_COMMAND_OFFSETS.queuedMission);
    const group = memory.i32(pointer + YR_COMMAND_OFFSETS.group);
    objects.push({
      uid: memory.u32(pointer + O.uniqueId),
      kind: entry.kind,
      type,
      owner,
      x,
      y,
      z,
      health: strength > 0 ? Math.max(0, Math.min(1, memory.i32(pointer + O.health) / strength)) : 0,
      selected: memory.u8(pointer + O.isSelected) !== 0,
      group: group >= 0 && group < 10 ? group : -1,
      mission: YR_MISSIONS[mission] ?? `#${mission}`,
      queuedMission: queued >= 0 ? (YR_MISSIONS[queued] ?? `#${queued}`) : null,
      target: readRef(memory, memory.u32(pointer + YR_COMMAND_OFFSETS.target)),
      destination: entry.mobile ? readRef(memory, memory.u32(pointer + YR_COMMAND_OFFSETS.destination)) : null,
      focus: readRef(memory, memory.u32(pointer + YR_COMMAND_OFFSETS.focus)),
    });
  }
  const localPointer = memory.u32(G.localHouse);
  const tactical = memory.u32(G.tactical);
  return {
    frame: memory.i32(G.frame),
    localHouse: houseIndex.get(localPointer) ?? -1,
    view: isPlausiblePointer(memory, tactical, O.tacticalPos + 8)
      ? { x: memory.i32(tactical + O.tacticalPos), y: memory.i32(tactical + O.tacticalPos + 4) }
      : null,
    objects,
    lastEvent: readLastEvent(memory),
    sidebar,
  };
}

/** True when the image holds every instruction the offsets were taken from. */
export function yrCommandSignaturesMatch(memory: GuestMemoryAccessor): boolean {
  return YR_COMMAND_SIGNATURES.every(({ address, bytes }) => bytes.every((byte, i) => memory.u8(address + i) === byte));
}

/** Guarded factory over an accessor source; null unless the image is the pinned YR 1.001 build. */
export function createYrCommandStateReaderFrom(
  memory: () => GuestMemoryAccessor,
  hash: string,
): GameCommandStateReader | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  const first = memory();
  if (
    !yrCommandSignaturesMatch(first) ||
    first.u32(YR_CELL_VTABLE) < 0x401000 ||
    first.u32(YR_CELL_VTABLE) >= 0x800000
  ) {
    return null;
  }
  // The sidebar reader validates its own tables; without it the order state is still useful.
  const readSidebar = createYrSidebarReader(memory, hash);
  return () => {
    try {
      const accessor = memory();
      // No scenario, no battle: the object vectors of a previous match may still hold stale pointers.
      if (!isPlausiblePointer(accessor, accessor.u32(G.scenario), 4)) return null;
      let sidebar: GameRenderSidebar | null = null;
      try {
        sidebar = readSidebar?.() ?? null;
      } catch {
        sidebar = null;
      }
      return readYrCommandState(accessor, sidebar);
    } catch {
      return null;
    }
  };
}

/** Guarded factory over the live guest memory. */
export function createYrCommandStateReader(
  memory: GuestMemory,
  size: number,
  hash: string,
): GameCommandStateReader | null {
  return createYrCommandStateReaderFrom(() => createByteViewAccessor(memory.read_memory(0, size)), hash);
}
