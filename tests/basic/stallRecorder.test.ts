import { describe, expect, it, vi } from 'vitest';
import {
  LongTaskLog,
  STALL_BATCH_INTERVAL_MS,
  STALL_CAPACITY,
  STALL_THRESHOLD_MS,
  StallBatcher,
  StallRecorder,
  type StallEntry,
  type StallSendResult,
} from '../../src/utils/stallRecorder';

/** A recorder whose context is the gap it was asked to describe, on a fixed wall clock. */
function recorder(options: { thresholdMs?: number; capacity?: number } = {}) {
  const describe = vi.fn((from: number, to: number) => ({ from, to }));
  const onStall = vi.fn();
  const stalls = new StallRecorder({ ...options, describe, onStall, wallClock: () => 1_700_000_000_000 });
  /** Present frames at these times. */
  const frames = (...times: number[]) => times.forEach((time) => stalls.frame(time));
  return { stalls, describe, onStall, frames };
}

describe('stall recorder: which frames count', () => {
  it('records a frame more than 150 ms after the one before it, and nothing else', () => {
    const r = recorder();
    expect(r.stalls.thresholdMs).toBe(STALL_THRESHOLD_MS);
    expect(STALL_THRESHOLD_MS).toBe(150);
    // The first frame starts the measurement; 16.7 ms frames and one of exactly 150 ms are no stalls.
    r.frames(1000, 1016.7, 1033.4, 1183.4);
    expect(r.stalls.recorded).toBe(0);
    // An ordinary frame asks for nothing: no description, no callback.
    expect(r.describe).not.toHaveBeenCalled();
    r.frames(1333.5);
    expect(r.stalls.recorded).toBe(1);
    expect(r.describe).toHaveBeenCalledTimes(1);
    expect(r.describe).toHaveBeenCalledWith(1183.4, 1333.5);
    const [entry] = r.stalls.entries();
    expect(entry).toMatchObject({ seq: 1, at: 1_700_000_000_000, from: 1183.4, to: 1333.5 });
    expect(entry!.gapMs).toBeCloseTo(150.1, 6);
    expect(entry!.context).toEqual({ from: 1183.4, to: 1333.5 });
    expect(r.onStall).toHaveBeenCalledWith(entry);
    // The frame after a late one is measured from the late one, not from before the gap.
    r.frames(1350);
    expect(r.stalls.recorded).toBe(1);
  });

  it('takes another threshold, and does not measure across a loop that was stopped on purpose', () => {
    const r = recorder({ thresholdMs: 40 });
    r.frames(0, 41);
    expect(r.stalls.recorded).toBe(1);
    r.stalls.skip();
    // Ten seconds later: the loop was not running, so this is no stall; the next gap counts again.
    r.frames(10_000, 10_016, 10_100);
    expect(r.stalls.recorded).toBe(2);
    expect(r.stalls.entries()[1]).toMatchObject({ from: 10_016, to: 10_100 });
  });

  it('ignores a clock that goes backwards', () => {
    const r = recorder();
    r.frames(5000, 4000, 4010);
    expect(r.stalls.recorded).toBe(0);
  });
});

describe('stall recorder: the ring', () => {
  it('holds the last 500 stalls by default and numbers every one', () => {
    const r = recorder();
    expect(r.stalls.capacity).toBe(STALL_CAPACITY);
    expect(STALL_CAPACITY).toBe(500);
    for (let i = 0; i <= 520; i++) r.stalls.frame(i * 1000);
    expect(r.stalls.recorded).toBe(520);
    const held = r.stalls.entries();
    expect(held).toHaveLength(500);
    // Oldest first; the first twenty were overwritten.
    expect(held[0]!.seq).toBe(21);
    expect(held.at(-1)!.seq).toBe(520);
    expect(held.every((entry, i) => entry.seq === 21 + i)).toBe(true);
    expect(held[0]!.to).toBe(21_000);
  });

  it('hands out the stalls after a number, oldest first, as many as asked for', () => {
    const r = recorder({ capacity: 4 });
    for (let i = 0; i <= 6; i++) r.stalls.frame(i * 1000);
    expect(r.stalls.entries().map((entry) => entry.seq)).toEqual([3, 4, 5, 6]);
    expect(r.stalls.since(4).map((entry) => entry.seq)).toEqual([5, 6]);
    expect(r.stalls.since(6)).toEqual([]);
    // What was asked for is no longer held: the oldest that is.
    expect(r.stalls.since(0, 2).map((entry) => entry.seq)).toEqual([3, 4]);
    expect(new StallRecorder({ capacity: 0, describe: () => null }).capacity).toBe(1);
  });
});

describe('long tasks under a gap', () => {
  it('adds up the part of each task that lies inside the gap', () => {
    const log = new LongTaskLog();
    log.add(100, 80); // 100..180
    log.add(300, 400); // 300..700
    log.add(900, 60); // 900..960
    expect(log.overlap(0, 50)).toBe(0);
    expect(log.overlap(150, 350)).toBe(30 + 50);
    expect(log.overlap(0, 1000)).toBe(540);
    expect(log.overlap(400, 500)).toBe(100);
    // Never more than the gap itself.
    expect(log.overlap(500, 400)).toBe(0);
  });

  it('forgets the oldest task when it is full', () => {
    const log = new LongTaskLog(2);
    log.add(0, 100);
    log.add(200, 100);
    log.add(400, 100);
    expect(log.overlap(0, 100)).toBe(0);
    expect(log.overlap(200, 500)).toBe(200);
  });
});

/** A recorder with a sink whose answers the test decides, on a manual clock and timer. */
function batching(maxBatch?: number) {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const sent: number[][] = [];
  const answers: (StallSendResult | Error)[] = [];
  const stalls = new StallRecorder<null>({ describe: () => null, onStall: () => batcher.notify() });
  const batcher: StallBatcher<null> = new StallBatcher(stalls, {
    ...(maxBatch ? { maxBatch } : {}),
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void timers.splice(timers.indexOf(timer as (typeof timers)[number]), 1),
    send: async (entries: StallEntry<null>[]) => {
      sent.push(entries.map((entry) => entry.seq));
      const answer = answers.shift() ?? true;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  let frameClock = 0;
  /** Record one stall at the current time. */
  const stall = () => {
    stalls.frame(frameClock);
    stalls.frame((frameClock += 1000));
    frameClock += 1;
  };
  /** Let time pass; due timers run, and their sends settle. */
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  };
  return { stalls, batcher, sent, answers, timers, stall, advance };
}

describe('stall batches to a sink', () => {
  it('sends new stalls together, at most one batch every five seconds', async () => {
    const b = batching();
    expect(STALL_BATCH_INTERVAL_MS).toBe(5000);
    b.stall();
    // The first batch may go at once, but not inside the frame that recorded the stall.
    expect(b.sent).toEqual([]);
    expect(b.timers).toHaveLength(1);
    await b.advance(0);
    expect(b.sent).toEqual([[1]]);
    // Three stalls within the next seconds: one timer, one batch, five seconds after the last one.
    b.stall();
    b.stall();
    await b.advance(3000);
    b.stall();
    expect(b.timers).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    await b.advance(1999);
    expect(b.sent).toHaveLength(1);
    await b.advance(1);
    expect(b.sent).toEqual([[1], [2, 3, 4]]);
    expect(b.batcher.unsent).toBe(0);
    // Nothing recorded, nothing armed: no timer runs while the page is smooth.
    await b.advance(60_000);
    expect(b.timers).toHaveLength(0);
    expect(b.sent).toHaveLength(2);
  });

  it('does not retry a refused batch by itself: it goes out again with the next stall', async () => {
    const b = batching();
    b.answers.push(false, new Error('network'), true);
    b.stall();
    await b.advance(0);
    expect(b.sent).toEqual([[1]]);
    expect(b.batcher.unsent).toBe(1);
    // A sink that is down is not asked again while nothing happens.
    await b.advance(120_000);
    expect(b.timers).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    b.stall();
    await b.advance(0);
    // A rejected send is a refusal too.
    expect(b.sent).toEqual([[1], [1, 2]]);
    expect(b.batcher.unsent).toBe(2);
    b.stall();
    await b.advance(4999);
    expect(b.sent).toHaveLength(2);
    await b.advance(1);
    expect(b.sent[2]).toEqual([1, 2, 3]);
    expect(b.batcher.unsent).toBe(0);
  });

  it('stops for good when nothing listens', async () => {
    const b = batching();
    b.answers.push('gone');
    b.stall();
    await b.advance(0);
    expect(b.sent).toHaveLength(1);
    for (let i = 0; i < 5; i++) b.stall();
    await b.advance(60_000);
    expect(b.sent).toHaveLength(1);
    expect(b.timers).toHaveLength(0);
    expect(b.batcher.takeRest()).toEqual([]);
    // The stalls are still held for whoever looks at the recorder itself.
    expect(b.stalls.recorded).toBe(6);
  });

  it('splits what does not fit one batch, an interval apart', async () => {
    const b = batching(2);
    for (let i = 0; i < 5; i++) b.stall();
    await b.advance(0);
    expect(b.sent).toEqual([[1, 2]]);
    await b.advance(5000);
    expect(b.sent).toEqual([
      [1, 2],
      [3, 4],
    ]);
    await b.advance(5000);
    expect(b.sent).toEqual([[1, 2], [3, 4], [5]]);
    await b.advance(5000);
    expect(b.sent).toHaveLength(3);
  });

  it('gives up the unsent stalls once for a last hand-over, and sends nothing after it is disposed', async () => {
    const b = batching();
    b.stall();
    b.stall();
    // The page goes away before the timer runs.
    expect(b.batcher.takeRest().map((entry) => entry.seq)).toEqual([1, 2]);
    expect(b.batcher.takeRest()).toEqual([]);
    await b.advance(0);
    expect(b.sent).toEqual([]);
    b.stall();
    b.batcher.dispose();
    expect(b.timers).toHaveLength(0);
    await b.advance(10_000);
    b.stall();
    expect(b.timers).toHaveLength(0);
    expect(b.sent).toEqual([]);
  });
});
