import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/**
 * The ore-gathering sparks a harvesting miner shows (YR 1.001, gamemd.exe). They are not an AnimClass: UnitClass's
 * draw (0x73CEC0) blits one frame of OREGATH.SHP (loaded once by name, 0x73CED6) right before the unit's own body,
 * block 0x73D0D1..0x73D283:
 *
 *   - gate: Type->Harvester (type +0xE0E) and the unit's harvesting flag (+0x6D2, set and cleared by the harvest
 *     mission 0x73E75B / 0x73E87D / 0x73E99A / 0x73EB19), the locomotor's Is_Moving_Now (ILocomotion slot +0x80) false,
 *     nothing at unit +0x278 (the temporal weapon erasing it), neither chrono flag (+0x270, +0x271; the virtuals
 *     +0x1D4 / +0x1D8 are plain getters), and, before the block, not Deploying/Undeploying (+0x6E1 / +0x6E2);
 *   - frame: (FootClass +0x538 + Unsorted::CurrentFrame) % 15 + (7 - f8) * 15, with f8 the body facing rounded to
 *     eight directions, (((raw >> 12) + 1) >> 1) & 7. +0x538 is the walk/idle frame counter (0x4DA9FB increments it),
 *     so the phase is not a pure function of the logic frame;
 *   - place: the SHP canvas centre (blit flag 0x200) at the projection of Location moved 30 leptons along the rounded
 *     facing: X + cos(a) * 30, Y - sin(a) * 30, both truncated (yrGatherPoint);
 *   - blit: anim palette (ConvertClass at 0x87F6C0), flags 0x2A00 (centred, read-only Z test, no translucency), ground
 *     gradient 0, the unit's own brightness, depth adjustment of the unit (virtual +0x2EC) minus 2.
 *
 * Checked against 27 frozen native framebuffers (War Miner and Chrono Miner, six of the eight facings): the predicted
 * frame group at the predicted pixel matches the picture wherever the hull does not cover it.
 *
 * Is_Moving_Now is a COM call the reader cannot make; it is evaluated from the same fields the two locomotors of YR's
 * harvesters read (drive 0x4AFC20, teleport 0x4B6610 -> 0x718080). A unit with any other locomotor reports nothing
 * rather than a guess.
 */
export const YR_GATHER_ART = 'OREGATH';
/** Frames per facing group and facing groups of OREGATH.SHP (15 at 0x73D249, eight facings at 0x73D1F3). */
export const YR_GATHER_PHASES = 15;
export const YR_GATHER_FACINGS = 8;

export const YR_GATHER_OFFSETS = Object.freeze({
  /** TechnoClass: chrono flags and the temporal weapon targeting this object. */
  beingWarpedOut: 0x270,
  warpingOut: 0x271,
  temporalTargetingMe: 0x278,
  /** ObjectClass::Location and TechnoClass::Owner / PrimaryFacing. */
  location: 0x9c,
  owner: 0x21c,
  primaryFacing: 0x388,
  /** FootClass: walk/idle frame counter, speed factors (GetCurrentSpeed 0x4DB1A0) and the ILocomotion pointer. */
  walkedFrames: 0x538,
  speedMultiplier: 0x578,
  speedPercentage: 0x580,
  locomotor: 0x674,
  /** UnitClass. */
  unitType: 0x6c4,
  flagHouseIndex: 0x6cc,
  harvesting: 0x6d2,
  deploying: 0x6e1,
  undeploying: 0x6e2,
  /** TechnoTypeClass::Speed (virtual +0x38C, 0x70EFE0) and UnitTypeClass::Harvester. */
  typeSpeed: 0x678,
  typeHarvester: 0xe0e,
  /** HouseClass::Type and the house type's unit speed factor (0x50C075: float, chosen for UnitType = 0x28). */
  houseType: 0x34,
  houseTypeUnitSpeed: 0x12c,
  /** Fields relative to the ILocomotion pointer: LinkedTo, then the drive locomotor's two coordinates. */
  locomotorLinkedTo: 0x8,
  driveDestination: 0x30,
  driveHeadTo: 0x3c,
  /** TeleportLocomotionClass::Is_Moving (0x718080) compares this byte with 1. */
  teleportMoving: 0x30,
});

export const YR_GATHER_GLOBALS = Object.freeze({
  /** CoordStruct the drive locomotor compares its coordinates with (0x4AFB8B, 0x4AFC4A). */
  emptyCoord: 0x8a0790,
});

/** ILocomotion vtables (the dword the unit's +0x674 pointer points at). */
export const YR_GATHER_LOCOMOTORS = Object.freeze({
  drive: 0x7e7eb0,
  teleport: 0x7f5000,
});

export interface YrUnitGatherState {
  /** Art the engine draws (file OREGATH.SHP). */
  art: string;
  /** Absolute SHP frame: facing group * 15 + phase. */
  frame: number;
  /** World point (leptons) the SHP canvas centre is drawn at. */
  x: number;
  y: number;
  z: number;
}

const s16 = (value: number) => (value << 16) >> 16;

/**
 * Lepton offset of the draw point per eight-way facing, [dx, dy] before the engine truncates X + dx and Y + dy
 * (0x73D184..0x73D1B6). The angle (int16(f8 << 13) - 0x3FFF) * -2pi/65536 (double at 0x7E2810) goes through the
 * engine's sine table (floats at 0x84F084, 0x2000 steps per turn; 0x4CACB0 reads the sine, 0x4CAD00 the cosine a
 * quarter turn on) and is scaled by 30 (double at 0x7F61D0). These are the table's own values at the eight indices
 * that formula selects, cosine * 30 and -sine * 30; the three near-zero entries are the table's 1.22e-16 and
 * -2.45e-16. A miner gathers at a cell centre, where one lepton more or less does not move the picture by a pixel, so
 * the x87 precision the engine truncates them with is not observable (checked on 27 frozen native frames).
 */
const DIAGONAL = 30 * Math.fround(Math.SQRT1_2);
const GATHER_OFFSETS: readonly (readonly [number, number])[] = [
  [30 * 1.2246063538223773e-16, -30],
  [DIAGONAL, -DIAGONAL],
  [30, 0],
  [DIAGONAL, DIAGONAL],
  [30 * -2.4492127076447545e-16, 30],
  [-DIAGONAL, DIAGONAL],
  [-30, -30 * 1.2246063538223773e-16],
  [-DIAGONAL, -DIAGONAL],
];

/** The engine's draw point for a unit at (x, y) with the given eight-way facing (0 = north, clockwise on screen). */
export function yrGatherPoint(x: number, y: number, f8: number): { x: number; y: number } {
  const [dx, dy] = GATHER_OFFSETS[f8 & 7]!;
  return { x: Math.trunc(x + dx), y: Math.trunc(y + dy) };
}

function plausible(memory: GuestMemoryAccessor, pointer: number, span: number): boolean {
  return pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= memory.size;
}

const scratch = new DataView(new ArrayBuffer(8));
function f32(memory: GuestMemoryAccessor, address: number): number {
  scratch.setUint32(0, memory.u32(address), true);
  return scratch.getFloat32(0, true);
}
function f64(memory: GuestMemoryAccessor, address: number): number {
  scratch.setUint32(0, memory.u32(address), true);
  scratch.setUint32(4, memory.u32(address + 4), true);
  return scratch.getFloat64(0, true);
}

/** FacingClass::Is_Rotating (0x4C9480). */
function facingRotating(memory: GuestMemoryAccessor, facing: number, frame: number): boolean {
  if (s16(memory.u16(facing + 0x14)) <= 0) return false;
  const start = memory.i32(facing + 0x8);
  let left = memory.i32(facing + 0x10);
  if (start !== -1) {
    const elapsed = frame - start;
    if (elapsed >= left) return false;
    left -= elapsed;
  }
  return left !== 0;
}

/** FootClass::GetCurrentSpeed (0x4DB1A0) > 0 for a UnitClass, without its veterancy factor (see the module notes). */
function currentSpeedPositive(memory: GuestMemoryAccessor, unit: number, type: number): boolean | undefined {
  const o = YR_GATHER_OFFSETS;
  const house = memory.u32(unit + o.owner);
  if (!plausible(memory, house, o.houseType + 4)) return undefined;
  const houseType = memory.u32(house + o.houseType);
  if (!plausible(memory, houseType, o.houseTypeUnitSpeed + 4)) return undefined;
  const factor = f32(memory, houseType + o.houseTypeUnitSpeed);
  const percentage = f64(memory, unit + o.speedPercentage);
  const multiplier = f64(memory, unit + o.speedMultiplier);
  if (![factor, percentage, multiplier].every(Number.isFinite)) return undefined;
  // The veteran "faster" factor (0x4DB1E8..0x4DB205) multiplies an integer by a rules value of at least 1 in YR
  // (VeteranSpeed=1.2), which cannot change whether the result is positive, so it is not read.
  let speed = Math.trunc(Math.trunc(memory.i32(type + o.typeSpeed) * factor * percentage) * multiplier);
  if (memory.i32(unit + o.flagHouseIndex) !== -1) speed = Math.trunc(speed / 2);
  return speed > 0;
}

/** The unit's locomotor reports that it is moving or turning now; undefined when that cannot be evaluated. */
export function readYrUnitMovingNow(
  memory: GuestMemoryAccessor,
  unit: number,
  type: number,
  frame: number,
): boolean | undefined {
  const o = YR_GATHER_OFFSETS;
  const locomotor = memory.u32(unit + o.locomotor);
  if (!plausible(memory, locomotor, o.driveHeadTo + 12)) return undefined;
  const vtable = memory.u32(locomotor);
  if (vtable === YR_GATHER_LOCOMOTORS.teleport) return memory.u8(locomotor + o.teleportMoving) === 1;
  if (vtable !== YR_GATHER_LOCOMOTORS.drive) return undefined;
  // DriveLocomotionClass::Is_Moving_Now (0x4AFC20) asks the linked object; it must be this unit.
  if (memory.u32(locomotor + o.locomotorLinkedTo) !== unit) return undefined;
  if (facingRotating(memory, unit + o.primaryFacing, frame)) return true;
  const coord = (at: number) => [memory.i32(at), memory.i32(at + 4), memory.i32(at + 8)] as const;
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const empty = coord(YR_GATHER_GLOBALS.emptyCoord);
  const destination = coord(locomotor + o.driveDestination);
  const headTo = coord(locomotor + o.driveHeadTo);
  const location = coord(unit + o.location);
  // Is_Moving (0x4AFB80): a destination, or a head-to coordinate away from the unit's cell position.
  const moving =
    !same(destination, empty) || (!same(headTo, empty) && (headTo[0] !== location[0] || headTo[1] !== location[1]));
  if (!moving || same(headTo, empty)) return false;
  return currentSpeedPositive(memory, unit, type);
}

/**
 * The sparks the native draw adds under this unit on this logic frame, or undefined when it draws none (or when a
 * field needed to decide is implausible). `facingRaw` is FacingClass::Current of the body, as the caller already read.
 */
export function readYrUnitGatherState(
  memory: GuestMemoryAccessor,
  unit: number,
  frame: number,
  facingRaw: number,
): YrUnitGatherState | undefined {
  const o = YR_GATHER_OFFSETS;
  try {
    if (!plausible(memory, unit, o.undeploying + 1)) return undefined;
    const type = memory.u32(unit + o.unitType);
    if (!plausible(memory, type, o.typeHarvester + 1)) return undefined;
    const flags = [
      memory.u8(type + o.typeHarvester),
      memory.u8(unit + o.harvesting),
      memory.u8(unit + o.deploying),
      memory.u8(unit + o.undeploying),
      memory.u8(unit + o.beingWarpedOut),
      memory.u8(unit + o.warpingOut),
    ];
    // The engine writes these bools as 0 or 1; anything else is a torn or foreign read.
    if (!flags.every((flag) => flag === 0 || flag === 1)) return undefined;
    const [harvester, harvesting, deploying, undeploying, beingWarped, warping] = flags;
    if (!harvester || !harvesting || deploying || undeploying || beingWarped || warping) return undefined;
    if (memory.u32(unit + o.temporalTargetingMe) !== 0) return undefined;
    if (readYrUnitMovingNow(memory, unit, type, frame) !== false) return undefined;
    const phase = (memory.i32(unit + o.walkedFrames) + frame) % YR_GATHER_PHASES;
    if (phase < 0) return undefined;
    const f8 = ((((facingRaw & 0xffff) >> 12) + 1) >> 1) & 7;
    return {
      art: YR_GATHER_ART,
      frame: (YR_GATHER_FACINGS - 1 - f8) * YR_GATHER_PHASES + phase,
      ...yrGatherPoint(memory.i32(unit + o.location), memory.i32(unit + o.location + 4), f8),
      z: memory.i32(unit + o.location + 8),
    };
  } catch {
    return undefined;
  }
}

/**
 * Every gather input that can change without a new logic frame, folded into one number for a change key (location,
 * facing, chrono flags and the walk counter are hashed by the caller already). The locomotor is only evaluated for a
 * unit whose harvesting flag is set.
 */
export function readYrUnitGatherKey(memory: GuestMemoryAccessor, unit: number, frame: number): number {
  const o = YR_GATHER_OFFSETS;
  if (!plausible(memory, unit, o.undeploying + 1)) return -1;
  const harvesting = memory.u8(unit + o.harvesting);
  let key = harvesting | (memory.u8(unit + o.deploying) << 8) | (memory.u8(unit + o.undeploying) << 16);
  if (memory.u32(unit + o.temporalTargetingMe) !== 0) key |= 1 << 24;
  if (harvesting) {
    const type = memory.u32(unit + o.unitType);
    const moving = plausible(memory, type, o.typeHarvester + 1)
      ? readYrUnitMovingNow(memory, unit, type, frame)
      : undefined;
    key |= (moving === undefined ? 3 : moving ? 2 : 1) << 25;
  }
  return key;
}
