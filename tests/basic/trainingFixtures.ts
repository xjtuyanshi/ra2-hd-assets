import type { GameCommandObject, GameCommandState } from '../../src/games/commandState';
import type { GameRenderSidebar } from '../../src/games/renderState';
import type { TrainingInput, TrainingSample } from '../../src/games/training';

/** Synthetic order states and inputs for the lesson engine, detector and lesson tests (no game files involved). */
let uid = 1;
export function unit(fields: Partial<GameCommandObject> = {}): GameCommandObject {
  return {
    uid: uid++,
    kind: 'vehicle',
    type: 'HTNK',
    owner: 0,
    x: 30 * 256,
    y: 100 * 256,
    z: 0,
    health: 1,
    selected: false,
    group: -1,
    mission: 'Guard',
    queuedMission: null,
    target: null,
    destination: null,
    focus: null,
    ...fields,
  };
}

/** A sidebar with only what detectors read: a 1112 x 768 tactical view in a 1280 x 800 frame. */
export function sidebar(fields: Partial<GameRenderSidebar> = {}): GameRenderSidebar {
  return {
    frame: { width: 1280, height: 800 },
    side: 1,
    layout: {
      sidebar: { x: 1112, y: 0, width: 168, height: 768 },
      commandBar: { x: 0, y: 768, width: 1112, height: 32 },
    },
    activeTab: 0,
    tabs: [],
    cameos: [],
    credits: 10000,
    modes: { repair: false, sell: false },
    ...fields,
  } as unknown as GameRenderSidebar;
}

export function state(objects: GameCommandObject[], fields: Partial<GameCommandState> = {}): GameCommandState {
  return {
    frame: 100,
    localHouse: 0,
    view: { x: -2940, y: 1650 },
    objects,
    lastEvent: null,
    sidebar: sidebar(),
    ...fields,
  };
}

export function input(
  code: string,
  time: number,
  mods: Partial<Pick<TrainingInput, 'ctrl' | 'alt' | 'shift'>> = {},
): TrainingInput {
  return { time, code, ctrl: false, alt: false, shift: false, ...mods };
}

export function sample(time: number, value: GameCommandState | null, inputs: TrainingInput[] = []): TrainingSample {
  return { time, state: value, inputs };
}
