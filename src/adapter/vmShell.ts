import type { SessionRuntime } from '../app/session/runtime';
import type { GamePerformanceSample } from '../games/performance';
import type { GameRenderState } from '../games/renderState';
import type { GuestMemRecordResult } from './memRecord';
import type { VmDiagnosticAction, VmDiagnostics, VmRuntimeInfo } from './vmDiagnostics';

/** Final input coordinates in the shim and actual presentation-surface bounds. */
export interface VmPointerState {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Main-window client area actually observed by guest GetClientRect. */
  clientWidth: number;
  clientHeight: number;
  /** Latest browser-injected keyboard message, used to confirm end to end that reserved keys such as Esc reached the guest. */
  lastKeyMessage: number;
  lastKeyVirtualKey: number;
  lastMouseMessage: number;
  lastMouseHwnd: number;
  lastMouseControlId: number;
  lastMouseCallback: number;
  lastMouseDispatchHwnd: number;
  lastMouseDispatchControlId: number;
  lastMouseDispatchCallback: number;
  campaignHoverDispatches: number;
  /** Number of synthesized WM_TIMER dispatches, indicating whether the guest is still pumping messages. */
  wmTimerDispatches: number;
}

/**
 * Shared VM-shell interface implemented by main-thread Win32GameVm and WorkerVmClient.
 * Probe reads uniformly return Promises: thin wrappers around synchronous reads on the main thread, request/response RPC in Workers. The page consumes one asynchronous interface.
 */
export interface VmAttachResult {
  attached: string[];
  existing: string[];
}

export interface VmShell extends SessionRuntime {
  readonly runtimeInfo: VmRuntimeInfo;
  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics>;
  /** Update only the filesystem; do not restart the VM or refresh the guest map list. */
  attachMapFiles(files: ReadonlyMap<string, Uint8Array>): Promise<VmAttachResult>;
  stop(): Promise<void>;
  /** Wait until all save writes from files already closed by the guest are persisted. */
  flushFiles(): Promise<void>;
  /** Win32 message injection (WM_*); see Win32Shim.postMessage for wParam/lParam semantics. */
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
  setCursorPosition(x: number, y: number): void;
  setGameClockRate(rate: number): number;
  setMasterVolume(linear: number): void;
  getPointerState(): Promise<VmPointerState | null>;
  /** Read the actual logic frame rate on demand; return null if unsupported or unloaded. */
  getGamePerformance(): Promise<GamePerformanceSample | null>;
  /**
   * Live battlefield snapshot for the HD renderer bridge; null when unsupported or not in a battle. While the snapshot
   * has not changed it resolves to the identical object again, so callers can skip their work by comparing references.
   */
  getRenderState(): Promise<GameRenderState | null>;
  /** Set the current RA2/YR game-speed setting; return the value actually written to the guest. */
  setGameSpeedFlag(value: number): Promise<number | null>;
  /**
   * HD bridge: switch the game's native overlay passthrough categories (see src/games/renderPassthrough.ts; 0 = off).
   * False when the session did not opt in, the game has no passthrough, its patches did not install, the game is not
   * running, or the flags are invalid.
   */
  setTacticalPassthrough(flags: number): Promise<boolean>;
  /** Memory-change recording: snapshot guest RAM as a baseline; return false if the VM is not ready. */
  startMemRecord(): Promise<boolean>;
  /** Finish recording and return change statistics sorted by modification count plus region summaries; null if not recording. */
  stopMemRecord(): Promise<GuestMemRecordResult | null>;
  /** Enable call hotspots and sparse samples when the debug panel first opens; otherwise count only total HCs. */
  setCallTracing(enabled: boolean): void;
}
