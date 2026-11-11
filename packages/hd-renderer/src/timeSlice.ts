/**
 * Long CPU passes split into frame-sized slices.
 *
 * A pass is written once, as a generator that yields between units of work (a row, a column, a line). `runSteps`
 * drives it to the end in one go, exactly as a plain function would run; `runStepsSliced` gives the thread back
 * whenever a slice has used its budget, so the page can present the frames in between. A map cache load decodes and
 * dilates whole-map images and builds distance fields over them: a second or more of loops that, run in one piece
 * while a match is on, froze the original picture the player was looking at (B3 #10, 2.5 s).
 */

/** A pass that yields between units of work; its return value is the pass's result. */
export type Steps<T> = Generator<void, T, void>;

/** Where a sliced pass reads its time and how it gives the thread back (injectable for tests). */
export interface SliceClock {
  now(): number;
  /** Resolves on a later task, after which the browser may run a rendering update. */
  pause(): Promise<void>;
}

/** Main-thread work per slice: half a 60 Hz frame, leaving the rest to presentation and input. */
export const SLICE_BUDGET_MS = 8;

/**
 * A task without the clamped timer delay: a message to a fresh channel. The event loop runs a rendering update
 * between tasks when one is due, so a frame can be presented between two slices.
 */
function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export const defaultSliceClock: SliceClock = { now: () => performance.now(), pause: nextTask };

/** Run a pass to the end without yielding the thread. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Run a pass, giving the thread back after every `budgetMs` of work. */
export async function runStepsSliced<T>(
  steps: Steps<T>,
  clock: SliceClock = defaultSliceClock,
  budgetMs = SLICE_BUDGET_MS,
): Promise<T> {
  let start = clock.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (clock.now() - start < budgetMs) continue;
    await clock.pause();
    start = clock.now();
  }
}
