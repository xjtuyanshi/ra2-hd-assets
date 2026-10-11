import type { GamePerformanceSample } from '../games/performance';
import type { GameCommandState } from '../games/commandState';
import type { GameRenderState } from '../games/renderState';
import { PortRelaySocket } from 'relay-package/client';
import { createBrowserEmulator } from '../platform/browser/emulator';
import { BrowserEmulatorProbe } from '../platform/browser/emulatorProbe';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';
import { DirectoryGameFileProvider } from '../platform/browser/files/directory';
import { gameVmConfiguration } from '../games/vmConfiguration';
import { HttpGameFileProvider } from '../platform/browser/files/http';
import { ScopedGameFileProvider } from '../resources/providers/scoped';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { discoverGameSources } from '../resources/discovery/discoverGameSources';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { PortGameFileProvider } from './fileProviderPort';
import { withMultiplayerNameOverride } from '../games/multiplayerName';
import { mountCustomMapFiles, prepareDynamicMaps } from './customMapPackage';
import { VmCore, type VmAudioSink, type VmCorePlatform } from './vmCore';
import type { MainToWorkerMessage, VmInitConfig, WorkerToMainMessage } from './vmProtocol';
import type { GuestMemRecordResult } from './memRecord';
import type { VmPointerState } from './vmShell';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';
import type { VmFrame } from '../vm86/win32';
import { withGameResolutionOverride } from '../games/resolution';
import { withGameSpeedOverride } from '../games/gameSpeed';
import { SerialTaskQueue } from '../utils/serialTaskQueue';
import { FrameBufferPool } from './frameBufferPool';
import { supportedGame } from '../games/catalog';

export interface VmWorkerCore {
  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics>;
  start(): Promise<void>;
  stop(): Promise<void>;
  flushFiles(): Promise<void>;
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
  setCursorPosition(x: number, y: number): void;
  setGameClockRate(rate: number): number;
  setMasterVolume(linear: number): void;
  getPointerState(): VmPointerState | null | Promise<VmPointerState | null>;
  getGamePerformance(): Promise<GamePerformanceSample | null>;
  getRenderState(): Promise<GameRenderState | null>;
  getCommandState(): Promise<GameCommandState | null>;
  setGameSpeedFlag(value: number): number | null | Promise<number | null>;
  setTacticalPassthrough(flags: number): boolean | Promise<boolean>;
  /** Native picture credit is released only after presentation consumption. */
  requestNextFrame?(): void;
  startMemRecord(): boolean;
  stopMemRecord(): GuestMemRecordResult | null;
  setFileProvider(files: GameFileProvider): void;
}

export interface VmWorkerControllerDependencies {
  postMessage: (message: WorkerToMainMessage, transfer?: Transferable[]) => void;
  createProvider?: (config: VmInitConfig) => GameFileProvider;
  discoverSources?: (provider: GameFileProvider) => Promise<GameSource[]>;
  applyResolution?: typeof withGameResolutionOverride;
  createCore?: (
    callbacks: GameVmCallbacks,
    source: GameSource,
    platform: VmCorePlatform,
    config?: VmInitConfig,
  ) => VmWorkerCore | Promise<VmWorkerCore>;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  audio?: VmAudioSink;
}

interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
}

class ProxyAudioSink implements VmAudioSink {
  constructor(private readonly post: VmWorkerControllerDependencies['postMessage']) {}

  createBuffer(id: number, byteLength: number, format: PcmWaveFormat): void {
    this.post({ type: 'audio', op: { op: 'createBuffer', id, byteLength, format } });
  }

  duplicateBuffer(sourceId: number, destinationId: number): boolean {
    this.post({ type: 'audio', op: { op: 'duplicateBuffer', sourceId, destinationId } });
    return true;
  }

  setFormat(id: number, format: PcmWaveFormat): boolean {
    this.post({ type: 'audio', op: { op: 'setFormat', id, format } });
    return true;
  }

  writeBuffer(id: number, offset: number, bytes: Uint8Array): number {
    const snapshot = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    this.post({ type: 'audio', op: { op: 'writeBuffer', id, offset, bytes: snapshot } }, [snapshot.buffer]);
    return snapshot.byteLength;
  }

  play(id: number, options: PcmPlayOptions = {}): boolean {
    this.post({ type: 'audio', op: { op: 'play', id, options } });
    return true;
  }

  stop(id: number): boolean {
    this.post({ type: 'audio', op: { op: 'stop', id } });
    return true;
  }

  setCurrentPosition(id: number, byteOffset: number): boolean {
    this.post({ type: 'audio', op: { op: 'setCurrentPosition', id, byteOffset } });
    return true;
  }

  setVolume(id: number, volume: number): boolean {
    this.post({ type: 'audio', op: { op: 'setVolume', id, volume } });
    return true;
  }

  setPan(id: number, pan: number): boolean {
    this.post({ type: 'audio', op: { op: 'setPan', id, pan } });
    return true;
  }

  setFrequency(id: number, frequency: number): boolean {
    this.post({ type: 'audio', op: { op: 'setFrequency', id, frequency } });
    return true;
  }

  getState(_id: number): { positionBytes: number; playing: boolean } | null {
    return null;
  }

  releaseBuffer(id: number): boolean {
    this.post({ type: 'audio', op: { op: 'releaseBuffer', id } });
    return true;
  }

  setMasterVolume(linear: number): void {
    this.post({ type: 'audio-control', action: 'master-volume', linear });
  }

  stopAll(): void {
    this.post({ type: 'audio-control', action: 'stop-all' });
  }

  async destroy(): Promise<void> {
    this.post({ type: 'audio-control', action: 'destroy' });
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdOf(message: MainToWorkerMessage): number | undefined {
  switch (message.type) {
    case 'diagnostics':
    case 'game-performance':
    case 'render-state':
    case 'command-state':
    case 'init':
    case 'state':
    case 'guest-speed-flag':
    case 'tactical-passthrough':
    case 'mem-record-start':
    case 'mem-record-stop':
    case 'flush':
    case 'attach-maps':
      return message.requestId;
    case 'control':
      return message.requestId;
    default:
      return undefined;
  }
}

export class VmWorkerController {
  private core: VmWorkerCore | null = null;
  /** Snapshot object of the last render-state reply posted (see 'render-state-unchanged'). */
  private lastRenderState: GameRenderState | null = null;
  private sourceTemplate: GameFileProvider | null = null;
  private started = false;
  private nativeBackend = false;
  private initReady: Promise<void> = Promise.resolve();
  private pendingClock: number | null = null;
  private pendingVolume: number | null = null;
  private callBatchOrdinal = 0;
  private callBatchDelta = 0;
  private callBatchLogicFrames = 0;
  private callBatchHistogram = new Map<string, number>();
  private callBatchSamples: Array<{ call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0]; ordinal: number }> =
    [];
  private callBatchTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private callTracing = false;
  private relayPort: MessagePort | undefined;
  private portFiles: PortGameFileProvider | null = null;
  private nextFrameId = 1;
  private inFlightFrameId = 0;
  private pendingFrameEmit: (() => void) | null = null;
  private readonly frameBuffers = new FrameBufferPool();
  private frameScheduleGeneration = 0;
  private readonly dependencies: Required<
    Pick<VmWorkerControllerDependencies, 'discoverSources' | 'applyResolution' | 'createCore' | 'fetchBytes'>
  > &
    Pick<VmWorkerControllerDependencies, 'createProvider' | 'audio'>;

  constructor(
    private readonly post: VmWorkerControllerDependencies['postMessage'],
    dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
  ) {
    this.dependencies = {
      discoverSources: dependencies.discoverSources ?? discoverGameSources,
      applyResolution: dependencies.applyResolution ?? withGameResolutionOverride,
      createCore:
        dependencies.createCore ??
        (async (callbacks, source, platform, config) => {
          if (config?.native) {
            if (import.meta.env.DEV) {
              if (source.game.id !== 'yr') throw new Error('Native host policy is unsupported for this game');
              const [{ NativeCore }, { createYrNativeHostPolicy }] = await Promise.all([
                import('./native/core'),
                import('../games/yr/nativeHost'),
              ]);
              return new NativeCore(
                callbacks,
                { ...config.native, renderPassthrough: config.renderPassthrough },
                (memory, metadata, hash) => createYrNativeHostPolicy(memory, () => memory.accessor(), hash, metadata),
                platform.scheduleFrame,
                source.executableBytes,
              );
            }
            throw new Error('Native host is available only in development');
          }
          return new VmCore(callbacks, source, platform);
        }),
      fetchBytes: dependencies.fetchBytes ?? fetchBytes,
      createProvider: dependencies.createProvider,
      audio: dependencies.audio,
    };
  }

  async handleMessage(message: MainToWorkerMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'init':
          this.initReady = this.handleInit(message.config);
          await this.initReady;
          this.post({ type: 'init-done', requestId: message.requestId });
          break;
        case 'control':
          if (message.action === 'start') {
            await this.initReady;
            await this.handleStart();
            this.post({ type: 'control-done', action: 'start', requestId: message.requestId });
          } else {
            this.frameScheduleGeneration++;
            this.inFlightFrameId = 0;
            this.pendingFrameEmit = null;
            if (this.core) await this.core.stop();
            this.started = false;
            this.post({ type: 'control-done', action: 'stop', requestId: message.requestId });
          }
          break;
        case 'wm':
          this.core?.postMessage(message.m, message.w, message.l);
          break;
        case 'key':
          this.core?.setKeyState(message.vk, message.down);
          break;
        case 'cursor':
          this.core?.setCursorPosition(message.x, message.y);
          break;
        case 'clock':
          this.pendingClock = message.rate;
          this.core?.setGameClockRate(message.rate);
          break;
        case 'volume':
          this.pendingVolume = message.linear;
          this.core?.setMasterVolume(message.linear);
          break;
        case 'call-tracing':
          this.callTracing = message.enabled;
          break;
        case 'game-performance':
          this.post({
            type: 'game-performance-reply',
            requestId: message.requestId,
            value: (await this.core?.getGamePerformance()) ?? null,
          });
          break;
        case 'command-state':
          this.post({
            type: 'command-state-reply',
            requestId: message.requestId,
            value: (await this.core?.getCommandState()) ?? null,
          });
          break;
        case 'render-state': {
          const value = (await this.core?.getRenderState()) ?? null;
          // The reader returns the identical object while nothing changed (GameRenderStateReader); the client still
          // holds the clone of the last reply, so post only a marker instead of cloning the snapshot again.
          if (value && value === this.lastRenderState) {
            this.post({ type: 'render-state-unchanged', requestId: message.requestId });
            break;
          }
          const sameOverlays = value?.overlays && value.overlays === this.lastRenderState?.overlays;
          const sameSmudges = value?.smudges && value.smudges === this.lastRenderState?.smudges;
          this.lastRenderState = value;
          if (value && (sameOverlays || sameSmudges)) {
            // Each cell layer changes independently; moving units need neither unchanged grid cloned again.
            const { overlays, smudges, ...rest } = value;
            this.post({
              type: 'render-state-cells-unchanged',
              requestId: message.requestId,
              value: { ...rest, ...(!sameOverlays && { overlays }), ...(!sameSmudges && { smudges }) },
            });
          } else {
            this.post({ type: 'render-state-reply', requestId: message.requestId, value });
          }
          break;
        }
        case 'diagnostics':
          if (!this.core) throw new Error('VM 尚未 init');
          this.post({
            type: 'diagnostics-reply',
            requestId: message.requestId,
            value: await this.core.getDiagnostics(message.action),
          });
          break;
        case 'state':
          this.post({
            type: 'state-reply',
            requestId: message.requestId,
            kind: message.kind,
            value: (await this.core?.getPointerState()) ?? null,
          });
          break;
        case 'guest-speed-flag':
          this.post({
            type: 'guest-speed-flag-reply',
            requestId: message.requestId,
            value: (await this.core?.setGameSpeedFlag(message.value)) ?? null,
          });
          break;
        case 'tactical-passthrough':
          this.post({
            type: 'tactical-passthrough-reply',
            requestId: message.requestId,
            value: (await this.core?.setTacticalPassthrough(message.flags)) ?? false,
          });
          break;
        case 'mem-record-start':
          this.post({
            type: 'mem-record-start-reply',
            requestId: message.requestId,
            ok: this.core?.startMemRecord() ?? false,
          });
          break;
        case 'mem-record-stop':
          this.post({
            type: 'mem-record-stop-reply',
            requestId: message.requestId,
            result: this.core?.stopMemRecord() ?? null,
          });
          break;
        case 'flush':
          await this.core?.flushFiles();
          this.post({ type: 'flush-done', requestId: message.requestId });
          break;
        case 'attach-maps': {
          if (this.nativeBackend) throw new Error('Native host does not support page file attachment');
          if (!this.core || !this.sourceTemplate) throw new Error('VM 尚未初始化');
          const { provider, result } = await prepareDynamicMaps(
            this.sourceTemplate,
            new Map(message.files.map(({ path, bytes }) => [path, bytes])),
          );
          this.core.setFileProvider(provider);
          this.sourceTemplate = provider;
          this.post({ type: 'attach-maps-done', requestId: message.requestId, result });
          break;
        }
        case 'frame-ack':
          this.acknowledgeFrame(message.frameId);
          break;
        case 'recycle-frame':
          this.frameBuffers.release(message.buffer);
          break;
      }
    } catch (error) {
      const requestId = requestIdOf(message);
      this.post(
        requestId === undefined
          ? { type: 'error', message: errorMessage(error) }
          : { type: 'error', requestId, message: errorMessage(error) },
      );
      if (message.type === 'init' || (message.type === 'control' && message.action === 'start')) {
        this.post({ type: 'status', phase: 'error', detail: errorMessage(error) });
      }
    }
  }

  dispose(): void {
    this.relayPort?.close();
    this.relayPort = undefined;
    this.frameBuffers.clear();
    this.portFiles?.dispose();
    this.portFiles = null;
    if (this.callBatchTimer !== null) globalThis.clearInterval(this.callBatchTimer);
    this.callBatchTimer = null;
    this.frameScheduleGeneration++;
    this.pendingFrameEmit = null;
    this.inFlightFrameId = 0;
  }

  /** Rebuild the file backend from init: directory handles with optional online overlays, session-package memory files, or development HTTP. */
  private buildProvider(config: VmInitConfig): GameFileProvider {
    if (config.provider.kind === 'port') {
      return (this.portFiles = new PortGameFileProvider(
        config.provider.label,
        config.provider.port,
        config.provider.names,
      ));
    }
    if (config.provider.kind === 'memory') {
      // Session-package (online ZIP) files transfer into the Worker with init; directly rebuild the memory
      // provider with deepDiscovery and persist saves to the same-origin IndexedDB shared with the page.
      return new SessionGameFileProvider(
        config.provider.label,
        new Map(config.provider.files.map((entry) => [entry.path, entry.bytes])),
      );
    }
    if (config.provider.kind === 'directory') {
      const base = new DirectoryGameFileProvider(config.provider.handle);
      const overlays = config.provider.overlays ?? [];
      if (!overlays.length) return base;
      // Online-package overlays only fill gaps: authorized local directories take precedence, including Chinese resources; writes still use the directory backend.
      return new OverlayGameFileProvider(
        base,
        new Map(overlays.map((entry) => [entry.path, entry.bytes])),
        '（在线覆盖）',
        false,
        false,
        true,
      );
    }
    const http = new HttpGameFileProvider();
    return config.provider.kind === 'http' && config.provider.root
      ? new ScopedGameFileProvider(http, config.provider.root)
      : http;
  }

  private async handleInit(config: VmInitConfig): Promise<void> {
    if (this.core) throw new Error('重复 init');
    this.relayPort = config.relayPort;
    this.pendingClock ??= config.clockRate;
    this.pendingVolume ??= config.masterVolume;
    this.callTracing = config.traceCalls;
    const callbacks: GameVmCallbacks = {
      onNetworkStatus: (status) => this.post({ type: 'network-status', status }),
      onStatus: (status) => this.post({ type: 'status', phase: status.phase, detail: status.detail }),
      onCall: (call, ordinal) => this.recordCall(call, ordinal),
      onBlocked: (call) => this.post({ type: 'blocked', call }),
      onFrame: (frame) => this.sendFrame(frame),
      onLogicFrame: (count) => {
        this.callBatchLogicFrames += count;
      },
      onShellPage: (title) => this.post({ type: 'shell-page', title }),
      onMoviePlayback: (playing) => this.post({ type: 'movie-playback', playing }),
    };
    if (config.native) {
      if (!import.meta.env.DEV || config.provider.kind !== 'native')
        throw new Error('Invalid development native-host configuration');
      this.nativeBackend = true;
      const unsupported = (): never => {
        throw new Error('Native host has no page-owned file or emulator backend');
      };
      const files: GameFileProvider = {
        label: 'Native game files are owned by the native process',
        read: async () => unsupported(),
        write: async () => unsupported(),
        flush: async () => unsupported(),
        list: async () => unsupported(),
      };
      const source: GameSource = {
        game: supportedGame(config.preferredGameId),
        files,
        executableBytes: config.selectedExecutable?.bytes ?? new Uint8Array(),
      };
      const platform: VmCorePlatform = {
        resourcePolicy: {
          prepareSource: async () => unsupported(),
          isSessionStatic: unsupported,
          preloadFallbackUrl: unsupported,
        },
        fetchBytes: async () => unsupported(),
        createEmulator: unsupported,
        createShim: unsupported,
        scheduleFrame: (emit) => this.scheduleFrameWithBackpressure(emit),
        audio: this.dependencies.audio ?? new ProxyAudioSink(this.post),
        fastFileRead: false,
      };
      this.core = await this.dependencies.createCore(callbacks, source, platform, config);
      this.callBatchTimer ??= globalThis.setInterval(() => this.flushCallBatch(), 500);
      return;
    }
    if (config.provider.kind === 'native') throw new Error('Native provider requires native attachment options');
    let provider = this.dependencies.createProvider
      ? this.dependencies.createProvider(config)
      : this.buildProvider(config);
    if (config.selectedExecutable) {
      // Overlay before discovery, not merely by replacing executableBytes: discovery, PE loading,
      // and later guest reads of its own EXE must agree. Never fall back to old files through parent-first lookup.
      provider = new OverlayGameFileProvider(
        provider,
        new Map([[config.selectedExecutable.path, config.selectedExecutable.bytes]]),
        '（启动 EXE）',
        true,
        false,
        false,
      );
    }
    const sources = await this.dependencies.discoverSources(provider);
    const discoveredSource =
      sources.find((item) => item.game.id === config.preferredGameId) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!discoveredSource) {
      throw new Error(`未在游戏目录中找到 ${config.preferredGameId}（发现 ${sources.length} 款已支持游戏）`);
    }
    const mounted = config.additionalFiles?.length
      ? mountCustomMapFiles(discoveredSource, new Map(config.additionalFiles.map(({ path, bytes }) => [path, bytes])))
      : discoveredSource;
    const source = withGameSpeedOverride(
      await withMultiplayerNameOverride(
        await this.dependencies.applyResolution(mounted, config.resolution),
        config.playerName,
      ),
      config.gameSpeed,
    );
    this.sourceTemplate = source.files;
    const probe = new BrowserEmulatorProbe();
    const platform: VmCorePlatform = {
      createEmulator: (options) =>
        createBrowserEmulator(options, probe, { expandJitModules: config.expandJitModules === true }),
      executionProbe: probe,
      ...gameVmConfiguration(
        source.game,
        callbacks.onNetworkStatus,
        config.ra2Network,
        config.relayPort ? (url) => new PortRelaySocket(config.relayPort!, url) : undefined,
      ),
      startupPage: config.startupPage,
      renderPassthrough: config.renderPassthrough,
      pageCursor: config.pageCursor,
      fetchBytes: this.dependencies.fetchBytes,
      scheduleFrame: (emit) => this.scheduleFrameWithBackpressure(emit),
      deferFrameSnapshot: true,
      packedRgb565Frames: true,
      takeFrameBuffer: (size) => this.frameBuffers.take(size),
      audio: this.dependencies.audio ?? new ProxyAudioSink(this.post),
      fastFileRead: config.fastFileRead,
    };
    this.core = await this.dependencies.createCore(callbacks, source, platform, config);
    this.callBatchTimer ??= globalThis.setInterval(() => this.flushCallBatch(), 500);
  }

  private async handleStart(): Promise<void> {
    if (!this.core) throw new Error('VM 尚未 init');
    if (this.started) return;
    this.started = true;
    await this.core.start();
    if (!this.nativeBackend) {
      this.core.setGameClockRate(this.pendingClock ?? 1);
      this.core.setMasterVolume(this.pendingVolume ?? 0.25);
    }
  }

  private recordCall(call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0], ordinal: number): void {
    this.callBatchOrdinal = ordinal;
    this.callBatchDelta++;
    if (!this.callTracing) return;
    const key = call.imported.key;
    this.callBatchHistogram.set(key, (this.callBatchHistogram.get(key) ?? 0) + 1);
    if (ordinal <= 200 || ordinal % 256 === 0) this.callBatchSamples.push({ call, ordinal });
  }

  private flushCallBatch(): void {
    if (!this.callBatchDelta && !this.callBatchLogicFrames) return;
    this.post({
      type: 'call-batch',
      batch: {
        ordinal: this.callBatchOrdinal,
        delta: this.callBatchDelta,
        logicFrames: this.callBatchLogicFrames,
        histogram: [...this.callBatchHistogram],
        samples: this.callBatchSamples,
      },
    });
    this.callBatchDelta = 0;
    this.callBatchLogicFrames = 0;
    this.callBatchHistogram = new Map();
    this.callBatchSamples = [];
  }

  private sendFrame(frame: VmFrame): void {
    const frameId = this.nextFrameId++;
    this.inFlightFrameId = frameId;
    const transfers: Transferable[] = [frame.pixels.buffer, frame.palette.buffer];
    if (frame.rgba) transfers.push(frame.rgba.buffer);
    if (frame.rgb565) transfers.push(frame.rgb565.buffer);
    if (frame.cursor) transfers.push(frame.cursor.rgba.buffer);
    this.post({ type: 'frame', frameId, frame }, transfers);
  }

  private scheduleFrameWithBackpressure(emit: () => void): void {
    if (this.inFlightFrameId) {
      this.pendingFrameEmit = emit;
      return;
    }
    const generation = this.frameScheduleGeneration;
    queueMicrotask(() => {
      if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
      emit();
    });
  }

  private acknowledgeFrame(frameId: number): void {
    if (frameId !== this.inFlightFrameId) return;
    this.inFlightFrameId = 0;
    const next = this.pendingFrameEmit;
    this.pendingFrameEmit = null;
    if (!next) this.core?.requestNextFrame?.();
    if (next) {
      const generation = ++this.frameScheduleGeneration;
      queueMicrotask(() => {
        if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
        next();
      });
    }
  }
}

export function createVmWorkerController(dependencies: VmWorkerControllerDependencies): VmWorkerController {
  const { postMessage, ...rest } = dependencies;
  return new VmWorkerController(postMessage, rest);
}

export function installVmWorker(
  scope: WorkerScope,
  dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
): VmWorkerController {
  const controller = createVmWorkerController({ postMessage: scope.postMessage.bind(scope), ...dependencies });
  const queue = new SerialTaskQueue((error) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
  scope.postMessage({ type: 'probe', ready: true });
  scope.onmessage = (event) => {
    void queue.enqueue(() => controller.handleMessage(event.data));
  };
  return controller;
}
