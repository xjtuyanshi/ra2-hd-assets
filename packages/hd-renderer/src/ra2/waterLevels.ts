/** Open-water cell coordinates and its base terrain level (not world height). */
export interface WaterCell {
  x: number;
  y: number;
  level: number;
}

/** All open-water cells at one base level, including disconnected lakes. Bounds include cell origins. */
export interface WaterLevel {
  level: number;
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Keep every level for the legacy lowest-plane policy; mirror selection is a separate enhanced-bed policy. */
export function groupWaterCells(cells: Iterable<WaterCell>): WaterLevel[] {
  const levels = new Map<number, WaterLevel>();
  for (const { x, y, level } of cells) {
    const group = levels.get(level);
    if (group) {
      group.count++;
      group.minX = Math.min(group.minX, x);
      group.maxX = Math.max(group.maxX, x);
      group.minY = Math.min(group.minY, y);
      group.maxY = Math.max(group.maxY, y);
    } else {
      levels.set(level, { level, count: 1, minX: x, maxX: x, minY: y, maxY: y });
    }
  }
  return [...levels.values()];
}

/**
 * Spend at most four scene renders on the largest water levels; tiny pools keep sky only. Ties prefer lower levels.
 * The chosen mirrors are returned lowest level first: that is the order they render in, and with three r186 a mirror
 * rendered after a HIGHER mirror of the same material sampled black on RiverRam (level 12 first, then 0: no reflections
 * at all on the main lake), while lowest-first renders every level correctly (verified on RiverRam levels 0/4/8/12).
 */
export function selectWaterMirrorLevels(levels: readonly WaterLevel[]): WaterLevel[] {
  return levels
    .filter(({ count }) => count >= 12)
    .sort((a, b) => b.count - a.count || a.level - b.level)
    .slice(0, 4)
    .sort((a, b) => a.level - b.level);
}
