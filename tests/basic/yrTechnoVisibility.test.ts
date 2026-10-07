import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_TECHNO_VISIBILITY as V,
  YR_TECHNO_VISIBILITY_SIGNATURES,
  readYrTechnoVisual,
  yrTechnoVisibilitySignaturesMatch,
  yrVisualPresentation,
} from '../../src/games/yr/technoVisibility';

const TECHNO = 0xb0_0000;
const TYPE = 0xb1_0000;
const RULES = 0xb2_0000;
const LOCAL = 0xb3_0000;
const ENEMY = 0xb4_0000;
const CELLS = 0xb8_0000;
const CELL = 0xb5_0000;

/** Synthetic guest memory: an enemy submarine at cell (40, 30), the local house (index 2) and its enemy (index 5). */
function memory() {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  const u32 = (at: number, value: number) => view.setUint32(at, value >>> 0, true);
  const i32 = (at: number, value: number) => view.setInt32(at, value, true);
  for (const { address, bytes: code } of YR_TECHNO_VISIBILITY_SIGNATURES) bytes.set(code, address);
  u32(V.rules, RULES);
  i32(RULES + V.rulesCloakingStages, 9);
  u32(V.localHouse, LOCAL);
  i32(LOCAL + V.houseArrayIndex, 2);
  i32(ENEMY + V.houseArrayIndex, 5);
  // The game hides cloaked objects (both globals set, as read in a running skirmish).
  u32(V.cloakHides, 1);
  u32(V.allianceGate, 0xb6_0000);
  u32(TECHNO + V.owner, ENEMY);
  i32(TECHNO + V.location, 40 * 256 + 128);
  i32(TECHNO + V.location + 4, 30 * 256 + 128);
  u32(V.map + V.mapCellItems, CELLS);
  u32(CELLS + ((30 << 9) + 40) * 4, CELL);
  const cloak = (state: number, progress = 0) => {
    i32(TECHNO + V.cloakState, state);
    i32(TECHNO + V.cloakProgress, progress);
  };
  const ally = (house: number, otherIndex: number, on = true) => u32(house + V.houseAllies, on ? 1 << otherIndex : 0);
  const sensors = (houseIndex: number, count: number) =>
    view.setInt16(CELL + V.cellSensors + houseIndex * 2, count, true);
  const read = (kind: Parameters<typeof readYrTechnoVisual>[2] = 'vehicle') =>
    readYrTechnoVisual(createByteViewAccessor(bytes), TECHNO, kind, TYPE);
  return { bytes, u32, i32, cloak, ally, sensors, read };
}

describe('YR techno visibility (cloak)', () => {
  it('draws an uncloaked techno and every building as usual', () => {
    const m = memory();
    expect(m.read()).toBe('normal');
    m.cloak(2);
    expect(m.read('building')).toBe('normal');
  });

  it('hides a cloaked enemy and shows it through its cloak to its owner, an ally or a sensor', () => {
    const m = memory();
    m.cloak(2);
    expect(m.read()).toBe('hidden');
    expect(m.read('infantry')).toBe('hidden');
    expect(m.read('aircraft')).toBe('hidden');
    // The local player's own cloaked unit, or one he has been shown (+0x41A).
    m.bytes[TECHNO + V.visibleToPlayer] = 1;
    expect(m.read()).toBe('shadowy');
    m.bytes[TECHNO + V.visibleToPlayer] = 0;
    // A sensor of the local house (index 2) covers the cell; another house's sensor does not help.
    m.sensors(5, 3);
    expect(m.read()).toBe('hidden');
    m.sensors(2, 1);
    expect(m.read()).toBe('shadowy');
    m.sensors(2, -1);
    expect(m.read()).toBe('hidden');
    // Allied both ways.
    m.ally(LOCAL, 5);
    expect(m.read()).toBe('hidden');
    m.ally(ENEMY, 2);
    expect(m.read()).toBe('shadowy');
    // Without the gate pointer the alliance is not consulted.
    m.u32(V.allianceGate, 0);
    expect(m.read()).toBe('hidden');
    // While the hide switch is off every cloaked techno is merely shadowy; the reveal switch draws it normally.
    m.u32(V.cloakHides, 0);
    expect(m.read()).toBe('shadowy');
    m.bytes[V.revealAll] = 1;
    expect(m.read()).toBe('normal');
  });

  it('fades through the engine stages while cloaking and uncloaking', () => {
    const m = memory();
    // CloakingStages 9: value = trunc(progress / 9 * 256).
    const stage = (progress: number, state = 1) => {
      m.cloak(state, progress);
      return m.read();
    };
    expect(stage(0)).toBe('normal');
    expect([1, 2].map((p) => stage(p))).toEqual(['indistinct', 'indistinct']);
    expect([3, 4].map((p) => stage(p))).toEqual(['darken', 'darken']);
    expect([5, 6].map((p) => stage(p))).toEqual(['shadowy', 'shadowy']);
    // The last stages: an enemy ripples and then vanishes; the owner keeps seeing a shadow.
    expect([7, 8].map((p) => stage(p))).toEqual(['ripple', 'ripple']);
    expect(stage(9)).toBe('hidden');
    expect(stage(9, 3)).toBe('hidden');
    m.bytes[TECHNO + V.visibleToPlayer] = 1;
    expect([7, 8, 9].map((p) => stage(p, 3))).toEqual(['shadowy', 'shadowy', 'shadowy']);
  });

  it('never draws an InvisibleInGame type the player was not shown', () => {
    const m = memory();
    m.bytes[TYPE + V.typeInvisibleInGame] = 1;
    expect(m.read()).toBe('hidden');
    m.bytes[TECHNO + V.visibleToPlayer] = 1;
    expect(m.read()).toBe('normal');
  });

  it('answers nothing on implausible fields', () => {
    const m = memory();
    m.cloak(7);
    expect(m.read()).toBeUndefined();
    m.cloak(1, 5);
    m.i32(RULES + V.rulesCloakingStages, 0);
    expect(m.read()).toBeUndefined();
    m.i32(RULES + V.rulesCloakingStages, 9);
    m.bytes[TECHNO + V.visibleToPlayer] = 9;
    expect(m.read()).toBeUndefined();
    m.bytes[TECHNO + V.visibleToPlayer] = 0;
    m.cloak(2);
    m.u32(V.localHouse, 0x7);
    expect(m.read()).toBeUndefined();
    expect(readYrTechnoVisual(createByteViewAccessor(m.bytes), 0x5, 'vehicle', TYPE)).toBeUndefined();
  });

  it('maps a VisualType to what a renderer does and recognises the pinned build only', () => {
    expect(yrVisualPresentation('normal')).toBeNull();
    expect(yrVisualPresentation('hidden')).toEqual({ hidden: true });
    expect(yrVisualPresentation('indistinct')).toEqual({ opacity: 0.75 });
    for (const visual of ['darken', 'shadowy', 'ripple'] as const)
      expect(yrVisualPresentation(visual)).toEqual({ opacity: 0.5 });
    const m = memory();
    expect(yrTechnoVisibilitySignaturesMatch(createByteViewAccessor(m.bytes))).toBe(true);
    for (const { address } of YR_TECHNO_VISIBILITY_SIGNATURES) {
      m.bytes[address] ^= 0xff;
      expect(yrTechnoVisibilitySignaturesMatch(createByteViewAccessor(m.bytes))).toBe(false);
      m.bytes[address] ^= 0xff;
    }
  });
});
