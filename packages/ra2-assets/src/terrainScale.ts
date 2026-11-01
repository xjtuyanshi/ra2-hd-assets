/**
 * Scale selection for a whole-map terrain composite (manifest `terrainMap`) under a per-side texture limit.
 *
 * The renderer maps an engine screen position p to composite pixel (p - origin) * scale and normalizes by the image's
 * own width/height, so `scale` may be any positive number. When the requested integer scale would exceed the limit on
 * either axis, the composite is "fitted": the scale becomes the largest multiple of 1/FIT_SCALE_DENOMINATOR that
 * keeps both sides within the limit, and each side is ceil(side * scale). A dyadic scale keeps side * scale exact
 * in binary floating point (in JSON, JS and NumPy alike), so producers and consumers agree on every size. Pixel x
 * of a fitted image covers exactly [x / scale, (x + 1) / scale) original pixels; the last column/row may extend
 * past the original edge and holds the mean of the part it covers. Registration is therefore exact everywhere,
 * not merely within a pixel at the far edge.
 */

/** Largest 2D texture side the HD renderer requests from the adapter (Apple GPUs offer 16384; WebGPU guarantees 8192). */
export const TERRAIN_MAX_SIDE = 16384;
/** Fitted scales are multiples of 1/256: below 0.4 % resolution loss, and exact in binary floating point. */
export const FIT_SCALE_DENOMINATOR = 256;

export interface TerrainFit {
  /** Output pixels per original engine pixel: the request, or a fractional fitted scale below it. */
  scale: number;
  /** Output image size: ceil(side * scale) on each axis. */
  width: number;
  height: number;
  /** True when the scale is not an integer (the requested integer scale did not fit). */
  fitted: boolean;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Composite size at `scale` (ceil per side; exact for integer and dyadic scales). */
export function scaledTerrainSize(width: number, height: number, scale: number): [number, number] {
  if (!positiveInteger(width) || !positiveInteger(height)) throw new RangeError('Invalid terrain dimensions');
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('scale must be a positive number');
  return [Math.ceil(width * scale), Math.ceil(height * scale)];
}

/**
 * The scale for a `width` x `height` scale-1 composite requested at integer `requested`: the request itself when it
 * fits `maxSide` on both axes (integer behaviour unchanged), else the largest multiple of 1/FIT_SCALE_DENOMINATOR
 * that fits (never below 1). Throws when even scale 1 exceeds `maxSide`.
 */
export function fitTerrainScale(
  width: number,
  height: number,
  requested: number,
  maxSide: number = TERRAIN_MAX_SIDE,
): TerrainFit {
  if (!positiveInteger(width) || !positiveInteger(height)) throw new RangeError('Invalid terrain dimensions');
  if (!positiveInteger(requested)) throw new RangeError('requested scale must be a positive integer');
  if (!positiveInteger(maxSide)) throw new RangeError('maxSide must be a positive integer');
  const longest = Math.max(width, height);
  if (longest > maxSide) throw new RangeError(`Terrain ${width}x${height} exceeds ${maxSide} px even at scale 1`);
  if (longest * requested <= maxSide)
    return { scale: requested, width: width * requested, height: height * requested, fitted: false };
  // Integer operands below 2^31: the quotient's floor is exact (the gap to the next integer exceeds one ulp).
  const steps = Math.floor((maxSide * FIT_SCALE_DENOMINATOR) / longest);
  const scale = steps / FIT_SCALE_DENOMINATOR;
  const [w, h] = scaledTerrainSize(width, height, scale);
  return { scale, width: w, height: h, fitted: !Number.isInteger(scale) };
}

/**
 * File names of an upscaled composite and its water mask. Integer scales keep `terrain-map@<scale>x.png`; a fitted
 * composite is named after the integer scale it was made from, `terrain-map@<requested>x-fit.png` (its manifest
 * scale is the fractional one).
 */
export function terrainMapNames(fit: TerrainFit, requested: number): { file: string; waterMask: string } {
  const suffix = fit.fitted ? `@${requested}x-fit` : `@${fit.scale}x`;
  return { file: `terrain-map${suffix}.png`, waterMask: `terrain-water${suffix}.png` };
}
