import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmInitConfig } from '../../src/adapter/vmProtocol';
import type { GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
const state = vi.hoisted(() => ({
  configs: [] as VmInitConfig[],
  probe: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}));
vi.mock('../../src/adapter/vmClient', () => ({
  WorkerVmClient: class {
    constructor(_callbacks: unknown, config: VmInitConfig) {
      state.configs.push(config);
    }
    waitProbe() {
      return state.probe();
    }
    destroy() {
      return state.destroy();
    }
  },
}));
import { createVmShell } from '../../src/adapter/runtime';
function source(): GameSource {
  return {
    game: supportedGame('yr'),
    executableBytes: new Uint8Array([0x4d, 0x5a, 3]),
    files: {
      label: 'synthetic',
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      list: vi.fn(async () => null),
    },
  };
}
function browser(search: string) {
  vi.stubGlobal('window', { location: { search } });
  vi.stubGlobal('Worker', class {});
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  state.configs.length = 0;
  state.probe.mockReset().mockResolvedValue();
  state.destroy.mockReset().mockResolvedValue();
});

describe('development native URL selection', () => {
  it('passes native connection data and an independent EXE copy without reading or changing game files', async () => {
    vi.stubEnv('DEV', true);
    browser('?backend=native&agent=ws%3A%2F%2F127.0.0.1%3A15450&agent-token=' + 'ab'.repeat(32));
    const supplied = source(),
      original = supplied.executableBytes.slice();
    await createVmShell({}, supplied, { renderPassthrough: true });
    const config = state.configs[0]!;
    expect(config.native).toEqual({ url: 'ws://127.0.0.1:15450', token: 'ab'.repeat(32), pageCursor: true });
    expect(config.provider).toEqual({ kind: 'native' });
    expect(config.renderPassthrough).toBe(true);
    expect(config.selectedExecutable!.bytes).toEqual(original);
    expect(config.selectedExecutable!.bytes).not.toBe(supplied.executableBytes);
    expect(supplied.files.read).not.toHaveBeenCalled();
    expect(supplied.files.write).not.toHaveBeenCalled();
    expect(supplied.files.list).not.toHaveBeenCalled();
    expect(supplied.executableBytes).toEqual(original);
  });
  it('preserves game cursor presentation when requested or page art is unavailable', async () => {
    vi.stubEnv('DEV', true);
    const nativeUrl = '?backend=native&agent=ws%3A%2F%2F127.0.0.1%3A15450&agent-token=' + 'ab'.repeat(32);
    browser(nativeUrl + '&native-cursor=game');
    await createVmShell({}, source());
    expect(state.configs[0]!.native!.pageCursor).toBe(false);
    browser(nativeUrl);
    await createVmShell({}, source(), { nativePageCursor: false });
    expect(state.configs[1]!.native!.pageCursor).toBe(false);
  });
  it('keeps the existing Worker configuration when native was not requested', async () => {
    browser('');
    await createVmShell({}, source());
    expect(state.configs[0]!.native).toBeUndefined();
    expect(state.configs[0]!.provider.kind).toBe('http');
    expect(state.configs[0]!.clockRate).toBe(1);
  });
  it('rejects missing credentials, unavailable Workers and production native selection explicitly', async () => {
    vi.stubEnv('DEV', true);
    browser('?backend=native');
    await expect(createVmShell({}, source())).rejects.toThrow('agent and agent-token');
    browser('?backend=native&vm-worker=0');
    await expect(createVmShell({}, source())).rejects.toThrow('requires the Worker');
    vi.stubEnv('DEV', false);
    browser('?backend=native');
    await expect(createVmShell({}, source())).rejects.toThrow('only in development');
    expect(state.configs).toHaveLength(0);
  });
  it('destroys a failed native Worker probe and never constructs an emulator fallback', async () => {
    vi.stubEnv('DEV', true);
    browser('?backend=native&agent=ws%3A%2F%2F127.0.0.1%3A15450&agent-token=' + 'ab'.repeat(32));
    state.probe.mockRejectedValueOnce(new Error('probe fixture refused'));
    const supplied = source();
    await expect(createVmShell({}, supplied)).rejects.toThrow('probe fixture refused');
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]!.native).toBeDefined();
    expect(supplied.files.read).not.toHaveBeenCalled();
  });
});
