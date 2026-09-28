import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three/webgpu';

/** Encoded range of the signed shore distance, in cells: texel value 0..1 maps to SHORE_MIN..SHORE_MAX. */
export const SHORE_MIN = -3;
export const SHORE_MAX = 9;

/** Engine pixels per world cell along the ground once the 2:1 screen squash is undone (60 / sqrt 2). */
const ISO_PIXELS_PER_CELL = 60 / Math.SQRT2;
const FAR = 1e20;

/**
 * Signed distance to the shoreline, in world cells (positive over open water, negative on land), computed from the
 * whole-map water mask. The mask lives in engine screen space, where a vertical screen pixel covers twice the ground a
 * horizontal one does, so the vertical spacing is doubled to measure true ground distance. Water depth, shoreline foam
 * and wet sand are all derived from this one field, so they follow the painted shoreline exactly.
 *
 * `scale` is the mask's pixels per engine pixel; `step` downsamples (one texel per `step` mask pixels).
 */
export function buildShoreField(
  mask: Uint8Array,
  width: number,
  height: number,
  scale: number,
  step = 4,
): { texture: DataTexture; data: Uint8Array; width: number; height: number } {
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const water = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++)
        for (let dx = 0; dx < step; dx++) {
          const px = x * step + dx;
          const py = y * step + dy;
          if (px >= width || py >= height) continue;
          sum += mask[py * width + px]!;
          n++;
        }
      water[y * w + x] = n && sum / n >= 128 ? 1 : 0;
    }
  const texel = step / scale;
  const toWater = distanceField(water, w, h, 1, texel, texel * 2);
  const toLand = distanceField(water, w, h, 0, texel, texel * 2);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const cells = water[i]
      ? Math.sqrt(toLand[i]!) / ISO_PIXELS_PER_CELL
      : -Math.sqrt(toWater[i]!) / ISO_PIXELS_PER_CELL;
    data[i] = Math.round(Math.min(1, Math.max(0, (cells - SHORE_MIN) / (SHORE_MAX - SHORE_MIN))) * 255);
  }
  const texture = new DataTexture(data, w, h, RedFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, data, width: w, height: h };
}

/**
 * Squared distance from every texel to the nearest texel whose value equals `target`, with separate horizontal and
 * vertical spacings (exact Euclidean distance transform, Felzenszwalb & Huttenlocher, separable in two passes).
 */
export function distanceField(
  values: Uint8Array,
  width: number,
  height: number,
  target: number,
  spacingX: number,
  spacingY: number,
): Float64Array {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = values[i] === target ? 0 : FAR;
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const s2x = spacingX * spacingX;
  const s2y = spacingY * spacingY;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x]! / s2y;
    transform1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y]! * s2y;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = out[y * width + x]! / s2x;
    transform1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x]! * s2x;
  }
  return out;
}

/** 1D squared distance transform of f (unit spacing): d[q] = min_p (q - p)^2 + f[p]. */
function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}
