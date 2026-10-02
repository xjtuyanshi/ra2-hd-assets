/** Native traversal metadata. It breaks physical depth ties; it is never an absolute fragment depth. */
export interface PainterObject {
  layer: number;
  ySort: number;
  index?: number;
  afterEqual?: boolean;
  /** Camera-space world units, independent of scene occupancy and camera movement. */
  bias: number;
  /** Shared camera-space pull for sprite cards and voxel parts. */
  pull?: number;
  uid?: number;
  contactUid?: number;
  dock?: boolean;
  unloading?: 'door' | 'roof';
  /** Building foundation and its northwest world coordinate, separate from the sprite's draw point. */
  foundation?: readonly [number, number];
  x: number;
  z: number;
}

/**
 * YR 1.001: GetYSort (0x5F6BD0), Building GetPosition_2 (0x459EF0) and override (0x449410).
 * Buildings sort at Location.X + Location.Y - 256, with +32 for voxel turrets and -16 for gates.
 * This is NOT an occlusion plane: DrawObject (0x705E00) also tests/writes the building Z-shape.
 */
export function objectYSort(x: number, y: number, building = false, voxelTurret = false, gate = false): number {
  return x + y - (building ? 256 : 0) + (building && voxelTurret ? 32 : 0) - (building && gate ? 16 : 0);
}

export function comparePainterOrder(a: PainterObject, b: PainterObject): number {
  const layer = a.layer - b.layer;
  if (layer) return layer;
  if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
  // Mixing a native partial sort with fallback Y keys pairwise creates comparison cycles. Fallbacks form their
  // own stable group; physical Z, not this group order, resolves overlaps with registered objects.
  if (a.index !== undefined || b.index !== undefined)
    return Number(a.index !== undefined) - Number(b.index !== undefined);
  if (a.layer === 2) return a.ySort - b.ySort || Number(!!a.afterEqual) - Number(!!b.afterEqual);
  return (a.index ?? 0) - (b.index ?? 0);
}

/** Less than two original pixels in world space, including component bias. Never crosses a cell or height level. */
export const PAINTER_BIAS_STEP = 0.01;
export const MAX_PAINTER_BIAS = 4 * PAINTER_BIAS_STEP;

/**
 * Fixed, occupancy-independent biases. Native registration breaks near-equal physical ties. A building's NW key
 * must not move its facade: its foundation ramp supplies depth instead. Static cards never change when an effect
 * appears. No sorting, scratch containers or allocations are needed, even on a logic-frame update.
 * Finite depth precision can collapse very large equal-depth registration lists; this is not a native Z emulator.
 */
export function assignPainterBias(objects: Iterable<PainterObject>): void {
  for (const object of objects) {
    const index = Math.max(0, object.index ?? 0);
    object.bias =
      object.layer < 2 || object.foundation
        ? 0
        : PAINTER_BIAS_STEP * (Math.min(2, object.layer - 2) + (object.afterEqual ? 1 : index / (index + 32)));
  }
}

export function painterObject(layer: number, ySort: number, index?: number): PainterObject {
  return { layer, ySort, index, bias: 0, x: 0, z: 0 };
}

/** Components retain physical depth, with a small, bounded tie-break over their own body. */
export function spritePainterBias(object: PainterObject | undefined, part = 0): number {
  return object && object.layer >= 2
    ? object.bias + (object.pull ?? 0) + Math.max(0, Math.min(1, part)) * PAINTER_BIAS_STEP
    : 0;
}
