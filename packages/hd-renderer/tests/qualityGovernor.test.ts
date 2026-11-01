import { describe, expect, it } from 'vitest';
import { QualityGovernor } from '../src/qualityGovernor';
import session from './fixtures/ownerSessionFrames.json';

const BUDGET = 1000 / 60;
/** The bridge's margin (hdBridge.ts FRAME_BUDGET_MARGIN), also the governor's default. */
const OVER = 1.04;

/** Feed `seconds` of frames `ms` apart; the tier after each one. */
function run(governor: QualityGovernor, ms: number, seconds: number): number[] {
  const tiers: number[] = [];
  for (let t = 0; t < seconds * 1000; t += ms) tiers.push(governor.frame(ms));
  return tiers;
}
/** Feed `seconds` of frames whose interval depends on the tier in use (a scene the tiers make cheaper or not). */
function scene(governor: QualityGovernor, interval: (tier: number) => number, seconds: number): number[] {
  const tiers: number[] = [];
  for (let t = 0; t < seconds * 1000;) {
    const ms = interval(governor.tier);
    t += ms;
    tiers.push(governor.frame(ms));
  }
  return tiers;
}
/** Seconds of frames (fed by `interval`) until the governor first answers `tier`; Infinity if it never does. */
function secondsUntil(governor: QualityGovernor, tier: number, interval: (tier: number) => number, limit = 60): number {
  let elapsed = 0;
  while (elapsed < limit * 1000) {
    const ms = interval(governor.tier);
    elapsed += ms;
    if (governor.frame(ms) === tier) return elapsed / 1000;
  }
  return Infinity;
}
/** A display that paces in whole refresh intervals: every `late`-th frame takes two of them. */
function paced(late: number): () => number {
  let n = 0;
  return () => (++n % late === 0 ? 2 * BUDGET : BUDGET);
}
/** Times a tier was entered from the tier above it (a step down) in a history of tiers. */
function stepsDown(history: number[]): number {
  return history.filter((tier, i) => i > 0 && tier > history[i - 1]!).length;
}

/**
 * The owner's build 11 match of 2026-10-16 (Lost Lake, four players, 2056x1290 game frame at 1.5 device pixels per
 * CSS pixel, 120 Hz display): one row per five seconds while the HD view was shown, as the session's speed and feel
 * telemetry recorded them (fixtures/ownerSessionFrames.json). The old governor kept the view at its last tier for 143
 * of the 221 rows while frames were at 59 to 60 a second in 62 of those.
 */
type SessionRow = [string, number, number, number, number, number, number, number, number, number];
const rows = session.rows as SessionRow[];
const column = (name: string) => session.columns.indexOf(name);

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Frame intervals of one telemetry row: its frame count over its window, distributed along the row's recorded
 * percentiles (a piecewise linear quantile function through the median, p95, p99 and the longest frame, its lowest
 * point chosen so the intervals add up to the window) in a fixed shuffled order. The row keeps its frame rate and its
 * share of late frames; where in the five seconds they fell was not recorded.
 */
function rowFrames(row: SessionRow, index: number): number[] {
  const windowMs = row[column('windowMs')] as number;
  const n = row[column('frames')] as number;
  const [p50, p95, p99, max] = (['p50', 'p95', 'p99', 'max'] as const).map((name) => row[column(name)] as number);
  const mean = windowMs / n;
  const upper = (0.45 * (p50! + p95!)) / 2 + (0.04 * (p95! + p99!)) / 2 + (0.01 * (p99! + max!)) / 2;
  const lowest = Math.min(p50!, Math.max(8, 4 * (mean - upper) - p50!));
  const knots: [number, number][] = [
    [0, lowest],
    [0.5, p50!],
    [0.95, p95!],
    [0.99, p99!],
    [1, max!],
  ];
  const quantile = (u: number) => {
    for (let k = 1; k < knots.length; k++) {
      const [u0, v0] = knots[k - 1]!;
      const [u1, v1] = knots[k]!;
      if (u <= u1) return v0 + ((v1 - v0) * (u - u0)) / (u1 - u0);
    }
    return max!;
  };
  const frames = Array.from({ length: n }, (_, i) => quantile((i + 0.5) / n));
  const total = frames.reduce((sum, ms) => sum + ms, 0);
  const scaled = frames.map((ms) => (ms * windowMs) / total);
  const random = mulberry32(index + 1);
  for (let i = scaled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [scaled[i], scaled[j]] = [scaled[j]!, scaled[i]!];
  }
  return scaled;
}

/**
 * Replay the match. `cost(row, tier)` scales a row's frames at a tier (1: the frames as recorded, whatever the tier).
 * Answers the share of frame time spent at each tier, overall and within the rows `within` selects, and the tier at
 * the end of each row.
 */
function replay(
  governor: QualityGovernor,
  cost: (row: SessionRow, tier: number) => number = () => 1,
  within: (row: SessionRow) => boolean = () => false,
) {
  const time = [0, 0, 0];
  const selected = [0, 0, 0];
  const tiers: number[] = [];
  rows.forEach((row, index) => {
    for (const recorded of rowFrames(row, index)) {
      const ms = recorded * cost(row, governor.tier);
      const tier = governor.frame(ms);
      time[tier]! += ms;
      if (within(row)) selected[tier]! += ms;
    }
    tiers.push(governor.tier);
  });
  const share = (values: number[]) => {
    const total = values.reduce((sum, ms) => sum + ms, 0);
    return values.map((ms) => (total ? ms / total : 0));
  };
  return { share: share(time), within: share(selected), tiers };
}
const governed = () => new QualityGovernor({ tiers: 3, budgetMs: BUDGET, overFactor: OVER });
const fps = (row: SessionRow) => row[column('hdFps')] as number;
const time = (row: SessionRow) => row[column('time')] as string;

describe('quality governor', () => {
  it('stays at full quality while frames are on budget', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(new Set(run(governor, BUDGET, 120))).toEqual(new Set([0]));
    // A faster display (120 Hz) is on budget too.
    expect(new Set(run(governor, BUDGET / 2, 30))).toEqual(new Set([0]));
    // Timer jitter around the budget is not load.
    let flip = 1;
    for (let i = 0; i < 6000; i++) expect(governor.frame(BUDGET + (flip = -flip) * 0.4)).toBe(0);
    expect(governor.secondsToTrial).toBe(Infinity);
    expect(governor.phase).toBe('steady');
  });

  it('lets seconds of slow frames pass: only a sustained run over budget is a reason to step down', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // Two seconds at 30 frames a second (new art arriving, a burst of engine work) every ten seconds, for ten
    // minutes, with every tier as slow as the next.
    const history: number[] = [];
    for (let i = 0; i < 60; i++) {
      history.push(...run(governor, 2 * BUDGET, 2));
      history.push(...run(governor, BUDGET, 8));
    }
    expect(Math.max(...history)).toBe(0);
    // Four seconds of verdicts over budget are (the first verdict comes a second into the slow frames).
    const late = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    const seconds = secondsUntil(late, 1, () => 18.2);
    expect(seconds).toBeGreaterThan(4.4);
    expect(seconds).toBeLessThan(4.7);
  });

  it('keeps a step down that makes the frames faster, one tier at a time, and stops at the last tier', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // A view the passes cost too much for: 50 frames a second with everything, 54 at tier 1, 57.5 at tier 2.
    const cost = [20, 18.6, 17.4];
    const tiers = scene(governor, (tier) => cost[tier]!, 30);
    const first = tiers.indexOf(1);
    const second = tiers.indexOf(2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    // The first step after four seconds of verdicts over budget, the second once the first has been judged (three
    // seconds of its frames) and found to help, but not enough.
    expect(first * 20).toBeGreaterThan(4400);
    expect(first * 20).toBeLessThan(4700);
    expect(tiers.slice(second)).toEqual(new Array(tiers.length - second).fill(2));
    expect(governor.tier).toBe(2);
  });

  it('takes back a step that does not make the frames faster, and holds back the next ones', () => {
    // The owner's slow minutes: the frames are as slow at every tier (the main thread, the compositor or another
    // process holds them back, not a pass a tier gives up).
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    const history = run(governor, 20, 300);
    // At full quality for all but the few seconds each futile step is judged.
    const degraded = history.filter((tier) => tier > 0).length / history.length;
    expect(degraded).toBeLessThan(0.08);
    // Steps after 4.5 s, then after holds of 30, 60, 120 and 120 seconds: no more than six in five minutes.
    const steps = stepsDown(history);
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(steps).toBeLessThanOrEqual(6);
    expect(history.at(-1)).toBe(0);
    // Each futile step returns to the tier it came from, not further.
    expect(Math.max(...history)).toBe(1);
  });

  it('ends a hold when the frames get clearly slower than the ones the futile step was taken on', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    run(governor, 18.2, 10);
    expect(governor.tier).toBe(0);
    expect(governor.phase).toBe('holding');
    // Now a much heavier scene that the tiers do relieve: protection within a few seconds, despite the hold.
    const seconds = secondsUntil(governor, 1, (tier) => (tier === 0 ? 22 : BUDGET), 20);
    expect(seconds).toBeLessThan(4.5);
    scene(governor, (tier) => (tier === 0 ? 22 : BUDGET), 6);
    expect(governor.tier).toBe(1);
  });

  it('goes straight to the last tier when the view is far over budget and only the last tier holds', () => {
    // 38 frames a second in whole refresh intervals (more than half of the frames late) until the last tier.
    const governor = new QualityGovernor({ tiers: 4, budgetMs: BUDGET });
    let n = 0;
    const heavy = () => (++n % 5 < 3 ? 2 * BUDGET : BUDGET);
    const seconds = secondsUntil(governor, 3, (tier) => (tier < 3 ? heavy() : BUDGET));
    expect(seconds).toBeGreaterThan(4.3);
    expect(seconds).toBeLessThan(4.8);
    expect(new Set(scene(governor, (tier) => (tier < 3 ? heavy() : BUDGET), 9))).toEqual(new Set([3]));
    // 30 frames a second: the same.
    const slow = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(secondsUntil(slow, 2, (tier) => (tier < 2 ? 2 * BUDGET : BUDGET))).toBeLessThan(5);
  });

  it('counts a view that misses refreshes as over budget although its median frame is on time', () => {
    // 48 frames a second: three frames on time, one late. The median interval is the budget.
    const late4 = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    const at4 = paced(4);
    expect(secondsUntil(late4, 1, (tier) => (tier === 0 ? at4() : BUDGET))).toBeLessThan(4.8);
    // 55 frames a second (every eleventh frame late): still over.
    const late11 = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    const at11 = paced(11);
    expect(secondsUntil(late11, 1, (tier) => (tier === 0 ? at11() : BUDGET))).toBeLessThan(6);
    // One late frame in thirty (58 frames a second) is held.
    const late30 = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(secondsUntil(late30, 1, paced(30), 120)).toBe(Infinity);
  });

  it('ignores single long frames and pauses of the page', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    for (let second = 0; second < 60; second++) {
      // One 300 ms frame a second (a page arriving): left out of its window's mean.
      for (let i = 0; i < 59; i++) expect(governor.frame(BUDGET)).toBe(0);
      expect(governor.frame(300)).toBe(0);
    }
    // A stretch of slow frames cut by pauses (tab hidden, loading): every pause restarts the windows and the run.
    for (let i = 0; i < 40; i++) {
      for (let k = 0; k < 60; k++) expect(governor.frame(40)).toBe(0);
      expect(governor.frame(5000)).toBe(0);
    }
    expect(governor.frame(Number.NaN)).toBe(0);
    expect(governor.frame(0)).toBe(0);
    expect(governor.frame(-3)).toBe(0);
  });

  it('takes a verdict on at least eight frames however slow they are', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // 200 ms frames: a window is eight of them (1.6 s); a verdict is on two, and three verdicts (4.8 s) are sustained.
    const tiers = run(governor, 200, 8);
    expect(tiers.slice(0, 31)).toEqual(new Array(31).fill(0));
    expect(tiers[31]).toBe(2);
  });

  it('tries a tier up after a calm stretch, keeps it when it holds and backs off when it does not', () => {
    const options = { tiers: 3, budgetMs: BUDGET, calmSeconds: 10, trialSeconds: 4, maxCalmSeconds: 40 };
    const governor = new QualityGovernor(options);
    // A heavy stretch that only the last tier holds: down after 4.5 seconds, judged for 3.5 more.
    scene(governor, (tier) => (tier < 2 ? 33.4 : BUDGET), 9);
    expect(governor.tier).toBe(2);
    expect(governor.phase).toBe('steady');
    // On budget at tier 2: one tier up after ten seconds within budget, the next one only after the trial held and ten
    // more.
    const toTrial = governor.secondsToTrial;
    expect(toTrial).toBeGreaterThan(8);
    expect(toTrial).toBeLessThanOrEqual(10);
    const calm = run(governor, BUDGET, 40);
    const firstUp = calm.indexOf(1);
    expect(firstUp).toBeGreaterThanOrEqual(toTrial * 60 - 1);
    expect(firstUp).toBeLessThan(toTrial * 60 + 40);
    const secondUp = calm.indexOf(0);
    expect(secondUp - firstUp).toBeGreaterThanOrEqual((4 + 10) * 60 - 40);
    expect(secondUp - firstUp).toBeLessThan((4 + 10) * 60 + 120);
    expect(governor.tier).toBe(0);

    // A scene that cannot afford tier 0: 50 frames a second at 0, on budget at 1.
    const cost = (tier: number) => (tier === 0 ? 20 : BUDGET);
    scene(governor, cost, 8);
    expect(governor.tier).toBe(1);
    // Every try at tier 0 fails once its frames have been over budget for three seconds, returns to tier 1 (not
    // further down) and the waits between tries double: 10, 20, 40, 40 seconds. Nothing oscillates in between.
    const history = scene(governor, cost, 200);
    expect(Math.max(...history)).toBe(1);
    const tries: number[] = [];
    let elapsed = 0;
    const at: number[] = [];
    history.forEach((tier) => {
      at.push(elapsed);
      elapsed += tier === 0 ? 20 : BUDGET;
    });
    history.forEach((tier, i) => {
      if (tier === 0 && history[i - 1] === 1) tries.push(at[i]! / 1000);
    });
    expect(tries.length).toBeGreaterThanOrEqual(4);
    const gaps = tries.slice(1).map((seconds, i) => seconds - tries[i]!);
    // A failed try is about four seconds at tier 0 (its first window, then three seconds over budget).
    expect(gaps[0]).toBeGreaterThan(23);
    expect(gaps[0]).toBeLessThan(26);
    expect(gaps[1]).toBeGreaterThan(43);
    expect(gaps[1]).toBeLessThan(46);
    expect(gaps[2]).toBeGreaterThan(43);
    expect(gaps[2]).toBeLessThan(46);
    expect(governor.secondsToTrial).toBeLessThanOrEqual(40);

    governor.reset();
    expect(governor.tier).toBe(0);
    governor.reset(7);
    expect(governor.tier).toBe(2);
  });

  it('gives up a failed try of a far too heavy tier without falling through to the last tier', () => {
    const governor = new QualityGovernor({ tiers: 4, budgetMs: BUDGET, calmSeconds: 5, trialSeconds: 3 });
    // Tier 1 holds, tier 0 is at 30 frames a second.
    governor.reset(1);
    const history = scene(governor, (tier) => (tier === 0 ? 2 * BUDGET : BUDGET), 60);
    expect(history.includes(0)).toBe(true);
    expect(Math.max(...history)).toBe(1);
  });

  it('tries a tier up while still over budget, and keeps it once the tiers no longer make a difference', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // A GPU-heavy stretch: everything is 45 frames a second, tier 2 is 52.
    scene(governor, (tier) => [22, 20.5, 19.2][tier]!, 20);
    expect(governor.tier).toBe(2);
    // The load moves to the main thread: 52 frames a second at every tier. Within a probe (30 s) and its trial the
    // view is back to tier 1, and after the next probe to everything.
    const history = scene(governor, () => 19.2, 90);
    expect(history.at(-1)).toBe(0);
    expect(history.slice(Math.floor(history.length * 0.9)).every((tier) => tier === 0)).toBe(true);
    // While the tiers still help, the probes fail and back off.
    const helped = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    const steady = scene(helped, (tier) => [22, 20.5, 19.2][tier]!, 300);
    expect(
      steady.slice(steady.length / 3).filter((tier) => tier === 2).length / (steady.length * (2 / 3)),
    ).toBeGreaterThan(0.85);
  });

  it('replays a stream of intervals to the same tiers and rejects impossible options', () => {
    const stream: number[] = [];
    let seed = 11;
    for (let i = 0; i < 6000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      stream.push(i % 1500 < 700 ? 33.4 + (seed % 5) : BUDGET + (seed % 3) * 0.1);
    }
    const play = () => {
      const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET, calmSeconds: 5 });
      return stream.map((ms) => governor.frame(ms));
    };
    expect(play()).toEqual(play());
    expect(new Set(play()).size).toBeGreaterThan(1);
    expect(() => new QualityGovernor({ tiers: 0, budgetMs: BUDGET })).toThrow(RangeError);
    expect(() => new QualityGovernor({ tiers: 2, budgetMs: 0 })).toThrow(RangeError);
    const single = new QualityGovernor({ tiers: 1, budgetMs: BUDGET });
    expect(new Set(run(single, 50, 30))).toEqual(new Set([0]));
  });
});

describe('quality governor on the owner match of 2026-10-16', () => {
  it('rebuilds each telemetry row with its recorded frame rate', () => {
    expect(rows.length).toBe(221);
    rows.forEach((row, index) => {
      const frames = rowFrames(row, index);
      const total = frames.reduce((sum, ms) => sum + ms, 0);
      expect(Math.abs((frames.length * 1000) / total - fps(row))).toBeLessThan(0.6);
    });
    // As recorded: 143 of the rows at the last tier, 62 of those at 57 frames a second or more (45 at 59 or more).
    const last = rows.filter((row) => row[column('tier')] === 2);
    expect(last.length).toBe(143);
    expect(last.filter((row) => fps(row) >= 57).length).toBe(62);
    expect(last.filter((row) => fps(row) >= 59).length).toBe(45);
  });

  it('keeps full quality through the match when the frames are what they were at every tier', () => {
    // The recorded frames, whatever the tier: they were recorded at the last tier for most of the match, and the
    // seconds of slow frames came at every tier alike (see the rows at 03:32 to 03:34, at the last tier).
    const { share, tiers } = replay(governed());
    expect(share[0]).toBeGreaterThan(0.9);
    expect(share[2]).toBeLessThan(0.02);
    // The minutes at 59 to 60 frames a second after the slow stretch (03:34:55 to 03:37:05) are at full quality.
    const calm = rows
      .map((row, i) => [time(row), tiers[i]] as const)
      .filter(([at]) => at >= '03:34:55' && at <= '03:37:05');
    expect(calm.filter(([, tier]) => tier === 0).length / calm.length).toBeGreaterThan(0.9);
  });

  it('protects the slow minutes when they are the GPU and the tiers relieve it, and gives the look back after', () => {
    // Had the slow minutes (rows below 57 frames a second) been the GPU, with tier 0 15 % and tier 1 7 % dearer than
    // the recorded tier 2:
    const dearer = [1.15, 1.07, 1];
    const slow = (row: SessionRow) => fps(row) < 57;
    const { share, within, tiers } = replay(governed(), (row, tier) => (slow(row) ? dearer[tier]! : 1), slow);
    expect(within[0]).toBeLessThan(0.35);
    expect(within[2]).toBeGreaterThan(0.5);
    expect(share[0]).toBeGreaterThan(0.5);
    const calm = rows
      .map((row, i) => [time(row), tiers[i]] as const)
      .filter(([at]) => at >= '03:35:10' && at <= '03:37:05');
    expect(calm.filter(([, tier]) => tier === 0).length / calm.length).toBeGreaterThan(0.8);
    // A tier that buys a few per cent is not worth its look: frames 4 % and 2 % dearer keep full quality.
    const marginal = [1.04, 1.02, 1];
    const small = replay(governed(), (row, tier) => (slow(row) ? marginal[tier]! : 1));
    expect(small.share[0]).toBeGreaterThan(0.9);
  });
});
