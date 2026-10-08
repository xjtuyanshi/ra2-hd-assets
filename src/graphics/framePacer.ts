/**
 * Frame pacer: holds a view's frame rate so that it does not starve a workload it shares the machine with.
 *
 * Why it exists (measurements: docs/remaster/HD_BRIDGE.md "Frame rate"): the emulator runs on a Worker thread, which
 * the browser schedules below every thread that takes part in drawing (the page's main thread, the GPU process, the
 * compositor). A view that draws on every display frame of a 120 Hz display keeps those threads busy, and the
 * emulator then executes the same guest code at little more than half its speed: the game falls behind its own speed
 * setting although the machine has idle cores. Each frame the view does not draw is time the emulator gets back.
 *
 * Two rules, both without reading a clock (time is what the caller passes in):
 *
 *  - `due(frameTime)`: asked once per display frame, answers whether the view draws this one. A frame is due when
 *    the time since the last drawn frame has reached the level's interval within `tolerance` (10 %): on a 120 Hz
 *    display the 60 frames-a-second level draws every second display frame, the 40 level every third, the 30 level
 *    every fourth; on a 60 Hz display the levels are 60, 30 and 30. No display rate is assumed.
 *  - `sample(...)`: fed about once a second with what the workload reached (its rate against the rate it was asked
 *    for, and the share of its thread it spent waiting), moves the level. Behind its target on `behindSamples`
 *    samples in a row: one level down (straight to the last one when far behind). A game's frame limiter never
 *    catches up a late frame, so a game can be behind while its thread still waits a tenth of the time: only a
 *    workload that mostly waits (`busyIdleShare`: a paused game) is not behind whatever its rate. Holding its target
 *    with `slackShare` of its thread idle for `calmSeconds`: one level up is tried; a try the workload cannot afford
 *    is given up at the first sample behind, the wait before the next try doubles (up to `maxCalmSeconds`) and the
 *    idle share the try started from is remembered as not enough for that level (never more than
 *    `maxSlackShare`), so a scene that cannot afford more frames is not probed every few seconds. A workload without a target (an unlimited or unknown speed
 *    setting) has nothing to fall behind: the pacer returns to its first level.
 */
export interface FramePacerOptions {
  /** Whether drawing competes with the workload's scheduler. Independent workloads recover the cap on target. */
  sharedDrawingScheduler?: boolean;
  /** Frame rates the view may be held to, fastest first. Default [60, 40, 30]. */
  rates?: readonly number[];
  /** A frame is due once the level's interval divided by this has passed. Default 1.1. */
  tolerance?: number;
  /** The workload is behind when its rate is below this share of its target. Default 0.955. */
  behindShare?: number;
  /** Below this share of its target it is far behind: a step down goes to the last level. Default 0.8. */
  farBehindShare?: number;
  /** A workload that waits this share of its thread or more is not behind, whatever its rate. Default 0.5. */
  busyIdleShare?: number;
  /** Samples behind in a row before a step down. Default 2. */
  behindSamples?: number;
  /** Idle share of the workload's thread needed before a step up is tried. Default 0.1. */
  slackShare?: number;
  /** Added to the idle share a failed try started from: what the next try at that level needs. Default 0.05. */
  slackMargin?: number;
  /** No try ever needs more idle share than this, whatever failed before. Default 0.5. */
  maxSlackShare?: number;
  /** Seconds of slack before one level up is tried. Default 8. */
  calmSeconds?: number;
  /** Upper bound of that wait after failed tries. Default 120. */
  maxCalmSeconds?: number;
  /** Seconds a level must hold after a step up to count as affordable. Default 6. */
  trialSeconds?: number;
}

/** What the workload did in one window. */
export interface WorkloadSample {
  /** Length of the window in ms (on the workload's clock). */
  intervalMs: number;
  /** Rate it reached (for a game: logic frames a second). */
  rate: number;
  /** Rate it was asked for; null: no limit; undefined: unknown. */
  targetRate: number | null | undefined;
  /** Share of its thread's window spent in waits it asked for (0..1); null when not measured. */
  idleShare: number | null;
}

/** Display-frame intervals kept for the refresh estimate. */
const REFRESH_WINDOW = 32;

export class FramePacer {
  private readonly sharedDrawingScheduler: boolean;
  private readonly rates: readonly number[];
  private readonly intervals: readonly number[];
  private readonly tolerance: number;
  private readonly behindShare: number;
  private readonly farBehindShare: number;
  private readonly busyIdleShare: number;
  private readonly behindSamples: number;
  private readonly slackShare: number;
  private readonly slackMargin: number;
  private readonly maxSlackShare: number;
  private readonly calmMs: number;
  private readonly maxCalmMs: number;
  private readonly trialMs: number;
  private current = 0;
  /** Time of the last drawn frame and of the last display frame seen; null before the first. */
  private drawnAt: number | null = null;
  private seenAt: number | null = null;
  /** The last intervals between display frames (ring), for `refreshMs`. */
  private readonly seen: number[] = [];
  private seenNext = 0;
  private behindRun = 0;
  /** Time with slack since the last step or sample without it. */
  private calm = 0;
  /** The wait before the next try up; doubles after a failed try. */
  private wait: number;
  /** Time left of the trial that follows a step up; 0 outside one. */
  private trial = 0;
  /** Idle share the running trial started from. */
  private trialFrom = 0;
  /** Per level: the idle share a try for it needs (raised by failed tries). */
  private readonly needed: number[];

  constructor(options: FramePacerOptions = {}) {
    this.sharedDrawingScheduler = options.sharedDrawingScheduler ?? true;
    const rates = options.rates ?? [60, 40, 30];
    if (!rates.length || rates.some((rate, index) => !(rate > 0) || (index > 0 && rate >= rates[index - 1]!)))
      throw new RangeError('Frame rates must be positive and descending');
    this.rates = [...rates];
    this.intervals = rates.map((rate) => 1000 / rate);
    this.tolerance = Math.max(1, options.tolerance ?? 1.1);
    this.behindShare = options.behindShare ?? 0.955;
    this.farBehindShare = Math.min(this.behindShare, options.farBehindShare ?? 0.8);
    this.busyIdleShare = options.busyIdleShare ?? 0.5;
    this.behindSamples = Math.max(1, Math.floor(options.behindSamples ?? 2));
    this.slackShare = options.slackShare ?? 0.1;
    this.slackMargin = options.slackMargin ?? 0.05;
    this.maxSlackShare = Math.max(this.slackShare, options.maxSlackShare ?? 0.5);
    this.calmMs = (options.calmSeconds ?? 8) * 1000;
    this.maxCalmMs = Math.max(this.calmMs, (options.maxCalmSeconds ?? 120) * 1000);
    this.trialMs = (options.trialSeconds ?? 6) * 1000;
    this.wait = this.calmMs;
    this.needed = rates.map(() => this.slackShare);
  }

  /** The level in use: 0 is the fastest rate. */
  get level(): number {
    return this.current;
  }

  get levels(): number {
    return this.intervals.length;
  }

  /** Frame rate of the level in use (what the view is held to at most). */
  get rate(): number {
    return this.rates[this.current]!;
  }

  /** Shortest interval between display frames seen lately, or null before two were seen. */
  get refreshMs(): number | null {
    return this.seen.length ? Math.min(...this.seen) : null;
  }

  /**
   * Display frames from one drawn frame to the next while the view keeps pace: 1 means every display frame is drawn
   * (the view is not held back at all), 2 every second one, and so on. Before a display interval is known: 1.
   */
  get stride(): number {
    const refresh = this.refreshMs;
    if (refresh === null) return 1;
    // A hair below the quotient: 30.3 ms of a 165 Hz display against a 30.3 ms threshold is five frames, not six.
    return Math.max(1, Math.ceil(this.intervals[this.current]! / this.tolerance / refresh - 0.02));
  }

  /** Interval drawn frames come at while the view keeps pace (`stride` display frames), or null when unknown. */
  get pacedIntervalMs(): number | null {
    const refresh = this.refreshMs;
    return refresh === null ? null : this.stride * refresh;
  }

  /** One display frame at `frameTimeMs`: whether the view draws it. */
  due(frameTimeMs: number): boolean {
    const seenAt = this.seenAt;
    this.seenAt = frameTimeMs;
    if (seenAt !== null) {
      const interval = frameTimeMs - seenAt;
      // A pause of the page or a clock that started over says nothing about the display.
      if (interval > 1 && interval < 100) {
        this.seen[this.seenNext] = interval;
        this.seenNext = (this.seenNext + 1) % REFRESH_WINDOW;
      }
    }
    const drawnAt = this.drawnAt;
    if (
      drawnAt !== null &&
      frameTimeMs >= drawnAt &&
      frameTimeMs - drawnAt < this.intervals[this.current]! / this.tolerance
    )
      return false;
    this.drawnAt = frameTimeMs;
    return true;
  }

  /** One window of the workload. Answers the level to pace with from now on. */
  sample(sample: WorkloadSample): number {
    const { intervalMs, rate, targetRate, idleShare } = sample;
    if (!(intervalMs > 0) || !Number.isFinite(rate)) return this.current;
    if (typeof targetRate !== 'number' || !(targetRate > 0)) {
      // No limit, or unknown: there is no rate to protect.
      this.settle(0);
      return this.current;
    }
    const last = this.intervals.length - 1;
    const waiting = this.sharedDrawingScheduler && idleShare !== null && idleShare >= this.busyIdleShare;
    if (rate < targetRate * this.behindShare && !waiting) {
      this.calm = 0;
      if (this.trial > 0) {
        // The level just tried is not affordable here: back at once, and ask for more before the next try.
        this.needed[this.current] = Math.min(
          this.maxSlackShare,
          Math.max(this.needed[this.current]!, this.trialFrom + this.slackMargin),
        );
        this.wait = Math.min(this.maxCalmMs, this.wait * 2);
        this.trial = 0;
        this.behindRun = 0;
        this.current = Math.min(last, this.current + 1);
        return this.current;
      }
      if (++this.behindRun >= this.behindSamples && this.current < last) {
        this.current = rate < targetRate * this.farBehindShare ? last : this.current + 1;
        this.behindRun = 0;
      }
      return this.current;
    }
    // An independent workload does not need the drawing scheduler's measured
    // slack or an emulator trial to sustain its observed rate.
    if (!this.sharedDrawingScheduler) {
      this.settle(0);
      return this.current;
    }
    this.behindRun = 0;
    if (this.trial > 0) {
      this.trial -= intervalMs;
      if (this.trial <= 0) {
        // The try held: the next one waits the normal time again.
        this.trial = 0;
        this.wait = this.calmMs;
      }
    }
    if (this.current === 0) return this.current;
    // Without a wait measurement, a workload that holds its target is all that can be known.
    const slack = idleShare === null ? rate >= targetRate * 0.985 : idleShare >= this.needed[this.current - 1]!;
    if (!slack) {
      this.calm = 0;
      return this.current;
    }
    this.calm += intervalMs;
    if (this.calm >= this.wait) {
      this.current--;
      this.calm = 0;
      this.trial = this.trialMs;
      this.trialFrom = idleShare ?? 0;
    }
    return this.current;
  }

  /** Forget what was learned and start at the first level (another match, a view shown again). */
  reset(): void {
    this.settle(0);
    this.wait = this.calmMs;
    this.needed.fill(this.slackShare);
    this.drawnAt = null;
  }

  private settle(level: number): void {
    this.current = level;
    this.behindRun = 0;
    this.calm = 0;
    this.trial = 0;
  }
}
