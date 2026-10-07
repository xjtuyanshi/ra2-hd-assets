import { describe, expect, it } from 'vitest';
import { createLessonRun } from '../../src/app/training/lessonRun';
import type { TrainingLesson } from '../../src/games/training';
import { chordWithEffect, selection, usedChord } from '../../src/games/shared/trainingDetectors';
import { input, sample, state, unit } from './trainingFixtures';

const lesson = (): TrainingLesson => ({
  id: 'demo',
  title: 'Demo',
  summary: '',
  scenario: 'demo',
  hotkeys: [
    { chords: ['KeyT'], label: 'T' },
    { chords: ['Ctrl+Digit1'], label: 'Ctrl+1' },
    { chords: ['KeyX'], label: 'X' },
  ],
  tasks: [
    {
      id: 'select',
      title: 'select',
      instruction: 'select three',
      hint: 'use T',
      detect: chordWithEffect(['KeyT'], ({ state: s }) => selection(s).length >= 3),
    },
    {
      id: 'team',
      title: 'team',
      instruction: 'make team 1',
      hint: 'Ctrl+1',
      hintAfterMs: 5000,
      detect: chordWithEffect(['Ctrl+Digit1'], ({ state: s }) => s.objects.filter((o) => o.group === 0).length >= 3),
    },
    { id: 'any', title: 'any', instruction: 'press S', hint: 'S', detect: (context) => usedChord(context, ['KeyS']) },
  ],
});

const tanks = (selected: boolean, group = -1) => [0, 1, 2].map(() => unit({ selected, group }));

describe('lesson engine', () => {
  it('waits for a battle, then runs tasks in order and reports times and hotkeys', () => {
    const run = createLessonRun(lesson());
    expect(run.push(sample(0, null)).phase).toBe('waiting');
    let view = run.push(sample(100, state(tanks(false))));
    expect(view.phase).toBe('running');
    expect(view.tasks.map((task) => task.status)).toEqual(['active', 'pending', 'pending']);
    // The state alone does not complete the task: the key was not used.
    view = run.push(sample(600, state(tanks(true))));
    expect(view.taskIndex).toBe(0);
    view = run.push(sample(1100, state(tanks(true)), [input('KeyT', 1050)]));
    expect(view.taskIndex).toBe(1);
    expect(view.tasks[0]).toMatchObject({ status: 'done', elapsedMs: 1000 });
    view = run.push(sample(1600, state(tanks(true, 0)), [input('Digit1', 1550, { ctrl: true })]));
    expect(view.taskIndex).toBe(2);
    view = run.push(sample(2100, state(tanks(true, 0)), [input('KeyS', 2000)]));
    expect(view.phase).toBe('done');
    expect(view.taskIndex).toBe(3);
    expect(view.totalMs).toBe(2000);
    expect(view.hotkeysUsed).toEqual(['T', 'Ctrl+1']);
    expect(view.hotkeysUnused).toEqual(['X']);
  });

  it('does not let the chord of one task complete the next one', () => {
    const run = createLessonRun({
      ...lesson(),
      tasks: [
        { id: 'a', title: 'a', instruction: '', hint: '', detect: (context) => usedChord(context, ['KeyS']) },
        { id: 'b', title: 'b', instruction: '', hint: '', detect: (context) => usedChord(context, ['KeyS']) },
      ],
    });
    run.push(sample(0, state([])));
    expect(run.push(sample(100, state([]), [input('KeyS', 50)])).taskIndex).toBe(1);
    expect(run.push(sample(200, state([]))).taskIndex).toBe(1);
    expect(run.push(sample(300, state([]), [input('KeyS', 250)])).phase).toBe('done');
  });

  it('shows the hint after a stretch without progress and restarts the wait when progress grows', () => {
    const run = createLessonRun(lesson(), { hintAfterMs: 3000 });
    let time = 0;
    const step = (value: ReturnType<typeof state> | null, inputs = [] as ReturnType<typeof input>[]) =>
      run.push(sample((time += 500), value, inputs));
    step(state(tanks(false)));
    for (let i = 0; i < 5; i++) expect(step(state(tanks(false))).tasks[0]!.hintVisible).toBe(false);
    // The chord without its effect is half progress: the wait starts again.
    expect(step(state(tanks(false)), [input('KeyT', time)]).tasks[0]!.hintVisible).toBe(false);
    for (let i = 0; i < 5; i++) expect(step(state(tanks(false))).tasks[0]!.hintVisible).toBe(false);
    expect(step(state(tanks(false))).tasks[0]!.hintVisible).toBe(true);
  });

  it('does not count time while the battle is not running or across long gaps', () => {
    const run = createLessonRun(lesson());
    run.push(sample(0, state(tanks(false))));
    run.push(sample(500, state(tanks(false))));
    run.push(sample(1000, null)); // options page over the battle
    run.push(sample(9000, null));
    run.push(sample(9500, state(tanks(false)))); // back: the step from a menu sample is not counted
    const view = run.push(sample(60_000, state(tanks(false)))); // a hidden tab: capped at one second
    expect(view.tasks[0]!.elapsedMs).toBe(1500);
  });

  it('keeps a note of a finished task and shares values between tasks', () => {
    const run = createLessonRun({
      ...lesson(),
      tasks: [
        {
          id: 'measure',
          title: 'measure',
          instruction: '',
          hint: '',
          detect: (context) => {
            context.shared.set('value', 42);
            context.memo.set('note', 'measured');
            return true;
          },
        },
        {
          id: 'report',
          title: 'report',
          instruction: '',
          hint: '',
          detect: (context) => {
            context.memo.set('note', `value ${String(context.shared.get('value'))}`);
            return usedChord(context, ['KeyS']);
          },
        },
      ],
    });
    let view = run.push(sample(0, state([])));
    expect(view.tasks.map((task) => task.note)).toEqual(['measured', null]);
    view = run.push(sample(100, state([]), [input('KeyS', 50)]));
    expect(view.tasks.map((task) => task.note)).toEqual(['measured', 'value 42']);
  });

  it('waits for the lesson to be ready and survives a detector that throws', () => {
    const run = createLessonRun({
      ...lesson(),
      ready: (s) => s.objects.length > 0,
      tasks: [
        {
          id: 'boom',
          title: 'boom',
          instruction: '',
          hint: '',
          detect: () => {
            throw new Error('unexpected state');
          },
        },
      ],
    });
    expect(run.push(sample(0, state([]))).phase).toBe('waiting');
    expect(run.push(sample(100, state([unit()]))).phase).toBe('running');
    expect(run.push(sample(200, state([unit()]))).taskIndex).toBe(0);
  });
});
