import type { TimingSummary } from '../utils/timingStats';

/** Host execution measurements, independent of game policy and the presentation thread. */
export interface VmExecutionSample {
  scheduler: string;
  supported: boolean;
  active: boolean;
  elapsedMs: number;
  cpuSlices: TimingSummary;
  immediateWaits: TimingSummary;
  delayedWaitOvershoot: TimingSummary;
  staleCallbacks: number;
  jitDisabled: boolean | null;
  /** Raw upstream jit_get_cache_size value; do not infer resident memory from it. */
  jitCacheSize: number | null;
  wasmMemoryBytes: number | null;
}

/** Cumulative CPU-loop accounting on the execution thread's clock, counted from the first `usage` request. */
export interface VmExecutionUsage {
  /** Milliseconds inside the emulator's CPU loop: guest code and the device callbacks it runs inline. */
  guestMs: number;
  /** CPU-loop slices (the loop is left at every guest halt, host call and scheduler yield). */
  slices: number;
  /**
   * Modules of guest code the emulator's JIT compiled and gave up; null when it does not expose those hooks. Many
   * given up at once is its whole compiled cache being thrown away (src/vm86/jitModuleTable.ts).
   */
  jitCompiled: number | null;
  jitFreed: number | null;
}

export interface VmExecutionProbe {
  start(): void;
  sample(): VmExecutionSample;
  stop(): void;
  /**
   * Lasting, light accounting for development telemetry: the first request starts it (one clock pair per CPU slice,
   * nothing per wait) and it stays until the probe is detached. Null while the emulator cannot be metered. A session
   * that never asks keeps the unwrapped loop.
   */
  usage?(): VmExecutionUsage | null;
}
