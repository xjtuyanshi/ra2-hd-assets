import { describe, expect, it, vi } from 'vitest';
import { NativeMirrorPacer } from '../../../src/adapter/native/mirrorPacer';

function pacer(window: number, holdMs = 200) {
  const acks: number[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const instance = new NativeMirrorPacer({
    acknowledge: (frame) => acks.push(frame),
    window: () => window,
    holdMs,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  const fire = () => {
    const live = timers.filter((timer) => !timer.cleared);
    for (const timer of live) {
      timer.cleared = true;
      timer.callback();
    }
    return live.length;
  };
  return { instance, acks, fire };
}

describe('native mirror capture pacing', () => {
  it('keeps one capture ahead of the reader with a two-entry window', () => {
    const { instance, acks } = pacer(2);
    // Two logic frames publish while nobody reads: both credits stay withheld, so the agent stops capturing.
    instance.arrived(10, 1, true);
    instance.arrived(11, 2, true);
    expect(acks).toEqual([]);
    expect(instance.holding).toBe(2);
    // The reader uses the newest image: the older credit returns, the consumed one waits for the next capture.
    instance.consume(2);
    expect(acks).toEqual([10]);
    instance.arrived(12, 3, true);
    expect(acks).toEqual([10]);
    instance.consume(3);
    expect(acks).toEqual([10, 11]);
    // Re-reading the same image is not progress and returns nothing.
    instance.consume(3);
    expect(acks).toEqual([10, 11]);
    expect(instance.holding).toBe(1);
  });

  it('returns the consumed credit at once with a legacy single-entry window', () => {
    const { instance, acks } = pacer(1);
    instance.arrived(5, 1, true);
    expect(acks).toEqual([]);
    instance.consume(1);
    expect(acks).toEqual([5]);
    expect(instance.holding).toBe(0);
  });

  it('acknowledges incomplete publications and barriers immediately, in arrival order', () => {
    const { instance, acks } = pacer(2);
    instance.arrived(20, 1, true);
    instance.arrived(21, 2, true);
    instance.arrived(22, 2, false);
    expect(acks).toEqual([20, 21, 22]);
    instance.arrived(23, 3, true);
    instance.releaseForBarrier();
    expect(acks).toEqual([20, 21, 22, 23]);
    expect(instance.counters).toMatchObject({ held: 3, barrierReleases: 1 });
  });

  it('returns every credit after the hold limit only while readers make no progress', () => {
    const { instance, acks, fire } = pacer(2);
    instance.arrived(30, 1, true);
    instance.consume(1);
    instance.arrived(31, 2, true);
    instance.consume(2); // Progress restarts the limit; it never fires between regular reads.
    expect(acks).toEqual([30]);
    expect(fire()).toBe(1);
    expect(acks).toEqual([30, 31]);
    expect(instance.counters.holdTimeouts).toBe(1);
    expect(fire()).toBe(0);
  });

  it('forgets withheld credits of a closed connection without acknowledging them', () => {
    const { instance, acks, fire } = pacer(2);
    instance.arrived(40, 1, true);
    instance.reset();
    expect(fire()).toBe(0);
    expect(acks).toEqual([]);
    instance.arrived(41, 1, true);
    instance.consume(1);
    expect(acks).toEqual([]);
    expect(instance.holding).toBe(1);
  });

  it('uses real timers by default', () => {
    vi.useFakeTimers();
    try {
      const acks: number[] = [];
      const instance = new NativeMirrorPacer({ acknowledge: (frame) => acks.push(frame), window: () => 2, holdMs: 50 });
      instance.arrived(1, 1, true);
      vi.advanceTimersByTime(49);
      expect(acks).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(acks).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves arrival order across frame reuse and cancels old timers at barriers and teardown', () => {
    vi.useFakeTimers();
    try {
      const acks: number[] = [];
      const instance = new NativeMirrorPacer({ acknowledge: (frame) => acks.push(frame), window: () => 2, holdMs: 50 });
      instance.arrived(100, 1, true);
      instance.arrived(101, 2, true);
      instance.releaseForBarrier();
      expect(acks).toEqual([100, 101]);
      vi.advanceTimersByTime(40);
      instance.arrived(0, 3, true);
      instance.consume(3);
      vi.advanceTimersByTime(10); // The old hold timer must not return the new match's credit.
      expect(acks).toEqual([100, 101]);
      instance.arrived(1, 4, true);
      instance.consume(4);
      expect(acks).toEqual([100, 101, 0]);
      instance.consume(3); // A late read cannot rewind consumption or return a duplicate ACK.
      instance.reset();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(acks).toEqual([100, 101, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});
