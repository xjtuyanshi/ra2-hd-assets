import type { GameRenderSidebar } from '../../src/games/renderState';
import { describe, expect, it, vi } from 'vitest';
import { GAME_RENDER_SHROUD } from '../../src/games/renderState';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import type { ReadYrEffectsOptions, YrEffects } from '../../src/games/yr/effectsReader';
import { readYrEffects, YR_EFFECTS_GLOBALS as E } from '../../src/games/yr/effectsReader';
import {
  YR_CAPTURE_MANAGER_VTABLE,
  YR_MIND_CONTROL_HOUSE_VTABLE,
  YR_MIND_CONTROL_GLOBALS as MC,
  YR_MIND_CONTROL_OFFSETS as MO,
} from '../../src/games/yr/mindControlLinkReader';
import { YR_BEAMS_GLOBALS as B, YR_BEAMS_OFFSETS as BO } from '../../src/games/yr/beamsReader';
import { YR_BUILDING_RENDER_OFFSETS as BR, YR_BUILDING_RULES as R } from '../../src/games/yr/buildingRenderState';
import { YR_BUILDING_ACTIVE_ANIM as A, YR_NATIVE_DETAIL as D } from '../../src/games/yr/buildingActiveAnim';
import type { ReadYrSmudgeOptions, YrSmudges } from '../../src/games/yr/smudgeReader';
import type { ReadYrOverlayOptions, YrOverlays } from '../../src/games/yr/overlayReader';
import {
  createYrRenderStateReader,
  createYrRenderStateReaderFrom,
  YR_SAME_FRAME_REREAD_MS,
  YR_SHROUD_POLL_MS,
} from '../../src/games/yr/renderState';
import { YR_RUNTIME_HOOKS } from '../../src/games/yr/runtimeHooks';
import { YR_SHROUD_STATE, type ReadYrShroudOptions, type YrShroud } from '../../src/games/yr/shroudReader';
import {
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS,
  YR_STATE_OFFSETS as O,
  YR_STATE_VTABLES as V,
  type YrState,
} from '../../src/games/yr/stateReader';
import { createGuestMemory } from '../helpers/guestMemory';

/**
 * A reader clock on which every poll comes a second after the one before: past the shroud cadence and past the
 * one-look-per-logic-frame bound, so a case that changes something inside one logic frame tests the change key.
 */
const farApart = () => {
  let at = 0;
  return () => (at += 1000);
};

/**
 * Memory for the change key's globals and mutable native render fields. The readers themselves are injected,
 * so no YR image or original game art is needed.
 */
function keyMemory() {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  const u32 = (address: number, value: number) => view.setUint32(address, value >>> 0, true);
  const technos = [0xb0_0000, 0xb0_1000];
  const items = 0xb1_0000;
  technos.forEach((pointer, index) => u32(items + index * 4, pointer));
  u32(G.technos + 4, items);
  u32(G.technos + 0x10, technos.length);
  const tactical = 0xb2_0000;
  u32(G.tactical, tactical);
  u32(G.scenario, 0xb3_0000);
  view.setInt32(G.frame, 100, true);
  return {
    bytes,
    u32,
    technos,
    frame: (value: number) => view.setInt32(G.frame, value, true),
    scroll: (x: number, y: number) => {
      view.setInt32(tactical + O.tacticalPos, x, true);
      view.setInt32(tactical + O.tacticalPos + 4, y, true);
    },
    select: (pointer: number, selected: boolean) => view.setUint8(pointer + O.isSelected, selected ? 1 : 0),
    corruptTechnos: () => u32(G.technos + 0x10, 4 * YR_STATE_LIMITS.objectsPerKind + 1),
    layer: (layer: number, pointers: number[]) => {
      const base = G.renderLayers + layer * 0x18;
      const at = 0xb4_0000 + layer * 0x1000;
      pointers.forEach((pointer, index) => u32(at + index * 4, pointer));
      u32(base + 4, at);
      u32(base + 0x10, pointers.length);
    },
  };
}

function yrState(frame: number, map = true): YrState {
  return {
    frame,
    map: map
      ? {
          fileName: 'XMP29U2.MAP',
          theater: 'urban',
          width: 60,
          height: 60,
          size: null,
          localSize: null,
        }
      : null,
    houses: [
      {
        index: 0,
        country: 'Americans',
        name: 'Commander',
        plainName: '<human player>',
        colorIndex: 3,
        isHuman: true,
        isLocal: true,
        defeated: false,
        startingPoint: 0,
      },
    ],
    localHouse: 0,
    view: { x: 12, y: 34 },
    objects: [
      {
        id: 0xb0_0000,
        uid: 11,
        kind: 'vehicle',
        type: 'MTNK',
        owner: 0,
        x: 256,
        y: 512,
        z: 0,
        facing: 64,
        facingRaw: 0x4000,
        turretFacing: 192,
        turretFacingRaw: 0xc000,
        health: 0.75,
        isSelected: true,
      },
      {
        id: 0xb0_1000,
        uid: 12,
        kind: 'infantry',
        type: 'E1',
        owner: 0,
        x: 1000,
        y: 2000,
        z: 104,
        facing: 0,
        facingRaw: 0,
        health: 1,
        isSelected: false,
      },
    ],
    stats: {
      vectors: { building: 0, vehicle: 1, infantry: 1, aircraft: 0 },
      limbo: { building: 0, vehicle: 0, infantry: 0, aircraft: 0 },
      invalid: { building: 0, vehicle: 0, infantry: 0, aircraft: 0 },
    },
  };
}

function yrEffects(frame: number): YrEffects {
  const point = { x: 1, y: 2, z: 3 };
  const per = <T>(value: T) => ({
    anims: value,
    voxelAnims: value,
    bullets: value,
    particleSystems: value,
    lasers: value,
    electricBolts: value,
  });
  return {
    frame,
    anims: [
      {
        id: 1,
        uid: 2,
        type: 'TWLT070',
        x: 10,
        y: 20,
        z: 30,
        frame: 4,
        stage: 4,
        frameCount: 20,
        loopStart: 0,
        loopEnd: 20,
        loopsLeft: 1,
        rate: 1,
        attachedTo: null,
        owner: 0,
        layer: 'ground',
        flat: false,
        translucent: false,
        translucency: 0,
        buildingAnim: false,
        invisible: false,
        paused: false,
      },
    ],
    voxelAnims: [],
    bullets: [
      {
        id: 3,
        uid: 4,
        type: 'Cannon',
        weapon: '105mm',
        warhead: 'AP',
        x: 5,
        y: 6,
        z: 7,
        source: point,
        target: point,
        velocity: point,
        firer: null,
        owner: 0,
        inviso: false,
        arcing: false,
        firersPalette: false,
        frame: 0,
      },
    ],
    lasers: [
      {
        id: 5,
        source: point,
        target: point,
        innerColor: [255, 0, 0],
        outerColor: [0, 0, 0],
        outerSpread: [0, 0, 0],
        thickness: 3,
        houseColor: false,
        duration: 15,
        progress: 1,
        fades: true,
        blinks: false,
      },
    ],
    electricBolts: [
      {
        id: 6,
        source: point,
        target: point,
        firer: null,
        weaponSlot: 0,
        lifetime: 0x10000,
        alternateColor: true,
      },
    ],
    particleSystems: [
      {
        id: 7,
        uid: 8,
        type: 'SmokeSys',
        behavesLike: 'smoke',
        x: 1,
        y: 1,
        z: 1,
        target: point,
        attachedTo: null,
        owner: -1,
        particleCount: 4,
        lifetime: -1,
      },
    ],
    fires: [{ id: 9, uid: 10, kind: 'vehicle', frame, target: null, targetPosition: null }],
    stats: { ...per(0), vectors: per(1), invalid: per(0), limbo: per(0), unresolved: 0, technos: 5 },
  } as YrEffects;
}

/** Shroud reader double: fills `reuse` in place like the real reader, with cells from `cells`. */
function shroudReader(cells: () => number[]) {
  return vi.fn((options?: ReadYrShroudOptions): YrShroud => {
    const values = cells();
    const reuse = options?.reuse;
    const target = reuse && reuse.cells.length === values.length ? reuse.cells : new Uint8Array(values.length);
    target.set(values);
    return {
      frame: 0,
      originX: 1,
      originY: 2,
      width: 2,
      height: 2,
      cells: target,
      edges: reuse?.edges ?? new Uint8Array(4),
      fogEdges: null,
      fogOfWar: false,
      counts: { shrouded: 0, fogged: 0, visible: 0, none: 0, invalid: 0 },
    };
  });
}

function sources(
  memory: ReturnType<typeof keyMemory>,
  options: {
    map?: () => boolean;
    cells?: () => number[];
    overlays?: (options?: ReadYrOverlayOptions) => YrOverlays | null;
    smudges?: (options?: ReadYrSmudgeOptions) => YrSmudges | null;
    now?: () => number;
    sidebar?: () => GameRenderSidebar | null;
  } = {},
) {
  let frame = 0;
  const readState = vi.fn(() => yrState(++frame, options.map?.() ?? true));
  const readShroud = shroudReader(options.cells ?? (() => [0, 1, 2, 0xff]));
  const readEffects = vi.fn((_options?: ReadYrEffectsOptions) => yrEffects(frame));
  const createShroudReader = vi.fn((): typeof readShroud | null => readShroud);
  const createEffectsReader = vi.fn(() => readEffects);
  const readOverlays = vi.fn((reuse?: ReadYrOverlayOptions) => options.overlays?.(reuse) ?? null);
  const createOverlayReader = vi.fn((): typeof readOverlays | null => readOverlays);
  const readSmudges = vi.fn((reuse?: ReadYrSmudgeOptions) => options.smudges?.(reuse) ?? null);
  const createSmudgeReader = vi.fn((): typeof readSmudges | null => readSmudges);
  const read = createYrRenderStateReaderFrom({
    memory: () => createByteViewAccessor(memory.bytes),
    readState,
    createShroudReader,
    createEffectsReader,
    createOverlayReader,
    createSmudgeReader,
    createSidebarReader: options.sidebar ? () => options.sidebar! : undefined,
    now: options.now ?? farApart(),
  });
  return {
    read,
    readState,
    readShroud,
    readEffects,
    readOverlays,
    readSmudges,
    createShroudReader,
    createEffectsReader,
    createOverlayReader,
    createSmudgeReader,
  };
}

describe('YR 1.001 render state for the HD bridge', () => {
  it('publishes completed-building ActiveAnim and observes same-frame detail/slot/type changes', () => {
    const memory = keyMemory();
    const building = memory.technos[0]!;
    const anim = 0xb50000;
    const type = 0xb60000;
    memory.u32(building, V.building);
    memory.u32(building + A.slot, anim);
    memory.u32(anim, 0x7e3354);
    memory.u32(anim + A.type, type);
    memory.u32(type, 0x7e3608);
    memory.u32(type + A.detailLevel, 2);
    memory.u32(D.fps, 30);
    memory.u32(D.min, 15);
    memory.u32(D.buffer, 5);
    memory.u32(D.level, 2);
    const state = yrState(100);
    state.objects[0] = { ...state.objects[0]!, kind: 'building', type: 'NAPOWR', buildState: 'done' };
    const harness = sources(memory);
    harness.readState.mockImplementation(() => state);
    const first = harness.read()!;
    expect(first.objects[0]!.activeAnim).toBe('shown');
    expect(first.nativeDetail).toEqual({ fps: 30, lowFrameRate: false, level: 2 });
    expect(harness.read()).toBe(first);
    for (const [address, value, expected] of [
      [D.fps, 14, 'detail'],
      [D.fps, 15, 'shown'],
      [D.lowFrameRate, 1, 'detail'],
      [D.fps, 20, 'shown'],
      [D.min, 16, 'detail'],
      [D.buffer, 0, 'shown'],
      [D.level, 1, 'detail'],
      [D.level, 2, 'shown'],
      [type + A.detailLevel, 3, 'detail'],
      [type + A.detailLevel, 2, 'shown'],
      [anim + A.invisible, 1, 'detail'],
      [anim + A.invisible, 0, 'shown'],
      [building + A.slot, 0, 'none'],
      [building + A.slot, anim, 'shown'],
      [anim + A.type, 0, undefined],
      [anim + A.type, type, 'shown'],
      [type, 0, undefined],
      [type, 0x7e3608, 'shown'],
      [D.min, 0, undefined],
    ] as const) {
      const previous = harness.read()!;
      memory.u32(address, value);
      const next = harness.read()!;
      expect(next).not.toBe(previous);
      expect(next.frame).toBe(100);
      expect(next.objects[0]!.activeAnim).toBe(expected);
      if (expected === undefined) expect(next.objects[0]).not.toHaveProperty('activeAnim');
    }
    expect(first.objects[0]!.activeAnim).toBe('shown');
    expect(structuredClone(first)).toEqual(first);
    expect(harness.read()).not.toHaveProperty('nativeDetail');
  });

  it('samples detail globals once per poll regardless of the number of completed buildings', () => {
    const memory = keyMemory();
    memory.u32(D.min, 15);
    memory.u32(D.buffer, 5);
    const state = yrState(100);
    state.objects = memory.technos.map((id, i) => {
      memory.u32(id, V.building);
      return { ...state.objects[0]!, id, uid: i, kind: 'building', buildState: 'done' };
    });
    const accessor = createByteViewAccessor(memory.bytes);
    const originalBytes = accessor.bytes;
    const bytes = vi.spyOn(accessor, 'bytes');
    const harness = sources(memory);
    harness.readState.mockImplementation(() => state);
    const read = createYrRenderStateReaderFrom({
      memory: () => accessor,
      readState: harness.readState,
      createShroudReader: harness.createShroudReader,
      createEffectsReader: harness.createEffectsReader,
      createOverlayReader: harness.createOverlayReader,
      createSmudgeReader: harness.createSmudgeReader,
      now: farApart(),
    });
    expect(read()!.objects.map((object) => object.activeAnim)).toEqual(['none', 'none']);
    read(); // Cached polls still observe the native draw gate.
    for (const address of Object.values(D)) expect(bytes.mock.calls.filter(([at]) => at === address)).toHaveLength(2);
    bytes.mockImplementation((at, width) =>
      at === memory.technos[0]! + A.slot ? new Uint8Array(0) : originalBytes(at, width),
    );
    expect(read()!.objects[0]).not.toHaveProperty('activeAnim');
    bytes.mockImplementation(originalBytes);
    expect(read()!.objects[0]!.activeAnim).toBe('none'); // Availability recovered within the same logic frame.
    state.objects[0]!.buildState = 'building';
    state.objects[1]!.buildState = 'selling';
    memory.frame(101);
    expect(read()!.objects.every((object) => !('activeAnim' in object))).toBe(true);
  });

  it('contains an unavailable guest-memory view and recovers on the next poll', () => {
    const memory = keyMemory();
    const harness = sources(memory);
    let unavailable = false;
    const read = createYrRenderStateReaderFrom({
      memory: () => {
        if (unavailable) throw new Error('detached guest view');
        return createByteViewAccessor(memory.bytes);
      },
      readState: harness.readState,
      createShroudReader: harness.createShroudReader,
      createEffectsReader: harness.createEffectsReader,
      createOverlayReader: harness.createOverlayReader,
      createSmudgeReader: harness.createSmudgeReader,
      now: farApart(),
    });
    expect(read()).not.toBeNull();
    unavailable = true;
    expect(read()).toBeNull();
    unavailable = false;
    expect(read()).not.toBeNull();
  });

  it('polls the sidebar every time and republishes only its changed content, preserving battlefield references', () => {
    const memory = keyMemory();
    const sidebar: GameRenderSidebar = {
      frame: { width: 800, height: 600 },
      side: 0,
      activeTab: 0,
      tabs: [],
      cameos: [],
      credits: 100,
      layout: {
        sidebar: { x: 632, y: 0, width: 168, height: 600 },
        commandBar: null,
        radar: { x: 648, y: 49, width: 140, height: 108 },
        credits: { x: 632, y: 0, width: 168, height: 16 },
        creditsAnchor: { x: 716, y: 2 },
        strip: { x: 654, y: 227, width: 123, height: 300 },
        cameo: { width: 60, height: 48 },
        cameoPitch: { x: 63, y: 50 },
        cameoOrigin: { x: 654, y: 228 },
        tabs: [],
        buttons: { repair: null, sell: null, options: null, diplomacy: null, scrollUp: null, scrollDown: null },
        power: { x: 637, y: 227, width: 12, slotHeight: 3, slots: 101 },
      },
      power: { output: 100, drain: 50, surplus: 2, reserve: 3, used: 4, low: false },
      radarActive: false,
      modes: { repair: false, sell: false },
      labels: { ready: 'Ready', hold: 'On Hold' },
    };
    let next: GameRenderSidebar | null = sidebar;
    let at = 0;
    const poll = vi.fn(() => next && structuredClone(next));
    const harness = sources(memory, { sidebar: poll, now: () => at });
    const first = harness.read()!;
    expect(first.sidebar).toEqual(sidebar);
    expect(harness.read()).toBe(first); // New but equal sidebar read retains both identities.
    expect(poll).toHaveBeenCalledTimes(2);
    next = { ...sidebar, credits: 101 };
    const changed = harness.read()!;
    expect(changed).not.toBe(first);
    expect(changed.sidebar).not.toBe(first.sidebar);
    for (const field of ['objects', 'effects', 'overlays', 'smudges', 'shroud', 'houses', 'map', 'view'] as const)
      expect(changed[field]).toBe(first[field]);
    expect(first.sidebar!.credits).toBe(100);
    expect(harness.read()).toBe(changed);
    expect(harness.readState).toHaveBeenCalledTimes(1);
    next = {
      ...next,
      pointer: { x: 660, y: 250, frame: 1, hotspot: { x: 0, y: 0 } },
      tooltip: { rect: { x: 600, y: 260, width: 90, height: 30 }, text: 'Native\n$600' },
    };
    const pointerChanged = harness.read()!;
    expect(pointerChanged).not.toBe(changed);
    expect(pointerChanged.objects).toBe(changed.objects);
    expect(pointerChanged.sidebar?.pointer?.frame).toBe(1);
    expect(pointerChanged.sidebar?.tooltip?.text).toBe('Native\n$600');
    expect(harness.read()).toBe(pointerChanged);
    at = 250; // Due cell poll takes a second cache-return path.
    next = { ...next, radarActive: true };
    const due = harness.read()!;
    expect(due).not.toBe(changed);
    expect(due.objects).toBe(changed.objects);
    expect(due.effects).toBe(changed.effects);
    expect(harness.read()).toBe(due);
    next = null;
    const unavailable = harness.read()!;
    expect(unavailable.sidebar).toBeNull();
    expect(unavailable.objects).toBe(due.objects);
    expect(harness.read()).toBe(unavailable);
    next = sidebar;
    memory.frame(101);
    harness.readState.mockReturnValue(yrState(101, false));
    const outside = harness.read()!;
    expect(outside.sidebar).toBeNull();
    expect(harness.read()).toBe(outside);
  });

  it('accepts an unavailable optional sidebar factory', () => {
    const memory = keyMemory();
    const read = createYrRenderStateReaderFrom({
      memory: () => createByteViewAccessor(memory.bytes),
      readState: () => yrState(100),
      createShroudReader: () => null,
      createEffectsReader: () => null,
      createOverlayReader: () => null,
      createSmudgeReader: () => null,
      createSidebarReader: () => null,
      now: farApart(),
    });
    const first = read()!;
    expect(first.sidebar).toBeNull();
    expect(read()).toBe(first);
  });

  it('preserves optional H2 fields, including zero frames, in immutable thread-safe publications', () => {
    const memory = keyMemory();
    const harness = sources(memory);
    const state = yrState(100);
    state.objects[0] = {
      ...state.objects[0]!,
      kind: 'building',
      buildState: 'selling',
      buildupFrame: 0,
      buildingFrame: 0,
      buildingDamaged: false,
      contactUid: 0,
      dock: false,
      unloading: 'roof',
    };
    state.objects[1] = {
      ...state.objects[1]!,
      infantrySequence: 'FireProne',
      sequenceFrame: 0,
      infantryDrawFacingRaw: 0,
    };
    harness.readState.mockReturnValue(state);
    const result = harness.read()!;
    expect(result.objects[0]).toMatchObject({
      buildState: 'selling',
      buildupFrame: 0,
      buildingFrame: 0,
      buildingDamaged: false,
      contactUid: 0,
      dock: false,
      unloading: 'roof',
    });
    expect(result.objects[1]).toMatchObject({
      infantrySequence: 'FireProne',
      sequenceFrame: 0,
      infantryDrawFacingRaw: 0,
    });
    expect(result.objects[1]).not.toHaveProperty('contactUid');
    expect(result.objects[1]).not.toHaveProperty('dock');
    expect(result.objects[1]).not.toHaveProperty('unloading');
    expect(result.objects[1]).not.toHaveProperty('buildState');
    expect(result.objects[0]).not.toHaveProperty('infantrySequence');
    expect(structuredClone(result)).toEqual(result);
    state.objects[1]!.sequenceFrame = 9;
    expect(result.objects[1]!.sequenceFrame).toBe(0);
  });

  it('polls overlays at 250 ms, publishes immutable changes and resets immediately for a new battle', () => {
    const memory = keyMemory();
    let at = 0;
    let data = 3;
    let inBattle = true;
    let available = true;
    const overlay = (options?: ReadYrOverlayOptions): YrOverlays | null => {
      if (!available) return null;
      const reuse = options?.reuse;
      const changed = !reuse || reuse.data[0] !== data;
      const index = reuse?.index ?? new Int16Array([0, -1]);
      const frames = reuse?.data ?? new Uint8Array(2);
      frames[0] = data;
      return {
        frame: 0,
        originX: 1,
        originY: 2,
        width: 2,
        height: 1,
        index,
        data: frames,
        types: reuse?.types ?? ['GAWALL'],
        revision: (reuse?.revision ?? 0) + Number(changed),
        rubble: [{ slot: 0, type: 'CAOILD' }],
        counts: { cells: 2, overlays: 1, invalidCells: 0, invalidTypes: 0, invalidIndices: 0, invalidRubble: 0 },
      };
    };
    const { read, readOverlays } = sources(memory, { overlays: overlay, now: () => at, map: () => inBattle });
    const first = read()!;
    const scratch = readOverlays.mock.results[0]!.value!;
    expect(first.overlays!.index).not.toBe(scratch.index);
    expect(first.overlays!.data).not.toBe(scratch.data);
    expect(first.overlays!.types).not.toBe(scratch.types);
    expect(first.overlays!.rubble).toEqual(scratch.rubble);
    expect(first.overlays!.rubble).not.toBe(scratch.rubble);
    expect(first.overlays!.rubble![0]).not.toBe(scratch.rubble[0]);
    scratch.rubble[0]!.type = 'OTHER';
    expect(first.overlays!.rubble).toEqual([{ slot: 0, type: 'CAOILD' }]);
    at = 249;
    data = 7;
    memory.frame(101);
    expect(read()!.overlays).toBe(first.overlays);
    expect(readOverlays).toHaveBeenCalledTimes(1);
    at = 250;
    const changed = read()!;
    expect(readOverlays).toHaveBeenLastCalledWith({ reuse: scratch });
    expect(changed.overlays!.data[0]).toBe(7);
    expect(changed.overlays!.revision).toBe(2);
    expect(first.overlays!.data[0]).toBe(3);
    at = 500;
    expect(read()).toBe(changed);
    expect(readOverlays).toHaveBeenCalledTimes(3);

    // A same-map restart can retain the scenario singleton but rewinds its logic frame.
    memory.frame(1);
    at = 501;
    const restarted = read()!;
    expect(restarted.overlays!.revision).toBe(3);
    expect(readOverlays).toHaveBeenLastCalledWith({ reuse: null });
    inBattle = false;
    memory.frame(2);
    expect(read()!.overlays).toBeNull();
    inBattle = true;
    memory.frame(3);
    expect(read()!.overlays!.revision).toBe(4);
    available = false;
    at = 751;
    expect(read()!.overlays).toBeNull();
    available = true;
    at = 1001;
    expect(read()!.overlays!.revision).toBe(5);
    expect(structuredClone(first)).toEqual(first);
  });

  it('retries an unavailable overlay factory only when the next overlay poll is due', () => {
    const memory = keyMemory();
    let at = 0;
    const { read, readOverlays, createOverlayReader } = sources(memory, { now: () => at });
    createOverlayReader.mockReturnValueOnce(null);
    expect(read()!.overlays).toBeNull();
    memory.frame(101);
    at = 249;
    read();
    expect(createOverlayReader).toHaveBeenCalledTimes(1);
    at = 250;
    read();
    expect(createOverlayReader).toHaveBeenCalledTimes(2);
    expect(readOverlays).toHaveBeenCalledTimes(1);
  });

  it('polls smudges at 250 ms, publishes immutable changes and resets immediately for a new battle', () => {
    const memory = keyMemory();
    let at = 0;
    let data = 3;
    let inBattle = true;
    let available = true;
    const smudge = (options?: ReadYrSmudgeOptions): YrSmudges | null => {
      if (!available) return null;
      const reuse = options?.reuse;
      const changed = !reuse || reuse.data[0] !== data;
      const index = reuse?.index ?? new Int16Array([0, -1]);
      const frames = reuse?.data ?? new Uint8Array(2);
      frames[0] = data;
      return {
        frame: 0,
        originX: 1,
        originY: 2,
        width: 2,
        height: 1,
        index,
        data: frames,
        types: reuse?.types ?? ['CR1'],
        revision: (reuse?.revision ?? 0) + Number(changed),
        counts: { cells: 2, smudges: 1, invalidCells: 0, invalidTypes: 0, invalidIndices: 0 },
      };
    };
    const { read, readSmudges } = sources(memory, { smudges: smudge, now: () => at, map: () => inBattle });
    const first = read()!;
    const scratch = readSmudges.mock.results[0]!.value!;
    expect(first.smudges!.index).not.toBe(scratch.index);
    expect(first.smudges!.data).not.toBe(scratch.data);
    expect(first.smudges!.types).not.toBe(scratch.types);
    expect(first.smudges).not.toHaveProperty('rubble');
    at = 249;
    data = 7;
    memory.frame(101);
    expect(read()!.smudges).toBe(first.smudges);
    expect(readSmudges).toHaveBeenCalledTimes(1);
    at = 250;
    const changed = read()!;
    expect(readSmudges).toHaveBeenLastCalledWith({ reuse: scratch });
    expect(changed.smudges!.data[0]).toBe(7);
    expect(changed.smudges!.revision).toBe(2);
    expect(first.smudges!.data[0]).toBe(3);
    at = 500;
    expect(read()).toBe(changed);
    expect(readSmudges).toHaveBeenCalledTimes(3);

    // A same-map restart can retain the scenario singleton but rewinds its logic frame.
    memory.frame(1);
    at = 501;
    const restarted = read()!;
    expect(restarted.smudges!.revision).toBe(3);
    expect(readSmudges).toHaveBeenLastCalledWith({ reuse: null });
    inBattle = false;
    memory.frame(2);
    expect(read()!.smudges).toBeNull();
    inBattle = true;
    memory.frame(3);
    expect(read()!.smudges!.revision).toBe(4);
    available = false;
    at = 751;
    expect(read()!.smudges).toBeNull();
    available = true;
    at = 1001;
    expect(read()!.smudges!.revision).toBe(5);
    expect(structuredClone(first)).toEqual(first);
  });

  it('retries an unavailable smudge factory only when the next smudge poll is due', () => {
    const memory = keyMemory();
    let at = 0;
    const { read, readSmudges, createSmudgeReader } = sources(memory, { now: () => at });
    createSmudgeReader.mockReturnValueOnce(null);
    expect(read()!.smudges).toBeNull();
    memory.frame(101);
    at = 249;
    read();
    expect(createSmudgeReader).toHaveBeenCalledTimes(1);
    at = 250;
    read();
    expect(createSmudgeReader).toHaveBeenCalledTimes(2);
    expect(readSmudges).toHaveBeenCalledTimes(1);
  });

  it('shroud cells use the contract encoding unchanged', () => {
    expect({ ...YR_SHROUD_STATE }).toEqual({ ...GAME_RENDER_SHROUD });
  });

  it('returns the identical snapshot until the frame, the view or the selection changes', () => {
    const memory = keyMemory();
    let at = 0;
    const { read, readState } = sources(memory, { now: () => at });
    const first = read();
    at += YR_SAME_FRAME_REREAD_MS;
    expect(read()).toBe(first);
    expect(readState).toHaveBeenCalledTimes(1);

    memory.frame(101);
    const second = read();
    expect(second).not.toBe(first);
    at += YR_SAME_FRAME_REREAD_MS;
    expect(read()).toBe(second);

    memory.scroll(30, 0);
    const scrolled = read();
    expect(scrolled).not.toBe(second);

    memory.select(memory.technos[1]!, true);
    at += YR_SAME_FRAME_REREAD_MS;
    const selected = read();
    expect(selected).not.toBe(scrolled);
    at += YR_SAME_FRAME_REREAD_MS;
    expect(read()).toBe(selected);
    expect(readState).toHaveBeenCalledTimes(4);

    // An implausible techno vector disables the cache instead of trusting a torn key.
    memory.corruptTechnos();
    at += YR_SAME_FRAME_REREAD_MS;
    read();
    read();
    expect(readState).toHaveBeenCalledTimes(6);
  });

  it('projects only the fields the renderer consumes', () => {
    const { read } = sources(keyMemory());
    const state = read()!;
    expect(state.map).toEqual({ fileName: 'XMP29U2.MAP' });
    expect(state.houses).toEqual([{ index: 0, colorIndex: 3 }]);
    expect(state.localHouse).toBe(0);
    expect(state.view).toEqual({ x: 12, y: 34 });
    expect(state).not.toHaveProperty('stats');
    expect(state.objects).toEqual([
      {
        id: 0xb0_0000,
        uid: 11,
        kind: 'vehicle',
        type: 'MTNK',
        owner: 0,
        x: 256,
        y: 512,
        z: 0,
        facingRaw: 0x4000,
        turretFacingRaw: 0xc000,
        health: 0.75,
        isSelected: true,
      },
      {
        id: 0xb0_1000,
        uid: 12,
        kind: 'infantry',
        type: 'E1',
        owner: 0,
        x: 1000,
        y: 2000,
        z: 104,
        facingRaw: 0,
        health: 1,
        isSelected: false,
      },
    ]);
    expect(state.objects[1]).not.toHaveProperty('turretFacingRaw');
    expect(state.effects).toMatchObject({
      anims: [
        { id: 1, uid: 2, type: 'TWLT070', x: 10, y: 20, z: 30, frameCount: 20, buildingAnim: false, invisible: false },
      ],
      bullets: [{ id: 3, uid: 4, x: 5, y: 6, z: 7, inviso: false, owner: 0 }],
      lasers: [{ source: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 3 }, innerColor: [255, 0, 0] }],
      electricBolts: [{ source: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 3 }, alternateColor: true }],
      particleSystems: [{ id: 7, uid: 8, behavesLike: 'smoke', x: 1, y: 1, z: 1 }],
    });
    // An ordinary shell says nothing about its palette; only FirersPalette projectiles carry the flag.
    expect(state.effects!.bullets[0]).not.toHaveProperty('ownerPalette');
    // The snapshot must survive a structured clone (the Worker reply).
    expect(structuredClone(state)).toEqual(state);
  });

  it('publishes unloading image changes within the same frame and leaves older objects optional', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    state.objects[0]!.type = 'HARV';
    h.readState.mockReturnValue(state);
    memory.u32(memory.technos[0]!, V.unit);
    const first = h.read()!;
    expect(first.objects[0]).not.toHaveProperty('imageType');
    expect(h.read()).toBe(first);
    memory.bytes[memory.technos[0]! + O.unitUnloading] = 1;
    state.objects[0]!.imageType = 'HORV';
    const unloading = h.read()!;
    expect(unloading).not.toBe(first);
    expect(unloading.frame).toBe(first.frame);
    expect(unloading.objects[0]).toMatchObject({ type: 'HARV', imageType: 'HORV' });
    expect(unloading.objects[1]).not.toHaveProperty('imageType');
    expect(structuredClone(unloading)).toEqual(unloading);
    expect(h.read()).toBe(unloading);
    memory.bytes[memory.technos[0]! + O.unitUnloading] = 0;
    delete state.objects[0]!.imageType;
    const finished = h.read()!;
    expect(finished).not.toBe(unloading);
    expect(finished.objects[0]).not.toHaveProperty('imageType');
    expect(unloading.objects[0]!.imageType).toBe('HORV');
  });

  it('publishes turret swaps and recovered reads within one logic frame without changing previous snapshots', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    state.objects[0]!.type = 'FV';
    state.objects[0]!.turretIndex = 0;
    h.readState.mockReturnValue(state);
    const unit = memory.technos[0]!;
    const type = 0xb5_0000;
    memory.u32(unit, V.unit);
    memory.u32(unit + O.unitType, type);
    memory.u32(type + O.typeTurretCount, 4);
    const empty = h.read()!;
    expect(empty.objects[0]!.turretIndex).toBe(0);
    expect(empty.objects[1]).not.toHaveProperty('turretIndex');
    expect(h.read()).toBe(empty);
    for (const index of [2, 0, 1, 3]) {
      const previous = h.read()!;
      memory.u32(unit + O.currentTurret, index);
      state.objects[0]!.turretIndex = index;
      const changed = h.read()!;
      expect(changed).not.toBe(previous);
      expect(changed.frame).toBe(empty.frame);
      expect(changed.objects[0]!.turretIndex).toBe(index);
      expect(structuredClone(changed)).toEqual(changed);
      expect(h.read()).toBe(changed);
    }
    expect(empty.objects[0]!.turretIndex).toBe(0);
    const selected = h.read()!;
    memory.bytes[type + O.typeIsGattling] = 1;
    delete state.objects[0]!.turretIndex;
    const unavailable = h.read()!;
    expect(unavailable).not.toBe(selected);
    expect(unavailable.objects[0]).not.toHaveProperty('turretIndex');
    memory.bytes[type + O.typeIsGattling] = 0;
    state.objects[0]!.turretIndex = 3;
    expect(h.read()!.objects[0]!.turretIndex).toBe(3);
  });

  it('publishes the gather sparks as an underlay and follows the harvesting flag inside one logic frame', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    state.objects[0]!.type = 'HARV';
    h.readState.mockReturnValue(state);
    const unit = memory.technos[0]!;
    memory.u32(unit, V.unit);
    const first = h.read()!;
    expect(first.objects[0]).not.toHaveProperty('underlay');
    expect(h.read()).toBe(first);
    // The harvesting flag (unit +0x6D2) changes the key before the frame counter moves.
    memory.bytes[unit + 0x6d2] = 1;
    const gather = { art: 'OREGATH', frame: 47, x: 1000, y: 2030, z: 0 };
    state.objects[0]!.gather = gather;
    const gathering = h.read()!;
    expect(gathering).not.toBe(first);
    expect(gathering.frame).toBe(first.frame);
    expect(gathering.objects[0]!.underlay).toEqual(gather);
    expect(gathering.objects[0]!.underlay).not.toBe(gather);
    expect(gathering.objects[0]).not.toHaveProperty('gather');
    expect(gathering.objects[1]).not.toHaveProperty('underlay');
    expect(structuredClone(gathering)).toEqual(gathering);
    expect(h.read()).toBe(gathering);
    memory.bytes[unit + 0x6d2] = 0;
    delete state.objects[0]!.gather;
    const stopped = h.read()!;
    expect(stopped).not.toBe(gathering);
    expect(stopped.objects[0]).not.toHaveProperty('underlay');
    expect(gathering.objects[0]!.underlay).toEqual(gather);
  });

  it('publishes the picture tint as plain data and takes a new snapshot when a tint field changes in one frame', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    state.objects[0]!.tint = { light: 0.2, add: [0, 0, 24 / 31], shield: 'forceShield' };
    h.readState.mockReturnValue(state);
    const unit = memory.technos[0]!;
    memory.u32(unit, V.unit);
    const first = h.read()!;
    // The contract carries the factor and the colour; which protection it is stays in the YR layer.
    expect(first.objects[0]!.tint).toEqual({ light: 0.2, add: [0, 0, 24 / 31] });
    expect(first.objects[0]!.tint).not.toBe(state.objects[0]!.tint);
    expect(first.objects[0]!.tint!.add).not.toBe(state.objects[0]!.tint!.add);
    expect(first.objects[1]).not.toHaveProperty('tint');
    expect(structuredClone(first)).toEqual(first);
    expect(h.read()).toBe(first);
    // The tint stage (+0x1A4), the Force Shield flag (+0x1C4) and the Berzerk byte (+0x298) are part of the key.
    for (const offset of [0x1a4, 0x1c4, 0x298, 0x18c, 0x1c8]) {
      const before = h.read()!;
      memory.bytes[unit + offset] ^= 1;
      const changed = h.read()!;
      expect(changed).not.toBe(before);
      expect(changed.frame).toBe(before.frame);
    }
    state.objects[0]!.tint = { light: 0.5 };
    memory.bytes[unit + 0x1a0] ^= 1;
    expect(h.read()!.objects[0]!.tint).toEqual({ light: 0.5 });
    delete state.objects[0]!.tint;
    memory.bytes[unit + 0x1a0] ^= 1;
    expect(h.read()!.objects[0]).not.toHaveProperty('tint');
  });

  it("publishes a harvester's load and takes a new snapshot when the storage changes inside one logic frame", () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    state.objects[0]!.type = 'HARV';
    state.objects[0]!.cargo = { ore: 0, gems: 0 };
    h.readState.mockReturnValue(state);
    const unit = memory.technos[0]!;
    memory.u32(unit, V.unit);
    const empty = h.read()!;
    expect(empty.objects[0]!.cargo).toEqual({ ore: 0, gems: 0 });
    expect(empty.objects[0]!.cargo).not.toBe(state.objects[0]!.cargo);
    expect(empty.objects[1]).not.toHaveProperty('cargo');
    expect(structuredClone(empty)).toEqual(empty);
    expect(h.read()).toBe(empty);
    // One bale of gems (TechnoClass +0x33C, float[4]: the second is Cruentus) without the frame counter moving.
    new DataView(memory.bytes.buffer).setFloat32(unit + 0x33c + 4, 1, true);
    state.objects[0]!.cargo = { ore: 0, gems: 1 };
    const loaded = h.read()!;
    expect(loaded).not.toBe(empty);
    expect(loaded.frame).toBe(empty.frame);
    expect(loaded.objects[0]!.cargo).toEqual({ ore: 0, gems: 1 });
    expect(empty.objects[0]!.cargo).toEqual({ ore: 0, gems: 0 });
    expect(h.read()).toBe(loaded);
  });

  it('publishes body-only translucency and whole-object hiding without changing older snapshots', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    h.readState.mockReturnValue(state);
    const unit = memory.technos[0]!;
    memory.u32(unit, V.unit);
    const first = h.read()!;
    expect(first.objects[0]).not.toHaveProperty('nativeHidden');
    expect(first.objects[0]).not.toHaveProperty('translucent');
    memory.bytes[unit + O.beingWarpedOut] = 1;
    Object.assign(state.objects[0]!, { translucent: 0.5 });
    const chrono = h.read()!;
    expect(chrono).not.toBe(first);
    expect(chrono.frame).toBe(first.frame);
    expect(chrono.objects[0]).toHaveProperty('translucent', 0.5);
    expect(chrono.objects[0]).not.toHaveProperty('nativeHidden');
    expect(h.read()).toBe(chrono);
    memory.bytes[unit + O.tethered] = 1;
    Object.assign(state.objects[0]!, { nativeHidden: true });
    const hidden = h.read()!;
    expect(hidden).not.toBe(chrono);
    expect(hidden.objects[0]).toMatchObject({ nativeHidden: true, translucent: 0.5 });
    expect(hidden.objects[1]).not.toHaveProperty('nativeHidden');
    expect(hidden.objects[1]).not.toHaveProperty('translucent');
    expect(structuredClone(hidden)).toEqual(hidden);
    memory.bytes[unit + O.beingWarpedOut] = 0;
    memory.bytes[unit + O.tethered] = 0;
    delete state.objects[0]!.nativeHidden;
    delete state.objects[0]!.translucent;
    const released = h.read()!;
    expect(released).not.toBe(hidden);
    expect(released.objects[0]).not.toHaveProperty('nativeHidden');
    expect(released.objects[0]).not.toHaveProperty('translucent');
    expect(hidden.objects[0]).toMatchObject({ nativeHidden: true, translucent: 0.5 });
  });

  it('invalidates same-frame visibility/delivery state for link, door and either chrono flag changes', () => {
    const memory = keyMemory();
    const h = sources(memory);
    h.readState.mockReturnValue(yrState(100));
    const unit = memory.technos[0]!;
    const building = memory.technos[1]!;
    const radioItems = 0xb5_0000;
    memory.u32(unit, V.unit);
    memory.u32(building, V.building);
    memory.u32(unit + O.radioItems, radioItems);
    memory.u32(unit + O.radioCapacity, 1);
    memory.u32(radioItems, building);
    let previous = h.read()!;
    for (const mutate of [
      () => {
        memory.bytes[unit + O.beingWarpedOut] = 1;
      },
      () => {
        memory.bytes[unit + O.warpingOut] = 1;
      },
      () => {
        memory.bytes[unit + O.tethered] = 1;
      },
      () => {
        memory.bytes[building + BR.doorMoving] = 1;
      },
      () => {
        memory.bytes[building + BR.doorTargetOpen] = 1;
      },
      () => memory.u32(building + BR.currentMission, 16),
      () => memory.u32(building + BR.queuedMission, 16),
      () => memory.u32(radioItems, 0),
      () => memory.u32(unit + O.radioCapacity, 0),
    ]) {
      mutate();
      const next = h.read()!;
      expect(next).not.toBe(previous);
      expect(next.frame).toBe(previous.frame);
      expect(h.read()).toBe(next);
      previous = next;
    }
  });

  it('invalidates a tether hide when the linked building is absent from the techno vector', () => {
    const memory = keyMemory();
    const h = sources(memory);
    h.readState.mockReturnValue(yrState(100));
    const unit = memory.technos[0]!;
    const building = 0xb6_0000;
    const type = 0xb7_0000;
    const radioItems = 0xb5_0000;
    memory.u32(unit, V.unit);
    memory.bytes[unit + O.tethered] = 1;
    memory.u32(unit + O.radioItems, radioItems);
    memory.u32(unit + O.radioCapacity, 1);
    memory.u32(radioItems, building);
    memory.u32(building, V.building);
    memory.u32(building + O.buildingType, type);
    memory.u32(building + BR.currentMission, 16);
    memory.u32(type, V.buildingType);
    memory.bytes.set(new TextEncoder().encode('GAWEAP\0'), type + O.typeId);
    const first = h.read()!;
    expect(h.read()).toBe(first);
    memory.u32(building + BR.currentMission, 5);
    const released = h.read()!;
    expect(released).not.toBe(first);
    expect(h.read()).toBe(released);
    memory.u32(building + BR.queuedMission, 16);
    const queued = h.read()!;
    expect(queued).not.toBe(released);
    memory.bytes[building + BR.doorMoving] = 2;
    const invalid = h.read()!;
    expect(invalid).not.toBe(queued);
    expect(h.read()).toBe(invalid);
  });

  it('invalidates a same-frame cached infantry step and preserves health zero through publication', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const state = yrState(100);
    Object.assign(state.objects[1]!, { infantrySequence: 'Die1', sequenceFrame: 0, health: 0 });
    h.readState.mockReturnValue(state);
    memory.u32(memory.technos[1]! + 0x6c4, 11);
    const first = h.read()!;
    expect(h.read()).toBe(first);
    memory.u32(memory.technos[1]! + 0xf8, 2);
    state.objects[1]!.sequenceFrame = 2;
    const next = h.read()!;
    expect(next).not.toBe(first);
    expect(next.frame).toBe(first.frame);
    expect(next.objects[1]).toMatchObject({ infantrySequence: 'Die1', sequenceFrame: 2, health: 0 });
    expect(first.objects[1]!.sequenceFrame).toBe(0);
    memory.u32(memory.technos[1]! + 0x6c4, 8);
    state.objects[1]!.infantrySequence = 'FireProne';
    expect(h.read()!.objects[1]!.infantrySequence).toBe('FireProne');
  });

  it('observes same-frame effect progress and suppresses an expired bolt still in its native vector', () => {
    const memory = keyMemory();
    const h = sources(memory);
    const fx = yrEffects(100);
    h.readEffects.mockReturnValue(fx);
    const items = 0xb60000,
      bolt = 0xb61000,
      anim = 0xb62000;
    memory.u32(E.electricBolts + 4, items);
    memory.u32(E.electricBolts + 0x10, 1);
    memory.u32(items, bolt);
    memory.u32(bolt + 0x28, 1);
    memory.u32(E.anims + 4, items + 4);
    memory.u32(E.anims + 0x10, 1);
    memory.u32(items + 4, anim);
    const first = h.read()!;
    expect(first.effects!.anims[0]).toMatchObject({ frame: 4, stage: 4 });
    memory.u32(anim + 0xac, 7);
    fx.anims[0]!.frame = fx.anims[0]!.stage = 7;
    const advanced = h.read()!;
    expect(advanced.effects!.anims[0]!.frame).toBe(7);
    expect(first.effects!.anims[0]!.frame).toBe(4);
    memory.u32(bolt + 0x28, 0);
    fx.electricBolts[0]!.lifetime = 0;
    expect(h.read()!.effects!.electricBolts).toEqual([]);
    memory.u32(E.anims + 0x10, 0);
    fx.anims = [];
    expect(h.read()!.effects!.anims).toEqual([]);
  });

  it('publishes native beam metadata and invalidates same-frame age, intensity, vector capacity and removal', () => {
    const memory = keyMemory(),
      h = sources(memory),
      fx = yrEffects(100);
    h.readEffects.mockReturnValue(fx);
    const source = { x: 256, y: 512, z: 104 },
      target = { x: 1536, y: 1024, z: 208 };
    fx.radBeams = [
      {
        id: 20,
        type: 'rad',
        source,
        target,
        color: [30, 250, 60],
        period: 20,
        amplitude: 40,
        age: 5,
        progress: 0.25,
        sustained: false,
      },
    ];
    fx.waves = [{ id: 21, uid: 22, type: 'magnetron', source, target, intensity: 50, progress: 0.5 }];
    fx.mindControlLinks = [
      {
        id: 23,
        controller: 24,
        targetId: 25,
        source,
        target,
        color: [80, 120, 255],
        arcHeight: 512,
        remainingFrames: 30,
        selected: false,
      },
    ];
    const items = 0xb70000,
      rad = 0xb71000,
      wave = 0xb72000;
    for (const [base, pointer, offset] of [
      [B.radBeams, rad, 0],
      [B.waves, wave, 4],
    ]) {
      memory.u32(base! + 4, items + offset!);
      memory.u32(base! + 8, 1);
      memory.u32(base! + 0x10, 1);
      memory.u32(items + offset!, pointer!);
    }
    const first = h.read()!;
    expect(first.effects!.radBeams).toEqual(fx.radBeams);
    expect(first.effects!.waves).toEqual(fx.waves);
    expect(first.effects!.mindControlLinks).toEqual(fx.mindControlLinks);
    expect(first.effects!.mindControlLinks![0]!.source).not.toBe(source);
    expect(first.effects!.mindControlLinks![0]!.color).not.toBe(fx.mindControlLinks[0]!.color);
    expect(h.read()).toBe(first);
    memory.u32(rad + BO.radAge, 6);
    fx.radBeams[0]!.age = 6;
    fx.radBeams[0]!.progress = 0.3;
    const aged = h.read()!;
    expect(aged).not.toBe(first);
    expect(first.effects!.radBeams![0]!.age).toBe(5);
    fx.radBeams[0]!.color[0] = 100;
    expect(first.effects!.radBeams![0]!.color[0]).toBe(30);
    memory.u32(wave + BO.waveIntensity, 64);
    fx.waves[0]!.intensity = 64;
    const reset = h.read()!;
    expect(reset).not.toBe(aged);
    expect(reset.effects!.waves![0]!.intensity).toBe(64);
    memory.u32(B.radBeams + 8, 2);
    expect(h.read()).not.toBe(reset);
    memory.u32(B.waves + 0x10, 0);
    fx.waves = [];
    expect(h.read()!.effects!.waves).toEqual([]);
  });

  it('refreshes nested mind-control color, target height, timers and planning visibility in the same frame', () => {
    const memory = keyMemory(),
      h = sources(memory),
      data = new DataView(memory.bytes.buffer);
    const controller = memory.technos[0]!,
      target = memory.technos[1]!;
    const type = 0xc10000,
      targetType = 0xc12000,
      house = 0xc20000,
      manager = 0xc30000,
      node = 0xc40000;
    const vector = (base: number, items: number, pointer: number) => {
      memory.u32(base + 4, items);
      memory.u32(base + 8, 1);
      memory.u32(base + 0x10, 1);
      memory.u32(items, pointer);
    };
    memory.u32(controller, V.infantry);
    memory.u32(controller + 0x6c0, type);
    memory.u32(type, V.infantryType);
    memory.u32(target, V.unit);
    memory.u32(target + 0x6c4, targetType);
    memory.u32(targetType, V.unitType);
    memory.u32(controller + 0x6c, 100);
    memory.u32(target + 0x6c, 100);
    memory.u32(controller + MO.owner, house);
    memory.u32(house, YR_MIND_CONTROL_HOUSE_VTABLE);
    memory.bytes.set([30, 120, 230], house + MO.houseColor);
    memory.u32(controller + MO.manager, manager);
    memory.u32(target + MO.controlledBy, controller);
    memory.u32(manager, YR_CAPTURE_MANAGER_VTABLE);
    memory.u32(manager + MO.controller, controller);
    memory.u32(node, target);
    memory.u32(node + MO.timerStart, 90);
    memory.u32(node + MO.timerDuration, 20);
    vector(MC.managers, 0xc50000, manager);
    vector(manager + MO.nodes, 0xc50010, node);
    memory.u32(type + MO.alternateFlh + 8, 140);
    memory.u32(targetType + MO.targetHeight, 80);
    data.setFloat32(MC.trigScale, 2607.594482421875, true);
    for (let i = 0; i < 10240; i++) data.setFloat32(MC.trig + i * 4, Math.sin((i * Math.PI * 2) / 8192), true);
    h.readEffects.mockImplementation(() => readYrEffects(createByteViewAccessor(memory.bytes), { fireWindow: 0 }));
    const first = h.read()!;
    expect(first.effects!.mindControlLinks).toHaveLength(1);
    expect(h.read()).toBe(first);
    memory.bytes[house + MO.houseColor] = 180;
    const recolored = h.read()!;
    expect(recolored).not.toBe(first);
    expect(recolored.effects!.mindControlLinks![0]!.color).toEqual([180, 120, 230]);
    expect(first.effects!.mindControlLinks![0]!.color).toEqual([30, 120, 230]);
    memory.u32(targetType + MO.targetHeight, 160);
    const raised = h.read()!;
    expect(raised.effects!.mindControlLinks![0]!.target.z).toBe(160);
    memory.u32(node + MO.timerDuration, 10);
    expect(h.read()!.effects!.mindControlLinks).toEqual([]);
    memory.select(target, true);
    expect(h.read()!.effects!.mindControlLinks).toHaveLength(1);
    memory.bytes[MC.planning] = 1;
    expect(h.read()!.effects!.mindControlLinks).toEqual([]);
    memory.bytes[MC.planning] = 0;
    expect(h.read()!.effects!.mindControlLinks).toHaveLength(1);
    memory.u32(manager + MO.nodes + 0x10, 0);
    expect(h.read()!.effects!.mindControlLinks).toEqual([]);
  });

  it('invalidates completed-building art after same-frame health, occupancy or loaded-rule changes', () => {
    const memory = keyMemory();
    const { read } = sources(memory);
    const rules = 0xb70000;
    memory.u32(R.instance, rules);
    let previous = read()!;
    for (const [at, value] of [
      [memory.technos[0]! + O.health, 475],
      [memory.technos[0]! + 0x694, 2],
      [rules + R.red + 4, 0x3fd00000],
      [rules + R.yellow + 4, 0x3fe00000],
    ]) {
      memory.u32(at!, value!);
      const next = read()!;
      expect(next).not.toBe(previous);
      expect(read()).toBe(next);
      previous = next;
    }
  });

  it('publishes native painter metadata and refreshes after same-frame layer reordering', () => {
    const memory = keyMemory();
    const { read, readState } = sources(memory);
    const initial = yrState(100);
    initial.objects[0]!.renderOrder = { layer: 2, index: 1, ySort: 768 };
    readState.mockReturnValue(initial);
    memory.layer(2, [...memory.technos].reverse());
    const first = read()!;
    expect(first.objects[0]!.renderOrder).toEqual(initial.objects[0]!.renderOrder);
    expect(first.objects[0]!.renderOrder).not.toBe(initial.objects[0]!.renderOrder);
    expect(first.objects[1]).not.toHaveProperty('renderOrder');
    expect(structuredClone(first)).toEqual(first);
    expect(read()).toBe(first);
    const reordered = yrState(100);
    reordered.objects[0]!.renderOrder = { layer: 2, index: 0, ySort: 768 };
    readState.mockReturnValue(reordered);
    memory.layer(2, memory.technos);
    const next = read()!;
    expect(next).not.toBe(first);
    expect(next.objects[0]!.renderOrder).toEqual({ layer: 2, index: 0, ySort: 768 });
    expect(first.objects[0]!.renderOrder).toEqual({ layer: 2, index: 1, ySort: 768 });
  });

  it('publishes the native body tilt of a vehicle as its own copy and omits it when the reader has none', () => {
    const memory = keyMemory();
    const { read, readState } = sources(memory);
    const state = yrState(100);
    const tilt = { x: 0.4896, y: 0, z: 0.872 };
    state.objects[0]!.tilt = tilt;
    readState.mockReturnValue(state);
    const first = read()!;
    expect(first.objects[0]!.tilt).toEqual(tilt);
    expect(first.objects[0]!.tilt).not.toBe(tilt);
    expect(first.objects[1]).not.toHaveProperty('tilt');
    expect(structuredClone(first)).toEqual(first);
  });

  it('reads effects without the fire scan and reuses the shroud scratch without handing it out', () => {
    const memory = keyMemory();
    let cells = [0, 1, 2, 0xff];
    let at = 0;
    const { read, readShroud, readEffects } = sources(memory, { cells: () => cells, now: () => at });
    const first = read()!;
    expect(readEffects).toHaveBeenCalledWith({ fireWindow: 0 });
    const scratch = readShroud.mock.results[0]!.value as YrShroud;
    expect(first.shroud).toEqual({ originX: 1, originY: 2, width: 2, height: 2, cells: new Uint8Array(cells) });
    expect(first.shroud!.cells).not.toBe(scratch.cells);

    memory.frame(101);
    at += YR_SHROUD_POLL_MS;
    const same = read()!;
    expect(readShroud).toHaveBeenLastCalledWith({ reuse: scratch });
    expect(same).not.toBe(first);
    expect(same.shroud).toBe(first.shroud);

    cells = [2, 2, 2, 0xff];
    memory.frame(102);
    at += YR_SHROUD_POLL_MS;
    const changed = read()!;
    expect(changed.shroud).not.toBe(first.shroud);
    expect([...changed.shroud!.cells]).toEqual(cells);
    expect([...first.shroud!.cells]).toEqual([0, 1, 2, 0xff]);
  });

  it('computes the same change key from a word-aligned view and from one without a word view', () => {
    const aligned = keyMemory();
    // The same bytes one byte into a larger buffer: no word view, every field goes through the checked accessors.
    const backing = new Uint8Array(aligned.bytes.length + 8);
    const shifted = backing.subarray(1, 1 + aligned.bytes.length);
    const words = createByteViewAccessor(aligned.bytes).words!;
    expect(words).toBeInstanceOf(Uint32Array);
    expect(createByteViewAccessor(shifted).words).toBeUndefined();
    // A live view of the same memory, not a copy.
    aligned.u32(0x1000, 0x1234_5678);
    expect(words[0x1000 >>> 2]).toBe(0x1234_5678);
    const reader = (bytes: Uint8Array) =>
      createYrRenderStateReaderFrom({
        memory: () => createByteViewAccessor(bytes),
        readState: () => yrState(1),
        createShroudReader: () => null,
        createEffectsReader: () => null,
        createOverlayReader: () => null,
        createSmudgeReader: () => null,
        now: farApart(),
      });
    const fast = reader(aligned.bytes),
      slow = reader(shifted);
    shifted.set(aligned.bytes);
    let lastFast = fast(),
      lastSlow = slow();
    const step = (what: string, change: () => void, changed: boolean) => {
      change();
      shifted.set(aligned.bytes);
      const nextFast = fast(),
        nextSlow = slow();
      expect(nextFast !== lastFast, `${what} (word view)`).toBe(changed);
      expect(nextSlow !== lastSlow, `${what} (accessors)`).toBe(changed);
      lastFast = nextFast;
      lastSlow = nextSlow;
    };
    const [first, second] = aligned.technos as [number, number];
    step('nothing', () => undefined, false);
    step('health, first word of a span', () => aligned.u32(first + 0x6c, 77), true);
    step('nothing', () => undefined, false);
    step('last word of the facing span', () => aligned.u32(second + 0x3b4, 5), true);
    step('first word after that span', () => aligned.u32(second + 0x3b8, 5), false);
    // A span that starts on an odd offset (the chrono flags) is read through the accessors in both readers.
    step('chrono flag byte', () => (aligned.bytes[second + O.beingWarpedOut] = 1), true);
    step('nothing', () => undefined, false);
  });

  it('takes one look per logic frame: a poll inside the same frame and view gets the last snapshot back', () => {
    const memory = keyMemory();
    let at = 5000;
    const { read, readState } = sources(memory, { now: () => at });
    const first = read()!;
    // Half-updated objects in the middle of a logic frame: not read again while the frame and the view stand.
    memory.select(memory.technos[0]!, true);
    for (const step of [1, 5, 10, 14]) {
      at += step;
      expect(read()).toBe(first);
    }
    expect(readState).toHaveBeenCalledTimes(1);
    // The next logic frame is read at once, with what changed meanwhile.
    memory.frame(101);
    at += 1;
    const next = read()!;
    expect(next).not.toBe(first);
    expect(readState).toHaveBeenCalledTimes(2);
    // Scrolling moves the view without a logic frame: followed at every poll.
    memory.scroll(64, 8);
    at += 1;
    const scrolled = read()!;
    expect(scrolled).not.toBe(next);
    // A game that stands still (a pause, a slow frame) is looked at again a tenth of a second after the last look.
    memory.select(memory.technos[1]!, true);
    at += YR_SAME_FRAME_REREAD_MS - 1;
    expect(read()).toBe(scrolled);
    at += 1;
    const late = read()!;
    expect(late).not.toBe(scrolled);
    // That look counts: the next one is a tenth of a second later again, changed or not.
    memory.select(memory.technos[1]!, false);
    at += YR_SAME_FRAME_REREAD_MS - 1;
    expect(read()).toBe(late);
    at += 1;
    expect(read()).not.toBe(late);
    expect(readState).toHaveBeenCalledTimes(5);
  });

  it('reads the shroud on the cell cadence while objects and effects are read with every logic frame', () => {
    const memory = keyMemory();
    let cells = [0, 1, 2, 0xff];
    let at = 1000;
    const { read, readState, readShroud, readEffects } = sources(memory, { cells: () => cells, now: () => at });
    const first = read()!;
    expect(readShroud).toHaveBeenCalledTimes(1);
    // Logic frames 16 ms apart: every one a snapshot with fresh objects and effects, no shroud walk for 250 ms.
    cells = [2, 2, 2, 0xff];
    let frame = 100;
    let snapshots = 1;
    let previous = first;
    while (at + 16 - 1000 < YR_SHROUD_POLL_MS) {
      memory.frame(++frame);
      at += 16;
      const next = read()!;
      snapshots++;
      expect(next).not.toBe(previous);
      expect(next.shroud).toBe(first.shroud);
      previous = next;
    }
    expect(snapshots).toBe(16);
    expect(readState).toHaveBeenCalledTimes(snapshots);
    expect(readEffects).toHaveBeenCalledTimes(snapshots);
    expect(readShroud).toHaveBeenCalledTimes(1);
    // The first snapshot at or past the cadence walks the shroud again, and starts the next interval.
    memory.frame(++frame);
    at += 16;
    const caught = read()!;
    expect(readShroud).toHaveBeenCalledTimes(2);
    expect([...caught.shroud!.cells]).toEqual(cells);
    memory.frame(++frame);
    at += YR_SHROUD_POLL_MS - 1;
    expect(read()!.shroud).toBe(caught.shroud);
    expect(readShroud).toHaveBeenCalledTimes(2);
    memory.frame(++frame);
    at += 1;
    read();
    expect(readShroud).toHaveBeenCalledTimes(3);
  });

  it('reads the shroud at once for another battle, and keeps asking while it is unavailable', () => {
    const memory = keyMemory();
    let at = 0;
    const cells = [2, 2, 0, 0xff];
    const { read, readShroud } = sources(memory, { cells: () => cells, now: () => at });
    read();
    expect(readShroud).toHaveBeenCalledTimes(1);
    // The logic frame starting over is another match: its shroud is read without waiting for the cadence.
    memory.frame(3);
    at += 5;
    expect(read()!.shroud).not.toBeNull();
    expect(readShroud).toHaveBeenCalledTimes(2);
    // A reader that has nothing yet (tables not filled in) is asked again at the next snapshot, whatever the time.
    readShroud.mockReturnValueOnce(null as never);
    memory.frame(4);
    at += YR_SHROUD_POLL_MS;
    expect(read()!.shroud).toBeNull();
    memory.frame(5);
    at += 1;
    expect(read()!.shroud).not.toBeNull();
    expect(readShroud).toHaveBeenCalledTimes(4);
  });

  it('creates the shroud and effects readers inside a battle only, retrying while they are unavailable', () => {
    const memory = keyMemory();
    let inBattle = false;
    const { read, createShroudReader, createEffectsReader, readShroud } = sources(memory, { map: () => inBattle });
    const menu = read()!;
    expect(menu.map).toBeNull();
    expect(menu.shroud).toBeNull();
    expect(menu.effects).toBeNull();
    expect(createShroudReader).not.toHaveBeenCalled();

    inBattle = true;
    createShroudReader.mockReturnValueOnce(null);
    memory.frame(101);
    expect(read()!.shroud).toBeNull();
    memory.frame(102);
    expect(read()!.shroud).not.toBeNull();
    expect(createShroudReader).toHaveBeenCalledTimes(2);
    expect(createEffectsReader).toHaveBeenCalledTimes(1);
    expect(readShroud).toHaveBeenCalledTimes(1);
  });

  it('the guarded factory and the runtime hook reject other builds', async () => {
    const memory = createGuestMemory();
    expect(createYrRenderStateReader(memory, memory.bytes.length, 'other')).toBeNull();
    await expect(YR_RUNTIME_HOOKS.createRenderStateReader!(memory, memory.bytes.length, 'other')).resolves.toBeNull();
  });
});
