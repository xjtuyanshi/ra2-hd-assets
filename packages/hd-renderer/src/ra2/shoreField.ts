import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  RedFormat,
  UnsignedByteType,
} from 'three/webgpu';
import { runSteps, type Steps } from '../timeSlice';

/** Encoded range of the signed shore distance, in cells: texel value 0..1 maps to SHORE_MIN..SHORE_MAX. */
export const SHORE_MIN = -3;
export const SHORE_MAX = 9;

/** Cliff contact distance in cells encoded by a texel value of 1. */
export const CLIFF_FIELD_MAX = 1.5;

/**
 * Land specks of at most this many field texels (8-connected, 4 x 4 mask pixels each at the default step: about
 * 6 x 6 engine pixels) inside open water count as water: they are single rocks or mask noise, and as land each one
 * got a turquoise halo and a ring of foam (white speckles across a lake, owner feedback).
 */
export const SPECK_TEXELS = 8;

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
 *
 * `precise` (the lake-bed shoreline, whose wet sand, swash and foam work at a few hundredths of a cell) stores the same
 * normalised value as a half float instead of 8 bits (one 8-bit step is 0.047 cells, which drew contour lines along
 * the waterline), and moves every distance half a texel towards the shoreline so the field crosses zero on the mask's
 * edge instead of jumping from -1 to +1 texel across it. The default 8-bit field is unchanged.
 *
 * `ignore` has the mask's size and layout; values >= 128 mark land that must not form a shoreline (cliff tops and
 * walls can sit next to water at their feet in screen space). A texel is ignored when at least half its mask pixels
 * are marked and it remains land after speck filling. Ignored land stays dry and is excluded from water depth.
 */
export function buildShoreField(
  mask: Uint8Array,
  width: number,
  height: number,
  scale: number,
  step = 4,
  precise = false,
  ignore?: Uint8Array,
  landValue?: ShoreLandValue,
): { texture: DataTexture; data: Uint8Array; values: Uint8Array[] | null; width: number; height: number } {
  return runSteps(shoreFieldSteps(mask, width, height, scale, step, precise, ignore, landValue));
}

/**
 * Up to two properties of the land along the shoreline (each 0..1), read from the mask-space pixel rectangle
 * [x0, x1) x [y0, y1) of one land texel a little inland of the waterline; null where the rectangle has nothing to read.
 * `defaults` are the values where no shore is within reach.
 */
export interface ShoreLandValue {
  defaults: readonly number[];
  read(x0: number, y0: number, x1: number, y1: number): readonly number[] | null;
}

/** Land band (cells inland of the waterline) whose texels feed ShoreLandValue: past the painted wet band at the edge. */
export const SHORE_VALUE_BAND = [0.15, 0.8] as const;
/** Share of the spreading kernel covered by the land band along a straight coast; mass 0.5 encodes it (shoreValueSteps). */
export const SHORE_MASS_FULL = 0.3;
/** Radius (cells) of each of the three box passes that spread the land value onto the water (reach about 3x). */
export const SHORE_VALUE_RADIUS = 0.9;

/** buildShoreField as a pass that yields after every row or line of work (see timeSlice.ts). */
export function* shoreFieldSteps(
  mask: Uint8Array,
  width: number,
  height: number,
  scale: number,
  step = 4,
  precise = false,
  ignore?: Uint8Array,
  landValue?: ShoreLandValue,
): Steps<{ texture: DataTexture; data: Uint8Array; values: Uint8Array[] | null; width: number; height: number }> {
  const { water, ignored, width: w, height: h } = yield* downsampleMasks(mask, width, height, step, ignore);
  yield* fillSpecksSteps(water, w, h, SPECK_TEXELS);
  const texel = step / scale;
  const toWater = yield* distanceFieldSteps(water, w, h, 1, texel, texel * 2);
  const toLand = yield* distanceFieldSteps(
    ignored ? water.map((value, i) => value || ignored[i]!) : water,
    w,
    h,
    0,
    texel,
    texel * 2,
  );
  const data = new Uint8Array(w * h);
  const half = precise ? new Uint16Array(w * h) : null;
  const inset = precise ? texel / 2 : 0;
  for (let i = 0; i < data.length; i++) {
    if (i % w === 0) yield;
    const cells = water[i]
      ? (Math.sqrt(toLand[i]!) - inset) / ISO_PIXELS_PER_CELL
      : ignored?.[i]
        ? SHORE_MIN
        : -(Math.sqrt(toWater[i]!) - inset) / ISO_PIXELS_PER_CELL;
    const unit = Math.min(1, Math.max(0, (cells - SHORE_MIN) / (SHORE_MAX - SHORE_MIN)));
    data[i] = Math.round(unit * 255);
    if (half) half[i] = DataUtils.toHalfFloat(unit);
  }
  // The optional land values ride in the 8-bit field's G and B channels and the shore mass (shoreValueSteps) in A, so
  // the material reads them with the distance tap it already makes.
  const values = landValue && !half ? yield* shoreValueSteps(water, toWater, w, h, step, texel, landValue) : null;
  let texture: DataTexture;
  if (half) texture = new DataTexture(half, w, h, RedFormat, HalfFloatType);
  else if (values) {
    const rgba = new Uint8Array(w * h * 4).fill(255);
    for (let i = 0; i < data.length; i++) {
      rgba[i * 4] = data[i]!;
      values.forEach((value, c) => (rgba[i * 4 + 1 + c] = value[i]!));
    }
    texture = new DataTexture(rgba, w, h, RGBAFormat, UnsignedByteType);
  } else texture = new DataTexture(data, w, h, RedFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, data, values, width: w, height: h };
}

/**
 * Spread land properties onto the water beside it. Each water texel takes the weighted mean of the values read on the
 * land band of the nearby shoreline (normalised convolution: three box passes over value x weight and over weight),
 * fading to the defaults where no shore is within reach; returns them followed by the shore mass. A per-pixel tap stepped back along the distance
 * field's gradient cannot do this: away from the waterline the gradient points at the wrong shore (across straits,
 * past small islands, along medial lines), so the tap read water or far land and drew hard-edged blocks and shards.
 */
function* shoreValueSteps(
  water: Uint8Array,
  toWater: Float64Array,
  w: number,
  h: number,
  step: number,
  texel: number,
  landValue: ShoreLandValue,
): Steps<Uint8Array[]> {
  const channels = Math.min(2, landValue.defaults.length);
  // One spread field per land value, then the shore mass, then the weight.
  const nums = Array.from({ length: channels + 1 }, () => new Float32Array(w * h));
  const den = new Float32Array(w * h);
  const band = new Uint8Array(w * h);
  const [near, far] = SHORE_VALUE_BAND;
  for (let y = 0; y < h; y++, yield)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (water[i]) continue;
      const cells = Math.sqrt(toWater[i]!) / ISO_PIXELS_PER_CELL;
      if (cells < near || cells > far) continue;
      const v = landValue.read(x * step, y * step, (x + 1) * step, (y + 1) * step);
      if (v === null) continue;
      for (let c = 0; c < channels; c++) nums[c]![i] = Math.min(1, Math.max(0, v[c] ?? landValue.defaults[c]!));
      den[i] = 1;
      band[i] = 1;
    }
  // A vertical texel covers twice the ground of a horizontal one (see buildShoreField).
  const rx = Math.max(1, Math.round((SHORE_VALUE_RADIUS * ISO_PIXELS_PER_CELL) / texel));
  const ry = Math.max(1, Math.round(rx / 2));
  const line = new Float32Array(Math.max(w, h));
  const blur = function* (field: Float32Array): Steps<void> {
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < h; y++, yield) boxLine(field, y * w, 1, w, rx, line);
      for (let x = 0; x < w; x++, yield) boxLine(field, x, w, h, ry, line);
    }
  };
  // Shore mass, measured on the land band itself: how much shoreline lies around that stretch of shore (SHORE_MASS_FULL
  // for a straight coast, more in a bay, a fraction on a small islet or a headland). It is then spread like the land
  // values, so the water keeps its shore's mass however far out it lies.
  const local = den.slice();
  yield* blur(local);
  const mass = nums[channels]!;
  for (let i = 0; i < mass.length; i++) if (band[i]) mass[i] = Math.min(1, local[i]! / (2 * SHORE_MASS_FULL));
  for (const field of [...nums, den]) yield* blur(field);
  const spread = nums.map((num, c) => {
    const fallback = c < channels ? landValue.defaults[c]! : 0.5;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) {
      const d = den[i]!;
      const mean = d > 1e-6 ? num[i]! / d : fallback;
      // Only the last fringe of the reach blends towards the default: a wider blend let a quay's class fade to a beach
      // about two cells out, and the shallows' warp then raised a pale turquoise shoal in the gap of a broken bridge.
      const trust = Math.min(1, d / 0.002);
      out[i] = Math.round((fallback + (mean - fallback) * trust) * 255);
    }
    return out;
  });
  while (spread.length < 3) spread.splice(spread.length - 1, 0, new Uint8Array(w * h).fill(255));
  return spread;
}

/** In-place box mean of radius r along one line of `field` (start index, stride, length), edges clamped. */
function boxLine(field: Float32Array, start: number, stride: number, n: number, r: number, line: Float32Array): void {
  for (let i = 0; i < n; i++) line[i] = field[start + i * stride]!;
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += line[Math.min(n - 1, Math.max(0, k))]!;
  const norm = 1 / (2 * r + 1);
  for (let i = 0; i < n; i++) {
    field[start + i * stride] = sum * norm;
    sum += line[Math.min(n - 1, i + r + 1)]! - line[Math.max(0, i - r)]!;
  }
}

/**
 * Unsigned distance to the nearest shore-ignored texel, in the shore field's isometric cell metric. Both masks use
 * the same composite-space layout and majority downsampling as buildShoreField. Every marked texel is a target,
 * including marks over water or specks: water classification must not erase a cliff contact line.
 *
 * Values are normalised to 0..1 over CLIFF_FIELD_MAX cells and stored as half-float bits in `data`, matching the
 * precise lake-bed shore texture. Distance is zero on a wall texel, without the signed shore field's edge inset.
 */
export function buildCliffField(
  maskBytes: Uint8Array,
  ignoreBytes: Uint8Array,
  width: number,
  height: number,
  scale: number,
  downsample = 4,
): { texture: DataTexture; data: Uint16Array } {
  return runSteps(cliffFieldSteps(maskBytes, ignoreBytes, width, height, scale, downsample));
}

/** buildCliffField as a pass that yields after every row or line of work (see timeSlice.ts). */
export function* cliffFieldSteps(
  maskBytes: Uint8Array,
  ignoreBytes: Uint8Array,
  width: number,
  height: number,
  scale: number,
  downsample = 4,
): Steps<{ texture: DataTexture; data: Uint16Array }> {
  const { ignored, width: w, height: h } = yield* downsampleMasks(maskBytes, width, height, downsample, ignoreBytes);
  const texel = downsample / scale;
  const toCliff = yield* distanceFieldSteps(ignored!, w, h, 1, texel, texel * 2);
  const data = new Uint16Array(w * h);
  for (let i = 0; i < data.length; i++) {
    if (i % w === 0) yield;
    const cells = Math.sqrt(toCliff[i]!) / ISO_PIXELS_PER_CELL;
    data[i] = DataUtils.toHalfFloat(Math.min(1, cells / CLIFF_FIELD_MAX));
  }
  const texture = new DataTexture(data, w, h, RedFormat, HalfFloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, data };
}

/** Sample both fields on the same texel grid, including partial blocks at the composite's edges. */
function* downsampleMasks(
  mask: Uint8Array,
  width: number,
  height: number,
  step: number,
  ignore?: Uint8Array,
): Steps<{ water: Uint8Array; ignored: Uint8Array | null; width: number; height: number }> {
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const water = new Uint8Array(w * h);
  const ignored = ignore ? new Uint8Array(w * h) : null;
  for (let y = 0; y < h; y++, yield)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      let ignoredPixels = 0;
      for (let dy = 0; dy < step; dy++)
        for (let dx = 0; dx < step; dx++) {
          const px = x * step + dx;
          const py = y * step + dy;
          if (px >= width || py >= height) continue;
          sum += mask[py * width + px]!;
          if (ignore && ignore[py * width + px]! >= 128) ignoredPixels++;
          n++;
        }
      water[y * w + x] = n && sum / n >= 128 ? 1 : 0;
      if (ignored) ignored[y * w + x] = n && ignoredPixels * 2 >= n ? 1 : 0;
    }
  return { water, ignored, width: w, height: h };
}

/**
 * Turn 8-connected land components of at most `maxTexels` texels that do not touch the field's border into water
 * (in place). Returns the number of texels changed.
 */
export function fillSpecks(water: Uint8Array, width: number, height: number, maxTexels: number): number {
  return runSteps(fillSpecksSteps(water, width, height, maxTexels));
}

function* fillSpecksSteps(water: Uint8Array, width: number, height: number, maxTexels: number): Steps<number> {
  const seen = new Uint8Array(water.length);
  const stack: number[] = [];
  const component: number[] = [];
  let changed = 0;
  for (let start = 0; start < water.length; start++) {
    if (start % width === 0) yield;
    if (water[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    component.length = 0;
    let border = false;
    while (stack.length) {
      const i = stack.pop()!;
      component.push(i);
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (water[j] || seen[j]) continue;
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (border || component.length > maxTexels) continue;
    for (const i of component) water[i] = 1;
    changed += component.length;
  }
  return changed;
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
  return runSteps(distanceFieldSteps(values, width, height, target, spacingX, spacingY));
}

function* distanceFieldSteps(
  values: Uint8Array,
  width: number,
  height: number,
  target: number,
  spacingX: number,
  spacingY: number,
): Steps<Float64Array> {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = values[i] === target ? 0 : FAR;
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const s2x = spacingX * spacingX;
  const s2y = spacingY * spacingY;
  for (let x = 0; x < width; x++, yield) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x]! / s2y;
    transform1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y]! * s2y;
  }
  for (let y = 0; y < height; y++, yield) {
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
