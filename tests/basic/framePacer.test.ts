import { describe, expect, it } from 'vitest';
import { FramePacer, type WorkloadSample } from '../../src/graphics/framePacer';

/** Display frames `refreshMs` apart for `ms`: how many of them the pacer draws, and the intervals between them. */
function run(pacer: FramePacer, refreshMs: number, ms: number, from = 0) {
  const drawn: number[] = [];
  let frames = 0;
  for (let at = from; at < from + ms - 1e-6; at += refreshMs) {
    frames++;
    if (pacer.due(at)) drawn.push(at);
  }
  const intervals = drawn.slice(1).map((at, index) => at - drawn[index]!);
  return { frames, drawn: drawn.length, intervals, end: from + frames * refreshMs };
}

/** A game at slider 5: 62.5 logic frames a second asked for, one-second windows. */
const game = (
  rate: number,
  idleShare: number | null = 0,
  targetRate: number | null | undefined = 62.5,
): WorkloadSample => ({
  intervalMs: 1000,
  rate,
  targetRate,
  idleShare,
});

describe('which display frames a paced view draws', () => {
  it('draws every frame of a 60 Hz display and every second one of a 120 Hz display at the first level', () => {
    const at60 = run(new FramePacer(), 1000 / 60, 1000);
    expect(at60.drawn).toBe(at60.frames);
    const pacer = new FramePacer();
    const at120 = run(pacer, 1000 / 120, 1000);
    expect(at120.frames).toBe(120);
    expect(at120.drawn).toBe(60);
    expect(at120.intervals.every((interval) => Math.abs(interval - 1000 / 60) < 1e-6)).toBe(true);
    expect(pacer.stride).toBe(2);
    expect(pacer.pacedIntervalMs).toBeCloseTo(1000 / 60, 6);
  });

  it('never draws faster than a tenth above the level on displays that do not divide into it', () => {
    // 165 Hz: every third frame (55 a second); 144 Hz: every third (48), not every second (72).
    const p165 = new FramePacer();
    expect(run(p165, 1000 / 165, 1000).drawn).toBe(55);
    expect(p165.stride).toBe(3);
    const p144 = new FramePacer();
    expect(run(p144, 1000 / 144, 1000).drawn).toBe(48);
    expect(p144.pacedIntervalMs).toBeCloseTo(3000 / 144, 6);
  });

  it('holds lower levels in whole display frames: 40 and 30 a second on 120 Hz, 30 and 30 on 60 Hz', () => {
    const down = (pacer: FramePacer, steps: number) => {
      for (let i = 0; i < steps * 2; i++) pacer.sample(game(55));
      return pacer;
    };
    expect(run(down(new FramePacer(), 1), 1000 / 120, 3000).drawn).toBe(120);
    expect(run(down(new FramePacer(), 2), 1000 / 120, 3000).drawn).toBe(90);
    expect(run(down(new FramePacer(), 1), 1000 / 60, 3000).drawn).toBe(90);
    const last = down(new FramePacer(), 2);
    expect(run(last, 1000 / 60, 3000).drawn).toBe(90);
    expect(last.stride).toBe(2);
    expect(last.rate).toBe(30);
  });

  it('follows the time between frames, not a count: late display frames are drawn as they come', () => {
    const pacer = new FramePacer();
    // A display whose frames come 25 ms apart (a busy page): every one is due.
    const slow = run(pacer, 25, 1000);
    expect(slow.drawn).toBe(slow.frames);
    expect(pacer.stride).toBe(1);
    // The first frame after a pause, and after a clock that started over, is drawn.
    expect(pacer.due(slow.end + 5000)).toBe(true);
    expect(pacer.due(3)).toBe(true);
    expect(pacer.due(8)).toBe(false);
  });

  it('estimates the display interval from the shortest of the last frames and ignores pauses', () => {
    const pacer = new FramePacer();
    expect(pacer.refreshMs).toBeNull();
    expect(pacer.stride).toBe(1);
    expect(pacer.pacedIntervalMs).toBeNull();
    let at = 0;
    for (const interval of [8.3, 16.7, 8.4, 4000, 8.3, 25, 0.2]) pacer.due((at += interval));
    expect(pacer.refreshMs).toBeCloseTo(8.3, 6);
    // Older intervals leave the window: a display switched to 60 Hz is noticed.
    for (let i = 0; i < 40; i++) pacer.due((at += 16.7));
    expect(pacer.refreshMs).toBeCloseTo(16.7, 6);
  });

  it('holds a fixed rate when that is all it is given', () => {
    const pacer = new FramePacer({ rates: [30] });
    expect(run(pacer, 1000 / 120, 1000).drawn).toBe(30);
    for (let i = 0; i < 10; i++) pacer.sample(game(20));
    expect(pacer.level).toBe(0);
    expect(pacer.levels).toBe(1);
  });

  it('draws every 47.95 Hz refresh on target and reports the display rate rather than a 60 Hz cap', () => {
    const refresh = 1000 / 47.95;
    const pacer = new FramePacer({ sharedDrawingScheduler: false, displayRefreshMs: () => refresh });
    const steady = run(pacer, refresh, 5000);
    expect(steady.drawn).toBe(steady.frames);
    expect(pacer.rate).toBe(47.95);
    expect(pacer.stride).toBe(1);
    pacer.sample(game(40, null));
    pacer.sample(game(40, null));
    expect(pacer.stride).toBe(2);
    expect(pacer.sample(game(62.5, null))).toBe(0);
    const recovered = run(pacer, refresh, 5000, steady.end);
    expect(recovered.drawn).toBe(recovered.frames);
    expect(pacer.rate).toBe(47.95);
  });

  it('keeps the measured display reference when callbacks are missed, with shared-scheduler protection intact', () => {
    const refresh = 1000 / 47.95;
    const pacer = new FramePacer({ displayRefreshMs: () => refresh });
    run(pacer, refresh * 2, 5000);
    expect(pacer.refreshMs).toBe(refresh);
    expect(pacer.rate).toBe(47.95);
    pacer.sample(game(55));
    pacer.sample(game(55));
    expect(pacer.level).toBe(1);
    expect(pacer.stride).toBe(2);
    for (let i = 0; i < 20; i++) pacer.sample(game(62.5, 0.01));
    expect(pacer.level).toBe(1);
  });

  it('rejects rates that are not positive and descending', () => {
    expect(() => new FramePacer({ rates: [] })).toThrow(RangeError);
    expect(() => new FramePacer({ rates: [30, 60] })).toThrow(RangeError);
    expect(() => new FramePacer({ rates: [60, 0] })).toThrow(RangeError);
  });
});

describe('how the workload moves the level', () => {
  it('keeps an independent workload at the display cap when its own counters hold the target', () => {
    const pacer = new FramePacer({ sharedDrawingScheduler: false });
    for (let i = 0; i < 60; i++) expect(pacer.sample(game(62, null))).toBe(0);
    expect(run(pacer, 1000 / 60, 1000).drawn).toBe(60);
    // A real counter deficit can lower the rate, but recovery needs no emulator
    // wait measurement or eight-second trial on an independent scheduler.
    pacer.sample(game(40, null));
    expect(pacer.sample(game(40, null))).toBe(2);
    expect(pacer.sample(game(62, null))).toBe(0);
    expect(pacer.rate).toBe(60);
  });

  it('ignores emulator wait telemetry when an independent workload is actually behind', () => {
    const pacer = new FramePacer({ sharedDrawingScheduler: false });
    pacer.sample(game(55, 1));
    expect(pacer.sample(game(55, 1))).toBe(1);
    expect(pacer.sample(game(55, 1, null))).toBe(0);
  });

  it('steps down after two samples behind with no waits, one level at a time', () => {
    const pacer = new FramePacer();
    expect(pacer.sample(game(55))).toBe(0);
    expect(pacer.sample(game(55))).toBe(1);
    expect(pacer.rate).toBe(40);
    expect(pacer.sample(game(56))).toBe(1);
    expect(pacer.sample(game(56))).toBe(2);
    // The last level stays however far behind the game is.
    for (let i = 0; i < 6; i++) pacer.sample(game(20));
    expect(pacer.level).toBe(2);
  });

  it('counts a game short of its rate as behind although its thread still waits: late frames are never caught up', () => {
    // 58.5 of 62.5 with a tenth of the thread idle (frames that overrun their 16 ms tick, measured under the HD view).
    const pacer = new FramePacer();
    pacer.sample(game(58.5, 0.12));
    expect(pacer.sample(game(58.5, 0.12))).toBe(1);
  });

  it('goes straight to the last level when the game is far behind', () => {
    const pacer = new FramePacer();
    pacer.sample(game(40));
    expect(pacer.sample(game(40))).toBe(2);
  });

  it('does not count a single slow window, a game that waits, or a game on target', () => {
    const pacer = new FramePacer();
    pacer.sample(game(55));
    pacer.sample(game(62.4, 0.2));
    pacer.sample(game(55));
    expect(pacer.level).toBe(0);
    // A paused game advances nothing and waits all the time: nothing takes time from it.
    for (let i = 0; i < 5; i++) pacer.sample(game(0, 0.9));
    expect(pacer.level).toBe(0);
    // One or two frames short of 62.5 in a second is the counter's resolution, not a game behind.
    for (let i = 0; i < 5; i++) pacer.sample(game(60.5));
    expect(pacer.level).toBe(0);
  });

  it('has nothing to protect without a target: unlimited and unknown speed settings stay at the first level', () => {
    for (const target of [null, undefined, 0]) {
      const pacer = new FramePacer();
      pacer.sample(game(40));
      pacer.sample(game(40));
      expect(pacer.level).toBe(2);
      const untargeted: WorkloadSample = { intervalMs: 1000, rate: 40, targetRate: target, idleShare: 0 };
      expect(pacer.sample(untargeted)).toBe(0);
      for (let i = 0; i < 5; i++) pacer.sample(untargeted);
      expect(pacer.level).toBe(0);
    }
  });

  it('tries one level up after eight seconds of slack and keeps it when the game still holds its target', () => {
    const pacer = new FramePacer();
    pacer.sample(game(55));
    pacer.sample(game(55));
    expect(pacer.level).toBe(1);
    for (let i = 0; i < 7; i++) expect(pacer.sample(game(62.4, 0.2))).toBe(1);
    expect(pacer.sample(game(62.4, 0.2))).toBe(0);
    for (let i = 0; i < 10; i++) expect(pacer.sample(game(62.3, 0.05))).toBe(0);
  });

  it('waits for slack: a game that holds its target with nothing to spare is left alone', () => {
    const pacer = new FramePacer();
    pacer.sample(game(40));
    pacer.sample(game(40));
    for (let i = 0; i < 60; i++) pacer.sample(game(62.4, 0.05));
    expect(pacer.level).toBe(2);
    // Slack that comes and goes does not add up.
    for (let i = 0; i < 30; i++) pacer.sample(game(62.4, i % 5 === 4 ? 0.05 : 0.2));
    expect(pacer.level).toBe(2);
  });

  it('gives a level up when the game cannot afford it, then waits twice as long and asks for more slack', () => {
    const pacer = new FramePacer();
    pacer.sample(game(55));
    pacer.sample(game(55));
    const calm = (idle: number) => {
      let samples = 0;
      while (pacer.level === 1 && samples < 400) {
        pacer.sample(game(62.4, idle));
        samples++;
      }
      return samples;
    };
    // First try after 8 s; the game falls behind at once: back down on the first sample behind.
    expect(calm(0.2)).toBe(8);
    expect(pacer.sample(game(55))).toBe(1);
    // The idle share the try started from (20 %) is no longer enough: 25 % is asked for.
    for (let i = 0; i < 40; i++) pacer.sample(game(62.4, 0.2));
    expect(pacer.level).toBe(1);
    // With more slack the next try comes after 16 s, and after another failure after 32 s.
    expect(calm(0.3)).toBe(16);
    expect(pacer.sample(game(55))).toBe(1);
    expect(calm(0.4)).toBe(32);
    // This one holds for its six seconds: the wait is back to eight.
    for (let i = 0; i < 6; i++) pacer.sample(game(62.4, 0.05));
    expect(pacer.level).toBe(0);
    pacer.sample(game(55));
    pacer.sample(game(55));
    expect(pacer.level).toBe(1);
    expect(calm(0.5)).toBe(8);
  });

  it('caps the wait between tries at two minutes', () => {
    const pacer = new FramePacer();
    pacer.sample(game(55));
    pacer.sample(game(55));
    let waited = 0;
    for (let round = 0; round < 8; round++) {
      waited = 0;
      while (pacer.level === 1) {
        pacer.sample(game(62.4, 0.9));
        waited++;
      }
      pacer.sample(game(55));
    }
    expect(waited).toBe(120);
  });

  it('without a wait measurement judges by the rate alone', () => {
    const pacer = new FramePacer();
    pacer.sample(game(55, null));
    expect(pacer.sample(game(55, null))).toBe(1);
    for (let i = 0; i < 7; i++) pacer.sample(game(62.4, null));
    expect(pacer.level).toBe(1);
    expect(pacer.sample(game(62.4, null))).toBe(0);
  });

  it('starts over on reset: first level, normal wait, nothing remembered', () => {
    const pacer = new FramePacer();
    pacer.sample(game(40));
    pacer.sample(game(40));
    expect(pacer.level).toBe(2);
    pacer.reset();
    expect(pacer.level).toBe(0);
    expect(pacer.due(0)).toBe(true);
    pacer.sample(game(55));
    expect(pacer.level).toBe(0);
  });

  it('ignores windows without a length or a rate', () => {
    const pacer = new FramePacer();
    pacer.sample({ intervalMs: 0, rate: 10, targetRate: 62.5, idleShare: 0 });
    pacer.sample({ intervalMs: 1000, rate: Number.NaN, targetRate: 62.5, idleShare: 0 });
    pacer.sample(game(55));
    expect(pacer.level).toBe(0);
  });

  it('replays the same samples to the same levels', () => {
    const samples = Array.from({ length: 200 }, (_, index) =>
      game(index % 37 < 9 ? 50 : 62.4, index % 11 < 3 ? 0.02 : 0.3),
    );
    const levels = (pacer: FramePacer) => samples.map((sample) => pacer.sample(sample));
    expect(levels(new FramePacer())).toEqual(levels(new FramePacer()));
  });
});
