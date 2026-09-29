import type { GuestMemory } from '../../vm86/win32';
import type {
  GameRenderEffects,
  GameRenderObject,
  GameRenderOverlays,
  GameRenderShroud,
  GameRenderState,
  GameRenderStateReader,
} from '../renderState';
import { createByteViewAccessor, type GuestMemoryAccessor } from '../shared/memoryAccessor';
import { createYrEffectsReader, type ReadYrEffectsOptions, type YrEffects } from './effectsReader';
import { createYrOverlayReader, type ReadYrOverlayOptions, type YrOverlays } from './overlayReader';
import { createYrShroudReader, type ReadYrShroudOptions, type YrShroud } from './shroudReader';
import {
  YR_STATE_GLOBALS,
  YR_STATE_LIMITS,
  YR_STATE_OFFSETS,
  createYrStateReader,
  isPlausiblePointer,
  readPointerVector,
  type YrObjectState,
  type YrState,
} from './stateReader';

/**
 * YR 1.001 implementation of the game-neutral render-state contract (src/games/renderState.ts) for the HD bridge. It
 * combines the state, shroud, overlay and effects readers and projects their output onto the fields the external renderer
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
  /** Host polling clock only; never changes the guest's clock or logic frame. */
  now?: () => number;
}

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
  });
}

export function createYrRenderStateReaderFrom(sources: YrRenderStateSources): GameRenderStateReader {
  let readShroud: ReturnType<YrRenderStateSources['createShroudReader']> = null;
  let readEffects: ReturnType<YrRenderStateSources['createEffectsReader']> = null;
  let readOverlays: ReturnType<YrRenderStateSources['createOverlayReader']> = null;
  let lastKey: number[] | null = null;
  let last: GameRenderState | null = null;
  // The shroud reader fills this result's arrays in place. It is never handed out, so reusing it is safe whether the
  // snapshot is structured-cloned to another thread or used directly on this one.
  let scratch: YrShroud | null = null;
  let shroud: GameRenderShroud | null = null;
  let overlayScratch: YrOverlays | null = null;
  let overlays: GameRenderOverlays | null = null;
  let overlayRevision = 0;
  let lastOverlayPoll = -Infinity;
  const now = sources.now ?? (() => performance.now());
  return () => {
    const key = readChangeKey(sources.memory);
    const at = now();
    const overlayDue = at - lastOverlayPoll >= YR_OVERLAY_POLL_MS;
    const unchangedKey = key && lastKey && sameKey(key, lastKey);
    if (last && unchangedKey && (!last.map || !overlayDue)) return last;
    const state = sources.readState();
    if (!state) {
      last = lastKey = null;
      overlayScratch = overlays = null;
      lastOverlayPoll = -Infinity;
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
        lastOverlayPoll = -Infinity;
      }
      if (newBattle || overlayDue) {
        readOverlays ??= sources.createOverlayReader();
        const previousRevision = overlayScratch?.revision;
        overlayScratch = readOverlays?.({ reuse: overlayScratch }) ?? null;
        if (!overlayScratch) overlays = null;
        else if (!overlays || overlayScratch.revision !== previousRevision) {
          overlays = publishOverlays(overlayScratch, ++overlayRevision);
        }
        lastOverlayPoll = at;
      }
      // A due overlay poll need not republish the rest of a paused/unchanged battlefield.
      if (last && !newBattle && unchangedKey && overlays === last.overlays) return last;
      readShroud ??= sources.createShroudReader();
      readEffects ??= sources.createEffectsReader();
      scratch = readShroud?.({ reuse: scratch }) ?? null;
      shroud = scratch ? publishShroud(scratch, shroud) : null;
      // fireWindow 0 skips the per-techno fire scan: the renderer does not use fire events.
      const read = readEffects?.({ fireWindow: 0 });
      effects = read ? projectEffects(read) : null;
    } else {
      overlayScratch = overlays = null;
      lastOverlayPoll = -Infinity;
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
      effects,
    };
    lastKey = key;
    return last;
  };
}

/** Scratch arrays never escape to a main-thread consumer or a Worker message. Copy only changed publications. */
function publishOverlays(read: YrOverlays, revision: number): GameRenderOverlays {
  return {
    originX: read.originX,
    originY: read.originY,
    width: read.width,
    height: read.height,
    index: read.index.slice(),
    data: read.data.slice(),
    types: read.types.slice(),
    revision,
  };
}

/**
 * What a snapshot depends on, read cheaply: the logic frame, the scenario pointer, the tactical view position, and
 * every techno pointer with its selection flag. Objects, shroud and effects move with the game logic, which advances
 * the frame counter; the view and the selection are in the key as well, so a scroll or a selection change is never
 * hidden behind a frame counter that stands still (for example while the logic is paused). Null (no caching for this
 * poll) when the techno vector is not plausible.
 */
function readChangeKey(memory: () => GuestMemoryAccessor): number[] | null {
  try {
    const m = memory();
    const o = YR_STATE_OFFSETS;
    const technos = readPointerVector(m, YR_STATE_GLOBALS.technos, 4 * YR_STATE_LIMITS.objectsPerKind);
    if (!technos) return null;
    // FNV-1a over (pointer, selected) pairs.
    let hash = 0x811c9dc5;
    for (const pointer of technos) {
      const selected = isPlausiblePointer(m, pointer, o.isSelected + 1) ? m.u8(pointer + o.isSelected) : 0;
      hash = Math.imul(hash ^ pointer, 0x01000193);
      hash = Math.imul(hash ^ selected, 0x01000193);
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
  const { id, uid, kind, type, owner, x, y, z, facingRaw, turretFacingRaw, health, isSelected } = object;
  return {
    id,
    uid,
    kind,
    type,
    owner,
    x,
    y,
    z,
    facingRaw,
    ...(turretFacingRaw !== undefined ? { turretFacingRaw } : {}),
    health,
    isSelected,
  };
}

const point = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z });

function projectEffects(effects: YrEffects): GameRenderEffects {
  return {
    anims: effects.anims.map(({ id, uid, type, x, y, z, frameCount, buildingAnim, invisible }) => ({
      id,
      uid,
      type,
      x,
      y,
      z,
      frameCount,
      buildingAnim,
      invisible,
    })),
    bullets: effects.bullets.map(({ id, uid, x, y, z, inviso }) => ({ id, uid, x, y, z, inviso })),
    lasers: effects.lasers.map(({ source, target, innerColor }) => ({
      source: point(source),
      target: point(target),
      innerColor,
    })),
    electricBolts: effects.electricBolts.map(({ source, target, alternateColor }) => ({
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
