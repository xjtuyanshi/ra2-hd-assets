import { Fn, cameraFar, cameraNear, clamp, depth, floor, max, min, round, textureLoad, vec2 } from 'three/tsl';
import type { NodeBuilder, Texture } from 'three/webgpu';
import { isShadowPass } from '../painterDepth';
import type { ShaderNode } from '../tsl';
import { GROUND_DEPTH, VERTICAL_DEPTH } from './nativeDepth';

export { GROUND_DEPTH, VERTICAL_DEPTH } from './nativeDepth';
const FOUNDATION_DEPTH = 1 / (Math.SQRT2 * Math.cos(Math.PI / 6));
export const SPRITE_DECAL_LIFT = 0.02;
export const EFFECT_DECAL_LIFT = 0.025;
// At the SAME screen pixel, raising a horizontal decal by h pulls its depth forward by h / sin(30 degrees),
// not h * sin(30 degrees). Upright lower rows must clear that plane: 0.03 let SHP shadows cut holes in walls.
export const CARD_CLEARANCE = EFFECT_DECAL_LIFT / Math.sin(Math.PI / 6) + 0.01;

/**
 * Camera-space displacement from the unpushed billboard. w/h describe a rectangular foundation; dx/ds move a
 * component's draw point back to its owner's foundation. w=-1 describes a horizontal deck h world units up.
 *
 * YR's building draw (0x43D85F) uses ZGradient=2 and BUILDNGZ.SHA, not its GetYSort plane. Without that per-art
 * Z-shape we intersect each screen column with the foundation's front faces: s=min(2w-d,2h+d). This analytic
 * facade ramp is an approximation, not a reconstruction of roof recesses or custom ZAdjust. See painter-order.md.
 * Above the base, ordinary cards stand vertically; below it, their depth follows the ground under that pixel.
 * Thus frame padding cannot change anchor depth or cut a unit's feet with ground. Explosion volumes add their
 * separately bounded per-fragment bias through cardDepthNode's bias input (see fireballDepth.ts).
 */
export function cardDepthPush(px: number, py: number, w = 0, h = 0, dx = 0, ds = 0): number {
  const ground = py * GROUND_DEPTH;
  if (w < 0) return ground + h / Math.sin(Math.PI / 6) + CARD_CLEARANCE;
  const d = px / 30 + dx;
  const front = w > 0 ? Math.max(0, Math.min(2 * w - d, 2 * h + d)) + ds : 0;
  return Math.max(ground, front * FOUNDATION_DEPTH - py * VERTICAL_DEPTH) + CARD_CLEARANCE;
}

/** Extra nearness of the ground-following lower rim over the upright anchor plane (world units; py is native px). */
export function cardGroundExcess(py: number): number {
  return Math.max(0, py * (GROUND_DEPTH + VERTICAL_DEPTH));
}

export function cardGroundExcessNode(py: ShaderNode): ShaderNode {
  return max(0, py.mul(GROUND_DEPTH + VERTICAL_DEPTH));
}

/** Pull a ground-plane draw point onto its owner's facade, without counting its existing physical depth twice. */
export function foundationPointPush(x: number, z: number, w: number, h: number): number {
  return cardDepthPush(30 * (x - z), 15 * (x + z), w, h) - (x + z) * Math.sqrt(3 / 8);
}

/** Same expression as cardDepthPush, evaluated per fragment so the facade ridge is not flattened by the quad. */
export function cardDepthNode(
  px: ShaderNode,
  py: ShaderNode,
  profile: ShaderNode,
  placementPush: ShaderNode,
  bias: ShaderNode,
  flat: ShaderNode,
  native?: {
    /** (mode, template x/card bottom, template y/card bonus, body base/ground bonus). */
    data: ShaderNode;
    /** (owner-relative pixel x/y, owner-relative physical nearness, sprite draw-pass code). */
    offset: ShaderNode;
    template?: { texture: Texture; width: number; height: number };
  },
): ShaderNode {
  const d = px.div(30).add(profile.z);
  const front = max(0, min(profile.x.mul(2).sub(d), profile.y.mul(2).add(d))).add(profile.w);
  const ground = py.mul(GROUND_DEPTH);
  const facade = profile.x.greaterThan(0).select(front.mul(FOUNDATION_DEPTH), 0).sub(py.mul(VERTICAL_DEPTH));
  let push = profile.x
    .lessThan(0)
    .select(ground.add(profile.y.div(Math.sin(Math.PI / 6))), max(ground, facade))
    .add(CARD_CLEARANCE);
  if (native) {
    const n = native.data;
    const ownerPixel = vec2(px, py).add(native.offset.xy);
    const card = n.y
      .add(n.z)
      .add(floor(n.y.sub(ownerPixel.y).div(3)))
      .mul(GROUND_DEPTH);
    const plane = ownerPixel.y.add(n.w).mul(GROUND_DEPTH);
    let nativePush = n.x.equal(2).select(plane, card);
    if (native.template) {
      const coords = clamp(
        n.yz.add(floor(ownerPixel)),
        vec2(0),
        vec2(native.template.width - 1, native.template.height - 1),
      );
      // R8 UNORM carries the extractor's transformed bytes, not the original SHP palette indices.
      const byte = round(textureLoad(native.template.texture, coords).r.mul(255));
      const signed = byte.greaterThanEqual(128).select(byte.sub(256), byte);
      nativePush = n.x.equal(1).select(n.w.add(signed).mul(GROUND_DEPTH), nativePush);
    }
    const enabled = native.template ? n.x.greaterThan(0) : n.x.greaterThan(1);
    push = enabled.select(nativePush.sub(native.offset.z).add(CARD_CLEARANCE), push);
  }
  const corrected = depth.sub(push.sub(placementPush).add(bias).div(cameraFar.sub(cameraNear)));
  return Fn(([], builder: NodeBuilder) => (isShadowPass(builder) ? depth : flat.select(depth, corrected)))();
}
