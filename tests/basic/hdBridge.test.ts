import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmShell } from '../../src/adapter/vmShell';
import type { GameRenderState } from '../../src/games/renderState';
import { startHdBridge } from '../../src/ui/pages/game/hdBridge';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import { hdSidebar } from '../helpers/hdSidebar';

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

interface BridgeHandle {
  toggle(): boolean;
  readonly ui: { enabled: boolean; readonly state: GameRenderState['sidebar']; toggle(): boolean };
  readonly live: unknown;
  readonly passthrough: { flags: number; unsupported: boolean; keyed: boolean };
}

/** 800x600 frame minus YR's 168 px sidebar and 32 px command bar. */
const TACTICAL = { x: 0, y: 0, width: 632, height: 568 };
const KEY = { rect: TACTICAL, rgb565: 0xf81f };

let clock = 0;
let frames: Array<() => void> = [];

function fakeView() {
  return { push: vi.fn(), render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
}

function fakeLookView() {
  return { ...fakeView(), hd: { settings: {}, applySettings: vi.fn() } };
}

function battle(frame: number, fileName = 'XMP29U2.MAP'): GameRenderState {
  return {
    frame,
    view: { x: 100, y: 200 },
    map: { fileName },
    houses: [],
    objects: [],
    shroud: null,
    overlays: null,
    smudges: null,
    effects: null,
  } as unknown as GameRenderState;
}

function setup(search = '?hd=1', backend: VmFrameRenderer['backend'] = 'WebGL2') {
  clock = 1000;
  frames = [];
  const hdCanvas = { id: '', style: {} as Record<string, string>, remove: vi.fn() };
  const win: { location: { search: string }; __hdBridge?: BridgeHandle } = { location: { search } };
  const createElement = vi.fn(() => hdCanvas);
  vi.stubGlobal('window', win);
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
  const renderer = { backend, setTransparentKey: vi.fn(), setTransparentRect: vi.fn() };
  let state: GameRenderState | null = null;
  const vm = {
    getRenderState: vi.fn(async (): Promise<GameRenderState | null> => state),
    setTacticalPassthrough: vi.fn(async (_flags: number) => true),
  };
  const stop = startHdBridge({
    vm: vm as unknown as VmShell,
    screen: screen as unknown as HTMLCanvasElement,
    frameRenderer: renderer as unknown as VmFrameRenderer,
    invalidate: vi.fn(),
    frameSize: () => ({ width: 800, height: 600 }),
  });
  return {
    stop,
    vm,
    renderer,
    screen,
    hdCanvas,
    createElement,
    bridge: () => win.__hdBridge,
    setState(next: GameRenderState | null) {
      state = next;
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
    for (const callback of frames.splice(0)) callback();
    await settle();
  }
}

/** Enter a battle on a cached map and wait until the HD view is live. */
async function goLive(harness: ReturnType<typeof setup>, view = fakeView()) {
  liveView.create.mockResolvedValue(view);
  harness.setState(battle(1));
  await advance(16);
  await vi.waitFor(() => expect(harness.bridge()?.live).toBe(view));
  harness.setState(battle(2));
  await advance(16);
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  liveView.create.mockReset();
  hdRenderer.applyLookPreset.mockReset();
  hdUi.start.mockReset();
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
    expect(pushed.objects[0]).toMatchObject({ buildingFrame: 0, buildingDamaged: false });
    expect(pushed.objects).toEqual(state.objects);
    expect(pushed.objects[2]).not.toHaveProperty('buildState');
    expect(pushed.objects[2]).not.toHaveProperty('sequenceFrame');
    expect(pushed.objects[2]).not.toHaveProperty('activeAnim');
    expect(pushed.objects[2]).toMatchObject({ type: 'HARV', imageType: 'HORV' });
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
    harness.setState({ ...next, effects: { ...next.effects!, anims: [] } });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].effects!.anims).toEqual([]);
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
    expect(harness.polls()).toBe(3);
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
