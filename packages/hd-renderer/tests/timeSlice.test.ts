import { describe, expect, it } from 'vitest';
import { runSteps, runStepsSliced, type SliceClock, type Steps } from '../src/timeSlice';

function* rows(count: number, clock: { t: number }): Steps<number> {
  let sum = 0;
  for (let row = 0; row < count; row++, yield) {
    sum += row;
    clock.t += 3; // Each row costs 3 ms of this fake thread.
  }
  return sum;
}

describe('time-sliced passes', () => {
  it('gives the thread back once a slice has used its budget and returns what the unsliced pass returns', async () => {
    const time = { t: 0 };
    const paused: number[] = [];
    const clock: SliceClock = {
      now: () => time.t,
      pause: async () => {
        paused.push(time.t);
      },
    };
    expect(await runStepsSliced(rows(10, time), clock, 8)).toBe(runSteps(rows(10, { t: 0 })));
    // 3 ms rows against an 8 ms budget: a pause after every third row, never after the last one.
    expect(paused).toEqual([9, 18, 27]);
  });
  it('runs a pass with no work units without pausing', async () => {
    let pauses = 0;
    // eslint-disable-next-line require-yield
    function* none(): Steps<string> {
      return 'done';
    }
    expect(await runStepsSliced(none(), { now: () => 1e9 * Math.random(), pause: async () => void pauses++ }, 0)).toBe(
      'done',
    );
    expect(pauses).toBe(0);
  });
});
