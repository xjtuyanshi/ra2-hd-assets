export const FRONT_DISTANCE = 1.5;
/** Screen-plane world units: include filtered edges, presentation growth and garnish outside the authored crop. */
export const FIRE_FOOTPRINT_MARGIN = 0.75;
export const OBJECT_FOOTPRINT_MARGIN = 0.75;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}
export interface EngulfObject extends Point3 {
  /** Circle about the anchor's screen projection, covering every body/turret/barrel or SHP component. */
  radius: number;
  code: number;
}
export interface EngulfFire extends Point3 {
  screenX: number;
  screenY: number;
  radius: number;
}

/**
 * Units/infantry use their current ground draw point (voxel root or SHP anchor), including height/bridge placement.
 * Buildings use the foundation centre, never a cropped sprite centre or the NW draw corner. Every component shares
 * this anchor and code. A missing foundation falls back to a conservative 1x1 cell foundation at the NW coordinate.
 * Airborne aircraft are excluded by LiveView: the original gives flying units their own layer; parked aircraft join.
 */
export function engulfAnchor(
  draw: Point3,
  foundation: readonly [number, number] | undefined,
  northwestX: number,
  northwestZ: number,
  out: Point3,
): void {
  out.x = foundation ? northwestX + foundation[0] / 2 : draw.x;
  out.y = draw.y;
  out.z = foundation ? northwestZ + foundation[1] / 2 : draw.z;
}

/** Allocation-free near test. Membership does not choose a global front/cover class. */
export function isNearEngulfFire(
  object: Point3,
  radius: number,
  fires: readonly EngulfFire[],
  count: number,
  right: Point3,
  up: Point3,
): boolean {
  const sx = object.x * right.x + object.y * right.y + object.z * right.z;
  const sy = object.x * up.x + object.y * up.y + object.z * up.z;
  for (let i = 0; i < count; i++) {
    const fire = fires[i]!;
    const reach = radius + fire.radius;
    if ((sx - fire.screenX) ** 2 + (sy - fire.screenY) ** 2 > reach * reach) continue;
    // Generous circles can over-include objects; the GPU acts only on actual fire/object fragment overlap.
    return true;
  }
  return false;
}
