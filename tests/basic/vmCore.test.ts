import { readFileSync } from 'node:fs';
import { RA2_YR_RESOURCE_POLICY } from '../../src/games/shared/resourcePolicy';
import { describe, expect, it, vi } from 'vitest';
import { VmCore, type VmAudioSink, type VmCorePlatform } from '../../src/adapter/vmCore';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { SUPPORTED_GAMES, type SupportedGame } from '../../src/games/catalog';
import { EMPTY_GAME_SHIM_PROFILE } from '../../src/vm86/shim/gameProfile';
import type { V86 } from 'v86';
import type { GameRenderState, GameRenderStateReader } from '../../src/games/renderState';
import type { RenderPassthroughControl } from '../../src/games/renderPassthrough';
import type { GameRuntimeHooks } from '../../src/games/runtimeHooks';
import type { GuestMemory } from '../../src/vm86/win32';
import type { Win32Shim } from '../../src/games/win32Shim';
import { HYPERCALL_EXCEPTION, HYPERCALL_HALTED, HYPERCALL_REQUEST, HYPERCALL_STACK } from '../../src/vm86/pe';
import { FIXTURE_FILE_BYTES, FIXTURE_FILE_PATH, FIXTURE_ABI, buildFixturePe } from '../fixture/fixtureProgram';

class FakeAudio implements VmAudioSink {
  readonly destroy = vi.fn(async () => {});
  readonly stopAll = vi.fn();
  createBuffer(): void {}
  duplicateBuffer(): boolean {
    return true;
  }
  setFormat(): boolean {
    return true;
  }
  writeBuffer(_id: number, _offset: number, bytes: Uint8Array): number {
    return bytes.byteLength;
  }
  play(): boolean {
    return true;
  }
  stop(): boolean {
    return true;
  }
  setCurrentPosition(): boolean {
    return true;
  }
  setVolume(): boolean {
    return true;
  }
  setPan(): boolean {
    return true;
  }
  setFrequency(): boolean {
    return true;
  }
  getState(): { positionBytes: number; playing: boolean } | null {
    return null;
  }
  releaseBuffer(): boolean {
    return true;
  }
  setMasterVolume(): void {}
}

class FakeEmulator {
  readonly destroy = vi.fn(async () => {});
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  readonly run = vi.fn(async () => {
    this.running = true;
  });
  private readonly memory = new Uint8Array(32 * 1024 * 1024);
  private running = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  add_listener(name: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    if (name === 'emulator-ready') queueMicrotask(() => listener());
  }

  remove_listener(name: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  write_memory(data: number[] | Uint8Array, address: number): void {
    this.memory.set(data, address);
  }
  read_memory(address: number, length: number): Uint8Array {
    return this.memory.subarray(address, address + length);
  }
  is_running(): boolean {
    return this.running;
  }
  serial0_send(): void {}
}

function source(): GameSource {
  const base = SUPPORTED_GAMES[0]!;
  const game: SupportedGame = {
    ...base,
    title: 'fixture',
    executable: 'fixture.exe',
    abi: FIXTURE_ABI,
    argBytes: (dll, name) => FIXTURE_ABI[`${dll.toUpperCase()}!${name}`] ?? 0,
    shimProfile: EMPTY_GAME_SHIM_PROFILE,
    runtimeHooks: undefined,
    commandLineArguments: undefined,
    defaultGameSpeed: undefined,
    preloadFiles: [],
    guestMemoryBytes: 32 * 1024 * 1024,
    stackTop: 0x0070_0000,
    heapBase: 0x00e0_0000,
    arenaTop: 0x00e0_0000,
    fastFileMirrorBase: undefined,
    fastFileMirrorTop: undefined,
    fastFileMirrorFiles: undefined,
    driveTypes: undefined,
  };
  const fixture = buildFixturePe();
  const files = new MemoryGameFileProvider(new Map([[FIXTURE_FILE_PATH, FIXTURE_FILE_BYTES]]));
  return { game, files, executableBytes: fixture.built.exe };
}

function platform(emulator: FakeEmulator, audio: FakeAudio, createShim: (emulator: V86) => Win32Shim): VmCorePlatform {
  const boot = new Uint8Array(readFileSync(new URL('../../src/vm86/boot.bin', import.meta.url)));
  return {
    resourcePolicy: RA2_YR_RESOURCE_POLICY,
    fetchBytes: async () => boot,
    scheduleFrame: (emit) => emit(),
    audio,
    fastFileRead: false,
    createEmulator: () => emulator as unknown as V86,
    createShim: (value) => createShim(value),
  };
}

function fakeShim(dispatch: () => unknown = () => null): Win32Shim {
  return {
    setGameClockRate: vi.fn(),
    dispose: vi.fn(),
    dispatch,
    inspectShellPageTitle: () => '',
    inspectHeapState: () => ({
      liveBytes: 0,
      freeBytes: 0,
      nextAddress: 0,
      virtualRegions: 0,
      virtualBytes: 0,
      virtualFreeBytes: 0,
    }),
    inspectCallbackState: () => null,
    failedOpens: [],
    unimplementedDetail: null,
  } as unknown as Win32Shim;
}

function writeU32(emulator: FakeEmulator, address: number, value: number): void {
  emulator.write_memory([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff], address);
}

describe('VmCore lifecycle orchestration', () => {
  it('客体处理较慢时按墙钟让出，不必等满 128 次调用才响应输入', async () => {
    const core = new VmCore(
      {},
      source(),
      platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
    );
    const scheduling = core as unknown as {
      calls: number;
      nextHostYieldAt: number;
      hypercallListener(): void;
      yieldToHost(): void;
      poll(): Promise<void>;
    };
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const yieldHost = vi.spyOn(scheduling, 'yieldToHost').mockImplementation(() => {});
    const poll = vi.spyOn(scheduling, 'poll').mockResolvedValue();
    try {
      scheduling.calls = 1;
      scheduling.nextHostYieldAt = 104;
      scheduling.hypercallListener();
      await Promise.resolve();
      expect(poll).toHaveBeenCalledOnce();
      expect(yieldHost).not.toHaveBeenCalled();
      now.mockReturnValue(104);
      scheduling.hypercallListener();
      expect(yieldHost).toHaveBeenCalledOnce();
      scheduling.nextHostYieldAt = 108;
      scheduling.calls = 128;
      scheduling.hypercallListener();
      expect(yieldHost).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      await core.destroy();
    }
  });
  it('FindFirstFileA 派发前等待 provider 元数据，不预挂载空的 MOD 档案', async () => {
    const emulator = new FakeEmulator();
    const fixture = source();
    await fixture.files.write('ecache01.mix', new Uint8Array(7));
    const setResults = vi.fn();
    const dispatch = vi.fn(() => {
      expect(setResults).toHaveBeenCalledWith('ECACHE*.MIX', [{ path: 'ecache01.mix', size: 7 }]);
      return null; // This test only verifies that asynchronous bridging precedes synchronous dispatch; it does not resume guest execution.
    });
    const shim = Object.assign(fakeShim(dispatch), {
      setFileSearchResults: setResults,
      resolveDynamicImport: () => ({
        id: 999,
        key: 'KERNEL32.DLL!FindFirstFileA',
        dll: 'KERNEL32.DLL',
        name: 'FindFirstFileA',
        argBytes: 8,
        slot: 0,
        stub: 0,
      }),
    });
    const core = new VmCore(
      {},
      fixture,
      platform(emulator, new FakeAudio(), () => shim),
    );
    try {
      await core.start();
      emulator.write_memory(new TextEncoder().encode('ECACHE*.MIX\0'), 0x3000);
      writeU32(emulator, HYPERCALL_STACK, 0x2000);
      writeU32(emulator, 0x2004, 0x3000);
      writeU32(emulator, 0x2008, 0x4000);
      writeU32(emulator, HYPERCALL_REQUEST, 999);
      await (core as unknown as { poll(): Promise<void> }).poll();
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
  });

  it('loads Unicode structured-storage paths before the first synchronous open', async () => {
    const emulator = new FakeEmulator();
    const fixture = source();
    const bytes = new Uint8Array([83, 71, 66, 89]);
    const path = '存档.sav';
    const mount = vi.fn();
    const dispatch = vi.fn(() => {
      expect(mount).toHaveBeenCalledWith(path, bytes, true, bytes.length);
      return null;
    });
    const shim = Object.assign(fakeShim(dispatch), {
      mountFile: mount,
      resolveDynamicImport: () => ({
        id: 999,
        key: 'OLE32.DLL!StgOpenStorage',
        dll: 'OLE32.DLL',
        name: 'StgOpenStorage',
        argBytes: 24,
        slot: 0,
        stub: 0,
      }),
    });
    const core = new VmCore(
      {},
      fixture,
      platform(emulator, new FakeAudio(), () => shim),
    );
    try {
      await core.start();
      const read = vi.spyOn(fixture.files, 'read').mockImplementation(async (name) => {
        expect(name).toBe(path);
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        return bytes;
      });
      emulator.write_memory(
        [...path, '\0'].flatMap((char) => [char.charCodeAt(0) & 255, char.charCodeAt(0) >>> 8]),
        0x3000,
      );
      writeU32(emulator, HYPERCALL_STACK, 0x2000);
      writeU32(emulator, 0x2004, 0x3000);
      writeU32(emulator, HYPERCALL_REQUEST, 999);
      await (core as unknown as { poll(): Promise<void> }).poll();
      expect(read).toHaveBeenCalledWith(path);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await core.destroy();
    }
  });

  it.each(SUPPORTED_GAMES)('$id 的启动参数经公共 VmCore 传入 shim', async (game) => {
    const emulator = new FakeEmulator();
    const fixture = source();
    fixture.game = { ...fixture.game, executable: game.executable, commandLineArguments: game.commandLineArguments };
    const shim = fakeShim();
    const hooks = platform(emulator, new FakeAudio(), () => shim);
    hooks.createShim = vi.fn(() => shim);
    const core = new VmCore({}, fixture, hooks);
    try {
      await core.start();
      expect(hooks.createShim).toHaveBeenCalledWith(
        emulator,
        expect.objectContaining({
          moduleName: game.executable,
          commandLineArguments: '-SPEEDCONTROL',
        }),
      );
    } finally {
      await core.destroy();
    }
  });

  it('首帧前上报资源名并保持运行阶段，首帧后停止启动进度', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: Array<{ phase: string; detail: string }> = [];
    const shim = fakeShim();
    Object.assign(shim, { hasMountedFile: () => false, mountFile: vi.fn() });
    const fixture = source();
    fixture.files = new MemoryGameFileProvider(
      new Map([
        ['ra2.mix', new Uint8Array([1])],
        ['language.mix', new Uint8Array([2])],
      ]),
    );
    const hooks = platform(emulator, audio, () => shim);
    let onFrame: (() => void) | undefined;
    hooks.createShim = (_memory, options) => {
      onFrame = () => options?.onFrame?.({} as never);
      return shim;
    };
    const core = new VmCore({ onStatus: (status) => statuses.push(status) }, fixture, hooks);
    try {
      await core.start();
      const sync = (
        core as unknown as {
          syncGuestFile: (pointer: number) => Promise<void> | null;
        }
      ).syncGuestFile.bind(core);
      emulator.write_memory(new TextEncoder().encode('ra2.mix\0'), 0x1000);
      await sync(0x1000);
      expect(statuses.at(-1)).toEqual({ phase: 'running', detail: '正在读取 ra2.mix…' });
      onFrame!();
      const count = statuses.length;
      emulator.write_memory(new TextEncoder().encode('language.mix\0'), 0x1000);
      await sync(0x1000);
      expect(statuses).toHaveLength(count);
      expect(shim.mountFile).toHaveBeenCalledTimes(2);
    } finally {
      await core.destroy();
    }
  });

  it('emits loading+ → ready → running → stopped and releases resources', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase) },
      source(),
      platform(emulator, audio, () => fakeShim()),
    );

    await core.start();
    expect(statuses).toEqual(['loading', 'loading', 'ready', 'running']);
    await core.stop();
    expect(statuses.at(-1)).toBe('stopped');
    await core.destroy();
    expect(emulator.destroy).toHaveBeenCalledTimes(1);
    expect(audio.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports startup error and cleans an emulator when shim creation fails', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase) },
      source(),
      platform(emulator, audio, () => {
        throw new Error('shim construction failed');
      }),
    );

    await expect(core.start()).rejects.toThrow('shim construction failed');
    expect(statuses.at(-1)).toBe('error');
    expect(emulator.destroy).toHaveBeenCalledTimes(1);
    expect(audio.destroy).toHaveBeenCalledTimes(1);
  });

  it('retries a static resource after replacing the file provider', async () => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const mounted = new Map<string, Uint8Array>();
    const shim = fakeShim();
    const shimFiles = shim as unknown as {
      hasMountedFile: (path: string) => boolean;
      mountFile: (path: string, bytes: Uint8Array) => void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes.slice());
    };
    const core = new VmCore(
      {},
      source(),
      platform(emulator, audio, () => shim),
    );
    await core.start();

    const pathPtr = 0x1000;
    const pathBytes = new Uint8Array([...new TextEncoder().encode('ra2.mix'), 0]);
    emulator.write_memory(pathBytes, pathPtr);
    const syncGuestFile = (
      core as unknown as {
        syncGuestFile: (pointer: number) => Promise<void> | null;
      }
    ).syncGuestFile.bind(core);
    await syncGuestFile(pathPtr);
    expect(mounted.has('ra2.mix')).toBe(false);

    const bytes = new Uint8Array([1, 2, 3]);
    core.setFileProvider(new MemoryGameFileProvider(new Map([['ra2.mix', bytes]])));
    await syncGuestFile(pathPtr);

    expect(mounted.get('ra2.mix')).toEqual(bytes);
    await core.destroy();
  });

  it.each([
    ['test.yro', 1, false],
    ['test.yrm', 1, false],
    ['test.mpr', 1, false],
    ['test.ini', 2, false],
    ['test.sav', 2, false],
    ['test.asset', 1, true],
    ['test.mix', 2, true],
  ] as const)('重复打开 %s：预期读取 %i 次，自定义策略=%s', async (path, reads, customPolicy) => {
    const emulator = new FakeEmulator();
    const shim = fakeShim();
    const mounted = new Map<string, Uint8Array>();
    const shimFiles = shim as unknown as {
      hasMountedFile(path: string): boolean;
      mountFile(path: string, bytes: Uint8Array): void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes);
    };
    const fixture = source();
    fixture.files = new MemoryGameFileProvider(new Map([[path, new Uint8Array([1, 2])]]));
    const read = vi.spyOn(fixture.files, 'read');
    const host = platform(emulator, new FakeAudio(), () => shim);
    if (customPolicy)
      host.resourcePolicy = {
        ...RA2_YR_RESOURCE_POLICY,
        isSessionStatic: (path) => path.endsWith('.asset'),
      };
    const core = new VmCore({}, fixture, host);
    try {
      await core.start();
      read.mockClear();
      emulator.write_memory(new TextEncoder().encode(`${path}\0`), 0x1000);
      const sync = (core as unknown as { syncGuestFile(pointer: number): Promise<void> | null }).syncGuestFile.bind(
        core,
      );
      await sync(0x1000);
      await sync(0x1000);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(mounted.get(path)).toEqual(new Uint8Array([1, 2]));
    } finally {
      await core.destroy();
    }
  });

  it('动态挂载期间旧异步读取的 miss 不会遮蔽新地图', async () => {
    const emulator = new FakeEmulator();
    const shim = fakeShim();
    const mounted = new Map<string, Uint8Array>();
    const shimFiles = shim as unknown as {
      hasMountedFile: (path: string) => boolean;
      mountFile: (path: string, bytes: Uint8Array) => void;
    };
    shimFiles.hasMountedFile = (path) => mounted.has(path);
    shimFiles.mountFile = (path, bytes) => {
      mounted.set(path, bytes.slice());
    };
    const core = new VmCore(
      {},
      source(),
      platform(emulator, new FakeAudio(), () => shim),
    );
    await core.start();
    const old = new MemoryGameFileProvider(new Map());
    vi.spyOn(old, 'hasKnownFile').mockReturnValue(null);
    let finishRead!: (value: Uint8Array | null) => void;
    vi.spyOn(old, 'read').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    core.setFileProvider(old);
    emulator.write_memory(new Uint8Array([...new TextEncoder().encode('new.mpr'), 0]), 0x1000);
    const sync = (core as unknown as { syncGuestFile(pointer: number): Promise<void> | null }).syncGuestFile.bind(core);
    const pending = sync(0x1000);
    core.setFileProvider(new MemoryGameFileProvider(new Map([['new.mpr', new Uint8Array([7])]])));
    finishRead(null);
    await pending;
    await sync(0x1000);
    expect(mounted.get('new.mpr')).toEqual(new Uint8Array([7]));
    await core.destroy();
  });

  it.each([
    ['blocked', 'blocked', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_REQUEST, 1)],
    ['normal guest exit', 'exited', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_HALTED, 1)],
    ['runtime exception', 'error', (emulator: FakeEmulator) => writeU32(emulator, HYPERCALL_EXCEPTION, 1)],
  ] as const)('reports the %s terminal path', async (_label, expected, trigger) => {
    const emulator = new FakeEmulator();
    const audio = new FakeAudio();
    const statuses: string[] = [];
    const blocked = vi.fn();
    const core = new VmCore(
      { onStatus: (status) => statuses.push(status.phase), onBlocked: blocked },
      source(),
      platform(emulator, audio, () => fakeShim()),
    );

    await core.start();
    trigger(emulator);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe(expected), { timeout: 500 });
    if (expected === 'blocked') expect(blocked).toHaveBeenCalledTimes(1);
    await core.destroy();
  });
});

describe('VmCore HD bridge opt-in', () => {
  const GUEST_MEMORY = 32 * 1024 * 1024;
  type Reserve = (size: number, alignment?: number) => number;

  function hooked(hooks: GameRuntimeHooks, game: Partial<SupportedGame> = {}): GameSource {
    const fixture = source();
    fixture.game = { ...fixture.game, ...game, runtimeHooks: hooks };
    return fixture;
  }

  function control(configAddress = 0): RenderPassthroughControl & { set: ReturnType<typeof vi.fn> } {
    return {
      supported: 7,
      keyRgb565: 0xf81f,
      configAddress,
      set: vi.fn(() => true),
      read: () => ({ flags: 0, applied: 0, counters: {} }),
    };
  }

  it('未选择加入时不安装直通补丁，开关请求返回 false', async () => {
    const prepare = vi.fn(async () => control());
    const core = new VmCore(
      {},
      hooked({ prepareRenderPassthrough: prepare }),
      platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
    );
    try {
      await core.start();
      expect(prepare).not.toHaveBeenCalled();
      expect(core.setTacticalPassthrough(3)).toBe(false);
    } finally {
      await core.destroy();
    }
  });

  it.each([
    ['堆区顶端', undefined, 0x00e0_0000],
    ['快速文件镜像顶端', 0x01f8_0000, 0x01f8_0000],
  ] as const)(
    '选择加入时从客体内存顶端分配补丁内存：对齐、不低于%s、耗尽时报错；停止后开关无效',
    async (_label, fastFileMirrorTop, floor) => {
      const emulator = new FakeEmulator();
      const reservations: Array<{ address: number; size: number; alignment: number }> = [];
      const errors: string[] = [];
      const installed = control();
      const prepare = vi.fn(async (_memory: GuestMemory, reserve: Reserve) => {
        for (const [size, alignment] of [
          [0x1000, 0x1000],
          [0x2345, 0x1000],
          [40, 16],
        ] as const)
          reservations.push({ address: reserve(size, alignment), size, alignment });
        for (const request of [() => reserve(GUEST_MEMORY), () => reserve(0), () => reserve(16, 8)]) {
          try {
            request();
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
        // Exactly the rest down to the floor still fits; one more byte does not.
        const last = reservations.at(-1)!.address;
        reservations.push({ address: reserve(last - floor, 16), size: last - floor, alignment: 16 });
        try {
          reserve(16);
        } catch (error) {
          errors.push((error as Error).message);
        }
        return installed;
      });
      const core = new VmCore({}, hooked({ prepareRenderPassthrough: prepare }, { fastFileMirrorTop }), {
        ...platform(emulator, new FakeAudio(), () => fakeShim()),
        renderPassthrough: true,
      });
      try {
        await core.start();
        expect(prepare).toHaveBeenCalledOnce();
        expect(prepare.mock.calls[0]![0]).toBe(emulator);
        let previous = GUEST_MEMORY;
        for (const { address, size, alignment } of reservations) {
          expect(address % alignment).toBe(0);
          expect(address).toBeGreaterThanOrEqual(floor);
          expect(address + size).toBeLessThanOrEqual(previous);
          previous = address;
        }
        expect(reservations[0]!.address).toBe(GUEST_MEMORY - 0x1000);
        expect(reservations.at(-1)!.address).toBe(floor);
        expect(errors).toEqual(['补丁内存区不足', '补丁内存请求无效', '补丁内存请求无效', '补丁内存区不足']);

        expect(core.setTacticalPassthrough(3)).toBe(true);
        expect(installed.set).toHaveBeenCalledWith(emulator, 3);
        await core.stop();
        expect(core.setTacticalPassthrough(0)).toBe(false);
        expect(installed.set).toHaveBeenCalledOnce();
      } finally {
        await core.destroy();
      }
    },
  );

  it('补丁未安装（钩子返回 null）时照常启动，开关请求返回 false', async () => {
    const core = new VmCore({}, hooked({ prepareRenderPassthrough: async () => null }), {
      ...platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
      renderPassthrough: true,
    });
    try {
      await core.start();
      expect(core.setTacticalPassthrough(1)).toBe(false);
    } finally {
      await core.destroy();
    }
  });

  it('启动页桩必须止于 0xA0000（v86 VGA 窗口）之前', async () => {
    const statuses: string[] = [];
    let first = 0;
    let filled = 0;
    const prepareStartupPage = vi.fn((_memory: GuestMemory, _page: string, _hash: string, reserve: Reserve) => {
      first = reserve(16);
      filled = reserve(0xa_0000 - (first + 16));
      reserve(1);
    });
    const core = new VmCore({ onStatus: (status) => statuses.push(status.phase) }, hooked({ prepareStartupPage }), {
      ...platform(new FakeEmulator(), new FakeAudio(), () => fakeShim()),
      startupPage: 'skirmish',
    });
    await expect(core.start()).rejects.toThrow('启动导航桩区不足');
    expect(prepareStartupPage).toHaveBeenCalledOnce();
    expect(first).toBeGreaterThanOrEqual(0x8_0000);
    expect(filled).toBe(first + 16);
    expect(statuses.at(-1)).toBe('error');
  });

  it('渲染状态：运行前与外壳页面返回 null；运行中只创建一次读取器，不支持或加载失败时下次重试', async () => {
    const emulator = new FakeEmulator();
    const snapshot: GameRenderState = {
      frame: 5,
      view: { x: 0, y: 0 },
      map: { fileName: 'TEST.MAP' },
      houses: [],
      localHouse: -1,
      objects: [],
      shroud: null,
      overlays: null,
      effects: null,
    };
    const reader = vi.fn(() => snapshot);
    const create = vi.fn(async (): Promise<GameRenderStateReader | null> => reader);
    let title = '';
    const shim = Object.assign(fakeShim(), { inspectShellPageTitle: () => title });
    const core = new VmCore(
      {},
      hooked({ createRenderStateReader: create }),
      platform(emulator, new FakeAudio(), () => shim),
    );
    try {
      expect(await core.getRenderState()).toBeNull();
      await core.start();
      title = 'MainMenu';
      expect(await core.getRenderState()).toBeNull();
      expect(create).not.toHaveBeenCalled();
      title = '';
      create.mockResolvedValueOnce(null);
      expect(await core.getRenderState()).toBeNull();
      create.mockRejectedValueOnce(new Error('module failed to load'));
      await expect(core.getRenderState()).rejects.toThrow('module failed to load');
      const [a, b] = await Promise.all([core.getRenderState(), core.getRenderState()]);
      expect(a).toBe(snapshot);
      expect(b).toBe(snapshot);
      expect(create).toHaveBeenCalledTimes(3);
      expect(create).toHaveBeenLastCalledWith(emulator, GUEST_MEMORY, expect.stringMatching(/^[0-9a-f]{64}$/));
      expect(reader).toHaveBeenCalledTimes(2);
      await core.stop();
      expect(await core.getRenderState()).toBeNull();
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      await core.destroy();
    }
  });
});
