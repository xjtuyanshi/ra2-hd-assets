import type { GameVmCallbacks, VmPhase } from '../../app/session/runtimeEvents';
import type {
  NativeGamePolicy,
  NativeHostFollowRule,
  NativeHostMetadata,
  NativeHostRange,
} from '../../games/nativeHost';
import type { GameRenderPreparation, GameRenderState } from '../../games/renderState';
import type { GameCommandState } from '../../games/commandState';
import type { GameFrameCounters, GamePerformanceSample } from '../../games/performance';
import type { RenderPassthroughControl } from '../../games/renderPassthrough';
import type { GameFileProvider } from '../../resources/contracts';
import type { VmDiagnosticAction, VmDiagnostics } from '../vmDiagnostics';
import type { GuestMemRecordResult } from '../memRecord';
import type { VmPointerState } from '../vmShell';
import type { MenuSnapshot } from '../../vm86/menuSnapshot';
import type { VmFrame } from '../../vm86/win32';
import { GamePerformanceMeter } from '../gamePerformance';
import { NativeConnection, NativeConnectionLostError } from './connection';
import type { NativeConnectionOptions } from './connection';
import {
  NativeMessageType,
  NATIVE_PAGE_SIZE,
  NATIVE_INPUT_STATE_MINIMAL,
  NATIVE_INPUT_STATE_CURSOR,
  NATIVE_INPUT_STATE_MENU,
  decodeCursorSnapshot,
  decodeMenuSnapshot,
  decodeJson,
  encodeSubscription,
  encodeU32,
} from './protocol';
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
  pageCursor?: boolean;
  sessionStatusUrl?: string;
}
export type NativeGamePolicyFactory = (
  memory: NativeMirrorMemory,
  metadata: NativeHostMetadata,
  hash: string,
) => NativeGamePolicy;
export interface NativeMirrorFootprint {
  sampledAtMs: number;
  pageLimit: number | null;
  mirror: {
    complete: boolean;
    lastPublishedFrame: number | null;
    lastFlags: number;
    currentFollowDemand: 'last-complete-mirror' | 'unknown';
    ranges: NativeRange[];
  };
  ranges: { fixed: NativeRange[]; additional: NativeRange[]; learned: NativeRange[]; subscribed: NativeRange[] };
  pageCounts: {
    fixed: number;
    additional: number;
    learned: number;
    baseUnion: number;
    requestedSeedUnion: number;
    subscribed: number;
    lastPublishedMirror: number;
    knownPublishedOutsideSubscribed: number;
  };
  owners: {
    name: string;
    accessedPages: number;
    learnedPages: number;
    exclusiveLearnedOutsideBase: number;
    coldAtMs: number | null;
    readerCached: boolean | null;
  }[];
  rules: NativeHostFollowRule[];
}
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
  atRevision?: number;
}
interface NativeInputOperation {
  kind: number;
  a: number;
  b: number;
  c: number;
  position: boolean;
}
interface NativeInputState {
  modal?: boolean;
  menuVisible?: boolean;
  menuHwnd?: number;
  moviePlaying?: boolean | null;
  movieOpens?: number;
  movieTotalMs?: number;
  movieTrackingFailures?: number;
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
function rangePages(ranges: readonly NativeRange[]): Set<number> {
  const pages = new Set<number>();
  for (const range of ranges)
    for (let page = range.address; page < range.address + range.length; page += NATIVE_PAGE_SIZE) pages.add(page);
  return pages;
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
function revisionReached(actual: number | null, expected: number): boolean {
  return actual !== null && (actual - expected) >>> 0 < 0x80000000;
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
  private subscribedRules: NativeHostFollowRule[] = [];
  private readonly workingSet = new NativeReaderWorkingSet();
  private additionalRanges: NativeRange[] = [];
  private resetSerial = 0;
  private completeRevision: number | null = null;
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
  private menuSurface: boolean | null = null;
  private awaitingBattleMirror = false;
  private readerEpoch = 0;
  private inputQueue: NativeInputOperation[] = [];
  private inputOutstanding = false;
  private pointer: VmFrame['pointer'] = null;
  private pointerReadPending = false;
  private pointerReadPicture: NativePicture | null = null;
  private pointerSuppressed = false;
  private pointerUndo: NativeWrite[] = [];
  private systemCursor: VmFrame['cursor'];
  private failing = false;
  private moviePlaying = false;
  private movieState: NativeInputState = {};
  private inputStateReadAt = -Infinity;
  private inputStateReadPending: Promise<NativeInputState> | null = null;
  private inputState: NativeInputState = {};
  private menuSnapshotPending: Promise<MenuSnapshot | null> | null = null;
  private renderPreparationPending: Promise<GameRenderPreparation | null> | null = null;

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
    if (this.closed || this.failing) return;
    this.failing = true;
    const shouldStop = this.running;
    this.running = false;
    this.rejectWaiters(error);
    void (async () => {
      const normalExit = error instanceof NativeConnectionLostError && (await this.launcherClosedNormally());
      if (!normalExit) this.status('error', error.message);
      if (shouldStop)
        await this.stop().catch((cleanup) => {
          if (!normalExit) console.warn('[native] Error cleanup:', cleanup);
        });
      this.status(normalExit ? 'exited' : 'error', normalExit ? '游戏已关闭' : error.message);
    })();
  }
  private async launcherClosedNormally(): Promise<boolean> {
    // Socket loss alone cannot distinguish quitting from a crash. Only the
    // authenticated status of this launch can turn it into a normal exit.
    if (!this.hello || !this.options.sessionStatusUrl) return false;
    let url: URL;
    try {
      url = new URL(this.options.sessionStatusUrl);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^1545[0-9]$/.test(url.port)) return false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 1500);
    try {
      while (!abort.signal.aborted) {
        const response = await fetch(url, {
          signal: abort.signal,
          cache: 'no-store',
          redirect: 'error',
          headers: { Authorization: `Bearer ${this.options.token}` },
        });
        if (!response.ok) return false;
        const status = (await response.json()) as { state?: unknown };
        if (status.state === 'closed') return true;
        if (status.state !== 'running') return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch {
      // Missing status, a stopped page server, and invalid replies remain errors.
    } finally {
      clearTimeout(timeout);
    }
    return false;
  }
  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
  private nextMirror(afterReset?: number, atRevision?: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Native host is closed'));
    return new Promise((resolve, reject) => {
      const waiter: MirrorWaiter = {
        resolve,
        reject,
        afterReset,
        atRevision,
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
    if (
      !(update.flags & 5) &&
      this.hello?.limits.pageRemovals &&
      this.hello.limits.subscribeRevision &&
      update.subscriptionRevision === undefined
    )
      throw new Error('Native mirror omitted negotiated subscription revision');
    this.lastMirrorFlags = update.flags;
    const complete = this.memory.apply(update);
    this.connection.notify(NativeMessageType.Ack, encodeU32(update.frame));
    if (!complete) {
      if (update.flags & 4 && this.running) void this.recoverInvalidMirror();
      return;
    }
    if (update.flags & 2) this.resetSerial++;
    this.completeRevision = update.subscriptionRevision ?? null;
    if (this.previousLogicFrame !== null && update.frame < this.previousLogicFrame) this.invalidateBattleReaders();
    // A retained complete mirror is not evidence for a second match. The new video mode must first be observed,
    // followed by a complete logic-boundary publication; loading pictures alone cannot release old state.
    if (this.menuSurface === false) this.awaitingBattleMirror = false;
    if (this.previousLogicFrame !== null && update.frame >= this.previousLogicFrame)
      this.callbacks.onLogicFrame?.(update.frame - this.previousLogicFrame);
    this.previousLogicFrame = update.frame;
    for (const waiter of this.waiters) {
      if (waiter.afterReset !== undefined && this.resetSerial <= waiter.afterReset) continue;
      if (waiter.atRevision !== undefined && !revisionReached(this.completeRevision, waiter.atRevision)) continue;
      clearTimeout(waiter.timer);
      waiter.resolve();
      this.waiters.delete(waiter);
    }
  }
  private pictureArrived(picture: NativePicture): void {
    if (this.closed || !this.running) return;
    const menuSize = this.policy?.menuSurface;
    if (
      menuSize &&
      (this.menuSurface !== null || picture.width !== menuSize.width || picture.height !== menuSize.height)
    ) {
      const isMenu = picture.width === menuSize.width && picture.height === menuSize.height;
      if (isMenu !== this.menuSurface) {
        this.menuSurface = isMenu;
        this.awaitingBattleMirror = true;
        this.invalidateBattleReaders();
      }
    }
    this.creditOutstanding = false;
    if (this.hello) this.hello.surface = { width: picture.width, height: picture.height, bpp: 16, format: 'RGB565' };
    const frame: VmFrame = {
      width: picture.width,
      height: picture.height,
      pixels: new Uint8Array(),
      palette: new Uint8Array(),
      rgb565: picture.pixels,
      ...(this.options.pageCursor !== undefined
        ? {
            pointer: this.pointer,
            ...(!this.pointer && this.systemCursor
              ? { cursor: { ...this.systemCursor, rgba: this.systemCursor.rgba.slice() } }
              : {}),
          }
        : {}),
    };
    this.refreshPointer(picture);
    // Films and menus can supply pictures without an HD render-state poll.
    // Reuse a pending lightweight query and skip it when another reader just
    // sampled, keeping this observation independent of timers and key input.
    if (performance.now() - this.inputStateReadAt >= 16) void this.readInputState().catch(() => undefined);
    this.scheduleFrame(() => {
      if (this.closed || !this.running) return;
      this.hostFrames++;
      this.callbacks.onFrame?.(frame);
    });
  }

  private observeInputState(state: NativeInputState): NativeInputState {
    this.inputStateReadAt = performance.now();
    if (this.closed) return state;
    this.inputState = state;
    this.movieState = {
      moviePlaying: state.moviePlaying,
      movieOpens: state.movieOpens,
      movieTotalMs: state.movieTotalMs,
      movieTrackingFailures: state.movieTrackingFailures,
    };
    // The main menu also keeps a Bink handle for its animated background.
    // A visible dialog owns input there; Escape must never be offered as a film skip.
    const playing = state.moviePlaying === true && !state.modal;
    if (typeof state.moviePlaying === 'boolean' && this.moviePlaying !== playing) {
      this.moviePlaying = playing;
      this.callbacks.onMoviePlayback?.(this.moviePlaying);
    }
    return state;
  }

  private readInputState(): Promise<NativeInputState> {
    if (this.inputStateReadPending) return this.inputStateReadPending;
    const pending = this.connection
      .request(NativeMessageType.InputState, encodeU32(NATIVE_INPUT_STATE_MINIMAL))
      .then((bytes) => this.observeInputState(decodeJson(bytes) as NativeInputState));
    this.inputStateReadPending = pending;
    void pending
      .finally(() => {
        if (this.inputStateReadPending === pending) this.inputStateReadPending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  async getMenuSnapshot(): Promise<MenuSnapshot | null> {
    if (
      this.closed ||
      !this.running ||
      !this.hello?.limits.menuSnapshot ||
      this.inputOutstanding ||
      this.inputQueue.length
    )
      return null;
    if (this.menuSnapshotPending) return this.menuSnapshotPending;
    // Pictures and render-state reads already sample modal ownership. Reuse
    // that lightweight observation; normal match play never queries controls.
    const input = performance.now() - this.inputStateReadAt < 100 ? this.inputState : await this.readInputState();
    if (!(input.menuVisible ?? input.modal) || this.inputOutstanding || this.inputQueue.length) return null;
    if (this.menuSnapshotPending) return this.menuSnapshotPending;
    const pending = this.connection
      .request(NativeMessageType.InputState, encodeU32(NATIVE_INPUT_STATE_MENU))
      .then(async (bytes) => {
        // A pending GUI input can still replace this dialog. Its ACK only
        // establishes delivery, not that its callback has finished painting.
        if (this.closed || !this.running || this.inputOutstanding || this.inputQueue.length) return null;
        const snapshot = decodeMenuSnapshot(bytes);
        if (!snapshot || !this.policy?.readMenuTexts) return snapshot;
        const texts = await this.policy.readMenuTexts(
          async (address, length) => (await this.connection.read(address, length)).bytes,
          snapshot.controls.map((control) => control.hwnd),
        );
        for (const control of snapshot.controls) {
          if (!texts.has(control.hwnd)) continue;
          control.sourceText = control.text;
          control.text = texts.get(control.hwnd)!;
          control.textComplete = true;
        }
        const current = await this.readInputState();
        if (current.menuHwnd !== snapshot.dialogHwnd) snapshot.complete = false;
        return this.closed || !this.running || this.inputOutstanding || this.inputQueue.length ? null : snapshot;
      });
    this.menuSnapshotPending = pending;
    void pending
      .finally(() => {
        if (this.menuSnapshotPending === pending) this.menuSnapshotPending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private refreshPointer(picture: NativePicture): void {
    if (this.options.pageCursor === undefined || !this.policy?.readPointer) return;
    this.pointerReadPicture = picture;
    if (this.pointerReadPending) return;
    this.pointerReadPending = true;
    const update = async () => {
      while (this.pointerReadPicture && !this.closed && this.running) {
        const current = this.pointerReadPicture;
        this.pointerReadPicture = null;
        await this.readCurrentPointer(current.width, current.height);
      }
    };
    void update().finally(() => {
      this.pointerReadPending = false;
    });
  }

  private async readCurrentPointer(width: number, height: number): Promise<void> {
    if (!this.policy?.readPointer) return;
    try {
      const pointer = await this.policy.readPointer(
        async (address, length) => (await this.connection.read(address, length)).bytes,
        width,
        height,
      );
      // An unconfirmed sample preserves the last actual art while the page
      // continues moving it locally. Null explicitly leaves software mode.
      if (pointer === undefined) return;
      let system: VmFrame['cursor'];
      if (pointer === null && this.hello?.limits.cursorSnapshot) {
        try {
          system = decodeCursorSnapshot(
            await this.connection.request(NativeMessageType.InputState, encodeU32(NATIVE_INPUT_STATE_CURSOR)),
          );
        } catch {
          // Software absence is authoritative even if the separate hardware
          // read is unavailable. Retain only previously validated hardware.
          system = this.systemCursor;
        }
      }
      if (!this.closed) {
        this.pointer = pointer;
        this.systemCursor = system;
      }
    } catch {
      // A failed READ is unavailable, not evidence that the game hid its
      // pointer. Shutdown remains the owner of clearing retained session art.
    }
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
      if (this.options.pageCursor && this.policy.setPointerDrawing && this.policy.readPointer) {
        this.pointerSuppressed = await runNativeTransaction(
          this.memory,
          (transaction) => this.policy!.setPointerDrawing!(transaction, false),
          {
            ...this.host,
            commit: async (writes) => {
              if (!writes.length) return;
              await this.connection.batch(writes);
              this.pointerUndo = writes.map((write) => ({
                address: write.address,
                expected: write.bytes.slice(),
                bytes: write.expected.slice(),
              }));
            },
          },
        );
        if (!this.pointerSuppressed) throw new Error('Native cursor drawing signature is unsupported');
      }
      const input = this.observeInputState(
        decodeJson(await this.connection.request(NativeMessageType.InputState)) as NativeInputState,
      );
      // A menu has native pictures and input but no logic-frame callbacks. Do
      // not manufacture a mirror or a logic-thread ID to make it attachable.
      // An attachment outside a menu still requires a complete initial mirror.
      if (!this.memory.complete && !input.modal && !input.moviePlaying) await this.nextMirror();
      if (this.memory.complete) await this.preparePolicy();
      if (this.options.pageCursor !== undefined && this.hello.surface.width > 0 && this.hello.surface.height > 0)
        await this.readCurrentPointer(this.hello.surface.width, this.hello.surface.height);
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
      const revisionSupported = this.hello.limits.pageRemovals === true && this.hello.limits.subscribeRevision === true;
      const rules = this.policy.rules.map((rule) => ({ ...rule }));
      const response = await this.connection.request(
        NativeMessageType.Subscribe,
        encodeSubscription({
          ranges: next,
          rules,
          maxPages: this.hello.limits.pages,
          budgetUs: Math.min(12000, this.hello.limits.maxBudgetUs ?? 4000),
          sampleCount: 0,
          pageRemovals: revisionSupported,
        }),
      );
      if (revisionSupported && response.byteLength !== 4)
        throw new Error('Native subscription omitted negotiated revision');
      const revision = revisionSupported
        ? new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(0, true)
        : undefined;
      this.subscribed = next;
      this.subscribedRules = rules;
      if (this.hookStarted) {
        if (revision !== undefined) {
          if (!this.memory.complete || !revisionReached(this.completeRevision, revision))
            await this.nextMirror(undefined, revision);
        } else if (this.resetSerial <= beforeReset || !this.memory.complete) await this.nextMirror(beforeReset);
      }
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
      this.subscribedRules = [];
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
  private invalidateBattleReaders(): void {
    this.readerEpoch++;
    this.previousLogicFrame = null;
    for (const slot of [this.render, this.command, this.frame]) {
      slot.reader = null;
      slot.previous = null;
      slot.error = null;
      slot.coldAt = undefined;
    }
    this.meter.reset();
  }
  private async readExclusive<T>(slot: ReaderSlot<T>, factory: () => (() => T | null) | null): Promise<T | null> {
    if (this.menuSurface === true || this.awaitingBattleMirror) return null;
    if (!this.running || !this.policy || !this.memory.complete || this.recovering) return slot.previous;
    const epoch = this.readerEpoch;
    const at = performance.now();
    try {
      await this.preparePolicy();
      await this.expandPolicyRanges();
      if (epoch !== this.readerEpoch) return null;
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
      if (epoch !== this.readerEpoch) return null;
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
      return epoch === this.readerEpoch ? result : null;
    } catch (error) {
      if (epoch !== this.readerEpoch) return null;
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
  async getRenderPreparation(): Promise<GameRenderPreparation | null> {
    if (!this.running || this.closed || !this.policy?.readRenderPreparation) return null;
    if (this.renderPreparationPending) return this.renderPreparationPending;
    const pending = this.policy
      .readRenderPreparation(async (address, length) => (await this.connection.read(address, length)).bytes)
      .then((value) => (this.running && !this.closed ? value : null));
    this.renderPreparationPending = pending;
    void pending
      .finally(() => {
        if (this.renderPreparationPending === pending) this.renderPreparationPending = null;
      })
      .catch(() => undefined);
    return pending;
  }
  async getRenderState(): Promise<GameRenderState | null> {
    if (!this.running) return null;
    const input = await this.readInputState();
    if (input.modal || input.moviePlaying) return null;
    return this.read(this.render, () => this.policy!.createRenderReader());
  }
  async getCommandState(): Promise<GameCommandState | null> {
    if (!this.running) return null;
    const input = await this.readInputState();
    if (input.modal || input.moviePlaying) return null;
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
    const position = kind === 3 || (kind === 1 && a === 0x0200);
    const operation = { kind, a, b, c, position };
    const trailing = this.inputQueue.at(-1);
    if (position && trailing?.position) {
      // Coalesce only the unsent tail. A button, key or wheel operation is an
      // ordering barrier, so its preceding position cannot change afterwards.
      if (kind === 3 && trailing.kind === 1) {
        trailing.c = (((b & 0xffff) << 16) | (a & 0xffff)) >>> 0;
      } else this.inputQueue[this.inputQueue.length - 1] = operation;
    } else this.inputQueue.push(operation);
    this.drainInput();
  }
  private drainInput(): void {
    if (this.inputOutstanding || !this.running || this.closed) return;
    const operation = this.inputQueue.shift();
    if (!operation) return;
    this.inputOutstanding = true;
    void this.connection
      .request(
        NativeMessageType.Input,
        encodeU32(operation.kind, operation.a >>> 0, operation.b >>> 0, operation.c >>> 0),
      )
      .then(() => {
        this.inputOutstanding = false;
        this.drainInput();
      })
      .catch((error) => {
        this.inputOutstanding = false;
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
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
    const state = decodeJson(await this.connection.request(NativeMessageType.InputState)) as NativeInputState & {
      x: number;
      y: number;
      lastKeyMessage: number;
      lastKeyVirtualKey: number;
      lastMessage: number;
    };
    this.observeInputState(state);
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
        inputQueueLength: this.inputQueue.length,
        inputOutstanding: this.inputOutstanding,
        ...this.movieState,
        cursor: {
          pagePresentation: this.pointerSuppressed,
          software: this.pointer ?? null,
          hardware: this.systemCursor
            ? {
                handle: this.systemCursor.handle,
                width: this.systemCursor.width,
                height: this.systemCursor.height,
                hotspotX: this.systemCursor.hotspotX,
                hotspotY: this.systemCursor.hotspotY,
              }
            : null,
          readPending: this.pointerReadPending,
        },
      },
    };
  }

  /** Optional read-only audit surface, independent of the VM diagnostic/Worker ABI and guest reads. */
  getMirrorFootprint(): NativeMirrorFootprint {
    const fixed = mergeRanges(this.policy?.ranges ?? []),
      additional = this.additionalRanges.map((range) => ({ ...range })),
      learned = this.workingSet.ranges,
      subscribed = this.subscribed.map((range) => ({ ...range })),
      published = this.memory.publishedRanges,
      fixedPages = rangePages(fixed),
      additionalPages = rangePages(additional),
      learnedPages = rangePages(learned),
      subscribedPages = rangePages(subscribed),
      publishedPages = rangePages(published),
      basePages = new Set([...fixedPages, ...additionalPages]),
      requestedPages = new Set([...basePages, ...learnedPages]),
      scopes = this.workingSet.scopes.map((scope) => ({ ...scope, pages: rangePages(scope.ranges) })),
      references = new Map<number, number>();
    for (const scope of scopes) for (const page of scope.pages) references.set(page, (references.get(page) ?? 0) + 1);
    return {
      sampledAtMs: performance.now(),
      pageLimit: this.hello?.limits.pages ?? null,
      mirror: {
        complete: this.memory.complete,
        lastPublishedFrame: this.memory.frame,
        lastFlags: this.lastMirrorFlags,
        currentFollowDemand: this.memory.complete ? 'last-complete-mirror' : 'unknown',
        ranges: published,
      },
      ranges: { fixed, additional, learned, subscribed },
      pageCounts: {
        fixed: fixedPages.size,
        additional: additionalPages.size,
        learned: learnedPages.size,
        baseUnion: basePages.size,
        requestedSeedUnion: requestedPages.size,
        subscribed: subscribedPages.size,
        lastPublishedMirror: publishedPages.size,
        knownPublishedOutsideSubscribed: [...publishedPages].filter((page) => !subscribedPages.has(page)).length,
      },
      owners: scopes.map(({ owner, pages }) => {
        const name =
            owner === this.render
              ? 'render'
              : owner === this.command
                ? 'command'
                : owner === this.frame
                  ? 'performance'
                  : typeof owner === 'string'
                    ? owner
                    : 'opaque',
          slot =
            owner === this.render
              ? this.render
              : owner === this.command
                ? this.command
                : owner === this.frame
                  ? this.frame
                  : null;
        return {
          name,
          accessedPages: pages.size,
          learnedPages: [...pages].filter((page) => learnedPages.has(page)).length,
          exclusiveLearnedOutsideBase: [...pages].filter(
            (page) => learnedPages.has(page) && !basePages.has(page) && references.get(page) === 1,
          ).length,
          coldAtMs: slot?.coldAt ?? null,
          readerCached: slot ? slot.reader !== null : null,
        };
      }),
      rules: this.subscribedRules.map((rule) => ({ ...rule })),
    };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.running = false;
    this.inputQueue.length = 0;
    this.pointerReadPicture = null;
    await this.operationTail;
    let cleanupError: unknown;
    try {
      if (this.pointerUndo.length) {
        await this.connection.batch(this.pointerUndo);
        this.pointerUndo = [];
        this.pointerSuppressed = false;
        this.pointer = null;
      }
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
