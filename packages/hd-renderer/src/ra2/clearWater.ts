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
  vec4,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, sampleLightField } from '../atmosphere';
import { oceanNormalTexture, waterTextures } from '../proceduralTextures';
import type { ShaderNode } from '../tsl';
import type { BedWaterInputs, BedWaterLook, WaterLook, WaterLookInputs } from './waterLook';

/** Candidate A uses the approved optical palette and the four-sample three.js WaterMesh surface model.
 * Metric targets require same-camera rendered acceptance; they are not guarantees from these coefficients.
 */
export const CLEAR_WATER = {
  depthCells: 2.4,
  absorption: [7, 3.4, 2.7],
  refraction: 0.04,
  maxRefraction: 0.05,
  foamPeriod: 7,
  foamFade: 0.4,
  causticGain: 0.22,
  reflection: 0.07,
  reflectionMax: 0.22,
  skyTop: 0.12,
  shininess: 900,
  sparkle: 5,
  relief: 0.85,
  whitecap: 0.12,
  cliffContact: 0.7,
  mirrorKeep: 0.55,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

/** One ground world unit is one cell (world.ts); eight metres per cell is the chosen visual scale. */
export const CLEAR_SURFACE = { tileMetres: 26, metresPerCell: 8, timeScale: 0.8, normalGain: 1.5 } as const;
/** WaterMesh.getNoise: divisor (x,z), signed scroll rate (tiles per surface-clock second), equal weights. */
export const CLEAR_LAYERS = [
  [103, 103, 1 / 17, 1 / 29],
  [107, 107, 1 / 19, -1 / 31],
  [8907, 9803, 1 / 101, 1 / 97],
  [1091, 1027, -1 / 109, 1 / 113],
] as const;

/** sRGB palette before scene lighting: deep teal-blue, turquoise shallows, the sand bed seen through the shallows. */
export function clearPalette(theater = '') {
  switch (theater.toLowerCase()) {
    case 'snow':
      return { deep: 0x114558, shallow: 0x3796b2, bed: 0x8a969c };
    case 'desert':
      return { deep: 0x174750, shallow: 0x45aea4, bed: 0xa89470 };
    case 'urban':
    case 'newurban':
      return { deep: 0x17434f, shallow: 0x3a908c, bed: 0x8a8a80 };
    default:
      return { deep: 0x134250, shallow: 0x2a9894, bed: 0x8c7c5e };
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

/** RGB = world normal; A = coincident compression of the two fine layers. */
export function clearField(ground: ShaderNode): ShaderNode {
  const uv = ground.mul((CLEAR_SURFACE.metresPerCell * 103) / CLEAR_SURFACE.tileMetres);
  const clock = time.mul(CLEAR_SURFACE.timeScale);
  const samples = CLEAR_LAYERS.map(([x, z, dx, dz]) =>
    texture(oceanNormalTexture(), uv.div(vec2(x, z)).add(vec2(clock.mul(dx), clock.mul(dz)))),
  );
  // Sum encoded normals * 0.5 - 1 is the mean of four decoded normals, exactly as in WaterMesh.
  const mean = samples[0]!.rgb.add(samples[1]!.rgb).add(samples[2]!.rgb).add(samples[3]!.rgb).mul(0.5).sub(1);
  const normal = normalize(mean.xzy.mul(vec3(CLEAR_SURFACE.normalGain, 1, CLEAR_SURFACE.normalGain)));
  const compression = samples[0]!.a.add(samples[1]!.a).sub(0.9).mul(1.4).clamp(0, 1);
  return vec4(normal, compression);
}
export function clearNormal(p: ShaderNode): ShaderNode {
  return clearField(p).xyz;
}
export function clearSlope(p: ShaderNode): ShaderNode {
  const n = clearNormal(p);
  return n.xz.negate().div(max(n.y, 0.01));
}
export function clearReflectionOffset(p: ShaderNode): ShaderNode {
  return clearSlope(p).mul(0.1);
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
  // Quays, seawalls and pavement: no beach there (no turquoise shallows, no foam), deep water up to the wall.
  const quay: ShaderNode = (inputs.quay ?? float(0)).mul(float(1).sub(hard));
  const edge = max(inputs.maskShore ?? shore, 0);
  const depth = max(smoothstep(0, CLEAR_WATER.depthCells, max(shore, 0)), max(hard.mul(0.9), quay.mul(0.8)));
  const field = clearField(p.xz);
  const normal = field.xyz;
  const groundTilt = normal.xz.negate().div(max(normal.y, 0.01));
  // Optical depth rises faster than the proxy at first: the sand shows clearly only in the first half cell.
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(pow(depth, 0.6).negate()));
  // Refracted bed: the lake bed's own art where the cache has one, else the theatre's sand with a faint ripple-mark
  // texture, both shifted a little by the wave normals. (Sampling the ground inland of the shore traced the distance
  // field's medial lines as rays around rocks and piers.)
  const offset = groundTilt.mul(CLEAR_WATER.refraction).mul(smoothstep(0, 0.15, depth));
  const bounded = offset.mul(float(CLEAR_WATER.maxRefraction).div(max(offset.length(), CLEAR_WATER.maxRefraction)));
  const sandGrain = texture(waterTextures().noise, p.xz.add(bounded).mul(0.42)).b.sub(0.5).mul(0.5).add(1);
  const bed = inputs.bedAt ? inputs.bedAt(bounded) : color(palette.bed).mul(sandGrain);
  // Caustics: drifting light on the bed between about half a cell and a cell and a half from the beach.
  const caustic = texture(
    waterTextures().caustics,
    p.xz
      .div(1.3)
      .add(bounded.mul(4))
      .add(vec2(time.mul(0.02), time.mul(-0.014))),
  )
    .r.sub(0.45)
    .mul(CLEAR_WATER.causticGain)
    .mul(smoothstep(0.2, 0.6, edge).mul(smoothstep(1.7, 1.0, edge)))
    .mul(float(1).sub(hard).mul(float(1).sub(quay)));
  const column = mix(color(palette.shallow), color(palette.deep), smoothstep(0, 1, depth));
  let body: ShaderNode = bed
    .mul(transmission)
    .add(column.mul(vec3(1).sub(transmission)))
    .mul(float(1).add(caustic));
  // A's relief is illumination by the same normal used for glints, not a separate crest/height pattern.
  const relief = mix(
    float(1),
    max(dot(normal, uniforms.sunDirection), 0).div(max(uniforms.sunDirection.y, 0.2)),
    CLEAR_WATER.relief,
  );
  body = body.mul(relief);
  // Cliff feet: the wall drops into deep, shaded water, darkest within half a cell of the rock.
  const cliffFoot = hard.mul(smoothstep(0.75, 0.2, edge));
  body = body.mul(float(1).sub(hard.mul(0.15)).sub(cliffFoot.mul(CLEAR_WATER.cliffContact)));
  // Quays: a slightly lighter deep colour up to the wall, then a dark wet line at its foot.
  body = body.mul(
    float(1)
      .add(quay.mul(0.08))
      .sub(quay.mul(smoothstep(0.07, 0.0, edge)).mul(0.3)),
  );
  // Night: the moonlight is blue; a greener, brighter body keeps the water a dark teal, never black navy.
  const nightBody = body.mul(vec3(4.4, 3.0, 1.65));
  body = mix(
    body,
    mix(nightBody, vec3(dot(nightBody, vec3(0.2126, 0.7152, 0.0722))), 0.1),
    night.mul(smoothstep(0.15, 0.85, depth)),
  );

  const view = normalize(cameraPosition.sub(p));
  const reflectedDirection = reflect(view.negate(), normal);
  const fresnel = float(0.02).add(pow(float(1).sub(max(dot(normal, view), 0)), 5).mul(0.98));
  // Fresnel toward the far edge: the RTS camera hardly changes the view angle across the screen, so the top of the
  // screen stands in for grazing view.
  const far = smoothstep(0.75, 0.0, screenUV.y);
  const strength = float(CLEAR_WATER.reflection)
    .add(fresnel.mul(0.9))
    .add(far.mul(CLEAR_WATER.skyTop).mul(float(1).sub(night)))
    .min(CLEAR_WATER.reflectionMax)
    .mul(float(1).sub(cliffFoot.mul(0.6)));
  const open = smoothstep(0, 0.45, edge);
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0, 0.8, reflectedDirection.y)).mul(
    mix(float(0.4), sceneBrightness.min(1).mul(0.12), night),
  );
  // The mirrored scene: at a cliff only the foot of the rock is mirrored (fading within about 0.4 cells) and in the
  // water's own colour, so tall walls do not smear brown far out over the deep water.
  let mirror: ShaderNode = sky;
  if (inputs.reflection) {
    const mirrored = moonlit(inputs.reflection.colour, nodes);
    const toned = mix(
      mirrored,
      color(palette.deep).mul(dot(mirrored, vec3(0.2126, 0.7152, 0.0722)).mul(3)),
      hard.mul(0.7),
    );
    const coverage = inputs.reflection.coverage
      .mul(CLEAR_WATER.mirrorKeep)
      .mul(mix(float(1), smoothstep(0.45, 0.05, edge), hard));
    mirror = mix(sky, toned, coverage);
  }
  // A's sharp Phong glints follow the actual scene sun; no screen-space zone or invented crest facing.
  const sunDot = max(dot(reflectedDirection, uniforms.sunDirection), 0);
  const glint = pow(sunDot, CLEAR_WATER.shininess).mul(CLEAR_WATER.sparkle).add(pow(sunDot, 60).mul(0.1));
  const sparkle = uniforms.sunColor
    .mul(glint)
    .mul(smoothstep(0.25, 0.7, depth))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night));
  const lights = sampleLightField(p.xz.sub(vec2(Math.SQRT1_2, Math.SQRT1_2).mul(0.9)).add(groundTilt.mul(2)), nodes)
    .mul(0.12)
    .min(vec3(0.18));
  const breakup = texture(waterTextures().noise, p.xz.mul(0.24)).g;
  const lace = texture(waterTextures().noise, p.xz.mul(0.9).add(vec2(time.mul(0.01), 0))).b;
  const cycle = time.mul((2 * Math.PI) / CLEAR_WATER.foamPeriod).add(breakup.mul(3));
  const breath = sin(cycle).mul(0.5).add(0.5);
  // Beaches: a thin, broken white line that slowly breathes up and back; its width (0 to about 4 px) and opacity
  // follow noise, so islands are not outlined like stickers.
  const width = smoothstep(0.3, 0.75, lace).mul(0.028);
  const beachFoam = smoothstep(width.add(0.004), width.mul(0.3), abs(edge.sub(breath.mul(0.04).add(0.015))))
    .mul(smoothstep(0.32, 0.62, breakup).mul(0.7).add(0.3))
    .mul(smoothstep(CLEAR_WATER.foamFade, 0, edge))
    .mul(0.52)
    .mul(float(1).sub(hard))
    .mul(float(1).sub(quay));
  // Rocky shores: a broken line of white water 3-6 px wide at the base, breathing slowly.
  const rockFoam = smoothstep(0.045, 0.012, edge)
    .mul(smoothstep(0.38, 0.62, lace))
    .mul(breath.mul(0.5).add(0.5))
    .mul(hard)
    .mul(0.5);
  // Small streaky flecks only where the two moving long-wave compression masks overlap.
  const clock = time.mul(CLEAR_SURFACE.timeScale);
  const metres = p.xz.mul(CLEAR_SURFACE.metresPerCell).add(vec2(clock.mul(0.4), 0));
  const wind = (200 * Math.PI) / 180;
  const alongWind = vec2(
    metres.x.mul(Math.cos(wind)).add(metres.y.mul(Math.sin(wind))),
    metres.y.mul(Math.cos(wind)).sub(metres.x.mul(Math.sin(wind))),
  );
  // The cached noise has 24 fine / 4 broad lattice cycles per tile; convert prototype metres to its UVs.
  const fleck = texture(waterTextures().noise, alongWind.mul(vec2(4.5 / 24, 1.6 / 24))).b;
  const gust = texture(waterTextures().noise, metres.mul(0.05 / 4).add(clock.mul(0.03 / 4))).r;
  const whitecaps = smoothstep(0.62, 0.85, field.w.mul(0.8).add(fleck.mul(0.55)))
    .mul(smoothstep(0.35, 0.75, gust))
    .mul(CLEAR_WATER.whitecap)
    .mul(smoothstep(0.4, 1, edge))
    .mul(float(1).sub(hard))
    .mul(float(1).sub(quay));
  const foam = beachFoam
    .add(rockFoam)
    .add(whitecaps)
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
