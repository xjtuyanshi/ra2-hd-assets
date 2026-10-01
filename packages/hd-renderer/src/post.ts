import { dot, exp, float, max, mix, smoothstep, vec3 } from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES } from './atmosphere';
import type { ShaderNode } from './tsl';

/**
 * Faithful display transform for original art.
 *
 * Original maps are calibrated so unlit art (sprites, tile rasters, voxel palette colours) arrives at the display
 * transform with exactly its palette colour at clear noon. A filmic curve would then change that colour: PBR Neutral
 * subtracts a small offset (sRGB 100 lands on 78, so dark paint turns darker and more saturated) and compresses
 * bright saturated colours towards white along a path that turns red fire pink. This curve instead is the identity
 * up to the knee, so every palette colour below it survives unchanged, and above it rolls the brightest channel off
 * towards 1 with a smooth shoulder while scaling all three channels by the same factor. Hue and saturation are kept,
 * so orange explosions stay orange however bright they get.
 */

/**
 * Share of the faithful transform in the display (1 by day). Original maps blend it towards PBR Neutral with the night
 * weight (HdRenderer): the night presentation was tuned under Neutral's toe, so it keeps its calibrated look, while the
 * day shows the palette colours. Materials that compensate their own look for the faithful transform (the HD water)
 * fade that compensation with it.
 */
export const faithfulDisplay = DEFAULT_ATMOSPHERE_NODES.faithfulDisplay;

/** Linear value up to which the curve is the identity (sRGB ~231). */
export const FAITHFUL_KNEE = 0.8;
/** Headroom above the knee: the shoulder approaches KNEE + SPAN = 1 asymptotically. */
export const FAITHFUL_SPAN = 1 - FAITHFUL_KNEE;

/** The curve on the brightest channel (JavaScript twin of faithfulToneMap, for tests and CPU-side checks). */
export function faithfulCurve(m: number): number {
  if (m <= FAITHFUL_KNEE) return m;
  return FAITHFUL_KNEE + FAITHFUL_SPAN * (1 - Math.exp(-(m - FAITHFUL_KNEE) / FAITHFUL_SPAN));
}

/** Apply the curve to a linear RGB colour: every channel scaled by curve(max) / max. */
export function faithfulToneMapRgb(rgb: readonly [number, number, number]): [number, number, number] {
  const m = Math.max(rgb[0], rgb[1], rgb[2]);
  if (m <= FAITHFUL_KNEE) return [rgb[0], rgb[1], rgb[2]];
  const k = faithfulCurve(m) / m;
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

/** TSL version for the post pipeline: linear, exposed scene colour (vec3) in, display-referred linear colour out. */
export function faithfulToneMap(colour: ShaderNode): ShaderNode {
  const rgb: ShaderNode = vec3(colour).max(0);
  const m: ShaderNode = max(rgb.x, max(rgb.y, rgb.z));
  const shoulder: ShaderNode = float(FAITHFUL_KNEE).add(
    float(FAITHFUL_SPAN).mul(float(1).sub(exp(m.sub(FAITHFUL_KNEE).div(FAITHFUL_SPAN).negate()))),
  );
  const scale: ShaderNode = m.greaterThan(FAITHFUL_KNEE).select(shoulder.div(m.max(1e-6)), float(1));
  return rgb.mul(scale);
}

/** Display-linear grading controls; RGB gains are linear multipliers, not encoded colour-picker values. */
export interface CinematicGradeParams {
  /** Per-channel balance, normalized to preserve Rec.709 luminance of grey. */
  gradeBalance: [number, number, number];
  /** Perceptual S-curve strength (-0.5 .. 1); negative values flatten contrast. */
  gradeContrast: number;
  /** Perceptual mid-tone lift, with fixed black and white endpoints. */
  gradePivotLift: number;
  gradeSaturation: number;
  /** Luminance-preserving split tones, weighted by squared perceptual shadow/highlight luma. */
  gradeShadowTint: [number, number, number];
  gradeHighlightTint: [number, number, number];
}

export type CinematicGradeUniforms = { [K in keyof CinematicGradeParams]: ShaderNode };

/** Fresh arrays keep renderer settings and named presets independent during live calibration. */
export function neutralGrade(): CinematicGradeParams {
  return {
    gradeBalance: [1, 1, 1],
    gradeContrast: 0,
    gradePivotLift: 0,
    gradeSaturation: 1,
    gradeShadowTint: [1, 1, 1],
    gradeHighlightTint: [1, 1, 1],
  };
}

/** Neutral settings omit the entire node graph, preserving the existing display path exactly. */
export function hasCinematicGrade(params: CinematicGradeParams): boolean {
  return (
    params.gradeContrast !== 0 ||
    params.gradePivotLift !== 0 ||
    params.gradeSaturation !== 1 ||
    params.gradeBalance.some((v) => v !== 1) ||
    params.gradeShadowTint.some((v) => v !== 1) ||
    params.gradeHighlightTint.some((v) => v !== 1)
  );
}

const REC709 = [0.2126, 0.7152, 0.0722] as const;
const GRADE_GAMMA = 2.2;
const GRADE_EPSILON = 1e-6;
type Rgb = readonly [number, number, number];
const luma = (rgb: Rgb): number => rgb[0] * REC709[0] + rgb[1] * REC709[1] + rgb[2] * REC709[2];
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** JavaScript twin of cinematicGrade, including its input/output gamut clamps. */
export function cinematicGradeRgb(rgb: Rgb, params: CinematicGradeParams): [number, number, number] {
  if (!hasCinematicGrade(params)) return [...rgb];
  const gains = (tint: Rgb): [number, number, number] => {
    const positive = tint.map((v) => Math.max(0, v)) as [number, number, number];
    const level = luma(positive);
    return level > GRADE_EPSILON ? (positive.map((v) => v / level) as [number, number, number]) : [1, 1, 1];
  };
  const balance = gains(params.gradeBalance);
  const contrast = Math.min(1, Math.max(-0.5, params.gradeContrast));
  let c = rgb.map((v, i) => {
    const x = Math.pow(clamp01(v * balance[i]!), 1 / GRADE_GAMMA);
    const y = x + (x * x * (3 - 2 * x) - x) * contrast + params.gradePivotLift * 4 * x * (1 - x);
    // Negative contrast/lift can cross zero; clamp before the fractional power.
    return Math.pow(clamp01(y), GRADE_GAMMA);
  }) as [number, number, number];
  const level = luma(c);
  c = c.map((v) => Math.max(0, level + (v - level) * Math.max(0, params.gradeSaturation))) as [number, number, number];
  const perceptualLuma = Math.pow(clamp01(luma(c)), 1 / GRADE_GAMMA);
  const tint = (colour: Rgb, value: Rgb, weight: number): [number, number, number] => {
    const normalized = gains(value);
    const tinted = colour.map((v, i) => v * (1 + (normalized[i]! - 1) * weight)) as [number, number, number];
    const after = luma(tinted);
    // Preserve the actual colour's luminance, including saturated paint, before final gamut clipping.
    return after > GRADE_EPSILON
      ? (tinted.map((v) => v * (luma(colour) / after)) as [number, number, number])
      : [...colour];
  };
  c = tint(c, params.gradeShadowTint, (1 - perceptualLuma) ** 2);
  c = tint(c, params.gradeHighlightTint, perceptualLuma ** 2);
  return c.map(clamp01) as [number, number, number];
}

/** Pure display-linear TSL transform, after tone mapping and before output encoding; night fading is the caller's. */
export function cinematicGrade(colour: ShaderNode, uniforms: CinematicGradeUniforms): ShaderNode {
  const weights = vec3(...REC709);
  const gains = (value: ShaderNode): ShaderNode => {
    const positive = value.max(0);
    const level = dot(positive, weights);
    return level.greaterThan(GRADE_EPSILON).select(positive.div(level.max(GRADE_EPSILON)), vec3(1));
  };
  const x = vec3(colour)
    .mul(gains(uniforms.gradeBalance))
    .clamp(0, 1)
    .pow(1 / GRADE_GAMMA);
  const curve = mix(x, smoothstep(0, 1, x), uniforms.gradeContrast.clamp(-0.5, 1));
  const y = curve.add(x.mul(float(1).sub(x)).mul(4).mul(uniforms.gradePivotLift));
  let c = y.clamp(0, 1).pow(GRADE_GAMMA);
  c = mix(vec3(dot(c, weights)), c, uniforms.gradeSaturation.max(0)).max(0);
  const perceptualLuma = dot(c, weights)
    .clamp(0, 1)
    .pow(1 / GRADE_GAMMA);
  const tint = (input: ShaderNode, value: ShaderNode, weight: ShaderNode): ShaderNode => {
    const tinted = input.mul(mix(vec3(1), gains(value), weight));
    const after = dot(tinted, weights);
    return after
      .greaterThan(GRADE_EPSILON)
      .select(tinted.mul(dot(input, weights).div(after.max(GRADE_EPSILON))), input);
  };
  c = tint(c, uniforms.gradeShadowTint, float(1).sub(perceptualLuma).pow(2));
  c = tint(c, uniforms.gradeHighlightTint, perceptualLuma.pow(2));
  return c.clamp(0, 1);
}
