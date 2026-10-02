import type { GuestMemory } from '../../vm86/win32';
import type {
  GameRenderCellSprites,
  GameRenderEffects,
  GameRenderObject,
  GameRenderOverlays,
  GameRenderShroud,
  GameRenderSmudges,
  GameRenderState,
  GameRenderSidebar,
  GameRenderStateReader,
} from '../renderState';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_BUILDING_RULES } from './buildingRenderState';
import { YR_BEAMS_GLOBALS, YR_BEAMS_LIMITS } from './beamsReader';
import {
  createYrEffectsReader,
  YR_EFFECTS_GLOBALS,
  YR_EFFECTS_LIMITS,
  type ReadYrEffectsOptions,
  type YrEffects,
} from './effectsReader';
import { createYrOverlayReader, type ReadYrOverlayOptions, type YrOverlays } from './overlayReader';
import { createYrSidebarReader } from './sidebarReader';
import { createYrSmudgeReader, type ReadYrSmudgeOptions, type YrSmudges } from './smudgeReader';
import { createYrShroudReader, type ReadYrShroudOptions, type YrShroud } from './shroudReader';
import {
  YR_STATE_GLOBALS,
  YR_STATE_LIMITS,
  YR_STATE_OFFSETS,
  YR_STATE_VTABLES,
  createYrStateReader,
  isPlausiblePointer,
  readPointerVector,
  type YrObjectState,
  type YrState,
} from './stateReader';

/**
 * YR 1.001 implementation of the game-neutral render-state contract (src/games/renderState.ts) for the HD bridge. It
 * combines the state, shroud, overlay, smudge and effects readers and projects their output onto the fields the external renderer
 * consumes; everything else the readers report (reader statistics, house names, weapon and warhead ids, voxel debris,
 * fire events) stays here. HD bridge only: src/games/yr/runtimeHooks.ts loads this module on demand in development
 * builds.
 *
 * While the HD view is live the bridge polls at most every 15 ms (about 60 Hz; once a second otherwise), and the game
 * logic often advances more slowly than that, so a snapshot is cached and returned again (the identical object) until
 * its change key moves: see readChangeKey.
 */

/** The YR readers a snapshot combines; injectable so the caching and projection can be tested without an image. */
export interface YrRenderStateSources {
  /** A fresh accessor per call: replacing the guest memory detaches older views. */
  memory: () => GuestMemoryAccessor;
  readState: () => YrState | null;
  /** Called on first use inside a battle, because the shroud reader validates tables the loaded image fills in. */
  createShroudReader: () => ((options?: ReadYrShroudOptions) => YrShroud | null) | null;
  createEffectsReader: () => ((options?: ReadYrEffectsOptions) => YrEffects | null) | null;
  createOverlayReader: () => ((options?: ReadYrOverlayOptions) => YrOverlays | null) | null;
  createSmudgeReader: () => ((options?: ReadYrSmudgeOptions) => YrSmudges | null) | null;
  /** Native interface polling is independent of the battlefield change key. */
  createSidebarReader?: () => (() => GameRenderSidebar | null) | null;
  /** Host polling clock only; never changes the guest's clock or logic frame. */
  now?: () => number;
}

/** Both cell decoration layers share this cadence, independently of the logic frame. */
export const YR_OVERLAY_POLL_MS = 250;

/** Guarded factory over the live guest memory; null unless the image is the pinned YR 1.001 build. */
export function createYrRenderStateReader(
  memory: GuestMemory,
  size: number,
  hash: string,
): GameRenderStateReader | null {
  const accessor = () => createByteViewAccessor(memory.read_memory(0, size));
  const readState = createYrStateReader(accessor, hash);
  if (!readState) return null;
  return createYrRenderStateReaderFrom({
    memory: accessor,
    readState: () => readState(),
    createShroudReader: () => createYrShroudReader(accessor, hash),
    createEffectsReader: () => createYrEffectsReader(accessor, hash),
    createOverlayReader: () => createYrOverlayReader(accessor, hash),
    createSmudgeReader: () => createYrSmudgeReader(accessor, hash),
    createSidebarReader: () => createYrSidebarReader(accessor, hash),
  });
}

export function createYrRenderStateReaderFrom(sources: YrRenderStateSources): GameRenderStateReader {
  let readShroud: ReturnType<YrRenderStateSources['createShroudReader']> = null;
  let readEffects: ReturnType<YrRenderStateSources['createEffectsReader']> = null;
  let readOverlays: ReturnType<YrRenderStateSources['createOverlayReader']> = null;
  let readSmudges: ReturnType<YrRenderStateSources['createSmudgeReader']> = null;
  const readSidebar = sources.createSidebarReader?.() ?? null;
  let sidebar: GameRenderSidebar | null = null;
  let sidebarKey = 'null';
  const pollSidebar = () => {
    const next = readSidebar?.() ?? null;
    // Bounded plain data (at most 60 visible slots); exact comparison avoids hash collisions and preserves identity.
    const key = JSON.stringify(next);
    if (key !== sidebarKey) {
      sidebar = next;
      sidebarKey = key;
    }
  };
  const publishSidebar = (snapshot: GameRenderState): GameRenderState => {
    const next = snapshot.map ? sidebar : null;
    return !sources.createSidebarReader || snapshot.sidebar === next ? snapshot : { ...snapshot, sidebar: next };
  };
  let lastKey: number[] | null = null;
  let last: GameRenderState | null = null;
  // The shroud reader fills this result's arrays in place. It is never handed out, so reusing it is safe whether the
  // snapshot is structured-cloned to another thread or used directly on this one.
  let scratch: YrShroud | null = null;
  let shroud: GameRenderShroud | null = null;
  let overlayScratch: YrOverlays | null = null;
  let overlays: GameRenderOverlays | null = null;
  let overlayRevision = 0;
  let smudgeScratch: YrSmudges | null = null;
  let smudges: GameRenderSmudges | null = null;
  let smudgeRevision = 0;
  let lastCellPoll = -Infinity;
  const now = sources.now ?? (() => performance.now());
  return () => {
    pollSidebar();
    const key = readChangeKey(sources.memory);
    const at = now();
    const cellsDue = at - lastCellPoll >= YR_OVERLAY_POLL_MS;
    const unchangedKey = key && lastKey && sameKey(key, lastKey);
    if (last && unchangedKey && (!last.map || !cellsDue)) return (last = publishSidebar(last));
    const state = sources.readState();
    if (!state) {
      last = lastKey = null;
      overlayScratch = overlays = null;
      smudgeScratch = smudges = null;
      lastCellPoll = -Infinity;
      return null;
    }
    let effects: GameRenderEffects | null = null;
    if (state.map) {
      const newBattle =
        !last?.map ||
        state.map.fileName !== last.map.fileName ||
        (key && lastKey && (key[1] !== lastKey[1] || key[0]! < lastKey[0]!));
      if (newBattle) {
        overlayScratch = overlays = null;
        smudgeScratch = smudges = null;
        lastCellPoll = -Infinity;
      }
      if (newBattle || cellsDue) {
        readOverlays ??= sources.createOverlayReader();
        const previousRevision = overlayScratch?.revision;
        overlayScratch = readOverlays?.({ reuse: overlayScratch }) ?? null;
        if (!overlayScratch) overlays = null;
        else if (!overlays || overlayScratch.revision !== previousRevision) {
          overlays = publishCells(overlayScratch, ++overlayRevision);
        }
        readSmudges ??= sources.createSmudgeReader();
        const previousSmudgeRevision = smudgeScratch?.revision;
        smudgeScratch = readSmudges?.({ reuse: smudgeScratch }) ?? null;
        if (!smudgeScratch) smudges = null;
        else if (!smudges || smudgeScratch.revision !== previousSmudgeRevision) {
          smudges = publishCells(smudgeScratch, ++smudgeRevision);
        }
        lastCellPoll = at;
      }
      // A due cell poll need not republish the rest of a paused/unchanged battlefield.
      if (last && !newBattle && unchangedKey && overlays === last.overlays && smudges === last.smudges)
        return (last = publishSidebar(last));
      readShroud ??= sources.createShroudReader();
      readEffects ??= sources.createEffectsReader();
      scratch = readShroud?.({ reuse: scratch }) ?? null;
      shroud = scratch ? publishShroud(scratch, shroud) : null;
      // fireWindow 0 skips the per-techno fire scan: the renderer does not use fire events.
      const read = readEffects?.({ fireWindow: 0 });
      effects = read ? projectEffects(read) : null;
    } else {
      overlayScratch = overlays = null;
      smudgeScratch = smudges = null;
      lastCellPoll = -Infinity;
    }
    last = {
      frame: state.frame,
      view: state.view,
      map: state.map && { fileName: state.map.fileName },
      houses: state.houses.map(({ index, colorIndex }) => ({ index, colorIndex })),
      localHouse: state.localHouse,
      objects: state.objects.map(projectObject),
      shroud: state.map ? shroud : null,
      overlays,
      smudges,
      effects,
    };
    last = publishSidebar(last);
    lastKey = key;
    return last;
  };
}

/** Scratch arrays never escape to a main-thread consumer or a Worker message. Copy only changed publications. */
function publishCells(read: GameRenderCellSprites, revision: number): GameRenderCellSprites {
  return {
    originX: read.originX,
    originY: read.originY,
    width: read.width,
    height: read.height,
    index: read.index.slice(),
    data: read.data.slice(),
    types: read.types.slice(),
    ...(read.rubble && { rubble: read.rubble.map((entry) => ({ ...entry })) }),
    revision,
  };
}

/**
 * What a snapshot depends on, read cheaply: the logic frame, the scenario pointer, the tactical view position,
 * mutable techno render fields, effect objects and native painter lists. The frame counter is incremented only at
 * 0x55DE81; animation AI can change stages before that, and EBolt::Draw halves lifetime at 0x4C2821 independently.
 * A frame number alone must never keep a pre-update death step or an expired beam. Null disables caching on an
 * implausible vector. Type/configuration data is read again whenever one of these live fields changes.
 */
function readChangeKey(memory: () => GuestMemoryAccessor): number[] | null {
  try {
    const m = memory();
    const o = YR_STATE_OFFSETS;
    const technos = readPointerVector(m, YR_STATE_GLOBALS.technos, 4 * YR_STATE_LIMITS.objectsPerKind);
    if (!technos) return null;
    // FNV-1a over bounded native fields; no copied guest memory escapes the reader.
    let hash = 0x811c9dc5;
    const word = (value: number) => {
      hash = Math.imul(hash ^ value, 0x01000193);
    };
    const span = (pointer: number, start: number, end: number) => {
      if (!isPlausiblePointer(m, pointer, end)) throw new Error('unavailable render key');
      for (let at = start; at < end; at += 4) word(m.u32(pointer + at));
    };
    for (const pointer of technos) {
      word(pointer);
      const vtable = m.u32(pointer);
      word(vtable);
      span(pointer, 0x10, 0x14); // UniqueID, including pointer reuse.
      span(pointer, 0x6c, 0xa8); // Health, limbo/selection, location.
      span(pointer, 0xac, 0xb8); // Current/queued mission, including sale reversal.
      span(pointer, 0xf8, 0xfc); // Techno animation stage.
      span(pointer, 0x21c, 0x220); // Owner.
      span(pointer, 0x2b4, 0x2b8); // Target used by the infantry draw-facing branch.
      span(pointer, 0x388, 0x3b8); // Both facing interpolators.
      span(pointer, 0x520, 0x53c); // Building type and current/queued mode.
      span(pointer, 0x674, 0x678); // Locomotor interface.
      span(pointer, 0x694, 0x698); // Building occupants.
      span(pointer, 0x6c0, 0x6c8); // Infantry type/sequence (unit/aircraft type).
      if (vtable === YR_STATE_VTABLES.unit) {
        if (!isPlausiblePointer(m, pointer, o.unitUnloading + 1)) return null;
        word(m.u8(pointer + o.unitUnloading)); // Unloading can change the draw image within the same logic frame.
      }
      if (vtable === YR_STATE_VTABLES.building) span(pointer, 0x6e8, 0x6ec); // HasBuildUp.
    }
    const rules = m.u32(YR_BUILDING_RULES.instance);
    word(rules);
    if (isPlausiblePointer(m, rules, YR_BUILDING_RULES.red + 8))
      span(rules, YR_BUILDING_RULES.yellow, YR_BUILDING_RULES.red + 8);
    // Effects can expire during a draw without a new logic frame. Hash their bounded instance state, including
    // type pointers, stages, visibility flags and attachment pointers. These spans match effectsReader's fields.
    for (const [kind, size] of [
      ['anims', 0x1a0],
      ['bullets', 0x14c],
      ['particleSystems', 0x100],
      ['lasers', 0x58],
      ['electricBolts', 0x30],
    ] as const) {
      const pointers = readPointerVector(m, YR_EFFECTS_GLOBALS[kind], YR_EFFECTS_LIMITS[kind]);
      if (!pointers) return null;
      word(pointers.length);
      for (const pointer of pointers) {
        word(pointer);
        span(pointer, 0, size);
      }
    }
    // RadBeam ages during draw; waves can change endpoints/intensity in another same-frame publication.
    for (const [kind, size] of [
      ['radBeams', 0x80],
      ['waves', 0x1d4],
    ] as const) {
      word(m.u32(YR_BEAMS_GLOBALS[kind] + 8)); // Capacity also participates in beamsReader validation.
      const pointers = readPointerVector(m, YR_BEAMS_GLOBALS[kind], YR_BEAMS_LIMITS[kind]);
      if (!pointers) return null;
      word(pointers.length);
      for (const pointer of pointers) {
        word(pointer);
        span(pointer, 0, size);
      }
    }
    // Layer sorting may finish after the logic frame counter changed. Do not retain a stale registered tie order
    // just because a later poll observes that same frame, including while the match is paused.
    for (let layer = 0; layer < 5; layer++) {
      const pointers = readPointerVector(
        m,
        YR_STATE_GLOBALS.renderLayers + layer * 0x18,
        YR_STATE_LIMITS.objectsPerLayer,
      );
      if (!pointers) return null;
      hash = Math.imul(hash ^ pointers.length, 0x01000193);
      for (const pointer of pointers) hash = Math.imul(hash ^ pointer, 0x01000193);
    }
    const tactical = m.u32(YR_STATE_GLOBALS.tactical);
    const view = isPlausiblePointer(m, tactical, o.tacticalPos + 8);
    return [
      m.i32(YR_STATE_GLOBALS.frame),
      m.u32(YR_STATE_GLOBALS.scenario),
      view ? 1 : 0,
      view ? m.i32(tactical + o.tacticalPos) : 0,
      view ? m.i32(tactical + o.tacticalPos + 4) : 0,
      technos.length,
      hash,
    ];
  } catch {
    return null;
  }
}

function sameKey(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The previous published shroud when nothing changed (no copy), otherwise a copy of the scratch cells. */
function publishShroud(read: YrShroud, previous: GameRenderShroud | null): GameRenderShroud {
  if (
    previous &&
    previous.originX === read.originX &&
    previous.originY === read.originY &&
    previous.width === read.width &&
    previous.height === read.height &&
    previous.cells.length === read.cells.length &&
    previous.cells.every((value, index) => value === read.cells[index])
  )
    return previous;
  // YR_SHROUD_STATE uses the contract's GAME_RENDER_SHROUD values, so the cells are copied unchanged.
  return {
    originX: read.originX,
    originY: read.originY,
    width: read.width,
    height: read.height,
    cells: read.cells.slice(),
  };
}

function projectObject(object: YrObjectState): GameRenderObject {
  const {
    id,
    uid,
    kind,
    type,
    imageType,
    owner,
    x,
    y,
    z,
    facingRaw,
    turretFacingRaw,
    renderOrder,
    buildState,
    buildupFrame,
    buildingFrame,
    buildingDamaged,
    contactUid,
    dock,
    unloading,
    infantrySequence,
    sequenceFrame,
    infantryDrawFacingRaw,
    health,
    isSelected,
  } = object;
  return {
    id,
    uid,
    kind,
    type,
    ...(imageType ? { imageType } : {}),
    owner,
    x,
    y,
    z,
    facingRaw,
    ...(turretFacingRaw !== undefined ? { turretFacingRaw } : {}),
    ...(buildState !== undefined ? { buildState } : {}),
    ...(buildupFrame !== undefined ? { buildupFrame } : {}),
    ...(buildingFrame !== undefined ? { buildingFrame } : {}),
    ...(buildingDamaged !== undefined ? { buildingDamaged } : {}),
    ...(contactUid !== undefined ? { contactUid } : {}),
    ...(dock !== undefined ? { dock } : {}),
    ...(unloading !== undefined ? { unloading } : {}),
    ...(infantrySequence !== undefined ? { infantrySequence } : {}),
    ...(sequenceFrame !== undefined ? { sequenceFrame } : {}),
    ...(infantryDrawFacingRaw !== undefined ? { infantryDrawFacingRaw } : {}),
    ...(renderOrder !== undefined ? { renderOrder: { ...renderOrder } } : {}),
    health,
    isSelected,
  };
}

const point = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z });

function projectEffects(effects: YrEffects): GameRenderEffects {
  return {
    anims: effects.anims.map(
      ({
        id,
        uid,
        type,
        x,
        y,
        z,
        frameCount,
        buildingAnim,
        invisible,
        frame,
        stage,
        translucent,
        translucency,
        flat,
        layer,
        owner,
        attachedTo,
      }) => ({
        id,
        uid,
        type,
        x,
        y,
        z,
        frameCount,
        buildingAnim,
        invisible,
        frame,
        stage,
        translucent,
        translucency,
        flat,
        layer,
        owner,
        attachedTo: attachedTo && { ...attachedTo },
      }),
    ),
    bullets: effects.bullets.map(({ id, uid, x, y, z, inviso, type, frame, velocity }) => ({
      id,
      uid,
      x,
      y,
      z,
      inviso,
      type,
      frame,
      velocity: point(velocity),
    })),
    lasers: effects.lasers.map(({ source, target, innerColor }) => ({
      source: point(source),
      target: point(target),
      innerColor,
    })),
    radBeams: effects.radBeams?.map((beam) => ({
      ...beam,
      source: point(beam.source),
      target: point(beam.target),
      color: [...beam.color],
    })),
    waves: effects.waves?.map((wave) => ({ ...wave, source: point(wave.source), target: point(wave.target) })),
    // EBolt::Draw 0x4C2797..0x4C279C skips lifetime zero even before DrawAll removes the object.
    electricBolts: effects.electricBolts
      .filter((bolt) => bolt.lifetime > 0)
      .map(({ source, target, alternateColor }) => ({
        source: point(source),
        target: point(target),
        alternateColor,
      })),
    particleSystems: effects.particleSystems.map(({ id, uid, behavesLike, x, y, z }) => ({
      id,
      uid,
      behavesLike,
      x,
      y,
      z,
    })),
  };
}
