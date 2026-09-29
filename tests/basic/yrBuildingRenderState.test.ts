import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import { readYrBuildingRenderState, YR_BUILDING_RENDER_OFFSETS as O } from '../../src/games/yr/buildingRenderState';

function makeMemory() {
  const bytes = new Uint8Array(0x50000);
  const view = new DataView(bytes.buffer);
  const building = 0x10000;
  const type = 0x20000;
  const i32 = (at: number, value: number) => view.setInt32(at, value, true);
  const u8 = (at: number, value: number) => view.setUint8(at, value);
  i32(building, 0x7e3ebc);
  i32(type, 0x7e4570);
  i32(building + O.type, type);
  i32(building + O.state, 0);
  i32(building + O.queuedState, -1);
  i32(building + O.currentMission, 18);
  i32(building + O.queuedMission, -1);
  i32(type + O.makeCount, 20);
  u8(building + O.hasBuildup, 1);
  const memory = createByteViewAccessor(bytes);
  return { bytes, memory, building, type, i32, u8, read: () => readYrBuildingRenderState(memory, building) };
}

describe('YR 1.001 building render state', () => {
  it('reads current construction and its actual zero/last make SHP frame', () => {
    const m = makeMemory();
    expect(m.read()).toEqual({ buildState: 'building', buildupFrame: 0 });
    m.i32(m.building + O.stage, 19);
    expect(m.read()).toEqual({ buildState: 'building', buildupFrame: 19 });
  });

  it('reverses the increasing raw stage exactly once while selling', () => {
    const m = makeMemory();
    m.i32(m.building + O.currentMission, 19);
    for (const stage of [0, 3, 19]) {
      m.i32(m.building + O.stage, stage);
      expect(m.read()).toEqual({ buildState: 'selling', buildupFrame: 19 - stage });
    }
  });

  it('uses queued mission only when current mission is None', () => {
    const m = makeMemory();
    m.i32(m.building + O.queuedMission, 19);
    expect(m.read()!.buildState).toBe('building');
    m.i32(m.building + O.currentMission, -1);
    expect(m.read()).toEqual({ buildState: 'selling', buildupFrame: 19 });
    m.i32(m.building + O.currentMission, 19);
    m.i32(m.building + O.queuedMission, 18);
    expect(m.read()!.buildState).toBe('selling');
  });

  it('treats nonconstruction current modes as done and never draws a queued construction', () => {
    const m = makeMemory();
    m.i32(m.building + O.queuedState, 0);
    for (const state of [1, 2, 3, 4, 5]) {
      m.i32(m.building + O.state, state);
      expect(m.read()).toEqual({ buildState: 'done' });
    }
  });

  it('matches the gate reversal followed by the independent selling reversal', () => {
    const m = makeMemory();
    m.u8(m.type + O.gate, 1);
    m.i32(m.building + O.stage, 4);
    expect(m.read()).toEqual({ buildState: 'building', buildupFrame: 15 });
    m.i32(m.building + O.currentMission, 19);
    expect(m.read()).toEqual({ buildState: 'selling', buildupFrame: 4 });
  });

  it('omits unavailable or torn make state rather than guessing completion', () => {
    const initializing = makeMemory();
    initializing.i32(initializing.building + O.state, -1);
    initializing.i32(initializing.building + O.queuedState, 0);
    initializing.u8(initializing.building + O.hasBuildup, 0);
    expect(initializing.read()).toBeNull();
    for (const [offset, value] of [
      [O.state, -2],
      [O.state, 6],
      [O.queuedState, 6],
      [O.currentMission, -2],
      [O.currentMission, 32],
      [O.queuedMission, 32],
      [O.stage, -1],
      [O.stage, 20],
    ]) {
      const m = makeMemory();
      m.i32(m.building + offset!, value!);
      expect(m.read()).toBeNull();
    }
    for (const value of [0, 2, 255]) {
      const m = makeMemory();
      m.u8(m.building + O.hasBuildup, value);
      expect(m.read()).toBeNull();
    }
    for (const [offset, value] of [
      [O.makeStart, 1],
      [O.makeCount, 0],
      [O.makeCount, -1],
      [O.makeCount, 0x8000],
    ]) {
      const m = makeMemory();
      m.i32(m.type + offset!, value!);
      expect(m.read()).toBeNull();
    }
    for (const offset of [O.gate, O.laserFence, O.firestormWall]) {
      const m = makeMemory();
      m.u8(m.type + offset, offset === O.gate ? 2 : 1);
      expect(m.read()).toBeNull();
    }
  });

  it('validates object/type pointers, spans and vtables, and contains failed accessors', () => {
    const m = makeMemory();
    for (const pointer of [0, 0xffff, m.building + 1, m.bytes.length - O.hasBuildup, NaN])
      expect(readYrBuildingRenderState(m.memory, pointer)).toBeNull();
    for (const pointer of [0, m.type + 1, m.bytes.length - O.firestormWall]) {
      m.i32(m.building + O.type, pointer);
      expect(m.read()).toBeNull();
    }
    m.i32(m.building + O.type, m.type);
    m.i32(m.type, 0x7eb610);
    expect(m.read()).toBeNull();
    m.i32(m.type, 0x7e4570);
    m.i32(m.building, 0x7eb058);
    expect(m.read()).toBeNull();
    expect(
      readYrBuildingRenderState(
        {
          ...m.memory,
          u32: () => {
            throw new Error('unavailable');
          },
        },
        m.building,
      ),
    ).toBeNull();
  });

  it('does not publish malformed animation values supplied by an unavailable accessor', () => {
    const m = makeMemory();
    for (const offset of [O.makeCount, O.stage]) {
      const address = (offset === O.stage ? m.building : m.type) + offset;
      for (const value of [NaN, Infinity, 1.5]) {
        const memory = { ...m.memory, i32: (at: number) => (at === address ? value : m.memory.i32(at)) };
        expect(readYrBuildingRenderState(memory, m.building)).toBeNull();
      }
    }
  });
});
