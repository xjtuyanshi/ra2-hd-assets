import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_INFANTRY_RENDER_OFFSETS as O,
  YR_INFANTRY_SEQUENCES,
  readYrInfantryRenderState,
} from '../../src/games/yr/infantryRenderState';

function fixture(sequence = 0, sequenceFrame = 0, size = 0x20000) {
  const bytes = new Uint8Array(size);
  const data = new DataView(bytes.buffer);
  const pointer = 0x10000;
  const i32 = (offset: number, value: number) => data.setInt32(pointer + offset, value, true);
  i32(0, 0x7eb058);
  i32(O.sequence, sequence);
  i32(O.sequenceFrame, sequenceFrame);
  return { memory: createByteViewAccessor(bytes), pointer, i32, data };
}

function jumpjet() {
  const f = fixture(26, 2, 0x900000);
  const type = 0x12000;
  const target = 0x14000;
  const locomotor = 0x16004;
  const put = (at: number, value: number) => f.data.setInt32(at, value, true);
  const float = (at: number, value: number) => f.data.setFloat32(at, value, true);
  const point = (at: number, x: number, y: number, z = 0) => {
    put(at + 0x9c, x);
    put(at + 0xa0, y);
    put(at + 0xa4, z);
  };
  f.i32(O.type, type);
  f.i32(O.target, target);
  f.i32(O.locomotor, locomotor);
  put(type, 0x7eb610);
  f.data.setUint8(type + O.jumpJet, 1);
  put(locomotor - 4, 0x7ece34);
  put(locomotor, 0x7ecd68);
  put(0x7ece40, 0x54b710);
  put(target, 0x7f5c70);
  put(0x7f5c70 + 0x48, 0x5f65a0);
  put(0x7eb058 + 0x48, 0x5f65a0);
  point(f.pointer, 2560, 2560, 512);
  point(target, 2816, 2560);
  float(0x8650b8, 0.024413354694843292);
  return {
    ...f,
    type,
    target,
    locomotor,
    put,
    float,
    point,
    read: () => readYrInfantryRenderState(f.memory, f.pointer),
  };
}

describe('YR H2 infantry animation state', () => {
  it('retains a zero-health infantry until native removal and reads its current death stage', () => {
    const f = fixture(11, 0);
    f.i32(0x6c, 0);
    expect(readYrInfantryRenderState(f.memory, f.pointer)).toEqual({ infantrySequence: 'Die1', sequenceFrame: 0 });
    f.i32(O.sequenceFrame, 2);
    expect(readYrInfantryRenderState(f.memory, f.pointer)).toEqual({ infantrySequence: 'Die1', sequenceFrame: 2 });
  });
  it('publishes the target draw direction independently of travel facing using native word truncation', () => {
    const f = jumpjet();
    f.i32(0x388, 0x8000);
    for (const [dx, dy, raw] of [
      [0, -256, 0],
      [256, 0, 0x3fff],
      [0, 256, 0x7fff],
      [-256, 0, 0xc001],
      [0, 0, 0x3fff],
    ]) {
      f.point(f.target, 2560 + dx!, 2560 + dy!, 1000);
      expect(f.read()).toEqual({ infantrySequence: 'FireFly', sequenceFrame: 2, infantryDrawFacingRaw: raw });
    }
  });

  it('uses the native atan table and quadrants rather than a continuous atan2', () => {
    const f = jumpjet();
    // A synthetic table entry distinguishes lookup index truncation from a host trigonometric calculation.
    f.float(0x8610b4 + 40 * 4, Math.PI / 4);
    for (const [dx, dy, raw] of [
      [256, -256, 0x1fff],
      [256, 256, 0x5fff],
      [-256, 256, 0x9ffe],
      [-256, -256, 0xe001],
    ]) {
      f.point(f.target, 2560 + dx!, 2560 + dy!);
      expect(f.read()?.infantryDrawFacingRaw).toBe(raw);
    }
    // Ratios beyond the table saturate to its pi/2 branch.
    f.point(f.target, 2561, 12560);
    expect(f.read()?.infantryDrawFacingRaw).toBe(0x7fff);
  });

  it('resolves building foundation centres and cell targets through their validated GetCoords slots', () => {
    const f = jumpjet();
    f.put(f.target, 0x7e3ebc);
    f.put(0x7e3ebc + 0x48, 0x447ac0);
    f.put(f.target + 0x520, 0x18000);
    f.put(0x18000, 0x7e4570);
    f.put(0x18000 + 0xef0, 8); // 4x2: GetCoords adds (384, 128).
    f.point(f.target, 2816 - 384, 2560 - 128);
    expect(f.read()?.infantryDrawFacingRaw).toBe(0x3fff);
    f.put(f.target, 0x7e4eec);
    f.put(0x7e4eec + 0x48, 0x486840);
    f.data.setUint16(f.target + 0x24, 11, true);
    f.data.setUint16(f.target + 0x26, 10, true);
    f.point(f.pointer, 2560 + 128, 2560 + 128);
    expect(f.read()?.infantryDrawFacingRaw).toBe(0x3fff);
  });

  it('omits draw facing when a branch condition or target validation fails, keeping the sequence', () => {
    const changes: Array<(f: ReturnType<typeof jumpjet>) => void> = [
      (f) => f.data.setUint8(f.type + O.jumpJet, 0),
      (f) => f.data.setUint8(f.type + O.jumpJet, 2),
      (f) => f.data.setUint8(f.type + O.jumpJetTurn, 1),
      (f) => f.i32(O.type, f.memory.size - 4),
      (f) => f.put(f.type, 0x7e4570),
      (f) => f.i32(O.locomotor, 0),
      (f) => f.i32(O.locomotor, f.locomotor + 1),
      (f) => f.put(f.locomotor, 0x7ece34),
      (f) => f.put(f.locomotor - 4, 0),
      (f) => f.put(0x7ece40, 0),
      (f) => f.i32(O.target, 0),
      (f) => f.i32(O.target, f.target + 1),
      (f) => f.i32(O.target, f.memory.size - 4),
      (f) => f.put(f.target, 0x1234),
      (f) => f.put(0x7f5c70 + 0x48, 0),
      (f) => f.point(f.target, 0x7fffffff, 2560),
      (f) => f.point(f.target, 2816, 2560, 100000),
      (f) => f.float(0x8650b8, 0),
      (f) => f.float(0x8610b4, NaN),
    ];
    for (const change of changes) {
      const f = jumpjet();
      change(f);
      expect(f.read()).toEqual({ infantrySequence: 'FireFly', sequenceFrame: 2 });
    }
  });

  it('isolates a target read exception from the independently valid animation state', () => {
    const f = jumpjet();
    const memory = {
      ...f.memory,
      u32: (at: number) => {
        if (at === f.target) throw new Error('target unavailable');
        return f.memory.u32(at);
      },
    };
    expect(readYrInfantryRenderState(memory, f.pointer)).toEqual({ infantrySequence: 'FireFly', sequenceFrame: 2 });
  });

  it('maps every executable DoType value to its art Sequence key', () => {
    const keys = [
      'Ready',
      'Guard',
      'Prone',
      'Walk',
      'FireUp',
      'Down',
      'Crawl',
      'Up',
      'FireProne',
      'Idle1',
      'Idle2',
      'Die1',
      'Die2',
      'Die3',
      'Die4',
      'Die5',
      'Tread',
      'Swim',
      'WetIdle1',
      'WetIdle2',
      'WetDie1',
      'WetDie2',
      'WetAttack',
      'Hover',
      'Fly',
      'Tumble',
      'FireFly',
      'Deploy',
      'Deployed',
      'DeployedFire',
      'DeployedIdle',
      'Undeploy',
      'Cheer',
      'Paradrop',
      'AirDeathStart',
      'AirDeathFalling',
      'AirDeathFinish',
      'Panic',
      'Shovel',
      'Carry',
      'SecondaryFire',
      'SecondaryProne',
    ];
    expect(YR_INFANTRY_SEQUENCES).toEqual(keys);
    keys.forEach((infantrySequence, sequence) => {
      const f = fixture(sequence, sequence + 5);
      expect(readYrInfantryRenderState(f.memory, f.pointer)).toEqual({
        infantrySequence,
        sequenceFrame: sequence + 5,
      });
    });
  });

  it('preserves the relative step including zero and values requiring art-frame wrapping', () => {
    const f = fixture(8, 0);
    expect(readYrInfantryRenderState(f.memory, f.pointer)).toEqual({
      infantrySequence: 'FireProne',
      sequenceFrame: 0,
    });
    f.i32(O.sequenceFrame, 37);
    expect(readYrInfantryRenderState(f.memory, f.pointer)?.sequenceFrame).toBe(37);
    f.i32(O.sequenceFrame, 0xffff);
    expect(readYrInfantryRenderState(f.memory, f.pointer)?.sequenceFrame).toBe(0xffff);
    f.i32(O.sequenceFrame, 0x10000);
    expect(readYrInfantryRenderState(f.memory, f.pointer)?.sequenceFrame).toBe(0x10000);
    f.i32(O.sequenceFrame, 0x7fffffff);
    expect(readYrInfantryRenderState(f.memory, f.pointer)?.sequenceFrame).toBe(0x7fffffff);
  });

  it('rejects uninitialized and unknown sequences', () => {
    for (const sequence of [-1, -100, 42, 0x7fffffff]) {
      const f = fixture(sequence);
      expect(readYrInfantryRenderState(f.memory, f.pointer)).toBeNull();
    }
  });

  it('keeps the sequence but omits an implausible animation step', () => {
    for (const sequenceFrame of [-1, -0x80000000]) {
      const f = fixture(27, sequenceFrame);
      expect(readYrInfantryRenderState(f.memory, f.pointer)).toEqual({ infantrySequence: 'Deploy' });
    }
  });

  it('omits malformed stage values from a custom accessor without discarding its valid sequence', () => {
    const f = fixture(27, 1);
    for (const sequenceFrame of [0x80000000, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const malformed = {
        ...f.memory,
        i32: (address: number) => (address === f.pointer + O.sequenceFrame ? sequenceFrame : f.memory.i32(address)),
      };
      expect(readYrInfantryRenderState(malformed, f.pointer)).toEqual({ infantrySequence: 'Deploy' });
    }
  });

  it('rejects stale/misaligned/out-of-range pointers and another object kind', () => {
    const f = fixture(3, 5);
    for (const pointer of [0, 0xfffc, f.pointer + 1, f.memory.size - O.sequence, Number.NaN, 1.5]) {
      expect(readYrInfantryRenderState(f.memory, pointer)).toBeNull();
    }
    f.i32(0, 0x7f5c70);
    expect(readYrInfantryRenderState(f.memory, f.pointer)).toBeNull();
  });

  it('contains an accessor read failure without disrupting the parent snapshot', () => {
    const f = fixture();
    const throwing = {
      ...f.memory,
      i32: () => {
        throw new Error('detached memory');
      },
    };
    expect(readYrInfantryRenderState(throwing, f.pointer)).toBeNull();
  });
});
