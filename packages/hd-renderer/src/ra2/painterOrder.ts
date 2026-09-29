/** Object-level tactical painter order, independent of art offsets, altitude and cardPush. */
export interface PainterObject {
  layer: number;
  ySort: number;
  /** Actual index in the native layer vector; equal Ground keys retain registration order. */
  index?: number;
  /** Fallback attached/transient art should follow equal-key registered bodies, rather than precede them. */
  afterEqual?: boolean;
  depth: number;
  slotWidth: number;
}

/**
 * YR 1.001: GetYSort (0x5F6BD0), Building GetPosition_2 (0x459EF0) and override (0x449410).
 * Buildings sort at their northwest foundation corner, NOT their drawing centre or front edge. Foundation size
 * and Z do not enter this key. TurretAnimIsVoxel adds 32 leptons; Gate subtracts 16.
 */
export function objectYSort(x: number, y: number, building = false, voxelTurret = false, gate = false): number {
  return x + y - (building ? 256 : 0) + (building && voxelTurret ? 32 : 0) - (building && gate ? 16 : 0);
}

/** Native layer/index is authoritative; older snapshots fall back to the verified Ground key. */
export function comparePainterOrder(a: PainterObject, b: PainterObject): number {
  const layer = a.layer - b.layer;
  if (layer) return layer;
  if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
  if (a.layer === 2) return a.ySort - b.ySort || Number(!!a.afterEqual) - Number(!!b.afterEqual);
  return (a.index ?? 0) - (b.index ?? 0);
}

/**
 * One slot per object (all atlas pages and voxel parts share it). Nearer slots belong to later painter entries.
 * The band precedes terrain/decal depth in the fixed IsoCamera; objects can never be sliced by their own ground.
 * Component offsets and bounded voxel self-depth fit inside a slot, so they cannot reverse object ordering.
 * Physical scene depth is retained separately for the renderer's mist and shroud post pass.
 */
export function assignPainterDepth(objects: PainterObject[]): void {
  // Preserve the actual native traversal even during an unfinished adjacent-sort pass. Merge static cache art
  // using its Ground key, without a mixed comparator that could cyclically reorder native registrations.
  const ordered: PainterObject[] = [];
  const layers = [...new Set(objects.map((object) => object.layer))].sort((a, b) => a - b);
  for (const layer of layers) {
    const native = objects.filter((object) => object.layer === layer && object.index !== undefined);
    const fallback = objects.filter((object) => object.layer === layer && object.index === undefined);
    native.sort(comparePainterOrder);
    fallback.sort(comparePainterOrder);
    const lastEqual = new Map<number, number>();
    for (let i = 0; i < native.length; i++) lastEqual.set(native[i]!.ySort, i);
    let next = 0;
    for (let i = 0; i < native.length; i++) {
      const object = native[i]!;
      while (next < fallback.length) {
        const extra = fallback[next]!;
        // A partially sorted list may encounter a larger key before an equal body. Attached art must still
        // wait for that body's last registration, rather than being inserted before the earlier larger key.
        if (layer === 2 && extra.afterEqual && (lastEqual.get(extra.ySort) ?? -1) >= i) break;
        if (layer === 2 && (extra.ySort > object.ySort || (extra.ySort === object.ySort && extra.afterEqual))) break;
        ordered.push(extra);
        next++;
      }
      ordered.push(object);
    }
    while (next < fallback.length) ordered.push(fallback[next++]!);
  }
  for (let i = 0; i < ordered.length; i++) objects[i] = ordered[i]!;
  const width = 0.1 / (objects.filter((object) => object.layer >= 2).length + 1);
  let slot = 0;
  for (const object of objects) {
    // Underground/surface objects still test physical terrain depth; the upright band must not expose them.
    if (object.layer < 2) {
      object.depth = -1;
      object.slotWidth = 0;
      continue;
    }
    object.depth = 0.2 - ++slot * width;
    object.slotWidth = width;
  }
}

export function painterObject(layer: number, ySort: number, index?: number): PainterObject {
  return { layer, ySort, index, depth: -1, slotWidth: 0 };
}

/** All object components use the same slot; a small part offset draws anims/turrets over their own body. */
export function spritePainterDepth(object: PainterObject | undefined, part = 0): number {
  return object && object.depth >= 0 ? object.depth - part * object.slotWidth : -1;
}
