import { DepthClass, type DepthCaptureClass } from '../terrainDepth';

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
  classification: DepthCaptureClass;
}
export interface EngulfFire extends Point3 {
  screenX: number;
  screenY: number;
  radius: number;
}

/**
 * Units/infantry use their current ground draw point (voxel root or SHP anchor), including height/bridge placement.
 * Buildings use the foundation centre, never a cropped sprite centre or the NW draw corner. Every component shares
 * this anchor and class. A missing foundation falls back to a conservative 1x1 cell foundation at the NW coordinate.
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

/** Allocation-free whole-object policy. Horizontal camera direction is normalized independently of its elevation. */
export function classifyEngulf(
  object: Point3,
  radius: number,
  fires: readonly EngulfFire[],
  count: number,
  right: Point3,
  up: Point3,
  toCamera: Point3,
): DepthCaptureClass {
  const sx = object.x * right.x + object.y * right.y + object.z * right.z;
  const sy = object.x * up.x + object.y * up.y + object.z * up.z;
  const horizontalLength = Math.hypot(toCamera.x, toCamera.z);
  let result: DepthCaptureClass = DepthClass.NONE;
  for (let i = 0; i < count; i++) {
    const fire = fires[i]!;
    const reach = radius + fire.radius;
    if ((sx - fire.screenX) ** 2 + (sy - fire.screenY) ** 2 > reach * reach) continue;
    // Generous circles can over-include objects. The class only changes depth where an actual fire pixel covers
    // an actual object pixel, so empty space in these bounds cannot create a cut or paint fire outside its card.
    const front = ((object.x - fire.x) * toCamera.x + (object.z - fire.z) * toCamera.z) / horizontalLength;
    // Absorb floating-point projection error at the inclusive 1.5-cell boundary.
    if (front < FRONT_DISTANCE - 1e-9) return DepthClass.COVER; // COVER wins even if another nearby fire sees FRONT.
    result = DepthClass.FRONT;
  }
  return result;
}
