import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  readYrBuildingRenderState,
  YR_BUILDING_RENDER_OFFSETS as O,
  YR_BUILDING_RULES as R,
} from '../../src/games/yr/buildingRenderState';

function makeMemory(size = 0x50000) {
  const bytes = new Uint8Array(size);
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

describe('YR native completed-building art', () => {
  function body() {
    const m = makeMemory(0x900000);
    const rules = 0x30000;
    const data = new DataView(m.bytes.buffer);
    m.i32(R.instance, rules);
    data.setFloat64(rules + R.yellow, 0.5, true);
    data.setFloat64(rules + R.red, 0.25, true);
    m.i32(m.building + O.state, 1);
    m.i32(m.type + O.strength, 1000);
    m.i32(m.type + O.techLevel, -1);
    return { ...m, rules, data };
  }

  it('keeps civilian bodies intact at 49.6% and 47.5%, independently of yellow damage layers', () => {
    const m = body();
    m.u8(m.type + O.canBeOccupied, 1);
    for (const hp of [496, 475, 251]) {
      m.i32(m.building + O.health, hp);
      expect(m.read()).toEqual({ buildState: 'done', buildingFrame: 0, buildingDamaged: true });
    }
    for (const hp of [250, 249, 0]) {
      m.i32(m.building + O.health, hp);
      expect(m.read()?.buildingFrame).toBe(1);
    }
  });

  it('uses integer HP/Strength as a real ratio and honors loaded scenario rules', () => {
    const m = body();
    m.i32(m.type + O.strength, 101);
    m.i32(m.building + O.health, 51);
    expect(m.read()?.buildingFrame).toBe(0);
    m.i32(m.building + O.health, 50);
    expect(m.read()?.buildingFrame).toBe(1);
    m.data.setFloat64(m.rules + R.yellow, 0.4, true);
    expect(m.read()?.buildingFrame).toBe(0);
    m.u8(m.type + O.canBeOccupied, 1);
    m.data.setFloat64(m.rules + R.red, 0.6, true);
    expect(m.read()).toMatchObject({ buildingFrame: 1, buildingDamaged: false });
  });

  it('selects occupancy variants and the TechLevel branch, including the civilian frame-3 remap', () => {
    const m = body();
    m.u8(m.type + O.canBeOccupied, 1);
    m.i32(m.building + O.occupants, 3);
    m.i32(m.building + O.health, 475);
    expect(m.read()?.buildingFrame).toBe(2);
    m.i32(m.type + O.techLevel, 1);
    expect(m.read()?.buildingFrame).toBe(3);
    m.i32(m.type + O.techLevel, 0);
    expect(m.read()?.buildingFrame).toBe(2);
    m.i32(m.building + O.health, 250);
    expect(m.read()?.buildingFrame).toBe(3);
    m.i32(m.type + O.techLevel, -1);
    expect(m.read()?.buildingFrame).toBe(1);
  });

  it('keeps gate and active-mode frame offsets separate from ordinary idle bodies', () => {
    const m = body();
    m.i32(m.building + O.health, 500);
    m.u8(m.type + O.gate, 1);
    m.i32(m.type + O.gateStages, 9);
    expect(m.read()?.buildingFrame).toBe(10);
    m.u8(m.type + O.gate, 0);
    m.i32(m.building + O.state, 2);
    m.i32(m.building + O.stage, 3);
    m.i32(m.type + O.modes + 4 * 12, 12);
    m.i32(m.type + O.modes + 4 * 12 + 4, 8);
    expect(m.read()?.buildingFrame).toBe(23);
    m.i32(m.building + O.health, 501);
    expect(m.read()?.buildingFrame).toBe(3);
  });

  it('omits unvalidated body state without losing known construction completion', () => {
    const m = body();
    m.data.setFloat64(m.rules + R.red, NaN, true);
    expect(m.read()).toEqual({ buildState: 'done' });
    m.data.setFloat64(m.rules + R.red, 0.25, true);
    m.i32(m.type + O.strength, 0);
    expect(m.read()).toEqual({ buildState: 'done' });
    m.i32(R.instance, m.bytes.length - 4);
    expect(m.read()).toEqual({ buildState: 'done' });
  });
});
