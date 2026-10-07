import {
  trainingChord,
  type TrainingContext,
  type TrainingInput,
  type TrainingLesson,
  type TrainingSample,
} from '../../games/training';
import type { GameCommandState } from '../../games/commandState';

/**
 * Generic lesson engine: feeds samples (live order state + real inputs) to the active task's detector, keeps the time
 * each task took, decides when a hint is due and builds the closing summary. Pure logic: no DOM, timers or game facts,
 * so it runs the same from the page and from tests with synthetic samples.
 */

export type LessonTaskStatus = 'pending' | 'active' | 'done';

export interface LessonTaskView {
  id: string;
  title: string;
  instruction: string;
  hint: string;
  status: LessonTaskStatus;
  /** Time the task was active while the battle ran, in milliseconds. */
  elapsedMs: number;
  hintVisible: boolean;
}

export interface LessonRunView {
  lessonId: string;
  title: string;
  /** waiting: no battle yet or the scenario is not ready; running; done: every task finished. */
  phase: 'waiting' | 'running' | 'done';
  /** Index of the active task (tasks.length when done). */
  taskIndex: number;
  tasks: LessonTaskView[];
  totalMs: number;
  /** Labels of the lesson's hotkeys the player used so far / has not used. */
  hotkeysUsed: string[];
  hotkeysUnused: string[];
}

export interface LessonRunOptions {
  /** Default time without progress before a task's hint shows. */
  hintAfterMs?: number;
  /** A gap between two samples longer than this is not counted as practice time (hidden tab, stalled page). */
  maxStepMs?: number;
  /** Inputs kept per task; older ones are dropped. */
  maxInputs?: number;
}

export interface LessonRun {
  /** Feed one sample; returns the current view. */
  push(sample: TrainingSample): LessonRunView;
  view(): LessonRunView;
}

export function createLessonRun(lesson: TrainingLesson, options: LessonRunOptions = {}): LessonRun {
  const hintAfterMs = options.hintAfterMs ?? 20_000;
  const maxStepMs = options.maxStepMs ?? 1_000;
  const maxInputs = options.maxInputs ?? 400;
  const elapsed = lesson.tasks.map(() => 0);
  const hinted = lesson.tasks.map(() => false);
  const usedChords = new Set<string>();
  let index = 0;
  let ready = false;
  let lastTime: number | null = null;
  let lastHadState = false;
  // State of the active task.
  let origin: GameCommandState | null = null;
  let originTime = 0;
  let inputs: TrainingInput[] = [];
  let memo = new Map<string, unknown>();
  let progress = 0;
  let sinceProgressMs = 0;

  const beginTask = () => {
    origin = null;
    inputs = [];
    memo = new Map();
    progress = 0;
    sinceProgressMs = 0;
  };

  const view = (): LessonRunView => {
    const used: string[] = [];
    const unused: string[] = [];
    for (const hotkey of lesson.hotkeys) (hotkey.chords.some((chord) => usedChords.has(chord)) ? used : unused).push(hotkey.label);
    return {
      lessonId: lesson.id,
      title: lesson.title,
      phase: index >= lesson.tasks.length ? 'done' : ready ? 'running' : 'waiting',
      taskIndex: index,
      tasks: lesson.tasks.map((task, i) => ({
        id: task.id,
        title: task.title,
        instruction: task.instruction,
        hint: task.hint,
        status: i < index ? 'done' : i === index && ready ? 'active' : 'pending',
        elapsedMs: elapsed[i]!,
        hintVisible: hinted[i]! && i === index,
      })),
      totalMs: elapsed.reduce((sum, value) => sum + value, 0),
      hotkeysUsed: used,
      hotkeysUnused: unused,
    };
  };

  return {
    view,
    push(sample) {
      const step = lastTime === null ? 0 : Math.max(0, Math.min(maxStepMs, sample.time - lastTime));
      const counted = lastHadState && sample.state !== null ? step : 0;
      lastTime = sample.time;
      lastHadState = sample.state !== null;
      for (const input of sample.inputs) usedChords.add(trainingChord(input));
      if (index >= lesson.tasks.length) return view();
      const state = sample.state;
      if (!state) return view();
      if (!ready) {
        ready = lesson.ready ? lesson.ready(state) : true;
        if (!ready) return view();
      }
      // One sample can finish several tasks whose conditions already hold; each still needs its own inputs.
      let fresh = sample.inputs;
      for (let guard = 0; guard <= lesson.tasks.length && index < lesson.tasks.length; guard++) {
        const task = lesson.tasks[index]!;
        if (!origin) {
          origin = state;
          originTime = sample.time;
        } else if (guard === 0) {
          elapsed[index]! += counted;
          sinceProgressMs += counted;
        }
        if (fresh.length) {
          inputs = inputs.concat(fresh);
          if (inputs.length > maxInputs) inputs = inputs.slice(inputs.length - maxInputs);
          fresh = [];
        }
        const context: TrainingContext = { time: sample.time, state, origin, originTime, inputs, memo };
        let result: boolean | number;
        try {
          result = task.detect(context);
        } catch {
          // A detector that trips over an unexpected state must not end the lesson; it simply has not fired.
          result = false;
        }
        const value = result === true ? 1 : result === false ? 0 : Math.max(0, Math.min(1, result));
        if (value >= 1) {
          index += 1;
          beginTask();
          continue;
        }
        if (value > progress) {
          progress = value;
          sinceProgressMs = 0;
        }
        if (sinceProgressMs >= (task.hintAfterMs ?? hintAfterMs)) hinted[index] = true;
        break;
      }
      return view();
    },
  };
}
