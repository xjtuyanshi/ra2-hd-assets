import type { GameVmCallbacks, VmPhase } from '../../app/session/runtimeEvents';
import type { NativeGamePolicy, NativeHostMetadata, NativeHostRange } from '../../games/nativeHost';
import type { GameRenderState } from '../../games/renderState';
import type { GameCommandState } from '../../games/commandState';
import type { GameFrameCounters, GamePerformanceSample } from '../../games/performance';
import type { RenderPassthroughControl } from '../../games/renderPassthrough';
import type { GameFileProvider } from '../../resources/contracts';
import type { VmDiagnosticAction, VmDiagnostics } from '../vmDiagnostics';
import type { GuestMemRecordResult } from '../memRecord';
import type { VmPointerState } from '../vmShell';
import type { VmFrame } from '../../vm86/win32';
import { GamePerformanceMeter } from '../gamePerformance';
import { NativeConnection } from './connection';
import type { NativeConnectionOptions } from './connection';
import { NativeMessageType, NATIVE_PAGE_SIZE, decodeJson, encodeSubscription, encodeU32 } from './protocol';
import type { NativeHello, NativeMirrorUpdate, NativePicture } from './protocol';
import {
  NativeMirrorMemory,
  NativeMemoryMiss,
  NativeReaderWorkingSet,
  readNativeWithRetry,
  runNativeTransaction,
} from './memory';
import type { NativeRange, NativeTransactionHost, NativeWrite } from './memory';

export class NativeUnsupportedError extends Error {
  constructor(operation: string) {
    super(`Native host does not support ${operation}`);
    this.name = 'NativeUnsupportedError';
  }
}
class NativeMirrorUnavailable extends Error {
  constructor(flags: number) {
    super(`No complete native mirror within 8 seconds (last flags ${flags})`);
    this.name = 'NativeMirrorUnavailable';
  }
}
export interface NativeCoreOptions extends NativeConnectionOptions {
  renderPassthrough?: boolean;
}
export type NativeGamePolicyFactory = (
  memory: NativeMirrorMemory,
  metadata: NativeHostMetadata,
  hash: string,
) => NativeGamePolicy;
interface ReaderSlot<T> {
  reader: (() => T | null) | null;
  previous: T | null;
  error: string | null;
  coldAt?: number;
}
interface MirrorWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  afterReset?: number;
}

function mergeRanges(ranges: readonly NativeHostRange[]): NativeRange[] {
  const sorted = ranges
    .filter((range) => range.length > 0)
    .map((range) => {
      const start = Math.floor(range.address / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
      const end = Math.ceil((range.address + range.length) / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
      return { address: start, length: end - start };
    })
    .sort((a, b) => a.address - b.address);
  const merged: NativeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.address <= previous.address + previous.length)
      previous.length = Math.max(previous.address + previous.length, range.address + range.length) - previous.address;
    else merged.push(range);
  }
  if (merged.length > 4096) throw new Error('Native subscription exceeds range limit');
  return merged;
}
function sameRanges(a: readonly NativeRange[], b: readonly NativeRange[]): boolean {
  return (
    a.length === b.length &&
    a.every((range, index) => range.address === b[index]!.address && range.length === b[index]!.length)
  );
}
function metadataOf(value: unknown, hello: NativeHello): NativeHostMetadata {
  const diagnostics = value as { gameThreadId?: number; frameHook?: NativeHostMetadata['verifiedNativeHook'] } | null;
  const thread = diagnostics?.gameThreadId ?? hello.gameThreadId;
  if (!Number.isInteger(thread) || thread <= 0) throw new Error('Native logic thread has not been observed');
  const hook = diagnostics?.frameHook;
  if (
    !hook ||
    !Number.isInteger(hook.site) ||
    !Array.isArray(hook.original) ||
    !Array.isArray(hook.patched) ||
    !hook.original.length ||
    hook.original.length !== hook.patched.length ||
    [...hook.original, ...hook.patched].some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw new Error('Native agent did not report a verified frame hook');
  return { gameThreadId: thread, verifiedNativeHook: hook };
}

/** Reusable host mechanics. Executable addresses, signatures, and follow policies are injected. */
export class NativeCore {
  private readonly connection: NativeConnection;
  readonly memory = new NativeMirrorMemory();
  private readonly meter = new GamePerformanceMeter();
  private policy: NativeGamePolicy | null = null;
  private hello: NativeHello | null = null;
  private phase: VmPhase = 'ready';
  private closed = false;
  private running = false;
  private creditOutstanding = false;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly waiters = new Set<MirrorWaiter>();
  private subscribed: NativeRange[] = [];
  private readonly workingSet = new NativeReaderWorkingSet();
  private additionalRanges: NativeRange[] = [];
  private resetSerial = 0;
  private hookStarted = false;
  private metadata: NativeHostMetadata = { gameThreadId: 0 };
  private policyPrepared = false;
  private policyPreparation: Promise<void> | null = null;
  private recovering = false;
  private recoveryAttempts = 0;
  private recoveryWindowAt = 0;
  private subscriptionTail: Promise<void> = Promise.resolve();
  private render: ReaderSlot<GameRenderState> = { reader: null, previous: null, error: null };
  private command: ReaderSlot<GameCommandState> = { reader: null, previous: null, error: null };
  private frame: ReaderSlot<GameFrameCounters> = { reader: null, previous: null, error: null };
  private passthrough: RenderPassthroughControl | null = null;
  private undo: NativeWrite[] = [];
  private readonly allocations = new Map<number, number>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private hostFrames = 0;
  private stateReadMs = 0;
  private stateReads = 0;
  private lastMirrorFlags = 0;
  private previousLogicFrame: number | null = null;

  constructor(
    private readonly callbacks: GameVmCallbacks,
    private readonly options: NativeCoreOptions,
    private readonly createPolicy: NativeGamePolicyFactory,
    private readonly scheduleFrame: (emit: () => void) => void,
    private readonly selectedExecutable?: Uint8Array,
  ) {
    this.connection = new NativeConnection(options);
  }

  private status(phase: VmPhase, detail: string): void {
    this.phase = phase;
    this.callbacks.onStatus?.({ phase, detail });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    const shouldStop = this.running;
    this.running = false;
    this.status('error', error.message);
    this.rejectWaiters(error);
    if (shouldStop)
      void this.stop()
        .catch((cleanup) => console.warn('[native] Error cleanup:', cleanup))
        .finally(() => this.status('error', error.message));
  }
  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
  private nextMirror(afterReset?: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Native host is closed'));
    return new Promise((resolve, reject) => {
      const waiter: MirrorWaiter = {
        resolve,
        reject,
        afterReset,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new NativeMirrorUnavailable(this.lastMirrorFlags));
        }, 8000),
      };
      this.waiters.add(waiter);
    });
  }
  private mirrorArrived(update: NativeMirrorUpdate): void {
    if (this.closed) return;
    this.lastMirrorFlags = update.flags;
    const complete = this.memory.apply(update);
    this.connection.notify(NativeMessageType.Ack, encodeU32(update.frame));
    if (!complete) {
      if (update.flags & 4 && this.running) void this.recoverInvalidMirror();
      return;
    }
    if (update.flags & 2) this.resetSerial++;
    if (this.previousLogicFrame !== null && update.frame >= this.previousLogicFrame)
      this.callbacks.onLogicFrame?.(update.frame - this.previousLogicFrame);
    this.previousLogicFrame = update.frame;
    for (const waiter of this.waiters) {
      if (waiter.afterReset !== undefined && this.resetSerial <= waiter.afterReset) continue;
      clearTimeout(waiter.timer);
      waiter.resolve();
      this.waiters.delete(waiter);
    }
  }
  private pictureArrived(picture: NativePicture): void {
    if (this.closed || !this.running) return;
    this.creditOutstanding = false;
    if (this.hello) this.hello.surface = { width: picture.width, height: picture.height, bpp: 16, format: 'RGB565' };
    const frame: VmFrame = {
      width: picture.width,
      height: picture.height,
      pixels: new Uint8Array(),
      palette: new Uint8Array(),
      rgb565: picture.pixels,
    };
    this.scheduleFrame(() => {
      if (this.closed || !this.running) return;
      this.hostFrames++;
      this.callbacks.onFrame?.(frame);
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.closed) throw new Error('A stopped native session cannot be restarted');
    this.status('loading', '正在连接本机游戏');
    this.unsubscribe.push(
      this.connection.onError((error) => this.fail(error)),
      this.connection.onMirror((update) => this.mirrorArrived(update)),
      this.connection.onPicture((picture) => this.pictureArrived(picture)),
    );
    try {
      this.hello = await this.connection.connect();
      if (!this.hello.exe.verified) throw new Error('Native executable identity is unsupported');
      if (this.selectedExecutable?.length) {
        const selected = this.selectedExecutable.slice();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', selected as BufferSource))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (selected.length !== this.hello.exe.size || hash !== this.hello.exe.sha256)
          throw new Error('The page resources and native executable identity differ');
      }
      this.policy = this.createPolicy(this.memory, { gameThreadId: this.hello.gameThreadId }, this.hello.exe.sha256);
      await this.subscribe([]);
      await this.connection.request(NativeMessageType.Hook, encodeU32(1));
      this.hookStarted = true;
      const input = decodeJson(await this.connection.request(NativeMessageType.InputState)) as { modal?: boolean };
      // A menu has native pictures and input but no logic-frame callbacks. Do
      // not manufacture a mirror or a logic-thread ID to make it attachable.
      // An attachment outside a menu still requires a complete initial mirror.
      if (!this.memory.complete && !input.modal) await this.nextMirror();
      if (this.memory.complete) await this.preparePolicy();
      this.running = true;
      this.status('running', '已连接本机游戏');
      this.requestNextFrame();
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.fail(reason);
      // Startup may have installed the hook before an invalid/incomplete mirror was observed.
      await this.stop().catch(() => undefined);
      throw reason;
    }
  }

  private preparePolicy(): Promise<void> {
    if (this.policyPrepared) return Promise.resolve();
    if (this.policyPreparation) return this.policyPreparation;
    const pending = (async () => {
      if (!this.hello || !this.memory.complete) return;
      const diagnostics = decodeJson(await this.connection.request(NativeMessageType.Diagnostics));
      const metadata = metadataOf(diagnostics, this.hello);
      this.policy = this.createPolicy(this.memory, metadata, this.hello.exe.sha256);
      this.metadata = metadata;
      this.policyPrepared = true;
    })();
    this.policyPreparation = pending;
    void pending
      .finally(() => {
        this.policyPreparation = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private subscribe(ranges: readonly NativeRange[], owner: unknown = 'transaction'): Promise<void> {
    this.workingSet.learn(owner, ranges);
    const operation = async () => {
      if (!this.policy || !this.hello || this.closed) return;
      const next = mergeRanges([...this.policy.ranges, ...this.workingSet.ranges, ...this.additionalRanges]);
      if (sameRanges(next, this.subscribed)) return;
      const beforeReset = this.resetSerial;
      await this.connection.request(
        NativeMessageType.Subscribe,
        encodeSubscription({
          ranges: next,
          rules: this.policy.rules,
          maxPages: this.hello.limits.pages,
          budgetUs: 4000,
          sampleCount: 0,
        }),
      );
      this.subscribed = next;
      if (this.hookStarted && (this.resetSerial <= beforeReset || !this.memory.complete))
        await this.nextMirror(beforeReset);
    };
    const pending = this.subscriptionTail.then(operation);
    this.subscriptionTail = pending.catch(() => undefined);
    return pending;
  }
  private readonly host: NativeTransactionHost = {
    fetchPage: async (address) => (await this.connection.read(address, NATIVE_PAGE_SIZE)).bytes,
    alloc: async (size, alignment) => {
      const amount = Math.ceil(size / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
      const address = await this.connection.allocate(amount, 0, true);
      if (address % alignment) {
        await this.connection.free(address);
        throw new Error('Native allocation does not satisfy required alignment');
      }
      this.allocations.set(address, amount);
      return { address, size: amount };
    },
    free: async (address) => {
      await this.connection.free(address);
      this.allocations.delete(address);
    },
    commit: async (writes) => {
      if (writes.length) await this.connection.batch(writes);
    },
    subscribe: (ranges) => this.subscribe(ranges),
    nextMirror: () => this.nextMirror(),
  };

  private async expandPolicyRanges(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      this.memory.beginOperation();
      let additional: readonly NativeHostRange[] | undefined;
      try {
        additional = this.policy!.additionalRanges?.();
      } catch (error) {
        if (!(error instanceof NativeMemoryMiss)) throw error;
      }
      if (this.memory.operationMissed) {
        await this.subscribe(this.memory.missingRanges, 'policy');
        await this.nextMirror();
        continue;
      }
      const next = mergeRanges(additional ?? []);
      if (!sameRanges(next, this.additionalRanges)) {
        // A new map scope replaces prior cells instead of retaining freed pages.
        this.additionalRanges = next;
        this.workingSet.clear();
        this.render.reader = this.command.reader = this.frame.reader = null;
        await this.subscribe([]);
      }
      return;
    }
    throw new NativeMemoryMiss(this.memory.missingRanges);
  }
  private async recoverInvalidMirror(): Promise<void> {
    if (this.recovering || this.closed || !this.policy || !this.hello) return;
    this.recovering = true;
    const now = performance.now();
    if (now - this.recoveryWindowAt > 60_000) {
      this.recoveryWindowAt = now;
      this.recoveryAttempts = 0;
    }
    try {
      if (++this.recoveryAttempts > 3)
        throw new Error('Native mirror repeatedly contains invalid pages; attachment stopped');
      this.workingSet.clear();
      this.additionalRanges = [];
      this.subscribed = [];
      this.render.reader = this.command.reader = this.frame.reader = null;
      this.policy = this.createPolicy(this.memory, this.metadata, this.hello.exe.sha256);
      await this.subscribe([]);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.recovering = false;
    }
  }
  private read<T>(slot: ReaderSlot<T>, factory: () => (() => T | null) | null): Promise<T | null> {
    return this.exclusive(() => this.readExclusive(slot, factory));
  }
  private async readExclusive<T>(slot: ReaderSlot<T>, factory: () => (() => T | null) | null): Promise<T | null> {
    if (!this.running || !this.policy || !this.memory.complete || this.recovering) return slot.previous;
    const at = performance.now();
    try {
      await this.preparePolicy();
      await this.expandPolicyRanges();
      // Refresh cached reader dependencies before retiring their old allocation footprint.
      let cold = !slot.reader || slot.coldAt === undefined || at - slot.coldAt >= 1000;
      if (cold) slot.reader = null;
      const result = await readNativeWithRetry(
        this.memory,
        () => {
          slot.reader ??= factory();
          return slot.reader?.() ?? null;
        },
        slot.previous,
        { ...this.host, subscribe: (ranges) => this.subscribe(ranges, slot) },
        () => {
          slot.reader = null;
          cold = true;
        },
        8,
      );
      if (this.memory.operationMissed) {
        slot.error = 'Native reader retry budget exhausted; retaining previous complete result';
        return slot.previous;
      }
      slot.previous = result;
      slot.error = null;
      if (result !== null) {
        this.workingSet.complete(slot, this.memory, cold);
        if (cold) slot.coldAt = performance.now();
        await this.subscribe([]);
      }
      return result;
    } catch (error) {
      if (error instanceof NativeMemoryMiss || error instanceof NativeMirrorUnavailable) {
        slot.error = error.message;
        return slot.previous;
      }
      slot.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.stateReadMs += performance.now() - at;
      this.stateReads++;
    }
  }
  async getRenderState(): Promise<GameRenderState | null> {
    if (!this.running) return null;
    if ((decodeJson(await this.connection.request(NativeMessageType.InputState)) as { modal?: boolean }).modal)
      return null;
    return this.read(this.render, () => this.policy!.createRenderReader());
  }
  async getCommandState(): Promise<GameCommandState | null> {
    if (!this.running) return null;
    if ((decodeJson(await this.connection.request(NativeMessageType.InputState)) as { modal?: boolean }).modal)
      return null;
    return this.read(this.command, () => this.policy!.createCommandReader());
  }
  async getGamePerformance(): Promise<GamePerformanceSample | null> {
    if (!this.memory.complete) return null;
    const counters = await this.read(this.frame, () => this.policy!.createFrameReader());
    return counters ? this.meter.sample(counters, performance.now(), this.running) : null;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation);
    this.operationTail = pending.catch(() => undefined);
    return pending;
  }
  setGameSpeedFlag(value: number): Promise<number | null> {
    return this.exclusive(async () => {
      if (!this.running || !this.policy || !this.memory.complete) return null;
      await this.preparePolicy();
      return runNativeTransaction(this.memory, (transaction) => this.policy!.setSpeed(transaction, value), this.host);
    });
  }
  setTacticalPassthrough(flags: number): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.running || !this.policy || !this.options.renderPassthrough || !this.memory.complete) return false;
      await this.preparePolicy();
      if (!this.passthrough) {
        this.passthrough = await runNativeTransaction(
          this.memory,
          (transaction) => this.policy!.installPassthrough(transaction, transaction.reserve),
          {
            ...this.host,
            commit: async (writes) => {
              if (!writes.length) return;
              await this.connection.batch(writes);
              this.undo = writes.map((write) => ({
                address: write.address,
                expected: write.bytes.slice(),
                bytes: write.expected.slice(),
              }));
            },
          },
        );
      }
      if (!this.passthrough) return false;
      return runNativeTransaction(this.memory, (transaction) => this.passthrough!.set(transaction, flags), this.host);
    });
  }

  /** Called only after the presenter ACK, so hidden pages naturally backpressure native picture capture. */
  requestNextFrame(): void {
    if (!this.running || this.closed || this.creditOutstanding) return;
    this.creditOutstanding = true;
    void this.connection.request(NativeMessageType.Credit, encodeU32(1)).catch((error) => {
      this.creditOutstanding = false;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }
  private input(kind: number, a: number, b: number, c: number): void {
    if (!this.running || this.closed) return;
    void this.connection
      .request(NativeMessageType.Input, encodeU32(kind, a >>> 0, b >>> 0, c >>> 0))
      .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }
  postMessage(message: number, wParam = 0, lParam = 0): void {
    this.input(1, message, wParam, lParam);
  }
  setKeyState(vk: number, down: boolean): void {
    this.input(2, vk, down ? 1 : 0, 0);
  }
  setCursorPosition(x: number, y: number): void {
    this.input(3, x, y, 0);
  }
  async getPointerState(): Promise<VmPointerState | null> {
    if (!this.running || !this.hello) return null;
    const state = decodeJson(await this.connection.request(NativeMessageType.InputState)) as {
      x: number;
      y: number;
      lastKeyMessage: number;
      lastKeyVirtualKey: number;
      lastMessage: number;
    };
    const surface = this.hello.surface;
    return {
      x: state.x,
      y: state.y,
      width: surface.width,
      height: surface.height,
      clientWidth: surface.width,
      clientHeight: surface.height,
      lastKeyMessage: state.lastKeyMessage,
      lastKeyVirtualKey: state.lastKeyVirtualKey,
      lastMouseMessage: state.lastMessage >= 0x200 && state.lastMessage <= 0x20e ? state.lastMessage : 0,
      lastMouseHwnd: 0,
      lastMouseControlId: 0,
      lastMouseCallback: 0,
      lastMouseDispatchHwnd: 0,
      lastMouseDispatchControlId: 0,
      lastMouseDispatchCallback: 0,
      campaignHoverDispatches: 0,
      wmTimerDispatches: 0,
    };
  }
  setGameClockRate(_rate: number): number {
    return 0;
  }
  setMasterVolume(_linear: number): void {
    console.warn('[native] Page audio volume is unsupported; native game owns audio');
  }
  startMemRecord(): boolean {
    return false;
  }
  stopMemRecord(): GuestMemRecordResult | null {
    return null;
  }
  setFileProvider(_provider: GameFileProvider): never {
    throw new NativeUnsupportedError('file attachment');
  }
  flushFiles(): Promise<void> {
    return Promise.reject(new NativeUnsupportedError('page file persistence'));
  }
  async getDiagnostics(_action: VmDiagnosticAction): Promise<VmDiagnostics> {
    const native = decodeJson(await this.connection.request(NativeMessageType.Diagnostics));
    if (!native || typeof native !== 'object') throw new Error('Invalid native diagnostics');
    return {
      sampledAtMs: performance.now(),
      phase: this.phase,
      hypercalls: 0,
      clockRate: 0,
      execution: null,
      game: await this.getGamePerformance(),
      usage: null,
      native: {
        ...native,
        mirrorFrame: this.memory.frame,
        mirrorComplete: this.memory.complete,
        awaitingLogicMirror: !this.policyPrepared || !this.memory.complete,
        mirrorMisses: this.memory.misses,
        lastReaderError: this.render.error ?? this.command.error ?? this.frame.error,
        readerErrors: { render: this.render.error, command: this.command.error, performance: this.frame.error },
        stateReadMs: this.stateReadMs,
        stateReads: this.stateReads,
        frames: this.hostFrames,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.running = false;
    await this.operationTail;
    let cleanupError: unknown;
    try {
      if (this.passthrough) {
        await runNativeTransaction(this.memory, (transaction) => this.passthrough!.set(transaction, 0), this.host);
        // Only restore external signatures that still exactly match the installed
        // bytes. Agent-owned data/counters change during play and are not code sites.
        const restored = this.undo.filter(
          (write) =>
            ![...this.allocations].some(
              ([address, size]) => write.address >= address && write.address + write.bytes.length <= address + size,
            ),
        );
        if (restored.length) await this.connection.batch(restored);
        // A suspended thread can still return into an allocated gate after the
        // original sites are restored. Keep published executable blocks alive until
        // process exit; never free live return addresses without quiescence proof.
        this.passthrough = null;
        this.undo = [];
      }
      if (this.hello) await this.connection.request(NativeMessageType.Hook, encodeU32(0));
    } catch (error) {
      cleanupError = error;
    } finally {
      this.closed = true;
      this.connection.close();
      for (const remove of this.unsubscribe) remove();
      this.unsubscribe.length = 0;
      this.rejectWaiters(new Error('Native session stopped'));
      this.memory.reset();
      this.workingSet.clear();
      this.meter.reset();
      this.status('stopped', '本机游戏连接已关闭');
    }
    if (cleanupError) throw cleanupError;
  }
}
