import { ra2Screen } from './cache';

/**
 * Hard shores: where the water's edge is rock, a cliff's foot or masonry rather than a beach, on maps whose water mask
 * follows the painted waterline (MapMaterials.waterline). The enhanced water gives a beach a sandy bed, turquoise
 * shallows, a swash and foam; at a rock face the original paints deep water straight up to the stone, and the same
 * dressing read as a glowing band around every cliff.
 *
 * The terrain's own cliff test (the `contact` attribute, a rise within two cells) does not find these shores: a
 * cliff's face is painted on cells of the lower level, often more than a cell in front of the height step. What tells
 * them apart is the tile under the water: a beach is a shore tile, open sea a water tile, and those are the only
 * tiles in which the extractor's mask marks water (`waterFamily`). Water that the painted-waterline mask shows in, or
 * right against, a cell of any other tile lies at a hard shore (beaches always have their shore tiles in between).
 */

/**
 * Mask samples across a cell, in cells from its corner along either ground axis: every fifth of a cell from a tenth
 * outside one edge to a tenth outside the other. A strip of water a fifth of a cell wide along an edge (six engine
 * pixels across the screen) is found, and so is water that only touches the cell from outside: a rock face painted
 * right up to its cell's edge, with the sea starting in the next cell, is a hard shore too.
 */
const SAMPLES = [-0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 1.1] as const;
/** Mask value from which a sample is water (the mask's 8-bit midpoint, as in the shore field). */
const WATER_BYTE = 128;

/**
 * Lattice nodes (half cells at two vertices per cell edge) over which the field falls from 1 to 0 around a hard-shore
 * cell: full on the cell and one node beyond it, gone three nodes away. The falloff keeps the look's beach from
 * switching on at a cell edge where a beach meets a cliff.
 */
export const HARD_SHORE_FALLOFF = { full: 1, none: 3 } as const;

export interface HardShoreCell {
  /** Height level the cell's art is drawn at. */
  level: number;
  /** The extractor's mask can mark water in this cell's tile (open water, shore families). */
  waterFamily: boolean;
}

/**
 * One value per node of the terrain's vertex lattice ((width * sub + 1) x (height * sub + 1), row-major): 1 at and
 * around hard-shore cells, 0 elsewhere. `cell` returns null for a missing cell; `mask` is the water mask laid out
 * like the whole-map terrain `ref` describes (any resolution with the same aspect).
 */
export function hardShoreField(
  width: number,
  height: number,
  sub: number,
  cell: (x: number, y: number) => HardShoreCell | null,
  mask: { data: ArrayLike<number>; width: number; height: number },
  ref: { originX: number; originY: number; scale: number; width: number; height: number },
): Float32Array {
  const gw = width * sub + 1;
  const gh = height * sub + 1;
  // Node distance to the nearest hard-shore cell (Chebyshev), by a multi-source flood over the lattice.
  const distance = new Int32Array(gw * gh).fill(-1);
  const queue: number[] = [];
  const perEnginePixel = (ref.scale * mask.width) / ref.width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = cell(x, y);
      if (!c || c.waterFamily) continue;
      let water = false;
      for (let j = 0; j < SAMPLES.length && !water; j++) {
        for (let i = 0; i < SAMPLES.length && !water; i++) {
          const [sx, sy] = ra2Screen(x + SAMPLES[i]!, y + SAMPLES[j]!, c.level);
          const px = Math.floor((sx - ref.originX) * perEnginePixel);
          const py = Math.floor((sy - ref.originY) * perEnginePixel);
          if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue;
          water = mask.data[py * mask.width + px]! >= WATER_BYTE;
        }
      }
      if (!water) continue;
      for (let j = 0; j <= sub; j++) {
        for (let i = 0; i <= sub; i++) {
          const node = (y * sub + j) * gw + (x * sub + i);
          if (distance[node] === 0) continue;
          distance[node] = 0;
          queue.push(node);
        }
      }
    }
  }
  const out = new Float32Array(gw * gh);
  const { full, none } = HARD_SHORE_FALLOFF;
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    const d = distance[node]!;
    out[node] = Math.min(1, Math.max(0, (none - d) / (none - full)));
    if (d + 1 >= none) continue;
    const nx = node % gw;
    const ny = (node - nx) / gw;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = nx + dx;
        const y = ny + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const next = y * gw + x;
        if (distance[next] !== -1) continue;
        distance[next] = d + 1;
        queue.push(next);
      }
    }
  }
  return out;
}
