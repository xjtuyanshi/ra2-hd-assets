import { describe, expect, it } from 'vitest';
import { createLessonRun } from '../../src/app/training/lessonRun';
import type { GameCommandObject, GameCommandState } from '../../src/games/commandState';
import type { TrainingContext, TrainingInput, TrainingLesson } from '../../src/games/training';
import { YR_TRAINING_LESSONS, yrProjection } from '../../src/games/yr/training/lessons';
import { YR_HOTKEY_SHEET } from '../../src/games/yr/hotkeys';
import { runtimeEnglishMessages } from '../../src/ui/shared/i18n/runtimeMessages';
import { input, sidebar, state, unit } from './trainingFixtures';

/**
 * Every task detector of the YR lessons against synthetic states: `good` (the taught input with its effect) must
 * complete the task and `bad` (the same effect reached with a wrong key, or the right key without the effect) must not.
 */
const lessonOf = (id: string): TrainingLesson => YR_TRAINING_LESSONS.find((lesson) => lesson.id === id)!;
const cell = (x: number, y: number) => ({ x: x * 256 + 128, y: y * 256 + 128 });
const yard = () => unit({ kind: 'building', type: 'NACNST', ...cell(25, 114) });
const tanks = (fields: Partial<GameCommandObject> = {}) =>
  [0, 1, 2, 3].map((i) => unit({ ...cell(28 + i, 110), ...fields }));
const troops = (fields: Partial<GameCommandObject> = {}) =>
  [0, 1, 2].map((i) => unit({ kind: 'infantry', type: 'E2', ...cell(28 + i, 113), ...fields }));
/** View origin that puts a world point in the middle of the 1112 x 768 tactical view. */
const viewOn = (point: { x: number; y: number }) => {
  const p = yrProjection({ ...point, z: 0 });
  return { x: Math.round(p.x - 556), y: Math.round(p.y - 384) };
};
const key = (code: string, mods: Partial<Pick<TrainingInput, 'ctrl' | 'alt' | 'shift'>> = {}) => input(code, 900, mods);

interface Case {
  origin: GameCommandState;
  good: { state: GameCommandState; inputs: TrainingInput[]; memo?: [string, unknown][] };
  bad: { state: GameCommandState; inputs: TrainingInput[]; memo?: [string, unknown][] };
}
const run = (lesson: TrainingLesson, task: string, origin: GameCommandState, step: Case['good']) => {
  const context: TrainingContext = {
    time: 1000,
    state: step.state,
    origin,
    originTime: 0,
    inputs: step.inputs,
    memo: new Map(step.memo ?? []),
  };
  return Number(lesson.tasks.find((entry) => entry.id === task)!.detect(context));
};

const home = viewOn(cell(25, 114));
const away = { x: home.x + 2000, y: home.y };
const enemyPlant = unit({ owner: 1, kind: 'building', type: 'NAPOWR', ...cell(25, 95) });
const civilians = () =>
  [0, 1].map((i) => unit({ owner: 2, kind: 'infantry', type: `CIV${i + 1}`, ...cell(20 + i, 120) }));

const CASES: Record<string, Record<string, Case>> = {
  'yr-camera': {
    scroll: {
      origin: state([yard()], { view: home }),
      good: { state: state([yard()], { view: { x: home.x + 400, y: home.y } }), inputs: [key('ArrowRight')] },
      bad: { state: state([yard()], { view: { x: home.x + 400, y: home.y } }), inputs: [key('Drag2')] },
    },
    base: {
      origin: state([yard()], { view: away }),
      good: { state: state([yard()], { view: home }), inputs: [key('KeyH')] },
      bad: { state: state([yard()], { view: home }), inputs: [key('ArrowLeft')] },
    },
    event: {
      origin: state([yard()], { view: home }),
      good: {
        state: state([yard()], { view: viewOn(cell(57, 75)), lastEvent: { x: 57, y: 75 } }),
        inputs: [key('Space')],
      },
      bad: {
        state: state([yard()], { view: viewOn(cell(57, 75)), lastEvent: { x: 57, y: 75 } }),
        inputs: [key('ArrowUp')],
      },
    },
    return: {
      origin: state([yard()], { view: away }),
      good: { state: state([yard()], { view: home }), inputs: [key('KeyH')] },
      bad: { state: state([yard()], { view: away }), inputs: [key('KeyH')] },
    },
    box: {
      origin: state(tanks()),
      good: { state: state(tanks({ selected: true })), inputs: [key('Mouse0'), key('Drag0')] },
      bad: { state: state(tanks({ selected: true })), inputs: [key('Mouse0'), key('KeyP')] },
    },
    deselect: {
      origin: state(tanks({ selected: true })),
      good: { state: state(tanks()), inputs: [key('Mouse2')] },
      bad: { state: state(tanks()), inputs: [key('Mouse0')] },
    },
    type: {
      origin: state([...tanks(), ...troops()]),
      good: { state: state([...tanks({ selected: true }), ...troops()]), inputs: [key('Mouse0'), key('KeyT')] },
      bad: { state: state([...tanks({ selected: true }), ...troops({ selected: true })]), inputs: [key('KeyT')] },
    },
    add: {
      origin: state([...tanks({ selected: true }), ...troops()]),
      good: {
        state: state([...tanks({ selected: true }), ...troops({ selected: true })]),
        inputs: [key('Mouse0', { shift: true })],
      },
      bad: { state: state([...tanks({ selected: true }), ...troops({ selected: true })]), inputs: [key('Drag0')] },
    },
    all: {
      origin: state([...tanks(), ...troops()]),
      good: { state: state([...tanks({ selected: true }), ...troops({ selected: true })]), inputs: [key('KeyP')] },
      bad: { state: state([...tanks({ selected: true }), ...troops({ selected: true })]), inputs: [key('Drag0')] },
    },
  },
  'yr-teams': {
    make1: {
      origin: state(tanks({ selected: true })),
      good: { state: state(tanks({ selected: true, group: 0 })), inputs: [key('Digit1', { ctrl: true })] },
      bad: { state: state(tanks({ selected: true, group: 0 })), inputs: [key('Digit1')] },
    },
    make2: {
      origin: state(troops({ selected: true })),
      good: { state: state(troops({ selected: true, group: 1 })), inputs: [key('Digit2', { ctrl: true })] },
      bad: { state: state(troops({ selected: true, group: 0 })), inputs: [key('Digit2', { ctrl: true })] },
    },
    recall1: {
      origin: state([...tanks({ group: 0 }), ...troops({ group: 1 })]),
      good: {
        state: state([...tanks({ group: 0, selected: true }), ...troops({ group: 1 })]),
        inputs: [key('Digit1')],
      },
      bad: {
        state: state([...tanks({ group: 0, selected: true }), ...troops({ group: 1, selected: true })]),
        inputs: [key('Digit1')],
      },
    },
    add2: {
      origin: state([...tanks({ group: 0, selected: true }), ...troops({ group: 1 })]),
      good: {
        state: state([...tanks({ group: 0, selected: true }), ...troops({ group: 1, selected: true })]),
        inputs: [key('Digit2', { shift: true })],
      },
      bad: {
        state: state([...tanks({ group: 0, selected: true }), ...troops({ group: 1, selected: true })]),
        inputs: [key('Digit2')],
      },
    },
    away: {
      origin: state(tanks({ group: 0 }), { view: home }),
      good: { state: state(tanks({ group: 0 }), { view: away }), inputs: [key('ArrowRight')] },
      bad: { state: state(tanks({ group: 0 }), { view: home }), inputs: [key('ArrowRight')] },
    },
    jump1: {
      origin: state(tanks({ group: 0 }), { view: away }),
      good: {
        state: state(tanks({ group: 0, selected: true }), { view: viewOn(cell(29, 110)) }),
        inputs: [key('Digit1', { alt: true })],
      },
      bad: {
        state: state(tanks({ group: 0, selected: true }), { view: viewOn(cell(29, 110)) }),
        inputs: [key('Digit1')],
      },
    },
  },
  'yr-orders': {
    move: {
      origin: state(tanks({ selected: true })),
      good: {
        state: state(tanks({ selected: true, mission: 'Move', destination: { kind: 'cell', x: 40, y: 100 } })),
        inputs: [key('Mouse0')],
      },
      bad: { state: state(tanks({ selected: true })), inputs: [key('Mouse0')] },
    },
    stop: {
      origin: state(tanks({ selected: true })),
      good: { state: state(tanks({ selected: true })), inputs: [key('KeyS')], memo: [['moving', true]] },
      // S while nothing had been moving: the order to stop was never needed.
      bad: { state: state(tanks({ selected: true })), inputs: [key('KeyS')] },
    },
    attack: {
      origin: state([...tanks({ selected: true }), enemyPlant]),
      good: {
        state: state([
          ...tanks({ selected: true, mission: 'Attack', target: { kind: 'object', uid: enemyPlant.uid } }),
          enemyPlant,
        ]),
        inputs: [key('Mouse0')],
      },
      bad: {
        state: state([
          ...tanks({ selected: true, mission: 'Attack', target: { kind: 'cell', x: 30, y: 99 } }),
          enemyPlant,
        ]),
        inputs: [key('Mouse0')],
      },
    },
    'force-fire': {
      origin: state(tanks({ selected: true })),
      good: {
        state: state(tanks({ selected: true, mission: 'Attack', target: { kind: 'cell', x: 30, y: 99 } })),
        inputs: [key('Mouse0', { ctrl: true })],
      },
      bad: {
        state: state(tanks({ selected: true, mission: 'Attack', target: { kind: 'cell', x: 30, y: 99 } })),
        inputs: [key('Mouse0')],
      },
    },
    crush: {
      origin: state([...tanks({ selected: true }), ...civilians()]),
      good: { state: state([...tanks({ selected: true }), civilians()[0]!]), inputs: [key('Mouse0', { alt: true })] },
      bad: { state: state([...tanks({ selected: true }), civilians()[0]!]), inputs: [key('Mouse0', { ctrl: true })] },
    },
    'attack-move': {
      origin: state(tanks({ selected: true })),
      good: {
        state: state(tanks({ selected: true, mission: 'Move', destination: { kind: 'cell', x: 30, y: 97 } })),
        inputs: [key('Mouse0', { ctrl: true, shift: true })],
      },
      bad: {
        state: state(tanks({ selected: true, mission: 'Move', destination: { kind: 'cell', x: 30, y: 97 } })),
        inputs: [key('Mouse0')],
      },
    },
    guard: {
      origin: state(tanks({ selected: true })),
      good: { state: state(tanks({ selected: true, mission: 'Area_Guard' })), inputs: [key('KeyG')] },
      bad: { state: state(tanks({ selected: true, mission: 'Area_Guard' })), inputs: [key('KeyS')] },
    },
  },
};

describe('YR practice lessons', () => {
  it('offers the four lessons in teaching order, each with tasks, hotkeys and a scenario', () => {
    expect(YR_TRAINING_LESSONS.map((lesson) => lesson.id)).toEqual(['yr-camera', 'yr-teams', 'yr-orders', 'yr-build']);
    for (const lesson of YR_TRAINING_LESSONS) {
      expect(lesson.tasks.length).toBeGreaterThanOrEqual(6);
      expect(new Set(lesson.tasks.map((task) => task.id)).size).toBe(lesson.tasks.length);
      expect(lesson.hotkeys.length).toBeGreaterThan(0);
      expect(['basic', 'build']).toContain(lesson.scenario);
    }
  });

  for (const [lessonId, tasks] of Object.entries(CASES)) {
    for (const [taskId, entry] of Object.entries(tasks)) {
      it(`${lessonId} / ${taskId}: the taught input completes it, a wrong one does not`, () => {
        const lesson = lessonOf(lessonId);
        expect(run(lesson, taskId, entry.origin, entry.good)).toBe(1);
        expect(run(lesson, taskId, entry.origin, entry.bad)).toBeLessThan(1);
        // Nothing pressed at all never completes a task.
        expect(run(lesson, taskId, entry.origin, { state: entry.good.state, inputs: [] })).toBeLessThan(1);
      });
    }
  }

  it('yr-orders / scatter and escort', () => {
    const lesson = lessonOf('yr-orders');
    const before = tanks({ selected: true });
    const moved = before.map((tank, i) => ({ ...tank, x: tank.x + (i === 0 ? 300 : 0) }));
    expect(run(lesson, 'scatter', state(before), { state: state(moved), inputs: [key('KeyX')] })).toBe(1);
    expect(run(lesson, 'scatter', state(before), { state: state(moved), inputs: [key('KeyS')] })).toBeLessThan(1);
    expect(run(lesson, 'scatter', state(before), { state: state(before), inputs: [key('KeyX')] })).toBeLessThan(1);
    const tank = unit();
    const flak = unit({ type: 'HTK', selected: true, mission: 'Area_Guard', focus: { kind: 'object', uid: tank.uid } });
    const chord = [key('Mouse0', { ctrl: true, alt: true })];
    expect(run(lesson, 'escort', state([tank, flak]), { state: state([tank, flak]), inputs: chord })).toBe(1);
    expect(
      run(lesson, 'escort', state([tank, flak]), { state: state([tank, flak]), inputs: [key('KeyG')] }),
    ).toBeLessThan(1);
    const stranger = { ...tank, owner: 1 };
    expect(
      run(lesson, 'escort', state([stranger, flak]), { state: state([stranger, flak]), inputs: chord }),
    ).toBeLessThan(1);
  });

  it('yr-build: deploy, structures, tabs, rally point, repair, sell and building while fighting', () => {
    const lesson = lessonOf('yr-build');
    const mcv = unit({ type: 'SMCV', selected: true });
    const built = (type: string, fields: Partial<GameCommandObject> = {}) =>
      unit({ kind: 'building', type, ...fields });
    const check = (task: string, origin: GameCommandState, good: Case['good'], bad: Case['good']) => {
      expect(run(lesson, task, origin, good), `${task} good`).toBe(1);
      expect(run(lesson, task, origin, bad), `${task} bad`).toBeLessThan(1);
    };
    check(
      'deploy',
      state([mcv]),
      { state: state([built('NACNST')]), inputs: [key('KeyD')] },
      { state: state([mcv]), inputs: [key('KeyD')] },
    );
    const home = built('NACNST', cell(25, 114));
    const oldPlant = built('NAPOWR');
    check(
      'power',
      state([home, oldPlant]),
      { state: state([home, oldPlant, built('NAPOWR')]), inputs: [] },
      { state: state([home, oldPlant]), inputs: [key('Mouse0')] },
    );
    check('barracks', state([]), { state: state([built('NAHAND')]), inputs: [] }, { state: state([]), inputs: [] });
    const tab = (activeTab: number) => state([], { sidebar: sidebar({ activeTab }) });
    check('tab-infantry', tab(0), { state: tab(2), inputs: [key('KeyE')] }, { state: tab(2), inputs: [key('Mouse0')] });
    check('tab-build', tab(2), { state: tab(0), inputs: [key('KeyQ')] }, { state: tab(0), inputs: [key('Mouse0')] });
    const barracks = built('NAHAND', { selected: true });
    check(
      'rally',
      state([barracks]),
      { state: state([{ ...barracks, focus: { kind: 'cell', x: 40, y: 100 } }]), inputs: [key('Mouse0')] },
      { state: state([barracks]), inputs: [key('Mouse0')] },
    );
    const made = (n: number) => Array.from({ length: n }, () => unit({ kind: 'infantry', type: 'E2' }));
    expect(run(lesson, 'train', state([]), { state: state(made(3)), inputs: [] })).toBe(1);
    expect(run(lesson, 'train', state([]), { state: state(made(1)), inputs: [] })).toBeCloseTo(1 / 3);
    // Conscripts that were already there do not count.
    const old = made(3);
    expect(run(lesson, 'train', state(old), { state: state(old), inputs: [] })).toBe(0);
    const damaged = built('NAPOWR', { health: 0.4 });
    check(
      'repair',
      state([damaged]),
      { state: state([{ ...damaged, health: 0.5 }]), inputs: [key('KeyK')] },
      { state: state([{ ...damaged, health: 0.5 }]), inputs: [key('Mouse0')] },
    );
    const gun = built('NALASR', cell(27, 118));
    const farGun = built('NALASR', cell(150, 80));
    check(
      'sell',
      state([home, gun, farGun]),
      { state: state([home, farGun]), inputs: [key('KeyL')] },
      { state: state([home, farGun]), inputs: [key('Mouse0')] },
    );
    // A gun of the player's lost at the far start is not a sale.
    expect(
      run(lesson, 'sell', state([home, gun, farGun]), { state: state([home, gun]), inputs: [key('KeyL')] }),
    ).toBeLessThan(1);
    // Building while fighting: two conscripts must appear while a tank attacks an enemy, and E must have been used.
    const fightingTank = unit({ mission: 'Attack', target: { kind: 'object', uid: enemyPlant.uid } });
    const play = (inputs: TrainingInput[]) => {
      const { ready: _ready, ...plain } = lesson;
      const engine = createLessonRun({ ...plain, tasks: [lesson.tasks.find((task) => task.id === 'multitask')!] });
      let view = engine.push({ time: 0, state: state([fightingTank, enemyPlant]), inputs });
      for (let n = 1; n <= 2; n++) {
        view = engine.push({ time: n * 500, state: state([fightingTank, enemyPlant, ...made(n)]), inputs: [] });
      }
      return view.phase;
    };
    expect(play([key('KeyE')])).toBe('done');
    expect(play([])).toBe('running');
  });

  it('has an English text for every lesson and cheat-sheet string', () => {
    const texts = new Set<string>();
    for (const lesson of YR_TRAINING_LESSONS) {
      texts.add(lesson.title).add(lesson.summary);
      for (const task of lesson.tasks) texts.add(task.title).add(task.instruction).add(task.hint);
      for (const hotkey of lesson.hotkeys) texts.add(hotkey.label);
    }
    for (const group of YR_HOTKEY_SHEET.groups) {
      texts.add(group.title);
      for (const row of group.rows) {
        texts.add(row.keys).add(row.action).add(row.tip);
        if (row.macKeys) texts.add(row.macKeys);
      }
    }
    for (const note of YR_HOTKEY_SHEET.notes) texts.add(note);
    const missing = [...texts].filter(
      (text) => /\p{Script=Han}/u.test(text) && !Object.hasOwn(runtimeEnglishMessages, text),
    );
    expect(missing).toEqual([]);
  });
});
