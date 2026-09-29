import { exp, float, max, uniform, vec3 } from 'three/tsl';
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
export const faithfulDisplay = uniform(1);

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
