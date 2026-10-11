import type { GameBattlefieldOverlayObject, GameBattlefieldOverlayState } from '../renderState';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_BUILDING_RULES } from './buildingRenderState';
import { YR_COMMAND_OFFSETS } from './commandState';
import { YR_FOUNDATION_SIZES } from './objectCoords';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import {
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS as L,
  YR_STATE_OFFSETS as O,
  YR_STATE_VTABLES as V,
} from './stateReader';

/** Pinned YR 1.001 selected-object vector, read by TacticalClass at 0x6DBE2A / 0x6DBE39. */
export const YR_BATTLEFIELD_OVERLAY = Object.freeze({
  selected: 0xa8ecb8,
  selectionBracketDelta: 0x3e0,
  foundation: 0xef0,
  groupColour: 0x56f9,
});

/** Original instructions only. This reader installs no patches and never authorizes suppression. */
export const YR_BATTLEFIELD_OVERLAY_SIGNATURES = Object.freeze([
  { address: 0x6dbe2a, bytes: [0x8b, 0x1d, 0xc8, 0xec, 0xa8, 0x00] },
  { address: 0x6dbe39, bytes: [0xa1, 0xbc, 0xec, 0xa8, 0x00] },
  { address: 0x6f68d5, bytes: [0x8b, 0xa8, 0xe0, 0x03, 0x00, 0x00] },
  { address: 0x6f6968, bytes: [0x8b, 0xa8, 0xe0, 0x03, 0x00, 0x00] },
  { address: 0x70a6fd, bytes: [0x8b, 0xbd, 0x14, 0x02, 0x00, 0x00] },
  { address: 0x45ec90, bytes: [0x8b, 0x81, 0xf0, 0x0e, 0x00, 0x00] },
]);

const KINDS = [
  { kind: 'vehicle', vtable: V.unit, typeOffset: O.unitType, typeVtable: V.unitType },
  { kind: 'infantry', vtable: V.infantry, typeOffset: O.infantryType, typeVtable: V.infantryType },
  { kind: 'building', vtable: V.building, typeOffset: O.buildingType, typeVtable: V.buildingType },
  { kind: 'aircraft', vtable: V.aircraft, typeOffset: O.aircraftType, typeVtable: V.aircraftType },
] as const;

function exact(memory: GuestMemoryAccessor, address: number, length: number): DataView | null {
  if (!Number.isInteger(address) || address < 0x10000 || address + length > memory.size) return null;
  if (memory.isRangeAvailable?.(address, length) === false) return null;
  const bytes = memory.bytes(address, length);
  return bytes.length === length ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}

/** Read only fully validated objects. Short reads are unknown, including valid-looking zero-filled defaults. */
function readObject(
  memory: GuestMemoryAccessor,
  pointer: number,
  thresholds: readonly [number, number],
  types: Map<number, DataView>,
  houses: ReadonlySet<number>,
): GameBattlefieldOverlayObject | null {
  if (pointer % 4) return null;
  const object = exact(memory, pointer, 0x6c8);
  if (!object || object.getUint8(O.isSelected) !== 1 || object.getUint8(O.inLimbo) !== 0) return null;
  const entry = KINDS.find(({ vtable }) => vtable === object.getUint32(0, true));
  if (!entry) return null;
  const typePointer = object.getUint32(entry.typeOffset, true);
  if (typePointer % 4) return null;
  let type = types.get(typePointer);
  if (!type) {
    type = exact(memory, typePointer, entry.kind === 'building' ? 0xef4 : 0x3e4) ?? undefined;
    if (!type) return null;
    types.set(typePointer, type);
  }
  if (type.getUint32(0, true) !== entry.typeVtable) return null;
  const current = object.getInt32(O.health, true),
    maximum = type.getInt32(O.typeStrength, true);
  const x = object.getInt32(O.location, true),
    y = object.getInt32(O.location + 4, true),
    z = object.getInt32(O.location + 8, true);
  const group = object.getInt32(YR_COMMAND_OFFSETS.group, true);
  if (
    current < 0 ||
    maximum <= 0 ||
    Math.abs(x) > L.maxCoordinate ||
    Math.abs(y) > L.maxCoordinate ||
    Math.abs(z) > L.maxCoordinate ||
    group < -1 ||
    group > 9
  )
    return null;
  const ratio = current / maximum;
  const result: GameBattlefieldOverlayObject = {
    id: pointer,
    uid: object.getUint32(O.uniqueId, true),
    kind: entry.kind,
    selected: true,
    world: { x, y, z },
    health: {
      current,
      maximum,
      ratio,
      // Building DrawHealthBar uses IsRedHP (0x5F5CD0), whose Health > 0 guard keeps zero at its green default.
      colour:
        entry.kind === 'building' && current === 0
          ? 'green'
          : ratio <= thresholds[1]
            ? 'red'
            : ratio <= thresholds[0]
              ? 'yellow'
              : 'green',
    },
    group: null,
  };
  if (group >= 0) {
    const owner = object.getUint32(O.owner, true);
    if (!houses.has(owner)) return null;
    const colour = exact(memory, owner + YR_BATTLEFIELD_OVERLAY.groupColour, 3);
    if (!colour) return null;
    result.group = {
      index: group,
      label: String((group + 1) % 10),
      colour: [colour.getUint8(0), colour.getUint8(1), colour.getUint8(2)],
    };
  }
  if (entry.kind === 'building') {
    const size = YR_FOUNDATION_SIZES[type.getInt32(YR_BATTLEFIELD_OVERLAY.foundation, true)];
    if (!size || size[0] <= 0 || size[1] <= 0) return null;
    result.foundation = { width: size[0], height: size[1] };
  } else {
    const delta = type.getInt32(YR_BATTLEFIELD_OVERLAY.selectionBracketDelta, true);
    if (Math.abs(delta) > 4096) return null;
    const infantry = entry.kind === 'infantry',
      maximumPips = infantry ? 8 : 17;
    // 0x6F68B9..0x6F6973, health ratio conversion/clamps 0x6F697C..0x6F69A7.
    result.mobileGeometry = {
      pipOrigin: { x: infantry ? -5 : -15, y: delta - (infantry ? 24 : 25) },
      borderOrigin: { x: infantry ? 11 : 1, y: delta - (infantry ? 25 : 26) },
      maximumPips,
      filledPips: Math.max(1, Math.min(maximumPips, Math.trunc(ratio * maximumPips))),
      pipStepX: 2,
    };
  }
  return result;
}

/** Atomic read result: one failed member invalidates the package instead of silently erasing that member. */
export function readYrBattlefieldOverlays(
  memory: GuestMemoryAccessor,
  now: () => number = () => performance.now(),
): GameBattlefieldOverlayState | null {
  const started = now();
  try {
    const frameBytes = exact(memory, G.frame, 4),
      scenario = exact(memory, G.scenario, 4);
    const vector = exact(memory, YR_BATTLEFIELD_OVERLAY.selected, 20);
    if (!frameBytes || !scenario || !scenario.getUint32(0, true) || !vector) return null;
    const frame = frameBytes.getInt32(0, true),
      count = vector.getInt32(16, true),
      capacity = vector.getInt32(8, true),
      items = vector.getUint32(4, true);
    // Native insertions compare Count with Capacity before growing: selected 0x5F4638, houses 0x4F61A7.
    if (frame < 0 || count < 0 || capacity < 0 || count > capacity || count > L.objectsPerKind * 4) return null;
    const objects: GameBattlefieldOverlayObject[] = [];
    if (count > 0) {
      if (items % 4) return null;
      const pointers = exact(memory, items, count * 4),
        rulesPointer = exact(memory, YR_BUILDING_RULES.instance, 4);
      if (!pointers || !rulesPointer) return null;
      const rules = rulesPointer.getUint32(0, true);
      if (rules < 0x10000 || rules % 4) return null;
      const thresholds = exact(memory, rules + YR_BUILDING_RULES.yellow, 16);
      if (!thresholds) return null;
      const yellow = thresholds.getFloat64(0, true),
        red = thresholds.getFloat64(8, true);
      if (!(red >= 0 && yellow >= red && yellow <= 1)) return null;
      const houseVector = exact(memory, G.houses, 20);
      if (!houseVector) return null;
      const houseCount = houseVector.getInt32(16, true),
        houseCapacity = houseVector.getInt32(8, true),
        houseItems = houseVector.getUint32(4, true);
      if (houseCount <= 0 || houseCapacity < 0 || houseCount > houseCapacity || houseCount > L.houses || houseItems % 4)
        return null;
      const housePointers = exact(memory, houseItems, houseCount * 4);
      if (!housePointers) return null;
      const houses = new Set<number>();
      for (let index = 0; index < houseCount; index++) {
        const house = housePointers.getUint32(index * 4, true);
        if (
          house < 0x10000 ||
          house % 4 ||
          house + YR_BATTLEFIELD_OVERLAY.groupColour + 3 > memory.size ||
          houses.has(house)
        )
          return null;
        houses.add(house);
      }
      const types = new Map<number, DataView>();
      const seen = new Set<number>();
      for (let index = 0; index < count; index++) {
        const pointer = pointers.getUint32(index * 4, true);
        if (seen.has(pointer)) return null;
        seen.add(pointer);
        const object = readObject(memory, pointer, [yellow, red], types, houses);
        if (!object) return null;
        objects.push(object);
      }
    }
    // A changing frame or selection descriptor is an unknown sample on non-mirrored accessors.
    const finalFrame = exact(memory, G.frame, 4),
      finalVector = exact(memory, YR_BATTLEFIELD_OVERLAY.selected, 20);
    if (
      !finalFrame ||
      !finalVector ||
      finalFrame.getInt32(0, true) !== frame ||
      finalVector.getInt32(16, true) !== count ||
      finalVector.getInt32(8, true) !== capacity ||
      finalVector.getUint32(4, true) !== items
    )
      return null;
    return { frame, presentation: 'native', objects, readerMs: Math.max(0, now() - started) };
  } catch {
    return null;
  }
}

/** Native-only opt-in presently; VM and unknown versions keep the complete original overlay path. */
export function createYrBattlefieldOverlayReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): (() => GameBattlefieldOverlayState | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  const initial = memory();
  for (const signature of YR_BATTLEFIELD_OVERLAY_SIGNATURES) {
    if (initial.isRangeAvailable?.(signature.address, signature.bytes.length) === false) return null;
    const bytes = initial.bytes(signature.address, signature.bytes.length);
    if (bytes.length !== signature.bytes.length || signature.bytes.some((byte, index) => byte !== bytes[index]))
      return null;
  }
  return () => {
    try {
      return readYrBattlefieldOverlays(memory());
    } catch {
      return null;
    }
  };
}
