import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmShell } from '../../src/adapter/vmShell';
import type { GameRenderState } from '../../src/games/renderState';
import {
  parseHdPace,
  sidebarUpcomingTypes,
  startHdBridge,
  type HdBridgeCapture,
  type HdBridgeCombatState,
  type HdBridgeCounters,
  type HdBridgeDrawCapture,
  type HdBridgeTimeline,
} from '../../src/ui/pages/game/hdBridge';
import type { VmDiagnostics } from '../../src/adapter/vmDiagnostics';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import type { VmFrame } from '../../src/vm86/win32';
import { hdSidebar } from '../helpers/hdSidebar';
import { createWebGpuFrameCapture } from '../../src/graphics/webGpuFrameCapture';

// The bridge loads LiveView (three.js, WebGPU) through a dynamic import; a stub stands in for it.
const liveView = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../packages/hd-renderer/src/live/liveView', () => ({ LiveView: { create: liveView.create } }));
const hdRenderer = vi.hoisted(() => ({ applyLookPreset: vi.fn() }));
vi.mock('../../packages/hd-renderer/src/HdRenderer', () => ({
  LOOK_PRESETS: { faithful: {}, golden: { hour: 16.5 }, cinematic: { hour: 16.5 } },
  applyLookPreset: hdRenderer.applyLookPreset,
}));

const hdUi = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../src/ui/pages/game/hdUi', () => ({ startHdUi: hdUi.start }));
// The stall recorder listens to the document and posts to the development server: a stub records its wiring.
const stallMonitor = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../src/ui/pages/game/hdStallMonitor', () => ({ startHdStallMonitor: stallMonitor.start }));

interface BridgeHandle {
  toggle(): boolean;
  readonly ui: { enabled: boolean; readonly state: GameRenderState['sidebar']; toggle(): boolean };
  readonly live: unknown;
  readonly timeline: HdBridgeTimeline;
  readonly passthrough: { flags: number; unsupported: boolean; keyed: boolean };
  readonly pace: { mode: string; level: number; levels: number; rate: number; stride: number } | null;
  readonly diagnostics: {
    readonly enabled: boolean;
    readonly shown: boolean;
    readonly state: GameRenderState | null;
    readonly combatState: HdBridgeCombatState | null;
    readonly counters: HdBridgeCounters;
    readonly capture: HdBridgeCapture | null;
    startCapture(): HdBridgeCapture;
    finishCapture(): HdBridgeCapture | null;
    captureNextDraw(timeoutMs?: number): Promise<HdBridgeDrawCapture>;
    getCommandState(): ReturnType<VmShell['getCommandState']>;
    getGamePerformance(): ReturnType<VmShell['getGamePerformance']>;
    getPointerState(): ReturnType<VmShell['getPointerState']>;
    getVmDiagnostics(): Promise<VmDiagnostics>;
  };
}

/** 800x600 frame minus YR's 168 px sidebar and 32 px command bar. */
const TACTICAL = { x: 0, y: 0, width: 632, height: 568 };
const KEY = { rect: TACTICAL, rgb565: 0xf81f };

let clock = 0;
let frames: Array<() => void> = [];
const stored = new Map<string, string>();

/**
 * A view that draws every snapshot completely at once (`settledFrames` is what the bridge waits for before it shows
 * the view; tests of that wait set it themselves).
 */
function fakeView() {
  return {
    push: vi.fn(),
    render: vi.fn(),
    resizePixels: vi.fn(),
    dispose: vi.fn(),
    settledFrames: 3,
    hd: {
      topEffectsEnabled: false,
      enableTopEffects: vi.fn(),
      settings: {},
      applySettings: vi.fn(),
      qualityTiers: 4,
      quality: 0,
      enableAsyncPipelines: vi.fn(() => true),
      setQualityTier: vi.fn(function (this: { quality: number }, tier: number) {
        this.quality = tier;
      }),
    },
    outOfSight: false,
    newArtPerFrame: 1,
    hiddenUploadPixels: 0,
    theater: 'urban',
    warm: vi.fn(),
    warmTypes: vi.fn((): unknown[] => []),
    loadingArt: vi.fn(() => 0),
    prepare: vi.fn(),
    activity: vi.fn(() => ({ pageUploads: 1, logicFps: 20 })),
  };
}

/** What the bridge gets back from the stall monitor it starts. */
function fakeStallMonitor() {
  return { frame: vi.fn(), newMatch: vi.fn(), entries: vi.fn((): unknown[] => [{ seq: 1 }]), dispose: vi.fn() };
}

function fakeLookView() {
  return fakeView();
}

function fakeGpuFrame(width = 2, height = 2, format = 'bgra8unorm') {
  const events: string[] = [];
  const texture = { width, height, format, usage: 17, sampleCount: 1, depthOrArrayLayers: 1 };
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const bytes = new Uint8Array(Math.max(0, bytesPerRow * height));
  let resolveMap!: () => void;
  const mapping = new Promise<void>((resolve) => (resolveMap = resolve));
  const buffer = {
    mapAsync: vi.fn(async () => {
      events.push('map');
      await mapping;
    }),
    getMappedRange: vi.fn(() => bytes.buffer),
    unmap: vi.fn(),
    destroy: vi.fn(),
  };
  const encoder = {
    copyTextureToBuffer: vi.fn(() => events.push('copy')),
    finish: vi.fn(() => 'copy-commands'),
  };
  const device = {
    createBuffer: vi.fn(() => buffer),
    createCommandEncoder: vi.fn(() => encoder),
    queue: { submit: vi.fn(() => events.push('submit')) },
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async (): Promise<{ message: string } | null> => null),
  };
  const backend = {
    isWebGPUBackend: true,
    context: { getCurrentTexture: vi.fn(() => texture) },
    device,
  };
  return { backend, texture, device, encoder, buffer, bytes, bytesPerRow, resolveMap, events };
}

/** The game's loading screen: the scenario is known and has a view, but no object exists yet. */
function loadingScreen(fileName = 'XMP29U2.MAP'): GameRenderState {
  return { ...battle(0, fileName), objects: [] };
}

/** A running match: the scenario has loaded, so there is at least one object (see `loadingScreen`). */
function battle(frame: number, fileName = 'XMP29U2.MAP'): GameRenderState {
  return {
    frame,
    view: { x: 100, y: 200 },
    map: { fileName },
    houses: [],
    objects: [
      {
        id: 1,
        uid: 1,
        kind: 'vehicle',
        type: 'HTNK',
        owner: 0,
        x: 0,
        y: 0,
        z: 0,
        facingRaw: 0,
        health: 1,
        isSelected: false,
      },
    ],
    shroud: null,
    overlays: null,
    smudges: null,
    effects: null,
  } as unknown as GameRenderState;
}

function setup(
  search = '?hd=1',
  backend: VmFrameRenderer['backend'] = 'WebGL2',
  runtimeBackend: 'v86' | 'native' = 'v86',
) {
  clock = 1000;
  frames = [];
  const hdCanvas = { id: '', style: {} as Record<string, string>, remove: vi.fn() };
  const curtain = { id: '', textContent: '', style: {} as Record<string, string>, remove: vi.fn() };
  const win: { location: { search: string }; __hdBridge?: BridgeHandle } = { location: { search } };
  const createElement = vi.fn((tag: string) => (tag === 'div' ? curtain : hdCanvas));
  vi.stubGlobal('window', win);
  // What earlier matches showed (hdWarmStore.ts); empty unless a test fills it before the bridge reads it.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal('document', { createElement });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const screen = {
    style: { position: 'static', zIndex: '' },
    parentElement: { insertBefore: vi.fn() },
    clientWidth: 800,
    clientHeight: 600,
    offsetLeft: 0,
    offsetTop: 0,
  };
  const renderer = { backend, setTransparentKey: vi.fn(), setTransparentRect: vi.fn(), prepareTransparentKey: vi.fn() };
  let state: GameRenderState | null = null;
  let frameSize = { width: 800, height: 600 };
  const vm = {
    runtimeInfo: { backend: runtimeBackend },
    getRenderState: vi.fn(async (): Promise<GameRenderState | null> => state),
    setTacticalPassthrough: vi.fn(async (_flags: number) => true),
  };
  const status = vi.fn((_text: string | null) => undefined);
  const quality = vi.fn((_tier: number | null, _tiers: number) => undefined);
  const stalls = vi.fn((_count: number, _longestMs: number) => undefined);
  const stop = startHdBridge({
    vm: vm as unknown as VmShell,
    screen: screen as unknown as HTMLCanvasElement,
    frameRenderer: renderer as unknown as VmFrameRenderer,
    invalidate: vi.fn(),
    frameSize: () => frameSize,
    publishStatus: status,
    publishQuality: quality,
    publishStalls: stalls,
  });
  return {
    stop,
    status,
    quality,
    stalls,
    vm,
    renderer,
    screen,
    hdCanvas,
    curtain,
    createElement,
    bridge: () => win.__hdBridge,
    setState(next: GameRenderState | null) {
      state = next;
    },
    /** The guest switched video mode (the game canvas keeps its 800x600 CSS box in this harness). */
    setFrameSize(width: number, height: number) {
      frameSize = { width, height };
    },
    nativeFrame(keyed = true) {
      stop.frame({
        ...frameSize,
        rgb565: new Uint16Array(frameSize.width * frameSize.height).fill(keyed ? 0xf81f : 0),
      } as VmFrame);
    },
    polls: () => vm.getRenderState.mock.calls.length,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Run `count` animation frames `ms` apart, letting replies settle after each. */
async function advance(ms: number, count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    clock += ms;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    for (const callback of frames.splice(0)) callback();
    await settle();
  }
}

/** Enter a battle on a cached map and wait until the HD view is live. */
async function goLive(harness: ReturnType<typeof setup>, view = fakeView()) {
  liveView.create.mockResolvedValue(view);
  harness.setState(battle(1));
  await advance(harness.vm.runtimeInfo.backend === 'native' ? 17 : 16);
  await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
  harness.setState(battle(2));
  // One frame pushes the match snapshot, the next finds the view complete and shows it.
  await advance(
    harness.vm.runtimeInfo.backend === 'native' ? 17 : 16,
    harness.vm.runtimeInfo.backend === 'native' ? 3 : 2,
  );
  if (harness.vm.runtimeInfo.backend === 'native') {
    harness.nativeFrame();
    await advance(17);
    expect(harness.bridge()!.diagnostics.shown).toBe(true);
  }
  return view;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stored.clear();
  liveView.create.mockReset();
  hdRenderer.applyLookPreset.mockReset();
  hdUi.start.mockReset();
  stallMonitor.start.mockReset();
});

describe('HD bridge control', () => {
  it('returns a stop function that can also switch between the HD view and the original picture', async () => {
    const harness = setup();
    await goLive(harness);
    await advance(16);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.stop.toggle()).toBe(false);
    // Frames the game already drew may still carry the key colour: the HD canvas goes after the passthrough trail.
    await advance(600);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    expect(harness.bridge()!.toggle()).toBe(true);
    await advance(16);
    expect(harness.hdCanvas.style.display).toBe('block');
    harness.stop();
    // A stopped bridge no longer switches anything.
    expect(harness.stop.toggle()).toBe(true);
    expect(harness.hdCanvas.remove).toHaveBeenCalledOnce();
  });

  it('has nothing to switch without the WebGL2 frame renderer', () => {
    const harness = setup('?hd=1', 'Canvas 2D');
    expect(harness.stop.toggle()).toBe(false);
    harness.stop();
  });
});

describe('HD bridge development measurement', () => {
  it('forwards a bounded next-draw timeout and releases a stalled capture without another render', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = setup('?hd=1&hd-pace=off');
    const view = await goLive(harness);
    const gpu = fakeGpuFrame();
    Object.assign(view.hd, { renderer: { backend: gpu.backend } });
    const before = view.render.mock.calls.length;
    const result = harness.bridge()!.diagnostics.captureNextDraw(500);
    const rejected = expect(result).rejects.toThrow('timed out');
    expect(view.render).toHaveBeenCalledTimes(before);
    await advance(20);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(gpu.buffer.destroy).toHaveBeenCalledTimes(1);
    gpu.resolveMap();
    await settle();
    expect(gpu.buffer.getMappedRange).not.toHaveBeenCalled();
    harness.stop();
  });

  it('copies the actual next submitted draw with fixed detached metadata and no additional render', async () => {
    const harness = setup('?hd=1&hd-pace=off');
    const view = await goLive(harness);
    const gpu = fakeGpuFrame();
    Object.assign(view.hd, { renderer: { backend: gpu.backend } });
    const native = battle(42);
    native.sidebar = hdSidebar();
    native.effects = {
      anims: [
        {
          id: 4,
          uid: 44,
          type: 'ANY-GAME-TYPE',
          x: 256,
          y: 512,
          z: 104,
          frameCount: 12,
          buildingAnim: false,
          invisible: false,
        },
      ],
      bullets: [],
      lasers: [],
      electricBolts: [],
      particleSystems: [],
    };
    harness.setState(native);
    await advance(20, 3);
    const probe = harness.bridge()!.diagnostics;
    const expectedFrame = probe.state!.frame;
    const before = view.render.mock.calls.length;
    const result = probe.captureNextDraw();
    expect(view.render).toHaveBeenCalledTimes(before);
    await advance(20);
    expect(view.render).toHaveBeenCalledTimes(before + 1);
    expect(gpu.events).toEqual(['copy', 'submit', 'map']);
    // The map reply arrives after the live source and the current clock have moved on.
    native.view!.x = 9999;
    native.effects.anims[0]!.x = 9999;
    gpu.resolveMap();
    const image = await result;
    expect(image.frame).toBe(expectedFrame);
    expect(image.state.frame).toBe(image.frame);
    expect(image.drawAtMs).toBe(clock);
    expect(image.shown).toBe(true);
    expect(image.rect).toEqual(TACTICAL);
    expect(image.nativeSize).toEqual({ width: 800, height: 600 });
    expect(image.view).toEqual({ x: 100, y: 200 });
    expect(image.state.effects!.anims[0]).toMatchObject({ uid: 44, type: 'ANY-GAME-TYPE', x: 256 });
    expect(image.state.effects!.animsTruncated).toBe(false);
    expect(image.passthrough).toEqual(harness.bridge()!.passthrough);
    expect(image.interpolation).toBe('normal LiveView interpolation');
    expect(image.pixels).toHaveLength(16);
    expect(gpu.buffer.destroy).toHaveBeenCalledTimes(1);
    image.state.view!.x = -1;
    image.state.effects!.anims[0]!.x = -1;
    expect(native.view!.x).toBe(9999);
    expect(native.effects.anims[0]!.x).toBe(9999);
    expect(view.render).toHaveBeenCalledTimes(before + 1);
    harness.stop();
  });

  it('preserves shown=false for an actual Backslash-trail draw and cancels an owned readback on stop', async () => {
    const harness = setup('?hd=1&hd-pace=off');
    const view = await goLive(harness);
    const gpu = fakeGpuFrame();
    Object.assign(view.hd, { renderer: { backend: gpu.backend } });
    harness.bridge()!.toggle();
    const result = harness.bridge()!.diagnostics.captureNextDraw();
    await advance(20);
    gpu.resolveMap();
    expect((await result).shown).toBe(false);
    const next = fakeGpuFrame();
    Object.assign(view.hd, { renderer: { backend: next.backend } });
    const pending = harness.bridge()!.diagnostics.captureNextDraw();
    const rejected = expect(pending).rejects.toThrow('disposed');
    await advance(20);
    harness.stop();
    await rejected;
    expect(next.buffer.destroy).toHaveBeenCalledTimes(1);
    next.resolveMap();
    await settle();
    expect(next.buffer.getMappedRange).not.toHaveBeenCalled();
  });

  it('counts distinct delivered logic frames and completed draws, not repeated snapshots or display callbacks', async () => {
    const harness = setup('?hd=1&hd-pace=30');
    const view = await goLive(harness);
    await advance(16, 20);
    const probe = harness.bridge()!.diagnostics;
    expect(probe.enabled).toBe(true);
    expect(probe.shown).toBe(true);
    expect(probe.counters.firstDrawAtMs).not.toBeNull();
    expect(probe.counters.firstShownDrawAtMs).not.toBeNull();
    expect(probe.counters.firstShownDrawAtMs!).toBeGreaterThanOrEqual(probe.counters.firstDrawAtMs!);
    const renderedBefore = view.render.mock.calls.length;
    const capture = probe.startCapture();
    const state = battle(10);
    harness.setState(state);
    await advance(20);
    // Workers reconstruct the unchanged-cells fast reply. A new reference of the same logic frame is not a
    // distinct logic state; the next frame is, even while every map-cell layer remains unchanged.
    harness.setState({ ...state });
    await advance(20);
    harness.setState({ ...state, frame: 11 });
    await advance(20, 3);
    const measured = probe.finishCapture()!;
    expect(measured.startAtMs).toBe(capture.startAtMs);
    expect(measured.endAtMs).toBe(clock);
    expect(measured.distinctStates).toBe(2);
    expect(measured.deliveries).toEqual([
      { atMs: capture.startAtMs + 40, frame: 10, map: 'xmp29u2' },
      { atMs: capture.startAtMs + 80, frame: 11, map: 'xmp29u2' },
    ]);
    expect(measured.drawnFrames).toBe(view.render.mock.calls.length - renderedBefore);
    expect(measured.drawnFrames).toBeGreaterThan(0);
    expect(measured.drawnFrames).toBeLessThan(5);
    expect(measured.shownFrames).toBe(measured.drawnFrames);
    expect(measured.draws.every((draw) => draw.shown)).toBe(true);
    expect(measured.truncated).toBe(false);
    const liveState = probe.state!;
    liveState.objects[0]!.type = 'DETACHED';
    expect(probe.state!.objects[0]!.type).toBe('HTNK');
    measured.deliveries.length = 0;
    expect(probe.capture!.deliveries).toHaveLength(2);
    // Finishing the capture freezes its interval and arrays, while cumulative drawing counters keep advancing.
    const finished = probe.capture;
    await advance(20, 3);
    expect(probe.finishCapture()).toEqual(finished);
    expect(probe.counters.drawnFrames).toBe(view.render.mock.calls.length);
    harness.bridge()!.toggle();
    expect(probe.enabled).toBe(false);
    expect(probe.shown).toBe(false);
    harness.stop();
  });

  it('exposes existing read-only game probes without issuing a new render-state request', async () => {
    const harness = setup();
    const command = { frame: 41 };
    const performanceSample = { frame: 41, sampledAtMs: 1000 };
    const pointer = { x: 123, y: 45 };
    const vmDiagnostics = { sampledAtMs: 1000 };
    const probes = {
      getCommandState: vi.fn(async () => command),
      getGamePerformance: vi.fn(async () => performanceSample),
      getPointerState: vi.fn(async () => pointer),
      getDiagnostics: vi.fn(async () => vmDiagnostics),
    };
    Object.assign(harness.vm, probes);
    const probe = harness.bridge()!.diagnostics;
    expect(await probe.getCommandState()).toBe(command);
    expect(await probe.getGamePerformance()).toBe(performanceSample);
    expect(await probe.getPointerState()).toBe(pointer);
    expect(await probe.getVmDiagnostics()).toBe(vmDiagnostics);
    expect(probes.getDiagnostics).toHaveBeenCalledExactlyOnceWith('sample');
    expect(harness.polls()).toBe(0);
    harness.stop();
  });

  it('copies combat visibility and weapon data without traversing object, map, art or sidebar lists', async () => {
    const harness = setup();
    await goLive(harness);
    const state = battle(42);
    state.shroud = { originX: -1, originY: 2, width: 2, height: 2, cells: new Uint8Array([0, 1, 2, 255]) };
    state.sidebar = hdSidebar();
    const source = { x: 256, y: 512, z: 104 },
      target = { x: 512, y: 768, z: 208 };
    state.effects = {
      anims: [
        {
          id: 4,
          uid: 44,
          type: 'ANY-GAME-TYPE',
          ...source,
          frameCount: 12,
          frame: 3,
          stage: 3,
          buildingAnim: false,
          invisible: false,
          attachedTo: { id: 5, uid: 55, kind: 'vehicle' },
        },
      ],
      particleSystems: [],
      mindControlLinks: [],
      bullets: [{ id: 1, uid: 11, type: 'TEST', ...source, inviso: false }],
      lasers: [{ source, target, innerColor: [255, 0, 0] }],
      electricBolts: [{ source, target, alternateColor: false }],
      radBeams: [
        {
          id: 2,
          type: 'rad',
          source,
          target,
          color: [0, 255, 0],
          period: 20,
          amplitude: 40,
          age: 10,
          sustained: false,
          progress: 0.5,
        },
      ],
      waves: [{ id: 3, uid: 33, type: 'sonic', source, target, intensity: 50, progress: 0.5 }],
    };
    harness.setState(state);
    await advance(20, 2);
    const omittedReads = vi.fn();
    const watch = (object: object, key: string) => {
      const value = Reflect.get(object, key);
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          omittedReads(key);
          return value;
        },
      });
    };
    for (const key of ['map', 'houses', 'objects', 'overlays', 'smudges', 'lighting']) watch(state, key);
    for (const key of ['particleSystems', 'mindControlLinks']) watch(state.effects, key);
    for (const key of ['cameos', 'tabs', 'controls']) watch(state.sidebar, key);
    const probe = harness.bridge()!.diagnostics;
    const polls = harness.polls();
    const copy = probe.combatState!;
    expect(Object.keys(copy).sort()).toEqual(['effects', 'frame', 'shroud', 'sidebar', 'view']);
    expect(copy.frame).toBe(42);
    expect(copy.sidebar).toEqual({
      frame: state.sidebar.frame,
      layout: { sidebar: state.sidebar.layout.sidebar, commandBar: state.sidebar.layout.commandBar },
    });
    expect(Object.keys(copy.effects!).sort()).toEqual([
      'anims',
      'animsTruncated',
      'bullets',
      'electricBolts',
      'lasers',
      'radBeams',
      'waves',
    ]);
    expect(copy.effects!.animsTruncated).toBe(false);
    for (const list of Object.values(copy.effects!).filter(Array.isArray)) expect(list).toHaveLength(1);
    const original = structuredClone(copy);
    copy.view!.x = -999;
    copy.shroud!.cells.fill(0);
    copy.sidebar!.frame.width = 1;
    copy.sidebar!.layout.sidebar.x = -1;
    copy.sidebar!.layout.commandBar!.y = -1;
    copy.effects!.bullets[0]!.inviso = true;
    copy.effects!.anims[0]!.x = -1;
    copy.effects!.anims[0]!.type = 'DETACHED';
    copy.effects!.anims[0]!.attachedTo!.uid = -1;
    copy.effects!.lasers[0]!.source.x = -1;
    copy.effects!.electricBolts[0]!.target.y = -1;
    copy.effects!.radBeams![0]!.source.z = -1;
    copy.effects!.waves![0]!.target.x = -1;
    expect(probe.combatState).toEqual(original);
    expect(omittedReads).not.toHaveBeenCalled();
    expect(harness.polls()).toBe(polls);
    harness.stop();
  });

  it('bounds detached animation diagnostics and exposes truncation without filtering game type IDs', async () => {
    const harness = setup();
    await goLive(harness);
    const state = battle(42);
    const anims = Array.from({ length: 8193 }, (_, id) => ({
      id,
      uid: id + 1,
      type: `TYPE-${id}`,
      x: 256,
      y: 512,
      z: 104,
      frameCount: 12,
      buildingAnim: id % 2 === 0,
      invisible: id % 3 === 0,
    }));
    state.effects = { anims, bullets: [], lasers: [], electricBolts: [], particleSystems: [] };
    harness.setState(state);
    await advance(20, 2);
    const probe = harness.bridge()!.diagnostics;
    const polls = harness.polls();
    const copy = probe.combatState!;
    expect(copy.effects!.anims).toHaveLength(8192);
    expect(copy.effects!.animsTruncated).toBe(true);
    expect(copy.effects!.anims[0]).toMatchObject({ type: 'TYPE-0', invisible: true, buildingAnim: true });
    expect(copy.effects!.anims.at(-1)!.type).toBe('TYPE-8191');
    copy.effects!.anims[0]!.uid = -1;
    expect(anims[0]!.uid).toBe(1);
    expect(state.effects.anims).toHaveLength(8193);
    expect(harness.polls()).toBe(polls);
    harness.stop();
  });

  it('keeps unavailable combat fields and missing optional weapon readers unavailable', async () => {
    const harness = setup();
    const probe = harness.bridge()!.diagnostics;
    expect(probe.combatState).toBeNull();
    await goLive(harness);
    expect(probe.combatState).toMatchObject({ frame: 2, shroud: null, sidebar: null, effects: null });
    harness.setState({
      ...battle(3),
      view: null,
      effects: { anims: [], particleSystems: [], bullets: [], lasers: [], electricBolts: [] },
    });
    await advance(20, 2);
    expect(probe.combatState!.view).toBeNull();
    expect(probe.combatState!.effects).toEqual({
      anims: [],
      animsTruncated: false,
      bullets: [],
      lasers: [],
      electricBolts: [],
      radBeams: undefined,
      waves: undefined,
    });
    harness.setState(null);
    await advance(20, 2);
    expect(probe.combatState).toBeNull();
    harness.stop();
  });

  it('bounds forgotten capture records while preserving the distinct-state count', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1000);
    const harness = setup('?hd=1', 'WebGL2', 'native');
    vi.mocked(performance.now).mockImplementation(() => Date.now());
    liveView.create.mockReturnValue(new Promise(() => {}));
    let nextFrame = 1;
    harness.vm.getRenderState.mockImplementation(async () => battle(nextFrame++));
    await settle();
    const probe = harness.bridge()!.diagnostics;
    probe.startCapture();
    // No display callbacks or ready art: native arrival accounting still runs, with a fixed storage bound.
    await vi.advanceTimersByTimeAsync(350_000);
    const measured = probe.finishCapture()!;
    expect(measured.distinctStates).toBeGreaterThan(20_000);
    expect(measured.deliveries).toHaveLength(20_000);
    expect(measured.truncated).toBe(true);
    expect(measured.draws).toHaveLength(0);
    expect(probe.counters.drawnFrames).toBe(0);
    harness.stop();
  });
});

describe('submitted WebGPU frame readback ownership', () => {
  it('rejects unbounded caller timeouts without owning a request or allocating a buffer', async () => {
    const gpu = fakeGpuFrame();
    const capture = createWebGpuFrameCapture(() => ({ backend: gpu.backend, metadata: null }));
    for (const timeoutMs of [49, 10001, NaN, Infinity])
      await expect(capture.request(timeoutMs)).rejects.toThrow('between 50 and 10000');
    capture.draw(null);
    expect(gpu.device.createBuffer).not.toHaveBeenCalled();
    const result = capture.request(50);
    capture.draw(null);
    gpu.resolveMap();
    expect((await result).pixels).toHaveLength(16);
    capture.dispose();
  });

  it('releases a short expired request and isolates its late reply from the next request', async () => {
    vi.useFakeTimers();
    const old = fakeGpuFrame();
    const next = fakeGpuFrame(1, 1, 'rgba8unorm');
    let gpu = old;
    const capture = createWebGpuFrameCapture((frame: number) => ({ backend: gpu.backend, metadata: frame }));
    const result = capture.request(500);
    const rejected = expect(result).rejects.toThrow('timed out');
    capture.draw(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(old.buffer.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(old.buffer.destroy).toHaveBeenCalledTimes(1);
    gpu = next;
    const replacement = capture.request(50);
    capture.draw(2);
    old.resolveMap();
    await settle();
    expect(old.buffer.getMappedRange).not.toHaveBeenCalled();
    next.resolveMap();
    expect((await replacement).metadata).toBe(2);
    expect(next.buffer.destroy).toHaveBeenCalledTimes(1);
    capture.dispose();
  });

  it('submits synchronously before awaiting mapping, removes row padding, and preserves BGRA alpha', async () => {
    const gpu = fakeGpuFrame();
    gpu.bytes.fill(0xee);
    gpu.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    gpu.bytes.set([9, 10, 11, 12, 13, 14, 15, 16], gpu.bytesPerRow);
    const source = vi.fn((metadata: { frame: number }) => ({ backend: gpu.backend, metadata }));
    const capture = createWebGpuFrameCapture(source);
    capture.draw({ frame: 0 });
    expect(source).not.toHaveBeenCalled();
    const result = capture.request();
    capture.draw({ frame: 7 });
    expect(gpu.events).toEqual(['copy', 'submit', 'map']);
    expect(gpu.device.createBuffer).toHaveBeenCalledWith({ label: 'HD next-draw readback', size: 512, usage: 9 });
    expect(gpu.encoder.copyTextureToBuffer).toHaveBeenCalledWith(
      { texture: gpu.texture },
      { buffer: gpu.buffer, bytesPerRow: 256, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    );
    gpu.resolveMap();
    const image = await result;
    expect(Array.from(image.pixels)).toEqual([3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12, 15, 14, 13, 16]);
    expect(image.metadata).toEqual({ frame: 7 });
    expect(gpu.buffer.unmap).toHaveBeenCalledTimes(1);
    expect(gpu.buffer.destroy).toHaveBeenCalledTimes(1);
    capture.dispose();
  });

  it('preserves RGBA bytes and refuses overlapping requests while a readback is mapping', async () => {
    const gpu = fakeGpuFrame(1, 1, 'rgba8unorm-srgb');
    gpu.bytes.set([17, 29, 53, 71]);
    const capture = createWebGpuFrameCapture(() => ({ backend: gpu.backend, metadata: null }));
    const first = capture.request();
    capture.draw(null);
    await expect(capture.request()).rejects.toThrow('already pending');
    capture.draw(null);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(1);
    gpu.resolveMap();
    expect(Array.from((await first).pixels)).toEqual([17, 29, 53, 71]);
    capture.dispose();
    await expect(capture.request()).rejects.toThrow('disposed');
  });

  it.each([
    { change: { width: 0 }, error: 'dimensions' },
    { change: { width: 10001, height: 1000 }, error: 'dimensions' },
    { change: { format: 'rgba16float' }, error: 'format' },
    { change: { usage: 16 }, error: 'COPY_SRC' },
    { change: { sampleCount: 4 }, error: 'dimensions' },
  ])('rejects unsupported source properties $change before allocating a buffer', async ({ change, error }) => {
    const gpu = fakeGpuFrame();
    Object.assign(gpu.texture, change);
    const capture = createWebGpuFrameCapture(() => ({ backend: gpu.backend, metadata: null }));
    const result = capture.request();
    const rejected = expect(result).rejects.toThrow(error);
    capture.draw(null);
    await rejected;
    expect(gpu.device.createBuffer).not.toHaveBeenCalled();
    capture.dispose();
  });

  it('rejects GPU validation and mapping failures and releases each buffer', async () => {
    for (const failure of ['validation', 'mapping']) {
      const gpu = fakeGpuFrame();
      if (failure === 'validation') gpu.device.popErrorScope.mockResolvedValue({ message: 'invalid copy' });
      else gpu.buffer.mapAsync.mockRejectedValue(new Error('device lost'));
      const capture = createWebGpuFrameCapture(() => ({ backend: gpu.backend, metadata: null }));
      const result = capture.request();
      const rejected = expect(result).rejects.toThrow(failure === 'validation' ? 'invalid copy' : 'device lost');
      capture.draw(null);
      gpu.resolveMap();
      await rejected;
      expect(gpu.buffer.destroy).toHaveBeenCalledTimes(1);
      capture.dispose();
    }
  });

  it('rejects absent draws or stalled mapping after ten seconds and ignores late replies', async () => {
    vi.useFakeTimers();
    const gpu = fakeGpuFrame();
    const capture = createWebGpuFrameCapture(() => ({ backend: gpu.backend, metadata: null }));
    const result = capture.request();
    const rejected = expect(result).rejects.toThrow('timed out');
    capture.draw(null);
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(gpu.buffer.destroy).toHaveBeenCalledTimes(1);
    gpu.resolveMap();
    await settle();
    expect(gpu.buffer.getMappedRange).not.toHaveBeenCalled();
    const waiting = createWebGpuFrameCapture(() => null);
    const missing = waiting.request();
    const absent = expect(missing).rejects.toThrow('timed out');
    waiting.draw(null);
    await vi.advanceTimersByTimeAsync(10000);
    await absent;
    capture.dispose();
    waiting.dispose();
  });

  it('cancels an old view without letting its late map reply affect a new request', async () => {
    const old = fakeGpuFrame();
    const next = fakeGpuFrame(1, 1, 'rgba8unorm');
    let gpu = old;
    const capture = createWebGpuFrameCapture((frame: number) => ({ backend: gpu.backend, metadata: frame }));
    const abandoned = capture.request();
    const rejected = expect(abandoned).rejects.toThrow('view replaced');
    capture.draw(1);
    capture.cancel('view replaced');
    await rejected;
    gpu = next;
    const result = capture.request();
    capture.draw(2);
    old.resolveMap();
    await settle();
    expect(old.buffer.getMappedRange).not.toHaveBeenCalled();
    next.resolveMap();
    expect((await result).metadata).toBe(2);
    expect(old.buffer.destroy).toHaveBeenCalledTimes(1);
    expect(next.buffer.destroy).toHaveBeenCalledTimes(1);
    capture.dispose();
  });
});

describe('HD bridge canvas layout', () => {
  it('covers the tactical rectangle on whole device pixels with one buffer pixel per device pixel', async () => {
    const harness = setup();
    // A 1728x1080 game fitted at two device pixels per game pixel on a DPR-2 display, 20.25 CSS px from the top.
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
    Object.assign(harness.screen, {
      offsetParent: { getBoundingClientRect: () => ({ left: 0, top: 0 }), clientLeft: 0, clientTop: 0 },
      getBoundingClientRect: () => ({ left: 0, top: 20.25, width: 800, height: 600 }),
    });
    const view = fakeView();
    await goLive(harness, view);
    await advance(16);
    // 800x600 frame shown at 800x600 CSS px = 2 device px per game px; the tactical view is 632x568 game px.
    expect(view.resizePixels).toHaveBeenLastCalledWith(1264, 1136, 632, 568);
    // The top edge is rounded to a whole device pixel (40.5 -> 41 device px = 20.5 CSS px).
    expect(harness.hdCanvas.style).toMatchObject({ left: '0px', top: '20.5px', width: '632px', height: '568px' });
    harness.stop();
  });

  it('keeps a fractional fit on whole device pixels and renders a huge rectangle at the pixel budget', async () => {
    const harness = setup();
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
    Object.assign(harness.screen, {
      offsetParent: { getBoundingClientRect: () => ({ left: 10, top: 0 }), clientLeft: 0, clientTop: 0 },
      // 800x600 frame at 2.903 device px per game px: nothing lands on whole pixels by itself.
      getBoundingClientRect: () => ({ left: 28, top: 0, width: 1161.2, height: 870.9 }),
    });
    const view = fakeView();
    await goLive(harness, view);
    await advance(16);
    const [bufferWidth, bufferHeight, viewWidth, viewHeight] = view.resizePixels.mock.lastCall as number[];
    expect([viewWidth, viewHeight]).toEqual([632, 568]);
    expect(Number.isInteger(bufferWidth) && Number.isInteger(bufferHeight)).toBe(true);
    expect(harness.hdCanvas.style.width).toBe(`${bufferWidth! / 2}px`);
    expect(harness.hdCanvas.style.height).toBe(`${bufferHeight! / 2}px`);
    expect(harness.hdCanvas.style.left).toBe('18px');
    // A 6400x4800 device-pixel rectangle is over the budget: the buffer shrinks, the CSS box does not.
    Object.assign(harness.screen, { getBoundingClientRect: () => ({ left: 10, top: 0, width: 4050.7, height: 3038 }) });
    await advance(16);
    const [width, height] = view.resizePixels.mock.lastCall as number[];
    expect(width! * height!).toBeLessThanOrEqual(10_000_000 * 1.001);
    expect(width! / height!).toBeCloseTo(632 / 568, 2);
    expect(Number.parseFloat(harness.hdCanvas.style.width!)).toBeCloseTo((4050.7 * 632) / 800, 0);
    harness.stop();
  });
});

describe('HD bridge look parameters', () => {
  it.each([
    ['', 'ignore'],
    ['&hd-native-detail=mirror', 'mirror'],
    ['&hd-native-detail=ignore', 'ignore'],
    ['&hd-native-detail=invalid', 'ignore'],
  ])('passes native detail review mode from %s', async (query, nativeDetail) => {
    const harness = setup(`?hd=1${query}`);
    await goLive(harness);
    expect(liveView.create).toHaveBeenCalledWith(harness.hdCanvas, expect.objectContaining({ nativeDetail }));
    harness.stop();
  });
  it('applies the cinematic preset and vehicle options before the first snapshot push and render', async () => {
    const harness = setup('?hd=1&hd-look=cinematic&hd-vlook=remaster&hd-vproj=/vehicles-hd/');
    const view = fakeLookView();
    await goLive(harness, view);
    await advance(16);
    expect(liveView.create).toHaveBeenCalledWith(
      harness.hdCanvas,
      expect.objectContaining({ dayHour: 16.5, voxelLook: 'remaster', voxelProjection: '/hd-cache/vehicles-hd' }),
    );
    // The preset hour stages day maps only; dusk and night maps keep their own [Lighting] hour.
    expect(liveView.create.mock.calls[0]![1]).not.toHaveProperty('timeOfDay');
    expect(hdRenderer.applyLookPreset).toHaveBeenCalledExactlyOnceWith(view.hd.settings, 'cinematic');
    expect(view.hd.applySettings).toHaveBeenCalledTimes(1);
    expect(view.push).toHaveBeenCalledTimes(1);
    expect(view.render).toHaveBeenCalled();
    expect(hdRenderer.applyLookPreset.mock.invocationCallOrder[0]).toBeLessThan(
      view.hd.applySettings.mock.invocationCallOrder[0]!,
    );
    expect(view.hd.applySettings.mock.invocationCallOrder[0]).toBeLessThan(view.push.mock.invocationCallOrder[0]!);
    expect(view.hd.applySettings.mock.invocationCallOrder[0]).toBeLessThan(view.render.mock.invocationCallOrder[0]!);
    harness.stop();
  });

  it('lets hd-time override the preset hour', async () => {
    const harness = setup('?hd=1&hd-look=cinematic&hd-time=12');
    const view = fakeLookView();
    await goLive(harness, view);
    expect(liveView.create).toHaveBeenCalledWith(
      harness.hdCanvas,
      expect.objectContaining({ timeOfDay: 12, dayHour: 16.5 }),
    );
    expect(hdRenderer.applyLookPreset).toHaveBeenCalledWith(view.hd.settings, 'cinematic');
    expect(view.hd.applySettings).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('ignores unknown looks, engine voxel look and traversal in the projection directory', async () => {
    const harness = setup('?hd=1&hd-look=neon&hd-vlook=engine&hd-vproj=../x');
    await goLive(harness);
    const options = liveView.create.mock.calls[0]![1];
    expect(options).not.toHaveProperty('timeOfDay');
    expect(options).not.toHaveProperty('dayHour');
    expect(options).not.toHaveProperty('voxelLook');
    expect(options).not.toHaveProperty('voxelProjection');
    expect(hdRenderer.applyLookPreset).not.toHaveBeenCalled();
    harness.stop();
  });

  it('keeps map staging when the faithful preset has no suggested hour', async () => {
    const harness = setup('?hd=1&hd-look=faithful');
    const view = fakeLookView();
    await goLive(harness, view);
    expect(liveView.create.mock.calls[0]![1]).not.toHaveProperty('timeOfDay');
    expect(liveView.create.mock.calls[0]![1]).not.toHaveProperty('dayHour');
    expect(hdRenderer.applyLookPreset).toHaveBeenCalledWith(view.hd.settings, 'faithful');
    expect(view.hd.applySettings).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it.each([
    ['  /vehicles-hd/  ', '/hd-cache/vehicles-hd'],
    ['', undefined],
    ['  ///  ', undefined],
    ['vehicles..hd', undefined],
    ['vehicles\\hd', undefined],
    ['https://example', undefined],
  ])('sanitizes the projection directory %j', async (directory, expected) => {
    const harness = setup(`?hd=1&hd-vproj=${encodeURIComponent(directory!)}`);
    await goLive(harness);
    const options = liveView.create.mock.calls[0]![1];
    if (expected === undefined) expect(options).not.toHaveProperty('voxelProjection');
    else expect(options.voxelProjection).toBe(expected);
    expect(hdRenderer.applyLookPreset).not.toHaveBeenCalled();
    harness.stop();
  });
});

describe('HD 桥状态机', () => {
  it('forwards same-frame turret art changes, including zero and unknown', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    state.objects = [
      {
        id: 1,
        uid: 11,
        kind: 'vehicle',
        type: 'FV',
        owner: 0,
        x: 100,
        y: 200,
        z: 0,
        facingRaw: 0,
        turretFacingRaw: 0x4000,
        health: 1,
        isSelected: true,
      },
    ];
    for (const turretIndex of [0, 2, 0, 1, 3, undefined]) {
      if (turretIndex === undefined) delete state.objects[0]!.turretIndex;
      else state.objects[0]!.turretIndex = turretIndex;
      harness.setState({ ...state });
      await advance(16);
      const object = view.push.mock.calls.at(-1)![0].objects[0];
      expect(object).toMatchObject({ type: 'FV', turretFacingRaw: 0x4000 });
      if (turretIndex === undefined) expect(object).not.toHaveProperty('turretIndex');
      else expect(object.turretIndex).toBe(turretIndex);
    }
    harness.stop();
  });

  it('forwards native body visibility and opacity, including same-frame changes and absent fields', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    state.objects = [
      {
        id: 1,
        uid: 11,
        kind: 'vehicle',
        type: 'HTNK',
        owner: 0,
        x: 100,
        y: 200,
        z: 0,
        facingRaw: 0,
        health: 1,
        isSelected: true,
        nativeHidden: true,
        translucent: 0.5,
        tint: { light: 0.2, add: [0, 0, 24 / 31] },
        underlay: { art: 'OREGATH', frame: 47, x: 100, y: 230, z: 0 },
        cargo: { ore: 3, gems: 12 },
      },
    ];
    harness.setState(state);
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].objects[0]).toMatchObject({
      nativeHidden: true,
      translucent: 0.5,
      underlay: { art: 'OREGATH', frame: 47, x: 100, y: 230, z: 0 },
      isSelected: true,
    });
    expect(view.push.mock.calls.at(-1)![0].objects[0].underlay).not.toBe(state.objects[0]!.underlay);
    expect(view.push.mock.calls.at(-1)![0].objects[0].cargo).toEqual({ ore: 3, gems: 12 });
    expect(view.push.mock.calls.at(-1)![0].objects[0].cargo).not.toBe(state.objects[0]!.cargo);
    expect(view.push.mock.calls.at(-1)![0].objects[0].tint).toEqual({ light: 0.2, add: [0, 0, 24 / 31] });
    expect(view.push.mock.calls.at(-1)![0].objects[0].tint).not.toBe(state.objects[0]!.tint);

    state.objects[0]!.nativeHidden = false;
    state.objects[0]!.translucent = 0;
    harness.setState({ ...state });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].objects[0]).toMatchObject({ nativeHidden: false, translucent: 0 });

    delete state.objects[0]!.nativeHidden;
    delete state.objects[0]!.translucent;
    delete state.objects[0]!.underlay;
    delete state.objects[0]!.cargo;
    delete state.objects[0]!.tint;
    harness.setState({ ...state });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('tint');
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('underlay');
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('cargo');
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('nativeHidden');
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('translucent');
    harness.stop();
  });

  it('forwards same-frame scene lighting changes and clears an unknown read', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    state.lighting = {
      ambient: 0.87,
      ground: 0,
      level: 0,
      tint: [1, 0.8, 0.68],
      override: [0.3, 0.4, 0.75],
      event: 'storm',
      storm: { active: true, pending: false, ending: false, cell: { x: 60, y: 62 } },
    };
    harness.setState(state);
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].lighting).toEqual(state.lighting);
    harness.setState({ ...state, lighting: { ...state.lighting, ambient: 1, override: null, event: null } });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].lighting).toMatchObject({ ambient: 1, override: null, event: null });
    harness.setState({ ...state, lighting: null });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].lighting).toBeNull();
    harness.stop();
  });

  it('forwards engine image and H2 animation fields and keeps absent fields optional', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    state.nativeDetail = { fps: 14, lowFrameRate: true, level: 2 };
    const common = {
      owner: 0,
      x: 100,
      y: 200,
      z: 0,
      facingRaw: 0,
      health: 1,
      isSelected: false,
    };
    state.objects = [
      {
        ...common,
        id: 1,
        uid: 11,
        kind: 'building',
        type: 'NAHAND',
        buildState: 'selling',
        buildupFrame: 0,
        buildingFrame: 0,
        buildingDamaged: false,
        contactUid: 0,
        dock: false,
        unloading: 'door',
        activeAnim: 'detail',
      },
      {
        ...common,
        id: 2,
        uid: 12,
        kind: 'infantry',
        type: 'E1',
        infantrySequence: 'Deployed',
        sequenceFrame: 0,
        infantryDrawFacingRaw: 0,
      },
      { ...common, id: 3, uid: 13, kind: 'vehicle', type: 'HARV', imageType: 'HORV' },
      { ...common, id: 4, uid: 14, kind: 'vehicle', type: 'CMIN' },
    ];
    harness.setState(state);
    await advance(16);
    const pushed = view.push.mock.calls.at(-1)![0];
    expect(pushed.nativeDetail).toEqual(state.nativeDetail);
    expect(pushed.objects[0]).toMatchObject({
      buildingFrame: 0,
      buildingDamaged: false,
      contactUid: 0,
      dock: false,
      unloading: 'door',
    });
    expect(pushed.objects).toEqual(state.objects);
    expect(pushed.objects[2]).not.toHaveProperty('buildState');
    expect(pushed.objects[2]).not.toHaveProperty('sequenceFrame');
    expect(pushed.objects[2]).not.toHaveProperty('activeAnim');
    expect(pushed.objects[2]).toMatchObject({ type: 'HARV', imageType: 'HORV' });
    expect(pushed.objects[3]).not.toHaveProperty('contactUid');
    expect(pushed.objects[3]).not.toHaveProperty('dock');
    expect(pushed.objects[3]).not.toHaveProperty('unloading');
    expect(pushed.objects[3]).not.toHaveProperty('imageType');
    delete state.objects[2]!.imageType;
    delete state.objects[0]!.activeAnim;
    delete state.nativeDetail;
    harness.setState({ ...state });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].objects[2]).not.toHaveProperty('imageType');
    expect(view.push.mock.calls.at(-1)![0].objects[0]).not.toHaveProperty('activeAnim');
    expect(view.push.mock.calls.at(-1)![0]).not.toHaveProperty('nativeDetail');
    harness.stop();
  });

  it('forwards same-frame death progress and native effect stages, then an empty effect publication', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(20);
    state.objects = [
      {
        id: 1,
        uid: 1,
        kind: 'infantry',
        type: 'TEST',
        owner: 0,
        x: 0,
        y: 0,
        z: 0,
        facingRaw: 0,
        health: 0,
        isSelected: false,
        infantrySequence: 'Die1',
        sequenceFrame: 0,
      },
    ];
    const effect = {
      id: 2,
      uid: 2,
      type: 'TEST',
      x: 0,
      y: 0,
      z: 0,
      frameCount: 15,
      frame: 8,
      stage: 8,
      buildingAnim: false,
      invisible: false,
      translucent: true,
      translucency: 25,
    };
    state.effects = {
      anims: [effect, { ...effect, uid: 3, buildingAnim: true }],
      bullets: [],
      lasers: [],
      electricBolts: [],
      particleSystems: [],
      radBeams: [
        {
          id: 40,
          type: 'rad',
          source: { x: 256, y: 512, z: 104 },
          target: { x: 512, y: 768, z: 208 },
          color: [30, 255, 70],
          period: 20,
          amplitude: 40,
          age: 10,
          progress: 0.5,
          sustained: false,
        },
      ],
      waves: [
        {
          id: 41,
          uid: 42,
          type: 'sonic',
          source: { x: 256, y: 512, z: 104 },
          target: { x: 512, y: 768, z: 208 },
          intensity: 50,
          progress: 0.5,
        },
      ],
      mindControlLinks: [
        {
          id: 43,
          controller: 44,
          targetId: 45,
          source: { x: 256, y: 512, z: 135 },
          target: { x: 512, y: 768, z: 168 },
          color: [200, 20, 255],
          arcHeight: 512,
          remainingFrames: 0,
          selected: true,
        },
      ],
    };
    harness.setState(state);
    await advance(16);
    const next = structuredClone(state);
    next.objects[0]!.sequenceFrame = 2;
    next.effects!.anims[0]!.frame = 10;
    harness.setState(next);
    await advance(16);
    const pushed = view.push.mock.calls.at(-1)![0];
    expect(pushed.objects[0]).toMatchObject({ health: 0, infantrySequence: 'Die1', sequenceFrame: 2 });
    expect(pushed.effects!.anims[0]).toMatchObject({ frame: 10, stage: 8, translucency: 25 });
    expect(pushed.effects!.anims[1]!.buildingAnim).toBe(true);
    expect(pushed.effects!.radBeams).toEqual(state.effects!.radBeams);
    expect(pushed.effects!.waves).toEqual(state.effects!.waves);
    expect(pushed.effects!.mindControlLinks).toEqual(state.effects!.mindControlLinks);
    harness.setState({ ...next, effects: { ...next.effects!, anims: [], mindControlLinks: [] } });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].effects!.anims).toEqual([]);
    expect(view.push.mock.calls.at(-1)![0].effects!.mindControlLinks).toEqual([]);
    harness.stop();
  });

  it('forwards optional native painter order without inventing metadata for older snapshots', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    const object = {
      id: 1,
      uid: 2,
      kind: 'infantry' as const,
      type: 'SHK',
      owner: 0,
      x: 13248,
      y: 20544,
      z: 208,
      facingRaw: 0,
      health: 1,
      isSelected: false,
    };
    state.objects = [
      { ...object, renderOrder: { layer: 2, index: 3, ySort: 33792 } },
      { ...object, id: 3, uid: 4 },
    ];
    harness.setState(state);
    await advance(16);
    const pushed = view.push.mock.calls.at(-1)![0];
    expect(pushed.objects[0].renderOrder).toEqual({ layer: 2, index: 3, ySort: 33792 });
    expect(pushed.objects[1]).not.toHaveProperty('renderOrder');
    harness.stop();
  });

  it('forwards independent live overlays, smudges and the local house without copying the cell arrays', async () => {
    const harness = setup();
    const view = await goLive(harness);
    const state = battle(3);
    state.localHouse = 2;
    state.overlays = {
      originX: 1,
      originY: 2,
      width: 2,
      height: 1,
      index: new Int16Array([0, -1]),
      data: new Uint8Array([7, 0]),
      types: ['GAWALL'],
      revision: 3,
    };
    state.smudges = { ...state.overlays, types: ['CR1'], data: new Uint8Array([2, 0]) };
    state.overlays.rubble = [{ slot: 0, type: 'SOURCE' }];
    harness.setState(state);
    await advance(16);
    const pushed = view.push.mock.calls.at(-1)![0];
    expect(pushed.localHouse).toBe(2);
    expect(pushed.overlays).toBe(state.overlays);
    expect(pushed.overlays.rubble).toBe(state.overlays.rubble);
    expect(pushed.smudges).not.toHaveProperty('rubble');
    expect(pushed.smudges).toBe(state.smudges);
    harness.setState({ ...state, frame: 4, overlays: null, smudges: null });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].overlays).toBeNull();
    expect(view.push.mock.calls.at(-1)![0].smudges).toBeNull();
    harness.stop();
  });
  it('游戏接受直通：只让键色透明，关闭后键色保留一小段再清除', async () => {
    const harness = setup();
    const view = await goLive(harness);
    expect(liveView.create).toHaveBeenCalledWith(
      harness.hdCanvas,
      expect.objectContaining({ mapBase: '/hd-cache/XMP29U2', libraryBase: '/hd-cache/_library' }),
    );
    expect(view.push).toHaveBeenCalledTimes(1);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(7);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    expect(harness.renderer.setTransparentRect).toHaveBeenLastCalledWith(null);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.bridge()?.passthrough).toEqual({ flags: 7, unsupported: false, keyed: true });
    // Readers return the identical object while nothing changed; it is not projected and pushed again.
    await advance(16);
    expect(view.push).toHaveBeenCalledTimes(1);
    harness.setState(battle(3));
    await advance(16);
    expect(view.push).toHaveBeenCalledTimes(2);

    // A shell page takes over: passthrough goes off, but frames already rendered may still carry the key colour.
    harness.setState(null);
    await advance(16);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(0);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    await advance(600);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    expect(harness.renderer.setTransparentRect).toHaveBeenLastCalledWith(null);
    expect(harness.hdCanvas.style.display).toBe('none');
    harness.stop();
  });

  it('游戏拒绝直通：退回整个战术区透明', async () => {
    const harness = setup();
    harness.vm.setTacticalPassthrough.mockResolvedValue(false);
    await goLive(harness);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledWith(7);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    expect(harness.renderer.setTransparentRect).toHaveBeenLastCalledWith(TACTICAL);
    expect(harness.bridge()?.passthrough).toEqual({ flags: 0, unsupported: true, keyed: false });
    harness.stop();
    // Nothing was switched on in the guest, so cleanup has nothing to switch off.
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledTimes(1);
  });

  it('不含地形的类别组合没有键色像素：请求这些类别，但用透明矩形', async () => {
    const harness = setup('?hd=1&hd-passthrough=objects,effects');
    await goLive(harness);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(6);
    expect(harness.renderer.setTransparentRect).toHaveBeenLastCalledWith(TACTICAL);
    expect(harness.renderer.setTransparentKey.mock.calls.every(([key]) => key === null)).toBe(true);
    expect(harness.bridge()?.passthrough.keyed).toBe(false);
    harness.stop();
  });

  it('停止时关闭直通、清除透明状态并释放视图；之后到达的回复不再生效', async () => {
    const harness = setup();
    const view = await goLive(harness);
    // Worker replies cross threads, so a poll is usually in flight when the page stops the bridge.
    let resolvePoll!: (state: GameRenderState | null) => void;
    harness.vm.getRenderState.mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)));
    await advance(16);
    const passthroughCalls = harness.vm.setTacticalPassthrough.mock.calls.length;

    harness.stop();
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(0);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    expect(harness.renderer.setTransparentRect).toHaveBeenLastCalledWith(null);
    expect(view.dispose).toHaveBeenCalledTimes(1);
    expect(harness.hdCanvas.remove).toHaveBeenCalledTimes(1);
    expect(harness.screen.style).toEqual({ position: 'static', zIndex: '' });
    expect(harness.bridge()).toBeUndefined();

    const keyCalls = harness.renderer.setTransparentKey.mock.calls.length;
    resolvePoll(battle(9));
    await settle();
    await advance(16, 3);
    expect(view.push).toHaveBeenCalledTimes(1);
    expect(harness.renderer.setTransparentKey).toHaveBeenCalledTimes(keyCalls);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledTimes(passthroughCalls + 1);
    // goLive: the load, the match snapshot, the frame that shows the view; then the poll left in flight.
    expect(harness.polls()).toBe(4);
    harness.stop();
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledTimes(passthroughCalls + 1);
  });

  it('停止后到达的直通确认和失败的轮询不再触碰渲染器', async () => {
    const harness = setup();
    let accept!: (accepted: boolean) => void;
    harness.vm.setTacticalPassthrough.mockImplementationOnce(() => new Promise((resolve) => (accept = resolve)));
    await goLive(harness);
    let rejectPoll!: (error: Error) => void;
    harness.vm.getRenderState.mockImplementationOnce(() => new Promise((_, reject) => (rejectPoll = reject)));
    await advance(16);
    harness.stop();
    const keyCalls = harness.renderer.setTransparentKey.mock.calls.length;
    const rectCalls = harness.renderer.setTransparentRect.mock.calls.length;
    accept(true);
    rejectPoll(new Error('VM destroyed'));
    await settle();
    expect(harness.renderer.setTransparentKey).toHaveBeenCalledTimes(keyCalls);
    expect(harness.renderer.setTransparentRect).toHaveBeenCalledTimes(rectCalls);
    expect(harness.vm.setTacticalPassthrough.mock.calls.map(([flags]) => flags)).toEqual([7, 0]);
  });

  it('停止时仍在加载的视图创建后立即释放', async () => {
    const harness = setup();
    const view = fakeView();
    let finishLoad!: (value: ReturnType<typeof fakeView>) => void;
    liveView.create.mockImplementation(() => new Promise((resolve) => (finishLoad = resolve)));
    harness.setState(battle(1));
    await advance(16);
    await vi.waitFor(() => expect(liveView.create).toHaveBeenCalledTimes(1));
    harness.stop();
    finishLoad(view);
    await vi.waitFor(() => expect(view.dispose).toHaveBeenCalledTimes(1));
    expect(view.push).not.toHaveBeenCalled();
  });

  it('快照用不上时低频轮询：无缓存的地图、关闭 HD 视图、VM 不应答', async () => {
    const harness = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveView.create.mockRejectedValue(new Error('no cache'));
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(harness.polls()).toBe(1);
    await advance(16, 30);
    expect(harness.polls()).toBe(1);
    await advance(16, 40);
    expect(harness.polls()).toBe(2);
    // A failed map is not fetched again on every poll.
    expect(liveView.create).toHaveBeenCalledTimes(1);

    // The HD view is live again once a cached map is played.
    const view = fakeView();
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(1000);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    let polls = harness.polls();
    await advance(16.7, 5);
    expect(harness.polls()).toBe(polls + 5);
    // 144 Hz display: every third frame, not every frame.
    polls = harness.polls();
    await advance(1000 / 144, 6);
    expect(harness.polls()).toBe(polls + 2);

    // Toggled off: nothing to show, so poll only to keep track of the map; toggled on: full rate right away.
    expect(harness.bridge()?.toggle()).toBe(false);
    polls = harness.polls();
    await advance(16.7, 70);
    expect(harness.polls()).toBe(polls + 1);
    expect(harness.bridge()?.toggle()).toBe(true);
    polls = harness.polls();
    await advance(16.7, 3);
    expect(harness.polls()).toBe(polls + 3);

    // A VM that stops answering is not hammered every frame.
    harness.vm.getRenderState.mockRejectedValue(new Error('VM destroyed'));
    await advance(16.7);
    polls = harness.polls();
    await advance(16.7, 40);
    expect(harness.polls()).toBe(polls);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    harness.stop();
  });

  it('加载失败的地图不逐次重试：等待一段时间后或新一局时再加载，页面无需刷新', async () => {
    const harness = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveView.create.mockRejectedValue(new Error('no cache'));
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]![0]).toContain('pnpm hd:prepare -- --map NOCACHE');
    // Idle polls within the wait leave the failed map alone.
    await advance(1000, 25);
    expect(harness.polls()).toBeGreaterThanOrEqual(25);
    expect(liveView.create).toHaveBeenCalledTimes(1);
    // After the wait (the cache may have been built meanwhile) one idle poll tries again, and fails again here.
    await advance(1000, 6);
    expect(liveView.create).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));

    // The logic frame moving on is the same match; starting over is a new one and retries at once.
    harness.setState(battle(40, 'NOCACHE.MAP'));
    await advance(1000);
    expect(liveView.create).toHaveBeenCalledTimes(2);
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(1000);
    expect(liveView.create).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));

    // So is coming back from outside a battle; this time the cache is there and the HD view goes live.
    harness.setState(null);
    await advance(1000);
    const view = fakeView();
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(1000);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    expect(liveView.create).toHaveBeenCalledTimes(4);
    harness.stop();
  });

  it('Canvas 2D 帧渲染器无法合成：不启动', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = setup('?hd=1', 'Canvas 2D');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WebGL2'));
    expect(harness.createElement).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
    expect(harness.bridge()).toBeUndefined();
    harness.stop();
    expect(harness.vm.getRenderState).not.toHaveBeenCalled();
    expect(harness.vm.setTacticalPassthrough).not.toHaveBeenCalled();
  });
});

describe('HD bridge fallback notice', () => {
  /** What the loader throws for a map directory that is not in the cache (see MapCacheMissingError). */
  function missingCache(): Error {
    return Object.assign(new Error('no HD cache'), { name: 'MapCacheMissingError' });
  }

  it('没有高清素材的地图：显示原版画面并在屏幕上说明，一局只说一次，到时收起', async () => {
    const harness = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveView.create.mockRejectedValue(missingCache());
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(harness.status).toHaveBeenCalledTimes(1));
    const notice = harness.status.mock.calls[0]![0]!;
    expect(notice).toContain('NOCACHE');
    // The original picture: no transparent hole, no key, no passthrough, HD canvas hidden.
    expect(harness.renderer.setTransparentRect).not.toHaveBeenCalledWith(expect.objectContaining({ width: 632 }));
    expect(harness.renderer.setTransparentKey).not.toHaveBeenCalledWith(expect.objectContaining({ rect: TACTICAL }));
    expect(harness.vm.setTacticalPassthrough).not.toHaveBeenCalled();
    expect(harness.hdCanvas.style.display).toBe('none');

    // The game is still on its loading screen (the logic frame stands still): the notice waits for the battlefield.
    await advance(1000, 20);
    expect(harness.status).toHaveBeenCalledTimes(1);
    // The notice is for the start of the match: once it runs, the notice goes away by itself after 12 seconds.
    harness.setState(battle(2, 'NOCACHE.MAP'));
    await advance(1000, 11);
    expect(harness.status).toHaveBeenCalledTimes(1);
    await advance(1000, 2);
    expect(harness.status).toHaveBeenCalledTimes(2);
    expect(harness.status).toHaveBeenLastCalledWith(null);
    // The failed retry (30 s after the first load) does not bring it back.
    expect(liveView.create).toHaveBeenCalledTimes(2);
    await advance(1000, 31);
    expect(liveView.create).toHaveBeenCalledTimes(3);
    await settle();
    expect(harness.status).toHaveBeenCalledTimes(2);

    // The logic frame moving on is the same match; starting over is the next match, which says it again.
    harness.setState(battle(40, 'NOCACHE.MAP'));
    await advance(1000);
    expect(harness.status).toHaveBeenCalledTimes(2);
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(1000);
    await vi.waitFor(() => expect(harness.status).toHaveBeenLastCalledWith(notice));
    // Leaving the battle clears it at once.
    harness.setState(null);
    await advance(1000);
    expect(harness.status).toHaveBeenLastCalledWith(null);
    harness.stop();
  });

  it('素材存在但加载失败时换一句话；稍后加载成功就收起并显示高清画面', async () => {
    const harness = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveView.create.mockRejectedValueOnce(missingCache());
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(harness.status).toHaveBeenCalledTimes(1));
    const missing = harness.status.mock.calls[0]![0]!;
    harness.setState(null);
    await advance(1000);

    liveView.create.mockRejectedValueOnce(new Error('WebGPU device lost'));
    harness.setState(battle(1, 'BROKEN.MAP'));
    await advance(1000);
    await vi.waitFor(() => expect(harness.status).toHaveBeenCalledTimes(3));
    const failedNotice = harness.status.mock.calls[2]![0]!;
    expect(failedNotice).toContain('BROKEN');
    expect(failedNotice.replace('BROKEN', 'NOCACHE')).not.toBe(missing);

    // The retry in the same match loads the view: the HD picture shows and no notice is left or repeated.
    const view = fakeView();
    liveView.create.mockResolvedValue(view);
    await advance(1000, 31);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    expect(harness.status).toHaveBeenLastCalledWith(null);
    harness.setState(battle(2, 'BROKEN.MAP'));
    await advance(16);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    expect(harness.status).toHaveBeenCalledTimes(4);
    harness.stop();
    expect(harness.status).toHaveBeenCalledTimes(4);
  });

  it('切到原版画面（toggle）或停止时不留提示', async () => {
    const harness = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    liveView.create.mockRejectedValue(missingCache());
    harness.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(harness.status).toHaveBeenCalledTimes(1));
    expect(harness.bridge()?.toggle()).toBe(false);
    expect(harness.status).toHaveBeenLastCalledWith(null);
    expect(harness.bridge()?.toggle()).toBe(true);
    expect(harness.status).toHaveBeenCalledTimes(2);

    const next = setup();
    liveView.create.mockRejectedValue(missingCache());
    next.setState(battle(1, 'NOCACHE.MAP'));
    await advance(16);
    await vi.waitFor(() => expect(next.status).toHaveBeenCalledTimes(1));
    next.stop();
    expect(next.status).toHaveBeenLastCalledWith(null);
  });

  it('同一张地图的大小写变化（菜单里的 2Peaks、开局后的 2PEAKS.MAP）不是另一张地图：只加载一次', async () => {
    const harness = setup();
    const view = fakeView();
    let finish!: (value: unknown) => void;
    liveView.create.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    harness.setState(battle(1, '2Peaks'));
    await advance(16);
    await vi.waitFor(() => expect(liveView.create).toHaveBeenCalledTimes(1));
    expect(liveView.create.mock.calls[0]![1]).toMatchObject({ mapBase: '/hd-cache/2Peaks' });
    // The match starts while the view is still loading: same map, the load in flight is kept.
    harness.setState(battle(2, '2PEAKS.MAP'));
    await advance(1000, 2);
    expect(liveView.create).toHaveBeenCalledTimes(1);
    finish(view);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    harness.setState(battle(3, '2PEAKS.MAP'));
    // One frame pushes the snapshot, the next finds the view complete and shows it.
    await advance(1000, 2);
    expect(view.dispose).not.toHaveBeenCalled();
    expect(view.push).toHaveBeenCalled();
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    expect(harness.status).not.toHaveBeenCalledWith(expect.any(String));
    harness.stop();
  });
});

describe('HD interface bridge wiring', () => {
  it('updates before uncached-map returns, polls every 50 ms, A/B hides and cleanup disposes', async () => {
    const ui = { update: vi.fn(), setEnabled: vi.fn(), dispose: vi.fn() };
    hdUi.start.mockReturnValue(ui);
    liveView.create.mockRejectedValue(new Error('optional map cache absent'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = setup('?hd=1&hd-ui=1');
    const state = { ...battle(1), sidebar: hdSidebar() };
    h.setState(state);
    await vi.waitFor(() => expect(hdUi.start).toHaveBeenCalledOnce());
    await advance(16);
    expect(ui.update).toHaveBeenLastCalledWith(state.sidebar);
    const published = h.bridge()!.ui.state!;
    expect(published).toEqual(state.sidebar);
    expect(published).not.toBe(state.sidebar);
    published.credits = -1;
    expect(h.bridge()!.ui.state!.credits).toBe(state.sidebar.credits);
    expect(Object.getOwnPropertyDescriptor(h.bridge()!.ui, 'state')?.set).toBeUndefined();
    await advance(49);
    expect(h.polls()).toBe(1);
    await advance(1);
    expect(h.polls()).toBe(2);
    expect(h.bridge()?.ui.enabled).toBe(true);
    expect(h.bridge()?.ui.toggle()).toBe(false);
    expect(ui.setEnabled).toHaveBeenLastCalledWith(false);
    h.bridge()?.ui.toggle();
    expect(h.bridge()?.toggle()).toBe(false);
    expect(ui.setEnabled).toHaveBeenLastCalledWith(false);
    h.bridge()?.toggle();
    expect(ui.setEnabled).toHaveBeenLastCalledWith(true);
    h.vm.getRenderState.mockRejectedValueOnce(new Error('poll failed'));
    await advance(50);
    expect(ui.update).toHaveBeenLastCalledWith(null);
    h.stop();
    expect(ui.dispose).toHaveBeenCalledOnce();
  });

  it('does not load UI without hd-ui=1 or after immediate cleanup', async () => {
    const h = setup();
    await settle();
    expect(hdUi.start).not.toHaveBeenCalled();
    h.stop();
    const late = setup('?hd=1&hd-ui=1');
    late.stop();
    await settle();
    expect(hdUi.start).not.toHaveBeenCalled();
  });
});

describe('stall recorder wiring', () => {
  it('reports every animation frame with its clock, and what it knows when one comes late', async () => {
    const monitor = fakeStallMonitor();
    stallMonitor.start.mockReturnValue(monitor);
    const harness = setup();
    await settle();
    expect(stallMonitor.start).toHaveBeenCalledTimes(1);
    const host = stallMonitor.start.mock.calls[0]![0] as {
      match(): { map: string | null; frame: number; shown: boolean };
      activity(): unknown;
      publish(count: number, longestMs: number): void;
    };
    // Before any battle: no map, no view.
    expect(host.match()).toEqual({ map: null, frame: 0, shown: false });
    expect(host.activity()).toBeNull();
    const before = monitor.frame.mock.calls.length;
    await advance(16, 3);
    expect(monitor.frame.mock.calls.slice(before).map(([now]) => now)).toEqual([clock - 32, clock - 16, clock]);
    const view = await goLive(harness);
    await advance(16);
    expect(host.match()).toEqual({ map: 'xmp29u2', frame: 2, shown: true });
    expect(host.activity()).toEqual({ pageUploads: 1, logicFps: 20 });
    expect(view.activity).toHaveBeenCalledTimes(1);
    // The original picture is shown instead: the match goes on, the HD view is not what the player sees.
    harness.stop.toggle();
    await advance(16);
    expect(host.match()).toMatchObject({ map: 'xmp29u2', shown: false });
    // The count of the match reaches the page (its toolbar line).
    host.publish(3, 1730);
    expect(harness.stalls).toHaveBeenLastCalledWith(3, 1730);
    // The console handle shows what was recorded.
    expect((harness.bridge() as unknown as { stalls: unknown[] }).stalls).toEqual([{ seq: 1 }]);
    harness.stop();
    expect(monitor.dispose).toHaveBeenCalledTimes(1);
    const frames = monitor.frame.mock.calls.length;
    await advance(16, 2);
    expect(monitor.frame.mock.calls.length).toBe(frames);
  });

  it('starts the count over with every match, and not when a match merely goes on', async () => {
    const monitor = fakeStallMonitor();
    stallMonitor.start.mockReturnValue(monitor);
    const harness = setup();
    await settle();
    await goLive(harness);
    const first = monitor.newMatch.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    harness.setState(battle(50));
    await advance(16, 3);
    expect(monitor.newMatch).toHaveBeenCalledTimes(first);
    // The logic frame starts over: another match on the same map.
    harness.setState(battle(1));
    await advance(16);
    expect(monitor.newMatch).toHaveBeenCalledTimes(first + 1);
    harness.stop();
  });

  it('runs without a recorder when the monitor cannot start', async () => {
    stallMonitor.start.mockImplementation(() => {
      throw new Error('no document');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = setup();
    await settle();
    await goLive(harness);
    await advance(16, 2);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect((harness.bridge() as unknown as { stalls: unknown[] }).stalls).toEqual([]);
    expect(warn.mock.calls.some(([text]) => String(text).includes('stall recorder unavailable'))).toBe(true);
    harness.stop();
  });
});

describe('art of what the sidebar announces', () => {
  it('lists the types being produced, queued or waiting to be placed, each once, and no superweapon', () => {
    expect(sidebarUpcomingTypes(null)).toEqual([]);
    expect(sidebarUpcomingTypes(undefined)).toEqual([]);
    const sidebar = hdSidebar();
    // The helper's power plant is being built, its GI is ready and its tank is on hold in a queue of twelve.
    expect(sidebarUpcomingTypes(sidebar)).toEqual(['GAPOWR', 'E1', 'MTNK']);
    const idle = { ...sidebar.cameos[0]!, progress: null, ready: false, queued: 0 };
    const charging = { ...sidebar.cameos[0]!, id: 'NukeSpecial', kind: 'super' as const, progress: 0.5 };
    const queued = { ...idle, id: 'E2', queued: 1 };
    sidebar.cameos = [idle, charging, queued, { ...queued }, sidebar.cameos[1]!];
    expect(sidebarUpcomingTypes(sidebar)).toEqual(['E2', 'E1']);
  });

  it("hands them to the view when they change, so a building's art is in before it is placed", async () => {
    const harness = setup();
    const view = await goLive(harness);
    expect(view.prepare).not.toHaveBeenCalled();
    const sidebar = hdSidebar();
    harness.setState({ ...battle(3), sidebar });
    await advance(16);
    expect(view.prepare.mock.calls).toEqual([[['GAPOWR', 'E1', 'MTNK']]]);
    // The clock moving on is no news: the view is not asked again on every poll.
    harness.setState({ ...battle(4), sidebar: { ...sidebar, cameos: sidebar.cameos.map((c) => ({ ...c })) } });
    await advance(16, 3);
    expect(view.prepare).toHaveBeenCalledTimes(1);
    // The refinery's production starts.
    const refinery = { ...sidebar.cameos[0]!, id: 'NAREFN', progress: 0.01, queued: 0 };
    harness.setState({ ...battle(5), sidebar: { ...sidebar, cameos: [...sidebar.cameos, refinery] } });
    await advance(16);
    expect(view.prepare).toHaveBeenLastCalledWith(['GAPOWR', 'E1', 'MTNK', 'NAREFN']);
    // Nothing in production any more: nothing to ask for (what was asked for stays prepared in the view).
    harness.setState({ ...battle(6), sidebar: { ...sidebar, cameos: [] } });
    await advance(16);
    expect(view.prepare).toHaveBeenLastCalledWith([]);
    harness.stop();
  });

  it('asks a new view again: another map has another library', async () => {
    const harness = setup();
    const first = await goLive(harness);
    const sidebar = hdSidebar();
    harness.setState({ ...battle(3), sidebar });
    await advance(16);
    expect(first.prepare).toHaveBeenCalledTimes(1);
    const second = fakeView();
    liveView.create.mockResolvedValue(second);
    harness.setState({ ...battle(1, 'OTHER.MAP'), sidebar });
    await advance(1000);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(second));
    harness.setState({ ...battle(2, 'OTHER.MAP'), sidebar });
    await advance(16, 2);
    expect(second.prepare.mock.calls).toEqual([[['GAPOWR', 'E1', 'MTNK']]]);
    harness.stop();
  });
});

describe('HD bridge match start', () => {
  const WARM_MAP = 'ra2-hd-warm:1:map:xmp29u2';
  const WARM_THEATER = 'ra2-hd-warm:1:theater:urban';

  /** Load the view behind the loading screen (no object yet). */
  async function loadBehindLoadingScreen(harness: ReturnType<typeof setup>, view = fakeView()) {
    liveView.create.mockResolvedValue(view);
    harness.setState(loadingScreen());
    await advance(16);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    await advance(16, 2);
    return view;
  }

  it('keeps the original picture until the view has drawn the running match completely', async () => {
    const harness = setup();
    const view = fakeView();
    view.settledFrames = 0;
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(16);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    harness.setState(battle(2));
    await advance(16, 5);
    // Art is still arriving: no transparent pixels, no passthrough, the canvas stays away, yet frames are drawn.
    expect(view.push).toHaveBeenCalled();
    expect(view.outOfSight).toBe(true);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.vm.setTacticalPassthrough).not.toHaveBeenCalled();
    expect(harness.renderer.setTransparentKey).not.toHaveBeenCalledWith(KEY);
    expect(view.render.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Laid out as it will be shown, so the frames drawn out of sight are the real ones.
    expect(view.resizePixels).toHaveBeenLastCalledWith(632, 568, 632, 568);
    // Two complete frames are not enough.
    view.settledFrames = 2;
    await advance(16, 2);
    expect(harness.hdCanvas.style.display).toBe('none');
    view.settledFrames = 3;
    await advance(16);
    expect(view.outOfSight).toBe(false);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(7);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    expect(harness.bridge()!.timeline).toMatchObject({ map: 'xmp29u2', revealReason: 'settled', revealLoading: 0 });
    // Shown for the match: art that loads later no longer hides the view.
    view.settledFrames = 0;
    harness.setState(battle(3));
    await advance(16, 3);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('prepares behind the loading screen and shows the view only once the match runs', async () => {
    const harness = setup();
    const view = await loadBehindLoadingScreen(harness);
    // Complete (there is nothing to draw yet), but the match has not started.
    expect(view.outOfSight).toBe(true);
    // Nothing moves behind the loading screen: no pacing of builds and uploads.
    expect([view.newArtPerFrame, view.hiddenUploadPixels]).toEqual([Infinity, Infinity]);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.vm.setTacticalPassthrough).not.toHaveBeenCalled();
    expect(view.warm).not.toHaveBeenCalled();
    expect(view.push).toHaveBeenCalled();
    // Out of sight and complete, the view is drawn now and then, not sixty times a second.
    const drawn = view.render.mock.calls.length;
    await advance(16, 24);
    expect(view.render.mock.calls.length - drawn).toBe(2);
    // The starting units exist, the logic frame is still 0: the game has not drawn the battlefield yet.
    harness.setState(battle(0));
    await advance(16, 3);
    expect(harness.hdCanvas.style.display).toBe('none');
    // From here on the game's own picture may be on screen at any moment: one kind and 8 M pixels per frame.
    expect([view.newArtPerFrame, view.hiddenUploadPixels]).toEqual([1, 8 << 20]);
    expect(harness.bridge()!.timeline.matchAt).toBeNull();
    harness.setState(battle(1));
    await advance(16, 2);
    expect(view.outOfSight).toBe(false);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    harness.stop();
  });

  it('hands the view what the last match on the map showed, and keeps that list until the match has objects', async () => {
    stored.set(
      WARM_MAP,
      JSON.stringify([
        ['vehicle', 'HTNK', '', 21, 0],
        ['building', 'CAOILD', '', 5, 1],
      ]),
    );
    stored.set(WARM_THEATER, JSON.stringify([['vehicle', 'MTNK', '', 17, 0]]));
    const harness = setup();
    const view = await loadBehindLoadingScreen(harness);
    expect(view.warm).toHaveBeenCalledTimes(1);
    expect(view.warm).toHaveBeenCalledWith([
      { kind: 'vehicle', type: 'HTNK', colorIndex: 21 },
      { kind: 'building', type: 'CAOILD', colorIndex: 5, civilian: true },
    ]);
    // The empty snapshots of the loading screen must not replace the list being prepared.
    expect(view.push).not.toHaveBeenCalled();
    await advance(16, 6);
    expect(view.warm).toHaveBeenCalledTimes(1);
    expect(view.push).not.toHaveBeenCalled();
    expect(harness.bridge()!.timeline).toMatchObject({ warmTypes: 2, revealedAt: null });
    expect(harness.bridge()!.timeline.warmSettledAt).not.toBeNull();
    harness.setState(battle(1));
    await advance(16, 2);
    expect(view.push).toHaveBeenCalledTimes(1);
    expect(harness.hdCanvas.style.display).toBe('block');
    harness.stop();
  });

  it('falls back to the list of the theater on a map that was not played yet', async () => {
    stored.set(WARM_THEATER, JSON.stringify([['vehicle', 'MTNK', '', 17, 0]]));
    const harness = setup();
    const view = await loadBehindLoadingScreen(harness);
    expect(view.warm).toHaveBeenCalledWith([{ kind: 'vehicle', type: 'MTNK', colorIndex: 17 }]);
    harness.stop();
  });

  it('remembers the kinds of object of the opening for the next match', async () => {
    const harness = setup();
    const view = fakeView();
    view.warmTypes.mockReturnValue([
      { kind: 'vehicle', type: 'SMCV', colorIndex: 21 },
      { kind: 'building', type: 'CAOILD', colorIndex: 5, civilian: true },
    ]);
    await goLive(harness, view);
    expect(JSON.parse(stored.get(WARM_MAP)!)).toEqual([
      ['vehicle', 'SMCV', '', 21, 0],
      ['building', 'CAOILD', '', 5, 1],
    ]);
    // The theater's list, and the one for theaters not played yet, are for other maps: players' objects only.
    expect(JSON.parse(stored.get(WARM_THEATER)!)).toEqual([['vehicle', 'SMCV', '', 21, 0]]);
    expect(JSON.parse(stored.get('ra2-hd-warm:1:players')!)).toEqual([['vehicle', 'SMCV', '', 21, 0]]);
    // The MCV deployed: what was seen stays, the new kind is added.
    view.warmTypes.mockReturnValue([{ kind: 'building', type: 'NACNST', colorIndex: 21 }]);
    harness.setState(battle(30));
    await advance(16, 2);
    expect(JSON.parse(stored.get(WARM_MAP)!)).toEqual([
      ['vehicle', 'SMCV', '', 21, 0],
      ['building', 'CAOILD', '', 5, 1],
      ['building', 'NACNST', '', 21, 0],
    ]);
    // After the opening minutes nothing more is collected.
    const reads = view.warmTypes.mock.calls.length;
    harness.setState(battle(6001));
    await advance(16, 2);
    harness.setState(battle(6100));
    await advance(16, 2);
    expect(view.warmTypes).toHaveBeenCalledTimes(reads);
    harness.stop();
  });

  it('prepares behind the loading screen at the layout the view was last shown with', async () => {
    const LAYOUT = 'ra2-hd-warm:1:layout';
    stored.set(LAYOUT, JSON.stringify([3120, 2096, 1560, 1048]));
    const harness = setup();
    const view = await loadBehindLoadingScreen(harness);
    // The loading screen is 800x600; a view laid out for it would be rebuilt when the match's video mode arrives.
    expect(view.resizePixels).toHaveBeenCalledTimes(1);
    expect(view.resizePixels).toHaveBeenLastCalledWith(3120, 2096, 1560, 1048);
    // The game switches to the match's mode, at another size than last time: the view follows what is real.
    harness.setFrameSize(1024, 768);
    await advance(16, 13);
    expect(view.resizePixels).toHaveBeenCalledTimes(2);
    expect(view.resizePixels).toHaveBeenLastCalledWith(669, 575, 856, 736);
    harness.setState(battle(1));
    await advance(16, 2);
    expect(harness.hdCanvas.style.display).toBe('block');
    // The first frame drawn in sight records the layout: it is the one to prepare for next time.
    await advance(16);
    expect(view.resizePixels).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stored.get(LAYOUT)!)).toEqual([669, 575, 856, 736]);
    harness.stop();
  });

  it('prepares at the current frame size when no layout is remembered, and remembers the one it is shown with', async () => {
    const harness = setup();
    const view = await loadBehindLoadingScreen(harness);
    expect(view.resizePixels).toHaveBeenLastCalledWith(632, 568, 632, 568);
    expect(stored.has('ra2-hd-warm:1:layout')).toBe(false);
    harness.setState(battle(1));
    await advance(16, 3);
    expect(JSON.parse(stored.get('ra2-hd-warm:1:layout')!)).toEqual([632, 568, 632, 568]);
    harness.stop();
  });

  it('gives a view the top-layer pass before it is shown once a match has shown top-layer art', async () => {
    const TOP = 'ra2-hd-warm:1:top-effects';
    const harness = setup();
    const view = await goLive(harness);
    expect(view.hd.enableTopEffects).not.toHaveBeenCalled();
    expect(stored.has(TOP)).toBe(false);
    // The first top-layer art of the match put the pass into the view's post graph.
    view.hd.topEffectsEnabled = true;
    harness.setState(battle(3));
    await advance(16, 2);
    expect(stored.get(TOP)).toBe('1');
    harness.stop();
    // The next page load knows: its view has the pass from the start.
    const next = setup();
    const later = fakeView();
    await goLive(next, later);
    expect(later.hd.enableTopEffects).toHaveBeenCalledOnce();
    next.stop();
  });

  it('shows the view after the deadline when its art never settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = setup();
    const view = fakeView();
    view.settledFrames = 0;
    view.loadingArt.mockReturnValue(2);
    // What each frame was drawn for, and whether the canvas was on screen when it was drawn.
    const drawn: { outOfSight: boolean; displayed: boolean }[] = [];
    view.render.mockImplementation(() => {
      drawn.push({ outOfSight: view.outOfSight, displayed: harness.hdCanvas.style.display === 'block' });
    });
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(16);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    harness.setState(battle(2));
    await advance(16, 2);
    await advance(19_000);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(drawn.every((frame) => frame.outOfSight && !frame.displayed)).toBe(true);
    await advance(1_100);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.bridge()!.timeline).toMatchObject({ revealReason: 'deadline', revealLoading: 2 });
    expect(warn).toHaveBeenCalledOnce();
    // The view was incomplete when it was shown: it is drawn again as a shown view at once, so no frame drawn for a
    // view out of sight (which leaves out units whose mesh is still being built) is ever on screen.
    expect(drawn.some((frame) => !frame.outOfSight)).toBe(true);
    expect(drawn.filter((frame) => frame.displayed).every((frame) => !frame.outOfSight)).toBe(true);
    const shownFrom = drawn.findIndex((frame) => !frame.outOfSight);
    expect(drawn[shownFrom]).toEqual({ outOfSight: false, displayed: true });
    expect(drawn[shownFrom - 1]).toEqual({ outOfSight: true, displayed: false });
    harness.stop();
  });

  it('starts out of sight again when another match begins on the same map', async () => {
    const harness = setup();
    const view = await goLive(harness);
    harness.setState(battle(500));
    await advance(16, 2);
    expect(harness.hdCanvas.style.display).toBe('block');
    // The logic frame starts over: a new match, whose first snapshots the view has to draw completely first.
    view.settledFrames = 0;
    harness.setState(battle(1));
    await advance(16, 2);
    expect(view.outOfSight).toBe(true);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(0);
    await advance(600);
    expect(harness.hdCanvas.style.display).toBe('none');
    view.settledFrames = 3;
    harness.setState(battle(2));
    await advance(16, 2);
    expect(view.outOfSight).toBe(false);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(liveView.create).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('keeps the view of a match that had no snapshot for a while (an in-game menu), without waiting again', async () => {
    const harness = setup();
    const view = await goLive(harness);
    harness.setState(battle(300));
    await advance(16, 2);
    expect(harness.hdCanvas.style.display).toBe('block');
    // The options menu owns the screen: the VM reports no battle state, the original picture is shown.
    harness.setState(null);
    await advance(16, 2);
    await advance(600);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(view.outOfSight).toBe(false);
    // Back in the match, a few frames on. The view is not complete by its own count (art may be arriving), yet it
    // was shown for this match: it returns with the first snapshot.
    view.settledFrames = 0;
    harness.setState(battle(301));
    await advance(1100);
    await advance(16);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(view.outOfSight).toBe(false);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(KEY);
    harness.stop();
  });

  it('does not draw out of sight while the HD view is switched off', async () => {
    const harness = setup();
    const view = fakeView();
    view.settledFrames = 0;
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(16);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    expect(harness.bridge()!.toggle()).toBe(false);
    const drawn = view.render.mock.calls.length;
    await advance(1100, 3);
    expect(view.render).toHaveBeenCalledTimes(drawn);
    expect(harness.bridge()!.toggle()).toBe(true);
    view.settledFrames = 3;
    harness.setState(battle(2));
    await advance(1100, 3);
    expect(harness.hdCanvas.style.display).toBe('block');
    harness.stop();
  });
});

describe('native HD curtain', () => {
  it('covers the tactical view synchronously on the first battle video frame, before a state or HD cache exists', async () => {
    const harness = setup('?hd=1', 'WebGL2', 'native');
    harness.setFrameSize(1280, 720);
    harness.nativeFrame(false);
    expect(harness.curtain.style.display).toBe('flex');
    expect(harness.curtain.style.opacity).toBe('1');
    expect(harness.curtain.textContent).toContain('Preparing');
    expect(harness.bridge()!.timeline.transitions).toMatchObject([
      { from: 'original', to: 'curtain', reason: 'battle-video-mode', atMs: 1000 },
    ]);
    await advance(200);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.curtain.style.display).toBe('flex');
    harness.stop();
    expect(harness.curtain.remove).toHaveBeenCalledOnce();
  });

  it('waits for passthrough acceptance and an actual keyed native picture, then fades for 300 ms', async () => {
    const harness = setup('?hd=1', 'WebGL2', 'native');
    harness.setFrameSize(1280, 720);
    harness.nativeFrame(false);
    let accept!: (value: boolean) => void;
    harness.vm.setTacticalPassthrough.mockImplementation(() => new Promise((resolve) => (accept = resolve)));
    const view = fakeView();
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(17);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    harness.setState(battle(2));
    await advance(17, 3);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenCalledWith(7);
    expect(harness.bridge()!.timeline.revealedAt).toBeNull();
    expect(harness.curtain.style.opacity).toBe('1');
    accept(true);
    await settle();
    harness.nativeFrame(false);
    await advance(17);
    expect(harness.bridge()!.timeline.revealedAt).toBeNull();
    harness.nativeFrame();
    await advance(17);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.curtain.style.opacity).toBe('1');
    const first = harness.bridge()!.timeline;
    expect(first.passthroughAcceptedAt).toBeLessThan(first.revealedAt!);
    await advance(150);
    expect(Number(harness.curtain.style.opacity)).toBeCloseTo(0.5);
    await advance(151);
    expect(harness.curtain.style.display).toBe('none');
    expect(harness.bridge()!.timeline.curtainLiftedAt).toBeGreaterThan(first.revealedAt!);
    expect(harness.bridge()!.timeline.transitions.some((entry) => entry.from === 'hd' && entry.to === 'original')).toBe(
      false,
    );
    harness.stop();
  });

  it('holds HD through a short state gap and records a longer gap and a commanded switch with their reasons', async () => {
    const harness = setup('?hd=1', 'WebGL2', 'native');
    await goLive(harness);
    await advance(320);
    harness.setState(null);
    await advance(200);
    expect(harness.bridge()!.diagnostics.shown).toBe(true);
    harness.setState(battle(3));
    await advance(17);
    expect(harness.bridge()!.timeline.transitions.filter((entry) => entry.to === 'original')).toHaveLength(0);
    harness.setState(null);
    await advance(17);
    await advance(499);
    expect(harness.bridge()!.diagnostics.shown).toBe(true);
    await advance(2);
    expect(harness.bridge()!.diagnostics.shown).toBe(false);
    expect(harness.bridge()!.timeline.transitions.at(-1)).toMatchObject({
      from: 'hd',
      to: 'original',
      reason: 'state-unavailable',
    });
    harness.setState(battle(4));
    await advance(17);
    harness.nativeFrame();
    await advance(17);
    expect(harness.bridge()!.diagnostics.shown).toBe(true);
    harness.stop.toggle();
    expect(harness.bridge()!.timeline.transitions.at(-1)).toMatchObject({
      from: 'hd',
      to: 'original',
      reason: 'commanded-toggle',
    });
    harness.stop();
  });

  it('keeps passthrough off through repeated idle polls after switching to the original picture', async () => {
    vi.useFakeTimers();
    const harness = setup('?hd=1', 'WebGL2', 'native');
    await goLive(harness);
    await advance(320);
    const polls = harness.polls();
    expect(harness.stop.toggle()).toBe(false);
    expect(harness.vm.setTacticalPassthrough).toHaveBeenLastCalledWith(0);
    await advance(1000, 3);
    expect(harness.polls()).toBeGreaterThanOrEqual(polls + 3);
    expect(harness.vm.setTacticalPassthrough.mock.calls.map(([flags]) => flags)).toEqual([7, 0]);
    expect(harness.bridge()!.passthrough).toMatchObject({ flags: 0, keyed: false });
    expect(harness.bridge()!.diagnostics.shown).toBe(false);
    expect(harness.renderer.setTransparentKey).toHaveBeenLastCalledWith(null);
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.curtain.style.display).toBe('none');
    harness.stop();
  });

  it('switches preflight passthrough off before a hole exists and ignores its late acceptance', async () => {
    vi.useFakeTimers();
    const harness = setup('?hd=1', 'WebGL2', 'native');
    harness.setFrameSize(1280, 720);
    harness.nativeFrame(false);
    let accept!: (value: boolean) => void;
    harness.vm.setTacticalPassthrough.mockImplementation((flags) =>
      flags ? new Promise((resolve) => (accept = resolve)) : Promise.resolve(true),
    );
    const view = fakeView();
    liveView.create.mockResolvedValue(view);
    harness.setState(battle(1));
    await advance(17);
    await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
    harness.setState(battle(2));
    await advance(17, 3);
    expect(harness.bridge()!.passthrough.flags).toBe(7);
    expect(harness.bridge()!.diagnostics.shown).toBe(false);
    expect(harness.bridge()!.timeline.revealedAt).toBeNull();
    expect(harness.stop.toggle()).toBe(false);
    expect(harness.vm.setTacticalPassthrough.mock.calls.map(([flags]) => flags)).toEqual([7, 0]);
    accept(true);
    await settle();
    harness.nativeFrame();
    await advance(1000, 3);
    expect(harness.bridge()!.passthrough).toMatchObject({ flags: 0, keyed: false });
    expect(harness.bridge()!.timeline.passthroughAcceptedAt).toBeNull();
    expect(harness.bridge()!.timeline.revealedAt).toBeNull();
    expect(harness.curtain.style.display).toBe('none');
    expect(harness.hdCanvas.style.display).toBe('none');
    expect(harness.vm.setTacticalPassthrough.mock.calls.map(([flags]) => flags)).toEqual([7, 0]);
    harness.stop();
  });
});

describe('HD bridge frame-time safeguard', () => {
  it('steps the shown view down while frames stay over budget, says so, and starts the next match with everything', async () => {
    const harness = setup();
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(16, 4);
    expect(harness.hdCanvas.style.display).toBe('block');
    // On budget: the view draws with everything, and the host knows.
    await advance(16, 300);
    expect(view.hd.quality).toBe(0);
    expect(harness.quality).toHaveBeenLastCalledWith(0, 4);
    // A steady 18.2 ms (55 frames a second) is over budget (see FRAME_BUDGET_MARGIN): one tier down after about a
    // second of frames, the next one after another second.
    await advance(18.2, 60);
    expect(view.hd.quality).toBe(1);
    expect(harness.quality).toHaveBeenLastCalledWith(1, 4);
    await advance(18.2, 60);
    expect(view.hd.quality).toBe(2);
    expect(harness.quality).toHaveBeenLastCalledWith(2, 4);
    // A pause of the page (a dialog, another tab) is not load: the frames before it are forgotten.
    await advance(18.2, 20);
    await advance(4000);
    await advance(18.2, 40);
    expect(view.hd.quality).toBe(2);
    // 30 ms frames, far over budget: down again within about a second.
    await advance(30, 40);
    expect(view.hd.quality).toBe(3);
    await advance(4000);
    await advance(30, 80);
    expect(view.hd.quality).toBe(3);
    // Another match on the map: out of sight again, at full quality, and the host hears that no HD view is shown
    // until this one is.
    harness.quality.mockClear();
    view.settledFrames = 0;
    harness.setState(battle(1));
    // (Frames the game drew before it heard of the change may still carry the key colour for half a second.)
    await advance(16, 45);
    expect(view.outOfSight).toBe(true);
    expect(view.hd.quality).toBe(0);
    expect(harness.quality).toHaveBeenLastCalledWith(null, 4);
    harness.stop();
  });

  it('keeps every pass with ?hd-governor=0', async () => {
    const harness = setup('?hd=1&hd-governor=0');
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(16, 4);
    await advance(40, 600);
    expect(view.hd.setQualityTier).not.toHaveBeenCalled();
    expect(view.hd.quality).toBe(0);
    expect(harness.quality).toHaveBeenLastCalledWith(0, 4);
    harness.stop();
    expect(harness.quality).toHaveBeenLastCalledWith(null, 0);
  });
});

describe('HD bridge frame pacing', () => {
  /**
   * The emulator's answer to a pace sample: a game at slider 5 (62.5 logic frames a second asked for) whose frame
   * counter and waits follow the test clock at the given rate and idle share.
   */
  function gameAt(harness: ReturnType<typeof setup>, logicFps: () => number, idleShare: () => number) {
    let frame = 100;
    let waitMs = 0;
    let at = clock;
    const getDiagnostics = vi.fn(async (_action: string): Promise<VmDiagnostics> => {
      frame += ((clock - at) * logicFps()) / 1000;
      waitMs += (clock - at) * idleShare();
      at = clock;
      return {
        sampledAtMs: clock,
        phase: 'running',
        hypercalls: 0,
        clockRate: 1,
        execution: null,
        game: {
          frame: Math.floor(frame),
          gameSpeed: 1,
          sessionSpeed: 1,
          requestedFps: 60,
          targetFps: 62.5,
          sampledAtMs: clock,
          intervalMs: null,
          logicFps: null,
          status: 'sample',
        },
        usage: {
          guestMs: 0,
          slices: 0,
          jitCompiled: 0,
          jitFreed: 0,
          hostCallMs: 0,
          guestWaitMs: waitMs,
          stateReadMs: 0,
          stateReads: 0,
          frames: 0,
        },
      };
    });
    (harness.vm as unknown as { getDiagnostics: typeof getDiagnostics }).getDiagnostics = getDiagnostics;
    return getDiagnostics;
  }

  /** Frames the view drew and snapshots the bridge asked for while `count` display frames `ms` apart went by. */
  async function count(
    harness: ReturnType<typeof setup>,
    view: ReturnType<typeof fakeView>,
    ms: number,
    frames: number,
  ) {
    const drawn = view.render.mock.calls.length;
    const polls = harness.polls();
    await advance(ms, frames);
    return { drawn: view.render.mock.calls.length - drawn, polls: harness.polls() - polls };
  }

  it('reads ?hd-pace: auto by default, a fixed rate, or off', () => {
    expect(parseHdPace(null)).toEqual({ kind: 'auto' });
    expect(parseHdPace('')).toEqual({ kind: 'auto' });
    expect(parseHdPace('auto')).toEqual({ kind: 'auto' });
    expect(parseHdPace('nonsense')).toEqual({ kind: 'auto' });
    expect(parseHdPace('off')).toEqual({ kind: 'off' });
    expect(parseHdPace('cap')).toEqual({ kind: 'fixed', rate: 60 });
    expect(parseHdPace('40')).toEqual({ kind: 'fixed', rate: 40 });
    // Out of range is not a rate.
    expect(parseHdPace('5')).toEqual({ kind: 'auto' });
    expect(parseHdPace('1000')).toEqual({ kind: 'auto' });
  });

  it('holds the shown view to 60 frames a second on a 120 Hz display and draws every frame of a 60 Hz one', async () => {
    const harness = setup();
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(1000 / 120, 8);
    expect((await count(harness, view, 1000 / 120, 120)).drawn).toBe(60);
    expect(harness.bridge()?.pace).toEqual({ mode: 'auto', level: 0, levels: 3, rate: 60, stride: 2 });
    expect(harness.stop.scene()?.pace).toBe(60);
    await advance(1000 / 60, 40);
    expect((await count(harness, view, 1000 / 60, 60)).drawn).toBe(60);
    expect(harness.bridge()?.pace?.stride).toBe(1);
    harness.stop();
  });

  it('paces native drawing from the native game counters and their timestamps, without emulator diagnostics', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1000);
    const harness = setup('?hd=1', 'WebGL2', 'native');
    vi.mocked(performance.now).mockImplementation(() => Date.now());
    const diagnostics = gameAt(
      harness,
      () => 40,
      () => 0,
    );
    let logicFps = 62;
    let frame = 100;
    let at = performance.now();
    const getGamePerformance = vi.fn(async () => {
      const now = performance.now();
      frame += ((now - at) * logicFps) / 1000;
      at = now;
      return {
        frame: Math.floor(frame),
        gameSpeed: 1,
        sessionSpeed: 1,
        requestedFps: 60,
        targetFps: 62.5,
        sampledAtMs: at,
        intervalMs: null,
        logicFps: null,
        status: 'sample' as const,
      };
    });
    (harness.vm as unknown as { getGamePerformance: typeof getGamePerformance }).getGamePerformance =
      getGamePerformance;
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(1000 / 120, 120 * 60);
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60, stride: 2 });
    expect((await count(harness, view, 1000 / 120, 120)).drawn).toBe(60);
    expect(diagnostics).not.toHaveBeenCalled();
    expect(getGamePerformance.mock.calls.length).toBeGreaterThanOrEqual(59);
    expect(getGamePerformance.mock.calls.length).toBeLessThanOrEqual(63);
    // Only the game's observed logic counter deficit permits a lower level.
    logicFps = 40;
    await advance(1000 / 120, 480);
    expect(harness.bridge()?.pace).toMatchObject({ level: 2, rate: 30 });
    logicFps = 62;
    await advance(1000 / 120, 240);
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60 });
    harness.stop();
  });

  it('delivers native states without display frames or ready art, at no more than 60 requests a second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1000);
    const harness = setup('?hd=1', 'WebGL2', 'native');
    vi.mocked(performance.now).mockImplementation(() => Date.now());
    liveView.create.mockReturnValue(new Promise(() => {}));
    const requestedAt: number[] = [];
    harness.vm.getRenderState.mockImplementation(async () => {
      requestedAt.push(performance.now());
      return battle(requestedAt.length);
    });
    await settle();
    // There is no animation-frame callback in this interval. Art stays pending.
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestedAt.length).toBeGreaterThanOrEqual(55);
    expect(requestedAt.length).toBeLessThanOrEqual(60);
    expect(requestedAt.slice(1).every((at, i) => at - requestedAt[i]! >= 1000 / 60)).toBe(true);
    expect(harness.stop.scene()?.objects).toBe(1);
    expect(harness.bridge()?.timeline.firstStateAt).toBeLessThanOrEqual(1017);
    expect(harness.bridge()?.timeline.readyAt).toBeNull();
    const deliveryCounters = harness.bridge()!.diagnostics.counters;
    expect(deliveryCounters.distinctStates).toBe(requestedAt.length);
    expect(deliveryCounters.drawnFrames).toBe(0);
    expect(deliveryCounters.firstDrawAtMs).toBeNull();
    // One display frame a second still receives the same bounded native stream.
    const beforeSlowDisplay = requestedAt.length;
    await advance(1000, 3);
    expect(requestedAt.length - beforeSlowDisplay).toBeGreaterThanOrEqual(55 * 3);
    expect(requestedAt.length - beforeSlowDisplay).toBeLessThanOrEqual(60 * 3);
    const beforeStop = requestedAt.length;
    harness.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestedAt).toHaveLength(beforeStop);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one native state request outstanding and does not restart it after disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1000);
    const harness = setup('?hd=1', 'WebGL2', 'native');
    vi.mocked(performance.now).mockImplementation(() => Date.now());
    let reply!: (state: GameRenderState) => void;
    harness.vm.getRenderState.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    // The initial immediate request, then exactly one still-unanswered timer request.
    expect(harness.polls()).toBe(2);
    harness.stop();
    reply(battle(1));
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(harness.polls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes a due native request before a rounded or late timer, without duplicate or early requests', async () => {
    const timers = new Map<number, { at: number; run: () => void }>();
    let nextTimer = 1;
    vi.stubGlobal('setTimeout', (run: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    });
    vi.stubGlobal('clearTimeout', (id: number) => timers.delete(id));
    liveView.create.mockReturnValue(new Promise(() => {}));
    const harness = setup('?hd=1', 'WebGL2', 'native');
    const starts = [clock];
    harness.vm.getRenderState.mockImplementation(async () => {
      starts.push(clock);
      return battle(starts.length);
    });
    await settle();
    const rounded = [...timers.values()][0]!;
    expect(rounded.at).toBe(1017);
    // A display callback at 16.7 ms can start the due read before the ceil-rounded 17 ms timer.
    await advance(16.7);
    expect(starts).toEqual([1000, 1016.7]);
    expect([...timers.values()]).not.toContain(rounded);
    expect(timers.size).toBe(1);
    // A canceled callback must not erase or duplicate the replacement timer even if a queued turn invokes it.
    rounded.run();
    await settle();
    expect(starts).toHaveLength(2);
    expect(timers.size).toBe(1);
    // Rendering blocked the main-thread timer turn. The next display callback gets a chance before drawing
    // again, cancels that late timer and schedules one replacement after its reply, rather than two reads.
    const late = [...timers.values()][0]!;
    await advance(22);
    expect(starts).toEqual([1000, 1016.7, 1038.7]);
    expect([...timers.values()]).not.toContain(late);
    expect(timers.size).toBe(1);
    // Once callbacks stop, the independently scheduled timer remains the owner of state delivery.
    const [id, next] = [...timers][0]!;
    timers.delete(id);
    clock = next.at;
    next.run();
    await settle();
    expect(starts).toHaveLength(4);
    expect(starts.slice(1).every((at, i) => at - starts[i]! >= 1000 / 60)).toBe(true);
    expect(timers.size).toBe(1);
    harness.stop();
    expect(timers.size).toBe(0);
  });

  it('rearms an early native timer and keeps a slow request exclusive across display callbacks', async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    vi.stubGlobal('setTimeout', (run: () => void) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    });
    vi.stubGlobal('clearTimeout', (id: number) => timers.delete(id));
    const harness = setup('?hd=1', 'WebGL2', 'native');
    await settle();
    const [id, early] = [...timers][0]!;
    timers.delete(id);
    clock += 8;
    early();
    await settle();
    expect(harness.polls()).toBe(1);
    expect(timers.size).toBe(1);
    let reply!: (state: GameRenderState) => void;
    harness.vm.getRenderState.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    await advance(9);
    expect(harness.polls()).toBe(2);
    expect(timers.size).toBe(0);
    await advance(16.7, 5);
    expect(harness.polls()).toBe(2);
    harness.stop();
    reply(battle(1));
    await settle();
    await advance(100);
    expect(harness.polls()).toBe(2);
    expect(timers.size).toBe(0);
  });

  it('gives the game its speed back: fewer frames and fewer snapshot reads while it is behind its setting', async () => {
    const harness = setup();
    let logicFps = 62.5;
    let idle = 0.3;
    const asked = gameAt(
      harness,
      () => logicFps,
      () => idle,
    );
    const view = await goLive(harness);
    harness.setState(battle(3));
    // On target with time to spare: 60 frames a second, a snapshot asked for with every drawn frame.
    await advance(1000 / 120, 240);
    expect(await count(harness, view, 1000 / 120, 120)).toEqual({ drawn: 60, polls: 60 });
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60 });
    // One request a second on the emulator's thread, with the usage accounting it needs.
    expect(asked.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(asked.mock.calls.length).toBeLessThanOrEqual(4);
    expect(asked).toHaveBeenLastCalledWith('usage');
    // The game falls to 55 with no waits: 40 frames a second after two samples behind.
    logicFps = 55;
    idle = 0;
    for (let i = 0; i < 480 && harness.bridge()?.pace?.level === 0; i++) await advance(1000 / 120);
    expect(harness.bridge()?.pace).toMatchObject({ level: 1, rate: 40, stride: 3 });
    // At 40 the game holds its setting with nothing to spare: the view stays there.
    logicFps = 62.5;
    idle = 0.02;
    expect(await count(harness, view, 1000 / 120, 120)).toEqual({ drawn: 40, polls: 40 });
    expect(harness.stop.scene()?.pace).toBe(40);
    await advance(1000 / 120, 120 * 20);
    expect(harness.bridge()?.pace).toMatchObject({ level: 1 });
    // Behind again: 30. It stays there however long the game is behind.
    logicFps = 55;
    idle = 0;
    await advance(1000 / 120, 360);
    expect(harness.bridge()?.pace).toMatchObject({ level: 2, rate: 30, stride: 4 });
    expect(await count(harness, view, 1000 / 120, 120)).toEqual({ drawn: 30, polls: 30 });
    await advance(1000 / 120, 1200);
    expect(harness.bridge()?.pace).toMatchObject({ level: 2 });
    // The game holds its setting again with a quarter of its thread idle: one level back after eight seconds.
    logicFps = 62.5;
    idle = 0.25;
    await advance(1000 / 120, 120 * 10);
    expect(harness.bridge()?.pace).toMatchObject({ level: 1, rate: 40 });
    harness.stop();
  });

  it('does not take a view it holds back for a slow one, and still sees a slow one', async () => {
    // 30 frames a second on a 60 Hz display: every second display frame, 33 ms apart, is on time.
    const harness = setup('?hd=1&hd-pace=30');
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(1000 / 60, 8);
    expect((await count(harness, view, 1000 / 60, 600)).drawn).toBe(300);
    expect(view.hd.quality).toBe(0);
    expect(harness.bridge()?.pace).toEqual({ mode: 'fixed', level: 0, levels: 1, rate: 30, stride: 2 });
    // Display frames 50 ms apart: the view cannot keep even its held rate, and gives up its passes.
    await advance(50, 120);
    expect(view.hd.quality).toBeGreaterThan(0);
    harness.stop();
  });

  it('asks the game nothing at a fixed rate, and draws every display frame with ?hd-pace=off', async () => {
    const fixed = setup('?hd=1&hd-pace=40');
    const asked = gameAt(
      fixed,
      () => 30,
      () => 0,
    );
    const view = await goLive(fixed);
    fixed.setState(battle(3));
    await advance(1000 / 120, 600);
    expect(asked).not.toHaveBeenCalled();
    expect((await count(fixed, view, 1000 / 120, 120)).drawn).toBe(40);
    fixed.stop();

    const off = setup('?hd=1&hd-pace=off');
    const offAsked = gameAt(
      off,
      () => 30,
      () => 0,
    );
    const offView = await goLive(off);
    off.setState(battle(3));
    await advance(1000 / 120, 600);
    expect(await count(off, offView, 1000 / 120, 120)).toEqual({ drawn: 120, polls: 60 });
    expect(offAsked).not.toHaveBeenCalled();
    expect(off.bridge()?.pace).toBeNull();
    expect(off.stop.scene()?.pace).toBeNull();
    off.stop();
  });

  it('does not judge the game while the view is switched off: the pace it had is the pace it comes back with', async () => {
    const harness = setup();
    let logicFps = 62.5;
    const asked = gameAt(
      harness,
      () => logicFps,
      () => 0.3,
    );
    const view = await goLive(harness);
    harness.setState(battle(3));
    await advance(1000 / 120, 360);
    expect(harness.bridge()?.pace).toMatchObject({ level: 0 });
    // The original picture is asked for: the game repaints everything and falls behind for a moment. The view still
    // draws for half a second (frames already rendered carry the key colour), but nothing is asked any more.
    harness.bridge()!.toggle();
    logicFps = 30;
    const before = asked.mock.calls.length;
    await advance(1000 / 120, 600);
    expect(asked.mock.calls.length).toBe(before);
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60 });
    // Shown again with the game on target: still 60.
    logicFps = 62.5;
    harness.bridge()!.toggle();
    await advance(1000 / 120, 360);
    expect(harness.hdCanvas.style.display).toBe('block');
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60 });
    expect(asked.mock.calls.length).toBeGreaterThan(before);
    expect(view.render).toHaveBeenCalled();
    harness.stop();
  });

  it('starts another match at 60 again, and keeps its pace when the game cannot be asked', async () => {
    const harness = setup();
    let logicFps = 40;
    gameAt(
      harness,
      () => logicFps,
      () => 0,
    );
    const view = await goLive(harness);
    harness.setState(battle(3));
    // Far behind: straight to the last level.
    await advance(1000 / 120, 480);
    expect(harness.bridge()?.pace).toMatchObject({ level: 2, rate: 30 });
    // The emulator stops answering: the pace stays where it is.
    (harness.vm as unknown as { getDiagnostics: () => Promise<never> }).getDiagnostics = vi.fn(async () => {
      throw new Error('VM gone');
    });
    await advance(1000 / 120, 480);
    expect(harness.bridge()?.pace).toMatchObject({ level: 2 });
    // Another match on the map (the logic frame starts over).
    logicFps = 62.5;
    view.settledFrames = 0;
    harness.setState(battle(1));
    await advance(1000 / 120, 4);
    expect(harness.bridge()?.pace).toMatchObject({ level: 0, rate: 60 });
    harness.stop();
  });
});
