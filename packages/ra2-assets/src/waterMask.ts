/** Open-water classification shared by terrain atlases and whole-map composites (pure). */
import type { TileEntry } from './manifest.ts';

/** Templates that can contain water: sea, shores, water cliffs and bridges over water. */
const WATER_FAMILIES = /^(water|shore|w-a-|w-b-|wbrdge|wtr|bank)/i;
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Classify raw palette colours using each pixel's last drawing tile, soften opaque shorelines, then bleed three
 * pixels into transparency for linear sampling. For an atlas, callers fill `tileAt` from the tile rectangles;
 * for a composite, they record the winning tile while drawing. A tile index of -1 means no tile wrote the pixel.
 */
export function buildWaterMaskBytes(
  rgba: Uint8Array,
  width: number,
  height: number,
  tileAt: Int32Array,
  tiles: readonly TileEntry[],
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`invalid water mask size ${width}x${height}`);
  }
  const size = width * height;
  if (rgba.length !== size * 4 || tileAt.length !== size) {
    throw new RangeError('water mask RGBA and tile attribution must match the image size');
  }
  // Avoid matching a filename once per pixel on a whole-map image.
  const kinds = tiles.map((tile) =>
    tile.terrainType === 9 ? 2 : WATER_FAMILIES.test(tile.file.replace(/\d+\..*$/, '')) ? 1 : 0,
  );
  const mask = new Float32Array(size);
  const opaque = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (rgba[i * 4 + 3]! < 128) continue;
    opaque[i] = 1;
    const kind = kinds[tileAt[i]!];
    if (!kind) continue;
    if (kind === 2) {
      mask[i] = 1;
      continue;
    }
    const r = rgba[i * 4]! / 255;
    const g = rgba[i * 4 + 1]! / 255;
    const b = rgba[i * 4 + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const blueness = b - Math.max(r, g * 0.9);
    mask[i] = clamp01((blueness - 0.02) / 0.08) * clamp01((saturation - 0.12) / 0.15) * (max < 0.75 ? 1 : 0);
  }

  // Ignore transparent neighbours so tile diamond borders do not become artificial shorelines.
  let current = mask;
  for (let pass = 0; pass < 2; pass++) {
    const next = current.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!opaque[i]) continue;
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || !opaque[ny * width + nx]) continue;
            sum += current[ny * width + nx]!;
            n++;
          }
        }
        next[i] = sum / n;
      }
    }
    current = next;
  }

  let filled = opaque.slice();
  for (let pass = 0; pass < 3; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (filled[i]) continue;
        let sum = 0;
        let n = 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !filled[ny * width + nx]) continue;
          sum += current[ny * width + nx]!;
          n++;
        }
        if (n) {
          // Donors are restricted to the previous filled set, so newly written values cannot feed this pass.
          current[i] = sum / n;
          next[i] = 1;
        }
      }
    }
    filled = next;
  }
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = Math.round(current[i]! * 255);
  return bytes;
}
