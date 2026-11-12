import {
  abs,
  cameraPosition,
  color,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, sampleLightField } from '../atmosphere';
import { RIPPLE_SLOPE_RANGE, waterTextures } from '../proceduralTextures';
import type { ShaderNode } from '../tsl';
import type { BedWaterInputs, BedWaterLook, WaterLook, WaterLookInputs } from './waterLook';

/** Candidate look only. These budgets are targets for masked, same-camera capture, not measured guarantees. */
export const CLEAR_WATER = {
  depthCells: 5,
  absorption: [5.2, 3.2, 2.8],
  slope: 0.014,
  refraction: 0.16,
  maxRefraction: 0.018,
  foamPeriod: 8,
  foamFade: 0.5,
  causticGain: 0.035,
  reflection: 0.18,
  reflectionMax: 0.26,
  sunGain: 0.045,
  motionTarget: 1.5,
  anisotropyTarget: 0.35,
  highlightTarget: 0.02,
  saturationTarget: 0.55,
} as const;

// Equal-energy directions balance the source normal map's preferred wind axis. The third octave is deliberately weak.
export const CLEAR_LAYERS = [
  [0, 4.8, 0.09, 1],
  [Math.PI / 2, 4.1, -0.075, 1],
  [Math.PI / 4, 2.6, 0.055, 0.25],
] as const;

/** sRGB palette before scene lighting. Leave chroma headroom for the existing cinematic display grade. */
export function clearPalette(theater = '') {
  switch (theater.toLowerCase()) {
    case 'snow':
      return { deep: 0x465f6a, shallow: 0x719993, bed: 0x8e918e };
    case 'desert':
      return { deep: 0x42665f, shallow: 0x7ca699, bed: 0xb7ab8e };
    case 'urban':
    case 'newurban':
      return { deep: 0x4b6164, shallow: 0x7c9993, bed: 0x90958e };
    default:
      return { deep: 0x426369, shallow: 0x75a19a, bed: 0xb1aa96 };
  }
}

/** CPU reference of the shader's depth proxy, including steep rocky/cliff shores. */
export function clearDepth(shore: number, hard = 0): number {
  const t = Math.max(0, Math.min(1, shore / CLEAR_WATER.depthCells));
  return Math.max(t * t * (3 - 2 * t), Math.max(0, Math.min(1, hard)) * 0.9);
}
export function clearTransmission(depth: number): number[] {
  return CLEAR_WATER.absorption.map((a) => Math.exp(-a * Math.max(0, depth)));
}

export function clearSlope(p: ShaderNode): ShaderNode {
  let slope: ShaderNode = vec2(0);
  for (const [angle, scale, speed, weight] of CLEAR_LAYERS) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const uv = vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)))
      .sub(vec2(time.mul(speed), time.mul(speed * 0.37)))
      .div(scale);
    // Fixed mip 2 filters fine normal energy before it can shimmer or alias in a low-bitrate encode.
    const n = texture(waterTextures().ripple, uv).level(float(2)).rg.mul(2).sub(1).mul(RIPPLE_SLOPE_RANGE);
    slope = slope.add(vec2(n.x.mul(c).sub(n.y.mul(s)), n.x.mul(s).add(n.y.mul(c))).mul(weight));
  }
  return slope.mul(CLEAR_WATER.slope / Math.sqrt(2.0625));
}
export function clearNormal(p: ShaderNode): ShaderNode {
  const slope = clearSlope(p);
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
}
export function clearReflectionOffset(p: ShaderNode): ShaderNode {
  return clearSlope(p).mul(0.012);
}

/** Same terrain/mirror/light passes as enhanced, without sheen trains, painted chop, glitter hash or extra targets. */
export function clearWaterLook(
  inputs: WaterLookInputs & { bedAt?: (offset: ShaderNode) => ShaderNode },
  nodes = DEFAULT_ATMOSPHERE_NODES,
): WaterLook {
  const { position: p, shore, art, waterness, uniforms } = inputs;
  const { night, sceneBrightness } = nodes;
  const palette = clearPalette(inputs.theater);
  const hard: ShaderNode = inputs.calm ?? float(0);
  const depth = max(smoothstep(0, CLEAR_WATER.depthCells, max(shore, 0)), hard.mul(0.9));
  const slope = clearSlope(p.xz);
  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(depth.negate()));
  // Refract existing sand/rock art only. Where the cache has no underwater art, use a quiet neutral bed instead of
  // inventing detail from the original sea's painted sparkle. The transition mask still preserves shoreline art.
  const offset = slope.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.15, depth));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  const bed = inputs.bedAt
    ? inputs.bedAt(bounded)
    : mix(
        color(palette.bed),
        art,
        float(1)
          .sub(waterness)
          .mul(smoothstep(0.4, 0, depth)),
      );
  const caustic = texture(
    waterTextures().caustics,
    p.xz
      .div(1.8)
      .add(slope.mul(0.12))
      .add(vec2(time.mul(0.012), time.mul(-0.009))),
  )
    .r.sub(0.5)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.4, 0.05, depth))
    .mul(float(1).sub(hard));
  const column = mix(color(palette.shallow), color(palette.deep), depth);
  let body: ShaderNode = bed
    .mul(float(1).add(caustic))
    .mul(transmission)
    .add(column.mul(vec3(1).sub(transmission)));
  // Water-local compensation: the cinematic grade remains unchanged for the rest of the scene. A linear-channel
  // floor limits absorption's cyan chroma; the mild warm bias reserves room for cool shadow/blue-balance grading.
  const optical = smoothstep(0, 0.15, depth);
  body = body.mul(mix(vec3(1), vec3(1.1, 1, 0.88), optical));
  const peak = max(max(body.r, body.g), body.b);
  body = mix(body, max(body, vec3(peak.mul(0.38))), optical).mul(mix(float(1), float(0.48), night.mul(optical)));

  const view = normalize(cameraPosition.sub(p));
  const reflectedDirection = reflect(view.negate(), normal);
  const fresnel = pow(float(1).sub(max(dot(normal, view), 0)), 5);
  const strength = float(CLEAR_WATER.reflection).add(fresnel.mul(0.7)).min(CLEAR_WATER.reflectionMax);
  const open = smoothstep(0, 0.45, max(inputs.maskShore ?? shore, 0));
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0, 0.8, reflectedDirection.y)).mul(
    mix(float(0.32), sceneBrightness.min(1).mul(0.12), night),
  );
  const mirror = inputs.reflection
    ? mix(sky, moonlit(inputs.reflection.colour, nodes), inputs.reflection.coverage)
    : sky;
  // A single soft sun lobe; no screen-space noise/glitter. Its peak is deliberately below bloom energy.
  const sun = uniforms.sunColor
    .mul(pow(max(dot(reflectedDirection, uniforms.sunDirection), 0), 96))
    .mul(CLEAR_WATER.sunGain)
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night));
  const lights = sampleLightField(p.xz.sub(vec2(Math.SQRT1_2, Math.SQRT1_2).mul(0.9)).add(slope.mul(0.2)), nodes)
    .mul(0.12)
    .min(vec3(0.18));
  const edge = max(inputs.maskShore ?? shore, 0);
  const breakup = texture(waterTextures().noise, p.xz.mul(0.24)).g;
  const cycle = time.mul((2 * Math.PI) / CLEAR_WATER.foamPeriod).add(breakup.mul(3));
  const breath = sin(cycle).mul(0.5).add(0.5);
  const beachFoam = smoothstep(0.085, 0, abs(edge.sub(breath.mul(0.035).add(0.035))))
    .mul(smoothstep(CLEAR_WATER.foamFade, 0, edge))
    .mul(0.22)
    .mul(float(1).sub(hard));
  // Rocky shores receive intermittent white water at impact only, never a cyan shelf or continuous white outline.
  const rockFoam = smoothstep(0.1, 0, edge)
    .mul(smoothstep(0.78, 0.98, breath))
    .mul(smoothstep(0.45, 0.7, breakup))
    .mul(hard)
    .mul(0.16);
  const foam = beachFoam
    .add(rockFoam)
    .mul(waterness)
    .mul(float(1).sub(night.mul(0.5)));
  body = mix(body.mul(float(1).sub(strength.mul(open))), color(0xc4ceca), foam);
  const emission = mirror.mul(strength).add(sun).add(lights).mul(open).mul(waterness).mul(float(1).sub(foam));
  return { normal, body, emission, foam };
}

/** Adapt the clear surface to the bed path's existing coverage contract; leave dry terrain artwork untouched. */
export function clearBedWaterLook(inputs: BedWaterInputs, nodes = DEFAULT_ATMOSPHERE_NODES): BedWaterLook {
  const look = clearWaterLook(inputs, nodes);
  return {
    ...look,
    // Foam is already blended into clear's body, unlike the enhanced bed contract.
    foam: float(0),
    foamColour: color(0xc4ceca),
    land: inputs.bedAt(vec2(0)),
    coverage: inputs.waterness,
    openWater: inputs.waterness,
    wetness: float(0),
    roughness: float(1),
    gloss: float(0),
  };
}
