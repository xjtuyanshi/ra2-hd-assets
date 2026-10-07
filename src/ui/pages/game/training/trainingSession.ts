import { createLessonRun, type LessonRunView } from '../../../../app/training/lessonRun';
import type { GameCommandState } from '../../../../games/commandState';
import type { TrainingInput, TrainingLesson } from '../../../../games/training';
import type { GameInputObservation } from '../gameInput';

/**
 * One practice lesson on a running game: turns the inputs the page forwarded to the game into lesson inputs, polls the
 * game's order state a few times a second and feeds both to the lesson engine. It owns one interval timer and nothing
 * else; it never sends input to the game and never touches React (the page publishes the views it reports).
 */
export interface TrainingSessionOptions {
  lesson: TrainingLesson;
  getCommandState(): Promise<GameCommandState | null>;
  /** Called when what the coach panel shows has changed (times are reported in whole seconds). */
  publish(view: LessonRunView): void;
  now?: () => number;
  intervalMs?: number;
}

export interface TrainingSession {
  /** Feed one forwarded input (see GameInputOptions.observe). */
  observe(observation: GameInputObservation): void;
  view(): LessonRunView;
  stop(): void;
}

const DOUBLE_CLICK_MS = 450;
const DOUBLE_CLICK_PIXELS = 6;
const DRAG_PIXELS = 12;

export function startTrainingSession(options: TrainingSessionOptions): TrainingSession {
  const now = options.now ?? (() => performance.now());
  const run = createLessonRun(options.lesson);
  let pending: TrainingInput[] = [];
  let lastDown: { code: string; time: number; x: number; y: number } | null = null;
  const downs = new Map<string, { x: number; y: number }>();
  let stopped = false;
  let busy = false;
  let published = '';

  const publish = (view: LessonRunView) => {
    // Whole seconds only: the panel must not re-render ten times a second for a running clock.
    const key = JSON.stringify({
      ...view,
      totalMs: Math.floor(view.totalMs / 1000),
      tasks: view.tasks.map((task) => ({ ...task, elapsedMs: Math.floor(task.elapsedMs / 1000) })),
    });
    if (key === published) return;
    published = key;
    options.publish(view);
  };

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const state = await options.getCommandState().catch(() => null);
      if (stopped) return;
      const inputs = pending;
      pending = [];
      publish(run.push({ time: now(), state, inputs }));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 150);
  publish(run.view());

  return {
    view: () => run.view(),
    observe(observation) {
      if (stopped) return;
      const time = now();
      const { ctrl, alt, shift } = observation;
      if (observation.type === 'keydown') {
        pending.push({ time, code: observation.code, ctrl, alt, shift });
        return;
      }
      const x = observation.x ?? 0;
      const y = observation.y ?? 0;
      if (observation.type === 'pointerdown') {
        const double =
          observation.code === 'Mouse0' &&
          lastDown !== null &&
          lastDown.code === observation.code &&
          time - lastDown.time <= DOUBLE_CLICK_MS &&
          Math.hypot(x - lastDown.x, y - lastDown.y) <= DOUBLE_CLICK_PIXELS;
        lastDown = double ? null : { code: observation.code, time, x, y };
        downs.set(observation.code, { x, y });
        pending.push({ time, code: observation.code, ctrl, alt, shift, x, y });
        if (double) pending.push({ time, code: 'Double0', ctrl, alt, shift, x, y });
        return;
      }
      const down = downs.get(observation.code);
      downs.delete(observation.code);
      if (down && Math.hypot(x - down.x, y - down.y) >= DRAG_PIXELS) {
        pending.push({ time, code: observation.code.replace('Mouse', 'Drag'), ctrl, alt, shift, x, y });
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
