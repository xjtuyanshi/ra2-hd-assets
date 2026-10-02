import { foundationPointPush } from './cardDepth';
import { comparePainterOrder, type PainterObject } from './painterOrder';

/** Logic frames without an observed position change before a unit can clear low dock/pad art. */
export const DOCK_SETTLE_FRAMES = 6;
/** Camera-space world units above the sampled ground footprint, bounded independently of nearby building count. */
export const DOCK_PULL_MARGIN = 0.5;
export const DOCK_PULL_MAX = 3.5;

const EMPTY_BUILDINGS: readonly PainterObject[] = [];

/**
 * Native same-layer traversal draws a later unit over the building's low pad/dish art. YR also tests units against
 * BUILDNGZ.SHA Z shapes, which we do not decode; the analytic front-facade ramp reaches too far forward for that art.
 * A live War Miner at refinery NW (51,101), foundation [4,3], anchor (54.5,102.5) lost its tipped bin at every dock.
 * Replay needed about three cells of pull: sample the exact anchor and its four one-cell axial offsets for facade
 * height, then add 0.5 for the model above ground. Take the largest building pull, capped at 3.5, never a sum.
 * Only layer-2 units strictly inside a foundation and stationary for at least six logic frames qualify. Outside
 * units already stand physically in front; moving units leaving a war-factory door must remain behind its facade
 * as in native drawing. While active, the pull can put a screen-overlapping unit passing within about three cells
 * in front of the docked unit behind it instead. This trades that transient overlap for the permanent cut-off bin.
 * Callers select visible voxel units and visible buildings, excluding building turrets, projectiles and effects.
 */
export function dockPull(
  unit: PainterObject,
  anchor: { x: number; z: number },
  stationaryFrames: number,
  buildings: readonly PainterObject[] = EMPTY_BUILDINGS,
): number {
  if (unit.layer !== 2 || unit.foundation || stationaryFrames < DOCK_SETTLE_FRAMES) return 0;
  let pull = 0;
  for (const building of buildings) {
    const foundation = building.foundation;
    if (building.layer !== 2 || !foundation) continue;
    const [w, h] = foundation;
    if (
      w > 0 &&
      h > 0 &&
      unit.x >= building.x &&
      unit.x < building.x + w &&
      unit.z >= building.z &&
      unit.z < building.z + h &&
      comparePainterOrder(unit, building) > 0
    ) {
      const x = anchor.x - building.x;
      const z = anchor.z - building.z;
      const push = Math.max(
        0,
        foundationPointPush(x, z, w, h),
        foundationPointPush(x - 1, z, w, h),
        foundationPointPush(x + 1, z, w, h),
        foundationPointPush(x, z - 1, w, h),
        foundationPointPush(x, z + 1, w, h),
      );
      pull = Math.max(pull, Math.min(DOCK_PULL_MAX, push + DOCK_PULL_MARGIN));
    }
  }
  return pull;
}

/** Build once per painter refresh; each anchor query scans only buildings whose foundations cover that cell. */
export function bucketDockBuildings(buildings: Iterable<PainterObject>): Map<number, Map<number, PainterObject[]>> {
  const cells = new Map<number, Map<number, PainterObject[]>>();
  for (const building of buildings) {
    if (building.layer !== 2 || !building.foundation) continue;
    const [w, h] = building.foundation;
    if (w <= 0 || h <= 0) continue;
    for (let x = building.x; x < building.x + w; x++) {
      let column = cells.get(x);
      if (!column) cells.set(x, (column = new Map()));
      for (let z = building.z; z < building.z + h; z++) {
        let bucket = column.get(z);
        if (!bucket) column.set(z, (bucket = []));
        bucket.push(building);
      }
    }
  }
  return cells;
}
