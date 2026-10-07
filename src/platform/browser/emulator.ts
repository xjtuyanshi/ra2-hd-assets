import { V86 } from 'v86';
import type { BrowserEmulatorProbe } from './emulatorProbe';
import {
  expandV86JitModuleTable,
  growV86JitTable,
  V86_JIT_EXPANDED_MODULES,
  V86_JIT_TABLE_OFFSET,
} from '../../vm86/jitModuleTable';

interface CpuScheduler {
  running: boolean;
  worker: { terminate(): void } | null;
  yield(delay: number, tick: number): void;
  yield_callback(tick: number): void;
  unregister_yield(): void;
}

/** Internal scheduling interface of v86 0.5.441; preserve upstream behavior if its shape differs. */
export function installWorkerCpuScheduler(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object' || typeof MessageChannel !== 'function') return false;
  const engine = candidate as CpuScheduler;
  if (
    engine.running !== false ||
    typeof engine.yield !== 'function' ||
    typeof engine.yield_callback !== 'function' ||
    typeof engine.unregister_yield !== 'function' ||
    typeof engine.worker?.terminate !== 'function'
  )
    return false;

  const channel = new MessageChannel();
  const unregister = engine.unregister_yield.bind(engine);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Initialization has not called run, so there are no CPU ticks to migrate. Release the original nested timer Worker.
  unregister();
  channel.port1.onmessage = (event: MessageEvent<{ delay: number; tick: number }>) => {
    if (closed) return;
    clearTimeout(timer);
    timer = undefined;
    const { delay, tick } = event.data;
    // Preserve upstream positive waits and yield_callback's stale-tick checks.
    if (delay < 1) engine.yield_callback(tick);
    else
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) engine.yield_callback(tick);
      }, delay);
  };
  engine.yield = (delay, tick) => {
    if (!closed) channel.port2.postMessage({ delay, tick });
  };
  engine.unregister_yield = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    unregister();
  };
  return true;
}

export interface BrowserEmulatorSettings {
  /**
   * Give the pinned emulator build the larger compiled-module table (src/vm86/jitModuleTable.ts) instead of its own
   * 899 slots. Off by default: the binary runs as shipped unless a session asks for it; any other build runs as
   * shipped either way.
   */
  expandJitModules?: boolean;
}

type EmulatorOptions = ConstructorParameters<typeof V86>[0];

/** Replaceable pieces of the loader below (tests). */
export interface WasmLoaderEnvironment {
  load(url: string): Promise<Uint8Array>;
  instantiate(bytes: Uint8Array, imports: WebAssembly.Imports): Promise<WebAssembly.Exports>;
}

const browserWasmEnvironment: WasmLoaderEnvironment = {
  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  instantiate: async (bytes, imports) =>
    (await WebAssembly.instantiate(bytes as BufferSource, imports)).instance.exports,
};

/**
 * The emulator's own wasm loader (fetch, instantiate, fall back to the build without SIMD), with one step added:
 * the pinned binary is given the larger compiled-module table before it is instantiated. `expanded` is told the
 * slot count in use, or null for the stock binary. A failure anywhere in that step runs the stock binary instead.
 */
export function expandedWasmLoader(
  path: string,
  expanded: (modules: number | null) => void,
  environment: WasmLoaderEnvironment = browserWasmEnvironment,
): NonNullable<EmulatorOptions['wasm_fn']> {
  return async (imports) => {
    const stock = await environment.load(path);
    try {
      const table = (imports.env as Record<string, unknown> | undefined)?.__indirect_function_table;
      const patched = table instanceof WebAssembly.Table ? await expandV86JitModuleTable(stock) : null;
      if (patched && growV86JitTable(table as WebAssembly.Table, V86_JIT_EXPANDED_MODULES)) {
        const exports = await environment.instantiate(patched, imports);
        expanded(V86_JIT_EXPANDED_MODULES);
        return exports;
      }
    } catch (error) {
      console.warn('[VM] larger compiled-code table unavailable; running the stock emulator', error);
    }
    expanded(null);
    try {
      return await environment.instantiate(stock, imports);
    } catch {
      // Upstream's own fallback: the build for browsers without the wasm features the default one needs.
      return await environment.instantiate(
        await environment.load(path.replace('v86.wasm', 'v86-fallback.wasm')),
        imports,
      );
    }
  };
}

/** The browser host owns CPU scheduling ports; V86.destroy releases them through the existing ownership chain. */
export function createBrowserEmulator(
  options: EmulatorOptions,
  probe?: BrowserEmulatorProbe,
  settings: BrowserEmulatorSettings = {},
): V86 {
  /** Compiled-module slots of the running binary once it is loaded through the loader below; null = stock. */
  let jitModules: number | null = null;
  const expand = settings.expandJitModules === true && typeof options.wasm_path === 'string' && !options.wasm_fn;
  const emulator = new V86(
    expand
      ? { ...options, wasm_fn: expandedWasmLoader(options.wasm_path!, (modules) => (jitModules = modules)) }
      : options,
  );
  // Replace only nested Workers inside Dedicated Workers. Window retains the upstream timer Worker,
  // avoiding migration of positive waits to Window.setTimeout, which may be throttled in background tabs.
  const adaptWorker =
    options.autostart === false && typeof (globalThis as { importScripts?: unknown }).importScripts === 'function';
  if (!adaptWorker && !probe && !expand) return emulator;
  let disposed = false;
  const ready = () => {
    emulator.remove_listener('emulator-ready', ready);
    if (disposed) return;
    const engine = (emulator as unknown as { v86?: { worker?: unknown; cpu?: JitTableOwner } }).v86;
    if (jitModules !== null && engine?.cpu) clearWholeJitTable(engine.cpu, jitModules);
    const adapted = adaptWorker && installWorkerCpuScheduler(engine);
    probe?.attach(engine, adapted ? 'message-channel' : engine?.worker ? 'upstream-worker' : 'upstream-other');
  };
  const destroy = emulator.destroy.bind(emulator);
  emulator.destroy = async () => {
    disposed = true;
    probe?.detach();
    emulator.remove_listener('emulator-ready', ready);
    await destroy();
  };
  emulator.add_listener('emulator-ready', ready);
  return emulator;
}

interface JitTableOwner {
  wm?: { wasm_table?: WebAssembly.Table };
  jit_clear_all_funcs?: () => void;
}

/**
 * The emulator's "forget every compiled module" (state restore and reset) walks its stock 900 table entries: with
 * the larger table it must walk them all, or a later slot would keep a module of the discarded state.
 */
function clearWholeJitTable(cpu: JitTableOwner, modules: number): void {
  if (typeof cpu.jit_clear_all_funcs !== 'function') return;
  cpu.jit_clear_all_funcs = () => {
    const table = cpu.wm?.wasm_table;
    if (!table) return;
    const end = Math.min(table.length, V86_JIT_TABLE_OFFSET + modules + 1);
    for (let index = V86_JIT_TABLE_OFFSET; index < end; index++) table.set(index, null);
  };
}
