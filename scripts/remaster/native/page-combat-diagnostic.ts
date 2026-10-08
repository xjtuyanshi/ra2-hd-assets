import {
  createYrEffectsReader,
  readYrEffects,
  YR_EFFECTS_GLOBALS,
  YR_EFFECTS_OFFSETS,
  YR_EFFECTS_VTABLES,
  YR_GET_COORDS,
  YR_GET_COORDS_SLOT,
} from '../../../src/games/yr/effectsReader';
import { YR_STATE_VTABLES } from '../../../src/games/yr/stateReader';
import { readYrObjectCoords } from '../../../src/games/yr/objectCoords';
import { YR_STARTUP_PAGE_HASH } from '../../../src/games/yr/startupPage';
import type { GuestMemoryAccessor } from '../../../src/games/shared/memoryAccessor';
import type { GameRenderState } from '../../../src/games/renderState';

/** Read-only evidence from the same complete mirror as the actual page readers. */
export function readPageCombatDiagnostic(memory: GuestMemoryAccessor, render: GameRenderState | null) {
  const startedAt = performance.now();
  const frame = memory.i32(YR_EFFECTS_GLOBALS.frame);
  const vectorCounts = Object.fromEntries(
    Object.entries(YR_EFFECTS_GLOBALS)
      .filter(([name]) => !['frame'].includes(name))
      .map(([name, address]) => [name, memory.i32(address + 0x10)]),
  );
  let factoryAvailable: boolean | null = null;
  let factoryError: string | null = null;
  try {
    factoryAvailable = createYrEffectsReader(() => memory, YR_STARTUP_PAGE_HASH) !== null;
  } catch (error) {
    factoryError = String(error);
  }
  const raw = readYrEffects(memory, { fireWindow: 60 });
  const guardSlots = Object.fromEntries(
    [
      ['anim', YR_EFFECTS_VTABLES.anim, YR_GET_COORDS.anim],
      ['building', YR_STATE_VTABLES.building, YR_GET_COORDS.building],
      ['unit', YR_STATE_VTABLES.unit, YR_GET_COORDS.object],
      ['cell', YR_EFFECTS_VTABLES.cell, YR_GET_COORDS.cell],
    ].map(([name, vtable, expected]) => [
      name,
      { expected, actual: memory.u32((vtable as number) + YR_GET_COORDS_SLOT) },
    ]),
  );
  const guardHeads = Object.fromEntries(
    Object.entries(YR_EFFECTS_VTABLES).map(([name, address]) => [name, memory.u32(address)]),
  );
  const animTypes: Record<string, number> = {};
  for (const anim of raw.anims) animTypes[anim.type] = (animTypes[anim.type] ?? 0) + 1;
  const fires = raw.fires.map((fire) => ({
    ...fire,
    ageFrames: frame - fire.frame,
    sourcePosition: readYrObjectCoords(memory, fire.id),
    rawLocation: {
      x: memory.i32(fire.id + YR_EFFECTS_OFFSETS.location),
      y: memory.i32(fire.id + YR_EFFECTS_OFFSETS.location + 4),
      z: memory.i32(fire.id + YR_EFFECTS_OFFSETS.location + 8),
    },
  }));
  return {
    frame,
    renderFrame: render?.frame ?? null,
    renderEffectsAvailable: render?.effects != null,
    renderCounts: render?.effects
      ? Object.fromEntries(Object.entries(render.effects).map(([name, values]) => [name, values?.length ?? 0]))
      : null,
    factoryAvailable,
    factoryError,
    guardSlots,
    guardHeads,
    vectorCounts,
    stats: raw.stats,
    rawCounts: {
      anims: raw.anims.length,
      bullets: raw.bullets.length,
      lasers: raw.lasers.length,
      electricBolts: raw.electricBolts.length,
      particleSystems: raw.particleSystems.length,
      fires: raw.fires.length,
    },
    animTypes,
    fires,
    ms: performance.now() - startedAt,
  };
}
