import { comparePainterOrder, type PainterObject } from './painterOrder';

/** Camera-space world units: one cell, applied once rather than accumulated across nearby buildings. */
export const DOCK_PULL = 1.0;

const EMPTY_BUILDINGS: readonly PainterObject[] = [];

/**
 * Native same-layer traversal draws a later unit over the building's low pad/dish art. YR also tests units against
 * BUILDNGZ.SHA Z shapes, which we do not decode; the analytic front-facade ramp reaches too far forward for that art.
 * A live War Miner docked at the Soviet refinery lost its bin to that ramp although native drawing covered the dish.
 * Only layer-2 units inside the foundation or its one-cell +x/+z front band qualify, using the real NW cell rather
 * than the sprite's draw point. One cell of pull cannot jump past a southern building's facade at least one more
 * cell ahead. This bounded approximation does not reconstruct per-art Z shapes; callers select visible voxel units
 * and visible buildings, excluding building turrets, projectiles and effects.
 */
export function dockPull(unit: PainterObject, buildings: readonly PainterObject[] = EMPTY_BUILDINGS): number {
  if (unit.layer !== 2 || unit.foundation) return 0;
  for (const building of buildings) {
    const foundation = building.foundation;
    if (building.layer !== 2 || !foundation) continue;
    const [w, h] = foundation;
    if (
      w > 0 &&
      h > 0 &&
      unit.x >= building.x &&
      unit.x <= building.x + w &&
      unit.z >= building.z &&
      unit.z <= building.z + h &&
      comparePainterOrder(unit, building) > 0
    )
      return DOCK_PULL;
  }
  return 0;
}

/** Build once per painter refresh; each anchor query scans only buildings covering that expanded cell. */
export function bucketDockBuildings(buildings: Iterable<PainterObject>): Map<number, Map<number, PainterObject[]>> {
  const cells = new Map<number, Map<number, PainterObject[]>>();
  for (const building of buildings) {
    if (building.layer !== 2 || !building.foundation) continue;
    const [w, h] = building.foundation;
    if (w <= 0 || h <= 0) continue;
    for (let x = building.x; x <= building.x + w; x++) {
      let column = cells.get(x);
      if (!column) cells.set(x, (column = new Map()));
      for (let z = building.z; z <= building.z + h; z++) {
        let bucket = column.get(z);
        if (!bucket) column.set(z, (bucket = []));
        bucket.push(building);
      }
    }
  }
  return cells;
}
