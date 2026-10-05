import type { GameRenderLighting, GameRenderLightSource } from '../renderState';
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

/**
 * LightSourceClass instances (YR 1.001). The cell relight at 0x484180 walks this vector (items 0x48428B, count
 * 0x48427D), skips a light whose Activated byte is clear (0x484294) or whose DetailLevel exceeds the game's detail
 * setting (0x48429F..0x4842AA), and takes the centre from +0x38/+0x3C (0x4842E2), the reach from +0x44 (0x4842F0),
 * the intensity from +0x24 (0x4843BA) and the RGB tint from +0x28/+0x2C/+0x30 (0x4843DD/0x4843FE/0x48441F), all
 * per-mille integers. The constructor 0x554760 fills the same fields and sets the vtable; BuildingClass creates one
 * per building whose type has LightIntensity != 0 (0x440D6C) and switches it on (0x554A60).
 */
export const YR_LIGHT_SOURCES = Object.freeze({
  /** DynamicVectorClass<LightSourceClass*>: Items pointer and Count. */
  items: 0xabca14,
  count: 0xabca20,
  /** Game detail setting compared with each light's DetailLevel (the same global as YR_NATIVE_DETAIL.level). */
  detailLevel: 0xa8eb78,
  vtable: 0x7ed028,
  intensity: 0x24,
  tint: 0x28,
  detail: 0x34,
  position: 0x38,
  radius: 0x44,
  activated: 0x48,
  size: 0x4c,
  /** More lights than any map places; a larger count is a bad read. */
  maxCount: 4096,
});

/**
 * The light sources the engine applies now, or undefined when the vector cannot be read plausibly (the caller then
 * keeps whatever it knows from the map). Lights that are switched off or gated by the detail setting are left out,
 * as the cell relight leaves them out.
 */
export function readYrLightSources(
  memory: GuestMemoryAccessor,
  detailLevel?: number,
): GameRenderLightSource[] | undefined {
  const c = YR_LIGHT_SOURCES;
  const view = (address: number, length: number): DataView | null => {
    if (!Number.isInteger(address) || address < 0 || address + length > memory.size) return null;
    const bytes = memory.bytes(address, length);
    return bytes.length === length ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  };
  try {
    const head = view(c.items, c.count - c.items + 4);
    if (!head) return undefined;
    const items = head.getUint32(0, true);
    const count = head.getInt32(c.count - c.items, true);
    // The render-state poll samples the detail globals once and hands the level in; read it here only without one.
    const detail = detailLevel ?? view(c.detailLevel, 4)?.getInt32(0, true);
    if (detail === undefined || !integerIn(count, 0, c.maxCount) || !integerIn(detail, 0, 3)) return undefined;
    if (count === 0) return [];
    if (!isPlausiblePointer(memory, items, count * 4)) return undefined;
    const pointers = view(items, count * 4);
    if (!pointers) return undefined;
    const sources: GameRenderLightSource[] = [];
    for (let index = 0; index < count; index++) {
      const pointer = pointers.getUint32(index * 4, true);
      if (!isPlausiblePointer(memory, pointer, c.size)) return undefined;
      const light = view(pointer, c.size);
      if (!light || light.getUint32(0, true) !== c.vtable) return undefined;
      const activated = light.getUint8(c.activated);
      const level = light.getInt32(c.detail, true);
      // (DetailLevel is 2 for every light the constructor makes; the game's setting runs 0..2.)
      const intensity = light.getInt32(c.intensity, true);
      const tint = [0, 4, 8].map((offset) => light.getInt32(c.tint + offset, true)) as [number, number, number];
      const position = [0, 4, 8].map((offset) => light.getInt32(c.position + offset, true));
      const radius = light.getInt32(c.radius, true);
      // A type that sets LightIntensity without tints keeps the constructor's 1000.0 (per-mille 1000000).
      if (
        !integerIn(activated, 0, 1) ||
        !integerIn(level, 0, 3) ||
        !integerIn(intensity, -100000, 100000) ||
        !tint.every((channel) => integerIn(channel, -10000000, 10000000)) ||
        !position.every((value) => integerIn(value, -0x1000000, 0x1000000)) ||
        !integerIn(radius, -0x1000000, 0x1000000)
      )
        return undefined;
      if (activated === 0 || detail < level) continue;
      sources.push({
        x: position[0]!,
        y: position[1]!,
        z: position[2]!,
        radius,
        intensity: intensity / 1000,
        tint: [tint[0] / 1000, tint[1] / 1000, tint[2] / 1000],
      });
    }
    return sources;
  } catch {
    return undefined;
  }
}

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
export function readYrSceneLighting(memory: GuestMemoryAccessor, detailLevel?: number): GameRenderLighting | null {
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
    const decoded = decodeYrSceneLighting(words, {
      stormActive: statics.getUint8(c.stormActive - c.timewarpState),
      stormEnding: statics.getUint8(c.stormEnding - c.timewarpState),
      stormDeferment: statics.getInt32(c.stormDeferment - c.timewarpState, true),
      stormCellX: cell.getInt16(0, true),
      stormCellY: cell.getInt16(2, true),
      nukeState: statics.getInt32(c.nukeState - c.timewarpState, true),
      dominatorState: statics.getInt32(c.dominatorState - c.timewarpState, true),
      timewarpState: statics.getInt32(0, true),
    });
    if (!decoded) return null;
    // Optional and independent: an unreadable light vector leaves the scene values valid and the sources unknown.
    const sources = readYrLightSources(memory, detailLevel);
    return sources ? { ...decoded, sources } : decoded;
  } catch {
    return null;
  }
}
