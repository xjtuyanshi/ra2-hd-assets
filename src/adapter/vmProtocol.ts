import type { GamePerformanceSample } from '../games/performance';
import type { GameCommandState } from '../games/commandState';
import type { GameRenderPreparation, GameRenderState } from '../games/renderState';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';
import type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';
import type { VmFrame, Win32Call, VmNetworkStatus } from '../vm86/win32';
import type { SupportedGameId } from '../games/catalog';
import type { GuestMemRecordResult } from './memRecord';
import type { VmAttachResult, VmPointerState } from './vmShell';
import type { VmCallBatch, VmPhase } from '../app/session/runtimeEvents';
import type { GameResolution } from '../games/resolution';
import type { Ra2NetworkConfig } from '../games/ra2/networkTransport';
import type { MenuSnapshot } from '../vm86/menuSnapshot';

/** Main-thread/Worker message protocol. Array fields (PCM/frames/EXE) transfer ownership; a single FIFO channel preserves order. */

/**
 * Game files sent to the Worker with init (session packages/overlays). Buffers transfer with the message; the main thread already made independent copies, so transfer cannot affect the page's provider.
 */
export interface GameFileEntry {
  path: string;
  bytes: Uint8Array;
}

export interface VmInitConfig {
  /** Development-only native attachment; the game is already running outside the page. */
  native?: { url: string; token: string; pageCursor?: boolean; sessionStatusUrl?: string };
  startupPage?: string;
  /** HD bridge opt-in: install the game's inert native overlay passthrough patches before the entry point. */
  renderPassthrough?: boolean;
  /** Validated page cursor art is available before game startup. */
  pageCursor?: boolean;
  /**
   * File backend: directory handles (transferred/cloned), session-package memory files (online ZIP extraction results transferred with the message), or a development HTTP provider marker.
   * Provider instances cannot be structured-cloned; rebuild and rediscover in the Worker, also rebuilding the game's sourceTransform. Directory overlays contain online-package layers above the directory, innermost first with later layers overriding earlier ones, matching the page's Overlay-chain precedence.
   */
  provider:
    | { kind: 'native' }
    | { kind: 'directory'; handle: FileSystemDirectoryHandle; overlays?: GameFileEntry[] }
    | { kind: 'memory'; files: GameFileEntry[]; label: string }
    /** Two-stage loading: send the complete directory first, then read bytes through the port on demand; unextracted files wait for their producer. */
    | { kind: 'port'; port: MessagePort; names: string[]; label: string }
    /** `root`: sub-folder of the development server's game directory that holds this session's game folder. */
    | { kind: 'http'; root?: string };
  /** Selected game in a multi-game directory; the Worker uses this after rediscovery. */
  preferredGameId: SupportedGameId;
  /**
   * The EXE actually selected by the page, relative to the underlying provider root. Overlay before Worker discovery so it cannot reread an old same-named executable from the development/authorized directory. The buffer is an independent transfer copy.
   */
  selectedExecutable?: GameFileEntry;
  /** Custom map/text packages take precedence over the base game, regardless of HTTP, directory, or memory backends. */
  additionalFiles?: GameFileEntry[];
  /** Startup resolution applied only in the memory-provider overlay after reading the original INI; never write to the user's directory. */
  resolution?: GameResolution;
  /** Overlay the INI after rebuilding the Worker provider; development HTTP mode must retain the player name too. */
  playerName?: string;
  /** Startup game speed for this session (original INI scale 0..6) in place of the catalog default. */
  gameSpeed?: number;
  /** Room and EXE SHA-256 for explicitly enabled RA2 networking; omitted means single-player. */
  ra2Network?: Ra2NetworkConfig;
  /** The page owns the WS connection; the Worker sends and receives through a port transferred with init. */
  relayPort?: MessagePort;
  fastFileRead: boolean;
  /** Run the emulator with the larger compiled-module table (?jit-modules=expanded); see src/vm86/jitModuleTable.ts. */
  expandJitModules?: boolean;
  clockRate: number;
  masterVolume: number;
  /** F2/?debug call hotspots; when disabled, the Worker only increments an integer per HC. */
  traceCalls: boolean;
}

export type MainToWorkerMessage =
  | { type: 'diagnostics'; action: VmDiagnosticAction; requestId: number }
  | { type: 'game-performance'; requestId: number }
  | { type: 'render-state'; requestId: number }
  | { type: 'render-preparation'; requestId: number }
  | { type: 'command-state'; requestId: number }
  | { type: 'menu-snapshot'; requestId: number }
  | { type: 'attach-maps'; files: GameFileEntry[]; requestId: number }
  | { type: 'init'; config: VmInitConfig; requestId: number }
  | { type: 'wm'; m: number; w: number; l: number }
  | { type: 'key'; vk: number; down: boolean }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'clock'; rate: number }
  | { type: 'volume'; linear: number }
  | { type: 'call-tracing'; enabled: boolean }
  | { type: 'state'; kind: 'pointer'; requestId: number }
  | { type: 'guest-speed-flag'; value: number; requestId: number }
  | { type: 'tactical-passthrough'; flags: number; requestId: number }
  | { type: 'mem-record-start'; requestId: number }
  | { type: 'mem-record-stop'; requestId: number }
  /** The main thread consumed this frame at a display-refresh boundary; the Worker may release the next frame. */
  | { type: 'frame-ack'; frameId: number }
  /** Previous frame no longer referenced by the page; separate from ACK because the current frame is still needed for cursor redraws. */
  | { type: 'recycle-frame'; buffer: ArrayBuffer }
  | { type: 'flush'; requestId: number }
  | { type: 'control'; action: 'start'; requestId: number }
  | { type: 'control'; action: 'stop'; requestId: number };

export type WorkerToMainMessage =
  | { type: 'diagnostics-reply'; requestId: number; value: VmDiagnostics }
  | { type: 'game-performance-reply'; requestId: number; value: GamePerformanceSample | null }
  | { type: 'render-state-reply'; requestId: number; value: GameRenderState | null }
  | { type: 'render-preparation-reply'; requestId: number; value: GameRenderPreparation | null }
  | { type: 'command-state-reply'; requestId: number; value: GameCommandState | null }
  | { type: 'menu-snapshot-reply'; requestId: number; value: MenuSnapshot | null }
  /** An omitted cell layer retains the preceding ordered reply's publication; explicit null clears it. */
  | {
      type: 'render-state-cells-unchanged';
      requestId: number;
      value: Omit<GameRenderState, 'overlays' | 'smudges'> & Partial<Pick<GameRenderState, 'overlays' | 'smudges'>>;
    }
  /**
   * The core returned the same snapshot object as the last render-state reply this Worker posted: the client answers
   * with its copy of that reply instead of receiving another structured clone.
   */
  | { type: 'render-state-unchanged'; requestId: number }
  | { type: 'network-status'; status: VmNetworkStatus }
  | { type: 'attach-maps-done'; result: VmAttachResult; requestId: number }
  | { type: 'probe'; ready: true }
  | { type: 'status'; phase: VmPhase; detail: string }
  | { type: 'shell-page'; title: string }
  | { type: 'movie-playback'; playing: boolean }
  | { type: 'call-batch'; batch: VmCallBatch }
  | { type: 'blocked'; call: Win32Call }
  | { type: 'frame'; frameId: number; frame: VmFrame }
  | {
      type: 'state-reply';
      requestId: number;
      kind: 'pointer';
      value: VmPointerState | null;
    }
  | { type: 'guest-speed-flag-reply'; requestId: number; value: number | null }
  | { type: 'tactical-passthrough-reply'; requestId: number; value: boolean }
  | { type: 'mem-record-start-reply'; requestId: number; ok: boolean }
  | { type: 'mem-record-stop-reply'; requestId: number; result: GuestMemRecordResult | null }
  | { type: 'audio'; op: AudioOp }
  | { type: 'audio-control'; action: 'master-volume'; linear: number }
  | { type: 'audio-control'; action: 'stop-all' }
  | { type: 'audio-control'; action: 'destroy' }
  | { type: 'init-done'; requestId: number }
  | { type: 'flush-done'; requestId: number }
  | { type: 'control-done'; action: 'start' | 'stop'; requestId: number }
  | { type: 'error'; message: string; requestId?: number };

/**
 * Audio operations mirror Win32AudioSink (win32.ts:105-118). getState is never sent: synchronous cross-thread reads are unavailable, so ProxyAudioSink.getState returns null and the shim falls back to local accounting.
 */
export type AudioOp =
  | { op: 'createBuffer'; id: number; byteLength: number; format: PcmWaveFormat }
  | { op: 'duplicateBuffer'; sourceId: number; destinationId: number }
  | { op: 'setFormat'; id: number; format: PcmWaveFormat }
  | { op: 'writeBuffer'; id: number; offset: number; bytes: Uint8Array }
  | { op: 'play'; id: number; options?: PcmPlayOptions }
  | { op: 'stop'; id: number }
  | { op: 'setCurrentPosition'; id: number; byteOffset: number }
  | { op: 'setVolume'; id: number; volume: number }
  | { op: 'setPan'; id: number; pan: number }
  | { op: 'setFrequency'; id: number; frequency: number }
  | { op: 'releaseBuffer'; id: number };

let nextRequestId = 1;
/** Monotonically increasing requestId, unique within a session; independent counters on each thread do not affect correlation. */
export function createRequestId(): number {
  return nextRequestId++;
}
