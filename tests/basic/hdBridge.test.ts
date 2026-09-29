import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmShell } from '../../src/adapter/vmShell';
import type { GameRenderState } from '../../src/games/renderState';
import { startHdBridge } from '../../src/ui/pages/game/hdBridge';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';

// The bridge loads LiveView (three.js, WebGPU) through a dynamic import; a stub stands in for it.
const liveView = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../packages/hd-renderer/src/live/liveView', () => ({ LiveView: { create: liveView.create } }));

interface BridgeHandle {
  toggle(): boolean;
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

function battle(frame: number, fileName = 'XMP29U2.MAP'): GameRenderState {
  return {
    frame,
    view: { x: 100, y: 200 },
    map: { fileName },
    houses: [],
    objects: [],
    shroud: null,
    overlays: null,
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
});

describe('HD 桥状态机', () => {
  it('forwards live overlays and the local house without copying the cell arrays', async () => {
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
    harness.setState(state);
    await advance(16);
    const pushed = view.push.mock.calls.at(-1)![0];
    expect(pushed.localHouse).toBe(2);
    expect(pushed.overlays).toBe(state.overlays);
    harness.setState({ ...state, frame: 4, overlays: null });
    await advance(16);
    expect(view.push.mock.calls.at(-1)![0].overlays).toBeNull();
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
