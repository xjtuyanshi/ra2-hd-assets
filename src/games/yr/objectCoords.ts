import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/** Shared read-only GetCoords dispatch for hash-gated YR observers; instruction evidence also lives in effectsReader.ts. */
export interface YrPoint3 {
  x: number;
  y: number;
  z: number;
}

/** Virtual slot of ObjectClass/AbstractClass::GetCoords and the YR 1.001 implementations this reader reproduces. */
export const YR_GET_COORDS_SLOT = 0x48;
export const YR_GET_COORDS = Object.freeze({
  /** ObjectClass::GetCoords: Location (units, infantry, aircraft, terrain, bullets, ...). */
  object: 0x5f65a0,
  /** BuildingClass::GetCoords: Location + foundation centre offset. */
  building: 0x447ac0,
  /** AnimClass::GetCoords: owner.GetCoords() + Location when attached, else Location. */
  anim: 0x422be0,
  /** CellClass::GetCoords: cell centre at the cell's floor height. */
  cell: 0x486840,
});

/** Foundation enum (YRpp GeneralDefinitions.h) -> [width, height] in cells: the tables at 0x8192B8 / 0x819310. */
export const YR_FOUNDATION_SIZES: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
  [2, 3],
  [3, 2],
  [3, 3],
  [3, 5],
  [4, 2],
  [3, 3],
  [1, 3],
  [3, 1],
  [4, 3],
  [1, 4],
  [1, 5],
  [2, 6],
  [2, 5],
  [5, 3],
  [4, 4],
  [3, 4],
  [6, 4],
  [0, 0],
]);

const OFFSETS = Object.freeze({
  location: 0x9c,
  buildingType: 0x520,
  buildingTypeFoundation: 0xef0,
  animOwnerObject: 0xcc,
  cellMapCoords: 0x24,
  cellLevel: 0x11b,
});
const s8 = (value: number) => (value << 24) >> 24;
const s16 = (value: number) => (value << 16) >> 16;
const pointerFits = (memory: GuestMemoryAccessor, pointer: number, span: number) =>
  Number.isInteger(pointer) && pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= memory.size;

function objectVtable(memory: GuestMemoryAccessor, pointer: number): number {
  if (!pointerFits(memory, pointer, OFFSETS.location + 12)) return 0;
  const vtable = memory.u32(pointer);
  return vtable >= 0x7e1000 && vtable < 0x812000 && (vtable & 3) === 0 && vtable + YR_GET_COORDS_SLOT + 4 <= memory.size
    ? vtable
    : 0;
}

function readPoint(memory: GuestMemoryAccessor, address: number): YrPoint3 {
  return { x: memory.i32(address), y: memory.i32(address + 4), z: memory.i32(address + 8) };
}

/**
 * World position of any object the way its virtual GetCoords (vtable slot 0x48) computes it, for the YR 1.001
 * implementations listed in YR_GET_COORDS; null for an implausible object or an implementation this reader does not
 * reproduce. CellClass heights are the cell's Level * 104 (ramps add up to one level; only used for fire targets).
 */
export function readYrObjectCoords(memory: GuestMemoryAccessor, pointer: number, depth: number = 4): YrPoint3 | null {
  const o = OFFSETS;
  const vtable = objectVtable(memory, pointer);
  if (!vtable) return null;
  const getCoords = memory.u32(vtable + YR_GET_COORDS_SLOT);
  if (getCoords === YR_GET_COORDS.cell) {
    if (!pointerFits(memory, pointer, o.cellLevel + 1)) return null;
    const cx = s16(memory.u16(pointer + o.cellMapCoords)),
      cy = s16(memory.u16(pointer + o.cellMapCoords + 2));
    if (cx < 0 || cy < 0 || cx >= 512 || cy >= 512) return null;
    return { x: cx * 256 + 128, y: cy * 256 + 128, z: s8(memory.u8(pointer + o.cellLevel)) * 104 };
  }
  const location = readPoint(memory, pointer + o.location);
  switch (getCoords) {
    case YR_GET_COORDS.object:
      return location;
    case YR_GET_COORDS.building: {
      if (!pointerFits(memory, pointer, o.buildingType + 4)) return null;
      const type = memory.u32(pointer + o.buildingType);
      if (!pointerFits(memory, type, o.buildingTypeFoundation + 4) || memory.u32(type) !== 0x7e4570) return null;
      const size = YR_FOUNDATION_SIZES[memory.i32(type + o.buildingTypeFoundation)];
      if (!size) return null;
      return { x: location.x + size[0] * 128 - 128, y: location.y + size[1] * 128 - 128, z: location.z };
    }
    case YR_GET_COORDS.anim: {
      if (!pointerFits(memory, pointer, o.animOwnerObject + 4)) return null;
      const owner = memory.u32(pointer + o.animOwnerObject);
      if (owner === 0) return location;
      const limit = 6 * 256;
      if (depth <= 0 || Math.abs(location.x) > limit || Math.abs(location.y) > limit) return null;
      const base = readYrObjectCoords(memory, owner, depth - 1);
      return base && { x: base.x + location.x, y: base.y + location.y, z: base.z + location.z };
    }
    default:
      return null;
  }
}
