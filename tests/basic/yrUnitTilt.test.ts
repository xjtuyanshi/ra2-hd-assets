import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import { YR_UNIT_TILT as T, readYrUnitTilt } from '../../src/games/yr/unitTilt';

const FRAME = 5000;
const UNIT = 0x20_0000;
const LOCO = 0x30_0000;
/** Tilt of the edge ramps and of the corner ramps, as the engine's start-up table holds them. */
const EDGE = (29.31 * Math.PI) / 180;
const CORNER = (21.36 * Math.PI) / 180;

/** Synthetic guest memory: one unit, its locomotor and the ramp matrix table (3x4 row-major floats per ramp). */
function memory() {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  const u32 = (at: number, value: number) => view.setUint32(at, value >>> 0, true);
  const i32 = (at: number, value: number) => view.setInt32(at, value, true);
  /** Rotation about a horizontal axis that takes straight up to (x, north, z). */
  const ramp = (index: number, x: number, north: number, z: number) => {
    const at = T.rampMatrices + index * T.matrixBytes;
    // Only the third column is read; the others carry a distinct value so a wrong column is noticed.
    for (let i = 0; i < 12; i++) view.setFloat32(at + i * 4, 0.125, true);
    view.setFloat32(at + 8, x, true);
    view.setFloat32(at + 24, north, true);
    view.setFloat32(at + 40, z, true);
  };
  ramp(0, 0, 0, 1);
  ramp(1, -Math.sin(EDGE), 0, Math.cos(EDGE));
  ramp(2, 0, Math.sin(EDGE), Math.cos(EDGE));
  ramp(3, Math.sin(EDGE), 0, Math.cos(EDGE));
  ramp(4, 0, -Math.sin(EDGE), Math.cos(EDGE));
  ramp(5, -Math.sin(CORNER) * Math.SQRT1_2, Math.sin(CORNER) * Math.SQRT1_2, Math.cos(CORNER));
  for (let i = 17; i < 21; i++) ramp(i, 0, 0, 1);
  u32(UNIT + T.locomotor, LOCO);
  u32(LOCO, T.driveVtable);
  u32(LOCO + T.linkedTo, UNIT);
  const drive = (
    current: number,
    previous = 0,
    timer: [start: number, left: number, duration: number] = [-1, 0, 0],
  ) => {
    i32(LOCO + T.currentRamp, current);
    i32(LOCO + T.previousRamp, previous);
    i32(LOCO + T.timerStart, timer[0]);
    i32(LOCO + T.timerLeft, timer[1]);
    i32(LOCO + T.timerDuration, timer[2]);
  };
  drive(0);
  const read = (frame = FRAME) => readYrUnitTilt(createByteViewAccessor(bytes), UNIT, frame);
  return { bytes, view, u32, i32, ramp, drive, read };
}

describe('YR unit draw tilt', () => {
  it('reports a level body on flat ground and the ramp matrix up vector on a ramp, with y pointing south', () => {
    const m = memory();
    expect(m.read()).toEqual({ x: 0, y: 0, z: 1 });
    m.drive(3);
    const east = m.read()!;
    expect(east.x).toBeCloseTo(Math.sin(EDGE), 5);
    expect(east.y).toBeCloseTo(0, 6);
    expect(east.z).toBeCloseTo(Math.cos(EDGE), 5);
    // The table's second row is north; game coordinates grow to the south.
    m.drive(2);
    const north = m.read()!;
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(-Math.sin(EDGE), 5);
    expect(north.z).toBeCloseTo(Math.cos(EDGE), 5);
    m.drive(5);
    const corner = m.read()!;
    expect(Math.hypot(corner.x, corner.y, corner.z)).toBeCloseTo(1, 5);
    expect(Math.acos(corner.z)).toBeCloseTo(CORNER, 4);
    // North-west in the table is (-x, +north): west and north in game coordinates are both negative.
    expect(corner.x).toBeLessThan(0);
    expect(corner.y).toBeCloseTo(corner.x, 5);
  });

  it('blends from the previous ramp while the slope timer runs and ends exactly on the current one', () => {
    const m = memory();
    // Three-frame blend started two frames ago with three frames left then: one frame is left now.
    m.drive(3, 0, [FRAME - 2, 3, 3]);
    const blended = m.read()!;
    expect(Math.hypot(blended.x, blended.y, blended.z)).toBeCloseTo(1, 6);
    expect(Math.acos(blended.z)).toBeCloseTo((EDGE * 2) / 3, 4);
    expect(blended.y).toBeCloseTo(0, 6);
    // Each logic frame advances the blend; a stopped timer (start -1) holds its remaining time.
    expect(Math.acos(m.read(FRAME - 2)!.z)).toBeCloseTo(0, 4);
    expect(Math.acos(m.read(FRAME - 1)!.z)).toBeCloseTo(EDGE / 3, 4);
    expect(Math.acos(m.read(FRAME + 1)!.z)).toBeCloseTo(EDGE, 4);
    expect(Math.acos(m.read(FRAME + 50)!.z)).toBeCloseTo(EDGE, 4);
    m.drive(3, 0, [-1, 2, 3]);
    expect(Math.acos(m.read()!.z)).toBeCloseTo(EDGE / 3, 4);
    expect(Math.acos(m.read(FRAME + 50)!.z)).toBeCloseTo(EDGE / 3, 4);
    // Ramp to ramp: the blend passes between the two up vectors, never through level.
    m.drive(2, 3, [FRAME - 1, 2, 2]);
    const between = m.read()!;
    expect(between.x).toBeGreaterThan(0.2);
    expect(between.y).toBeLessThan(-0.2);
    expect(between.z).toBeGreaterThan(Math.cos(EDGE) - 1e-6);
  });

  it('keeps bodies level for the locomotors that draw with the base matrix', () => {
    const m = memory();
    m.drive(3);
    for (const vtable of T.levelVtables) {
      m.u32(LOCO, vtable);
      expect(m.read()).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it('reports nothing for other locomotors or implausible state instead of guessing', () => {
    const m = memory();
    m.drive(3);
    m.u32(LOCO, 0x7e_1234);
    expect(m.read()).toBeUndefined();
    m.u32(LOCO, T.driveVtable);
    expect(m.read()).toBeDefined();
    // The locomotor must point back at this unit.
    m.u32(LOCO + T.linkedTo, UNIT + 0x10);
    expect(m.read()).toBeUndefined();
    m.u32(LOCO + T.linkedTo, UNIT);
    for (const pointer of [0, 0x1000, LOCO + 2, 0x100_0000 - 8, 0xffff_fff0]) {
      m.u32(UNIT + T.locomotor, pointer);
      expect(m.read()).toBeUndefined();
    }
    m.u32(UNIT + T.locomotor, LOCO);
    for (const ramp of [-1, T.rampCount, 0x7fff_ffff]) {
      m.drive(ramp);
      expect(m.read()).toBeUndefined();
    }
    // A table entry that is not a unit vector pointing up (table not initialised, wrong image) is rejected.
    m.drive(6);
    expect(m.read()).toBeUndefined();
    m.ramp(6, 0, 0.9, -0.4359);
    expect(m.read()).toBeUndefined();
    m.ramp(6, 2, 0, 2);
    expect(m.read()).toBeUndefined();
    m.drive(3, 0, [FRAME, 3, -1]);
    expect(m.read()).toBeUndefined();
    // A running blend needs a valid previous ramp; a finished one does not.
    m.drive(3, 6, [FRAME - 1, 3, 3]);
    expect(m.read()).toBeUndefined();
    m.drive(3, 6, [FRAME - 3, 3, 3]);
    expect(Math.acos(m.read()!.z)).toBeCloseTo(EDGE, 4);
    expect(readYrUnitTilt(createByteViewAccessor(m.bytes), 0, FRAME)).toBeUndefined();
    expect(readYrUnitTilt(createByteViewAccessor(m.bytes.subarray(0, UNIT + 0x100)), UNIT, FRAME)).toBeUndefined();
  });
});
