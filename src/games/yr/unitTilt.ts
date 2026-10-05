import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/**
 * Read-only native draw tilt of a ground vehicle for the image guarded by createYrStateReader (YR 1.001,
 * YR_STARTUP_PAGE_HASH). Evidence is instruction-level in the player's pinned gamemd.exe; no guest calls or writes.
 *
 * - UnitClass draws its voxel with ILocomotion::Draw_Matrix (vtable slot +0x24) of the locomotor at Techno +0x674.
 *   DriveLocomotionClass (ILocomotion vtable 0x7E7EB0, linked object at +8) implements it at 0x4AFF60: the facing
 *   rotation of LocomotionClass::Draw_Matrix (0x55A730) is multiplied by the ramp matrix of the locomotor's current
 *   ramp (+0x18, 0..20) taken from the table at 0xB45188 (0x7559B0, 48 bytes per 3x4 row-major float matrix).
 * - While the slope timer runs (start +0x20, time left +0x28, duration +0x2C; 0x4B0301..0x4B038E) the matrix is the
 *   quaternion blend from the previous ramp (+0x1C) to the current one (0x755A40), with
 *   fraction = (duration - max(0, left - (frame - start))) / duration. A drive across ramp cells sets a 3-frame blend.
 * - The table is filled at start-up (0x754CB0): live values measured in a skirmish are rotations of 29.31 degrees for
 *   the four edge ramps 1-4 and the double ramps 13-16 and 21.36 degrees for the corner ramps 5-12; 0 and 17-20 are the
 *   identity. The third column is the body's up vector in the engine's voxel frame (x east, y north, z up).
 * - Locomotors whose Draw_Matrix slot is LocomotionClass's own 0x55A730 (Teleport 0x7F5000 of the Chrono Miner,
 *   Walk 0x7F69F8 and the three other base users) never tilt: their bodies stay level on every ramp.
 * - Rocking (Techno +0x328/+0x32C, the other half of 0x4AFFBD..0x4B02B3) is not reported: a rocked unit keeps its
 *   slope tilt here.
 *
 * Other locomotors (ship, hover, tunnel, rocket, jumpjet, fly) return undefined: the consumer keeps its own policy.
 */
export const YR_UNIT_TILT = Object.freeze({
  locomotor: 0x674,
  linkedTo: 0x8,
  driveVtable: 0x7e7eb0,
  levelVtables: Object.freeze([0x7e8278, 0x7eadf4, 0x7edb6c, 0x7f5000, 0x7f69f8]),
  currentRamp: 0x18,
  previousRamp: 0x1c,
  timerStart: 0x20,
  timerLeft: 0x28,
  timerDuration: 0x2c,
  rampMatrices: 0xb45188,
  rampCount: 21,
  matrixBytes: 48,
});

/** Unit up vector of the drawn body in game axes: x east, y south, z up. */
export interface YrUnitTilt {
  x: number;
  y: number;
  z: number;
}

const LEVEL: YrUnitTilt = Object.freeze({ x: 0, y: 0, z: 1 });
const scratch = new DataView(new ArrayBuffer(4));
const f32 = (m: GuestMemoryAccessor, at: number) => {
  scratch.setUint32(0, m.u32(at), true);
  return scratch.getFloat32(0, true);
};
const plausible = (m: GuestMemoryAccessor, pointer: number, span: number) =>
  Number.isInteger(pointer) && pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= m.size;

/** Third column of a ramp matrix, or null unless it is a unit vector pointing upwards. */
function rampUp(m: GuestMemoryAccessor, ramp: number): YrUnitTilt | null {
  const t = YR_UNIT_TILT;
  if (!Number.isInteger(ramp) || ramp < 0 || ramp >= t.rampCount) return null;
  if (ramp === 0) return LEVEL;
  const at = t.rampMatrices + ramp * t.matrixBytes;
  if (at + t.matrixBytes > m.size) return null;
  const x = f32(m, at + 8),
    north = f32(m, at + 24),
    z = f32(m, at + 40);
  const length = Math.hypot(x, north, z);
  if (!(Math.abs(length - 1) < 0.01) || !(z > 0.5)) return null;
  return { x: x / length, y: -north / length, z: z / length };
}

/** Spherical interpolation of two unit vectors (they are at most about 60 degrees apart here). */
function slerp(a: YrUnitTilt, b: YrUnitTilt, t: number): YrUnitTilt {
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return b;
  const sin = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sin,
    wb = Math.sin(t * angle) / sin;
  return { x: wa * a.x + wb * b.x, y: wa * a.y + wb * b.y, z: wa * a.z + wb * b.z };
}

/**
 * Up vector the engine draws this unit's body with at logic frame `frame`; undefined when the locomotor is not one
 * of the validated classes or any field is implausible (never an approximate endpoint).
 */
export function readYrUnitTilt(m: GuestMemoryAccessor, unit: number, frame: number): YrUnitTilt | undefined {
  const t = YR_UNIT_TILT;
  if (!plausible(m, unit, t.locomotor + 4)) return undefined;
  const loco = m.u32(unit + t.locomotor);
  if (!plausible(m, loco, t.timerDuration + 4) || m.u32(loco + t.linkedTo) !== unit) return undefined;
  const vtable = m.u32(loco);
  if (t.levelVtables.includes(vtable)) return LEVEL;
  if (vtable !== t.driveVtable) return undefined;
  const current = rampUp(m, m.i32(loco + t.currentRamp));
  if (!current) return undefined;
  const duration = m.i32(loco + t.timerDuration);
  if (duration < 0) return undefined;
  if (duration === 0) return current;
  const start = m.i32(loco + t.timerStart);
  const time = m.i32(loco + t.timerLeft);
  const left = start === -1 ? time : Math.max(0, time - (frame - start));
  const fraction = (duration - left) / duration;
  if (!(fraction < 1)) return current;
  const previous = rampUp(m, m.i32(loco + t.previousRamp));
  if (!previous || !(fraction >= 0)) return undefined;
  return slerp(previous, current, fraction);
}
