import {
  Fn,
  cameraPosition,
  color,
  cos,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  mx_noise_float,
  mx_worley_noise_float,
  normalize,
  pow,
  reflect,
  sin,
  smoothstep,
  time,
  vec2,
  vec3,
} from 'three/tsl';
import { moonlit, night, sceneBrightness } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import type { WaterUniforms } from '../waterShading';

/**
 * Open water for original maps, built to read as real water rather than a glossy sheet:
 * - depth from the signed shore distance: clear teal shallows over a sandy bed with moving caustics, deepening to blue
 *   green, with a touch of the original painted colour so each theater keeps its own water;
 * - wind-driven directional waves (several wavelengths, analytic slopes) plus fine noise and rain rings;
 * - real reflections of cliffs, trees and units from a mirrored render, sky where nothing is reflected, and a weak
 *   physically based Fresnel, so reflections stay subtle at the RTS viewing angle;
 * - lapping foam and a dark wet band on the sand along the painted shoreline.
 */

/** Wind direction on the ground (radians); the scene's weather drives strength only. */
const WIND_ANGLE = 0.6;
/** Directional wave components: angle offset from the wind, wavelength (cells), slope amplitude, angular speed. */
const WAVES: readonly [number, number, number, number][] = [
  [0, 1.35, 0.03, 0.85],
  [0.55, 0.78, 0.04, 1.25],
  [-0.7, 0.44, 0.04, 1.8],
  [1.25, 0.24, 0.03, 2.6],
];

export interface WaterLookInputs {
  /** World-space position of the fragment. */
  position: ShaderNode;
  /** Signed distance to the shoreline in cells (positive over water). */
  shore: ShaderNode;
  /** 0..1 open-water weight from the mask (soft at the painted shoreline). */
  waterness: ShaderNode;
  /** Original painted colour at this point (linear). */
  art: ShaderNode;
  uniforms: WaterUniforms;
  /** Mirrored scene colour (rgb) and whether anything was reflected there (0..1), when reflections are enabled. */
  reflection?: { colour: ShaderNode; coverage: ShaderNode };
}

export interface WaterLook {
  /** Surface normal of the water (world space). */
  normal: ShaderNode;
  /** Diffuse colour of the water body (lit by the scene like the ground, so shadows and night apply). */
  body: ShaderNode;
  /** Added light: reflections and sun glints. */
  emission: ShaderNode;
  /** 0..1 foam coverage. */
  foam: ShaderNode;
}

/** Wave normal at a ground position (xz), analytic slopes of the directional waves plus a fine noise layer. */
export const waveNormal = Fn(([p, wind, rain]: [ShaderNode, ShaderNode, ShaderNode]): ShaderNode => {
  const strength: ShaderNode = float(0.32).add(wind.mul(0.8));
  let gx: ShaderNode = float(0);
  let gz: ShaderNode = float(0);
  for (const [offset, wavelength, amplitude, speed] of WAVES) {
    const angle = WIND_ANGLE + offset;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const k = (Math.PI * 2) / wavelength;
    const phase = p.x.mul(dx).add(p.y.mul(dz)).mul(k).sub(time.mul(speed));
    const slope = cos(phase).mul(amplitude).mul(strength);
    gx = gx.add(slope.mul(dx));
    gz = gz.add(slope.mul(dz));
  }
  // Fine chop breaks up the regular crests.
  const e = 0.03;
  const chop = (q: ShaderNode) => mx_noise_float(vec3(q.mul(9.0), time.mul(0.9)));
  const c0 = chop(p);
  gx = gx.add(
    chop(p.add(vec2(e, 0)))
      .sub(c0)
      .div(e)
      .mul(0.006),
  );
  gz = gz.add(
    chop(p.add(vec2(0, e)))
      .sub(c0)
      .div(e)
      .mul(0.006),
  );
  // Rain rings: sparse cells, each an expanding ring with a random phase.
  const cell = p.mul(4.0).floor();
  const seed = mx_noise_float(vec3(cell.mul(1.7), 0.0))
    .mul(0.5)
    .add(0.5);
  const seed2 = mx_noise_float(vec3(cell.mul(2.3), 5.0))
    .mul(0.5)
    .add(0.5);
  const local = p.mul(4.0).fract().sub(vec2(seed, seed2).mul(0.6).add(0.2));
  const ringPhase = time.mul(1.1).add(seed.mul(9.0)).fract();
  const r = local.length().max(0.001);
  const ring = cos(r.sub(ringPhase.mul(0.45)).mul(45.0))
    .mul(smoothstep(0.35, 0.0, r))
    .mul(float(1).sub(ringPhase))
    .mul(smoothstep(0.45, 0.55, seed2))
    .mul(rain)
    .mul(0.5);
  gx = gx.add(local.x.div(r).mul(ring));
  gz = gz.add(local.y.div(r).mul(ring));
  return normalize(vec3(gx.negate(), 1.0, gz.negate()));
});

/** Moving caustic light on a shallow bed, 0..1. */
const caustics = Fn(([p]: [ShaderNode]): ShaderNode => {
  const a = mx_worley_noise_float(vec3(p.mul(2.4), time.mul(0.45)));
  const b = mx_worley_noise_float(vec3(p.mul(3.1).add(vec2(1.7, 4.2)), time.mul(-0.38)));
  return pow(float(1).sub(min(a, b)), 5);
});

export function waterLook(inputs: WaterLookInputs): WaterLook {
  const { position: p, shore, waterness, art, uniforms } = inputs;
  const depth = max(shore, 0);
  const normal: ShaderNode = waveNormal(p.xz, uniforms.wind, uniforms.rain);

  // Water column: blue-green depths, teal shallows, and the sandy bed showing through near the shore.
  const deep = color(0x0c3d57);
  const mid = color(0x15627a);
  const shallow = color(0x45b8ae);
  const bed = color(0xdcc99a);
  let column: ShaderNode = mix(deep, mid, smoothstep(2.4, 0.7, depth));
  column = mix(column, shallow, smoothstep(0.9, 0.05, depth).mul(0.85));
  // Keep a little of the original painting's hue, so snow, desert or lunar water keeps its own character.
  const artLevel = max(dot(art, vec3(0.2126, 0.7152, 0.0722)), 0.002);
  const columnLevel = dot(column, vec3(0.2126, 0.7152, 0.0722));
  column = mix(column, art.mul(columnLevel.div(artLevel)), 0.22);
  const clarity = exp(depth.mul(-2.8));
  const light = caustics(p.xz)
    .mul(smoothstep(0.8, 0.05, depth))
    .mul(0.9);
  const seabed = bed.mul(float(0.72).add(light));
  let body: ShaderNode = mix(column, seabed, clarity.mul(0.55));
  // At night the water column swallows the (cool) moonlight: darker than the land around it, not a glowing blue.
  body = body.mul(mix(float(1), float(0.7), night));

  // Reflection: Schlick Fresnel for water (F0 = 0.02) at the fixed viewing angle, lifted slightly so reflections of
  // cliffs and trees still read at RTS distance.
  const view = normalize(cameraPosition.sub(p));
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(normal, view), 0)), 5)));
  const strength = fresnel.mul(2.0).add(0.04).min(0.28);
  const r = reflect(view.negate(), normal);
  // The analytic sky follows the scene's light level at night (the overcast grey of night rain is not a lit sky).
  const skyLevel = mix(float(1), sceneBrightness.min(1).mul(0.6), night);
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0.0, 0.6, r.y)).mul(skyLevel);
  // At night the mirrored scene is graded like the moonlit land (desaturated, a little darker), so a reddish cliff
  // over blue water never smears magenta.
  const reflected = inputs.reflection ? moonlit(inputs.reflection.colour).mul(mix(float(1), float(0.8), night)) : null;
  const mirrored = reflected && inputs.reflection ? mix(sky, reflected, inputs.reflection.coverage) : sky;
  // Tight, sparse sun glints only; a broad sheen is what reads as plastic.
  const sunDot = max(dot(r, uniforms.sunDirection), 0);
  const glint = pow(sunDot, 2400).mul(1.2).mul(uniforms.sunColor).mul(float(1).sub(uniforms.rain));

  // Shoreline: waves lapping in over the first half cell, plus a thin broken line at the waterline.
  const breakup = mx_noise_float(vec3(p.xz.mul(5.0), time.mul(0.35)))
    .mul(0.5)
    .add(0.5);
  const lap = sin(shore.mul(16.0).sub(time.mul(1.7)).add(breakup.mul(5.0)))
    .mul(0.5)
    .add(0.5);
  const band = smoothstep(0.28, 0.03, shore).mul(smoothstep(-0.05, 0.02, shore));
  const line = smoothstep(0.05, 0.0, shore.sub(0.03).abs()).mul(smoothstep(0.45, 0.75, breakup));
  const foam = band
    .mul(smoothstep(0.7, 1.0, lap.mul(0.75).add(breakup.mul(0.4))))
    .max(line.mul(0.7))
    .mul(0.75)
    .min(1);

  // Foam is lit like the ground, but kept greyer at night so shorelines do not outline every water body in white.
  const foamColour = color(0xe9efef).mul(mix(float(1), float(0.5), night));
  body = mix(body.mul(float(1).sub(strength)), foamColour, foam);
  const emission = mirrored.mul(strength).add(glint).mul(float(1).sub(foam)).mul(waterness);
  return { normal, body, emission, foam };
}

/** Wet sand on land within a few tenths of a cell of the water (darker, glossier), 0..1. */
export function wetShore(shore: ShaderNode): ShaderNode {
  return smoothstep(-0.25, -0.02, shore).mul(smoothstep(0.08, -0.02, shore));
}
