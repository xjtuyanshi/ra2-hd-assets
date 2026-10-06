/**
 * Stall recording for a frame loop: which presented frames came late, and what the caller knew at that moment.
 *
 * A stall is a gap between two presented frames longer than a threshold. The loop calls `StallRecorder.frame` once
 * per frame, which costs one subtraction and one comparison; everything else here runs only when a gap is over the
 * threshold (describing it, keeping it in a ring, handing it to a sink in batches). Nothing in this module knows what
 * the frames show or where the records go.
 */

/** One recorded stall. */
export interface StallEntry<Context> {
  /** Number of the stall in this recorder, from 1. A hole in a sink's sequence is a stall the ring dropped unsent. */
  seq: number;
  /** Wall-clock time (epoch ms) at which the late frame was presented. */
  at: number;
  /** Time between the two presented frames, ms. */
  gapMs: number;
  /** The gap on the loop's own clock (the one `frame` is called with), for matching against other timelines. */
  from: number;
  to: number;
  /** What the caller's `describe` reported for the gap. */
  context: Context;
}

export interface StallRecorderOptions<Context> {
  /** A gap longer than this is a stall (default STALL_THRESHOLD_MS). */
  thresholdMs?: number;
  /** Stalls kept; older ones are overwritten (default STALL_CAPACITY). */
  capacity?: number;
  /** Called once per stall, never for an ordinary frame: what the loop was busy with during `from`..`to`. */
  describe: (from: number, to: number) => Context;
  /** Called after a stall has been stored. */
  onStall?: (entry: StallEntry<Context>) => void;
  /** Epoch clock (default Date.now). */
  wallClock?: () => number;
}

/** A frame later than this after the one before it was not presented smoothly by any display rate in use. */
export const STALL_THRESHOLD_MS = 150;
export const STALL_CAPACITY = 500;

export class StallRecorder<Context> {
  readonly thresholdMs: number;
  readonly capacity: number;
  private last = NaN;
  private count = 0;
  private readonly ring: StallEntry<Context>[] = [];
  private readonly describe: (from: number, to: number) => Context;
  private readonly onStall?: (entry: StallEntry<Context>) => void;
  private readonly wallClock: () => number;

  constructor(options: StallRecorderOptions<Context>) {
    this.thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS;
    this.capacity = Math.max(1, Math.floor(options.capacity ?? STALL_CAPACITY));
    this.describe = options.describe;
    this.onStall = options.onStall;
    this.wallClock = options.wallClock ?? Date.now;
  }

  /**
   * A frame is presented at `now` (any monotonic clock in ms, the same one every time). The first frame, and the
   * first one after `skip`, start a measurement and record nothing.
   */
  frame(now: number): void {
    const gap = now - this.last;
    this.last = now;
    // NaN compares false: no gap is known yet.
    if (gap > this.thresholdMs) this.record(now - gap, now);
  }

  /** The loop was stopped on purpose: the next frame is not measured against the last one. */
  skip(): void {
    this.last = NaN;
  }

  /** Stalls recorded so far, including those the ring no longer holds. */
  get recorded(): number {
    return this.count;
  }

  /** The stalls still held, oldest first. */
  entries(): StallEntry<Context>[] {
    return this.since(0);
  }

  /** The held stalls numbered above `seq`, oldest first, at most `limit` of them. */
  since(seq: number, limit = Infinity): StallEntry<Context>[] {
    const out: StallEntry<Context>[] = [];
    const first = Math.max(seq, this.count - this.capacity) + 1;
    for (let n = first; n <= this.count && out.length < limit; n++) out.push(this.ring[(n - 1) % this.capacity]!);
    return out;
  }

  private record(from: number, to: number): void {
    const seq = ++this.count;
    const entry: StallEntry<Context> = {
      seq,
      at: this.wallClock(),
      gapMs: to - from,
      from,
      to,
      context: this.describe(from, to),
    };
    this.ring[(seq - 1) % this.capacity] = entry;
    this.onStall?.(entry);
  }
}

/**
 * Recent main-thread long tasks (PerformanceObserver 'longtask' entries: tasks of 50 ms or more), to tell a stall the
 * page caused from one it only suffered: a late frame with no long task under it was not kept by the page's own
 * thread (the GPU process or the compositor did not deliver it).
 */
export class LongTaskLog {
  private readonly starts: Float64Array;
  private readonly ends: Float64Array;
  private next = 0;
  private held = 0;

  constructor(capacity = 128) {
    this.starts = new Float64Array(Math.max(1, capacity));
    this.ends = new Float64Array(Math.max(1, capacity));
  }

  add(start: number, duration: number): void {
    this.starts[this.next] = start;
    this.ends[this.next] = start + duration;
    this.next = (this.next + 1) % this.starts.length;
    this.held = Math.min(this.held + 1, this.starts.length);
  }

  /** Milliseconds of `from`..`to` during which a recorded long task ran (tasks do not overlap each other). */
  overlap(from: number, to: number): number {
    let total = 0;
    for (let i = 0; i < this.held; i++)
      total += Math.max(0, Math.min(to, this.ends[i]!) - Math.max(from, this.starts[i]!));
    return Math.min(total, Math.max(0, to - from));
  }
}

/** What a sink answered: the batch is in, it is not (offer it again with a later batch), or there is no sink. */
export type StallSendResult = boolean | 'gone';

export interface StallBatcherOptions<Context> {
  /**
   * Hand a batch over without blocking. True: accepted. False or a rejection: not accepted, the stalls go out again
   * with the next batch. 'gone': nothing listens (no log configured), so nothing is sent again.
   */
  send: (entries: StallEntry<Context>[]) => Promise<StallSendResult>;
  /** Least time between two batches (default STALL_BATCH_INTERVAL_MS). */
  intervalMs?: number;
  /** Most stalls in one batch (default STALL_BATCH_SIZE); the rest follows an interval later. */
  maxBatch?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const STALL_BATCH_INTERVAL_MS = 5000;
export const STALL_BATCH_SIZE = 50;

/**
 * Sends a recorder's new stalls to a sink in batches, at most one batch per interval.
 *
 * It has no timer of its own while nothing happens: `notify` (a stall was recorded) arms one timeout for the next
 * moment a batch may go, and a batch that was not accepted is not retried by itself. It waits for the next stall and
 * goes out with it, so a sink that is down costs one request per interval at most, and only while the page stalls.
 */
export class StallBatcher<Context> {
  private readonly send: (entries: StallEntry<Context>[]) => Promise<StallSendResult>;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private sentSeq = 0;
  private lastSend = -Infinity;
  private timer: unknown = null;
  private sending = false;
  private gone = false;
  private disposed = false;

  constructor(
    private readonly recorder: StallRecorder<Context>,
    options: StallBatcherOptions<Context>,
  ) {
    this.send = options.send;
    this.intervalMs = options.intervalMs ?? STALL_BATCH_INTERVAL_MS;
    this.maxBatch = Math.max(1, options.maxBatch ?? STALL_BATCH_SIZE);
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** Stalls recorded and not yet accepted by the sink that the ring still holds. */
  get unsent(): number {
    return this.recorder.since(this.sentSeq).length;
  }

  /** A stall was recorded: it goes out with the next batch. */
  notify(): void {
    if (this.disposed || this.gone || this.sending || this.timer !== null) return;
    const wait = Math.max(0, this.lastSend + this.intervalMs - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /**
   * The stalls not yet accepted, for a last hand-over when the page goes away (the caller sends them itself, e.g.
   * with sendBeacon); they count as sent.
   */
  takeRest(): StallEntry<Context>[] {
    if (this.gone) return [];
    const rest = this.recorder.since(this.sentSeq, this.maxBatch);
    if (rest.length) this.sentSeq = rest[rest.length - 1]!.seq;
    return rest;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.gone || this.sending) return;
    const batch = this.recorder.since(this.sentSeq, this.maxBatch);
    if (!batch.length) return;
    this.sending = true;
    this.lastSend = this.now();
    let result: StallSendResult;
    try {
      result = await this.send(batch);
    } catch {
      result = false;
    }
    this.sending = false;
    if (result === 'gone') {
      this.gone = true;
      return;
    }
    if (!result) return;
    this.sentSeq = Math.max(this.sentSeq, batch[batch.length - 1]!.seq);
    // More than a batch, or stalls recorded while this one was under way: the next batch, an interval later.
    if (this.recorder.recorded > this.sentSeq) this.notify();
  }
}
