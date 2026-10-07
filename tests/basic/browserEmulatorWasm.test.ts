import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEmulator, expandedWasmLoader } from '../../src/platform/browser/emulator';
import { V86_JIT_EXPANDED_MODULES, V86_JIT_TABLE_OFFSET, expandV86JitModuleTable } from '../../src/vm86/jitModuleTable';

const constructed: Array<Record<string, unknown>> = [];
vi.mock('v86', () => ({
  V86: class {
    v86 = { cpu: { wm: { wasm_table: null as WebAssembly.Table | null }, jit_clear_all_funcs: vi.fn() } };
    listeners = new Set<() => void>();
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
    add_listener(_name: string, callback: () => void) {
      this.listeners.add(callback);
    }
    remove_listener(_name: string, callback: () => void) {
      this.listeners.delete(callback);
    }
    ready() {
      for (const callback of [...this.listeners]) callback();
    }
    async destroy() {}
  },
}));

afterEach(() => {
  constructed.length = 0;
  vi.restoreAllMocks();
});

const pinned = () => new Uint8Array(readFileSync(resolve('node_modules/v86/build/v86.wasm')));
const table = (maximum?: number) =>
  new WebAssembly.Table({ element: 'anyfunc', initial: 1924, ...(maximum ? { maximum } : {}) });
const EXPORTS = {} as WebAssembly.Exports;

/** The loader with files and instantiation replaced: which bytes it runs, and what it reports. */
function loader(files: Record<string, Uint8Array>, instantiate?: (bytes: Uint8Array) => WebAssembly.Exports) {
  const ran: Uint8Array[] = [];
  const reported: Array<number | null> = [];
  const load = vi.fn(async (url: string) => {
    const bytes = files[url];
    if (!bytes) throw new Error(`${url}: HTTP 404`);
    return bytes;
  });
  const run = expandedWasmLoader('/assets/v86.wasm', (modules) => reported.push(modules), {
    load,
    instantiate: async (bytes) => {
      ran.push(bytes);
      return instantiate ? instantiate(bytes) : EXPORTS;
    },
  });
  return { run, ran, reported, load };
}

describe('loading the emulator binary with the larger compiled-module table', () => {
  it('runs the rewritten pinned binary with a table long enough for every slot', async () => {
    const stock = pinned();
    const t = table();
    const { run, ran, reported } = loader({ '/assets/v86.wasm': stock });
    expect(await run({ env: { __indirect_function_table: t } })).toBe(EXPORTS);
    expect(reported).toEqual([V86_JIT_EXPANDED_MODULES]);
    expect(t.length).toBe(V86_JIT_TABLE_OFFSET + V86_JIT_EXPANDED_MODULES + 1);
    expect(ran).toHaveLength(1);
    expect(Buffer.from(ran[0]!).equals(Buffer.from((await expandV86JitModuleTable(stock))!))).toBe(true);
  });

  it('runs any other binary, and the pinned one without a growable table, exactly as shipped', async () => {
    const other = pinned();
    other[other.length - 1]! ^= 1;
    const a = loader({ '/assets/v86.wasm': other });
    const t = table();
    await a.run({ env: { __indirect_function_table: t } });
    expect(a.reported).toEqual([null]);
    expect(a.ran[0]).toBe(other);
    expect(t.length).toBe(1924);
    const environments: WebAssembly.ModuleImports[] = [{ __indirect_function_table: table(1924) }, {}];
    for (const env of environments) {
      const stock = pinned();
      const b = loader({ '/assets/v86.wasm': stock });
      await b.run({ env });
      expect(b.reported).toEqual([null]);
      expect(b.ran[0]).toBe(stock);
    }
  });

  it('falls back to the stock binary when the rewritten one does not start, then to the upstream fallback build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stock = pinned();
    const fallback = new Uint8Array([1, 2, 3]);
    let attempt = 0;
    const once = loader({ '/assets/v86.wasm': stock }, () => {
      if (attempt++ === 0) throw new Error('compile error');
      return EXPORTS;
    });
    await once.run({ env: { __indirect_function_table: table() } });
    expect(once.reported).toEqual([null]);
    expect(once.ran[1]).toBe(stock);
    expect(warn).toHaveBeenCalledOnce();
    const twice = loader({ '/assets/v86.wasm': stock, '/assets/v86-fallback.wasm': fallback }, (bytes) => {
      if (bytes !== fallback) throw new Error('no SIMD');
      return EXPORTS;
    });
    expect(await twice.run({ env: { __indirect_function_table: table() } })).toBe(EXPORTS);
    expect(twice.ran.at(-1)).toBe(fallback);
    expect(twice.reported).toEqual([null]);
    // A binary that cannot be fetched at all is the emulator's own failure to start.
    await expect(loader({}).run({ env: {} })).rejects.toThrow('404');
  });
});

describe('browser emulator construction', () => {
  it('adds the loader only when the larger table is asked for, and only for a binary given by path', () => {
    const expanded = { expandJitModules: true };
    createBrowserEmulator({ wasm_path: '/assets/v86.wasm', autostart: false }, undefined, expanded);
    expect(constructed[0]).toMatchObject({ wasm_path: '/assets/v86.wasm', wasm_fn: expect.any(Function) });
    // The default: the emulator loads its own binary as shipped.
    createBrowserEmulator({ wasm_path: '/assets/v86.wasm', autostart: false });
    expect(constructed[1]).not.toHaveProperty('wasm_fn');
    createBrowserEmulator({ autostart: false }, undefined, expanded);
    expect(constructed[2]).not.toHaveProperty('wasm_fn');
    const own = async () => EXPORTS;
    createBrowserEmulator({ wasm_path: '/assets/v86.wasm', wasm_fn: own, autostart: false }, undefined, expanded);
    expect(constructed[3]!.wasm_fn).toBe(own);
  });

  it('makes the emulator forget every slot of the larger table when it resets, and leaves a stock one alone', async () => {
    const stock = pinned();
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => stock.buffer.slice(0) }));
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiate')
      .mockResolvedValue({ instance: { exports: EXPORTS } } as never);
    const emulator = createBrowserEmulator({ wasm_path: '/assets/v86.wasm', autostart: false }, undefined, {
      expandJitModules: true,
    });
    const fake = emulator as unknown as {
      ready(): void;
      v86: { cpu: { wm: { wasm_table: WebAssembly.Table | null }; jit_clear_all_funcs: () => void } };
    };
    const t = table();
    await (constructed[0]!.wasm_fn as (imports: WebAssembly.Imports) => Promise<unknown>)({
      env: { __indirect_function_table: t },
    });
    expect(instantiate).toHaveBeenCalledOnce();
    fake.v86.cpu.wm.wasm_table = t;
    const upstream = fake.v86.cpu.jit_clear_all_funcs;
    fake.ready();
    expect(fake.v86.cpu.jit_clear_all_funcs).not.toBe(upstream);
    const set = vi.spyOn(t, 'set');
    fake.v86.cpu.jit_clear_all_funcs();
    expect(set).toHaveBeenCalledTimes(V86_JIT_EXPANDED_MODULES + 1);
    expect(set).toHaveBeenNthCalledWith(1, V86_JIT_TABLE_OFFSET, null);
    expect(set).toHaveBeenLastCalledWith(V86_JIT_TABLE_OFFSET + V86_JIT_EXPANDED_MODULES, null);
    vi.unstubAllGlobals();
    // The default (stock table): the emulator's own method stays.
    const plain = createBrowserEmulator({ wasm_path: '/assets/v86.wasm', autostart: false }) as unknown as typeof fake;
    const own = plain.v86.cpu.jit_clear_all_funcs;
    plain.ready();
    expect(plain.v86.cpu.jit_clear_all_funcs).toBe(own);
  });
});
