/**
 * Frame choice for SHP vehicles and aircraft (terror drone, giant squid, dolphin): TS-style directional SHPs whose
 * frames are laid out in blocks per state, each block holding `count` frames for every facing. Pure (no three.js), so
 * it is unit-tested directly.
 *
 * Layout (art keys, defaults as the engine reads them and as the Chrono Divide-derived reference
 * huangkaoya/ts-redalert2 src/engine/renderable/entity/ObjectArt.ts documents them):
 *   F = Facings (8)             W = WalkFrames (0)          S = StandingFrames (1)        FF = FiringFrames (0)
 *   StartWalkFrame (0)          StartStandFrame (W * F)     StartFiringFrame ((W + S) * F)
 *   frame = start + count * shpVehicleDirection(facing, F) + step mod count
 * The terror drone (W 6, FF 4, 88 body frames) therefore walks on 0..47, stands on 48..55 and fires on 56..87.
 *
 * Direction order: unlike infantry (counter-clockwise from screen-up, art.ts facingFrame), SHP vehicle frames run
 * CLOCKWISE from screen-up (map north-west), so map north is direction 1 (shpVehicleDirection). Measured on frozen
 * same-moment live pairs: every DRON body frame scored against the engine framebuffer at the drone's draw point (luma
 * correlation over the frame's opaque pixels, best offset within 4 px) picked direction 1 for facing 0 (twice, 0.71 and
 * 0.60) and direction 2 for facings 32 and 40 (0.97 and 0.95); the infantry order gave 7 and 6, the reverse.
 *
 * Idle animation: rules IdleRate > 0 (giant squid 4, dolphin 8) keeps playing the walk frames while the unit stands,
 * so swimming animals never freeze; WalkRate (default 1) is the logic frames per walk step.
 */
import type { LibraryShpUnit } from '../../../ra2-assets/src/library';
import { facingFrame } from '../../../ra2-assets/src/art';

export type ShpUnitState = 'stand' | 'walk' | 'fire';

/** Rules timing of an SHP unit (not in the type library; the effects sidecar records it). */
export interface ShpUnitRates {
  /** Logic frames per walk step (rules WalkRate, default 1). */
  walkRate?: number;
  /** Logic frames per idle step through the walk frames (rules IdleRate, 0 = stands still). */
  idleRate?: number;
}

interface Block {
  start: number;
  count: number;
}

/** Frame blocks of one SHP unit, from its art keys with the engine defaults. */
export function shpUnitBlocks(u: LibraryShpUnit): { facings: number; walk: Block; stand: Block; fire: Block } {
  const f = Math.max(1, u.facings || 8);
  const k = u.frames;
  const walkFrames = Math.max(0, k.WalkFrames ?? 0);
  const standFrames = Math.max(0, k.StandingFrames ?? 1);
  const fireFrames = Math.max(0, k.FiringFrames ?? 0);
  return {
    facings: f,
    walk: { start: k.StartWalkFrame ?? 0, count: walkFrames },
    stand: { start: k.StartStandFrame ?? walkFrames * f, count: standFrames },
    fire: { start: k.StartFiringFrame ?? (walkFrames + standFrames) * f, count: fireFrames },
  };
}

/**
 * Body frame of an SHP unit for engine facing `facing8` (0..255, 0 = north, clockwise) in `state` at animation step
 * `step`. States without frames fall back to standing (and standing without frames to the walk block).
 */
export function shpUnitFrame(u: LibraryShpUnit, facing8: number, state: ShpUnitState, step: number): number {
  const blocks = shpUnitBlocks(u);
  let block = blocks[state];
  if (block.count <= 0) block = blocks.stand.count > 0 ? blocks.stand : blocks.walk;
  const count = Math.max(1, block.count);
  const dir = shpVehicleDirection(facing8, blocks.facings);
  return block.start + count * dir + (((Math.floor(step) % count) + count) % count);
}

/**
 * Direction block of an SHP vehicle for engine facing `facing8` (0..255, 0 = north, clockwise) with `facings` directions:
 * clockwise from screen-up, the mirror of the infantry order (see the module notes).
 */
export function shpVehicleDirection(facing8: number, facings: number): number {
  const n = Math.max(1, facings);
  return (n - facingFrame(facing8, n)) % n;
}

/**
 * State and step of an SHP unit at logic frame `frame`: walking (moved within the last logic frames) steps every
 * WalkRate frames, a standing unit with an IdleRate keeps cycling its walk frames at that rate, otherwise it stands.
 * `firing` (a fire event of this unit within its firing frames) wins over both.
 */
export function shpUnitPose(
  u: LibraryShpUnit,
  rates: ShpUnitRates | undefined,
  frame: number,
  moving: boolean,
  firingSince: number | null,
): { state: ShpUnitState; step: number } {
  const blocks = shpUnitBlocks(u);
  if (firingSince !== null && blocks.fire.count > 0 && frame - firingSince < blocks.fire.count)
    return { state: 'fire', step: frame - firingSince };
  const walkRate = Math.max(1, rates?.walkRate ?? 1);
  if (moving && blocks.walk.count > 0) return { state: 'walk', step: Math.floor(frame / walkRate) };
  const idleRate = rates?.idleRate ?? 0;
  if (idleRate > 0 && blocks.walk.count > 0) return { state: 'walk', step: Math.floor(frame / idleRate) };
  return { state: 'stand', step: 0 };
}
