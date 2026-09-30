import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import { readYrBuildingRenderState } from './buildingRenderState';
import { readYrInfantryRenderState } from './infantryRenderState';

/**
 * Read-only live battlefield state of Yuri's Revenge 1.001 (gamemd.exe, SHA-256 in YR_STARTUP_PAGE_HASH) for an
 * external renderer. It only reads guest memory through a GuestMemoryAccessor, so it runs unchanged on the main thread
 * and inside the VM Worker, and it never writes guest state or calls guest code.
 *
 * Source of the layout: the community YRpp headers (Phobos-developers/YRpp, reverse-engineered YR 1.001 classes) used
 * as facts only (addresses and field offsets; no code is taken from them). Offsets that YRpp only implies through field
 * order were computed from neighbouring anchors (fields YRpp names by their offset, such as `unknown_62C` or
 * `gap_AE`). The H2 construction/infantry observers document executable instruction evidence in
 * buildingRenderState.ts and infantryRenderState.ts. scripts/remaster/bridge/verifyStateReader.mts checks the
 * baseline object/map/facing fields against a running skirmish; H2 animation acceptance is a separate live check.
 *
 * Consistency: the poll runs between emulator slices, so it may observe the game half way through a logic frame (for
 * example an object already removed from one vector but not yet from another). Every pointer, count and string is
 * validated and anything implausible is skipped and counted in `stats`, never thrown.
 */

/** YR 1.001 global addresses (YRpp facts; see the field notes). */
export const YR_STATE_GLOBALS = Object.freeze({
  /** Unsorted::CurrentFrame, the logic frame counter (also used by src/games/yr/performance.ts). */
  frame: 0xa8ed84,
  /** DynamicVectorClass<UnitClass*> (vehicles, including naval units and MCVs). */
  units: 0x8b4108,
  infantry: 0xa83de8,
  buildings: 0xa8eb40,
  aircraft: 0xa8e390,
  /** DynamicVectorClass<TechnoClass*> holding all four kinds above. */
  technos: 0xa8ec78,
  houses: 0xa80228,
  /** HouseClass::CurrentPlayer (the house of the player at this computer). */
  localHouse: 0xa83d4c,
  /** ScenarioClass::Instance (pointer). */
  scenario: 0xa8b230,
  /** MapClass::Instance (the global map object itself, not a pointer). */
  map: 0x87f7e8,
  /** TacticalClass::Instance (pointer). */
  tactical: 0x887324,
  /** Five LayerClass vectors, in painter order (stride 0x18; TacticalClass::Render at 0x6D8DB0). */
  renderLayers: 0x8a0360,
});

/** DynamicVectorClass: Items pointer at +4, Count at +0x10. */
const VECTOR_ITEMS = 0x4;
const VECTOR_COUNT = 0x10;

/** Field offsets inside YR 1.001 classes (YRpp facts). */
export const YR_STATE_OFFSETS = Object.freeze({
  /** AbstractClass::UniqueID (sequence number, never reused within a game). */
  uniqueId: 0x10,
  /** ObjectClass::Health (int, current hit points). */
  health: 0x6c,
  /** ObjectClass::InLimbo (bool: removed from the map, e.g. inside a transport/factory or pending deletion). */
  inLimbo: 0x81,
  /** ObjectClass::IsSelected (bool, selected by the player at this computer). */
  isSelected: 0x83,
  /** ObjectClass::Location, CoordStruct {int X, Y, Z} in leptons (256 per cell, 104 per height level). */
  location: 0x9c,
  /** TechnoClass::Owner (HouseClass*). */
  owner: 0x21c,
  /** TechnoClass::PrimaryFacing (FacingClass, the body). */
  primaryFacing: 0x388,
  /** TechnoClass::SecondaryFacing (FacingClass, the turret). */
  secondaryFacing: 0x3a0,
  /** UnitClass::Type (UnitTypeClass*). */
  unitType: 0x6c4,
  /** InfantryClass::Type (InfantryTypeClass*). */
  infantryType: 0x6c0,
  /** BuildingClass::Type (BuildingTypeClass*). */
  buildingType: 0x520,
  /** AircraftClass::Type (AircraftTypeClass*); +0x6c0 holds the IFlyControl interface pointer. */
  aircraftType: 0x6c4,
  /** AbstractTypeClass::ID (char[0x18], the rules section name such as "MTNK"). */
  typeId: 0x24,
  /** ObjectTypeClass::Strength (int, full hit points). */
  typeStrength: 0xa0,
  /** TechnoTypeClass::Turret (bool). */
  typeTurret: 0xca1,
  /** BuildingTypeClass::Gate (bool); BuildingClass::GetYSort at 0x449410 subtracts 16. */
  buildingTypeGate: 0x16b7,
  /** BuildingTypeClass::TurretAnimIsVoxel (bool); the same sort virtual adds 32. */
  buildingTypeVoxelTurret: 0x16c5,
  /** HouseClass::ArrayIndex. */
  houseArrayIndex: 0x30,
  /** HouseClass::Type (HouseTypeClass*; its AbstractTypeClass::ID is the country, e.g. "Americans"). */
  houseType: 0x34,
  /** HouseClass::IsHumanPlayer (bool). */
  houseHuman: 0x1ec,
  /** HouseClass::Defeated (bool). */
  houseDefeated: 0x1f5,
  /**
   * HouseClass::PlainName (char[21]): the internal house name. For the local human it holds the placeholder
   * "<human player>", not the name the game displays.
   */
  housePlainName: 0x15ff4,
  /**
   * HouseClass::UIName (wchar_t[21], UTF-16LE): the name the game displays (score screen, diplomacy), e.g. the
   * player's handle. A search of the live local house found the displayed name only here.
   */
  houseUIName: 0x1602a,
  /** HouseClass::ColorSchemeIndex (int, index into the colour scheme list). */
  houseColorScheme: 0x16054,
  /** HouseClass::StartingPoint (int, multiplayer start waypoint index). */
  houseStartingPoint: 0x16058,
  /**
   * ScenarioClass::Waypoints (CellStruct[702] = {short X, short Y}). CellStruct is 2-byte aligned, so the array follows
   * `bool IsGamePaused` (0x630) at 0x632, not 0x634; verified against the map file's [Waypoints] (value = Y*1000 + X).
   */
  scenarioWaypoints: 0x632,
  /** ScenarioClass::Theater (TheaterType int). */
  scenarioTheater: 0x1258,
  /** ScenarioClass::FileName (char[0x104]). */
  scenarioFileName: 0x125c,
  /** MapClass::MapRect (RectangleStruct {X, Y, Width, Height}), the [Map] Size= rectangle. */
  mapRect: 0xec,
  /** MapClass::VisibleRect (RectangleStruct), the [Map] LocalSize= rectangle. */
  mapVisibleRect: 0xfc,
  /** TacticalClass::TacticalPos (Point2D, pixel position of the viewport's top-left corner). */
  tacticalPos: 0xb0,
});

/** Primary vtable addresses (YRpp `AbsVTable`); an object whose first dword differs is not what the vector claims. */
export const YR_STATE_VTABLES = Object.freeze({
  unit: 0x7f5c70,
  infantry: 0x7eb058,
  building: 0x7e3ebc,
  aircraft: 0x7e22a4,
  unitType: 0x7f6218,
  infantryType: 0x7eb610,
  buildingType: 0x7e4570,
  aircraftType: 0x7e2868,
});

/** Sanity limits: anything larger is treated as a stale or torn read. */
export const YR_STATE_LIMITS = Object.freeze({
  houses: 32,
  /** Per object vector. */
  objectsPerKind: 16384,
  /** A layer can contain every techno kind as well as effects. */
  objectsPerLayer: 65536,
  /** Lowest plausible heap pointer; the PE image sits at 0x400000 and the heap arena above it. */
  minPointer: 0x10000,
  /** |X|, |Y| in leptons: 512 cells is far beyond the largest map (MapClass allows at most 511 per axis). */
  maxCoordinate: 512 * 256,
  maxHeight: 64 * 104,
});

export type YrObjectKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';
export type YrTheater = 'temperate' | 'snow' | 'urban' | 'desert' | 'newurban' | 'lunar';

/** TheaterType enum order (YRpp GeneralDefinitions.h): Temperate=0, Snow, Urban, Desert, NewUrban, Lunar=5. */
const THEATERS: readonly YrTheater[] = ['temperate', 'snow', 'urban', 'desert', 'newurban', 'lunar'];

export interface YrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YrMapState {
  /** ScenarioClass::FileName, e.g. "RIVERRAM.YRO"; null when not a plausible ASCII name. */
  fileName: string | null;
  theater: YrTheater | null;
  /** [Map] Size= width/height in cells (MapClass::MapRect). */
  width: number;
  height: number;
  /** [Map] Size= origin (normally 0,0). */
  size: YrRect | null;
  /** [Map] LocalSize= (MapClass::VisibleRect): the playable area. */
  localSize: YrRect | null;
}

export interface YrHouseState {
  /** Index in HouseClass::Array; matches YrObjectState.owner. */
  index: number;
  /** Country (HouseTypeClass ID, e.g. "Americans"). */
  country: string | null;
  /**
   * HouseClass::UIName: the name the game displays for this house (the player's handle for a human), or null when
   * empty or not a plausible string.
   */
  name: string | null;
  /**
   * HouseClass::PlainName: the internal house name ("<human player>" for the local human, "Computer" for an AI in a
   * skirmish, "Neutral"/"Special" for the map houses). Not a display name.
   */
  plainName: string | null;
  colorIndex: number;
  isHuman: boolean;
  isLocal: boolean;
  defeated: boolean;
  /**
   * HouseClass::StartingPoint as stored. In a skirmish with random start positions it keeps the requested value
   * (-2 = random) rather than the resolved waypoint, and the map's Neutral/Special houses hold 0; locate a player's
   * start from its MCV and the start waypoints (readYrWaypoint 0..7) instead.
   */
  startingPoint: number;
}

export interface YrObjectState {
  /** Stable while the object lives: the native object pointer. Pointers may be reused after deletion; see `uid`. */
  id: number;
  /** AbstractClass::UniqueID, unique for the whole game (distinguishes a reused pointer). */
  uid: number;
  kind: YrObjectKind;
  /** Rules ID, e.g. "MTNK", "AMCV", "GACNST". */
  type: string;
  /** Owning house index in `houses`, or -1 when the owner pointer is not a known house. */
  owner: number;
  /**
   * World position in leptons (256 per cell; Z: 104 per height level); cell = floor(x / 256), floor(y / 256). Mobile
   * objects report their centre. Buildings report the centre of their foundation's top-left (north-most) cell: a
   * deployed GACNST sits at (-256, -256) from the MCV it came from, i.e. the renderer adds the foundation offset.
   */
  x: number;
  y: number;
  z: number;
  /**
   * Body facing, 0..255: 0 = north (world -Y, towards the top-right of the screen), 64 = east (+X, bottom-right),
   * 128 = south (+Y, bottom-left), 192 = west (-X, top-left); increasing clockwise as seen on screen. Buildings report
   * their (normally unused) facing too.
   */
  facing: number;
  /** Body facing in the native 16-bit resolution (0..65535, same orientation), for smooth interpolation. */
  facingRaw: number;
  /** Turret facing 0..255 (same convention), only for types with Turret=yes. */
  turretFacing?: number;
  turretFacingRaw?: number;
  /** Validated engine construction/sale state (H2); omitted on an implausible read. */
  buildState?: 'building' | 'selling' | 'done';
  /** Actual building make SHP frame, including engine sale/gate reversal. */
  buildupFrame?: number;
  /** Art sequence key from InfantryClass::SequenceAnim. */
  infantrySequence?: string;
  /** Sequence-local animation stage, excluding start/facing offsets. */
  sequenceFrame?: number;
  /** Optional engine-selected 16-bit infantry art direction; leaves body/travel facing unchanged. */
  infantryDrawFacingRaw?: number;
  /** Native registered painter position; absent when the layer list cannot be read reliably. */
  renderOrder?: { layer: number; index: number; ySort: number };
  /** Health / Strength clamped to 0..1. */
  health: number;
  isSelected: boolean;
}

export interface YrStateStats {
  /** Raw DynamicVectorClass counts, per kind, as the game reports them. */
  vectors: Record<YrObjectKind, number>;
  /** Objects skipped because they were in limbo (0 when `includeLimbo` is set). */
  limbo: Record<YrObjectKind, number>;
  /** Entries skipped because a pointer, vtable, type or coordinate failed validation. */
  invalid: Record<YrObjectKind, number>;
}

export interface YrState {
  frame: number;
  map: YrMapState | null;
  houses: YrHouseState[];
  /** Index of the local player's house, or -1. */
  localHouse: number;
  /** TacticalClass::TacticalPos: screen-space pixel position of the viewport's top-left corner. */
  view: { x: number; y: number } | null;
  objects: YrObjectState[];
  stats: YrStateStats;
}

const KINDS: ReadonlyArray<{
  kind: YrObjectKind;
  vector: number;
  vtable: number;
  typeOffset: number;
  typeVtable: number;
}> = [
  {
    kind: 'building',
    vector: YR_STATE_GLOBALS.buildings,
    vtable: YR_STATE_VTABLES.building,
    typeOffset: YR_STATE_OFFSETS.buildingType,
    typeVtable: YR_STATE_VTABLES.buildingType,
  },
  {
    kind: 'vehicle',
    vector: YR_STATE_GLOBALS.units,
    vtable: YR_STATE_VTABLES.unit,
    typeOffset: YR_STATE_OFFSETS.unitType,
    typeVtable: YR_STATE_VTABLES.unitType,
  },
  {
    kind: 'infantry',
    vector: YR_STATE_GLOBALS.infantry,
    vtable: YR_STATE_VTABLES.infantry,
    typeOffset: YR_STATE_OFFSETS.infantryType,
    typeVtable: YR_STATE_VTABLES.infantryType,
  },
  {
    kind: 'aircraft',
    vector: YR_STATE_GLOBALS.aircraft,
    vtable: YR_STATE_VTABLES.aircraft,
    typeOffset: YR_STATE_OFFSETS.aircraftType,
    typeVtable: YR_STATE_VTABLES.aircraftType,
  },
];

/** A plausible, 4-byte aligned heap/data pointer inside guest memory with room for `span` bytes. */
export function isPlausiblePointer(memory: GuestMemoryAccessor, pointer: number, span = 4): boolean {
  return (
    Number.isInteger(pointer) &&
    pointer >= YR_STATE_LIMITS.minPointer &&
    (pointer & 3) === 0 &&
    pointer + span <= memory.size
  );
}

/**
 * Read a NUL-terminated printable-ASCII string of at most `max` bytes. Returns null for an empty string, a missing
 * terminator or any non-printable byte, so garbage memory never turns into a name.
 */
export function readAsciiZ(memory: GuestMemoryAccessor, address: number, max: number): string | null {
  const bytes = memory.bytes(address, max);
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) return text || null;
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return null;
}

/**
 * Read a NUL-terminated UTF-16LE string of at most `max` code units. Returns null for an empty string, a missing
 * terminator, a control character or an unpaired surrogate, so garbage memory never turns into a name.
 */
export function readUtf16Z(memory: GuestMemoryAccessor, address: number, max: number): string | null {
  const bytes = memory.bytes(address, max * 2);
  if (bytes.length !== max * 2) return null;
  let text = '';
  let highSurrogate = false;
  for (let i = 0; i < max; i++) {
    const unit = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (highSurrogate !== isLow) return null;
    if (unit === 0) return text || null;
    if (unit < 0x20 || (unit >= 0x7f && unit < 0xa0)) return null;
    highSurrogate = unit >= 0xd800 && unit <= 0xdbff;
    text += String.fromCharCode(unit);
  }
  return null;
}

/**
 * Read a DynamicVectorClass of pointers. Returns null when the header is implausible (count above `limit`, items
 * pointer invalid). Entries are returned raw; the caller validates each one.
 */
export function readPointerVector(memory: GuestMemoryAccessor, vector: number, limit: number): number[] | null {
  const count = memory.u32(vector + VECTOR_COUNT);
  if (count === 0) return [];
  if (count > limit) return null;
  const items = memory.u32(vector + VECTOR_ITEMS);
  if (!isPlausiblePointer(memory, items, count * 4)) return null;
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) result[i] = memory.u32(items + i * 4);
  return result;
}

const s16 = (value: number) => (value << 16) >> 16;

/**
 * Current 16-bit direction of a FacingClass {DirStruct Desired @0, DirStruct Start @4, CDTimerClass RotationTimer
 * @8 (StartTime @8, TimeLeft @0x10), DirStruct ROT @0x14}, reproducing FacingClass::Current() (YR 0x4C93D0): while the
 * rotation timer runs, the facing is interpolated from Desired backwards by the remaining steps. A timer is running when
 * StartTime != -1; its remaining time is max(0, TimeLeft - (frame - StartTime)).
 */
export function readFacingRaw(memory: GuestMemoryAccessor, facing: number, frame: number): number {
  const desired = memory.u16(facing);
  const rot = s16(memory.u16(facing + 0x14));
  if (rot <= 0) return desired;
  const start = memory.i32(facing + 0x8);
  const timeLeft = memory.i32(facing + 0x10);
  // A stopped timer (StartTime == -1) keeps TimeLeft as stored; the game only tests it for non-zero, so a negative
  // value still counts as running.
  const left = start === -1 ? timeLeft : Math.max(0, timeLeft - (frame - start));
  if (left === 0) return desired;
  const diff = s16(desired - memory.u16(facing + 0x4));
  const steps = Math.trunc(Math.abs(diff) / rot);
  if (steps <= 0) return desired;
  // Same order as the game (0x4C93D0: `idiv steps` then `imul left`): divide first, truncating toward zero, then
  // multiply, so the result matches the game's 16-bit value exactly (e.g. diff 101, steps 3, left 2 -> 66, not 67).
  return (desired - Math.trunc(diff / steps) * left) & 0xffff;
}

/**
 * 16-bit DirStruct -> 0..255 facing with the engine's own rounding (DirStruct::GetValue<8>, i.e.
 * TranslateFixedPoint<16, 8>: ((raw >> 7) + 1) >> 1, wrapped). 0 = north (-Y), 64 = east (+X), clockwise.
 */
export function facingToByte(raw: number): number {
  return ((((raw & 0xffff) >> 7) + 1) >> 1) & 0xff;
}

/**
 * Unit direction of a 0..255 facing in world lepton axes: dx = sin(2*pi*f/256), dy = -cos(2*pi*f/256), matching the
 * engine's DirStruct::GetRadian (radian = (f - 64) * -2*pi/256 measured with Y pointing north).
 */
export function facingToWorldVector(facing: number): { dx: number; dy: number } {
  const angle = (facing / 256) * Math.PI * 2;
  return { dx: Math.sin(angle), dy: -Math.cos(angle) };
}

/** Inverse of facingToWorldVector for a world displacement (dx, dy); returns 0..255 (fractional). */
export function worldVectorToFacing(dx: number, dy: number): number {
  const angle = Math.atan2(dx, -dy);
  return ((((angle / (Math.PI * 2)) * 256) % 256) + 256) % 256;
}

function readRect(memory: GuestMemoryAccessor, address: number): YrRect | null {
  const rect = {
    x: memory.i32(address),
    y: memory.i32(address + 4),
    width: memory.i32(address + 8),
    height: memory.i32(address + 12),
  };
  const ok =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.width <= 511 &&
    rect.height <= 511 &&
    Math.abs(rect.x) <= 511 &&
    Math.abs(rect.y) <= 511;
  return ok ? rect : null;
}

/** Scenario/map description; null when the scenario pointer is not set (menus, loading). */
export function readYrMap(memory: GuestMemoryAccessor): YrMapState | null {
  const scenario = memory.u32(YR_STATE_GLOBALS.scenario);
  if (!isPlausiblePointer(memory, scenario, YR_STATE_OFFSETS.scenarioFileName + 0x104)) return null;
  const theater = memory.i32(scenario + YR_STATE_OFFSETS.scenarioTheater);
  const size = readRect(memory, YR_STATE_GLOBALS.map + YR_STATE_OFFSETS.mapRect);
  return {
    fileName: readAsciiZ(memory, scenario + YR_STATE_OFFSETS.scenarioFileName, 0x104),
    theater: THEATERS[theater] ?? null,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    size,
    localSize: readRect(memory, YR_STATE_GLOBALS.map + YR_STATE_OFFSETS.mapVisibleRect),
  };
}

/**
 * Multiplayer start waypoint as a cell, or null. ScenarioClass::Waypoints holds CellStruct {short X, short Y}; an
 * unused waypoint is (0, 0) or negative.
 */
export function readYrWaypoint(memory: GuestMemoryAccessor, index: number): { x: number; y: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= 702) return null;
  const scenario = memory.u32(YR_STATE_GLOBALS.scenario);
  if (!isPlausiblePointer(memory, scenario, YR_STATE_OFFSETS.scenarioFileName)) return null;
  const at = scenario + YR_STATE_OFFSETS.scenarioWaypoints + index * 4;
  const x = s16(memory.u16(at)),
    y = s16(memory.u16(at + 2));
  return x > 0 && y > 0 ? { x, y } : null;
}

export interface ReadYrStateOptions {
  /** Also return objects in limbo (default false: they are skipped and counted). */
  includeLimbo?: boolean;
}

/**
 * One consistent-as-possible snapshot of the battlefield. Never throws for any memory content; outside a battle it
 * returns an empty object list and a null map.
 */
export function readYrState(memory: GuestMemoryAccessor, options: ReadYrStateOptions = {}): YrState {
  const o = YR_STATE_OFFSETS;
  const frame = memory.i32(YR_STATE_GLOBALS.frame);
  const perKind = () => ({ building: 0, vehicle: 0, infantry: 0, aircraft: 0 });
  const stats: YrStateStats = { vectors: perKind(), limbo: perKind(), invalid: perKind() };

  // Houses first: object owners are resolved against this list.
  const housePointers = readPointerVector(memory, YR_STATE_GLOBALS.houses, YR_STATE_LIMITS.houses) ?? [];
  const localPointer = memory.u32(YR_STATE_GLOBALS.localHouse);
  const houseIndex = new Map<number, number>();
  const houses: YrHouseState[] = [];
  let localHouse = -1;
  for (const [index, house] of housePointers.entries()) {
    if (!isPlausiblePointer(memory, house, o.houseStartingPoint + 4)) continue;
    if (memory.i32(house + o.houseArrayIndex) !== index) continue;
    const type = memory.u32(house + o.houseType);
    houseIndex.set(house, index);
    if (house === localPointer) localHouse = index;
    houses.push({
      index,
      country: isPlausiblePointer(memory, type, o.typeId + 0x18) ? readAsciiZ(memory, type + o.typeId, 0x18) : null,
      name: readUtf16Z(memory, house + o.houseUIName, 21),
      plainName: readAsciiZ(memory, house + o.housePlainName, 21),
      colorIndex: memory.i32(house + o.houseColorScheme),
      isHuman: memory.u8(house + o.houseHuman) !== 0,
      isLocal: house === localPointer,
      defeated: memory.u8(house + o.houseDefeated) !== 0,
      startingPoint: memory.i32(house + o.houseStartingPoint),
    });
  }

  const typeCache = new Map<number, { id: string; strength: number; turret: boolean } | null>();
  const readType = (pointer: number, vtable: number) => {
    let cached = typeCache.get(pointer);
    if (cached === undefined) {
      cached = null;
      if (isPlausiblePointer(memory, pointer, o.typeTurret + 1) && memory.u32(pointer) === vtable) {
        const id = readAsciiZ(memory, pointer + o.typeId, 0x18);
        if (id)
          cached = {
            id,
            strength: memory.i32(pointer + o.typeStrength),
            turret: memory.u8(pointer + o.typeTurret) !== 0,
          };
      }
      typeCache.set(pointer, cached);
    }
    return cached;
  };

  const objects: YrObjectState[] = [];
  // Ground insertion (0x551A90) and its stable adjacent sort (0x551A30) compare GetYSort only; equal
  // keys keep registration order. Read the actual lists for their ties and locomotor-specific air layers.
  const renderOrders = new Map<number, { layer: number; index: number } | null>();
  for (let layer = 0; layer < 5; layer++) {
    const pointers = readPointerVector(
      memory,
      YR_STATE_GLOBALS.renderLayers + layer * 0x18,
      YR_STATE_LIMITS.objectsPerLayer,
    );
    if (!pointers) continue;
    for (const [index, pointer] of pointers.entries()) {
      if (!isPlausiblePointer(memory, pointer)) continue;
      // A poll between emulator slices can see registration in two lists; neither index is authoritative.
      renderOrders.set(pointer, renderOrders.has(pointer) ? null : { layer, index });
    }
  }
  const seen = new Set<number>();
  for (const spec of KINDS) {
    const count = memory.u32(spec.vector + VECTOR_COUNT);
    stats.vectors[spec.kind] = count;
    const pointers = readPointerVector(memory, spec.vector, YR_STATE_LIMITS.objectsPerKind);
    if (!pointers) {
      stats.invalid[spec.kind] += count;
      continue;
    }
    for (const pointer of pointers) {
      if (
        !isPlausiblePointer(memory, pointer, spec.typeOffset + 4) ||
        memory.u32(pointer) !== spec.vtable ||
        seen.has(pointer)
      ) {
        stats.invalid[spec.kind]++;
        continue;
      }
      seen.add(pointer);
      const inLimbo = memory.u8(pointer + o.inLimbo) !== 0;
      if (inLimbo && !options.includeLimbo) {
        stats.limbo[spec.kind]++;
        continue;
      }
      const typePointer = memory.u32(pointer + spec.typeOffset);
      const type = readType(typePointer, spec.typeVtable);
      const x = memory.i32(pointer + o.location),
        y = memory.i32(pointer + o.location + 4),
        z = memory.i32(pointer + o.location + 8);
      if (
        !type ||
        Math.abs(x) > YR_STATE_LIMITS.maxCoordinate ||
        Math.abs(y) > YR_STATE_LIMITS.maxCoordinate ||
        Math.abs(z) > YR_STATE_LIMITS.maxHeight
      ) {
        stats.invalid[spec.kind]++;
        continue;
      }
      const facingRaw = readFacingRaw(memory, pointer + o.primaryFacing, frame);
      const hitPoints = memory.i32(pointer + o.health);
      const object: YrObjectState = {
        id: pointer,
        uid: memory.u32(pointer + o.uniqueId),
        kind: spec.kind,
        type: type.id,
        owner: houseIndex.get(memory.u32(pointer + o.owner)) ?? -1,
        x,
        y,
        z,
        facing: facingToByte(facingRaw),
        facingRaw,
        health: type.strength > 0 ? Math.min(1, Math.max(0, hitPoints / type.strength)) : 0,
        isSelected: memory.u8(pointer + o.isSelected) !== 0,
      };
      if (type.turret) {
        const turretRaw = readFacingRaw(memory, pointer + o.secondaryFacing, frame);
        object.turretFacingRaw = turretRaw;
        object.turretFacing = facingToByte(turretRaw);
      }
      // The image/hash gate belongs to this reader; optional H2 observers validate their extra spans and fields.
      if (spec.kind === 'building') Object.assign(object, readYrBuildingRenderState(memory, pointer));
      else if (spec.kind === 'infantry') Object.assign(object, readYrInfantryRenderState(memory, pointer));
      const renderOrder = renderOrders.get(pointer);
      if (
        renderOrder &&
        (spec.kind !== 'building' || isPlausiblePointer(memory, typePointer, o.buildingTypeVoxelTurret + 1))
      ) {
        // ObjectClass::GetYSort (0x5F6BD0) is X+Y, without Z. Buildings use GetPosition_2
        // (0x459EF0), Location minus half a cell on both axes, independently of foundation size.
        const adjustment =
          spec.kind === 'building'
            ? -256 +
              (memory.u8(typePointer + o.buildingTypeVoxelTurret) ? 32 : 0) -
              (memory.u8(typePointer + o.buildingTypeGate) ? 16 : 0)
            : 0;
        object.renderOrder = { ...renderOrder, ySort: x + y + adjustment };
      }
      objects.push(object);
    }
  }

  const tactical = memory.u32(YR_STATE_GLOBALS.tactical);
  const view = isPlausiblePointer(memory, tactical, o.tacticalPos + 8)
    ? { x: memory.i32(tactical + o.tacticalPos), y: memory.i32(tactical + o.tacticalPos + 4) }
    : null;

  return { frame, map: readYrMap(memory), houses, localHouse, view, objects, stats };
}

/**
 * Guarded factory: only the pinned YR 1.001 image is supported. Beyond the hash it checks that each primary vtable
 * address holds a code pointer inside the image, so a different build or a not-yet-loaded image yields null instead of
 * silently wrong data.
 */
export function createYrStateReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): ((options?: ReadYrStateOptions) => YrState | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  const imageValid = (accessor: GuestMemoryAccessor) =>
    Object.values(YR_STATE_VTABLES).every((vtable) => {
      const first = accessor.u32(vtable);
      return first >= 0x401000 && first < 0x800000;
    });
  if (!imageValid(memory())) return null;
  return (options) => {
    try {
      return readYrState(memory(), options);
    } catch {
      return null;
    }
  };
}
