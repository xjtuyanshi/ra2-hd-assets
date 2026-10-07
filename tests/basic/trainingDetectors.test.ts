import { describe, expect, it } from 'vitest';
import {
  allOf,
  centroid,
  chordWithEffect,
  inGroup,
  lastChord,
  ofKind,
  ofType,
  own,
  pick,
  selection,
  tacticalSize,
  viewCentreDistance,
  viewShows,
  viewTravel,
  withMission,
} from '../../src/games/shared/trainingDetectors';
import { trainingChord, type TrainingContext } from '../../src/games/training';
import { input, state, unit } from './trainingFixtures';

const context = (fields: Partial<TrainingContext>): TrainingContext => ({
  time: 1000,
  state: state([]),
  origin: state([]),
  originTime: 0,
  inputs: [],
  memo: new Map(),
  shared: new Map(),
  ...fields,
});
const flat = (point: { x: number; y: number }) => ({ x: point.x, y: point.y });

describe('training detectors', () => {
  it('names chords with their modifiers in a fixed order', () => {
    expect(trainingChord(input('Digit1', 0, { ctrl: true }))).toBe('Ctrl+Digit1');
    expect(trainingChord(input('Mouse0', 0, { ctrl: true, alt: true, shift: true }))).toBe('Ctrl+Alt+Shift+Mouse0');
    expect(trainingChord(input('KeyT', 0))).toBe('KeyT');
  });

  it('filters objects by owner, type, kind, group and mission', () => {
    const s = state([
      unit({ selected: true, group: 0 }),
      unit({ type: 'E2', kind: 'infantry', mission: 'Move' }),
      unit({ owner: 1, selected: true }),
      unit({ queuedMission: 'Area_Guard' }),
    ]);
    expect(pick(s, own).length).toBe(3);
    expect(pick(s, own, ofType('E2')).length).toBe(1);
    expect(pick(s, ofKind('vehicle')).length).toBe(3);
    expect(pick(s, inGroup(0)).length).toBe(1);
    expect(pick(s, withMission('Move')).length).toBe(1);
    expect(pick(s, withMission('Area_Guard')).length).toBe(1);
    // Selection is the local player's only: a selected foreign object does not count.
    expect(selection(s).length).toBe(1);
    expect(centroid([])).toBeNull();
    expect(centroid([unit({ x: 0, y: 0 }), unit({ x: 200, y: 100 })])).toEqual({ x: 100, y: 50, z: 0 });
  });

  it('completes a chord task only when the chord was used and its effect is there in time', () => {
    const detect = chordWithEffect(['Ctrl+Digit1'], ({ state: s }) => pick(s, inGroup(0)).length > 0, 2000);
    const grouped = state([unit({ group: 0 })]);
    // Effect without the chord: nothing. A different key: nothing.
    expect(detect(context({ state: grouped }))).toBe(0);
    expect(detect(context({ state: grouped, inputs: [input('Digit1', 900)] }))).toBe(0);
    // Chord without the effect: half. Chord with the effect: done. Effect long after the chord: half.
    expect(detect(context({ inputs: [input('Digit1', 900, { ctrl: true })] }))).toBe(0.5);
    expect(detect(context({ state: grouped, inputs: [input('Digit1', 900, { ctrl: true })] }))).toBe(1);
    expect(detect(context({ state: grouped, time: 9000, inputs: [input('Digit1', 900, { ctrl: true })] }))).toBe(0.5);
    expect(lastChord([input('KeyT', 1), input('KeyT', 5), input('KeyS', 7)], ['KeyT'])?.time).toBe(5);
  });

  it('combines detectors', () => {
    const yes = () => true;
    const half = () => 0.5;
    expect(allOf(yes, yes)(context({}))).toBe(1);
    expect(allOf(yes, half)(context({}))).toBe(0.75);
  });

  it('measures the view against the tactical area of the native layout', () => {
    const s = state([], { view: { x: 100, y: 200 } });
    expect(tacticalSize(s)).toEqual({ width: 1112, height: 768 });
    expect(tacticalSize(state([], { sidebar: null }))).toBeNull();
    expect(viewTravel(context({ state: s, origin: state([], { view: { x: 100, y: 500 } }) }))).toBe(300);
    expect(viewShows(s, flat, { x: 150, y: 250, z: 0 })).toBe(true);
    expect(viewShows(s, flat, { x: 150, y: 250, z: 0 }, 60)).toBe(false);
    expect(viewShows(s, flat, { x: 2000, y: 250, z: 0 })).toBe(false);
    expect(viewShows(s, flat, null)).toBe(false);
    expect(viewCentreDistance(s, flat, { x: 100 + 556, y: 200 + 384, z: 0 })).toBe(0);
    expect(viewCentreDistance(state([], { view: null }), flat, { x: 0, y: 0, z: 0 })).toBe(Infinity);
  });
});
