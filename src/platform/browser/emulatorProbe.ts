import { TimingStats } from '../../utils/timingStats';
import type { VmExecutionProbe, VmExecutionSample, VmExecutionUsage } from '../../vm86/diagnostics';

interface Engine {
  tick_counter: number;
  yield(delay: number, tick: number): void;
  yield_callback(tick: number): void;
  cpu: {
    main_loop(): number;
    codegen_finalize?: (...args: never[]) => unknown;
    jit_clear_func?: (...args: never[]) => unknown;
    wasm_memory?: WebAssembly.Memory;
    wm?: { exports?: { get_jit_config?: (index: number) => number; jit_get_cache_size?: () => number } };
  };
}

/** Observe the existing v86 scheduler only during an explicit capture; never change deadlines or execute extra ticks. */
export class BrowserEmulatorProbe implements VmExecutionProbe {
  private engine: Engine | null = null;
  private scheduler = 'unavailable';
  private restore: (() => void) | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private stoppedAt: number | null = null;
  private slices = new TimingStats();
  private immediate = new TimingStats();
  private delayed = new TimingStats();
  private stale = 0;
  /** Lasting CPU-loop accounting (see `usage`); installed below a capture's wrapper, never above it. */
  private meter: {
    guestMs: number;
    slices: number;
    jitCompiled: number | null;
    jitFreed: number | null;
    restore: () => void;
  } | null = null;
  private meterWanted = false;

  attach(candidate: unknown, scheduler: string): void {
    this.dropMeter();
    this.stop();
    this.scheduler = scheduler;
    const engine = candidate as Engine | null;
    this.engine =
      engine &&
      typeof engine.tick_counter === 'number' &&
      typeof engine.yield === 'function' &&
      typeof engine.yield_callback === 'function' &&
      typeof engine.cpu?.main_loop === 'function'
        ? engine
        : null;
  }

  start(): void {
    this.stop();
    this.startedAt = performance.now();
    this.stoppedAt = null;
    this.slices = new TimingStats();
    this.immediate = new TimingStats();
    this.delayed = new TimingStats();
    this.stale = 0;
    const engine = this.engine;
    if (!engine) return;
    // A lost client or RPC must not leave hot-path instrumentation enabled indefinitely.
    this.watchdog = setTimeout(() => this.stop(), 30_000);
    const originalYield = engine.yield;
    const originalCallback = engine.yield_callback;
    const originalLoop = engine.cpu.main_loop;
    let pendingTick = -1,
      pendingAt = 0,
      pendingDelay = 0;
    engine.yield = (delay, tick) => {
      pendingTick = tick;
      pendingAt = performance.now();
      pendingDelay = delay < 1 ? 0 : delay;
      originalYield.call(engine, delay, tick);
    };
    engine.yield_callback = (tick) => {
      // v86 discards superseded callbacks. They must not inflate measured scheduling waits.
      if (tick !== engine.tick_counter) this.stale++;
      else if (pendingTick === tick) {
        const elapsed = performance.now() - pendingAt;
        if (pendingDelay === 0) this.immediate.add(elapsed);
        else this.delayed.add(Math.max(0, elapsed - pendingDelay));
        pendingTick = -1;
      }
      originalCallback.call(engine, tick);
    };
    engine.cpu.main_loop = () => {
      const at = performance.now();
      try {
        return originalLoop.call(engine.cpu);
      } finally {
        this.slices.add(performance.now() - at);
      }
    };
    this.restore = () => {
      engine.yield = originalYield;
      engine.yield_callback = originalCallback;
      engine.cpu.main_loop = originalLoop;
    };
  }

  sample(): VmExecutionSample {
    const exports = this.engine?.cpu.wm?.exports;
    return {
      scheduler: this.scheduler,
      supported: this.engine !== null,
      active: this.restore !== null,
      elapsedMs: Math.max(0, (this.stoppedAt ?? performance.now()) - this.startedAt),
      cpuSlices: this.slices.snapshot(),
      immediateWaits: this.immediate.snapshot(),
      delayedWaitOvershoot: this.delayed.snapshot(),
      staleCallbacks: this.stale,
      jitDisabled: exports?.get_jit_config ? exports.get_jit_config(0) !== 0 : null,
      jitCacheSize: exports?.jit_get_cache_size?.() ?? null,
      wasmMemoryBytes: this.engine?.cpu.wasm_memory?.buffer.byteLength ?? null,
    };
  }

  stop(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.restore?.();
    this.restore = null;
    this.stoppedAt ??= performance.now();
    // A capture restores the loop it found: accounting asked for while it ran starts now.
    this.installMeter();
  }

  /**
   * Time inside the CPU loop since the first request (development telemetry). Unlike a capture it stays for the
   * session and wraps only the loop: one clock pair per slice, no wait statistics, no watchdog.
   */
  usage(): VmExecutionUsage | null {
    this.meterWanted = true;
    this.installMeter();
    const meter = this.meter;
    return meter
      ? { guestMs: meter.guestMs, slices: meter.slices, jitCompiled: meter.jitCompiled, jitFreed: meter.jitFreed }
      : null;
  }

  detach(): void {
    this.dropMeter();
    this.stop();
    this.engine = null;
  }

  private installMeter(): void {
    const engine = this.engine;
    if (!engine || this.meter || this.restore || !this.meterWanted) return;
    const cpu = engine.cpu;
    const loop = cpu.main_loop;
    // v86's wasm imports call these two through the cpu object, so counting wrappers on it see every module.
    const finalize = cpu.codegen_finalize;
    const free = cpu.jit_clear_func;
    const meter: NonNullable<BrowserEmulatorProbe['meter']> = {
      guestMs: 0,
      slices: 0,
      jitCompiled: typeof finalize === 'function' ? 0 : null,
      jitFreed: typeof free === 'function' ? 0 : null,
      restore: () => {
        cpu.main_loop = loop;
        if (typeof finalize === 'function') cpu.codegen_finalize = finalize;
        if (typeof free === 'function') cpu.jit_clear_func = free;
      },
    };
    if (typeof finalize === 'function')
      cpu.codegen_finalize = function (this: unknown, ...args: never[]) {
        meter.jitCompiled!++;
        return finalize.apply(this, args);
      };
    if (typeof free === 'function')
      cpu.jit_clear_func = function (this: unknown, ...args: never[]) {
        meter.jitFreed!++;
        return free.apply(this, args);
      };
    engine.cpu.main_loop = () => {
      const at = performance.now();
      try {
        return loop.call(engine.cpu);
      } finally {
        meter.guestMs += performance.now() - at;
        meter.slices++;
      }
    };
    this.meter = meter;
  }

  private dropMeter(): void {
    this.meterWanted = false;
    if (!this.meter) return;
    // A capture above the meter holds the metered loop as its original: end it first so the engine's own loop returns.
    this.restore?.();
    this.restore = null;
    this.meter.restore();
    this.meter = null;
  }
}
