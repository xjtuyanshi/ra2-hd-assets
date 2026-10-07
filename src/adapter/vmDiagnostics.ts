import type { GamePerformanceSample } from '../games/performance';
import type { VmExecutionSample } from '../vm86/diagnostics';
import type { VmPhase } from '../app/session/runtimeEvents';

/**
 * `start`/`sample`/`stop` bracket a bounded capture (docs/GAME_PERFORMANCE.md). `usage` belongs to development
 * telemetry: it switches on the lasting accounting in `VmDiagnostics.usage` and never touches a capture.
 */
export type VmDiagnosticAction = 'start' | 'sample' | 'stop' | 'usage';

export interface VmRuntimeInfo {
  /** Execution engine; omitted by older clients. */
  backend?: 'v86' | 'native';
  mode: 'worker' | 'main-thread';
  reason: 'default' | 'requested' | 'worker-unavailable' | 'probe-failed';
  workerProbeMs: number | null;
  fallbackReason: string | null;
}

/**
 * Where the execution thread's wall time went, cumulative since the first `usage` request and on that thread's
 * clock; a reader takes differences between two samples. What the parts leave of the elapsed time is everything
 * else on the thread: scheduler turnaround between slices, frame snapshots, messages, garbage collection.
 */
export interface VmUsage {
  /** In the emulator's CPU loop; null when the platform cannot meter it (see VmExecutionProbe.usage). */
  guestMs: number | null;
  slices: number | null;
  /** Guest code modules the emulator's JIT compiled and gave up (see VmExecutionUsage); null when unknown. */
  jitCompiled: number | null;
  jitFreed: number | null;
  /** Handling the guest's host calls (Win32 and DirectX shims), without the waits below; includes awaited file reads. */
  hostCallMs: number;
  /** Waits the guest asked for: Sleep and blocking waits while none of its threads can run. */
  guestWaitMs: number;
  /** Reading live game state for the page (render and command state) on this thread, and how many reads. */
  stateReadMs: number;
  stateReads: number;
  /** Game frames handed to presentation. */
  frames: number;
}

export interface VmDiagnostics {
  sampledAtMs: number;
  phase: VmPhase;
  hypercalls: number;
  clockRate: number;
  execution: VmExecutionSample | null;
  game: GamePerformanceSample | null;
  /** Native-backend counters; emulator-only numeric fields are unsupported sentinels. */
  native?: Readonly<Record<string, unknown>>;
  /** Present once a `usage` request has switched the accounting on. */
  usage?: VmUsage | null;
}
