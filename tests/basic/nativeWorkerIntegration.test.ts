import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVmWorkerController, type VmWorkerCore } from '../../src/adapter/vmWorkerController';
import type { VmInitConfig, WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import type { GameVmCallbacks } from '../../src/app/session/runtimeEvents';

const nativeConfig = (): VmInitConfig => ({
  native: { url: 'ws://127.0.0.1:15450', token: 'ab'.repeat(32) },
  provider: { kind: 'native' },
  preferredGameId: 'yr',
  selectedExecutable: { path: 'supplied.exe', bytes: new Uint8Array([0x4d, 0x5a, 1, 2]) },
  renderPassthrough: true,
  fastFileRead: false,
  clockRate: 0,
  masterVolume: 0,
  traceCalls: false,
});
function fixture() {
  const messages: WorkerToMainMessage[] = [];
  let callbacks: GameVmCallbacks | undefined;
  const credit = vi.fn();
  const core: VmWorkerCore = {
    getDiagnostics: async () => ({
      sampledAtMs: 0,
      phase: 'running',
      hypercalls: 0,
      clockRate: 0,
      execution: null,
      game: null,
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    flushFiles: async () => {
      throw new Error('native persistence unsupported');
    },
    postMessage: vi.fn(),
    setKeyState: vi.fn(),
    setCursorPosition: vi.fn(),
    setGameClockRate: vi.fn(() => 0),
    setMasterVolume: vi.fn(),
    getPointerState: async () => null,
    getGamePerformance: async () => null,
    getRenderState: async () => null,
    getCommandState: async () => null,
    setGameSpeedFlag: async () => 3,
    setTacticalPassthrough: async () => true,
    startMemRecord: () => false,
    stopMemRecord: () => null,
    setFileProvider: () => {
      throw new Error('native attachment unsupported');
    },
    requestNextFrame: credit,
  };
  const provider = vi.fn(() => {
    throw new Error('must not build a provider');
  });
  const discovery = vi.fn(async () => {
    throw new Error('must not discover native resources');
  });
  const resolution = vi.fn(async () => {
    throw new Error('must not overlay native INI');
  });
  const factory = vi.fn((events, _source, _platform, _config) => {
    callbacks = events;
    return core;
  });
  const controller = createVmWorkerController({
    postMessage: (message) => messages.push(message),
    createProvider: provider,
    discoverSources: discovery,
    applyResolution: resolution,
    createCore: factory,
  });
  return {
    messages,
    core,
    controller,
    provider,
    discovery,
    resolution,
    factory,
    credit,
    get callbacks() {
      return callbacks!;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('native Worker composition and existing protocol seam', () => {
  it('bypasses resource discovery and overlays while passing the selected executable to the injectable factory', async () => {
    vi.stubEnv('DEV', true);
    const f = fixture(),
      config = nativeConfig();
    try {
      await f.controller.handleMessage({ type: 'init', config, requestId: 1 });
      expect(f.messages).toContainEqual({ type: 'init-done', requestId: 1 });
      expect(f.provider).not.toHaveBeenCalled();
      expect(f.discovery).not.toHaveBeenCalled();
      expect(f.resolution).not.toHaveBeenCalled();
      const [, source, platform, passed] = f.factory.mock.calls[0]!;
      expect(source.game.id).toBe('yr');
      expect(source.executableBytes).toBe(config.selectedExecutable!.bytes);
      expect(passed).toBe(config);
      await expect(source.files.read('unavailable')).rejects.toThrow('no page-owned');
      expect(() => platform.createEmulator()).toThrow('no page-owned');
      await f.controller.handleMessage({ type: 'control', action: 'start', requestId: 2 });
      expect(f.core.start).toHaveBeenCalledOnce();
      expect(f.core.setGameClockRate).not.toHaveBeenCalled();
      expect(f.core.setMasterVolume).not.toHaveBeenCalled();
    } finally {
      f.controller.dispose();
    }
  });
  it('preserves a cancelled startup rejection without reviving a global error after stop', async () => {
    vi.stubEnv('DEV', true);
    const f = fixture();
    let rejectStart!: (error: Error) => void;
    vi.mocked(f.core.start).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    try {
      await f.controller.handleMessage({ type: 'init', config: nativeConfig(), requestId: 1 });
      const pending = f.controller.handleMessage({ type: 'control', action: 'start', requestId: 2 });
      await Promise.resolve();
      await f.controller.handleMessage({ type: 'control', action: 'stop', requestId: 3 });
      rejectStart(new Error('Native session stopped'));
      await pending;
      expect(f.messages).toContainEqual({ type: 'error', requestId: 2, message: 'Native session stopped' });
      expect(f.messages.some((message) => message.type === 'status' && message.phase === 'error')).toBe(false);
    } finally {
      f.controller.dispose();
    }
  });
  it('awaits asynchronous native pointer/speed/patch replies and exposes unsupported attachment/persistence', async () => {
    vi.stubEnv('DEV', true);
    const f = fixture();
    try {
      await f.controller.handleMessage({ type: 'init', config: nativeConfig(), requestId: 1 });
      await f.controller.handleMessage({ type: 'state', kind: 'pointer', requestId: 2 });
      await f.controller.handleMessage({ type: 'guest-speed-flag', value: 3, requestId: 3 });
      await f.controller.handleMessage({ type: 'tactical-passthrough', flags: 7, requestId: 4 });
      await f.controller.handleMessage({ type: 'attach-maps', files: [], requestId: 5 });
      await f.controller.handleMessage({ type: 'flush', requestId: 6 });
      expect(f.messages).toContainEqual({ type: 'state-reply', kind: 'pointer', requestId: 2, value: null });
      expect(f.messages).toContainEqual({ type: 'guest-speed-flag-reply', requestId: 3, value: 3 });
      expect(f.messages).toContainEqual({ type: 'tactical-passthrough-reply', requestId: 4, value: true });
      expect(f.messages).toContainEqual({
        type: 'error',
        requestId: 5,
        message: 'Native host does not support page file attachment',
      });
      expect(f.messages).toContainEqual({ type: 'error', requestId: 6, message: 'native persistence unsupported' });
      expect(f.messages.some((message) => message.type === 'flush-done')).toBe(false);
    } finally {
      f.controller.dispose();
    }
  });
  it('grants the next picture only for the matching presenter ACK and preserves coalesced logic-frame deltas', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', true);
    const f = fixture();
    try {
      await f.controller.handleMessage({ type: 'init', config: nativeConfig(), requestId: 1 });
      f.callbacks.onLogicFrame?.(5);
      f.callbacks.onLogicFrame?.(3);
      await vi.advanceTimersByTimeAsync(500);
      expect(f.messages).toContainEqual({ type: 'call-batch', batch: expect.objectContaining({ logicFrames: 8 }) });
      f.callbacks.onFrame?.({
        width: 1,
        height: 1,
        pixels: new Uint8Array(),
        palette: new Uint8Array(),
        rgb565: new Uint16Array([2]),
      });
      const frame = f.messages.find((message) => message.type === 'frame');
      if (!frame || frame.type !== 'frame') throw new Error('missing frame');
      await f.controller.handleMessage({ type: 'frame-ack', frameId: frame.frameId + 1 });
      expect(f.credit).not.toHaveBeenCalled();
      await f.controller.handleMessage({ type: 'frame-ack', frameId: frame.frameId });
      expect(f.credit).toHaveBeenCalledOnce();
    } finally {
      f.controller.dispose();
    }
  });
  it('rejects production native requests before constructing either native or emulator core', async () => {
    vi.stubEnv('DEV', false);
    const f = fixture();
    try {
      await f.controller.handleMessage({ type: 'init', config: nativeConfig(), requestId: 1 });
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.discovery).not.toHaveBeenCalled();
      expect(f.messages).toContainEqual({
        type: 'error',
        requestId: 1,
        message: 'Invalid development native-host configuration',
      });
    } finally {
      f.controller.dispose();
    }
  });
});
