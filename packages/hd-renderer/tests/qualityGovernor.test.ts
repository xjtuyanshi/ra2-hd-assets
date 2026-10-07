import { describe, expect, it } from 'vitest';
import { QualityGovernor } from '../src/qualityGovernor';

const BUDGET = 1000 / 60;
/** Feed `seconds` of frames `ms` apart; the tier after each one. */
function run(governor: QualityGovernor, ms: number, seconds: number): number[] {
  const tiers: number[] = [];
  for (let t = 0; t < seconds * 1000; t += ms) tiers.push(governor.frame(ms));
  return tiers;
}
/** Seconds of frames (fed by `interval`) until the governor first answers `tier`; Infinity if it never does. */
function secondsUntil(governor: QualityGovernor, tier: number, interval: () => number, limit = 60): number {
  let elapsed = 0;
  while (elapsed < limit * 1000) {
    const ms = interval();
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
  });

  it('steps down one tier after a second over budget and stops at the last tier', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // A steady 18.2 ms (55 frames a second, as a browser paces a view just short of time): over, but not far over.
    const tiers = run(governor, 18.2, 4);
    const first = tiers.indexOf(1);
    const second = tiers.indexOf(2);
    // A verdict is on two half-second windows: the first step after about one second, the second after about two.
    expect(first * 18.2).toBeGreaterThan(900);
    expect(first * 18.2).toBeLessThan(1150);
    expect(second * 18.2).toBeGreaterThan(1900);
    expect(second * 18.2).toBeLessThan(2250);
    expect(tiers.at(-1)).toBe(2);
    expect(Math.max(...tiers)).toBe(2);
  });

  it('goes straight to the last tier when the view is far over budget', () => {
    // 38 frames a second in whole refresh intervals (more than half of the frames late), as a big battle at full
    // quality used to show for twelve seconds.
    const governor = new QualityGovernor({ tiers: 4, budgetMs: BUDGET });
    let n = 0;
    const seconds = secondsUntil(governor, 3, () => (++n % 5 < 3 ? 2 * BUDGET : BUDGET));
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.3);
    // 30 frames a second: the same.
    const slow = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(secondsUntil(slow, 2, () => 2 * BUDGET)).toBeLessThan(1.3);
  });

  it('counts a view that misses refreshes as over budget although its median frame is on time', () => {
    // 48 frames a second: three frames on time, one late. The median interval is the budget.
    const late4 = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(secondsUntil(late4, 1, paced(4))).toBeLessThan(1.3);
    // 55 frames a second (every eleventh frame late): still over.
    const late11 = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(secondsUntil(late11, 1, paced(11))).toBeLessThan(2.5);
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
    // A stretch of slow frames cut by pauses (tab hidden, loading): every pause restarts the window.
    for (let i = 0; i < 40; i++) {
      for (let k = 0; k < 10; k++) expect(governor.frame(40)).toBe(0);
      expect(governor.frame(5000)).toBe(0);
    }
    expect(governor.frame(Number.NaN)).toBe(0);
    expect(governor.frame(0)).toBe(0);
    expect(governor.frame(-3)).toBe(0);
  });

  it('takes a verdict on at least eight frames however slow they are', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    // 200 ms frames: a window is eight of them (1.6 s), two windows are needed.
    const tiers = run(governor, 200, 4);
    expect(tiers.slice(0, 15)).toEqual(new Array(15).fill(0));
    expect(tiers[15]).toBe(2);
  });

  it('tries a tier up after a calm stretch, keeps it when it holds and backs off when it does not', () => {
    const options = { tiers: 3, budgetMs: BUDGET, calmSeconds: 10, trialSeconds: 4, maxCalmSeconds: 40 };
    const governor = new QualityGovernor(options);
    run(governor, 33.4, 3);
    expect(governor.tier).toBe(2);
    // On budget at tier 2: one tier up after ten seconds, the next one only after the trial held and ten more.
    const calm = run(governor, BUDGET, 40);
    const firstUp = calm.indexOf(1);
    expect(firstUp).toBeGreaterThanOrEqual(600 - 1);
    expect(firstUp).toBeLessThan(600 + 40);
    const secondUp = calm.indexOf(0);
    expect(secondUp - firstUp).toBeGreaterThanOrEqual((4 + 10) * 60 - 40);
    expect(secondUp - firstUp).toBeLessThan((4 + 10) * 60 + 80);
    expect(governor.tier).toBe(0);

    // A scene that cannot afford tier 0: a little over budget at 0, on budget at 1.
    const scene = (frames: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < frames; i++) out.push(governor.frame(governor.tier === 0 ? 18.2 : BUDGET));
      return out;
    };
    scene(120);
    expect(governor.tier).toBe(1);
    // Every try at tier 0 fails at its first verdict, returns to tier 1 (not further down) and the waits between
    // tries double: 10, 20, 40, 40 seconds. Nothing oscillates in between.
    const history = scene(60 * 200);
    expect(Math.max(...history)).toBe(1);
    const tries: number[] = [];
    history.forEach((tier, i) => {
      if (tier === 0 && history[i - 1] === 1) tries.push(i);
    });
    expect(tries.length).toBeGreaterThanOrEqual(4);
    const gaps = tries.slice(1).map((at, i) => (at - tries[i]!) / 60);
    expect(gaps[0]).toBeGreaterThan(19);
    expect(gaps[0]).toBeLessThan(23);
    expect(gaps[1]).toBeGreaterThan(39);
    expect(gaps[1]).toBeLessThan(43);
    expect(gaps[2]).toBeGreaterThan(39);
    expect(gaps[2]).toBeLessThan(43);
    // Tier 0 is on screen for one verdict per try (about a second), never longer.
    const atZero = history.filter((tier) => tier === 0).length;
    expect(atZero).toBeLessThanOrEqual(tries.length * 64);
    expect(governor.secondsToTrial).toBeLessThanOrEqual(40);

    governor.reset();
    expect(governor.tier).toBe(0);
    governor.reset(7);
    expect(governor.tier).toBe(2);
  });

  it('gives up a failed try of a far too heavy tier without falling through to the last tier', () => {
    const governor = new QualityGovernor({ tiers: 4, budgetMs: BUDGET, calmSeconds: 5, trialSeconds: 3 });
    // Tier 1 holds, tier 0 is at 30 frames a second.
    const scene = (frames: number) => {
      const out: number[] = [];
      for (let i = 0; i < frames; i++) out.push(governor.frame(governor.tier === 0 ? 2 * BUDGET : BUDGET));
      return out;
    };
    governor.reset(1);
    const history = scene(60 * 60);
    expect(history.includes(0)).toBe(true);
    expect(Math.max(...history)).toBe(1);
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
