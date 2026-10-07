import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LessonRunView } from '../../src/app/training/lessonRun';
import type { TrainingLesson } from '../../src/games/training';
import { usedChord } from '../../src/games/shared/trainingDetectors';
import { startTrainingSession } from '../../src/ui/pages/game/training/trainingSession';
import { developmentGameRoot, parseTrainingQuery, trainingHref } from '../../src/ui/pages/game/training/trainingQuery';
import { state } from './trainingFixtures';

afterEach(() => vi.useRealTimers());

const lesson = (chords: string[]): TrainingLesson => ({
  id: 'demo',
  title: 'Demo',
  summary: '',
  scenario: 'demo',
  hotkeys: [],
  tasks: chords.map((chord) => ({
    id: chord,
    title: chord,
    instruction: '',
    hint: '',
    detect: (context) => usedChord(context, [chord]),
  })),
});

function setup(chords: string[]) {
  vi.useFakeTimers();
  let time = 0;
  const views: LessonRunView[] = [];
  const getCommandState = vi.fn(async () => state([]));
  const session = startTrainingSession({
    lesson: lesson(chords),
    getCommandState,
    publish: (view) => views.push(view),
    now: () => time,
    intervalMs: 100,
  });
  const tick = async (ms = 100) => {
    time += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const mods = { ctrl: false, alt: false, shift: false };
  return { session, views, tick, getCommandState, mods, at: (value: number) => (time = value) };
}

describe('training session', () => {
  it('turns forwarded inputs into chords: keys, double clicks and drags', async () => {
    const { session, tick, mods } = setup(['Ctrl+Digit1', 'Double0', 'Shift+Drag0', 'Mouse2']);
    await tick();
    session.observe({ type: 'keydown', code: 'Digit1', ...mods, ctrl: true });
    await tick();
    expect(session.view().taskIndex).toBe(1);
    // Two presses at the same place within the double-click time.
    session.observe({ type: 'pointerdown', code: 'Mouse0', ...mods, x: 100, y: 100 });
    session.observe({ type: 'pointerup', code: 'Mouse0', ...mods, x: 100, y: 100 });
    await tick();
    expect(session.view().taskIndex).toBe(1);
    session.observe({ type: 'pointerdown', code: 'Mouse0', ...mods, x: 102, y: 101 });
    session.observe({ type: 'pointerup', code: 'Mouse0', ...mods, x: 102, y: 101 });
    await tick();
    expect(session.view().taskIndex).toBe(2);
    // A release far from its press is a drag; a short one is not.
    session.observe({ type: 'pointerdown', code: 'Mouse0', ...mods, shift: true, x: 300, y: 300 });
    session.observe({ type: 'pointerup', code: 'Mouse0', ...mods, shift: true, x: 304, y: 303 });
    await tick();
    expect(session.view().taskIndex).toBe(2);
    session.observe({ type: 'pointerdown', code: 'Mouse0', ...mods, shift: true, x: 300, y: 300 });
    session.observe({ type: 'pointerup', code: 'Mouse0', ...mods, shift: true, x: 380, y: 360 });
    await tick();
    expect(session.view().taskIndex).toBe(3);
    session.observe({ type: 'pointerdown', code: 'Mouse2', ...mods, x: 10, y: 10 });
    await tick();
    expect(session.view().phase).toBe('done');
    session.stop();
  });

  it('publishes only when the panel changes and stops polling when stopped', async () => {
    const { session, views, tick, getCommandState, mods } = setup(['KeyS']);
    await tick();
    const published = views.length;
    await tick();
    await tick();
    // Same whole second, same task: nothing new to show.
    expect(views.length).toBe(published);
    await tick(1000);
    expect(views.length).toBe(published + 1);
    session.observe({ type: 'keydown', code: 'KeyS', ...mods });
    await tick();
    expect(views.at(-1)!.phase).toBe('done');
    session.stop();
    const calls = getCommandState.mock.calls.length;
    await tick(1000);
    expect(getCommandState.mock.calls.length).toBe(calls);
  });

  it('keeps running while the state request fails', async () => {
    const { session, tick, getCommandState } = setup(['KeyS']);
    getCommandState.mockRejectedValueOnce(new Error('VM destroyed'));
    await tick();
    await tick();
    expect(session.view().phase).toBe('running');
    session.stop();
  });
});

describe('training query', () => {
  it('reads the lesson, the lesson list and nothing outside development builds', () => {
    expect(parseTrainingQuery('?hd=1', true)).toBeNull();
    expect(parseTrainingQuery('?train=menu', false)).toBeNull();
    expect(parseTrainingQuery('?train=menu', true)).toEqual({ lesson: null, game: 'yr' });
    expect(parseTrainingQuery('?train=yr-camera', true)).toEqual({ lesson: 'yr-camera', game: 'yr' });
    expect(parseTrainingQuery('?train=../x', true)).toEqual({ lesson: null, game: 'yr' });
  });

  it('builds lesson addresses that keep the launcher parameters', () => {
    const menu = 'http://localhost:15403/?hd=1&game-speed=1&train=menu&debug-key=0';
    const lessonUrl = new URL(trainingHref(menu, 'yr-build', 'build'));
    expect(Object.fromEntries(lessonUrl.searchParams)).toEqual({
      hd: '1',
      'game-speed': '1',
      train: 'yr-build',
      'debug-key': '0',
      'game-root': 'build',
      'start-page': 'battle',
    });
    const back = new URL(trainingHref(lessonUrl.toString(), null));
    expect(Object.fromEntries(back.searchParams)).toEqual({
      hd: '1',
      'game-speed': '1',
      train: 'menu',
      'debug-key': '0',
    });
    expect(developmentGameRoot('?game-root=basic')).toBe('basic');
    expect(developmentGameRoot('?game-root=../etc')).toBe('');
    expect(developmentGameRoot('')).toBe('');
  });
});
