/**
 * Frame-time governor: holds a renderer on its frame budget by choosing a quality tier.
 *
 * Fed the interval between presented frames, it answers the tier to draw with: 0 is full quality, each higher tier
 * is cheaper (what a tier switches off is the renderer's business, see HdRenderer.setQualityTier). A tier is given up
 * only while frames stay over budget and giving it up measurably helps; it is taken back after a calm stretch.
 *
 *  - Verdicts are taken every `windowMs` of frames (half a second) on the last two windows together (one second of
 *    frames): their mean interval without the longest frames (`trim` of them, at least one). A single long frame (a
 *    page arriving, a collection pause) moves nothing, while a view that misses every tenth refresh is over budget
 *    although its median frame is on time. (A display paces frames in whole refresh intervals: a view at 48 frames
 *    a second shows three frames on time and one late, and its median never leaves the budget.) Intervals longer
 *    than `gapMs` are pauses of the page, not load: they restart the windows.
 *  - Sustained, not transient: a step down needs verdicts over `budgetMs * overFactor` without a break for
 *    `sustainSeconds` (a verdict covers a second, so up to about three seconds of slow frames never move a tier).
 *    A second or two of slow frames (new art arriving, a burst of engine work, the compositor busy) shows at every
 *    tier alike, and answering each one with a cheaper tier, then waiting ever longer before trying the tier again,
 *    kept a 2026-10 owner match at its last tier for two thirds of the match (tests/qualityGovernor.test.ts replays
 *    it). One tier down, or straight to the last one when the sustained frames are over `budgetMs * heavyFactor`.
 *  - Effective, not hopeful: after a step down the frames of the new tier are judged for `checkSeconds`. Unless they
 *    are within budget or at least `gainShare` shorter than the frames that caused the step, the passes the step gave
 *    up were not what held the frames back (the main thread, the compositor or another process was): the governor
 *    returns to the tier it came from and takes no step down for `holdSeconds` (doubling after each futile step, up
 *    to `maxCalmSeconds`), unless the frames get clearly slower than the ones the futile step was taken on.
 *  - Up: a renderer that holds its budget is paced by the display, and its frame intervals say nothing about how
 *    much time it has left. After `calmSeconds` of verdicts within budget (a short run over budget pauses the count,
 *    a sustained one restarts it) the governor tries the next tier up. A tier still over budget is tried again as
 *    well, after `probeSeconds` at it: the load that made it necessary may be gone, or may never have been the GPU's.
 *    A try fails when its frames stay over budget for `sustainSeconds`, or are over budget over the whole trial, and
 *    are also `gainShare` slower than at the tier below; it then returns there and the wait before the next try
 *    doubles (up to `maxCalmSeconds`). A try that holds for `trialSeconds` resets the waits. A try from a tier over
 *    budget that holds says the tiers are not what holds the frames back now: it counts as a futile step (a hold)
 *    and the next tier up is tried at once.
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
  /** A sustained run over budgetMs * heavyFactor sends a step down straight to the last tier. Default 1.5. */
  heavyFactor?: number;
  /** Length of a window, in ms of frames; a verdict is on two of them. Default 500. */
  windowMs?: number;
  /** Fewest frames of a window. Default 8. */
  minFrames?: number;
  /** Share of a verdict's longest frames left out of its mean (at least one frame). Default 0.05. */
  trim?: number;
  /** Seconds of verdicts over budget without a break before a step down (or before a try fails). Default 4. */
  sustainSeconds?: number;
  /** Seconds the frames of a lower tier are judged after a step down. Default 3. */
  checkSeconds?: number;
  /** Share by which a cheaper tier must shorten the frames to count as worth its look. Default 0.06. */
  gainShare?: number;
  /** Seconds without a step down after a step that did not help (doubles, up to maxCalmSeconds). Default 30. */
  holdSeconds?: number;
  /** Seconds within budget before one tier up is tried. Default 10. */
  calmSeconds?: number;
  /** Seconds at a tier that is still over budget before one tier up is tried anyway. Default 30. */
  probeSeconds?: number;
  /** Upper bound of the waits after failed tries and futile steps. Default 120. */
  maxCalmSeconds?: number;
  /** Seconds a tier must hold after a step up to count as affordable. Default 6. */
  trialSeconds?: number;
  /** Intervals longer than this are pauses, not frames. Default 500. */
  gapMs?: number;
}

/** What the governor is doing (diagnostics). */
export type QualityGovernorPhase = 'steady' | 'checking' | 'trying' | 'holding';

/** Frames of a step being judged: the mean the step was taken on and the verdicts since. */
interface Judgement {
  /** Tier to return to when the judgement goes against the step. */
  from: number;
  /** Mean interval the comparison is with (before a step down; at the tier below for a try up). */
  reference: number;
  /** Verdict time still to judge, in ms. */
  remaining: number;
  sum: number;
  count: number;
}

export class QualityGovernor {
  private readonly tiers: number;
  private readonly overMs: number;
  private readonly heavyMs: number;
  private readonly windowMs: number;
  private readonly minFrames: number;
  private readonly trim: number;
  private readonly sustainMs: number;
  private readonly checkMs: number;
  private readonly gain: number;
  private readonly holdMs: number;
  private readonly calmMs: number;
  private readonly probeMs: number;
  private readonly maxCalmMs: number;
  private readonly trialMs: number;
  private readonly gapMs: number;
  private window: number[] = [];
  private windowTime = 0;
  /** The window before the current one; null after a start, a step or a pause. */
  private previous: number[] | null = null;
  private current = 0;
  /** Verdict time over budget without a break, and the sum and count of those verdicts' means. */
  private overRun = 0;
  private overSum = 0;
  private overCount = 0;
  /** Verdict time within budget at this tier since the last step or sustained run over budget. */
  private calm = 0;
  /** Verdict time at this tier since the last step. */
  private atTier = 0;
  /** Within-budget verdict time since the last sustained run over budget (restores the hold length). */
  private quiet = 0;
  /** The calm needed before the next try up; doubles after a failed try. */
  private wait: number;
  /** Time at a tier over budget before the next try up; doubles after a failed try. */
  private probeWait: number;
  /** Judgement of the last step down, or null. */
  private check: Judgement | null = null;
  /** Judgement of the last step up, or null. */
  private trial: Judgement | null = null;
  /** Time left during which steps down are not taken (after a futile one), and the next hold's length. */
  private hold = 0;
  private holdNext: number;
  /** Mean interval of the last futile step: frames clearly slower than this end the hold. */
  private futileMean = Infinity;

  constructor(options: QualityGovernorOptions) {
    if (!Number.isInteger(options.tiers) || options.tiers < 1) throw new RangeError('Invalid tier count');
    if (!(options.budgetMs > 0)) throw new RangeError('Invalid frame budget');
    this.tiers = options.tiers;
    this.overMs = options.budgetMs * (options.overFactor ?? 1.04);
    this.heavyMs = options.budgetMs * Math.max(options.heavyFactor ?? 1.5, options.overFactor ?? 1.04);
    this.windowMs = Math.max(1, options.windowMs ?? 500);
    this.minFrames = Math.max(1, Math.floor(options.minFrames ?? 8));
    this.trim = Math.min(0.5, Math.max(0, options.trim ?? 0.05));
    this.sustainMs = Math.max(0, (options.sustainSeconds ?? 4) * 1000);
    this.checkMs = Math.max(0, (options.checkSeconds ?? 3) * 1000);
    this.gain = Math.max(0, options.gainShare ?? 0.06);
    this.calmMs = (options.calmSeconds ?? 10) * 1000;
    this.maxCalmMs = Math.max(this.calmMs, (options.maxCalmSeconds ?? 120) * 1000);
    this.holdMs = Math.min(this.maxCalmMs, (options.holdSeconds ?? 30) * 1000);
    this.probeMs = Math.min(this.maxCalmMs, (options.probeSeconds ?? 30) * 1000);
    this.trialMs = (options.trialSeconds ?? 6) * 1000;
    this.gapMs = options.gapMs ?? 500;
    this.wait = this.calmMs;
    this.probeWait = this.probeMs;
    this.holdNext = this.holdMs;
  }

  /** The tier in use. */
  get tier(): number {
    return this.current;
  }

  /** What the governor is doing: judging a step down or a try up, holding back steps down, or neither. */
  get phase(): QualityGovernorPhase {
    if (this.check) return 'checking';
    if (this.trial) return 'trying';
    return this.hold > 0 ? 'holding' : 'steady';
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
    this.endRun();
    this.calm = 0;
    this.atTier = 0;
    this.quiet = 0;
    this.check = null;
    this.trial = null;
    this.hold = 0;
    this.futileMean = Infinity;
    this.wait = this.calmMs;
    this.probeWait = this.probeMs;
    this.holdNext = this.holdMs;
  }

  /** One presented frame, `intervalMs` after the previous one. Answers the tier to draw the next frames with. */
  frame(intervalMs: number): number {
    if (!(intervalMs > 0) || intervalMs > this.gapMs) {
      // A pause of the page: what was measured before it no longer describes one stretch of frames.
      this.window = [];
      this.windowTime = 0;
      this.previous = null;
      this.endRun();
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
    // The first window after a start, a step or a pause: no verdict on half the frames.
    if (!before) return this.current;
    const sorted = before.concat(frames).sort((a, b) => a - b);
    const kept = sorted.length - Math.max(1, Math.floor(sorted.length * this.trim));
    let sum = 0;
    for (let i = 0; i < kept; i++) sum += sorted[i]!;
    this.verdict(sum / kept, elapsed);
    return this.current;
  }

  /** One verdict: the trimmed mean interval of the last second of frames, `elapsed` ms after the previous one. */
  private verdict(mean: number, elapsed: number): void {
    this.hold = Math.max(0, this.hold - elapsed);
    const over = mean > this.overMs;
    if (over) {
      this.overRun += elapsed;
      this.overSum += mean;
      this.overCount++;
    } else {
      this.endRun();
      this.quiet += elapsed;
      // A long calm stretch: a futile step found earlier no longer says anything about the scene.
      if (this.quiet >= this.maxCalmMs) this.holdNext = this.holdMs;
    }
    const sustained = this.overRun >= this.sustainMs;
    if (sustained) this.quiet = 0;

    const check = this.check;
    if (check) {
      // Nothing else is decided while the step down is judged: its frames are what the judgement is on.
      check.sum += mean;
      check.count++;
      check.remaining -= elapsed;
      if (check.remaining > 0) return;
      this.check = null;
      const after = check.sum / check.count;
      if (after > this.overMs && after * (1 + this.gain) > check.reference) {
        // The cheaper tier is not faster: what holds the frames back is not what it gives up.
        this.futileMean = check.reference;
        this.hold = this.holdNext;
        this.holdNext = Math.min(this.holdNext * 2, this.maxCalmMs);
        this.step(check.from);
        return;
      }
      // It helps. A run over budget that goes on at this tier counts from here (the next step needs its own).
    }

    const trial = this.trial;
    if (trial) {
      trial.sum += mean;
      trial.count++;
      trial.remaining -= elapsed;
      // A try from a tier within budget fails as soon as it runs over budget: allowing the gain margin there
      // would keep a tier that is slightly over budget and repeat the down-check-up cycle forever. A probe
      // from a tier over budget fails only when it is also slower than that tier.
      const probe = trial.reference > this.overMs;
      const worse = (value: number) =>
        probe ? value > Math.max(this.overMs, trial.reference * (1 + this.gain)) : value > this.overMs;
      if (
        (sustained && worse(this.overSum / this.overCount)) ||
        (trial.remaining <= 0 && worse(trial.sum / trial.count))
      ) {
        this.trial = null;
        if (trial.reference > this.overMs) this.probeWait = Math.min(this.probeWait * 2, this.maxCalmMs);
        else this.wait = Math.min(this.wait * 2, this.maxCalmMs);
        this.step(trial.from);
        return;
      }
      if (trial.remaining > 0) return;
      // The tier holds: the next one up may be tried after the ordinary waits.
      this.trial = null;
      this.wait = this.calmMs;
      this.probeWait = this.probeMs;
      this.calm = 0;
      this.atTier = 0;
      if (trial.reference > this.overMs) {
        // A try from a tier over budget that is no slower than that tier: the tiers are not what holds the frames
        // back now. As after a futile step, no step down for a while, and the next tier up is tried at once.
        const mean = trial.sum / trial.count;
        this.futileMean = Math.max(trial.reference, mean);
        this.hold = this.holdNext;
        this.holdNext = Math.min(this.holdNext * 2, this.maxCalmMs);
        if (this.current > 0) this.tryUp(mean);
      }
      return;
    }

    if (sustained && this.current < this.tiers - 1) {
      const run = this.overSum / this.overCount;
      // After a futile step only frames clearly slower than the ones it was taken on are a new reason to step.
      if (this.hold === 0 || run > this.futileMean * (1 + 2 * this.gain)) {
        const from = this.current;
        this.step(run > this.heavyMs ? this.tiers - 1 : this.current + 1);
        this.check = { from, reference: run, remaining: this.checkMs, sum: 0, count: 0 };
        return;
      }
    }

    if (this.current === 0) return;
    this.atTier += elapsed;
    if (sustained) this.calm = 0;
    else if (!over) this.calm += elapsed;
    if (this.calm >= this.wait) {
      this.tryUp(mean);
    } else if (sustained && this.atTier >= this.probeWait) {
      this.tryUp(this.overSum / this.overCount);
    }
  }

  /** One tier up on trial, compared with `reference`: the mean interval at the tier it leaves. */
  private tryUp(reference: number): void {
    const from = this.current;
    this.step(this.current - 1);
    this.trial = { from, reference, remaining: this.trialMs, sum: 0, count: 0 };
  }

  /** Draw with `tier` from now on: what was measured belongs to the tier left. */
  private step(tier: number): void {
    this.current = tier;
    this.previous = null;
    this.window = [];
    this.windowTime = 0;
    this.endRun();
    this.calm = 0;
    this.atTier = 0;
  }

  private endRun(): void {
    this.overRun = 0;
    this.overSum = 0;
    this.overCount = 0;
  }
}
