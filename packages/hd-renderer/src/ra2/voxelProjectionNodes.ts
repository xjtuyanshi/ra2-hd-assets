import {
  cameraWorldMatrix,
  cos,
  float,
  floor,
  fract,
  int,
  ivec2,
  max,
  mix,
  modelWorldMatrix,
  normalWorld,
  pow,
  positionLocal,
  smoothstep,
  sRGBTransferEOTF,
  sin,
  step,
  texture,
  textureLoad,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from '../tsl';
import type { VoxelProjectionInputs, VoxelProjectionState } from './voxelProjection';
import { highlightExponent } from './spriteLook';

/**
 * The look's light gains a projected redraw takes: the voxel units' own (VoxelLightingState, set from HdSettings
 * vehicleSunGain / vehicleSpecularSize by the renderer), not the sprite look's, so vehicles can be lit apart from
 * terrain, buildings and infantry.
 */
export interface VoxelLookGains {
  /** Sun weight of the Lambert terms (form light, house paint shade, relight ratio); 1 = neutral. */
  sunGain: ShaderNode;
  /** Highlight size: glint exponents divided by its square, intensity multiplied by its square; 1 = neutral. */
  specularSize: ShaderNode;
}

/** Upright source coordinates for a projected twin whose draw matrix has been flattened or mirrored. */
interface ProjectionBasis {
  matrix: ShaderNode;
  position: ShaderNode;
  normal: ShaderNode;
}

/**
 * Exactly four atlas samples, independent of instance count. Positions and yaw follow the complete mesh matrix.
 * `part` is the slot set the drawn object's part is bound to; `house` (a part with house paint or without) is the
 * only thing about a part that changes the shader.
 */
export function projectedVoxelColour(
  part: VoxelProjectionInputs,
  house: boolean,
  state: VoxelProjectionState,
  rawPalette: (index: ShaderNode) => ShaderNode,
  referenceLight: ShaderNode,
  currentLight: ShaderNode,
  gains: VoxelLookGains,
  basis?: ProjectionBasis,
): { colour: ShaderNode; albedo: ShaderNode; coverage: ShaderNode; paint: ShaderNode } {
  const matrix = basis?.matrix ?? modelWorldMatrix;
  const axis: ShaderNode = matrix.mul(vec4(1, 0, 0, 0)).xyz;
  const theta: ShaderNode = axis.z.negate().atan(axis.x).toVar();
  const facing: ShaderNode = fract(
    float(Math.PI / 2)
      .sub(theta)
      .div(2 * Math.PI),
  ).mul(256);
  const f: ShaderNode = facing.div(part.facingStep);
  const k0: ShaderNode = floor(f);
  const k1: ShaderNode = k0.add(1).mod(part.frameCount);
  const fraction: ShaderNode = fract(f);
  const weight: ShaderNode = mix(step(0.5, fraction), fraction, state.blend.clamp()).toVar();
  const worldOffset: ShaderNode = matrix.mul(vec4(basis?.position ?? positionLocal, 0)).xyz.toVar();
  const jx = part.jacobianX,
    jy = part.jacobianY;
  const sample = (k: ShaderNode): { colour: ShaderNode; alpha: ShaderNode; paint: ShaderNode } => {
    const delta: ShaderNode = float(Math.PI / 2)
      .sub(k.mul(part.frameAngle))
      .sub(theta);
    const c: ShaderNode = cos(delta),
      s: ShaderNode = sin(delta);
    const d: ShaderNode = vec3(
      c.mul(worldOffset.x).add(s.mul(worldOffset.z)),
      worldOffset.y,
      s.negate().mul(worldOffset.x).add(c.mul(worldOffset.z)),
    );
    const pivot: ShaderNode = textureLoad(part.frameTable, ivec2(int(k), 0)).xy;
    const rect: ShaderNode = textureLoad(part.frameTable, ivec2(int(k), 1));
    const px: ShaderNode = pivot.add(vec2(jx.dot(d), jy.dot(d))).toVar();
    const inside: ShaderNode = step(rect.x, px.x)
      .mul(step(rect.y, px.y))
      .mul(float(1).sub(step(rect.x.add(rect.z), px.x)))
      .mul(float(1).sub(step(rect.y.add(rect.w), px.y)));
    // Top-left atlas convention, upload flipY=false. Clamp to this frame even when coverage is zero.
    const uv: ShaderNode = px.clamp(rect.xy.add(0.5), rect.xy.add(rect.zw).sub(0.5)).div(part.atlasSize);
    const bias: ShaderNode = state.sharpen.clamp(0, 2).negate();
    const colour: ShaderNode = texture(part.colour, uv).bias(bias).toVar();
    const paint: ShaderNode = texture(part.paint, uv).bias(bias).rgb.toVar();
    // Pages with headroom store sRGB / exposure (see VoxelProjectionManifest.exposure); 1 leaves the sample as is
    // (a product with 1 is exact), and as a uniform it keeps the shader text the same for every page.
    return { colour: sRGBTransferEOTF(colour.rgb.mul(part.exposure)), alpha: colour.a.mul(inside), paint };
  };
  const a = sample(k0),
    b = sample(k1);
  const wa: ShaderNode = a.alpha.mul(float(1).sub(weight));
  const wb: ShaderNode = b.alpha.mul(weight);
  const coverage: ShaderNode = wa.add(wb).toVar();
  let colour: ShaderNode = a.colour.mul(wa).add(b.colour.mul(wb)).div(max(coverage, 1e-5));
  // t/ratio are conditional on paint coverage, preventing the unpainted neighbour from diluting a house ramp.
  const ma: ShaderNode = wa.mul(a.paint.r),
    mb: ShaderNode = wb.mul(b.paint.r);
  const paintWeight: ShaderNode = ma.add(mb);
  const mask: ShaderNode = paintWeight.div(max(coverage, 1e-5));
  const n: ShaderNode = basis?.normal ?? normalWorld;
  const highlightGain: ShaderNode = gains.specularSize.mul(gains.specularSize);
  let albedo: ShaderNode = colour;
  if (house) {
    const ramp: ShaderNode = a.paint.gb.mul(ma).add(b.paint.gb.mul(mb)).div(max(paintWeight, 1e-5));
    const index: ShaderNode = ramp.x.mul(15).add(16);
    const lower: ShaderNode = floor(index);
    let house: ShaderNode = mix(rawPalette(lower), rawPalette(lower.add(1).min(31)), fract(index)).mul(ramp.y.mul(2));
    // Preserve the atlas and remapped paint before all sun/form/glint terms for ambient-only reflections.
    albedo = mix(colour, house, mask);
    // Image models paint the faction colour as nearly flat glossy red (it must stay remappable), so it reads like a
    // sticker next to the shaded redraw. Give it form from the mesh: Lambert against the current sun, normalised to
    // 1 at a typical lit face (n.l = 0.65), plus a Blinn-Phong glint toward the fixed iso camera.
    const lambert: ShaderNode = max(n.dot(currentLight), 0);
    const shade: ShaderNode = lambert
      .mul(0.75)
      .mul(gains.sunGain)
      .add(0.35)
      .div(0.35 + 0.75 * 0.65);
    const view: ShaderNode = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.normalize();
    const glint: ShaderNode = pow(
      max(n.dot(currentLight.add(view).normalize()), 0),
      highlightExponent(28, highlightGain),
    )
      .mul(state.paintSpec.max(0))
      .mul(highlightGain);
    house = house.mul(mix(1, shade, state.paintShade.clamp())).add(glint);
    colour = mix(colour, house, mask);
  }
  // Form light from the smooth mesh on the whole redraw (house paint already has its own shade above).
  const lit: ShaderNode = max(n.dot(currentLight), 0);
  const form: ShaderNode = lit
    .mul(0.8)
    .mul(gains.sunGain)
    .add(0.3)
    .div(0.3 + 0.8 * 0.65);
  colour = colour.mul(mix(1, form, state.formShade.clamp().mul(float(1).sub(mask))));
  const luma: ShaderNode = colour
    .dot(vec3(0.2126, 0.7152, 0.0722))
    .max(1e-4)
    .toVar();
  // Shadows take the full power, highlights about a third of it: the redraws are bright, and a symmetric power
  // pushed light hulls to clipped white; the glint below supplies the bright edges instead.
  const power: ShaderNode = state.contrast.sub(1).mul(mix(1, 0.35, step(0.18, luma)));
  colour = colour.mul(pow(luma.div(0.18), power));
  const eye: ShaderNode = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.normalize();
  const sheen: ShaderNode = pow(max(n.dot(currentLight.add(eye).normalize()), 0), highlightExponent(24, highlightGain))
    .mul(smoothstep(0.03, 0.35, luma))
    .mul(step(1e-4, lit))
    .mul(state.spec.max(0))
    .mul(highlightGain);
  colour = colour.add(vec3(1, 0.97, 0.92).mul(sheen));
  const ratio: ShaderNode = max(n.dot(currentLight), 0)
    .mul(0.4)
    .mul(gains.sunGain)
    .add(0.6)
    .div(max(n.dot(referenceLight), 0).mul(0.4).add(0.6));
  const grey: ShaderNode = colour.dot(vec3(0.2126, 0.7152, 0.0722));
  colour = mix(vec3(grey), colour, state.saturation).max(0).mul(state.gain);
  const albedoLuma: ShaderNode = albedo
    .dot(vec3(0.2126, 0.7152, 0.0722))
    .max(1e-4)
    .toVar();
  const albedoPower: ShaderNode = state.contrast.sub(1).mul(mix(1, 0.35, step(0.18, albedoLuma)));
  albedo = albedo.mul(pow(albedoLuma.div(0.18), albedoPower));
  const albedoGrey: ShaderNode = albedo.dot(vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(vec3(albedoGrey), albedo, state.saturation).max(0).mul(state.gain);
  return {
    colour: colour.mul(mix(1, ratio, state.relight.clamp())),
    albedo,
    coverage: coverage.mul(state.strength.clamp()),
    paint: house ? mask : float(0),
  };
}
