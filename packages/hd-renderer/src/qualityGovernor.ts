/**
 * Frame-time governor: holds a renderer on its frame budget by choosing a quality tier.
 *
 * Fed the interval between presented frames, it answers the tier to draw with: 0 is full quality, each higher tier
 * is cheaper (what a tier switches off is the renderer's business, see HdRenderer.setQualityTier). It steps down when
 * frames stay over budget and tries one tier up again after a calm stretch:
 *
 *  - Verdicts are medians over a window of frames, so a single long frame (a page arriving, a collection pause)
 *    moves nothing, and intervals longer than `gapMs` are pauses of the page, not load: they restart the window.
 *  - Down: `downWindows` windows in a row over `budgetMs * overFactor`. A display paces frames in whole refresh
 *    intervals, so a renderer that misses a 16.7 ms budget shows 25 or 33 ms: far above any sensible factor.
 *  - Up: a renderer that holds its budget is paced by the display, and its frame intervals say nothing about how
 *    much time it has left. After `calmSeconds` within budget the governor therefore simply tries the next tier up;
 *    if that goes over budget within the trial it steps back down at once and waits twice as long before the next
 *    try (up to `maxCalmSeconds`), so a scene that cannot afford the tier is not probed every few seconds. A trial
 *    that holds resets the wait.
 *
 * Time is the sum of the intervals fed in: no clock is read, and a stream of intervals replays to the same tiers.
 */
export interface QualityGovernorOptions {
  /** Number of tiers, at least 1 (then the governor never moves). */
  tiers: number;
  /** Frame time to hold, in ms. */
  budgetMs: number;
  /** A window is over budget when its median exceeds budgetMs * overFactor. Default 1.15. */
  overFactor?: number;
  /** Frames per verdict. Default 90. */
  windowFrames?: number;
  /** Over-budget windows in a row before a step down. Default 2. */
  downWindows?: number;
  /** Seconds within budget before one tier up is tried. Default 20. */
  calmSeconds?: number;
  /** Upper bound of the wait after failed tries. Default 300. */
  maxCalmSeconds?: number;
  /** Seconds a tier must hold after a step up to count as affordable. Default 6. */
  trialSeconds?: number;
  /** Intervals longer than this are pauses, not frames. Default 500. */
  gapMs?: number;
}

export class QualityGovernor {
  private readonly tiers: number;
  private readonly overMs: number;
  private readonly windowFrames: number;
  private readonly downWindows: number;
  private readonly calmMs: number;
  private readonly maxCalmMs: number;
  private readonly trialMs: number;
  private readonly gapMs: number;
  private readonly window: number[] = [];
  private current = 0;
  private over = 0;
  /** Time within budget since the last step or over-budget window. */
  private calm = 0;
  /** The wait before the next try up; doubles after a failed try. */
  private wait: number;
  /** Time left of the trial that follows a step up; 0 outside one. */
  private trial = 0;

  constructor(options: QualityGovernorOptions) {
    if (!Number.isInteger(options.tiers) || options.tiers < 1) throw new RangeError('Invalid tier count');
    if (!(options.budgetMs > 0)) throw new RangeError('Invalid frame budget');
    this.tiers = options.tiers;
    this.overMs = options.budgetMs * (options.overFactor ?? 1.15);
    this.windowFrames = Math.max(1, Math.floor(options.windowFrames ?? 90));
    this.downWindows = Math.max(1, Math.floor(options.downWindows ?? 2));
    this.calmMs = (options.calmSeconds ?? 20) * 1000;
    this.maxCalmMs = Math.max(this.calmMs, (options.maxCalmSeconds ?? 300) * 1000);
    this.trialMs = (options.trialSeconds ?? 6) * 1000;
    this.gapMs = options.gapMs ?? 500;
    this.wait = this.calmMs;
  }

  /** The tier in use. */
  get tier(): number {
    return this.current;
  }

  /** Seconds within budget still needed before the next try up (diagnostics). */
  get secondsToTrial(): number {
    return this.current === 0 ? Infinity : Math.max(0, this.wait - this.calm) / 1000;
  }

  /** Forget the frames seen so far and start at `tier` (a new match, a view shown again). */
  reset(tier = 0): void {
    this.current = Math.min(Math.max(0, Math.floor(tier)), this.tiers - 1);
    this.window.length = 0;
    this.over = 0;
    this.calm = 0;
    this.trial = 0;
    this.wait = this.calmMs;
  }

  /** One presented frame, `intervalMs` after the previous one. Answers the tier to draw the next frames with. */
  frame(intervalMs: number): number {
    if (!(intervalMs > 0) || intervalMs > this.gapMs) {
      // A pause of the page: what was measured before it no longer describes one stretch of frames.
      this.window.length = 0;
      return this.current;
    }
    this.window.push(intervalMs);
    if (this.window.length < this.windowFrames) return this.current;
    const sorted = this.window.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    let elapsed = 0;
    for (const ms of this.window) elapsed += ms;
    this.window.length = 0;
    if (median > this.overMs) {
      this.calm = 0;
      this.over++;
      // A tier that was only being tried is given up on its first window over budget.
      const failedTrial = this.trial > 0;
      if ((failedTrial || this.over >= this.downWindows) && this.current < this.tiers - 1) {
        this.current++;
        this.over = 0;
        if (failedTrial) this.wait = Math.min(this.wait * 2, this.maxCalmMs);
      }
      this.trial = 0;
      return this.current;
    }
    this.over = 0;
    if (this.trial > 0) {
      this.trial -= elapsed;
      if (this.trial <= 0) {
        // The tier holds: the next one up may be tried after the ordinary wait.
        this.trial = 0;
        this.wait = this.calmMs;
        this.calm = 0;
      }
      return this.current;
    }
    this.calm += elapsed;
    if (this.current > 0 && this.calm >= this.wait) {
      this.current--;
      this.calm = 0;
      this.trial = this.trialMs;
    }
    return this.current;
  }
}
