import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_STATE_GLOBALS as G,
  YR_STATE_OFFSETS as O,
  YR_STATE_VTABLES as V,
  readYrState,
} from '../../src/games/yr/stateReader';
import {
  YR_GATHER_ART,
  YR_GATHER_GLOBALS,
  YR_GATHER_LOCOMOTORS as LOCO,
  YR_GATHER_OFFSETS as GO,
  readYrUnitGatherKey,
  readYrUnitGatherState,
  readYrUnitMovingNow,
  yrGatherPoint,
} from '../../src/games/yr/unitGatherState';

const FRAME = 1000;
/** A cell centre, where a miner stops to gather. */
const AT = { x: 40 * 256 + 128, y: 60 * 256 + 128, z: 208 };

/** Synthetic guest memory with one harvester on a stopped drive (or teleport) locomotor and its harvesting flag set. */
function miner(locomotorVtable: number = LOCO.drive) {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  let heap = 0xb0_0000;
  const alloc = (size: number) => {
    const at = heap;
    heap += (size + 15) & ~15;
    return at;
  };
  const m = {
    bytes,
    u8: (a: number, v: number) => view.setUint8(a, v),
    u16: (a: number, v: number) => view.setUint16(a, v, true),
    u32: (a: number, v: number) => view.setUint32(a, v >>> 0, true),
    i32: (a: number, v: number) => view.setInt32(a, v, true),
    f32: (a: number, v: number) => view.setFloat32(a, v, true),
    f64: (a: number, v: number) => view.setFloat64(a, v, true),
    coord: (a: number, x: number, y: number, z: number) => {
      view.setInt32(a, x, true);
      view.setInt32(a + 4, y, true);
      view.setInt32(a + 8, z, true);
    },
  };
  m.i32(G.frame, FRAME);
  const houseType = alloc(0x200);
  m.f32(houseType + GO.houseTypeUnitSpeed, 1);
  const house = alloc(0x16100);
  m.i32(house + O.houseArrayIndex, 0);
  m.u32(house + GO.houseType, houseType);
  const type = alloc(0x1700);
  m.u32(type, V.unitType);
  'HARV'.split('').forEach((c, i) => m.u8(type + O.typeId + i, c.charCodeAt(0)));
  m.i32(type + O.typeStrength, 1000);
  m.u8(type + GO.typeHarvester, 1);
  m.i32(type + GO.typeSpeed, 4);
  const locomotor = alloc(0x80);
  m.u32(locomotor, locomotorVtable);
  const unit = alloc(0x700);
  m.u32(unit, V.unit);
  m.u32(unit + O.uniqueId, 7);
  m.i32(unit + O.health, 1000);
  m.coord(unit + GO.location, AT.x, AT.y, AT.z);
  m.u32(unit + GO.owner, house);
  m.u32(unit + GO.unitType, type);
  m.u32(unit + GO.locomotor, locomotor);
  m.u32(locomotor + GO.locomotorLinkedTo, unit);
  m.i32(unit + GO.flagHouseIndex, -1);
  m.f64(unit + GO.speedPercentage, 1);
  m.f64(unit + GO.speedMultiplier, 1);
  m.u8(unit + GO.harvesting, 1);
  m.i32(unit + GO.walkedFrames, 7);
  // FacingClass: desired = start, no rotation running.
  const facing = (raw: number, start = raw, timerStart = -1, timeLeft = 0, rot = 0) => {
    m.u16(unit + GO.primaryFacing, raw);
    m.u16(unit + GO.primaryFacing + 4, start);
    m.i32(unit + GO.primaryFacing + 8, timerStart);
    m.i32(unit + GO.primaryFacing + 0x10, timeLeft);
    m.u16(unit + GO.primaryFacing + 0x14, rot);
  };
  facing(0x8000);
  const vector = (base: number, pointers: number[]) => {
    const items = alloc(Math.max(4, pointers.length * 4));
    pointers.forEach((pointer, i) => m.u32(items + i * 4, pointer));
    m.u32(base + 4, items);
    m.u32(base + 0x10, pointers.length);
  };
  vector(G.houses, [house]);
  vector(G.units, [unit]);
  const memory = () => createByteViewAccessor(bytes);
  const read = (facingRaw = 0x8000, frame = FRAME) => readYrUnitGatherState(memory(), unit, frame, facingRaw);
  return { m, unit, type, house, houseType, locomotor, facing, memory, read };
}

describe('YR ore-gathering sparks', () => {
  it('reports the native frame and draw point of a stopped, harvesting miner', () => {
    const h = miner();
    // Facing south (f8 = 4) is group 7 - 4 = 3; phase = (7 walked + 1000) % 15 = 2. The point is 30 leptons ahead.
    expect(h.read()).toEqual({ art: YR_GATHER_ART, frame: 3 * 15 + 2, x: AT.x, y: AT.y + 30, z: AT.z });
    // One phase per logic frame, wrapping after 15; the walk counter shifts the phase.
    expect(h.read(0x8000, FRAME + 1)!.frame).toBe(3 * 15 + 3);
    expect(h.read(0x8000, FRAME + 13)!.frame).toBe(3 * 15 + 0);
    h.m.i32(h.unit + GO.walkedFrames, 8);
    expect(h.read()!.frame).toBe(3 * 15 + 3);
  });

  it.each([
    [0, 0x0000, 0, -30],
    [1, 0x2000, 21, -22],
    [2, 0x4000, 30, 0],
    [3, 0x6000, 21, 21],
    [4, 0x8000, 0, 30],
    [5, 0xa000, -22, 21],
    [6, 0xc000, -30, 0],
    [7, 0xe000, -22, -22],
  ])('facing %i selects its frame group and the engine-truncated offset', (f8, raw, dx, dy) => {
    const h = miner();
    const group = 7 - f8;
    expect(h.read(raw)).toMatchObject({ frame: group * 15 + 2, x: AT.x + dx, y: AT.y + dy });
    expect(yrGatherPoint(AT.x, AT.y, f8)).toEqual({ x: AT.x + dx, y: AT.y + dy });
    // The facing is rounded to the nearest of eight directions like the engine's ((raw >> 12) + 1) >> 1.
    expect(h.read((raw + 0x0fff) & 0xffff)!.frame).toBe(group * 15 + 2);
    expect(h.read((raw + 0x1000) & 0xffff)!.frame).toBe(((7 - ((f8 + 1) & 7)) & 7) * 15 + 2);
  });

  it('draws nothing unless the type harvests and the unit is in the harvesting state', () => {
    const h = miner();
    h.m.u8(h.type + GO.typeHarvester, 0);
    expect(h.read()).toBeUndefined();
    h.m.u8(h.type + GO.typeHarvester, 1);
    h.m.u8(h.unit + GO.harvesting, 0);
    expect(h.read()).toBeUndefined();
    h.m.u8(h.unit + GO.harvesting, 1);
    expect(h.read()).toBeDefined();
    for (const offset of [GO.deploying, GO.undeploying, GO.beingWarpedOut, GO.warpingOut]) {
      h.m.u8(h.unit + offset, 1);
      expect(h.read()).toBeUndefined();
      h.m.u8(h.unit + offset, 0);
    }
    h.m.u32(h.unit + GO.temporalTargetingMe, 0xb12340);
    expect(h.read()).toBeUndefined();
    h.m.u32(h.unit + GO.temporalTargetingMe, 0);
    // A torn bool is not a state.
    h.m.u8(h.unit + GO.harvesting, 0x40);
    expect(h.read()).toBeUndefined();
  });

  it('follows the drive locomotor: turning or driving on hides the sparks, a stop shows them', () => {
    const h = miner();
    const moving = () => readYrUnitMovingNow(h.memory(), h.unit, h.type, FRAME);
    expect(moving()).toBe(false);
    // Rotating in place: timer started 2 frames ago with 5 left, ROT set.
    h.facing(0x8000, 0x4000, FRAME - 2, 5, 0x800);
    expect(moving()).toBe(true);
    expect(h.read()).toBeUndefined();
    // The same timer once it has run out.
    h.facing(0x8000, 0x4000, FRAME - 5, 5, 0x800);
    expect(moving()).toBe(false);
    h.facing(0x8000);
    // Heading to the next ore cell at full speed.
    h.m.coord(h.locomotor + GO.driveHeadTo, AT.x + 256, AT.y, AT.z);
    expect(moving()).toBe(true);
    expect(h.read()).toBeUndefined();
    // Blocked: a head-to coordinate but no speed is not "moving now", and the engine keeps drawing the sparks.
    h.m.f64(h.unit + GO.speedPercentage, 0);
    expect(moving()).toBe(false);
    expect(h.read()).toBeDefined();
    // Speed 4 x 0.2 truncates to 0; 4 x 0.25 is 1.
    h.m.f64(h.unit + GO.speedPercentage, 0.2);
    expect(moving()).toBe(false);
    h.m.f64(h.unit + GO.speedPercentage, 0.25);
    expect(moving()).toBe(true);
    // A flag carrier's speed is halved (1 / 2 truncates to 0).
    h.m.i32(h.unit + GO.flagHouseIndex, 0);
    expect(moving()).toBe(false);
    h.m.i32(h.unit + GO.flagHouseIndex, -1);
    h.m.f64(h.unit + GO.speedPercentage, 1);
    // Arrived: the head-to coordinate equals the position (height ignored) and no destination remains.
    h.m.coord(h.locomotor + GO.driveHeadTo, AT.x, AT.y, 0);
    expect(moving()).toBe(false);
    // A destination alone is moving only together with a head-to coordinate.
    h.m.coord(h.locomotor + GO.driveHeadTo, 0, 0, 0);
    h.m.coord(h.locomotor + GO.driveDestination, AT.x + 512, AT.y, AT.z);
    expect(moving()).toBe(false);
    h.m.coord(h.locomotor + GO.driveHeadTo, AT.x, AT.y, AT.z);
    expect(moving()).toBe(true);
    // The engine compares with its own empty coordinate, not with a literal zero.
    h.m.coord(YR_GATHER_GLOBALS.emptyCoord, AT.x, AT.y, AT.z);
    expect(moving()).toBe(false);
  });

  it('follows the teleport locomotor of the Chrono Miner and refuses unknown locomotors', () => {
    const chrono = miner(LOCO.teleport);
    expect(chrono.read()).toMatchObject({ frame: 3 * 15 + 2 });
    chrono.m.u8(chrono.locomotor + GO.teleportMoving, 1);
    expect(readYrUnitMovingNow(chrono.memory(), chrono.unit, chrono.type, FRAME)).toBe(true);
    expect(chrono.read()).toBeUndefined();
    const other = miner(0x7e8278);
    expect(readYrUnitMovingNow(other.memory(), other.unit, other.type, FRAME)).toBeUndefined();
    expect(other.read()).toBeUndefined();
    // A drive locomotor linked to another object, a missing locomotor or an unreadable owner decide nothing.
    const foreign = miner();
    foreign.m.u32(foreign.locomotor + GO.locomotorLinkedTo, foreign.type);
    expect(foreign.read()).toBeUndefined();
    const none = miner();
    none.m.u32(none.unit + GO.locomotor, 0);
    expect(none.read()).toBeUndefined();
    const ownerless = miner();
    ownerless.m.coord(ownerless.locomotor + GO.driveHeadTo, AT.x + 256, AT.y, AT.z);
    ownerless.m.u32(ownerless.unit + GO.owner, 0);
    expect(readYrUnitMovingNow(ownerless.memory(), ownerless.unit, ownerless.type, FRAME)).toBeUndefined();
    expect(ownerless.read()).toBeUndefined();
  });

  it('changes its key with every input that can change inside one logic frame', () => {
    const h = miner();
    const key = () => readYrUnitGatherKey(h.memory(), h.unit, FRAME);
    const stopped = key();
    h.m.coord(h.locomotor + GO.driveHeadTo, AT.x + 256, AT.y, AT.z);
    const driving = key();
    expect(driving).not.toBe(stopped);
    h.m.u8(h.unit + GO.harvesting, 0);
    const idle = key();
    expect(new Set([stopped, driving, idle]).size).toBe(3);
    h.m.u8(h.unit + GO.deploying, 1);
    expect(key()).not.toBe(idle);
    expect(readYrUnitGatherKey(h.memory(), h.m.bytes.length - 4, FRAME)).toBe(-1);
  });

  it('is published by the state reader only while the engine draws it', () => {
    const h = miner();
    const state = readYrState(h.memory());
    expect(state.objects).toHaveLength(1);
    expect(state.objects[0]).toMatchObject({
      type: 'HARV',
      gather: { art: 'OREGATH', frame: 3 * 15 + 2, x: AT.x, y: AT.y + 30, z: AT.z },
    });
    h.m.u8(h.unit + GO.harvesting, 0);
    expect(readYrState(h.memory()).objects[0]).not.toHaveProperty('gather');
  });
});
