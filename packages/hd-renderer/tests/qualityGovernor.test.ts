import { describe, expect, it } from 'vitest';
import { QualityGovernor } from '../src/qualityGovernor';

const BUDGET = 1000 / 60;
/** Feed `seconds` of frames `ms` apart; the tier after each one. */
function run(governor: QualityGovernor, ms: number, seconds: number): number[] {
  const tiers: number[] = [];
  for (let t = 0; t < seconds * 1000; t += ms) tiers.push(governor.frame(ms));
  return tiers;
}

describe('quality governor', () => {
  it('stays at full quality while frames are on budget', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET });
    expect(new Set(run(governor, BUDGET, 120))).toEqual(new Set([0]));
    // A faster display (120 Hz) is on budget too.
    expect(new Set(run(governor, BUDGET / 2, 30))).toEqual(new Set([0]));
    expect(governor.secondsToTrial).toBe(Infinity);
  });

  it('steps down after two windows over budget, one tier at a time, and stops at the last tier', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET, windowFrames: 60 });
    // 25 ms frames (the next refresh interval of a 120 Hz display after 16.7 ms).
    const tiers = run(governor, 25, 12);
    // Nothing during the first window, nothing after one window, down after the second.
    expect(tiers[58]).toBe(0);
    expect(tiers[59]).toBe(0);
    expect(tiers[118]).toBe(0);
    expect(tiers[119]).toBe(1);
    expect(tiers[239]).toBe(2);
    expect(tiers.at(-1)).toBe(2);
    expect(Math.max(...tiers)).toBe(2);
  });

  it('ignores single long frames and pauses of the page', () => {
    const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET, windowFrames: 60 });
    for (let second = 0; second < 60; second++) {
      // One 300 ms frame a second (a page arriving): the median does not move.
      for (let i = 0; i < 59; i++) expect(governor.frame(BUDGET)).toBe(0);
      expect(governor.frame(300)).toBe(0);
    }
    // A stretch of slow frames cut by pauses (tab hidden, loading): every pause restarts the window.
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < 50; k++) expect(governor.frame(40)).toBe(0);
      expect(governor.frame(5000)).toBe(0);
    }
    expect(governor.frame(Number.NaN)).toBe(0);
    expect(governor.frame(0)).toBe(0);
    expect(governor.frame(-3)).toBe(0);
  });

  it('tries a tier up after a calm stretch, keeps it when it holds and backs off when it does not', () => {
    const options = {
      tiers: 3,
      budgetMs: BUDGET,
      windowFrames: 60,
      calmSeconds: 10,
      trialSeconds: 4,
      maxCalmSeconds: 40,
    };
    const governor = new QualityGovernor(options);
    run(governor, 33.4, 12);
    expect(governor.tier).toBe(2);
    // On budget at tier 2: one tier up after ten seconds, the next one only after the trial held and ten more.
    // (Long enough for the second trial to finish: a tier given up while on trial doubles the wait, see below.)
    const calm = run(governor, BUDGET, 40);
    const firstUp = calm.indexOf(1);
    expect(firstUp).toBeGreaterThanOrEqual(600 - 1);
    expect(firstUp).toBeLessThan(600 + 60);
    const secondUp = calm.indexOf(0);
    expect(secondUp - firstUp).toBeGreaterThanOrEqual((4 + 10) * 60 - 60);
    expect(secondUp - firstUp).toBeLessThan((4 + 10) * 60 + 180);
    expect(governor.tier).toBe(0);

    // A scene that cannot afford tier 0: over budget at 0, on budget at 1.
    const scene = (frames: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < frames; i++) out.push(governor.frame(governor.tier === 0 ? 33.4 : BUDGET));
      return out;
    };
    scene(240);
    expect(governor.tier).toBe(1);
    // Every try at tier 0 fails within one window, and the waits between tries double: 10, 20, 40, 40 seconds.
    const history = scene(60 * 200);
    const tries: number[] = [];
    history.forEach((tier, i) => {
      if (tier === 0 && history[i - 1] === 1) tries.push(i);
    });
    expect(tries.length).toBeGreaterThanOrEqual(4);
    const gaps = tries.slice(1).map((at, i) => (at - tries[i]!) / 60);
    expect(gaps[0]).toBeGreaterThan(18);
    expect(gaps[0]).toBeLessThan(24);
    expect(gaps[1]).toBeGreaterThan(38);
    expect(gaps[1]).toBeLessThan(44);
    expect(gaps[2]).toBeGreaterThan(38);
    expect(gaps[2]).toBeLessThan(44);
    // Tier 0 is on screen for one window per try (33.4 ms frames: two seconds), never longer.
    const atZero = history.filter((tier) => tier === 0).length;
    expect(atZero).toBeLessThanOrEqual(tries.length * 60);
    expect(governor.secondsToTrial).toBeLessThanOrEqual(40);

    governor.reset();
    expect(governor.tier).toBe(0);
    governor.reset(7);
    expect(governor.tier).toBe(2);
  });

  it('replays a stream of intervals to the same tiers and rejects impossible options', () => {
    const stream: number[] = [];
    let seed = 11;
    for (let i = 0; i < 6000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      stream.push(i % 1500 < 700 ? 33.4 + (seed % 5) : BUDGET + (seed % 3) * 0.1);
    }
    const play = () => {
      const governor = new QualityGovernor({ tiers: 3, budgetMs: BUDGET, windowFrames: 45, calmSeconds: 5 });
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
