/** Capture-only markers, outside the anchor range of the orthographic scene. */
export const ALWAYS_COVER_CODE = -1024;
export const NOT_CAPTURED_CODE = -65504;
/** Camera-space cells: covers 3 half-float roundings (3*0.0625 at |relative depth| < 256) plus D24 rounding. */
export const OBJECT_DEPTH_EPSILON = 0.2;
/**
 * Cells. Texels whose decoded anchor codes differ by at most this belong to the same object for the reduction's
 * spread. Above the half-float code error bound (anchorCodeErrorBound(32) < 0.047), far below an object's footprint.
 */
export const OBJECT_CODE_TOLERANCE = 0.1;
/** Reduction placeholder for an uncaptured texel; larger than any supported relative depth. */
export const EMPTY_DEPTH = 1e6;
/** Limit dilation across unrelated depth discontinuities to two camera-space cells. */
export const OBJECT_DEPTH_CAP = 2;
/** depth32float + RG16F capture + two RGBA16F reduction records, all single-sampled. */
export const OBJECT_DEPTH_BYTES_PER_PIXEL = 4 + 4 + 2 * 8;

export interface CapturedDepthTexel {
  /** Original orthographic depth, unmodified by the capture. */
  depth: number;
  r: number;
  g: number;
}
export interface ReducedObjectDepth {
  /** Camera-space distances relative to the frame's depth reference. */
  sMin: number;
  sMax: number;
  code: number;
  valid: boolean;
}
export type ReducedObjectDepthPair = readonly [ReducedObjectDepth, ReducedObjectDepth];

/** Both RGB blend factors are identical: over clear, (code*a*b)/(a*b) = code, including soft edges. */
export function encodeAnchorCode(code: number, alpha: number): [number, number] {
  return [code * alpha, alpha];
}
export function decodeAnchorCode(r: number, g: number): number {
  return g > 0 ? r / g : NOT_CAPTURED_CODE;
}

/**
 * Pure twin of the GPU's clamped 3x3 reduction. Supply nine texels in row-major order (centre at index 4).
 * A keeps the centre's object, or the nearest captured object if the centre is absent. B keeps the nearest
 * captured object with a different code. Each spread uses only that record's own object's texels.
 */
export function reduceObjectDepth(
  texels: readonly CapturedDepthTexel[],
  near: number,
  far: number,
  depthReference: number,
): ReducedObjectDepthPair {
  const samples = texels.map((texel) =>
    texel.depth < 1 && texel.g > 0
      ? { s: near + texel.depth * (far - near) - depthReference, code: decodeAnchorCode(texel.r, texel.g) }
      : { s: EMPTY_DEPTH, code: NOT_CAPTURED_CODE },
  );
  let nearest = { s: EMPTY_DEPTH, code: NOT_CAPTURED_CODE };
  for (const sample of samples) if (sample.s < nearest.s) nearest = sample;
  const centre = samples[4];
  const a = centre && centre.s < EMPTY_DEPTH ? centre : nearest;
  let b = { s: EMPTY_DEPTH, code: NOT_CAPTURED_CODE };
  for (const sample of samples)
    if (sample.s < b.s && Math.abs(sample.code - a.code) > OBJECT_CODE_TOLERANCE) b = sample;
  const record = (seed: { s: number; code: number }): ReducedObjectDepth => {
    if (seed.s >= EMPTY_DEPTH) return { sMin: 0, sMax: 0, code: 0, valid: false };
    let sMin = EMPTY_DEPTH,
      sMax = -EMPTY_DEPTH;
    for (const sample of samples)
      if (sample.s < EMPTY_DEPTH && Math.abs(sample.code - seed.code) <= OBJECT_CODE_TOLERANCE) {
        sMin = Math.min(sMin, sample.s);
        sMax = Math.max(sMax, sample.s);
      }
    return { sMin, sMax, code: seed.code, valid: true };
  };
  return [record(a), record(b)];
}

/** Pure twin of the whole per-(fire, object) decision, including conservative pull/push and empty fallback. */
export function objectDepthCombine(
  base: number,
  reduced: ReducedObjectDepthPair,
  fireCode: number,
  frontDistance: number,
  near: number,
  far: number,
  depthReference: number,
): number {
  let p = Infinity,
    q = -Infinity;
  for (const record of reduced) {
    if (!record.valid) continue;
    const spread = Math.min(record.sMax - record.sMin, OBJECT_DEPTH_CAP);
    // Match the shader's float32 subtraction/comparison at the inclusive front boundary.
    const cover = Math.fround(record.code - fireCode) < Math.fround(frontDistance);
    if (cover) p = Math.min(p, record.sMin - spread - OBJECT_DEPTH_EPSILON);
    else q = Math.max(q, record.sMax + spread + OBJECT_DEPTH_EPSILON);
  }
  const normalized = (s: number) => (s + depthReference - near) / (far - near);
  // If Q > P, a COVER surface is in front of a FRONT object. That covered surface is the visible front,
  // so cover wins: apply P last. Unbounded sides (and an entirely empty window) preserve base exactly.
  return Math.min(Math.max(base, normalized(q)), normalized(p));
}

/** Worst-case absolute error after RG16F R/G and one further half-float code store, for normal alpha/products. */
export function anchorCodeErrorBound(maxAbsCode: number): number {
  const u = 2 ** -11;
  return maxAbsCode * ((1 + u) ** 2 / (1 - u) - 1) + 2 ** -20;
}
