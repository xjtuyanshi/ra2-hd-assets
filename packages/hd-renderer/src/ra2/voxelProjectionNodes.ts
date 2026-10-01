import {
  cameraWorldMatrix,
  cos,
  float,
  floor,
  fract,
  int,
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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from '../tsl';
import type { VoxelProjectionPart, VoxelProjectionState } from './voxelProjection';

/** Exactly four atlas samples, independent of instance count. Positions and yaw follow the complete mesh matrix. */
export function projectedVoxelColour(
  part: VoxelProjectionPart,
  state: VoxelProjectionState,
  rawPalette: (index: ShaderNode) => ShaderNode,
  referenceLight: ShaderNode,
  currentLight: ShaderNode,
): { colour: ShaderNode; coverage: ShaderNode; paint: ShaderNode } {
  const { manifest, spec } = part;
  const axis: ShaderNode = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
  const theta: ShaderNode = axis.z.negate().atan(axis.x).toVar();
  const facing: ShaderNode = fract(
    float(Math.PI / 2)
      .sub(theta)
      .div(2 * Math.PI),
  ).mul(256);
  const f: ShaderNode = facing.div(manifest.facingStep);
  const k0: ShaderNode = floor(f);
  const k1: ShaderNode = k0.add(1).mod(manifest.frames);
  const fraction: ShaderNode = fract(f);
  const weight: ShaderNode = mix(step(0.5, fraction), fraction, state.blend.clamp()).toVar();
  const worldOffset: ShaderNode = modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz.toVar();
  const jx = vec3(...manifest.jacobian[0]),
    jy = vec3(...manifest.jacobian[1]);
  const sample = (k: ShaderNode): { colour: ShaderNode; alpha: ShaderNode; paint: ShaderNode } => {
    const delta: ShaderNode = float(Math.PI / 2)
      .sub(k.mul((manifest.facingStep * 2 * Math.PI) / 256))
      .sub(theta);
    const c: ShaderNode = cos(delta),
      s: ShaderNode = sin(delta);
    const d: ShaderNode = vec3(
      c.mul(worldOffset.x).add(s.mul(worldOffset.z)),
      worldOffset.y,
      s.negate().mul(worldOffset.x).add(c.mul(worldOffset.z)),
    );
    const pivot: ShaderNode = part.pivots.element(int(k));
    const rect: ShaderNode = part.rects.element(int(k));
    const px: ShaderNode = pivot.add(vec2(jx.dot(d), jy.dot(d))).toVar();
    const inside: ShaderNode = step(rect.x, px.x)
      .mul(step(rect.y, px.y))
      .mul(float(1).sub(step(rect.x.add(rect.z), px.x)))
      .mul(float(1).sub(step(rect.y.add(rect.w), px.y)));
    // Top-left atlas convention, upload flipY=false. Clamp to this frame even when coverage is zero.
    const uv: ShaderNode = px.clamp(rect.xy.add(0.5), rect.xy.add(rect.zw).sub(0.5)).div(vec2(...spec.size));
    const bias: ShaderNode = state.sharpen.clamp(0, 2).negate();
    const colour: ShaderNode = texture(part.colour, uv).bias(bias).toVar();
    const paint: ShaderNode = texture(part.paint, uv).bias(bias).rgb.toVar();
    return { colour: sRGBTransferEOTF(colour.rgb), alpha: colour.a.mul(inside), paint };
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
  const n: ShaderNode = normalWorld;
  if (manifest.house) {
    const ramp: ShaderNode = a.paint.gb.mul(ma).add(b.paint.gb.mul(mb)).div(max(paintWeight, 1e-5));
    const index: ShaderNode = ramp.x.mul(15).add(16);
    const lower: ShaderNode = floor(index);
    let house: ShaderNode = mix(rawPalette(lower), rawPalette(lower.add(1).min(31)), fract(index)).mul(ramp.y.mul(2));
    // Image models paint the faction colour as nearly flat glossy red (it must stay remappable), so it reads like a
    // sticker next to the shaded redraw. Give it form from the mesh: Lambert against the current sun, normalised to
    // 1 at a typical lit face (n.l = 0.65), plus a Blinn-Phong glint toward the fixed iso camera.
    const lambert: ShaderNode = max(n.dot(currentLight), 0);
    const shade: ShaderNode = lambert.mul(0.75).add(0.35).div(0.35 + 0.75 * 0.65);
    const view: ShaderNode = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.normalize();
    const glint: ShaderNode = pow(max(n.dot(currentLight.add(view).normalize()), 0), 28).mul(state.paintSpec.max(0));
    house = house.mul(mix(1, shade, state.paintShade.clamp())).add(glint);
    colour = mix(colour, house, mask);
  }
  // Form light from the smooth mesh on the whole redraw (house paint already has its own shade above).
  const lit: ShaderNode = max(n.dot(currentLight), 0);
  const form: ShaderNode = lit.mul(0.8).add(0.3).div(0.3 + 0.8 * 0.65);
  colour = colour.mul(mix(1, form, state.formShade.clamp().mul(float(1).sub(mask))));
  const luma: ShaderNode = colour.dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-4).toVar();
  // Shadows take the full power, highlights about a third of it: the redraws are bright, and a symmetric power
  // pushed light hulls to clipped white; the glint below supplies the bright edges instead.
  const power: ShaderNode = state.contrast.sub(1).mul(mix(1, 0.35, step(0.18, luma)));
  colour = colour.mul(pow(luma.div(0.18), power));
  const eye: ShaderNode = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.normalize();
  const sheen: ShaderNode = pow(max(n.dot(currentLight.add(eye).normalize()), 0), 24)
    .mul(smoothstep(0.03, 0.35, luma))
    .mul(step(1e-4, lit))
    .mul(state.spec.max(0));
  colour = colour.add(vec3(1, 0.97, 0.92).mul(sheen));
  const ratio: ShaderNode = max(n.dot(currentLight), 0)
    .mul(0.4)
    .add(0.6)
    .div(max(n.dot(referenceLight), 0).mul(0.4).add(0.6));
  const grey: ShaderNode = colour.dot(vec3(0.2126, 0.7152, 0.0722));
  colour = mix(vec3(grey), colour, state.saturation).max(0).mul(state.gain);
  return {
    colour: colour.mul(mix(1, ratio, state.relight.clamp())),
    coverage: coverage.mul(state.strength.clamp()),
    paint: manifest.house ? mask : float(0),
  };
}
