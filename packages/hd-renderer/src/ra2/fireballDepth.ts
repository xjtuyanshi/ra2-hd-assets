import { float, floor, fract, max, min, sqrt } from 'three/tsl';
import type { ShaderNode } from '../tsl';
import { cardGroundExcess, cardGroundExcessNode } from './cardDepth';
import { MAX_PAINTER_BIAS } from './painterOrder';

/** Shared by native/HD explosion cards and their incandescent garnish, not smoke or other Air art. */
export const FIREBALL_VOLUME = {
  radiusFactor: 1,
  anchorBias: 0.5,
  // Same-ray upright-card separation is distance / cos(30 degrees). Reserve 0.03 at 1.5 cells, including
  // Air's 0.04 traversal bias: 1.5 / cos(30) - 0.5 - 0.04 - 0.03 = 1.16205; round down to 1.16.
  maxRadius: 1.16,
} as const;

/** Current displayed diameter in world units; padding and atlas resolution are not part of the volume. */
export function fireballRadius(width: number, height = width): number {
  return Math.min(FIREBALL_VOLUME.maxRadius, Math.max(0, width, height) * 0.5 * FIREBALL_VOLUME.radiusFactor);
}

/** Same radius policy for procedural fire whose displayed diameter changes on the presentation clock. */
export function fireballRadiusNode(diameter: ShaderNode): ShaderNode {
  return min(FIREBALL_VOLUME.maxRadius, max(0, diameter).mul(0.5 * FIREBALL_VOLUME.radiusFactor));
}

/** Camera-space nearness of the sphere's front surface at screen-plane distance r (both in world units). */
export function sphereDepthBias(r: number, radius: number): number {
  return Math.sqrt(Math.max(0, radius * radius - r * r));
}

/** Fragment-stage twin of sphereDepthBias; do not interpolate the curved depth from quad vertices. */
export function sphereDepthBiasNode(r: ShaderNode, radius: ShaderNode): ShaderNode {
  return sqrt(max(0, radius.mul(radius).sub(r.mul(r))));
}

/**
 * constantBias includes traversal and the legacy merged-building engulf. Take the maximum, not the sum: both
 * profiles describe the same engulfing front. Adding them would swallow buildings/units beyond either profile.
 * The existing garnish's 0.5 support also covers the card's own anchor; a sphere alone at r=0.6R reaches only 0.8R,
 * insufficient by itself at one horizontal cell of separation (1 / cos(30) = 1.1547 camera units). TerrainClass
 * and whole-object unit/building coverage now use the separate per-fire terrainDepth.ts combination. This
 * bounded sphere is retained as the fallback for unclassified surfaces.
 * Evaluate the sphere from the upright anchor plane, then max with the original ground-following rim: adding
 * depth to that already-nearer ground intersection would count the lower rim twice and hide foreground feet.
 * py is the fragment's displayed offset below the anchor, in native pixels (HD display size already applied).
 */
export function fireballDepthBias(r: number, radius: number, constantBias = 0, py = 0): number {
  return radius > 0
    ? Math.max(
        constantBias,
        MAX_PAINTER_BIAS + FIREBALL_VOLUME.anchorBias + sphereDepthBias(r, radius) - cardGroundExcess(py),
      )
    : constantBias;
}

/** Same combination as fireballDepthBias, retaining all other card policies when radius is zero. */
export function fireballDepthBiasNode(
  r: ShaderNode,
  radius: ShaderNode,
  constantBias: ShaderNode,
  py: ShaderNode,
): ShaderNode {
  return radius.greaterThan(0).select(
    max(
      constantBias,
      float(MAX_PAINTER_BIAS + FIREBALL_VOLUME.anchorBias)
        .add(sphereDepthBiasNode(r, radius))
        .sub(cardGroundExcessNode(py)),
    ),
    constantBias,
  );
}

// Reuse the draw-mode scalar: integer 0/1/2 = card/flat/shadow; fractional part = R / 4 (< 0.3).
// Radius is zero for flat/shadow cards. The HD six-vec4 layout and native four instance buffers do not grow.
export function packEffectDrawRadius(draw: number, radius: number): number {
  return draw + radius / 4;
}

export function unpackEffectDrawRadius(packed: number): { draw: number; radius: number } {
  const draw = Math.floor(packed);
  return { draw, radius: (packed - draw) * 4 };
}

/** TSL unpacking matches the Float32 upload/CPU twin without bit casts or another instanced attribute. */
export function unpackEffectDrawRadiusNode(packed: ShaderNode): { draw: ShaderNode; radius: ShaderNode } {
  return { draw: floor(packed), radius: fract(packed).mul(4) };
}
