import { describe, expect, it } from 'vitest';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../../src/games/shared/memoryAccessor';
import { createYrRenderStateReaderFrom } from '../../src/games/yr/renderState';
import {
  decodeYrSceneLighting,
  readYrLightSources,
  readYrSceneLighting,
  YR_LIGHT_SOURCES as S,
  YR_SCENE_LIGHTING as L,
  type YrSceneLightingStatics,
} from '../../src/games/yr/sceneLighting';
import { readYrState, YR_STATE_GLOBALS as G } from '../../src/games/yr/stateReader';

/**
 * A reader clock on which every poll comes a second after the one before: past the shroud cadence and past the
 * one-look-per-logic-frame bound, so a case that changes something inside one logic frame tests the change key.
 */
const farApart = () => {
  let at = 0;
  return () => (at += 1000);
};

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
    // The fixture's light vector is empty: a readable scene without local lights, not an unknown one.
    expect(readYrSceneLighting(f.memory)).toEqual({
      ...decodeYrSceneLighting(stormWords, { ...noEvents, stormActive: 1 }),
      sources: [],
    });
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
      now: farApart(),
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

describe('YR light sources (LightSourceClass vector)', () => {
  const items = 0xc00000;
  /** Write one LightSourceClass at `at`: per-mille intensity and tint, lepton position and reach. */
  function light(
    view: DataView,
    at: number,
    values: { intensity: number; tint: [number, number, number]; position: [number, number, number]; radius: number },
    activated = 1,
    detail = 2,
  ) {
    view.setUint32(at, S.vtable, true);
    view.setInt32(at + S.intensity, values.intensity, true);
    values.tint.forEach((channel, i) => view.setInt32(at + S.tint + i * 4, channel, true));
    view.setInt32(at + S.detail, detail, true);
    values.position.forEach((value, i) => view.setInt32(at + S.position + i * 4, value, true));
    view.setInt32(at + S.radius, values.radius, true);
    view.setUint8(at + S.activated, activated);
  }
  function vector(lights: number[]) {
    const f = fixture();
    f.view.setUint32(S.items, items, true);
    f.view.setInt32(S.count, lights.length, true);
    f.view.setInt32(S.detailLevel, 2, true);
    lights.forEach((pointer, i) => f.view.setUint32(items + i * 4, pointer, true));
    return f;
  }
  // INGALITE as the rules give it, and a NEGLAMP-style darkening light.
  const lamp = {
    intensity: 500,
    tint: [50, 50, 10] as [number, number, number],
    position: [15232, 17536, 208] as [number, number, number],
    radius: 4000,
  };
  const negative = {
    intensity: -150,
    tint: [0, 0, 0] as [number, number, number],
    position: [2688, 2688, 0] as [number, number, number],
    radius: 1500,
  };

  it('reads active lights in engine units and leaves out what the cell relight leaves out', () => {
    const f = vector([0xc10000, 0xc10100, 0xc10200, 0xc10300]);
    light(f.view, 0xc10000, lamp);
    light(f.view, 0xc10100, negative);
    light(f.view, 0xc10200, lamp, 0); // switched off (0x484294)
    light(f.view, 0xc10300, lamp, 1, 3); // above the detail setting (0x4842AA)
    const before = f.bytes.slice();
    expect(readYrLightSources(f.memory)).toEqual([
      { x: 15232, y: 17536, z: 208, radius: 4000, intensity: 0.5, tint: [0.05, 0.05, 0.01] },
      { x: 2688, y: 2688, z: 0, radius: 1500, intensity: -0.15, tint: [0, 0, 0] },
    ]);
    expect(f.bytes.every((value, index) => value === before[index])).toBe(true);
    // A lower detail setting gates every light (their DetailLevel is 2); a supplied level replaces the global's.
    expect(readYrLightSources(f.memory, 1)).toEqual([]);
    f.view.setInt32(S.detailLevel, 0, true);
    expect(readYrLightSources(f.memory)).toEqual([]);
    expect(readYrLightSources(f.memory, 2)).toHaveLength(2);
    // The scene read carries the list.
    expect(readYrSceneLighting(f.memory, 2)?.sources).toHaveLength(2);
  });

  it('keeps a type without tint keys at the constructor value', () => {
    const f = vector([0xc10000]);
    light(f.view, 0xc10000, { ...lamp, tint: [1000000, 1000000, 1000000] });
    expect(readYrLightSources(f.memory)![0]!.tint).toEqual([1000, 1000, 1000]);
  });

  it('reports unknown, never an empty scene, for implausible vectors', () => {
    const empty = vector([]);
    expect(readYrLightSources(empty.memory)).toEqual([]);
    for (const count of [-1, S.maxCount + 1]) {
      const f = vector([0xc10000]);
      light(f.view, 0xc10000, lamp);
      f.view.setInt32(S.count, count, true);
      expect(readYrLightSources(f.memory)).toBeUndefined();
    }
    for (const pointer of [0, 2, 0xffffff, 0xfffffffc]) {
      const f = vector([pointer]);
      expect(readYrLightSources(f.memory)).toBeUndefined();
    }
    const wrongClass = vector([0xc10000]);
    light(wrongClass.view, 0xc10000, lamp);
    wrongClass.view.setUint32(0xc10000, 0x7e3ebc, true);
    expect(readYrLightSources(wrongClass.memory)).toBeUndefined();
    const badItems = vector([0xc10000]);
    light(badItems.view, 0xc10000, lamp);
    badItems.view.setUint32(S.items, 3, true);
    expect(readYrLightSources(badItems.memory)).toBeUndefined();
    for (const corrupt of [
      (view: DataView) => view.setUint8(0xc10000 + S.activated, 2),
      (view: DataView) => view.setInt32(0xc10000 + S.intensity, 0x7fffffff, true),
      (view: DataView) => view.setInt32(0xc10000 + S.radius, 0x7fffffff, true),
      (view: DataView) => view.setInt32(0xc10000 + S.detail, 9, true),
    ]) {
      const f = vector([0xc10000]);
      light(f.view, 0xc10000, lamp);
      corrupt(f.view);
      expect(readYrLightSources(f.memory)).toBeUndefined();
    }
    const detail = vector([0xc10000]);
    light(detail.view, 0xc10000, lamp);
    detail.view.setInt32(S.detailLevel, 77, true);
    expect(readYrLightSources(detail.memory)).toBeUndefined();
    // An unreadable vector leaves the scene values valid and its sources unknown.
    const scene = readYrSceneLighting(detail.memory);
    expect(scene).not.toBeNull();
    expect(scene).not.toHaveProperty('sources');
    const short: GuestMemoryAccessor = {
      ...empty.memory,
      bytes: (address, length) => (address === S.items ? new Uint8Array(0) : empty.memory.bytes(address, length)),
    };
    expect(readYrLightSources(short)).toBeUndefined();
  });

  it('publishes a new snapshot when a light appears within the same logic frame', () => {
    const f = vector([]);
    const read = createYrRenderStateReaderFrom({
      memory: () => f.memory,
      readState: () => readYrState(f.memory),
      createShroudReader: () => null,
      createEffectsReader: () => null,
      createOverlayReader: () => null,
      createSmudgeReader: () => null,
      now: farApart(),
    });
    const dark = read()!;
    expect(dark.lighting?.sources).toEqual([]);
    expect(read()).toBe(dark);
    light(f.view, 0xc10000, lamp);
    f.view.setUint32(items, 0xc10000, true);
    f.view.setInt32(S.count, 1, true);
    const lit = read()!;
    expect(lit).not.toBe(dark);
    expect(lit.frame).toBe(dark.frame);
    expect(lit.lighting?.sources).toEqual([
      { x: 15232, y: 17536, z: 208, radius: 4000, intensity: 0.5, tint: [0.05, 0.05, 0.01] },
    ]);
    expect(dark.lighting?.sources).toEqual([]);
  });
});
