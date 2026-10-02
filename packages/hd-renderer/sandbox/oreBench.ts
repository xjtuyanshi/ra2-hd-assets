import type { MapObject } from '../../ra2-assets/src/manifest';
import type { LiveOverlayCells } from '../src/live/overlays';

export type CellPoint = readonly [number, number];

/** Constant-speed travel by arc length; duplicate vertices are ignored and the endpoint is held without moving. */
export function polylinePosition(points: readonly CellPoint[], seconds: number, speed: number) {
  if (!points.length) throw new Error('A harvest path needs at least one point');
  let remaining = Math.max(0, seconds) * Math.max(0, speed);
  let facingRaw = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    facingRaw = (Math.round((Math.atan2(dx, -dy) / (2 * Math.PI)) * 65536) + 65536) % 65536;
    // Decimal cell offsets can differ by a few ulps after subtracting a large map coordinate.
    if (remaining + 1e-9 < length)
      return {
        x: ax + (dx * remaining) / length,
        y: ay + (dy * remaining) / length,
        facingRaw,
        moving: speed > 0 && seconds >= 0,
      };
    remaining = Math.max(0, remaining - length);
  }
  const [x, y] = points[points.length - 1]!;
  return { x, y, facingRaw, moving: false };
}

function emptyGrid(width: number, height: number): LiveOverlayCells {
  return {
    originX: 0,
    originY: 0,
    width,
    height,
    index: new Int16Array(width * height).fill(-1),
    data: new Uint8Array(width * height),
    types: [],
    revision: 1,
  };
}

function put(grid: LiveOverlayCells, x: number, y: number, type: string, frame: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return;
  let index = grid.types.indexOf(type);
  if (index < 0) index = grid.types.push(type) - 1;
  grid.index[y * grid.width + x] = index;
  grid.data[y * grid.width + x] = frame;
}

/** Preserve the manifest's overlay IDs and exact growth/connection frames, including non-resource overlays. */
export function mapOverlayGrid(width: number, height: number, objects: readonly MapObject[]): LiveOverlayCells {
  const grid = emptyGrid(width, height);
  for (const object of objects)
    if (object.kind === 'overlay') put(grid, object.x, object.y, object.type, object.frame ?? 0);
  return grid;
}

/** One row per type, frames 0..11 along +x. Dense blocks stagger rightwards so rows cannot overwrite each other. */
export function growthGrid(
  width: number,
  height: number,
  types: readonly string[],
  cx: number,
  cy: number,
  spacing = 2,
  fill = 0,
): LiveOverlayCells {
  if (!Number.isInteger(spacing) || spacing < 1 || !Number.isInteger(fill) || fill < 0)
    throw new Error('Ore spacing must be a positive integer and fill a nonnegative integer');
  const grid = emptyGrid(width, height);
  types.forEach((type, row) => {
    const y = Math.floor(cy) + row * spacing;
    for (let frame = 0; frame < 12; frame++) put(grid, Math.floor(cx) + frame * spacing, y, type, frame);
    const blockX = Math.floor(cx) + 12 * spacing + row * (fill + spacing);
    for (let dy = 0; dy < fill; dy++) for (let dx = 0; dx < fill; dx++) put(grid, blockX + dx, y + dy, type, 11);
  });
  return grid;
}

/** Mutate one Chebyshev-radius-1 harvest step; frame zero is removed on the next loss, never Uint8-wrapped. */
export function depleteOre(grid: LiveOverlayCells, x: number, y: number, tiberium: ReadonlySet<string>): boolean {
  const cx = Math.floor(x) - grid.originX;
  const cy = Math.floor(y) - grid.originY;
  let changed = false;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) continue;
      const slot = py * grid.width + px;
      const index = grid.index[slot] ?? -1;
      if (index < 0 || slot >= grid.data.length || !tiberium.has(grid.types[index]!)) continue;
      if (grid.data[slot] === 0) grid.index[slot] = -1;
      else grid.data[slot]!--;
      changed = true;
    }
  if (changed) grid.revision++;
  return changed;
}
