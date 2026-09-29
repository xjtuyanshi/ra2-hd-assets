import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_INFANTRY_RENDER_OFFSETS as O,
  YR_INFANTRY_SEQUENCES,
  readYrInfantryRenderState,
} from '../../src/games/yr/infantryRenderState';

function fixture(sequence = 0, sequenceFrame = 0) {
  const bytes = new Uint8Array(0x20000);
  const data = new DataView(bytes.buffer);
  const pointer = 0x10000;
  const i32 = (offset: number, value: number) => data.setInt32(pointer + offset, value, true);
  i32(0, 0x7eb058);
  i32(O.sequence, sequence);
  i32(O.sequenceFrame, sequenceFrame);
  return { memory: createByteViewAccessor(bytes), pointer, i32 };
}

describe('YR H2 infantry animation state', () => {
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
