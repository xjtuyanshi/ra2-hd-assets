import { foundationPointPush } from './cardDepth';
import { comparePainterOrder, type PainterObject } from './painterOrder';

/** Camera-space world units above the sampled ground footprint, independent of nearby building count. */
export const DOCK_PULL_MARGIN = 0.5;
export const DOCK_PULL_MAX = 3.5;

/**
 * Clear a contacted host's low pad while preserving its native traversal condition. Missing contact/host policy
 * disables the approximation. A delivering host keeps units behind its facade, even if it also services units.
 * Sample the exact anchor and four one-cell axial neighbours; backing-in anchors may be one cell outside the
 * foundation. No motion/settling gate: low pad art must not cut off a unit while it backs into the dock.
 */
export function dockPull(unit: PainterObject, anchor: { x: number; z: number }, host?: PainterObject): number {
  if (
    unit.layer !== 2 ||
    unit.foundation ||
    unit.contactUid === undefined ||
    !host ||
    host.uid !== unit.contactUid ||
    host.layer !== 2 ||
    host.dock !== true ||
    host.unloading !== undefined ||
    !host.foundation ||
    comparePainterOrder(unit, host) <= 0
  )
    return 0;
  const [w, h] = host.foundation;
  const x = anchor.x - host.x;
  const z = anchor.z - host.z;
  if (w <= 0 || h <= 0 || !Number.isFinite(x) || !Number.isFinite(z) || x < -1 || x >= w + 1 || z < -1 || z >= h + 1)
    return 0;
  const push = Math.max(
    0,
    foundationPointPush(x, z, w, h),
    foundationPointPush(x - 1, z, w, h),
    foundationPointPush(x + 1, z, w, h),
    foundationPointPush(x, z - 1, w, h),
    foundationPointPush(x, z + 1, w, h),
  );
  return Math.min(DOCK_PULL_MAX, push + DOCK_PULL_MARGIN);
}

export interface DockPullUnit {
  painter: PainterObject;
  /** Exact ground anchor in cells, not the floored painter/foundation coordinate. */
  anchor: { x: number; z: number };
}

/**
 * Preserve native order for nearby passing ground units. Sources are only directly docked units, so propagation
 * cannot cascade through a crowd. Callers exclude buildings, aircraft, effects and projectiles from candidates.
 */
export function propagateDockPull(units: Iterable<DockPullUnit>, docked: readonly DockPullUnit[]): void {
  for (const unit of units) {
    const u = unit.painter;
    if (u.layer !== 2 || u.foundation || docked.some((d) => d.painter === u)) continue;
    for (const source of docked) {
      const d = source.painter;
      if (
        comparePainterOrder(u, d) <= 0 ||
        Math.max(Math.abs(unit.anchor.x - source.anchor.x), Math.abs(unit.anchor.z - source.anchor.z)) > 3
      )
        continue;
      const delta = unit.anchor.x + unit.anchor.z - source.anchor.x - source.anchor.z;
      u.pull = Math.max(u.pull ?? 0, 0, (d.pull ?? 0) - delta * Math.sqrt(3 / 8) + 0.05);
    }
  }
}
