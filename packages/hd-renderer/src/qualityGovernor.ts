/**
 * Frame-time governor: holds a renderer on its frame budget by choosing a quality tier.
 *
 * Fed the interval between presented frames, it answers the tier to draw with: 0 is full quality, each higher tier
 * is cheaper (what a tier switches off is the renderer's business, see HdRenderer.setQualityTier). It steps down when
 * frames stay over budget and tries one tier up again after a calm stretch:
 *
 *  - Verdicts are taken every `windowMs` of frames (half a second) on the last two windows together (one second of
 *    frames): their mean interval without the longest frames (`trim` of them, at least one). A single long frame (a
 *    page arriving, a collection pause) moves nothing, while a view that misses every tenth refresh is over budget
 *    although its median frame is on time. (A display paces frames in whole refresh intervals: a view at 48 frames
 *    a second shows three frames on time and one late, and its median never leaves the budget.) Intervals longer
 *    than `gapMs` are pauses of the page, not load: they restart the windows.
 *  - Down: a verdict over `budgetMs * overFactor`, about a second after the load rose. One tier, or straight to the
 *    last one when the verdict is over `budgetMs * heavyFactor`: a view that far from its budget needs everything
 *    the tiers can give, and a second per tier is a long time to watch it. After a step the windows start afresh,
 *    so the next verdict is on frames of the new tier only.
 *  - Up: a renderer that holds its budget is paced by the display, and its frame intervals say nothing about how
 *    much time it has left. After `calmSeconds` within budget the governor therefore simply tries the next tier up;
 *    if that goes over budget within the trial it steps back down at its first verdict over budget and waits twice
 *    as long before the next try (up to `maxCalmSeconds`), so a scene that cannot afford the tier is not probed
 *    every few seconds and the tiers do not oscillate. A trial that holds resets the wait.
 *
 * Time is the sum of the intervals fed in: no clock is read, and a stream of intervals replays to the same tiers.
 */
export interface QualityGovernorOptions {
  /** Number of tiers, at least 1 (then the governor never moves). */
  tiers: number;
  /** Frame time to hold, in ms. */
  budgetMs: number;
  /** A verdict is over budget when the trimmed mean interval exceeds budgetMs * overFactor. Default 1.04. */
  overFactor?: number;
  /** A verdict over budgetMs * heavyFactor sends a step down straight to the last tier. Default 1.5. */
  heavyFactor?: number;
  /** Length of a window, in ms of frames; a verdict is on two of them. Default 500. */
  windowMs?: number;
  /** Fewest frames of a window. Default 8. */
  minFrames?: number;
  /** Share of a verdict's longest frames left out of its mean (at least one frame). Default 0.05. */
  trim?: number;
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
  private readonly heavyMs: number;
  private readonly windowMs: number;
  private readonly minFrames: number;
  private readonly trim: number;
  private readonly calmMs: number;
  private readonly maxCalmMs: number;
  private readonly trialMs: number;
  private readonly gapMs: number;
  private window: number[] = [];
  private windowTime = 0;
  /** The window before the current one; null after a start, a step down or a pause. */
  private previous: number[] | null = null;
  private current = 0;
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
    this.overMs = options.budgetMs * (options.overFactor ?? 1.04);
    this.heavyMs = options.budgetMs * Math.max(options.heavyFactor ?? 1.5, options.overFactor ?? 1.04);
    this.windowMs = Math.max(1, options.windowMs ?? 500);
    this.minFrames = Math.max(1, Math.floor(options.minFrames ?? 8));
    this.trim = Math.min(0.5, Math.max(0, options.trim ?? 0.05));
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
    this.window = [];
    this.windowTime = 0;
    this.previous = null;
    this.calm = 0;
    this.trial = 0;
    this.wait = this.calmMs;
  }

  /** One presented frame, `intervalMs` after the previous one. Answers the tier to draw the next frames with. */
  frame(intervalMs: number): number {
    if (!(intervalMs > 0) || intervalMs > this.gapMs) {
      // A pause of the page: what was measured before it no longer describes one stretch of frames.
      this.window = [];
      this.windowTime = 0;
      this.previous = null;
      return this.current;
    }
    this.window.push(intervalMs);
    this.windowTime += intervalMs;
    if (this.windowTime < this.windowMs || this.window.length < this.minFrames) return this.current;
    const elapsed = this.windowTime;
    const frames = this.window;
    const before = this.previous;
    this.window = [];
    this.windowTime = 0;
    this.previous = frames;
    // The first window after a start, a step down or a pause: no verdict on half the frames.
    if (!before) return this.current;
    const sorted = before.concat(frames).sort((a, b) => a - b);
    const kept = sorted.length - Math.max(1, Math.floor(sorted.length * this.trim));
    let sum = 0;
    for (let i = 0; i < kept; i++) sum += sorted[i]!;
    const mean = sum / kept;
    if (mean > this.overMs) {
      this.calm = 0;
      // A tier that was only being tried is given up on its first verdict over budget.
      const failedTrial = this.trial > 0;
      if (this.current < this.tiers - 1) {
        // A failed trial returns to the tier that held; otherwise far over budget takes every tier at once.
        this.current = mean > this.heavyMs && !failedTrial ? this.tiers - 1 : this.current + 1;
        if (failedTrial) this.wait = Math.min(this.wait * 2, this.maxCalmMs);
        this.previous = null;
      }
      this.trial = 0;
      return this.current;
    }
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
