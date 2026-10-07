import type { GameCommandObject, GameCommandState } from '../commandState';
import { trainingChord, type TrainingContext, type TrainingDetector, type TrainingInput } from '../training';

/**
 * Game-independent building blocks for lesson detectors: object filters over the order state, "this chord was used
 * and then the state shows its effect", and view tests. Game modules combine them with their own facts (type names,
 * mission names, the map projection); nothing here names a game.
 */

export type ObjectFilter = (object: GameCommandObject, state: GameCommandState) => boolean;

export const own: ObjectFilter = (object, state) => object.owner === state.localHouse;
export const foreign: ObjectFilter = (object, state) => object.owner !== state.localHouse;
export const isSelected: ObjectFilter = (object) => object.selected;
export const ofType =
  (...types: string[]): ObjectFilter =>
  (object) =>
    types.includes(object.type);
export const ofKind =
  (...kinds: GameCommandObject['kind'][]): ObjectFilter =>
  (object) =>
    kinds.includes(object.kind);
export const inGroup =
  (group: number): ObjectFilter =>
  (object) =>
    object.group === group;
export const withMission =
  (...missions: string[]): ObjectFilter =>
  (object) =>
    missions.includes(object.mission) || (object.queuedMission !== null && missions.includes(object.queuedMission));

/** Objects passing every filter. */
export function pick(state: GameCommandState, ...filters: ObjectFilter[]): GameCommandObject[] {
  return state.objects.filter((object) => filters.every((filter) => filter(object, state)));
}

/** The local player's selected objects. */
export function selection(state: GameCommandState): GameCommandObject[] {
  return pick(state, own, isSelected);
}

export function byUid(state: GameCommandState, uid: number): GameCommandObject | undefined {
  return state.objects.find((object) => object.uid === uid);
}

/** Mean position, or null for no objects. */
export function centroid(objects: readonly GameCommandObject[]): { x: number; y: number; z: number } | null {
  if (!objects.length) return null;
  const sum = objects.reduce((acc, o) => ({ x: acc.x + o.x, y: acc.y + o.y, z: acc.z + o.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / objects.length, y: sum.y / objects.length, z: sum.z / objects.length };
}

/** The newest input that is one of `chords`, or null. */
export function lastChord(inputs: readonly TrainingInput[], chords: readonly string[]): TrainingInput | null {
  for (let i = inputs.length - 1; i >= 0; i--) if (chords.includes(trainingChord(inputs[i]!))) return inputs[i]!;
  return null;
}

export function usedChord(context: TrainingContext, chords: readonly string[]): boolean {
  return lastChord(context.inputs, chords) !== null;
}

/**
 * A task that is an input with a visible effect: done when `effect` holds at a sample taken at or within `windowMs`
 * after one of `chords` was used. The chord alone reports half progress; the effect without the chord reports none,
 * so reaching the same state another way (or with another key) does not complete the task.
 */
export function chordWithEffect(
  chords: readonly string[],
  effect: (context: TrainingContext, input: TrainingInput) => boolean,
  windowMs = 4000,
): TrainingDetector {
  return (context) => {
    const input = lastChord(context.inputs, chords);
    if (!input) return 0;
    if (context.time - input.time <= windowMs && effect(context, input)) return 1;
    return 0.5;
  };
}

/** Every detector must be done at the same sample; progress is the mean. */
export function allOf(...detectors: TrainingDetector[]): TrainingDetector {
  return (context) => {
    const values = detectors.map((detect) => Number(detect(context)));
    return values.every((value) => value >= 1) ? 1 : Math.min(0.99, values.reduce((a, b) => a + b, 0) / values.length);
  };
}

/** World point to world pixel (the same pixel space as GameCommandState.view); a fact of the game's projection. */
export type TrainingProjection = (point: { x: number; y: number; z: number }) => { x: number; y: number };

/** Size of the tactical view in guest pixels, from the native sidebar layout; null while the sidebar is unread. */
export function tacticalSize(state: GameCommandState): { width: number; height: number } | null {
  const sidebar = state.sidebar;
  if (!sidebar) return null;
  const width =
    sidebar.layout.sidebar.x > 0 ? sidebar.layout.sidebar.x : sidebar.frame.width - sidebar.layout.sidebar.width;
  const height = sidebar.layout.commandBar ? sidebar.layout.commandBar.y : sidebar.frame.height;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Pixels between the view origin now and when the task started. */
export function viewTravel(context: TrainingContext): number {
  const a = context.origin.view;
  const b = context.state.view;
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
}

/** True when the world point is drawn inside the tactical view, at least `margin` pixels from its edges. */
export function viewShows(
  state: GameCommandState,
  project: TrainingProjection,
  point: { x: number; y: number; z: number } | null,
  margin = 0,
): boolean {
  const size = tacticalSize(state);
  if (!size || !state.view || !point) return false;
  const pixel = project(point);
  const x = pixel.x - state.view.x;
  const y = pixel.y - state.view.y;
  return x >= margin && y >= margin && x <= size.width - margin && y <= size.height - margin;
}

/** Distance in pixels between the centre of the tactical view and a world point; Infinity when unknown. */
export function viewCentreDistance(
  state: GameCommandState,
  project: TrainingProjection,
  point: { x: number; y: number; z: number } | null,
): number {
  const size = tacticalSize(state);
  if (!size || !state.view || !point) return Infinity;
  const pixel = project(point);
  return Math.hypot(pixel.x - (state.view.x + size.width / 2), pixel.y - (state.view.y + size.height / 2));
}
