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
  cos,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, sampleLightField } from '../atmosphere';
import { RIPPLE_SLOPE_RANGE, waterTextures } from '../proceduralTextures';
import type { ShaderNode } from '../tsl';
import type { BedWaterInputs, BedWaterLook, WaterLook, WaterLookInputs } from './waterLook';

/**
 * Candidate look only. These budgets are targets for masked, same-camera capture at zoom 2.5, not measured guarantees.
 * v3 (2026-11-12, owner brief "modern, transparent, comfortable, like Red Alert 3"): dark teal-blue open water whose
 * surface is drawn by wave crests (four sharp-crested wave trains in several directions plus a fine ripple layer),
 * lit by the sun through the wave normal; turquoise shallows within about two cells of a beach with the sand bed and
 * faint caustics showing through; sun glints on the crests inside a broad soft zone; a little Fresnel sky toward the
 * top of the screen. Quays and seawalls keep deep water up to the wall; cliffs drop into dark water with a thin
 * broken line of white water.
 */
export const CLEAR_WATER = {
  depthCells: 2.4,
  absorption: [7, 3.4, 2.7],
  /** Normal tilt per unit wave slope (radians-ish): enough for the Fresnel sky to follow the waves. */
  slope: 0.09,
  shade: 0.38,
  refraction: 0.04,
  maxRefraction: 0.05,
  foamPeriod: 7,
  foamFade: 0.4,
  causticGain: 0.22,
  reflection: 0.07,
  reflectionMax: 0.22,
  skyTop: 0.12,
  sparkle: 0.85,
  /** Facing (sun-ward fine slope, unit-ish) from which a crest glints. */
  glint: 1.85,
  motionTarget: 1.5,
  anisotropyTarget: 0.4,
  highlightTarget: 0.04,
  saturationTarget: 0.6,
} as const;

/**
 * Wave trains [screen angle (degrees), wavelength (cell widths on screen), phase speed (cell widths/s), amplitude].
 * Four directions about 45 degrees apart (none dominates, so no parallel stripe trains); alternate trains run the
 * other way, so the sea evolves instead of sliding as one sheet. Each train has a sharp crest and a broad trough
 * (exp(k(sin - 1)) profile), which is what reads as waves rather than blotches.
 */
export const CLEAR_WAVES = [
  [12, 0.9, 0.06, 1],
  [57, 0.74, -0.052, 1],
  [103, 0.62, 0.048, 1],
  [148, 0.52, -0.044, 1],
] as const;
/** Crest sharpness of the wave profile and its mean/derivative spread (for unit-variance terms). */
const CREST = { sharpness: 2.4, mean: 0.277, spread: 0.333, slope: 0.186 } as const;
/** Kept for the reflection offset of other looks: same directions as the wave trains. */
export const CLEAR_LAYERS = CLEAR_WAVES;

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

/** Ground xz -> screen-isotropic domain in cell widths (the isometric view halves the (1,1) diagonal). */
function screenDomain(ground: ShaderNode): ShaderNode {
  return vec2(ground.x.sub(ground.y).mul(0.5), ground.x.add(ground.y).mul(0.25));
}
/** A slope in the screen domain as a ground (xz) slope. */
function groundSlope(s: ShaderNode): ShaderNode {
  return vec2(s.x.mul(0.5).add(s.y.mul(0.25)), s.x.mul(-0.5).add(s.y.mul(0.25)));
}

/**
 * Wave field at a ground position (xz), in the screen domain: xy = slope (unit variance, approximately), z = crest
 * height (zero mean, unit variance), w = the trains' own facing term (each train's slope along its own direction,
 * equal energy per direction, so lighting by it adds no preferred axis).
 */
export function clearField(ground: ShaderNode): ShaderNode {
  const s0 = screenDomain(ground);
  // Light domain warp: bends the crests so the trains never read as ruled lines.
  const warp = texture(waterTextures().noise, s0.mul(0.31).add(vec2(time.mul(0.003), time.mul(-0.002))))
    .level(float(0))
    .rg.sub(0.5)
    .mul(0.42);
  const s = s0.add(warp);
  let slope: ShaderNode = vec2(0);
  let height: ShaderNode = float(0);
  let facing: ShaderNode = float(0);
  let norm = 0;
  CLEAR_WAVES.forEach(([degrees, wavelength, speed, amplitude], index) => {
    const a = (degrees * Math.PI) / 180;
    const k = (2 * Math.PI) / wavelength;
    // Wave groups: each train swells and fades in slow patches of its own.
    // Short-crested: within a cell or two one or two trains dominate, so the crests do not knit into a net.
    const group = smoothstep(
      0.36,
      0.64,
      texture(
        waterTextures().noise,
        s0
          .mul(0.34)
          .add(vec2(0.37 * index, 0.61 * index))
          .add(time.mul(0.003)),
      ).level(float(0)).r,
    )
      .mul(1.2)
      .add(0.3)
      .mul(amplitude);
    const phase = s.x
      .mul(Math.cos(a))
      .add(s.y.mul(Math.sin(a)))
      .sub(time.mul(speed))
      .mul(k);
    const h = exp(sin(phase).sub(1).mul(CREST.sharpness));
    const d = cos(phase).mul(h).mul(group);
    slope = slope.add(vec2(Math.cos(a), Math.sin(a)).mul(d.div(CREST.slope)));
    height = height.add(h.sub(CREST.mean).mul(group).div(CREST.spread));
    facing = facing.add(d.div(CREST.slope));
    norm += amplitude ** 2;
  });
  const n = 1 / Math.sqrt(norm);
  return vec4(slope.mul(n), height.mul(n), facing.mul(n));
}

/** Fine ripples (about a fifth of a cell), stretched along the screen's x so their glints are short flecks. */
function clearFine(ground: ShaderNode): ShaderNode {
  const s = screenDomain(ground);
  const at = (angle: number, tile: number, speed: [number, number]) => {
    const c = Math.cos(angle),
      si = Math.sin(angle);
    const q = vec2(s.x.mul(0.55), s.y);
    const t = texture(
      waterTextures().ripple,
      vec2(q.x.mul(c).add(q.y.mul(si)), q.y.mul(c).sub(q.x.mul(si)))
        .div(tile)
        .add(vec2(time.mul(speed[0]), time.mul(speed[1]))),
    )
      .rg.mul(2)
      .sub(1);
    return vec2(t.x.mul(c).sub(t.y.mul(si)), t.x.mul(si).add(t.y.mul(c)));
  };
  return at(0.4, 0.45, [0.03, -0.04])
    .add(at(2.1, 0.35, [-0.035, 0.025]))
    .mul(0.5 * RIPPLE_SLOPE_RANGE);
}

export function clearSlope(ground: ShaderNode): ShaderNode {
  return groundSlope(clearField(ground).xy).mul(CLEAR_WATER.slope);
}
export function clearNormal(p: ShaderNode): ShaderNode {
  const slope = clearSlope(p);
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
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
  const fine = clearFine(p.xz);
  const waveSlope = field.xy;
  const groundTilt = groundSlope(waveSlope.add(fine.mul(0.35))).mul(CLEAR_WATER.slope);
  const normal = normalize(vec3(groundTilt.x.negate(), 1, groundTilt.y.negate()));
  // The sun in the screen domain.
  const sunGround = vec2(uniforms.sunDirection.x, uniforms.sunDirection.z).add(vec2(0.0001, 0));
  const sunScreen = normalize(screenDomain(sunGround));
  const lit = dot(waveSlope, sunScreen);
  // Optical depth rises faster than the proxy at first: the sand shows clearly only in the first half cell.
  const transmission = exp(vec3(...CLEAR_WATER.absorption).mul(pow(depth, 0.6).negate()));
  // Refracted bed: the lake bed's own art where the cache has one, else the theatre's sand with a faint ripple-mark
  // texture, both shifted a little by the wave normals. (Sampling the ground inland of the shore traced the distance
  // field's medial lines as rays around rocks and piers.)
  const offset = groundTilt
    .div(CLEAR_WATER.slope)
    .mul(CLEAR_WATER.refraction)
    .mul(smoothstep(0, 0.15, depth));
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
  // Wave light and shade: mostly the sun through the wave normal, the trains' own facing (no preferred axis), a
  // little crest height, the fine ripples. Calmer over the shallowest sand.
  const relief = lit
    .mul(0.55)
    .add(field.w.mul(0.45))
    .add(field.z.mul(0.3))
    .add(dot(fine, sunScreen).mul(0.3))
    .mul(CLEAR_WATER.shade)
    .mul(mix(float(0.5), float(1), smoothstep(0, 0.4, depth)))
    .clamp(-0.5, 0.7);
  body = body.mul(float(1).add(relief));
  // Cliff feet: the wall drops into deep, shaded water, darkest within half a cell of the rock.
  const cliffFoot = hard.mul(smoothstep(0.75, 0.2, edge));
  body = body.mul(float(1).sub(hard.mul(0.15)).sub(cliffFoot.mul(0.42)));
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
  const fresnel = pow(float(1).sub(max(dot(normal, view), 0)), 5);
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
    const coverage = inputs.reflection.coverage.mul(mix(float(1), smoothstep(0.45, 0.05, edge), hard));
    mirror = mix(sky, toned, coverage);
  }
  // Sun glints: crests whose fine facets face the sun, inside a broad soft zone of the screen on the sun's side.
  // Short flecks (the fine layer is stretched along x) with a faint halo; none outside the zone, in rain or at night.
  const zoneCentre = vec2(0.5, 0.45).add(sunScreen.mul(vec2(0.2, 0.16)));
  const zone = smoothstep(0.46, 0.26, screenUV.sub(zoneCentre).mul(vec2(1, 1.25)).length());
  const facet = dot(fine.add(waveSlope.mul(0.5)), sunScreen);
  const crest = smoothstep(-0.2, 1.2, field.z);
  const glint = smoothstep(CLEAR_WATER.glint, CLEAR_WATER.glint + 0.45, facet)
    .add(smoothstep(CLEAR_WATER.glint - 0.45, CLEAR_WATER.glint + 0.1, facet).mul(0.18))
    .mul(crest);
  const sparkle = uniforms.sunColor
    .mul(glint)
    .mul(zone)
    .mul(CLEAR_WATER.sparkle)
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
