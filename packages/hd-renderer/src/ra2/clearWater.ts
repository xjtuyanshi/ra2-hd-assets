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
  screenUV,
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

/**
 * Candidate look only. These budgets are targets for masked, same-camera capture at zoom 2.5, not measured guarantees.
 * v2 (2026-11-12, owner brief "modern, transparent, comfortable, like Red Alert 3"): dark teal-blue open water,
 * turquoise shallows within about two cells of a beach with the sand showing through, soft multi-direction ripples
 * that read as light and shade, a little Fresnel sky toward the top of the screen and sparse sun sparkle.
 */
export const CLEAR_WATER = {
  depthCells: 2.4,
  absorption: [7, 3.4, 2.7],
  slope: 0.03,
  shade: 0.21,
  refraction: 0.5,
  maxRefraction: 0.03,
  foamPeriod: 7,
  foamFade: 0.4,
  causticGain: 0.12,
  reflection: 0.07,
  reflectionMax: 0.2,
  skyTop: 0.12,
  sparkle: 0.3,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

// Ripple layers [angle, tile size (cells), drift (cells/s), weight]: five directions spread by the golden angle so no
// axis of the source normal map dominates; the drifts point different ways, so the pattern evolves instead of sliding.
export const CLEAR_LAYERS = [
  [0.3, 2.4, 0.027, 1],
  [0.3 + 2.39996, 1.9, -0.025, 1],
  [0.3 + 2 * 2.39996, 1.5, 0.022, 0.9],
  [0.3 + 3 * 2.39996, 1.15, -0.02, 0.75],
  [0.3 + 4 * 2.39996, 0.85, 0.018, 0.4],
] as const;
const LAYER_NORM = Math.sqrt(CLEAR_LAYERS.reduce((sum, layer) => sum + layer[3] ** 2, 0));

/** sRGB palette before scene lighting: deep teal-blue, turquoise shallows, neutral fallback bed. */
export function clearPalette(theater = '') {
  switch (theater.toLowerCase()) {
    case 'snow':
      return { deep: 0x173f52, shallow: 0x4a93a4, bed: 0x8d9496 };
    case 'desert':
      return { deep: 0x174750, shallow: 0x45aea4, bed: 0xc2ad86 };
    case 'urban':
    case 'newurban':
      return { deep: 0x17434f, shallow: 0x3a908c, bed: 0x9a9a90 };
    default:
      return { deep: 0x134250, shallow: 0x2ea29c, bed: 0xb5a482 };
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

/** Ripple field at a ground position (xz): xy = surface slope, z = height (unit variance, approximately). */
export function clearField(ground: ShaderNode): ShaderNode {
  // The isometric view shows the ground's (1,1) diagonal at half scale: stretch the ripple domain along it so the
  // ripples are round on screen, not horizontal streaks.
  const along = ground.x.add(ground.y).mul(Math.SQRT1_2 * 0.5),
    across = ground.x.sub(ground.y).mul(Math.SQRT1_2);
  const p = vec2(across, along);
  let slope: ShaderNode = vec2(0);
  let height: ShaderNode = float(0);
  for (const [angle, scale, speed, weight] of CLEAR_LAYERS) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const uv = vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)))
      .div(scale)
      .sub(vec2(time.mul(speed / scale), time.mul((speed * 0.31) / scale)));
    // Mip 1 keeps the ripples soft enough for a 4 Mb/s encode without blurring them away.
    const t = texture(waterTextures().ripple, uv).level(float(1));
    const n = t.rg.mul(2).sub(1).mul(RIPPLE_SLOPE_RANGE);
    slope = slope.add(vec2(n.x.mul(c).sub(n.y.mul(s)), n.x.mul(s).add(n.y.mul(c))).mul(weight));
    height = height.add(t.b.sub(0.5).mul(weight));
  }
  return vec3(slope.mul(CLEAR_WATER.slope / LAYER_NORM), height.mul(1 / (0.11 * LAYER_NORM)));
}
export function clearSlope(ground: ShaderNode): ShaderNode {
  return clearField(ground).xy;
}
export function clearNormal(p: ShaderNode): ShaderNode {
  const slope = clearSlope(p);
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
}
export function clearReflectionOffset(p: ShaderNode): ShaderNode {
  return clearSlope(p).mul(0.15);
}

/** Same terrain/mirror/light passes as enhanced, without sheen trains, painted chop or extra targets. */
export function clearWaterLook(
  inputs: WaterLookInputs & { bedAt?: (offset: ShaderNode) => ShaderNode },
  nodes = DEFAULT_ATMOSPHERE_NODES,
): WaterLook {
  const { position: p, shore, waterness, uniforms } = inputs;
  const { night, sceneBrightness } = nodes;
  const palette = clearPalette(inputs.theater);
  const hard: ShaderNode = inputs.calm ?? float(0);
  const depth = max(smoothstep(0, CLEAR_WATER.depthCells, max(shore, 0)), hard.mul(0.9));
  const field = clearField(p.xz);
  const slope = field.xy;
  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  // Unit-variance facet terms: ripples read as light and shade (not as a sheen), sparkle from the steepest facets.
  const facets = slope.div(CLEAR_WATER.slope * 0.5);
  const lightDir = normalize(vec2(uniforms.sunDirection.x, uniforms.sunDirection.z).add(vec2(0.0001, 0)));
  const facet = dot(facets, lightDir);
  // Optical depth rises faster than the proxy at first: the sand shows clearly only in the first half cell.
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(pow(depth, 0.6).negate()));
  // Refracted bed: the lake bed's own art where the cache has one, else a sand bed of the theatre. Sampling the
  // ground inland of the shore traced the distance field's medial lines as rays around rocks and piers, so the bed
  // is a flat colour that the caustics, ripples and absorption bring to life. Rocky shores drop straight to depth.
  const offset = slope.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.15, depth));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  const bed = inputs.bedAt ? inputs.bedAt(bounded) : color(palette.bed);
  const caustic = texture(
    waterTextures().caustics,
    p.xz
      .div(1.6)
      .add(slope.mul(2))
      .add(vec2(time.mul(0.015), time.mul(-0.011))),
  )
    .r.sub(0.5)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.55, 0.05, depth))
    .mul(float(1).sub(hard));
  const column = mix(color(palette.shallow), color(palette.deep), smoothstep(0, 1, depth));
  let body: ShaderNode = bed
    .mul(float(1).add(caustic))
    .mul(transmission)
    .add(column.mul(vec3(1).sub(transmission)));
  // Light and shade from the ripple height (isotropic) with a little directional relief; a directional derivative
  // alone favours the sun's axis and reads as parallel stripe trains.
  body = body.mul(
    float(1).add(
      field.z
        .mul(0.8)
        .add(facet.mul(0.35))
        .mul(CLEAR_WATER.shade)
        .mul(mix(float(0.55), float(1), depth))
        .clamp(-0.6, 0.8),
    ),
  );
  // Cliff feet: the wall drops into deep, shaded water, darker than the rock above it.
  body = body.mul(float(1).sub(hard.mul(0.4)));
  // Night: the moonlight is blue; a greener body keeps the water teal and a little lifted, never black navy.
  body = body.mul(mix(vec3(1), vec3(0.95, 1.25, 1.0), night));

  const view = normalize(cameraPosition.sub(p));
  const reflectedDirection = reflect(view.negate(), normal);
  const fresnel = pow(float(1).sub(max(dot(normal, view), 0)), 5);
  // Fresnel toward the far edge: the RTS camera hardly changes the view angle across the screen, so the top of the
  // screen stands in for grazing view.
  const far = smoothstep(0.75, 0.0, screenUV.y);
  const strength = float(CLEAR_WATER.reflection)
    .add(fresnel.mul(0.5))
    .add(far.mul(CLEAR_WATER.skyTop))
    .min(CLEAR_WATER.reflectionMax);
  const open = smoothstep(0, 0.45, max(inputs.maskShore ?? shore, 0));
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0, 0.8, reflectedDirection.y)).mul(
    mix(float(0.4), sceneBrightness.min(1).mul(0.12), night),
  );
  const mirror = inputs.reflection
    ? mix(sky, moonlit(inputs.reflection.colour, nodes), inputs.reflection.coverage)
    : sky;
  // Sun sparkle: the steepest sun-facing facets, only inside slowly drifting patches (a limited zone, no full-screen
  // glitter), below bloom energy.
  const zone = smoothstep(
    0.5,
    0.68,
    texture(waterTextures().noise, p.xz.mul(0.045).add(vec2(time.mul(0.004), time.mul(0.003)))).r,
  );
  // Fine facets of their own (about a fifth of a cell) in two crossed directions: their product gives small round
  // points rather than flat white blobs or streaks.
  const fineAt = (angle: number, speed: [number, number]) => {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const g = vec2(p.x.sub(p.z), p.x.add(p.z).mul(0.5)).mul(Math.SQRT1_2 / 0.55);
    return texture(
      waterTextures().ripple,
      vec2(g.x.mul(c).add(g.y.mul(s)), g.y.mul(c).sub(g.x.mul(s))).add(vec2(time.mul(speed[0]), time.mul(speed[1]))),
    )
      .level(float(1))
      .rg.mul(2)
      .sub(1);
  };
  const glint = smoothstep(0.3, 0.7, dot(fineAt(0.4, [0.025, -0.035]), lightDir)).mul(
    smoothstep(0.3, 0.7, dot(fineAt(2.0, [-0.03, 0.02]), lightDir)),
  );
  const sparkle = uniforms.sunColor
    .mul(glint.mul(smoothstep(0.4, 1.4, facet)))
    .mul(zone)
    .mul(CLEAR_WATER.sparkle)
    .mul(smoothstep(0.3, 0.8, depth))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night));
  const lights = sampleLightField(p.xz.sub(vec2(Math.SQRT1_2, Math.SQRT1_2).mul(0.9)).add(slope.mul(0.2)), nodes)
    .mul(0.12)
    .min(vec3(0.18));
  const edge = max(inputs.maskShore ?? shore, 0);
  const breakup = texture(waterTextures().noise, p.xz.mul(0.24)).g;
  const cycle = time.mul((2 * Math.PI) / CLEAR_WATER.foamPeriod).add(breakup.mul(3));
  const breath = sin(cycle).mul(0.5).add(0.5);
  // A thin white line on beaches that slowly breathes up and back.
  const beachFoam = smoothstep(0.06, 0, abs(edge.sub(breath.mul(0.05).add(0.03))))
    .mul(smoothstep(0.35, 0.6, breakup).mul(0.4).add(0.6))
    .mul(smoothstep(CLEAR_WATER.foamFade, 0, edge))
    .mul(0.55)
    .mul(float(1).sub(hard));
  // Rocky shores: a little white water at the base, flickering slowly, never a continuous outline.
  const rockFoam = smoothstep(0.12, 0, edge)
    .mul(smoothstep(0.55, 0.95, breath))
    .mul(smoothstep(0.45, 0.7, breakup))
    .mul(hard)
    .mul(0.4);
  const foam = beachFoam
    .add(rockFoam)
    .mul(waterness)
    .mul(float(1).sub(night.mul(0.5)));
  body = mix(body.mul(float(1).sub(strength.mul(open))), color(0xe8eeec), foam);
  const emission = mirror.mul(strength).add(sparkle).add(lights).mul(open).mul(waterness).mul(float(1).sub(foam));
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
