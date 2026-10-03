import type { GameRenderLighting } from '../renderState';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { isPlausiblePointer, YR_STATE_GLOBALS } from './stateReader';

/** YR 1.001 instruction evidence is expanded in docs/remaster/research/yr-scene-lighting.md. */
export const YR_SCENE_LIGHTING = Object.freeze({
  /** ScenarioClass int32 span: base ambient through DominatorLevel, inclusive. */
  wordsStart: 0x3528,
  wordsEnd: 0x3594,
  /** 0x539FA9 writes active; 0x53A8DD clears it. Pending deferment is a separate state. */
  stormActive: 0xa9fab4,
  /** 0x53A099 / 0x53A935 request the end; existing clouds are allowed to finish. */
  stormEnding: 0xa9fad0,
  /** 0x539F70 stores deferment; 0x53AAAD decrements it. */
  stormDeferment: 0xa9fab8,
  /** 0x53AA10 / 0x53AA21 read signed CellStruct coordinates. */
  stormCell: 0xa9f9cc,
  /** 0x53AB81 sets 1 (flash); 0x53A6C0 advances to 2 (recovery), then 0. */
  nukeState: 0xa9fabc,
  /** 0x53AF40 dispatches states 0..5; 5 restores palette while ambient recovers. */
  dominatorState: 0xa9fac0,
  /** 0x53C290 tests nonzero; TimeWarp identity is inferred from the sound key used at 0x53B52B. */
  timewarpState: 0xa9fab0,
});

/** Native values, kept numeric so corrupt booleans and states can be rejected rather than coerced. */
export interface YrSceneLightingStatics {
  stormActive: number;
  stormEnding: number;
  stormDeferment: number;
  stormCellX: number;
  stormCellY: number;
  nukeState: number;
  dominatorState: number;
  timewarpState: number;
}

const integerIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

/**
 * Decode contiguous int32 words at Scenario+0x3528..0x3590. This is the bulk palette policy at 0x53C280,
 * with the independent incremental cell-relight height policy at 0x4846C0. No inferred timing or target fade.
 */
export function decodeYrSceneLighting(
  words: ArrayLike<number>,
  state: YrSceneLightingStatics,
): GameRenderLighting | null {
  if (
    words.length < (YR_SCENE_LIGHTING.wordsEnd - YR_SCENE_LIGHTING.wordsStart) / 4 ||
    !integerIn(state.stormActive, 0, 1) ||
    !integerIn(state.stormEnding, 0, 1) ||
    !integerIn(state.stormDeferment, -1, 0x7fffffff) ||
    !integerIn(state.nukeState, 0, 2) ||
    !integerIn(state.dominatorState, 0, 5) ||
    !integerIn(state.timewarpState, -0x80000000, 0x7fffffff) ||
    !integerIn(state.stormCellX, -0x8000, 0x7fff) ||
    !integerIn(state.stormCellY, -0x8000, 0x7fff)
  )
    return null;
  const active = state.stormActive === 1;
  const pending = state.stormDeferment > 0;
  // Inactive storm coordinates may contain the engine's empty CellStruct sentinel. An active/pending target
  // must fit the MapClass cell axes (or their negative sentinel), never a random signed-short pair.
  if ((active || pending) && (!integerIn(state.stormCellX, -512, 511) || !integerIn(state.stormCellY, -512, 511)))
    return null;
  const word = (offset: number) => words[(offset - YR_SCENE_LIGHTING.wordsStart) / 4]!;
  const rgb = (offset: number): [number, number, number] => [word(offset), word(offset + 4), word(offset + 8)];
  const ambient = word(0x352c);
  const tint = rgb(0x3534);
  // Palette priority and cell-height priority intentionally differ when events overlap. Nuke flash wins the
  // palette over TimeWarp when both are present; both branches select the same raw Nuke RGB (0x53C280..297).
  const event: GameRenderLighting['event'] =
    state.nukeState === 1
      ? 'nuke'
      : state.timewarpState !== 0
        ? 'timewarp'
        : active
          ? 'storm'
          : state.dominatorState >= 1 && state.dominatorState <= 4
            ? 'dominator'
            : null;
  const override =
    event === 'nuke' || event === 'timewarp'
      ? rgb(0x3564)
      : event === 'storm'
        ? rgb(0x354c)
        : event === 'dominator'
          ? rgb(0x3580)
          : null;
  const groundAt = active ? 0x3558 : state.dominatorState !== 0 ? 0x358c : state.nukeState === 1 ? 0x3570 : 0x3540;
  const ground = word(groundAt);
  const level = word(groundAt + 4);
  // Generous mod-compatible bounds reject pointers/garbage without treating a legitimate zero as unknown.
  // The decoder does not clamp authored/event RGB: palette clamp/quantization is a separate engine layer.
  if (
    ![ambient, ...tint, ...(override ?? [])].every((value) => integerIn(value, 0, 1000)) ||
    !integerIn(ground, -10000, 10000) ||
    !integerIn(level, -10000, 10000)
  )
    return null;
  return {
    ambient: ambient / 100,
    ground: ground / 1000,
    level: level / 1000,
    tint: [tint[0] / 100, tint[1] / 100, tint[2] / 100],
    override: override && [override[0] / 100, override[1] / 100, override[2] / 100],
    event,
    storm: {
      active,
      pending,
      ending: state.stormEnding === 1,
      cell: { x: state.stormCellX, y: state.stormCellY },
    },
  };
}

/**
 * Pure read over a supplied accessor; the render-state factory owns executable-version validation. Exact byte
 * spans preserve unavailable versus zero despite GuestMemoryAccessor's scalar methods using zero on failure.
 */
export function readYrSceneLighting(memory: GuestMemoryAccessor): GameRenderLighting | null {
  const read = (address: number, length: number): DataView | null => {
    if (!Number.isInteger(address) || address < 0 || address + length > memory.size) return null;
    const bytes = memory.bytes(address, length);
    return bytes.length === length ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  };
  try {
    const pointerBytes = read(YR_STATE_GLOBALS.scenario, 4);
    if (!pointerBytes) return null;
    const scenario = pointerBytes.getUint32(0, true);
    if (!isPlausiblePointer(memory, scenario, YR_SCENE_LIGHTING.wordsEnd)) return null;
    const c = YR_SCENE_LIGHTING;
    const lighting = read(scenario + c.wordsStart, c.wordsEnd - c.wordsStart);
    const statics = read(c.timewarpState, c.stormEnding - c.timewarpState + 1);
    const cell = read(c.stormCell, 4);
    if (!lighting || !statics || !cell) return null;
    const words = Array.from({ length: lighting.byteLength / 4 }, (_, index) => lighting.getInt32(index * 4, true));
    return decodeYrSceneLighting(words, {
      stormActive: statics.getUint8(c.stormActive - c.timewarpState),
      stormEnding: statics.getUint8(c.stormEnding - c.timewarpState),
      stormDeferment: statics.getInt32(c.stormDeferment - c.timewarpState, true),
      stormCellX: cell.getInt16(0, true),
      stormCellY: cell.getInt16(2, true),
      nukeState: statics.getInt32(c.nukeState - c.timewarpState, true),
      dominatorState: statics.getInt32(c.dominatorState - c.timewarpState, true),
      timewarpState: statics.getInt32(0, true),
    });
  } catch {
    return null;
  }
}
