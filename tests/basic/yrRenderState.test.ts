import type { GameRenderSidebar } from '../../src/games/renderState';
import { describe, expect, it, vi } from 'vitest';
import { GAME_RENDER_SHROUD } from '../../src/games/renderState';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import type { ReadYrEffectsOptions, YrEffects } from '../../src/games/yr/effectsReader';
import { YR_EFFECTS_GLOBALS as E } from '../../src/games/yr/effectsReader';
import { YR_BUILDING_RULES as R } from '../../src/games/yr/buildingRenderState';
import type { ReadYrSmudgeOptions, YrSmudges } from '../../src/games/yr/smudgeReader';
import type { ReadYrOverlayOptions, YrOverlays } from '../../src/games/yr/overlayReader';
import { createYrRenderStateReader, createYrRenderStateReaderFrom } from '../../src/games/yr/renderState';
import { YR_RUNTIME_HOOKS } from '../../src/games/yr/runtimeHooks';
import { YR_SHROUD_STATE, type ReadYrShroudOptions, type YrShroud } from '../../src/games/yr/shroudReader';
import {
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS,
  YR_STATE_OFFSETS as O,
  type YrState,
} from '../../src/games/yr/stateReader';
import { createGuestMemory } from '../helpers/guestMemory';

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
    now: options.now ?? (() => 0),
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
      now: () => 0,
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
    });
    expect(result.objects[1]).toMatchObject({
      infantrySequence: 'FireProne',
      sequenceFrame: 0,
      infantryDrawFacingRaw: 0,
    });
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
        counts: { cells: 2, overlays: 1, invalidCells: 0, invalidTypes: 0, invalidIndices: 0 },
      };
    };
    const { read, readOverlays } = sources(memory, { overlays: overlay, now: () => at, map: () => inBattle });
    const first = read()!;
    const scratch = readOverlays.mock.results[0]!.value!;
    expect(first.overlays!.index).not.toBe(scratch.index);
    expect(first.overlays!.data).not.toBe(scratch.data);
    expect(first.overlays!.types).not.toBe(scratch.types);
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
    const { read, readState } = sources(memory);
    const first = read();
    expect(read()).toBe(first);
    expect(readState).toHaveBeenCalledTimes(1);

    memory.frame(101);
    const second = read();
    expect(second).not.toBe(first);
    expect(read()).toBe(second);

    memory.scroll(30, 0);
    const scrolled = read();
    expect(scrolled).not.toBe(second);

    memory.select(memory.technos[1]!, true);
    const selected = read();
    expect(selected).not.toBe(scrolled);
    expect(read()).toBe(selected);
    expect(readState).toHaveBeenCalledTimes(4);

    // An implausible techno vector disables the cache instead of trusting a torn key.
    memory.corruptTechnos();
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
      bullets: [{ id: 3, uid: 4, x: 5, y: 6, z: 7, inviso: false }],
      lasers: [{ source: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 3 }, innerColor: [255, 0, 0] }],
      electricBolts: [{ source: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 3 }, alternateColor: true }],
      particleSystems: [{ id: 7, uid: 8, behavesLike: 'smoke', x: 1, y: 1, z: 1 }],
    });
    // The snapshot must survive a structured clone (the Worker reply).
    expect(structuredClone(state)).toEqual(state);
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

  it('reads effects without the fire scan and reuses the shroud scratch without handing it out', () => {
    const memory = keyMemory();
    let cells = [0, 1, 2, 0xff];
    const { read, readShroud, readEffects } = sources(memory, { cells: () => cells });
    const first = read()!;
    expect(readEffects).toHaveBeenCalledWith({ fireWindow: 0 });
    const scratch = readShroud.mock.results[0]!.value as YrShroud;
    expect(first.shroud).toEqual({ originX: 1, originY: 2, width: 2, height: 2, cells: new Uint8Array(cells) });
    expect(first.shroud!.cells).not.toBe(scratch.cells);

    memory.frame(101);
    const same = read()!;
    expect(readShroud).toHaveBeenLastCalledWith({ reuse: scratch });
    expect(same).not.toBe(first);
    expect(same.shroud).toBe(first.shroud);

    cells = [2, 2, 2, 0xff];
    memory.frame(102);
    const changed = read()!;
    expect(changed.shroud).not.toBe(first.shroud);
    expect([...changed.shroud!.cells]).toEqual(cells);
    expect([...first.shroud!.cells]).toEqual([0, 1, 2, 0xff]);
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
