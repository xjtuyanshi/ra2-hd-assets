import { describe, expect, it, vi } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  readYrBuildingActiveAnim,
  readYrNativeDetail,
  YR_BUILDING_ACTIVE_ANIM as A,
  YR_NATIVE_DETAIL as D,
} from '../../src/games/yr/buildingActiveAnim';

function fixture() {
  const bytes = new Uint8Array(0xc00000);
  const data = new DataView(bytes.buffer);
  const building = 0x10000;
  const anim = 0x20000;
  const type = 0x30000;
  const u32 = (address: number, value: number) => data.setUint32(address, value >>> 0, true);
  const u8 = (address: number, value: number) => data.setUint8(address, value);
  u32(building, 0x7e3ebc);
  u32(building + A.slot, anim);
  u32(anim, 0x7e3354);
  u32(anim + A.type, type);
  u32(type, 0x7e3608);
  u32(type + A.detailLevel, 2);
  u32(D.fps, 30);
  u32(D.min, 15);
  u32(D.buffer, 5);
  u32(D.level, 2);
  const memory = createByteViewAccessor(bytes);
  return {
    bytes,
    memory,
    building,
    anim,
    type,
    u32,
    u8,
    read: () => readYrBuildingActiveAnim(memory, building, readYrNativeDetail(memory)),
  };
}

describe('YR 1.001 completed-building ActiveAnim observer', () => {
  it('distinguishes a null slot from an existing visible anim without writing guest memory', () => {
    const m = fixture();
    const before = m.bytes.slice();
    expect(m.read()).toBe('shown');
    expect(m.bytes.every((value, index) => value === before[index])).toBe(true);
    m.u32(m.building + A.slot, 0);
    expect(m.read()).toBe('none');
  });

  it('reproduces both hysteresis states at every 15/20 FPS boundary', () => {
    const m = fixture();
    for (const [flag, fps, expected] of [
      [0, 14, 'detail'],
      [0, 15, 'shown'],
      [0, 19, 'shown'],
      [0, 20, 'shown'],
      [1, 14, 'detail'],
      [1, 15, 'detail'],
      [1, 19, 'detail'],
      [1, 20, 'shown'],
    ] as const) {
      m.u8(D.lowFrameRate, flag);
      m.u32(D.fps, fps);
      expect(m.read()).toBe(expected);
      expect(m.memory.u8(D.lowFrameRate)).toBe(flag);
    }
    m.u32(D.min, 25);
    m.u32(D.buffer, 7);
    m.u32(D.fps, 31);
    expect(m.read()).toBe('detail');
    m.u32(D.fps, 32);
    expect(m.read()).toBe('shown');
  });

  it('keeps detail 0/1 visible at low FPS, but respects Invisible and options detail independently', () => {
    const m = fixture();
    m.u32(D.fps, 0);
    m.u8(D.lowFrameRate, 1);
    for (const level of [0, 1]) {
      m.u32(m.type + A.detailLevel, level);
      expect(m.read()).toBe('shown');
    }
    m.u8(m.anim + A.invisible, 1);
    expect(m.read()).toBe('detail');
    m.u8(m.anim + A.invisible, 0);
    m.u32(D.fps, 30);
    m.u32(m.type + A.detailLevel, 3);
    expect(m.read()).toBe('detail');
    m.u32(D.level, 3);
    expect(m.read()).toBe('shown');
  });

  it('omits implausible object/anim/type pointers, vtables and anim fields', () => {
    const m = fixture();
    const detail = readYrNativeDetail(m.memory);
    for (const pointer of [0, 0xffff, m.building + 1, m.bytes.length - A.slot, NaN])
      expect(readYrBuildingActiveAnim(m.memory, pointer, detail)).toBeUndefined();
    for (const pointer of [1, 0xffff, m.anim + 1, m.bytes.length - A.invisible, 0xffffffff]) {
      m.u32(m.building + A.slot, pointer);
      expect(m.read()).toBeUndefined();
    }
    m.u32(m.building + A.slot, m.anim);
    for (const pointer of [0, 0xffff, m.type + 1, m.bytes.length - A.detailLevel, 0xffffffff]) {
      m.u32(m.anim + A.type, pointer);
      expect(m.read()).toBeUndefined();
    }
    m.u32(m.anim + A.type, m.type);
    for (const [address, original] of [
      [m.building, 0x7e3ebc],
      [m.anim, 0x7e3354],
      [m.type, 0x7e3608],
    ]) {
      m.u32(address!, 0x7e4570);
      expect(m.read()).toBeUndefined();
      m.u32(address!, original!);
    }
    for (const level of [4, -1]) {
      m.u32(m.type + A.detailLevel, level);
      expect(m.read()).toBeUndefined();
    }
    m.u32(m.type + A.detailLevel, 2);
    m.u8(m.anim + A.invisible, 2);
    expect(m.read()).toBeUndefined();
  });

  it('leaves invalid or unavailable native detail unknown instead of guessing shown/off', () => {
    const m = fixture();
    expect(readYrNativeDetail(m.memory)).toEqual({ fps: 30, lowFrameRate: false, level: 2, min: 15, buffer: 5 });
    for (const [address, value] of [
      [D.fps, -1],
      [D.fps, 1001],
      [D.level, 4],
      [D.min, 0],
      [D.min, -1],
      [D.buffer, -1],
      [D.buffer, 1001],
      [D.min, 1000],
    ]) {
      const previous = m.memory.u32(address!);
      m.u32(address!, value!);
      expect(readYrNativeDetail(m.memory)).toBeNull();
      expect(m.read()).toBeUndefined();
      m.u32(address!, previous);
    }
    m.u8(D.lowFrameRate, 2);
    expect(m.read()).toBeUndefined();
    const short = createByteViewAccessor(m.bytes.subarray(0, D.lowFrameRate));
    expect(readYrNativeDetail(short)).toBeNull();
    const unavailable = { ...m.memory, bytes: vi.fn(() => new Uint8Array(0)) };
    expect(readYrNativeDetail(unavailable)).toBeNull();
    expect(readYrBuildingActiveAnim(unavailable, m.building, null)).toBeUndefined();
    const throwing = {
      ...m.memory,
      bytes: () => {
        throw new Error('unavailable');
      },
    };
    expect(readYrNativeDetail(throwing)).toBeNull();
    expect(readYrBuildingActiveAnim(throwing, m.building, null)).toBeUndefined();
  });
});
