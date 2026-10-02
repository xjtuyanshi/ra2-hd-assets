import { describe, expect, it } from 'vitest';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../../src/games/shared/memoryAccessor';
import { createYrRenderStateReaderFrom } from '../../src/games/yr/renderState';
import {
  decodeYrSceneLighting,
  readYrSceneLighting,
  YR_SCENE_LIGHTING as L,
  type YrSceneLightingStatics,
} from '../../src/games/yr/sceneLighting';
import { readYrState, YR_STATE_GLOBALS as G } from '../../src/games/yr/stateReader';

// Numeric facts from the XMP29U2 live sample: Scenario+0x3528..0x3590. No original game asset is required.
const stormWords = [
  100, 87, 87, 100, 80, 68, 0, 0, 87, 30, 40, 75, 0, 0, 200, 175, 150, 125, 100, 100, 1, 150, 85, 20, 30, 0, 0,
];
const noEvents: YrSceneLightingStatics = {
  stormActive: 0,
  stormEnding: 0,
  stormDeferment: 0,
  stormCellX: 60,
  stormCellY: 91,
  nukeState: 0,
  dominatorState: 0,
  timewarpState: 0,
};

function wordsAt(fields: Record<number, number> = {}) {
  const words = [...stormWords];
  for (const [offset, value] of Object.entries(fields)) words[(Number(offset) - L.wordsStart) / 4] = value;
  return words;
}

function fixture() {
  const bytes = new Uint8Array(0x1000000);
  const view = new DataView(bytes.buffer);
  const scenario = 0xb00000;
  view.setUint32(G.scenario, scenario, true);
  stormWords.forEach((value, index) => view.setInt32(scenario + L.wordsStart + index * 4, value, true));
  view.setUint8(L.stormActive, 1);
  view.setInt16(L.stormCell, 60, true);
  view.setInt16(L.stormCell + 2, 91, true);
  return { bytes, view, scenario, memory: createByteViewAccessor(bytes) };
}

describe('YR scene lighting words and separate event priorities', () => {
  it('reads the measured storm current ambient and raw Ion colour, retaining normal tint', () => {
    const result = decodeYrSceneLighting(stormWords, { ...noEvents, stormActive: 1 });
    expect(result).toEqual({
      ambient: 0.87,
      ground: 0,
      level: 0,
      tint: [1, 0.8, 0.68],
      override: [0.3, 0.4, 0.75],
      event: 'storm',
      storm: { active: true, pending: false, ending: false, cell: { x: 60, y: 91 } },
    });
    const transition = wordsAt({ 0x352c: 90, 0x3530: 87 });
    expect(decodeYrSceneLighting(transition, { ...noEvents, stormActive: 1 })?.ambient).toBe(0.9);
  });

  it('does not activate pending storms, and follows the supplied ambient on return to normal', () => {
    const result = decodeYrSceneLighting(wordsAt({ 0x352c: 100 }), { ...noEvents, stormDeferment: 30 });
    expect(result).toMatchObject({ ambient: 1, event: null, override: null, storm: { active: false, pending: true } });
    expect(decodeYrSceneLighting(stormWords, noEvents)).toMatchObject({ ambient: 0.87, event: null, override: null });
    expect(decodeYrSceneLighting(stormWords, { ...noEvents, stormActive: 1, stormEnding: 1 })).toMatchObject({
      event: 'storm',
      storm: { active: true, ending: true },
    });
  });

  it('uses Nuke RGB only in flash state, while recovery retains live ambient and normal height terms', () => {
    const words = wordsAt({ 0x352c: 170, 0x3540: 50, 0x3544: 8 });
    expect(decodeYrSceneLighting(words, { ...noEvents, nukeState: 1 })).toMatchObject({
      ambient: 1.7,
      override: [1.75, 1.5, 1.25],
      event: 'nuke',
      ground: 0.1,
      level: 0.1,
    });
    expect(decodeYrSceneLighting(words, { ...noEvents, nukeState: 2 })).toMatchObject({
      ambient: 1.7,
      override: null,
      event: null,
      ground: 0.05,
      level: 0.008,
    });
  });

  it.each([1, 2, 3, 4])('uses Dominator RGB in state %i', (dominatorState) => {
    expect(decodeYrSceneLighting(stormWords, { ...noEvents, dominatorState })).toMatchObject({
      override: [0.85, 0.2, 0.3],
      event: 'dominator',
    });
  });

  it('keeps Dominator ground/level in state 5 after its palette has been restored', () => {
    const words = wordsAt({ 0x358c: 75, 0x3590: 12 });
    expect(decodeYrSceneLighting(words, { ...noEvents, dominatorState: 5 })).toMatchObject({
      override: null,
      event: null,
      ground: 0.075,
      level: 0.012,
    });
  });

  it('selects palette nuke/timewarp > storm > dominator but ground/level storm > dominator > nuke', () => {
    const words = wordsAt({ 0x3558: 20, 0x355c: 3, 0x358c: 75, 0x3590: 12 });
    expect(decodeYrSceneLighting(words, { ...noEvents, stormActive: 1, dominatorState: 2 })).toMatchObject({
      override: [0.3, 0.4, 0.75],
      event: 'storm',
      ground: 0.02,
      level: 0.003,
    });
    expect(
      decodeYrSceneLighting(words, { ...noEvents, stormActive: 1, nukeState: 1, dominatorState: 2 }),
    ).toMatchObject({
      override: [1.75, 1.5, 1.25],
      event: 'nuke',
      ground: 0.02,
      level: 0.003,
    });
    expect(decodeYrSceneLighting(words, { ...noEvents, nukeState: 1, dominatorState: 5 })).toMatchObject({
      event: 'nuke',
      ground: 0.075,
      level: 0.012,
    });
    expect(decodeYrSceneLighting(words, { ...noEvents, stormActive: 1, timewarpState: 1 })).toMatchObject({
      override: [1.75, 1.5, 1.25],
      event: 'timewarp',
      ground: 0.02,
      level: 0.003,
    });
    expect(decodeYrSceneLighting(wordsAt({ 0x3540: 50, 0x3544: 8 }), { ...noEvents, timewarpState: 1 })).toMatchObject({
      event: 'timewarp',
      ground: 0.05,
      level: 0.008,
    });
  });

  it('rejects incomplete/implausible values without converting unknown into zero', () => {
    expect(decodeYrSceneLighting([], noEvents)).toBeNull();
    for (const value of [NaN, Infinity, 1.5, -1, 0xdeadbeef])
      expect(decodeYrSceneLighting(wordsAt({ 0x352c: value }), noEvents)).toBeNull();
    for (const state of [
      { stormActive: 2 },
      { stormEnding: 2 },
      { nukeState: 3 },
      { dominatorState: 6 },
      { stormActive: 1, stormCellX: 30000 },
      { stormDeferment: 1, stormCellY: -30000 },
    ])
      expect(decodeYrSceneLighting(stormWords, { ...noEvents, ...state })).toBeNull();
    expect(decodeYrSceneLighting(wordsAt({ 0x352c: 0 }), noEvents)?.ambient).toBe(0);
    expect(decodeYrSceneLighting(stormWords, { ...noEvents, stormCellX: -32768 })).not.toBeNull();
  });
});

describe('YR scene lighting memory reader and publication', () => {
  it('reads complete little-endian spans without changing guest memory', () => {
    const f = fixture();
    const before = f.bytes.slice();
    expect(readYrSceneLighting(f.memory)).toEqual(decodeYrSceneLighting(stormWords, { ...noEvents, stormActive: 1 }));
    expect(f.bytes.every((value, index) => value === before[index])).toBe(true);
  });

  it('rejects missing, unaligned and out-of-range pointers and failed/short reads', () => {
    const f = fixture();
    for (const pointer of [0, 4, 0xb00001, 0xffffff, 0xffffffff]) {
      f.view.setUint32(G.scenario, pointer, true);
      expect(readYrSceneLighting(f.memory)).toBeNull();
    }
    f.view.setUint32(G.scenario, f.scenario, true);
    for (const at of [G.scenario, f.scenario + L.wordsStart, L.timewarpState, L.stormCell]) {
      const memory: GuestMemoryAccessor = {
        ...f.memory,
        bytes: (address, length) => (address === at ? new Uint8Array(0) : f.memory.bytes(address, length)),
      };
      expect(readYrSceneLighting(memory)).toBeNull();
    }
    expect(readYrSceneLighting({ ...f.memory, size: G.scenario })).toBeNull();
    expect(
      readYrSceneLighting({
        ...f.memory,
        bytes: () => {
          throw new Error('unavailable');
        },
      }),
    ).toBeNull();
  });

  it('publishes same-frame changes and transitions to/from unavailable without mutating older snapshots', () => {
    const f = fixture();
    let failed = false;
    const memory: GuestMemoryAccessor = {
      ...f.memory,
      bytes: (address, length) =>
        failed && address === L.timewarpState ? new Uint8Array(0) : f.memory.bytes(address, length),
    };
    const read = createYrRenderStateReaderFrom({
      memory: () => memory,
      readState: () => readYrState(memory),
      createShroudReader: () => null,
      createEffectsReader: () => null,
      createOverlayReader: () => null,
      createSmudgeReader: () => null,
      now: () => 0,
    });
    const storm = read()!;
    expect(storm.lighting?.event).toBe('storm');
    expect(read()).toBe(storm);
    f.view.setUint8(L.stormActive, 0);
    f.view.setInt32(f.scenario + 0x352c, 100, true);
    const clear = read()!;
    expect(clear).not.toBe(storm);
    expect(clear.frame).toBe(storm.frame);
    expect(clear.lighting).toMatchObject({ ambient: 1, override: null, event: null });
    expect(storm.lighting).toMatchObject({ ambient: 0.87, event: 'storm' });
    failed = true;
    expect(read()!.lighting).toBeNull();
    failed = false;
    expect(read()!.lighting).toEqual(clear.lighting);
    f.view.setUint32(G.scenario, 0, true);
    expect(read()!.lighting).toBeNull();
  });
});
