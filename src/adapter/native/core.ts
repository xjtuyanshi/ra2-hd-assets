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
import type { GuestMemory, VmFrame } from '../../vm86/win32';
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
  admitNativeRanges,
  coalesceNativePages,
  readNativeWithRetry,
  runNativeTransaction,
} from './memory';
import type { NativeRange, NativeTransactionHost, NativeWrite } from './memory';
import { NativeMirrorPacer } from './mirrorPacer';

/**
 * Longest time battle pictures are withheld after attaching to a running battle while the guest has not yet run the
 * requested repaint (see NativeCore.staleBattlefieldHold). The guest normally takes the request at its next frame
 * start, well under this; the bound keeps a lost or unreadable counter from hiding the match.
 */
export const STALE_BATTLEFIELD_HOLD_MS = 1500;
/**
 * A picture credit still unanswered after this long is sent again. The agent coalesces credits (one permission, never
 * a second mailbox) and wakes the game's GUI thread on each, so a repeat is harmless; without it a credit whose
 * capture was lost leaves the native picture frozen until some other path invalidates it.
 */
export const PICTURE_CREDIT_REISSUE_MS = 1000;
/**
 * Longest time mirror credits stay withheld while no reader consumes an image (see NativeMirrorPacer). Well below the
 * one-second mirror waiter and staleness limits; in the original picture it leaves a few captures per second instead
 * of one per logic frame.
 */
export const NATIVE_MIRROR_HOLD_MS = 200;

export class NativeUnsupportedError extends Error {
  constructor(operation: string) {
    super(`Native host does not support ${operation}`);
    this.name = 'NativeUnsupportedError';
  }
}
class NativeMirrorUnavailable extends Error {
  constructor(flags: number, timeoutMs = 1000) {
    super(`No complete native mirror within ${timeoutMs} ms (last flags ${flags})`);
    this.name = 'NativeMirrorUnavailable';
  }
}
export interface NativeCoreOptions extends NativeConnectionOptions {
  renderPassthrough?: boolean;
  pageCursor?: boolean;
  /** Development opt-in until native clean-plane coverage is complete. */
  drawJournal?: boolean;
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
interface RenderPublicationWaiter {
  promise: Promise<void>;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
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
interface NativeMirrorRecovery {
  sequence: number;
  atEpochMs: number;
  reason: string;
  frame: number | null;
  flags: number;
  learned: NativeRange[];
  learnedOwners: { name: string; ranges: NativeRange[] }[];
  fault?: unknown;
  resumedAtEpochMs?: number;
}
interface NativeCadenceEvent {
  sequence: number;
  stage: 'mirror' | 'built' | 'handoff';
  frame: number;
  atEpochMs: number;
  durationMs: number;
}
/** Frequent telemetry keeps the fault and its matching owners, not every retired reader page. */
function compactMirrorRecovery(event: NativeMirrorRecovery) {
  const fault = event.fault as { address?: unknown; readAddress?: unknown } | null | undefined;
  const address = typeof fault?.address === 'number' ? fault.address : fault?.readAddress;
  return {
    sequence: event.sequence,
    atEpochMs: event.atEpochMs,
    resumedAtEpochMs: event.resumedAtEpochMs,
    reason: event.reason,
    frame: event.frame,
    flags: event.flags,
    retiredRangeCount: event.learned.length,
    retiredPageCount: event.learned.reduce((sum, range) => sum + range.length / NATIVE_PAGE_SIZE, 0),
    faultOwners:
      typeof address === 'number'
        ? event.learnedOwners
            .filter((owner) =>
              owner.ranges.some((range) => address >= range.address && address < range.address + range.length),
            )
            .map((owner) => owner.name)
        : [],
    fault: event.fault ?? null,
  };
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
  private creditIssuedAt = -Infinity;
  private creditReissues = 0;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly waiters = new Set<MirrorWaiter>();
  private renderPublicationWaiter: RenderPublicationWaiter | null = null;
  private renderTargetFps: number | null = null;
  private mirrorWindow = 1;
  private completeAppliedAt = -Infinity;
  private frameReadImageAt = -Infinity;
  private performanceImageAt = -Infinity;
  private readonly pacer = new NativeMirrorPacer({
    acknowledge: (frame) => {
      try {
        this.connection.notify(NativeMessageType.Ack, encodeU32(frame));
      } catch (error) {
        // A hold timer can outlive the socket; that connection's credits died with it.
        if (!(error instanceof NativeConnectionLostError)) throw error;
      }
    },
    window: () => this.mirrorWindow,
    holdMs: NATIVE_MIRROR_HOLD_MS,
  });
  private subscribed: NativeRange[] = [];
  private subscribedRules: NativeHostFollowRule[] = [];
  private readonly workingSet = new NativeReaderWorkingSet();
  private additionalRanges: NativeRange[] = [];
  private resetSerial = 0;
  private completeRevision: number | null = null;
  private requiredRevision: number | null = null;
  private requiredResetAfter: number | null = null;
  private hookStarted = false;
  private metadata: NativeHostMetadata = { gameThreadId: 0 };
  private policyPrepared = false;
  private policyPreparation: Promise<void> | null = null;
  private recovering = false;
  private checkingCaptureFault = false;
  private capacityRecoveryEpoch = -1;
  private recoveryCount = 0;
  private recoveryAt = -Infinity;
  private recoveries: NativeMirrorRecovery[] = [];
  private mirrorWatchdog: ReturnType<typeof setInterval> | null = null;
  private completeMirrorAt = -Infinity;
  private renderRequestedAt: number | null = null;
  private renderDemandAt = -Infinity;
  private renderPending = 0;
  private completeRenderAt = -Infinity;
  private completeRenderFrame: number | null = null;
  private battleResumedAt = -Infinity;
  private subscriptionTail: Promise<void> = Promise.resolve();
  private render: ReaderSlot<GameRenderState> = { reader: null, previous: null, error: null };
  private command: ReaderSlot<GameCommandState> = { reader: null, previous: null, error: null };
  private frame: ReaderSlot<GameFrameCounters> = { reader: null, previous: null, error: null };
  private passthrough: RenderPassthroughControl | null = null;
  /** See repaintAttachedBattlefield; failed attempts are retried a bounded number of times. */
  private battlefieldRepaint: 'owed' | 'pending' | 'done' = 'owed';
  private battlefieldRepaintFailures = 0;
  private battlefieldRepaintAt: number | null = null;
  /**
   * Attached to a running battle (a page reload): until the guest has run the repaint asked for by
   * repaintAttachedBattlefield, its battle pictures still copy the stale terrain cache (whole-screen key colour where
   * the previous client had terrain passthrough on). Those pictures are dropped, never presented, for at most
   * STALE_BATTLEFIELD_HOLD_MS after the attachment. `before` is the guest's repaint counter when the request was made.
   */
  private staleBattlefieldHold: { deadline: number; before: number | null; checking: boolean } | null = null;
  private staleBattlefieldPicturesHeld = 0;
  private undo: NativeWrite[] = [];
  private readonly allocations = new Map<number, number>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private passthroughTail: Promise<unknown> = Promise.resolve();
  private hostFrames = 0;
  private stateReadMs = 0;
  private stateReads = 0;
  private stateReadCpuMs = 0;
  private stateReadCpuMaxMs = 0;
  private readerOperations: { startEpochMs: number; durationMs: number }[] = [];
  private readonly cadence = {
    mirrors: 0,
    completeMirrors: 0,
    distinctMirrors: 0,
    truncatedMirrors: 0,
    invalidMirrors: 0,
    mirrorApplyMs: 0,
    mirrorApplyMaxMs: 0,
    renderRequests: 0,
    renderAttempts: 0,
    renderCached: 0,
    renderPublicationWaits: 0,
    renderPublicationWakes: 0,
    renderPublicationTimeouts: 0,
    renderPublicationInterrupts: 0,
    renderPublicationWaitMs: 0,
    renderPublicationWaitMaxMs: 0,
    renderReaderCalls: 0,
    renderCompletions: 0,
    distinctRenderCompletions: 0,
    renderHandoffs: 0,
    distinctRenderHandoffs: 0,
    renderInputWaitMs: 0,
    renderInputWaitMaxMs: 0,
    renderCpuMs: 0,
    renderCpuMaxMs: 0,
  };
  private mirrorPublication = 0;
  private renderPublication = -1;
  private renderPublicationEpoch = -1;
  private cadenceSequence = 0;
  private cadenceMirrorFrame: number | null = null;
  private cadenceBuiltFrame: number | null = null;
  private cadenceHandoffFrame: number | null = null;
  private readonly cadenceEvents: NativeCadenceEvent[] = [];
  private lastMirrorFlags = 0;
  private unreadableSinceEpochMs: number | null = null;
  /**
   * First truncated capture (budget or page cap) since the render reader last completed. A truncation while
   * scrolling is caught up within a few publications; one that lasts means the match outgrew what the agent can
   * copy per frame (round 9e #10: 16 741 infantry, 119 recoveries and no complete mirror), and the bridge must not
   * keep a frozen HD picture over the live game. Reported as is; the bridge decides how long is too long.
   */
  private incompleteSinceEpochMs: number | null = null;
  private previousLogicFrame: number | null = null;
  private menuSurface: boolean | null = null;
  private awaitingBattleMirror = false;
  private readerEpoch = 0;
  private inputQueue: NativeInputOperation[] = [];
  private inputOutstanding = false;
  private inputOutstandingChangesMenu = false;
  private menuInputRevision = 0;
  private pointer: VmFrame['pointer'] = null;
  private pointerReadPending = false;
  private pointerReadPicture: NativePicture | null = null;
  private pointerSuppressed = false;
  private pointerUndo: NativeWrite[] = [];
  private hiddenPresentationUndo: NativeWrite[] = [];
  private systemCursor: VmFrame['cursor'];
  private failure: Promise<boolean | null> | null = null;
  private stopping: Promise<void> | null = null;
  private sessionStatusAbort: AbortController | null = null;
  private sessionTerminal: Promise<boolean> | null = null;
  private moviePlaying = false;
  private movieState: NativeInputState = {};
  private inputStateReadAt = -Infinity;
  private inputStateReadPending: Promise<NativeInputState> | null = null;
  private checkingMirrorHealth = false;
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

  private status(phase: VmPhase, detail: string, notice?: string): void {
    this.phase = phase;
    this.callbacks.onStatus?.({ phase, detail, ...(notice ? { notice } : {}) });
  }
  private fail(error: Error): Promise<boolean | null> {
    if (this.failure) return this.failure;
    if (this.closed) return Promise.resolve(null);
    this.running = false;
    // A failed session cannot return credits; they belong to the connection that is going away.
    this.pacer.reset();
    this.rejectWaiters(error);
    if (error instanceof NativeConnectionLostError && this.sessionTerminal) {
      const notice = '游戏连接已中断，正在确认游戏是否已关闭。';
      this.status('running', notice, notice);
    }
    this.failure = (async () => {
      const normalExit = error instanceof NativeConnectionLostError && (await this.sessionTerminal);
      // Explicit cancellation owns teardown, including aborting the observer.
      // Its aborted body must not revive this older transport failure as error.
      if (this.closed || this.stopping) return null;
      if (!normalExit) this.status('error', error.message);
      await this.stop().catch((cleanup) => {
        if (!normalExit) console.warn('[native] Error cleanup:', cleanup);
      });
      this.status(normalExit ? 'exited' : 'error', normalExit ? '游戏已关闭' : error.message);
      return normalExit === true;
    })();
    return this.failure;
  }
  private async observeLauncherClosure(): Promise<void> {
    // Establish the authenticated response before opening the native socket.
    // Its terminal body can then wait in the browser network layer while this
    // Worker is frozen; closure never depends on a later HTTP request or timer.
    if (!this.options.sessionStatusUrl) return;
    let url: URL;
    try {
      url = new URL(this.options.sessionStatusUrl);
    } catch {
      throw new Error('启动器状态网址无效。请重新运行启动器。');
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^1545[0-9]$/.test(url.port))
      throw new Error('启动器状态网址无效。请重新运行启动器。');
    url.searchParams.set('wait', 'terminal');
    this.sessionStatusAbort = new AbortController();
    const response = await fetch(url, {
      signal: this.sessionStatusAbort.signal,
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.options.token}` },
    });
    if (!response.ok || response.headers.get('X-Native-Session-Wait') !== 'terminal')
      throw new Error('无法建立本次启动器的关闭通知。请重新运行启动器。');
    this.sessionTerminal = response
      .json()
      .then((status: { state?: unknown }) => status.state === 'closed')
      .catch(() => false);
  }
  private rejectWaiters(error: Error): void {
    // Recovery keeps the same connection: withheld credits must return, or the agent's drained-window barrier for
    // the replacement subscription could never be met. Teardown forgets them separately.
    this.pacer.releaseForBarrier();
    this.finishRenderPublicationWait('interrupt');
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
  private finishRenderPublicationWait(reason: 'publication' | 'timeout' | 'interrupt'): void {
    const waiter = this.renderPublicationWaiter;
    if (!waiter) return;
    this.renderPublicationWaiter = null;
    clearTimeout(waiter.timer);
    const duration = performance.now() - waiter.startedAt;
    this.cadence.renderPublicationWaitMs += duration;
    this.cadence.renderPublicationWaitMaxMs = Math.max(this.cadence.renderPublicationWaitMaxMs, duration);
    if (reason === 'publication') this.cadence.renderPublicationWakes++;
    else if (reason === 'timeout') this.cadence.renderPublicationTimeouts++;
    else this.cadence.renderPublicationInterrupts++;
    waiter.resolve();
  }
  private reusableRenderPublication(at: number): boolean {
    return (
      this.render.previous !== null &&
      this.render.reader !== null &&
      this.render.error === null &&
      this.render.coldAt !== undefined &&
      at - this.render.coldAt < 1000 &&
      this.renderPublication === this.mirrorPublication &&
      this.renderPublicationEpoch === this.readerEpoch
    );
  }
  private waitForRenderPublication(): Promise<void> | null {
    if (this.renderPublicationWaiter) return this.renderPublicationWaiter.promise;
    const at = performance.now();
    if (
      !this.running ||
      this.closed ||
      this.recovering ||
      !this.hasCurrentMirror() ||
      this.menuSurface === true ||
      this.awaitingBattleMirror ||
      this.inputState.menuVisible ||
      this.inputState.modal ||
      this.inputState.moviePlaying ||
      !this.render.previous?.map ||
      !this.reusableRenderPublication(at)
    )
      return null;
    // Keep a duplicate battlefield RPC on the Worker until a fresh immutable publication arrives.
    // The game's known target supplies the interval; one 60 Hz presentation interval bounds menu latency.
    const duration = Math.min(1000 / (this.renderTargetFps ?? 60), 1000 / 60);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.renderPublicationWaiter = {
      promise,
      resolve,
      startedAt: at,
      timer: setTimeout(() => this.finishRenderPublicationWait('timeout'), duration),
    };
    this.cadence.renderPublicationWaits++;
    return promise;
  }
  private nextMirror(afterReset?: number, atRevision?: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Native host is closed'));
    const timeoutMs = this.running ? 1000 : 8000;
    return new Promise((resolve, reject) => {
      const waiter: MirrorWaiter = {
        resolve,
        reject,
        afterReset,
        atRevision,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new NativeMirrorUnavailable(this.lastMirrorFlags, timeoutMs));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      // A waiter needs a newer image now; withheld credits would delay or block the capture it waits for.
      this.pacer.releaseForBarrier();
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
    const wasCurrent = this.hasCurrentMirror();
    const previousMirrorFrame = this.memory.frame;
    this.lastMirrorFlags = update.flags;
    this.cadence.mirrors++;
    if (update.flags & 1) {
      this.cadence.truncatedMirrors++;
      this.incompleteSinceEpochMs ??= performance.timeOrigin + performance.now();
    }
    if (update.flags & 4) {
      this.cadence.invalidMirrors++;
      this.unreadableSinceEpochMs ??= performance.timeOrigin + performance.now();
    }
    const appliedAt = performance.now();
    const complete = this.memory.apply(update);
    const applyMs = performance.now() - appliedAt;
    this.cadence.mirrorApplyMs += applyMs;
    this.cadence.mirrorApplyMaxMs = Math.max(this.cadence.mirrorApplyMaxMs, applyMs);
    if (!complete) {
      this.pacer.arrived(update.frame, this.mirrorPublication, false);
      this.finishRenderPublicationWait('interrupt');
      if (update.flags & 4 && this.running) void this.recoverInvalidMirror();
      else if (update.flags & 1 && this.running) void this.recoverCaptureCapacity();
      return;
    }
    this.mirrorPublication++;
    this.completeAppliedAt = appliedAt;
    // Credits follow consumption: the agent captures again once a reader has used an image (NativeMirrorPacer).
    this.pacer.arrived(update.frame, this.mirrorPublication, true);
    this.cadence.completeMirrors++;
    if (this.cadenceMirrorFrame !== update.frame) {
      this.cadence.distinctMirrors++;
      this.cadenceMirrorFrame = update.frame;
      this.recordCadence('mirror', update.frame, applyMs);
    }
    if (update.flags & 2) this.resetSerial++;
    this.completeRevision = update.subscriptionRevision ?? null;
    if (this.hasCurrentMirror()) {
      if (!wasCurrent || previousMirrorFrame !== update.frame) this.completeMirrorAt = performance.now();
      if (!wasCurrent && this.renderRequestedAt !== null) this.renderRequestedAt = performance.now();
    }
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
    this.finishRenderPublicationWait('publication');
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
    if (this.holdStaleBattlefieldPicture()) {
      // Not presented, so no presenter ACK follows: ask for the next picture here.
      this.staleBattlefieldPicturesHeld++;
      this.requestNextFrame();
      return;
    }
    if (this.hello) this.hello.surface = { width: picture.width, height: picture.height, bpp: 16, format: 'RGB565' };
    const frame: VmFrame = {
      width: picture.width,
      height: picture.height,
      menuGeneration: picture.menuGeneration,
      pixels: new Uint8Array(),
      palette: new Uint8Array(),
      rgb565: picture.pixels,
      ...(picture.overlayJournal
        ? {
            matchGeneration: picture.overlayJournal.matchGeneration,
            drawGeneration: picture.overlayJournal.drawGeneration,
            overlayJournal: picture.overlayJournal,
          }
        : {}),
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
      frame.menuVisible = !!(this.inputState.menuVisible || this.inputState.modal);
      this.callbacks.onFrame?.(frame);
    });
  }

  private observeInputState(state: NativeInputState): NativeInputState {
    this.inputStateReadAt = performance.now();
    if (this.closed) return state;
    if (
      (this.inputState.modal || this.inputState.menuVisible || this.inputState.moviePlaying) &&
      !state.modal &&
      !state.menuVisible &&
      !state.moviePlaying
    )
      this.battleResumedAt = performance.now();
    this.inputState = state;
    if (state.modal || state.menuVisible || state.moviePlaying) this.finishRenderPublicationWait('interrupt');
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
    if (this.closed || !this.running || !this.hello?.limits.menuSnapshot || this.menuInputPending()) return null;
    if (this.menuSnapshotPending) return this.menuSnapshotPending;
    const inputRevision = this.menuInputRevision;
    // Pictures and render-state reads already sample modal ownership. Reuse
    // that lightweight observation; normal match play never queries controls.
    const input = performance.now() - this.inputStateReadAt < 100 ? this.inputState : await this.readInputState();
    if (!(input.menuVisible ?? input.modal) || this.menuInputPending() || inputRevision !== this.menuInputRevision)
      return null;
    if (this.menuSnapshotPending) return this.menuSnapshotPending;
    const pending = this.connection
      .request(NativeMessageType.InputState, encodeU32(NATIVE_INPUT_STATE_MENU))
      .then(async (bytes) => {
        // A pending GUI input can still replace this dialog. Its ACK only
        // establishes delivery, not that its callback has finished painting.
        if (this.closed || !this.running || this.menuInputPending() || inputRevision !== this.menuInputRevision)
          return null;
        const snapshot = decodeMenuSnapshot(bytes);
        // Paired agents already captured actual game text on the GUI thread.
        // Reading it again would substitute later text into an older picture.
        if (!snapshot || snapshot.generation !== undefined || !this.policy?.readMenuTexts) return snapshot;
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
        return this.closed || !this.running || this.menuInputPending() || inputRevision !== this.menuInputRevision
          ? null
          : snapshot;
      });
    this.menuSnapshotPending = pending;
    void pending
      .finally(() => {
        if (this.menuSnapshotPending === pending) this.menuSnapshotPending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private menuInputPending(): boolean {
    // Pointer positions change hover feedback without replacing the dialog.
    // Clicks, wheel and keys remain barriers, even if their ACK arrives while
    // the snapshot's asynchronous text read is still in progress.
    return this.inputOutstandingChangesMenu || this.inputQueue.some((operation) => !operation.position);
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
      if (this.options.sessionStatusUrl) await this.observeLauncherClosure();
      if (this.closed) return;
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
      if (this.hello.hidden === true && this.policy.prepareHiddenPresentation) {
        const prepared = await runNativeTransaction(
          this.memory,
          (transaction) => this.policy!.prepareHiddenPresentation!(transaction),
          {
            ...this.host,
            commit: async (writes) => {
              if (!writes.length) return;
              await this.connection.batch(writes);
              this.hiddenPresentationUndo = writes.map((write) => ({
                address: write.address,
                expected: write.bytes.slice(),
                bytes: write.expected.slice(),
              }));
            },
          },
        );
        if (!prepared) throw new Error('Native hidden presentation signature is unsupported');
      }
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
      const surface = this.hello.surface,
        menuSize = this.policy?.menuSurface;
      if (
        this.options.renderPassthrough &&
        this.memory.complete &&
        menuSize &&
        surface.width > 0 &&
        surface.height > 0 &&
        (surface.width !== menuSize.width || surface.height !== menuSize.height)
      )
        this.staleBattlefieldHold = {
          deadline: performance.now() + STALE_BATTLEFIELD_HOLD_MS,
          before: null,
          checking: false,
        };
      // Attached to a running match: ask for the repaint before the first HD state read, which can take seconds.
      this.repaintAttachedBattlefield();
      this.mirrorWatchdog = setInterval(() => {
        this.checkPictureCredit();
        this.checkMirrorHealth();
      }, 250);
      this.status('running', '已连接本机游戏');
      this.requestNextFrame();
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      // A page reopened while the launcher is closing may lose the transport
      // before hello. Share the same terminal decision instead of returning a
      // second startup error which can overwrite a confirmed normal exit.
      if ((await this.fail(reason)) === true) return;
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
    const epoch = this.readerEpoch;
    const operation = async () => {
      if (!this.policy || !this.hello || this.closed || epoch !== this.readerEpoch) return;
      const desired = mergeRanges([...this.policy.ranges, ...this.workingSet.ranges, ...this.additionalRanges]);
      if (sameRanges(desired, this.subscribed)) return;
      // Camera jumps discover scattered render pages. Admit their strict misses before background map pages,
      // spreading a new footprint across complete publications without changing the agent's capture budget.
      const next = admitNativeRanges(this.policy.ranges, desired, this.subscribed, this.memory.missingRanges, 256);
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
          mirrorWindow: (this.mirrorWindow = revisionSupported && this.hello.limits.mirrorWindow === 2 ? 2 : 1),
        }),
      );
      if (epoch !== this.readerEpoch) return;
      if (revisionSupported && response.byteLength !== 4)
        throw new Error('Native subscription omitted negotiated revision');
      const revision = revisionSupported
        ? new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(0, true)
        : undefined;
      this.subscribed = next;
      this.subscribedRules = rules;
      if (this.hookStarted) {
        this.requiredRevision = revision ?? null;
        this.requiredResetAfter = revision === undefined ? beforeReset : null;
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

  /** Reuse only a complete publication accepted after this retry's failed read. */
  private readerRetryHost(owner: unknown, epoch: number): Pick<NativeTransactionHost, 'subscribe' | 'nextMirror'> {
    let failedPublication: number | null = null;
    return {
      subscribe: async (ranges) => {
        failedPublication = this.mirrorPublication;
        await this.subscribe(ranges, owner);
      },
      nextMirror: () => {
        if (!this.running || this.closed) return Promise.reject(new Error('Native host is closed'));
        // The caller's existing epoch check cancels the old read without borrowing the new map's image.
        if (epoch !== this.readerEpoch) return Promise.resolve();
        // subscribe already waits for admission. A no-op without a newer complete publication still waits.
        if (failedPublication !== null && this.mirrorPublication > failedPublication && this.hasCurrentMirror())
          return Promise.resolve();
        return this.nextMirror();
      },
    };
  }
  private async expandPolicyRanges(epoch = this.readerEpoch): Promise<void> {
    const retryHost = this.readerRetryHost('policy', epoch);
    for (let attempt = 0; attempt < 8; attempt++) {
      if (epoch !== this.readerEpoch) return;
      this.memory.beginOperation();
      let additional: readonly NativeHostRange[] | undefined;
      try {
        additional = this.policy!.additionalRanges?.();
      } catch (error) {
        if (!(error instanceof NativeMemoryMiss)) throw error;
      }
      if (this.memory.operationMissed) {
        await retryHost.subscribe(this.memory.missingRanges);
        if (epoch !== this.readerEpoch) return;
        await retryHost.nextMirror();
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
  private async recoverCaptureCapacity(): Promise<void> {
    if (this.checkingCaptureFault || this.recovering || this.closed || this.capacityRecoveryEpoch === this.readerEpoch)
      return;
    this.checkingCaptureFault = true;
    const epoch = this.readerEpoch;
    try {
      const diagnostics = decodeJson(
        await this.connection.request(
          NativeMessageType.Diagnostics,
          this.hello?.limits.mirrorFaultSnapshot ? encodeU32(1) : undefined,
        ),
      ) as {
        lastMirrorFault?: { reason?: number; value?: number; limit?: number };
      };
      const fault = diagnostics?.lastMirrorFault;
      // A time-budget miss is transient. Only the agent's actual page/seed capacity fault retires allocations.
      if (
        epoch === this.readerEpoch &&
        fault &&
        (fault.reason === 2 || fault.reason === 7) &&
        fault.limit === this.hello?.limits.pages &&
        fault.value === fault.limit
      ) {
        this.capacityRecoveryEpoch = epoch;
        await this.recoverInvalidMirror('capture-capacity');
      }
    } catch {
      // An unavailable diagnostic is not a capacity diagnosis; a later publication can try again.
    } finally {
      this.checkingCaptureFault = false;
    }
  }
  private hasCurrentMirror(): boolean {
    return (
      this.memory.complete &&
      (this.requiredRevision === null || revisionReached(this.completeRevision, this.requiredRevision)) &&
      (this.requiredResetAfter === null || this.resetSerial > this.requiredResetAfter)
    );
  }
  private mirrorStaleReason(now: number): 'mirror-stale' | 'reader-stale' | null {
    if (
      !this.running ||
      this.closed ||
      this.recovering ||
      // A bounded capture can fall behind under scrolling. Rebuilding its working set would throw away
      // catch-up progress; only an actual unreadable range justifies that reset while truncation persists.
      (this.unreadableSinceEpochMs === null && (this.lastMirrorFlags & 1) !== 0) ||
      this.renderRequestedAt === null ||
      (!this.renderPending && now - this.renderDemandAt >= 1000) ||
      this.menuSurface === true ||
      this.inputState.modal ||
      this.inputState.menuVisible ||
      this.inputState.moviePlaying
    )
      return null;
    const since = Math.max(this.renderRequestedAt, this.battleResumedAt);
    if (now - Math.max(this.completeMirrorAt, since) >= 1000) return 'mirror-stale';
    if (now - Math.max(this.completeRenderAt, since) >= 1000) return 'reader-stale';
    return null;
  }
  private checkMirrorHealth(freshInput = false): void {
    const reason = this.mirrorStaleReason(performance.now());
    if (!reason) return;
    if (freshInput) {
      void this.recoverInvalidMirror(reason);
      return;
    }
    if (this.checkingMirrorHealth) return;
    this.checkingMirrorHealth = true;
    // A score screen or modal can stop logic without publishing another picture.
    // Confirm current ownership before treating a cached battle state as a stalled mirror.
    void this.readInputState()
      .then(() => {
        const currentReason = this.mirrorStaleReason(performance.now());
        if (currentReason) return this.recoverInvalidMirror(currentReason);
      })
      .finally(() => {
        this.checkingMirrorHealth = false;
      })
      .catch(() => undefined);
  }
  private async recoverInvalidMirror(reason = 'invalid-range'): Promise<void> {
    if (this.recovering || this.closed || !this.policy || !this.hello) return;
    const now = performance.now();
    // A failed learned seed prevents every later complete read, so retirement cannot wait for reader success.
    // Rate-limit rebuilding, never terminate a live game because an optional HD range remains unreadable.
    if (now - this.recoveryAt < 1000) return;
    this.recovering = true;
    this.finishRenderPublicationWait('interrupt');
    this.recoveryAt = now;
    const learned = this.workingSet.ranges;
    const learnedPages = rangePages(learned);
    const recovery: NativeMirrorRecovery = {
      sequence: ++this.recoveryCount,
      atEpochMs: performance.timeOrigin + now,
      reason,
      frame: this.memory.frame,
      flags: this.lastMirrorFlags,
      learned,
      learnedOwners: this.workingSet.scopes
        .map(({ owner, ranges }) => ({
          name:
            owner === this.render
              ? 'render'
              : owner === this.command
                ? 'command'
                : owner === this.frame
                  ? 'performance'
                  : typeof owner === 'string'
                    ? owner
                    : 'opaque',
          ranges: coalesceNativePages([...rangePages(ranges)].filter((page) => learnedPages.has(page))),
        }))
        .filter((owner) => owner.ranges.length > 0),
    };
    this.recoveries.push(recovery);
    if (this.recoveries.length > 64) this.recoveries.shift();
    void this.connection
      .request(NativeMessageType.Diagnostics)
      .then((bytes) => {
        recovery.fault = (decodeJson(bytes) as { lastMirrorFault?: unknown }).lastMirrorFault;
        console.warn('[native] HD mirror recovery', JSON.stringify(compactMirrorRecovery(recovery)));
      })
      .catch(() => undefined);
    try {
      this.readerEpoch++;
      this.rejectWaiters(new NativeMirrorUnavailable(this.lastMirrorFlags));
      this.workingSet.clear();
      this.additionalRanges = [];
      this.subscribed = [];
      this.subscribedRules = [];
      // The negotiated transport sends page deltas, so keep its immutable baseline until removals arrive.
      // No reader may consume that baseline until the replacement subscription publishes completely.
      this.memory.invalidate();
      this.completeRenderFrame = null;
      for (const slot of [this.render, this.command, this.frame]) {
        slot.reader = null;
        slot.previous = null;
        slot.coldAt = undefined;
        slot.error = `Native HD reader rebuilding: ${reason}`;
      }
      this.policy = this.createPolicy(this.memory, this.metadata, this.hello.exe.sha256);
      await this.subscribe([]);
    } catch (error) {
      if (error instanceof NativeMirrorUnavailable) {
        // The replacement subscription can still publish after this wait expires.
        // Keep pictures/input alive; only a transport failure owns the exit handshake.
        for (const slot of [this.render, this.command, this.frame]) slot.error = error.message;
      } else if (error instanceof NativeConnectionLostError) void this.fail(error);
      else {
        // A reader/subscription failure is not evidence that the native process stopped.
        for (const slot of [this.render, this.command, this.frame])
          slot.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.recovering = false;
    }
  }
  private read<T>(slot: ReaderSlot<T>, factory: () => (() => T | null) | null): Promise<T | null> {
    return this.exclusive(() => this.readExclusive(slot, factory));
  }
  private invalidateBattleReaders(): void {
    this.finishRenderPublicationWait('interrupt');
    this.renderTargetFps = null;
    this.readerEpoch++;
    this.previousLogicFrame = null;
    this.renderRequestedAt = null;
    this.completeRenderAt = -Infinity;
    this.completeRenderFrame = null;
    this.unreadableSinceEpochMs = null;
    this.incompleteSinceEpochMs = null;
    this.battleResumedAt = performance.now();
    // An incomplete reader never reaches working-set retirement. End its allocation scope at the actual video
    // mode/frame epoch instead, before the next map can inherit freed or over-capacity pages.
    this.workingSet.clear();
    this.additionalRanges = [];
    if (this.policy && this.hello) {
      this.policy = this.createPolicy(this.memory, this.metadata, this.hello.exe.sha256);
      void this.subscribe([]).catch((error) => {
        if (!(error instanceof NativeMirrorUnavailable))
          this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    }
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
    if (!this.running || !this.policy || !this.hasCurrentMirror() || this.recovering) return null;
    const epoch = this.readerEpoch;
    const at = performance.now();
    if (slot === this.render && this.reusableRenderPublication(at)) {
      // Only an identical immutable publication is reusable. A same-frame publication can change selection/view.
      this.cadence.renderCached++;
      return slot.previous;
    }
    let readPublication = -1;
    let readInvalidMirrors = -1;
    if (slot === this.render) this.cadence.renderAttempts++;
    try {
      await this.preparePolicy();
      await this.expandPolicyRanges(epoch);
      if (epoch !== this.readerEpoch) return null;
      // Refresh cached reader dependencies before retiring their old allocation footprint.
      let cold = !slot.reader || slot.coldAt === undefined || at - slot.coldAt >= 1000;
      if (cold) slot.reader = null;
      const result = await readNativeWithRetry(
        this.memory,
        () => {
          if (epoch !== this.readerEpoch) return null;
          const started = performance.now();
          this.pacer.consume(this.mirrorPublication);
          if (slot === this.frame) this.frameReadImageAt = this.completeAppliedAt;
          if (slot === this.render) {
            this.cadence.renderReaderCalls++;
            readPublication = this.mirrorPublication;
            readInvalidMirrors = this.cadence.invalidMirrors;
          }
          try {
            slot.reader ??= factory();
            return slot.reader?.() ?? null;
          } finally {
            // Excludes asynchronous subscription waits: those remain in stateReadMs.
            const duration = performance.now() - started;
            this.stateReadCpuMs += duration;
            this.stateReadCpuMaxMs = Math.max(this.stateReadCpuMaxMs, duration);
            if (slot === this.render) {
              this.cadence.renderCpuMs += duration;
              this.cadence.renderCpuMaxMs = Math.max(this.cadence.renderCpuMaxMs, duration);
            }
            if (duration >= 5) {
              this.readerOperations.push({ startEpochMs: performance.timeOrigin + started, durationMs: duration });
              if (this.readerOperations.length > 32) this.readerOperations.shift();
            }
          }
        },
        slot.previous,
        this.readerRetryHost(slot, epoch),
        () => {
          slot.reader = null;
          cold = true;
        },
        8,
      );
      if (epoch !== this.readerEpoch) return null;
      if (this.memory.operationMissed) {
        slot.error = 'Native reader retry budget exhausted; awaiting a complete result';
        return null;
      }
      slot.previous = result;
      slot.error = null;
      if (result !== null) {
        this.workingSet.complete(slot, this.memory, cold);
        if (cold) slot.coldAt = performance.now();
        await this.subscribe([]);
        if (epoch === this.readerEpoch && slot === this.render) {
          // A later invalid capture can arrive while admission waits. A result built before that fault
          // cannot clear its episode, even when the reset rate limit keeps the same reader epoch.
          if (this.hasCurrentMirror() && readInvalidMirrors === this.cadence.invalidMirrors)
            this.unreadableSinceEpochMs = null;
          // Any completed render state ends a truncation episode: the HD stream is moving, if slowly.
          this.incompleteSinceEpochMs = null;
          // Subscription waits may receive newer images: cache the publication actually consumed by the reader.
          this.renderPublication = readPublication;
          this.renderPublicationEpoch = epoch;
          this.cadence.renderCompletions++;
          if (this.cadenceBuiltFrame !== (result as GameRenderState).frame) {
            this.cadence.distinctRenderCompletions++;
            this.cadenceBuiltFrame = (result as GameRenderState).frame;
            this.recordCadence('built', this.cadenceBuiltFrame, performance.now() - at);
          }
          if (this.completeRenderFrame !== (result as GameRenderState).frame) {
            this.completeRenderAt = performance.now();
            this.completeRenderFrame = (result as GameRenderState).frame;
          }
          const recovery = this.recoveries.at(-1);
          if (recovery && recovery.resumedAtEpochMs === undefined)
            recovery.resumedAtEpochMs = performance.timeOrigin + this.completeRenderAt;
        }
      }
      return epoch === this.readerEpoch ? result : null;
    } catch (error) {
      if (epoch !== this.readerEpoch) return null;
      if (error instanceof NativeMemoryMiss || error instanceof NativeMirrorUnavailable) {
        slot.error = error.message;
        return null;
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
    this.cadence.renderRequests++;
    const requestAt = performance.now();
    this.renderDemandAt = requestAt;
    const publication = this.waitForRenderPublication();
    if (publication) await publication;
    if (!this.running || this.closed) return null;
    const inputAt = performance.now();
    const input = await this.readInputState();
    const inputWaitMs = performance.now() - inputAt;
    this.cadence.renderInputWaitMs += inputWaitMs;
    this.cadence.renderInputWaitMaxMs = Math.max(this.cadence.renderInputWaitMaxMs, inputWaitMs);
    if (input.menuVisible || input.modal || input.moviePlaying) return null;
    this.checkMirrorHealth(true);
    if (this.recovering) return null;
    if (this.renderRequestedAt === null && this.memory.frame !== null) this.renderRequestedAt = performance.now();
    this.renderPending++;
    try {
      const result = await this.read(this.render, () => this.policy!.createRenderReader());
      if (result?.map) this.repaintAttachedBattlefield();
      if (result) {
        this.cadence.renderHandoffs++;
        if (this.cadenceHandoffFrame !== result.frame) {
          this.cadence.distinctRenderHandoffs++;
          this.cadenceHandoffFrame = result.frame;
          this.recordCadence('handoff', result.frame, performance.now() - requestAt);
        }
      }
      return result;
    } finally {
      this.renderPending--;
    }
  }
  private recordCadence(stage: NativeCadenceEvent['stage'], frame: number, durationMs: number): void {
    const event = {
      sequence: ++this.cadenceSequence,
      stage,
      frame,
      atEpochMs: performance.timeOrigin + performance.now(),
      durationMs,
    };
    // A bounded cross-clock timeline joins Worker receipt/builds to page draw opportunities.
    this.cadenceEvents.push(event);
    if (this.cadenceEvents.length > 512) this.cadenceEvents.shift();
  }
  async getCommandState(): Promise<GameCommandState | null> {
    if (!this.running) return null;
    const input = await this.readInputState();
    if (input.menuVisible || input.modal || input.moviePlaying) return null;
    return this.read(this.command, () => this.policy!.createCommandReader());
  }
  async getGamePerformance(): Promise<GamePerformanceSample | null> {
    if (!this.hasCurrentMirror()) return null;
    const counters = await this.read(this.frame, () => this.policy!.createFrameReader());
    this.renderTargetFps =
      Number.isFinite(counters?.targetFps) && counters!.targetFps! > 0 ? counters!.targetFps! : null;
    // Paced credits can leave the read image older than this call. Time the sample at that image's arrival, so the
    // logic rate stays measured between the actual frame counters rather than between telemetry calls.
    // An image read again (no publication since) has no newer arrival time; time it at the call as before.
    const imageAt =
      Number.isFinite(this.frameReadImageAt) && this.frameReadImageAt !== this.performanceImageAt
        ? this.frameReadImageAt
        : performance.now();
    this.performanceImageAt = this.frameReadImageAt;
    return counters ? this.meter.sample(counters, imageAt, this.running) : null;
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
    // Restoring original painting cannot queue behind an HD reader waiting for an unreadable mirror.
    // Own the small drawing-control transactions separately; their direct reads never change the mirror.
    const pending = this.passthroughTail.then(async () => {
      if (!this.running || !this.policy || !this.options.renderPassthrough) return false;
      if (!this.passthrough && flags === 0) return true;
      if (flags !== 0 && (!this.hasCurrentMirror() || this.recovering)) return false;
      if (!(await this.installPassthrough())) return false;
      return runNativeTransaction(
        this.memory,
        (transaction) => this.passthrough!.set(transaction, this.recovering ? 0 : flags),
        this.host,
      );
    });
    this.passthroughTail = pending.catch(() => undefined);
    return pending;
  }
  private async installPassthrough(): Promise<boolean> {
    if (!this.passthrough) {
      await this.preparePolicy();
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
    return !!this.passthrough;
  }
  /**
   * Once per connection, as soon as it is attached to a complete game image (else at the first battlefield it reads):
   * have the game repaint its whole tactical view. A page
   * reload attaches a new client to a running match; the previous client's terrain passthrough had skipped the
   * game's terrain-cache maintenance, and the agent's disconnect teardown restores the original entry sites without a
   * repaint. The original picture then copies that stale cache (the key colour, or terrain from an earlier view
   * position) for as long as the HD view prepares. Nothing else changes: the gates installed for the request stay
   * inert with every category off, exactly as after the HD view is switched off. The guest takes the request at its
   * next battle frame start, so one made in a menu waits for the next match, where it costs one ordinary full redraw.
   */
  private repaintAttachedBattlefield(): void {
    if (this.battlefieldRepaint !== 'owed' || !this.options.renderPassthrough) return;
    this.battlefieldRepaint = 'pending';
    const pending = this.passthroughTail.then(async () => {
      if (!this.running || !this.policy || !this.hasCurrentMirror()) return false;
      // Without the game thread (a menu attachment) the gates cannot be installed yet; a later battlefield can.
      if (!(await this.installPassthrough())) return this.metadata.gameThreadId > 0 ? null : false;
      return runNativeTransaction(
        this.memory,
        (transaction) => {
          const before = this.repaintCount(transaction);
          const done = this.passthrough!.repaint?.(transaction) ?? null;
          if (done && this.staleBattlefieldHold) this.staleBattlefieldHold.before = before;
          return done;
        },
        this.host,
      );
    });
    this.passthroughTail = pending.catch(() => undefined);
    void pending.then(
      (done) => {
        // Not requested yet (no complete mirror): the next battlefield read asks again. An executable without the
        // validated passthrough sites cannot be repainted from here, and is not asked again.
        this.battlefieldRepaint = done === false ? 'owed' : 'done';
        if (done) this.battlefieldRepaintAt = performance.timeOrigin + performance.now();
        // Nothing will repaint: holding pictures could only delay the (stale) original picture.
        if (!done || this.staleBattlefieldHold?.before === null) this.staleBattlefieldHold = null;
      },
      (error) => {
        this.battlefieldRepaint = ++this.battlefieldRepaintFailures < 3 ? 'owed' : 'done';
        this.staleBattlefieldHold = null;
        console.warn('[native] battlefield repaint request failed', error);
      },
    );
  }
  /** The guest's count of repaints it has run (the redraw:request gate counter); null when it has none. */
  private repaintCount(memory: GuestMemory): number | null {
    const count = this.passthrough?.read(memory).counters['redraw:request'];
    return typeof count === 'number' ? count : null;
  }
  /**
   * True while a battle picture must not be presented because the guest has not yet run the repaint requested after
   * attaching to a running battle. Each held picture checks the guest's repaint counter once (one read at a time);
   * menu pictures, the deadline, or a counter that moved past its value at the request end the hold.
   */
  private holdStaleBattlefieldPicture(): boolean {
    const hold = this.staleBattlefieldHold;
    if (!hold) return false;
    if (this.menuSurface === true || performance.now() >= hold.deadline) {
      this.staleBattlefieldHold = null;
      return false;
    }
    if (hold.before !== null && !hold.checking && this.passthrough) {
      hold.checking = true;
      void runNativeTransaction(this.memory, (transaction) => this.repaintCount(transaction), this.host).then(
        (count) => {
          hold.checking = false;
          if (this.staleBattlefieldHold === hold && (count === null || count !== hold.before))
            this.staleBattlefieldHold = null;
        },
        () => {
          if (this.staleBattlefieldHold === hold) this.staleBattlefieldHold = null;
        },
      );
    }
    return true;
  }

  /** Called only after the presenter ACK, so hidden pages naturally backpressure native picture capture. */
  requestNextFrame(): void {
    if (!this.running || this.closed || this.creditOutstanding) return;
    this.creditOutstanding = true;
    this.sendPictureCredit();
  }
  private sendPictureCredit(): void {
    this.creditIssuedAt = performance.now();
    const count = this.hello?.limits.menuIdentity ? 0x80000001 : 1;
    const credit = this.options.drawJournal && this.hello?.limits.drawJournal ? encodeU32(count, 1) : encodeU32(count);
    void this.connection.request(NativeMessageType.Credit, credit).catch((error) => {
      this.creditOutstanding = false;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }
  /** Re-sends a credit that has gone unanswered for PICTURE_CREDIT_REISSUE_MS (see there). */
  private checkPictureCredit(): void {
    if (!this.running || this.closed || !this.creditOutstanding) return;
    if (performance.now() - this.creditIssuedAt < PICTURE_CREDIT_REISSUE_MS) return;
    this.creditReissues++;
    this.sendPictureCredit();
  }
  private input(kind: number, a: number, b: number, c: number): void {
    if (!this.running || this.closed) return;
    const position = kind === 3 || (kind === 1 && a === 0x0200);
    if (!position) this.finishRenderPublicationWait('interrupt');
    if (!position) this.menuInputRevision++;
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
    this.inputOutstandingChangesMenu = !operation.position;
    void this.connection
      .request(
        NativeMessageType.Input,
        encodeU32(operation.kind, operation.a >>> 0, operation.b >>> 0, operation.c >>> 0),
      )
      .then(() => {
        this.inputOutstanding = false;
        this.inputOutstandingChangesMenu = false;
        this.drainInput();
      })
      .catch((error) => {
        this.inputOutstanding = false;
        this.inputOutstandingChangesMenu = false;
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
  async getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics> {
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
        renderHealth: {
          unreadableSinceEpochMs: this.unreadableSinceEpochMs,
          incompleteSinceEpochMs: this.incompleteSinceEpochMs,
        },
        battlefieldRepaint: {
          state: this.battlefieldRepaint,
          requestedAtEpochMs: this.battlefieldRepaintAt,
          picturesHeld: this.staleBattlefieldPicturesHeld,
          holding: this.staleBattlefieldHold !== null,
        },
        lastReaderError: this.render.error ?? this.command.error ?? this.frame.error,
        readerErrors: { render: this.render.error, command: this.command.error, performance: this.frame.error },
        stateReadMs: this.stateReadMs,
        stateReads: this.stateReads,
        stateReadCpuMs: this.stateReadCpuMs,
        stateReadCpuMaxMs: this.stateReadCpuMaxMs,
        readerOperations: this.readerOperations.slice(),
        cadence: { ...this.cadence, recent: this.cadenceEvents.slice() },
        mirrorPacing: { ...this.pacer.counters, holding: this.pacer.holding, window: this.mirrorWindow },
        mirrorRecovery: {
          count: this.recoveryCount,
          omitted: this.recoveryCount - this.recoveries.length,
          rebuilding: this.recovering,
          lastCompleteMirrorAtEpochMs: Number.isFinite(this.completeMirrorAt)
            ? performance.timeOrigin + this.completeMirrorAt
            : null,
          lastCompleteRenderAtEpochMs: Number.isFinite(this.completeRenderAt)
            ? performance.timeOrigin + this.completeRenderAt
            : null,
          events: this.recoveries.map((event) =>
            action === 'usage'
              ? compactMirrorRecovery(event)
              : {
                  ...event,
                  learned: event.learned.map((range) => ({ ...range })),
                  learnedOwners: event.learnedOwners.map((owner) => ({
                    ...owner,
                    ranges: owner.ranges.map((range) => ({ ...range })),
                  })),
                },
          ),
        },
        decode: this.connection.decodeDiagnostics(),
        frames: this.hostFrames,
        creditReissues: this.creditReissues,
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

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.closed) return Promise.resolve();
    this.stopping = this.stopOwnedSession();
    return this.stopping;
  }

  private async stopOwnedSession(): Promise<void> {
    this.sessionStatusAbort?.abort();
    this.sessionStatusAbort = null;
    this.running = false;
    this.finishRenderPublicationWait('interrupt');
    if (this.mirrorWatchdog !== null) clearInterval(this.mirrorWatchdog);
    this.mirrorWatchdog = null;
    this.inputQueue.length = 0;
    this.pointerReadPicture = null;
    await this.operationTail;
    await this.passthroughTail;
    let cleanupError: unknown;
    try {
      if (this.hiddenPresentationUndo.length) {
        await this.connection.batch(this.hiddenPresentationUndo);
        this.hiddenPresentationUndo = [];
      }
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
      this.pacer.reset();
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
