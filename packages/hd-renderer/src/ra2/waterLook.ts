import {
  Fn,
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  color,
  cos,
  dot,
  exp,
  float,
  fract,
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
  sqrt,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { ReflectorNode, Texture } from 'three/webgpu';
import { DEFAULT_ATMOSPHERE_NODES, moonlit, sampleLightField } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import type { WaterUniforms } from '../waterShading';
import { RIPPLE_SLOPE_RANGE, WATER_TEXTURE_SIZE, waterTextures } from '../proceduralTextures';
import { CLIFF_FIELD_MAX } from './shoreField';
import { LEVEL_HEIGHT } from '../world';

/**
 * Open water for original maps, built to read as real water rather than a glossy sheet. Two looks share one interface
 * (waterPreset.style, chosen when the terrain material is built):
 *
 * 'enhanced' (opt-in, like every modern effect: sandbox ?water=enhanced or ?look=golden, in game hd-water=enhanced),
 * the remaster's modern water, tuned against the approved river concept (concept A, RiverRam):
 * - depth from the signed shore distance: a narrow band of clear turquoise shallows over a sandy bed with moving
 *   caustics, deepening quickly to dark blue-teal (narrow channels read as deep water, not as one broad shallow);
 * - a wind sea from three scrolled layers of a tileable ripple normal map (proceduralTextures.ts) plus two long swells,
 *   modulated by drifting gust patches ("cat's paws") that roughen the surface and gather the sun glitter;
 * - real reflections of cliffs, trees and units from a mirrored render (rippled by reflectionOffset), sky where nothing
 *   is reflected, and a weak Fresnel, so reflections stay subtle at the RTS viewing angle;
 * - sun glitter: the sun mirrored in ripple facets, small and sparse, strongest in gusts, none in rain;
 * - explosions, fires and (at night) the map's lights mirrored in the water from the light field;
 * - shoreline: a thin foam line riding a swash that laps up and back, a fainter breaker line rolling in, lace foam in
 *   the surf zone, wet sand exposed as the swash retreats; none at cliff feet (`calm`), where the wall drops into
 *   deep water;
 * - rain rings in rain.
 *
 * 'classic' (default), the earlier HD water (procedural noise waves and Worley caustics, broader shallows).
 *
 * Owner feedback it must keep honouring: no broad glossy sheen (plastic), no screen-wide white streaks or speckles
 * (glints stay tight and sparse, reflections capped), no dark or white rings around cliff-foot rocks.
 */

export type WaterStyle = 'enhanced' | 'classic';

/**
 * Build-time choice of the water look; set before the world's terrain materials are created (sandbox ?water=, live
 * view LiveViewOptions.water).
 */
export const waterPreset: { style: WaterStyle } = { style: 'classic' };

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
  /** 0..1 sheltered water at a cliff foot: no surf, foam or exposed sand there (enhanced look). */
  calm?: ShaderNode;
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

/** Classic wave normal at a ground position (xz): analytic directional waves plus a fine noise layer. */
const classicWaveNormal = Fn(([p, wind, rain]: [ShaderNode, ShaderNode, ShaderNode]): ShaderNode => {
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

/** Moving caustic light on a shallow bed, 0..1 (classic look). */
const classicCaustics = Fn(([p]: [ShaderNode]): ShaderNode => {
  const a = mx_worley_noise_float(vec3(p.mul(2.4), time.mul(0.45)));
  const b = mx_worley_noise_float(vec3(p.mul(3.1).add(vec2(1.7, 4.2)), time.mul(-0.38)));
  return pow(float(1).sub(min(a, b)), 5);
});

function classicWaterLook(inputs: WaterLookInputs, nodes = DEFAULT_ATMOSPHERE_NODES): WaterLook {
  const { night, sceneBrightness } = nodes;
  const { position: p, shore, waterness, art, uniforms } = inputs;
  const depth = max(shore, 0);
  const normal: ShaderNode = classicWaveNormal(p.xz, uniforms.wind, uniforms.rain);

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
  const light = classicCaustics(p.xz)
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
  const reflected = inputs.reflection
    ? moonlit(inputs.reflection.colour, nodes).mul(mix(float(1), float(0.8), night))
    : null;
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

/** The water look of the current preset (see waterPreset). */
export function waterLook(inputs: WaterLookInputs, nodes = DEFAULT_ATMOSPHERE_NODES): WaterLook {
  return waterPreset.style === 'classic' ? classicWaterLook(inputs, nodes) : enhancedWaterLook(inputs, nodes);
}

/** Wave normal at a ground position (xz) of the current preset. */
export function waveNormal(p: ShaderNode, wind: ShaderNode, rain: ShaderNode): ShaderNode {
  if (waterPreset.style === 'classic') return classicWaveNormal(p, wind, rain);
  const slope = enhancedSlope(p, wind, rain, gustAt(p));
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
}

/**
 * Screen-UV offset of the mirrored scene at a ground position (xz). The enhanced look ripples reflections with the
 * swells and the broadest ripple layer only, so cliff and tree reflections break up at their edges without smearing.
 */
export function reflectionOffset(p: ShaderNode, wind: ShaderNode, rain: ShaderNode): ShaderNode {
  if (waterPreset.style === 'classic') return classicWaveNormal(p, wind, rain).xz.mul(0.015);
  const slope = rippleSlope(p, wind, float(0.5), RIPPLE_LAYERS.slice(0, 1)).add(swellSlope(p, wind));
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate())).xz.mul(REFLECTION_RIPPLE);
}

// ------------------------------------------------------------------------------------------------ enhanced look

/** Ripple layers: angle offset from the wind (rad), tile size (cells), drift along their axis (cells/s), weight. */
const RIPPLE_LAYERS: readonly (readonly [number, number, number, number])[] = [
  [0, 2.9, 0.19, 1],
  [0.95, 1.9, 0.13, 0.75],
  [-0.85, 1.25, 0.1, 0.55],
];
/**
 * Fine chop for the wave relief of water with a detail layer: short wind waves a few engine pixels long, the dense
 * light/dark strokes of the approved target's open water (shading only).
 */
const FINE_CHOP: readonly (readonly [number, number, number, number])[] = [
  // Crests across the view (waves running towards the camera, 45 degrees on the ground): horizontal strokes on screen,
  // as in the target; one layer only, domain-warped by the broad sea, so no cross-hatch from two regular layers.
  [Math.PI / 4 - WIND_ANGLE, 0.8, 0.06, 1.4],
];
/** Domain warp of the fine chop by the broad sea's slope (cells per unit slope). */
const FINE_CHOP_WARP = 1.6;
/** RMS surface slope per axis of all ripple layers together in a moderate wind (0.35), outside gusts. */
const RIPPLE_SLOPE = 0.1;
/** Long swells: angle offset from the wind, wavelength (cells), slope amplitude, angular speed (rad/s). */
const SWELLS: readonly (readonly [number, number, number, number])[] = [
  [0.15, 3.4, 0.028, 0.9],
  [-0.4, 2.2, 0.02, 1.25],
];
/**
 * UV shift of the mirrored scene per unit of surface slope: enough that the straight top edge of a reflected cliff wall
 * breaks into a wavy, shimmering line (about 4 px at zoom 1) instead of a hard seam across the water.
 */
const REFLECTION_RIPPLE = 0.02;

/** Colours of the water column and bed (linear after color()), tuned on RiverRam against concept A. */
const DEEP = 0x0b2e40;
const MID = 0x0f4a5c;
const SHALLOW = 0x1f9e93;
const BED = 0xd6c092;
/** Share of the original painted water's hue kept in the column (snow, desert and lunar water keep their character). */
const ART_HUE = 0.15;
/** Reflection: strength = Fresnel x REFLECT_GAIN + REFLECT_BASE, at most REFLECT_MAX (see the header's owner notes). */
const REFLECT_GAIN = 1.7;
const REFLECT_BASE = 0.025;
const REFLECT_MAX = 0.26;
/**
 * The analytic sky as the water shows it: dimmer than the sky and without most of its red, so open water reads as the
 * concept's deep blue-teal instead of slate grey (the column's colour shows through the weak reflection).
 */
const SKY_IN_WATER = vec3(0.3, 0.62, 0.78);
/** Ground direction towards the fixed camera, and how far behind a point its mirrored local light is sampled. */
const TOWARDS_CAMERA = vec2(Math.SQRT1_2, Math.SQRT1_2);
const LIGHT_MIRROR_REACH = 0.9;
/** Local light (explosions, fires, lamps) mirrored in the water, relative to its irradiance on the ground. */
const LIGHT_MIRROR = 0.05;
/** Swash: the waterline laps between these shore distances (cells) with this period (s). */
const SWASH_MIN = 0.015;
const SWASH_MAX = 0.13;
const SWASH_PERIOD = 5.5;
/** Breaker lines start this far out (cells) and roll in to the swash. */
const BREAKER_FAR = 0.42;

/** 0..1 gust patches ("cat's paws") drifting downwind: rougher water that gathers the sun glitter. */
function gustAt(p: ShaderNode): ShaderNode {
  const tex = waterTextures();
  const drift = vec2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE)).mul(time.mul(0.045));
  return smoothstep(0.36, 0.68, texture(tex.noise, p.div(18).sub(drift)).r);
}

/** Surface slope (d height / dx, d height / dz) of scrolled ripple normal-map layers. */
function rippleSlope(
  p: ShaderNode,
  wind: ShaderNode,
  gust: ShaderNode,
  layers: readonly (readonly [number, number, number, number])[] = RIPPLE_LAYERS,
  roughMultiplier: ShaderNode | number = 1,
  source: 'ripple' | 'chop' = 'ripple',
): ShaderNode {
  const tex = waterTextures();
  const map = source === 'chop' ? tex.chop : tex.ripple;
  const norm = Math.sqrt(RIPPLE_LAYERS.reduce((sum, layer) => sum + layer[3] * layer[3], 0));
  let rough: ShaderNode = float(0.55)
    .add(wind.mul(1.3))
    .mul(mix(float(0.6), float(1.35), gust));
  // Do not add an operation to the legacy graph when no detail layer supplies a multiplier.
  if (roughMultiplier !== 1) rough = rough.mul(roughMultiplier);
  let sx: ShaderNode = float(0);
  let sz: ShaderNode = float(0);
  for (const [offset, tile, drift, weight] of layers) {
    const angle = WIND_ANGLE + offset;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    // Layer coordinates: u along the layer's wind axis (the texture's x, where its waves travel), v across.
    const u: ShaderNode = p.x.mul(c).add(p.y.mul(s));
    const v: ShaderNode = p.y.mul(c).sub(p.x.mul(s));
    const texel: ShaderNode = texture(map, vec2(u.sub(time.mul(drift)), v).div(tile));
    const du: ShaderNode = texel.r.mul(2).sub(1).mul(RIPPLE_SLOPE_RANGE);
    const dv: ShaderNode = texel.g.mul(2).sub(1).mul(RIPPLE_SLOPE_RANGE);
    const w = (weight * RIPPLE_SLOPE) / norm;
    sx = sx.add(du.mul(c).sub(dv.mul(s)).mul(w));
    sz = sz.add(du.mul(s).add(dv.mul(c)).mul(w));
  }
  return vec2(sx, sz).mul(rough);
}

/** Crest sharpness (ripple A channel) of the two broadest ripple layers, at the same drifting coordinates. */
function rippleCrest(p: ShaderNode): ShaderNode {
  const tex = waterTextures();
  let crest: ShaderNode = float(0);
  RIPPLE_LAYERS.slice(0, 2).forEach(([offset, tile, drift], i) => {
    const angle = WIND_ANGLE + offset;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const u: ShaderNode = p.x.mul(c).add(p.y.mul(s));
    const v: ShaderNode = p.y.mul(c).sub(p.x.mul(s));
    const a: ShaderNode = texture(tex.ripple, vec2(u.sub(time.mul(drift)), v).div(tile)).a;
    crest = crest.max(i === 0 ? a : a.mul(0.85));
  });
  return crest;
}

/** Slope of the long swells (analytic). */
function swellSlope(p: ShaderNode, wind: ShaderNode): ShaderNode {
  const strength: ShaderNode = float(0.5).add(wind.mul(1.4));
  let sx: ShaderNode = float(0);
  let sz: ShaderNode = float(0);
  for (const [offset, wavelength, amplitude, speed] of SWELLS) {
    const angle = WIND_ANGLE + offset;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const k = (Math.PI * 2) / wavelength;
    const slope: ShaderNode = cos(p.x.mul(dx).add(p.y.mul(dz)).mul(k).sub(time.mul(speed)))
      .mul(amplitude)
      .mul(strength);
    sx = sx.add(slope.mul(dx));
    sz = sz.add(slope.mul(dz));
  }
  return vec2(sx, sz);
}

/** Slope of rain rings: sparse cells, each an expanding ring with a random phase (seeds from the hash texture). */
function rainSlope(p: ShaderNode, rain: ShaderNode): ShaderNode {
  const tex = waterTextures();
  const cell: ShaderNode = p.mul(4.0).floor();
  const seed: ShaderNode = texture(tex.noise, cell.add(0.5).div(WATER_TEXTURE_SIZE)).a;
  const seed2: ShaderNode = texture(tex.noise, cell.add(vec2(97.5, 41.5)).div(WATER_TEXTURE_SIZE)).a;
  const local: ShaderNode = p.mul(4.0).fract().sub(vec2(seed, seed2).mul(0.6).add(0.2));
  const phase: ShaderNode = time.mul(1.1).add(seed.mul(9.0)).fract();
  const r: ShaderNode = local.length().max(0.001);
  const ring: ShaderNode = cos(r.sub(phase.mul(0.45)).mul(45.0))
    .mul(smoothstep(0.35, 0.0, r))
    .mul(float(1).sub(phase))
    .mul(smoothstep(0.4, 0.5, seed2))
    .mul(rain)
    .mul(0.5);
  return local.div(r).mul(ring);
}

/** Full surface slope of the enhanced sea: ripples, swells and rain rings. */
function enhancedSlope(
  p: ShaderNode,
  wind: ShaderNode,
  rain: ShaderNode,
  gust: ShaderNode,
  roughMultiplier: ShaderNode | number = 1,
): ShaderNode {
  return rippleSlope(p, wind, gust, RIPPLE_LAYERS, roughMultiplier).add(swellSlope(p, wind)).add(rainSlope(p, rain));
}

function enhancedWaterLook(inputs: WaterLookInputs, nodes = DEFAULT_ATMOSPHERE_NODES): WaterLook {
  const { night, sceneBrightness } = nodes;
  const { position: p, shore, waterness, art, uniforms } = inputs;
  const tex = waterTextures();
  const xz: ShaderNode = p.xz;
  const surf: ShaderNode = float(1).sub(inputs.calm ?? float(0));
  const depth: ShaderNode = max(shore, 0);
  const gust = gustAt(xz);
  const slope = enhancedSlope(xz, uniforms.wind, uniforms.rain, gust);
  const normal: ShaderNode = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));

  // Water column: dark blue-teal within half a cell of the bank already, a narrow turquoise shallow band, and the sandy
  // bed showing through right at the shore.
  let column: ShaderNode = mix(color(DEEP), color(MID), smoothstep(1.3, 0.35, depth));
  column = mix(column, color(SHALLOW), smoothstep(0.42, 0.03, depth).mul(0.9));
  const artLevel = max(dot(art, vec3(0.2126, 0.7152, 0.0722)), 0.002);
  const columnLevel = dot(column, vec3(0.2126, 0.7152, 0.0722));
  // Only away from the bank: the painted water's white sparkle pixels, brought to the bright shallows' level, showed as
  // grey specks all over the turquoise band.
  column = mix(column, art.mul(columnLevel.div(artLevel)), smoothstep(0.1, 0.6, depth).mul(ART_HUE));
  // Caustics: two scrolled copies of the caustic web, bent by the ripples; their sum is a moving net of light lines,
  // brightest where the two cross (the minimum or product of two thin webs leaves only the crossings: white specks).
  const t: ShaderNode = time;
  const c1: ShaderNode = texture(
    tex.caustics,
    xz
      .div(1.35)
      .add(slope.mul(0.3))
      .add(vec2(t.mul(0.035), t.mul(0.021))),
  ).r;
  const c2: ShaderNode = texture(
    tex.caustics,
    xz
      .div(1.9)
      .sub(slope.mul(0.25))
      .add(vec2(t.mul(-0.027), t.mul(0.03))),
  ).r;
  const light: ShaderNode = pow(c1.add(c2).mul(0.5), 1.6)
    .mul(0.9)
    .mul(smoothstep(0.55, 0.03, depth));
  const bed: ShaderNode = color(BED);
  const clarity: ShaderNode = exp(depth.mul(-5.5));
  let body: ShaderNode = mix(column, bed.mul(float(0.68).add(light)), clarity.mul(0.5));
  // At night the water column swallows the (cool) moonlight: darker than the land around it, not a glowing blue.
  body = body.mul(mix(float(1), float(0.7), night));

  // Reflection: Schlick Fresnel for water (F0 = 0.02), lifted slightly so reflections still read at RTS distance.
  const view: ShaderNode = normalize(cameraPosition.sub(p));
  const fresnel: ShaderNode = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(normal, view), 0)), 5)));
  const strength: ShaderNode = fresnel.mul(REFLECT_GAIN).add(REFLECT_BASE).min(REFLECT_MAX);
  const r: ShaderNode = reflect(view.negate(), normal);
  const skyLevel: ShaderNode = mix(float(1), sceneBrightness.min(1).mul(0.6), night);
  const sky: ShaderNode = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0.0, 0.6, r.y)).mul(
    skyLevel.mul(SKY_IN_WATER),
  );
  const reflected = inputs.reflection
    ? moonlit(inputs.reflection.colour, nodes).mul(mix(float(1), float(0.8), night))
    : null;
  const mirrored: ShaderNode = reflected && inputs.reflection ? mix(sky, reflected, inputs.reflection.coverage) : sky;
  // Sun glitter: the sun mirrored in ripple facets, a tight lobe (small bright sparkles, bloomed) over a faint wider one;
  // gathered in gusts, none in rain or right at the bank.
  const sunDot: ShaderNode = max(dot(r, uniforms.sunDirection), 0);
  const glitter: ShaderNode = pow(sunDot, 600)
    .mul(6)
    .add(pow(sunDot, 110).mul(0.3))
    .mul(mix(float(0.3), float(1.35), gust))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night.mul(0.75)))
    .mul(smoothstep(0.04, 0.25, depth));
  const glint: ShaderNode = uniforms.sunColor.mul(glitter);
  // Explosions, fires and lamps mirrored in the water: the light field sampled behind the point (its mirror image lies
  // towards the camera), broken up by the ripples.
  const rippleEnergy: ShaderNode = abs(slope.x).add(abs(slope.y));
  const lights: ShaderNode = sampleLightField(xz.sub(TOWARDS_CAMERA.mul(LIGHT_MIRROR_REACH)).add(slope.mul(0.5)), nodes)
    .mul(LIGHT_MIRROR)
    .mul(float(0.5).add(rippleEnergy.mul(4)));

  // Shoreline. The swash laps between SWASH_MIN and SWASH_MAX, out of phase along the bank (broad noise); a thin broken
  // foam line rides its edge (brighter while it runs in), wet sand shows behind it as it drains back, a fainter breaker
  // line rolls in from BREAKER_FAR, and lace foam drifts in the surf zone.
  const along: ShaderNode = texture(tex.noise, xz.mul(0.11)).r;
  // Breakup of the foam line: medium noise, so the line has gaps a few tenths of a cell long rather than dots.
  const lace: ShaderNode = texture(tex.noise, xz.mul(0.3).add(vec2(t.mul(0.012), t.mul(-0.009)))).g;
  // Surf-zone lace: foam patches a tenth of a cell or so across, drifting (the fine noise is 1/24 of its tile).
  const lace2: ShaderNode = texture(tex.noise, xz.mul(0.3).sub(vec2(t.mul(0.012), t.mul(0.004)))).b;
  const cycle: ShaderNode = t.mul((Math.PI * 2) / SWASH_PERIOD).add(along.mul(14));
  const swash: ShaderNode = mix(float(SWASH_MIN), float(SWASH_MAX), sin(cycle).mul(0.5).add(0.5));
  // d(swash)/dt ~ cos(cycle): negative while the edge runs up the bank.
  const advancing: ShaderNode = smoothstep(0.3, -0.6, cos(cycle));
  const lineWidth = 0.032;
  const line: ShaderNode = smoothstep(lineWidth, 0.0, abs(shore.sub(swash)))
    .mul(mix(float(0.5), float(1), advancing))
    .mul(smoothstep(0.3, 0.5, lace));
  const exposed: ShaderNode = smoothstep(swash.add(0.004), swash.sub(0.014), shore)
    .mul(smoothstep(-0.02, 0.005, shore))
    .mul(surf);
  const roll: ShaderNode = fract(cycle.div(Math.PI * 2).add(0.35));
  const breakerAt: ShaderNode = mix(float(BREAKER_FAR), swash.add(0.03), roll);
  const breaker: ShaderNode = smoothstep(0.03, 0.0, abs(shore.sub(breakerAt)))
    .mul(smoothstep(0.0, 0.2, roll))
    .mul(smoothstep(1.0, 0.7, roll))
    .mul(smoothstep(0.4, 0.62, lace))
    .mul(0.55);
  const surfLace: ShaderNode = smoothstep(0.6, 0.8, lace2)
    .mul(smoothstep(0.26, 0.05, shore))
    .mul(0.4);
  const foam: ShaderNode = clamp(
    line
      .max(breaker)
      .max(surfLace)
      .mul(surf)
      .mul(smoothstep(-0.01, 0.01, shore)),
    0,
    1,
  );

  // Foam and wet sand are lit like the ground; foam is kept greyer at night so shorelines do not outline every water
  // body in white.
  const foamColour: ShaderNode = color(0xeef3f2).mul(mix(float(1), float(0.5), night));
  body = mix(body, bed.mul(0.55), exposed);
  body = mix(body.mul(float(1).sub(strength)), foamColour, foam);
  const emission: ShaderNode = mirrored
    .mul(strength)
    .add(glint)
    .add(lights)
    .mul(float(1).sub(foam))
    .mul(float(1).sub(exposed.mul(0.75)))
    .mul(waterness);
  return { normal, body, emission, foam };
}

/** Wet sand on land within a few tenths of a cell of the water (darker, glossier), 0..1. */
export function wetShore(shore: ShaderNode): ShaderNode {
  return smoothstep(-0.25, -0.02, shore).mul(smoothstep(0.08, -0.02, shore));
}

// ------------------------------------------------------------------------------------ painted lake-bed look

/**
 * World units per raw mirror depth for an orthographic WebGPU reflector (three r186, clipBias = 0).
 * ReflectorNode replaces projection row 3 with a positive multiple of the unit water plane in view space.
 * Row 4 stays (0, 0, 0, 1), so depth = clip.z / clip.w = height * length(row3.xyz). Row3.w locates the
 * water plane: it cancels at the waterline, including at nonzero water elevations. There is no depth offset or
 * WebGL-style 0.5 remapping. Cleared depth = 1 is sky, not a height measurement. Keep the last valid scale if
 * a projection is temporarily degenerate; the caller starts at zero until the mirror has rendered.
 */
export function reflectionWorldPerDepth(elements: ArrayLike<number>, previous = 0): number {
  const scale = 1 / Math.hypot(elements[2]!, elements[6]!, elements[10]!);
  return Number.isFinite(scale) && scale > 0 ? scale : previous;
}

/**
 * Lake-bed mirror only. Heights are world units above the water (one RA2 level = 0.40825 units).
 * Across/along gains are screen-plane world units per (unit slope * unit height); projection converts them to UV.
 * At zoom 1 (42.426 CSS px/world unit), a moderate-wind peak slope of 0.2 at 2-3 levels adds 6.93-10.39 px
 * vertically and 1.04-1.56 px horizontally. Spread is screen-plane units per unit height: the three taps span
 * 4.50-6.75 CSS px at those heights. These scales follow zoom, independently of DPR and the half-size mirror.
 * The old UV offset still probes height, but its final contribution fades in with height and is capped at
 * baseRippleMax screen-plane world units (0.51 CSS px at zoom 1): total displacement is zero at height zero,
 * and the vertical peaks above remain within 6.42-10.90 px including that residual offset.
 * Contrast reaches keepTop at fadeHeight; maxHeight bounds both sky-side edge breakup and very tall objects.
 */
const RIPPLED_REFLECTION = {
  across: 0.15,
  along: 1,
  spread: 0.065,
  baseRippleMax: 0.012,
  fadeHeight: 3 * LEVEL_HEIGHT,
  maxHeight: 4 * LEVEL_HEIGHT,
  keepTop: 0.6,
} as const;

/** Height-dependent distortion and three-tap vertical blur, using the bed normal's full ripple/swell/rain slope. */
export function rippledReflection(
  mirror: ReflectorNode,
  position: ShaderNode,
  uniforms: WaterUniforms,
): { colour: ShaderNode; coverage: ShaderNode } {
  const worldPerDepth = uniform(0).onRenderUpdate(({ camera }, self) => {
    // Do not read the unmodified camera clone before the first reflected render. A previous-frame scale is fine.
    if (!camera || !mirror.reflector.hasOutput) return self.value;
    return reflectionWorldPerDepth(mirror.reflector.getVirtualCamera(camera).projectionMatrix.elements, self.value);
  });
  const p: ShaderNode = position.xz;
  const slope = enhancedSlope(p, uniforms.wind, uniforms.rain, gustAt(p));
  const baseUv: ShaderNode = mirror.uvNode;
  const offset: ShaderNode = reflectionOffset(p, uniforms.wind, uniforms.rain);
  const uv0: ShaderNode = baseUv.add(offset);
  const depth = mirror.getDepthNode();
  const coverageAt = (uv: ShaderNode): ShaderNode => smoothstep(0.9999, 0.999, depth.sample(uv).x);
  const seedDepth: ShaderNode = depth.sample(uv0).x;
  const h: ShaderNode = smoothstep(0.9999, 0.999, seedDepth)
    .greaterThan(0)
    .select(clamp(seedDepth.mul(worldPerDepth), 0, RIPPLED_REFLECTION.maxHeight), float(RIPPLED_REFLECTION.maxHeight));
  // The fixed camera's ground axes are across (-x + z) and along (x + z); mirror UV flips screen X.
  const across: ShaderNode = slope.y.sub(slope.x).mul(Math.SQRT1_2);
  const along: ShaderNode = dot(slope, TOWARDS_CAMERA);
  const projection: ShaderNode = cameraProjectionMatrix;
  const uvPerWorld: ShaderNode = vec2(projection.element(0).x, projection.element(1).y).abs().mul(0.5);
  const heightFade: ShaderNode = smoothstep(0, RIPPLED_REFLECTION.fadeHeight, h);
  // Keeping the full old ~4 px shift in uv1 would move even a zero-height cliff foot. Retain only a bounded,
  // height-faded residual there; the unmodified offset above remains the depth probe requested by the bed path.
  const offsetWorld: ShaderNode = offset.div(uvPerWorld);
  const residual: ShaderNode = offsetWorld
    .mul(float(RIPPLED_REFLECTION.baseRippleMax).div(max(offsetWorld.length(), RIPPLED_REFLECTION.baseRippleMax)))
    .mul(heightFade)
    .mul(uvPerWorld);
  const uv1: ShaderNode = baseUv
    .add(residual)
    .add(vec2(across.mul(RIPPLED_REFLECTION.across), along.mul(RIPPLED_REFLECTION.along)).mul(h).mul(uvPerWorld));
  let colour: ShaderNode = vec3(0);
  let coverage: ShaderNode = float(0);
  for (const k of [-1, 0, 1]) {
    const uv: ShaderNode = uv1.add(vec2(0, h.mul(k * RIPPLED_REFLECTION.spread).mul(uvPerWorld.y)));
    const covered = coverageAt(uv);
    // Average premultiplied taps so cleared/sky texels cannot darken the silhouette before coverage is applied.
    colour = colour.add(mirror.sample(uv).rgb.mul(covered));
    coverage = coverage.add(covered);
  }
  const keep: ShaderNode = mix(float(1), float(RIPPLED_REFLECTION.keepTop), heightFade);
  // Folding keep into average coverage is exactly mix(waterSky, mix(waterSky, reflected, keep), coverage).
  // bedWaterLook supplies its own sky AFTER the existing moonlight grade, avoiding a second grade on that sky.
  return { colour: colour.div(max(coverage, 0.00001)), coverage: coverage.div(3).mul(keep) };
}

/** Beach profile: shelf width (cells), initial optical-depth slope, then quadratic deepening beyond the shelf. */
export const BEACH_PROFILE = { shelf: 0.35, slope: 2.5, drop: 20 } as const;
/** Beer-Lambert absorption per unit optical depth (RGB): red disappears first; the bed is lost by 0.8-1 cells. */
export const BED_ABSORPTION = [4.2, 1.45, 1.0] as const;
/** In-scattered colour of the water over the shelf (turquoise, about one cell wide as in the approved target), faded
 * towards the enhanced MID/DEEP offshore. */
const BED_SCATTER = { colour: 0x1f9e93, near: 0.1, far: 0.95, amount: 0.85 } as const;
/** Lit turquoise shelf on maps with a painted surface tile (cells from the bank; see bedWaterLook). */
const BED_SHALLOW_GLOW = { colour: 0x2aa89c, near: 0.2, far: 0.85, amount: 0.45 } as const;
/** Optional per-map water detail, used only by the painted-bed look. */
export const WATER_DETAIL = {
  /** Gain from linear detail colour to the in-scattered column colour. */
  columnGain: 1.0,
  /** 0 keeps the constant DEEP/MID/scatter column; 1 uses the detail colour. */
  columnAmount: 1.0,
  /** Share of the constant turquoise scatter retained over the first shallowReach cells. */
  shallowKeep: 0.35,
  /** Shore distance in cells over which shallowKeep fades out. */
  shallowReach: 0.25,
  /** Strength of alpha modulation of ripple roughness and glitter; A = 0.5 is neutral. */
  roughAmount: 1.0,
} as const;
/**
 * Open-water surface detail of the painted-bed look on maps with a water-detail layer, tuned against the approved
 * river target (finallook4/water metrics: the target's open water has ~1.5x the luminance spread, ~1.6x the local
 * contrast and ~10x the share of bright specks of the earlier water):
 * - relief: wave flanks facing the sun are lit, lee flanks darker (the diffuse body otherwise ignores the waves);
 * - whitecaps: small white caps on the steepest crests of the two broadest ripple layers, gathered by gusts and the
 *   layer's roughness (A), drifting with the waves;
 * - sparkles: sun-coloured points on crest facets, twinkling as the slopes move (a hash looked up through the slope),
 *   strongest along the sun's glitter path but present everywhere, like the target's speckled chop.
 */
export const WATER_SURFACE = {
  relief: 1.2,
  /** Relief of the fine chop layers (shading only, they do not bend reflections). */
  fineRelief: 14,
  reliefMin: 0.4,
  reliefMax: 2.6,
  capLow: 0.72,
  capHigh: 0.95,
  capAmount: 0.55,
  capBreakup: 0.72,
  sparkScale: 0.075,
  /** Glint grid cells per unit of (x - z) and of (x + z) / 2: square cells of 30 / sparkCells engine pixels. */
  sparkCells: 5,
  sparkJitter: 1.2,
  sparkThreshold: 0.65,
  sparkGain: 6,
  sparkPath: 8.0,
  sparkPathPower: 3,
  sparkBase: 0.25,
} as const;
/**
 * The painted surface tile (MapMaterials.waterSurface) on water with a detail layer: the image model's chop strokes and
 * crest glints, repeated in screen-aligned ground space, so the waves read like the approved target at game scale.
 * Two copies drift with the wind and cross-fade (flow-map phases), re-placed while invisible, and the broad swell's
 * slope bends them; deviations are rescaled by 1 / |w| so the cross-fade keeps the painted contrast.
 */
export const WATER_SURFACE_TILE = {
  /** Tile drift on screen (tiles per second) and the flow period (s) after which a copy is re-placed. */
  driftX: 0.006,
  driftY: -0.011,
  period: 7,
  /** Offset of each new placement (tiles), irrational so placements never repeat. */
  jumpX: 0.371,
  jumpY: 0.613,
  /** Tiles per unit of swell slope (the long swells bend the painted chop). */
  warp: 0.15,
  /** Exponent on the painted relief ratio (1 = as painted) and its weight offshore. */
  relief: 1.0,
  reliefAmount: 0.9,
  /** Glint gain (x sun colour) and the glitter-path lift towards the sun's mirror direction. */
  glintGain: 2.4,
  glintPath: 3.0,
  glintPathPower: 4,
  glintFloor: 0.2,
  /** Glint copy magnification: across (screen x) and down (screen y). */
  glintStretchX: 2.8,
  glintStretchY: 1.35,
  /** Glint cores: the cross-faded glint value is sharpened between these levels (crisp specks, not soft discs). */
  glintLow: 0.12,
  glintHigh: 0.55,
  /** Glint density outside / inside gust patches, and the power on the detail layer's roughness weight. */
  glintCalm: 0.25,
  glintGust: 1.7,
  glintRoughPower: 1.5,
  /** Glints are the sun itself: a touch warmer than the sun colour's average, like the target's golden specks. */
  glintTint: [1.0, 0.86, 0.62],
  /** Foam lace: the lace tile scale relative to the surface tile, and its drift (tiles/s). */
  laceScale: 0.55,
  laceDriftX: 0.004,
  laceDriftY: 0.007,
} as const;
/** Foam at cliff feet (cells; see bedWaterLook): lapping band width, backwash reach, opacities, wet contact shade. */
const CLIFF_FOAM = {
  base: 0.05,
  lap: 0.1,
  opacity: 0.6,
  backReach: 0.3,
  backOpacity: 0.4,
  contactShade: 0.7,
  contactReach: 0.12,
} as const;
/** Minimum reflectance of mirrored objects on water with a detail layer (see bedWaterLook). */
const OBJECT_REFLECT = 0.12;
/**
 * Share of the mirrored scene over the sky reflection on water with a detail layer: the approved target shows cliff
 * and tree reflections as faint dark-warm tints, the sky's blue dominating; full coverage read as red-brown smears.
 */
const OBJECT_COVERAGE = 0.5;
/** Analytic sky as water with a detail layer reflects it (see bedWaterLook). */
const WATER_DETAIL_SKY = vec3(0.45, 0.7, 0.6);
/** Refraction in world cells per ripple slope per depth, bounded to about 2.5 engine pixels in any direction. */
const BED_REFRACTION = 0.18;
const BED_REFRACTION_MAX = 0.06;
/** Blend from the exact land sample over these cells, avoiding a zero-depth seam from implicit texture LOD changes. */
const BED_REFRACTION_FADE = 0.04;
/** Bed illumination: unit ambient preserves the shore colour; caustics fade in, then out across the shallow shelf. */
const BED_AMBIENT = 1;
const BED_CAUSTICS = { gain: 0.65, start: 0.04, peak: 0.18, end: 0.55 } as const;
/** Fully wet through maximum run-up, drying towards a noisy edge 0.25-0.35 cells inland. */
const BEACH_WET = {
  reach: 0.22,
  jitter: 0.08,
  full: 0.03,
  brightness: 0.8,
  saturation: 1.1,
  roughness: 0.32,
  sheen: 0.018,
} as const;
/** Swash distances are cells; period is seconds, depth is optical depth, phase spread is radians. */
const BED_SWASH = {
  runup: 0.09,
  retreat: 0.04,
  period: 6.2,
  feather: 0.018,
  depth: 0.025,
  phaseScale: 0.11,
  phaseSpread: 14,
  tintFade: 0.035,
  roughness: 0.2,
  sheen: 0.04,
} as const;
/** Foam widths/reach in cells, opacity caps and noise thresholds; no line is tied to the static mask edge. */
const BED_FOAM = {
  frontWidth: 0.03,
  frontOpacity: 0.8,
  waterOpacity: 0.5,
  laceLow: 0.34,
  laceHigh: 0.56,
  bubbleLow: 0.5,
  bubbleHigh: 0.7,
  breakerFar: 0.45,
  breakerWidth: 0.03,
  /** With a painted lace tile: thin wavy breaker lines (width, opacity), their wobble (cells) and its noise scale. */
  wavyBreakerWidth: 0.028,
  wavyBreakerOpacity: 0.95,
  wobble: 0.12,
  wobbleScale: 0.8,
  wavyLaceOpacity: 0.45,
  /** Surf-zone lace and second breaker opacity (the approved target shows a wide, lacy surf band on beaches). */
  laceOpacity: 0.7,
} as const;
/** Shore distance over which reflections replace the faint wet-sand sheen; glitter starts farther offshore. */
const BED_REFLECTION_REACH = { start: 0.05, full: 0.4 } as const;
const BED_GLITTER_START = 0.1;
const BED_GLITTER_FULL = 0.25;
/** Texture scales (tiles/cell) and drift (tiles/s) for the wet edge, broken foam and fine draining bubbles. */
const BEACH_NOISE = { wetScale: 0.35, laceScale: 0.3, driftX: 0.012, driftZ: -0.009 } as const;

/**
 * Optical depth, not geometry height: continuous with a continuous slope at the shelf's end, zero on land.
 * The numeric form is also useful for testing/tuning transmittance without a GPU; both forms share the profile.
 */
export function beachDepth(shore: number): number;
export function beachDepth(shore: ShaderNode): ShaderNode;
export function beachDepth(shore: ShaderNode): ShaderNode {
  if (typeof shore === 'number') {
    const distance = Math.max(shore, 0);
    return distance * BEACH_PROFILE.slope + Math.max(distance - BEACH_PROFILE.shelf, 0) ** 2 * BEACH_PROFILE.drop;
  }
  const distance: ShaderNode = max(shore, 0);
  return distance
    .mul(BEACH_PROFILE.slope)
    .add(pow(max(distance.sub(BEACH_PROFILE.shelf), 0), 2).mul(BEACH_PROFILE.drop));
}

export interface BedWaterInputs extends WaterLookInputs {
  /** 0..1 normalised distance to the nearest cliff wall (CLIFF_FIELD_MAX cells = 1),
   * when the map has a shoreIgnore mask. */
  cliff?: ShaderNode;
  /** Composite-space water-detail sample: RGB is linear apparent colour, A is roughness/glitter weight. */
  detail?: ShaderNode;
  /**
   * Repeating painted open-water surface (MapMaterials.waterSurface): R relief ratio / 2, G crest glints, B foam lace;
   * scale is the tile width in screen units of 30 engine px. Used together with a detail layer only.
   */
  surface?: { texture: Texture; scale: number };
  /** Graded linear bed colour at a world xz offset, with the same rain wetness as art (the adjacent land albedo). */
  bedAt: (offsetXZ: ShaderNode) => ShaderNode;
  /** Display compensation belongs only to in-scattered water, never to transmitted bed colour or foam. */
  columnForDisplay: (column: ShaderNode) => ShaderNode;
  /** The existing display level compensation for water reflections and glitter. */
  reflectionLevel: ShaderNode;
}

export interface BedWaterLook extends WaterLook {
  /** Wet land before the transparent swash sheet; body is the bed plus the in-scattered water above it. */
  land: ShaderNode;
  /** Union of the static water mask and the swash sheet, including negative shore distances. */
  coverage: ShaderNode;
  /** Offshore weight for fading the existing rain sheen without cutting it off at the static mask. */
  openWater: ShaderNode;
  /** Foam is composited over BOTH land and water, avoiding a mask seam when its front crosses zero. */
  foamColour: ShaderNode;
  /** Shore wetness, roughness and specular weight, also used by the land material. */
  wetness: ShaderNode;
  roughness: ShaderNode;
  gloss: ShaderNode;
}

/**
 * Opt-in lake-bed shoreline. The old enhanced and classic graphs above deliberately remain separate: their painted
 * water assets need the original hue mix, inland replacement and whole-body display compensation.
 */
export function bedWaterLook(inputs: BedWaterInputs, nodes = DEFAULT_ATMOSPHERE_NODES): BedWaterLook {
  const { position: p, shore, waterness, art, uniforms, bedAt, columnForDisplay, reflectionLevel, detail } = inputs;
  const { night, sceneBrightness } = nodes;
  const tex = waterTextures();
  const xz: ShaderNode = p.xz;
  const surf: ShaderNode = float(1).sub(inputs.calm ?? float(0));
  const gust = gustAt(xz);
  const rough: ShaderNode | number = detail ? mix(float(1), detail.a.mul(2), WATER_DETAIL.roughAmount) : 1;
  const slope = enhancedSlope(xz, uniforms.wind, uniforms.rain, gust, rough);
  const normal: ShaderNode = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));

  const along: ShaderNode = texture(tex.noise, xz.mul(BED_SWASH.phaseScale)).r;
  const cycle: ShaderNode = time.mul((Math.PI * 2) / BED_SWASH.period).add(along.mul(BED_SWASH.phaseSpread));
  const rise: ShaderNode = sin(cycle).mul(0.5).add(0.5);
  const front: ShaderNode = mix(float(BED_SWASH.retreat), float(-BED_SWASH.runup), rise);
  // Negative front velocity is run-up. During drainage, only sparse bubbles remain behind the moving edge.
  const advancing: ShaderNode = smoothstep(-0.15, 0.45, cos(cycle));
  const sheet: ShaderNode = smoothstep(front, front.add(BED_SWASH.feather), shore)
    .mul(smoothstep(BED_SWASH.retreat, 0, shore))
    .mul(surf);
  const coverage: ShaderNode = waterness.max(sheet);
  const wetNoise: ShaderNode = texture(tex.noise, xz.mul(BEACH_NOISE.wetScale)).r.mul(2).sub(1);
  const wetReach: ShaderNode = float(BEACH_WET.reach).add(wetNoise.mul(BEACH_WET.jitter));
  const wetness: ShaderNode = smoothstep(wetReach.negate(), -BEACH_WET.full, shore).mul(surf);
  const wetSand = (bed: ShaderNode): ShaderNode => {
    const luma: ShaderNode = dot(bed, vec3(0.2126, 0.7152, 0.0722));
    const saturated: ShaderNode = mix(vec3(luma), bed, BEACH_WET.saturation).max(0);
    return mix(bed, saturated.mul(BEACH_WET.brightness), wetness);
  };
  const land: ShaderNode = wetSand(art);

  // Both sides approach the same wet sand at shore = 0. The very thin land film adds a little tint away from that
  // join; no whole-body grade, blanket night multiplier or nonzero refraction is allowed at zero depth.
  const filmFade: ShaderNode = smoothstep(0, BED_SWASH.tintFade, shore.negate());
  const depth: ShaderNode = beachDepth(shore).add(sheet.mul(BED_SWASH.depth).mul(filmFade));
  const transmission: ShaderNode = exp(vec3(...BED_ABSORPTION).mul(depth.negate()));
  const offset: ShaderNode = slope.mul(depth).mul(BED_REFRACTION);
  const boundedOffset: ShaderNode = offset.mul(float(BED_REFRACTION_MAX).div(max(offset.length(), BED_REFRACTION_MAX)));
  const c1: ShaderNode = texture(
    tex.caustics,
    xz
      .div(1.35)
      .add(slope.mul(0.3))
      .add(vec2(time.mul(0.035), time.mul(0.021))),
  ).r;
  const c2: ShaderNode = texture(
    tex.caustics,
    xz
      .div(1.9)
      .sub(slope.mul(0.25))
      .add(vec2(time.mul(-0.027), time.mul(0.03))),
  ).r;
  const caustics: ShaderNode = pow(c1.add(c2).mul(0.5), 1.6)
    .mul(BED_CAUSTICS.gain)
    .mul(smoothstep(0, BED_CAUSTICS.start, shore))
    .mul(smoothstep(BED_CAUSTICS.end, BED_CAUSTICS.peak, shore))
    .mul(surf);
  const refracted: ShaderNode = mix(art, bedAt(boundedOffset), smoothstep(0, BED_REFRACTION_FADE, abs(shore)));
  const bedLit: ShaderNode = wetSand(refracted).mul(float(BED_AMBIENT).add(caustics));
  // Preserve the enhanced deep/mid character; the sand supplies the shallow colour, never ART_HUE or a constant BED.
  const offshore: ShaderNode = max(shore, 0);
  const column: ShaderNode = mix(
    mix(color(DEEP), color(MID), smoothstep(1.3, 0.35, offshore)),
    color(BED_SCATTER.colour),
    smoothstep(BED_SCATTER.far, BED_SCATTER.near, offshore).mul(BED_SCATTER.amount),
  );
  const nightLevel: ShaderNode = mix(float(1), float(0.7), night);
  let displayedColumn: ShaderNode;
  if (detail) {
    const weight: ShaderNode = float(WATER_DETAIL.columnAmount).mul(
      float(1).sub(smoothstep(WATER_DETAIL.shallowReach, 0, offshore).mul(WATER_DETAIL.shallowKeep)),
    );
    // The repaint already describes a display colour: compensate only the constant column, then dim both at night.
    displayedColumn = mix(columnForDisplay(column), detail.rgb.mul(WATER_DETAIL.columnGain), weight);
    if (inputs.surface) {
      // Luminous turquoise over the sandy shelf (the approved target's beaches): sunlight scattered back from the bed
      // through clear shallow water, widest within about three quarters of a cell of the bank.
      const lit: ShaderNode = smoothstep(BED_SHALLOW_GLOW.far, BED_SHALLOW_GLOW.near, offshore).mul(
        BED_SHALLOW_GLOW.amount,
      );
      displayedColumn = mix(displayedColumn, columnForDisplay(color(BED_SHALLOW_GLOW.colour)), lit);
    }
    displayedColumn = displayedColumn.mul(nightLevel);
  } else {
    // Keep the original operation order (including compensation after night dimming) without a detail layer.
    displayedColumn = columnForDisplay(column.mul(nightLevel));
  }
  let body: ShaderNode = bedLit.mul(transmission).add(displayedColumn.mul(vec3(1).sub(transmission)));

  // Reuse the enhanced reflection, glitter, mirrored lights and rain-ripple model, fading it to zero at the sand join.
  const open: ShaderNode = smoothstep(BED_REFLECTION_REACH.start, BED_REFLECTION_REACH.full, shore);
  const crest: ShaderNode | null = detail ? rippleCrest(xz) : null;
  // Painted surface tile: two copies drifting on screen, cross-faded by flow phase and re-placed while invisible.
  let tile: { relief: ShaderNode; glint: ShaderNode; lace: ShaderNode } | null = null;
  if (detail && inputs.surface) {
    const T = WATER_SURFACE_TILE;
    const map = inputs.surface.texture;
    const screen: ShaderNode = vec2(xz.x.sub(xz.y), xz.x.add(xz.y).mul(0.5)).div(inputs.surface.scale);
    // Only the long swells bend the painted chop: the ripple layers' slope would crumple it at their own frequency.
    const bend: ShaderNode = swellSlope(xz, uniforms.wind).mul(T.warp);
    const q: ShaderNode = screen.add(bend);
    const flow = (i: number, scale: ShaderNode | null = null) => {
      const t: ShaderNode = time.div(T.period).add(i * 0.5);
      const phase: ShaderNode = fract(t);
      const uv: ShaderNode = (scale ? q.mul(scale) : q)
        .add(vec2(T.driftX, T.driftY).mul(phase.mul(T.period)))
        .add(vec2(T.jumpX, T.jumpY).mul(t.floor().add(i * 0.37)));
      return { sample: texture(map, uv), weight: float(1).sub(abs(phase.mul(2).sub(1))) };
    };
    const a = flow(0);
    const b = flow(1);
    // Glints from their own, magnified and horizontally stretched copies: the target's sun specks are short horizontal
    // streaks several engine pixels wide, larger than the painted chop's own highlights.
    const glintScale: ShaderNode = vec2(1 / T.glintStretchX, 1 / T.glintStretchY);
    const ga = flow(0, glintScale);
    const gb = flow(1, glintScale);
    const norm: ShaderNode = float(1).div(max(sqrt(a.weight.mul(a.weight).add(b.weight.mul(b.weight))), 0.5));
    const deviation: ShaderNode = a.sample.r
      .mul(2)
      .sub(1)
      .mul(a.weight)
      .add(b.sample.r.mul(2).sub(1).mul(b.weight))
      .mul(norm);
    const laceUv: ShaderNode = screen.div(T.laceScale).add(bend).add(vec2(T.laceDriftX, T.laceDriftY).mul(time));
    tile = {
      relief: float(1).add(deviation),
      glint: ga.sample.g.mul(ga.weight).add(gb.sample.g.mul(gb.weight)).mul(norm),
      lace: texture(map, laceUv).b,
    };
  }
  if (detail) {
    // Wave relief: n.L of the rippled surface against the flat one, through the slope towards the sun on the ground.
    const sunGround: ShaderNode = normalize(vec2(uniforms.sunDirection.x, uniforms.sunDirection.z).add(vec2(1e-4, 0)));
    const fine: ShaderNode = rippleSlope(
      xz.add(slope.mul(FINE_CHOP_WARP)),
      uniforms.wind,
      gust,
      FINE_CHOP,
      rough,
      'chop',
    );
    // With a painted surface tile its strokes replace the procedural fine chop; the broad slope still shades swells.
    const facing: ShaderNode = (
      tile
        ? dot(slope, sunGround).mul(WATER_SURFACE.relief)
        : dot(slope, sunGround).mul(WATER_SURFACE.relief).add(dot(fine, sunGround).mul(WATER_SURFACE.fineRelief))
    ).negate();
    // Exponential: lit crest flanks flare up to a few times the body, lee flanks fall off more gently.
    const relief: ShaderNode = exp(facing).clamp(WATER_SURFACE.reliefMin, WATER_SURFACE.reliefMax);
    body = body.mul(mix(float(1), relief, smoothstep(0.12, 0.6, shore)));
    if (tile) {
      const painted: ShaderNode = pow(max(tile.relief, 0.05), WATER_SURFACE_TILE.relief);
      body = body.mul(mix(float(1), painted, smoothstep(0.06, 0.4, shore).mul(WATER_SURFACE_TILE.reliefAmount)));
    }
  }
  const view: ShaderNode = normalize(cameraPosition.sub(p));
  const fresnel: ShaderNode = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(normal, view), 0)), 5)));
  const strength: ShaderNode = fresnel.mul(REFLECT_GAIN).add(REFLECT_BASE).min(REFLECT_MAX).mul(open);
  const r: ShaderNode = reflect(view.negate(), normal);
  const skyLevel: ShaderNode = mix(float(1), sceneBrightness.min(1).mul(0.6), night);
  const sky: ShaderNode = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0.0, 0.6, r.y)).mul(skyLevel);
  // With a detail layer the column already carries the water's apparent colour (sky included, as the repaint shows
  // it): the analytic sky is reflected dimmer and greener so open water reads teal, not sky blue; mirrored cliffs and
  // trees keep their full strength.
  const waterSky: ShaderNode = detail ? sky.mul(SKY_IN_WATER).mul(WATER_DETAIL_SKY) : sky.mul(SKY_IN_WATER);
  const reflected = inputs.reflection
    ? moonlit(inputs.reflection.colour, nodes).mul(mix(float(1), float(0.8), night))
    : null;
  const mirrored: ShaderNode =
    reflected && inputs.reflection ? mix(waterSky, reflected, inputs.reflection.coverage) : waterSky;
  const sunDot: ShaderNode = max(dot(r, uniforms.sunDirection), 0);
  let glitter: ShaderNode = pow(sunDot, 600)
    .mul(6)
    .add(pow(sunDot, 110).mul(0.3))
    .mul(mix(float(0.3), float(1.35), gust))
    .mul(float(1).sub(uniforms.rain))
    .mul(float(1).sub(night.mul(0.75)))
    .mul(smoothstep(BED_GLITTER_START, BED_GLITTER_FULL, shore));
  if (detail) glitter = glitter.mul(rough);
  const rippleEnergy: ShaderNode = abs(slope.x).add(abs(slope.y));
  const lights: ShaderNode = sampleLightField(xz.sub(TOWARDS_CAMERA.mul(LIGHT_MIRROR_REACH)).add(slope.mul(0.5)), nodes)
    .mul(LIGHT_MIRROR)
    .mul(float(0.5).add(rippleEnergy.mul(4)))
    .mul(open);
  body = body.mul(float(1).sub(strength));

  const drift: ShaderNode = vec2(time.mul(BEACH_NOISE.driftX), time.mul(BEACH_NOISE.driftZ));
  const lace: ShaderNode = texture(tex.noise, xz.mul(BEACH_NOISE.laceScale).add(drift)).g;
  const fine: ShaderNode = texture(tex.noise, xz.mul(BEACH_NOISE.laceScale).sub(drift)).b;
  const gaps: ShaderNode = smoothstep(BED_FOAM.laceLow, BED_FOAM.laceHigh, lace);
  const bubbles: ShaderNode = smoothstep(BED_FOAM.bubbleLow, BED_FOAM.bubbleHigh, fine);
  const line: ShaderNode = smoothstep(BED_FOAM.frontWidth, 0, abs(shore.sub(front)))
    .mul(gaps)
    .mul(mix(bubbles.mul(BED_FOAM.waterOpacity), float(BED_FOAM.frontOpacity), advancing))
    .mul(mix(float(0.45), float(1), bubbles));
  // Fading bubbles occupy the drained strip, not a second stationary outline at maximum run-up.
  const drainage: ShaderNode = smoothstep(-BED_SWASH.runup, -BED_SWASH.runup + BED_SWASH.feather, shore)
    .mul(smoothstep(front, front.sub(BED_FOAM.frontWidth), shore))
    .mul(float(1).sub(rise))
    .mul(float(1).sub(advancing))
    .mul(gaps)
    .mul(bubbles)
    .mul(BED_FOAM.waterOpacity);
  const roll: ShaderNode = fract(cycle.div(Math.PI * 2).add(0.35));
  const breakerAt: ShaderNode = mix(float(BED_FOAM.breakerFar), float(0), roll);
  // With a painted lace tile (the approved target's surf): breakers are thin wavy lines whose distance from the bank
  // wobbles along the shore (not contour lines parallel to it), broken by the lace into long strokes, and a sparse
  // fine lace drifts between them.
  const laceTile: ShaderNode | null = tile ? tile.lace : null;
  const wobble: ShaderNode | number = laceTile
    ? texture(tex.noise, xz.mul(BED_FOAM.wobbleScale).add(drift)).r.sub(0.5).mul(BED_FOAM.wobble)
    : 0;
  const wavyShore: ShaderNode = laceTile ? shore.add(wobble) : shore;
  const breakerWidth: number = laceTile ? BED_FOAM.wavyBreakerWidth : BED_FOAM.breakerWidth;
  const breakerLace: ShaderNode = laceTile ? smoothstep(0.12, 0.3, laceTile) : gaps;
  const breaker: ShaderNode = smoothstep(breakerWidth, 0, abs(wavyShore.sub(breakerAt)))
    .mul(smoothstep(0, 0.2, roll))
    .mul(smoothstep(1, 0.7, roll))
    .mul(breakerLace)
    .mul(laceTile ? BED_FOAM.wavyBreakerOpacity : BED_FOAM.waterOpacity);
  // A second breaker half a cycle behind the first, so the surf band always holds two rolling lines.
  const roll2: ShaderNode = fract(roll.add(0.5));
  const breaker2: ShaderNode = smoothstep(
    breakerWidth,
    0,
    abs(wavyShore.sub(mix(float(BED_FOAM.breakerFar), 0, roll2))),
  )
    .mul(smoothstep(0, 0.2, roll2))
    .mul(smoothstep(1, 0.7, roll2))
    .mul(laceTile ? smoothstep(0.18, 0.4, laceTile) : smoothstep(0.3, 0.5, lace))
    .mul(laceTile ? BED_FOAM.wavyBreakerOpacity : BED_FOAM.laceOpacity);
  // Surf lace: sparse fine lace thinning out offshore (its threshold rises with the distance).
  const surfLace: ShaderNode = (
    laceTile
      ? smoothstep(
          mix(float(0.5), float(0.85), smoothstep(0, BED_FOAM.breakerFar, shore)),
          mix(float(0.7), float(0.97), smoothstep(0, BED_FOAM.breakerFar, shore)),
          laceTile,
        ).mul(BED_FOAM.wavyLaceOpacity)
      : bubbles.mul(gaps).mul(BED_FOAM.laceOpacity)
  )
    .mul(smoothstep(0, BED_SWASH.retreat, shore))
    .mul(smoothstep(BED_FOAM.breakerFar, 0.1, shore));
  let foam: ShaderNode = line
    .mul(laceTile ? mix(float(0.75), float(1), smoothstep(0.15, 0.45, laceTile)) : 1)
    .max(drainage)
    .max(breaker)
    .max(breaker2)
    .max(surfLace)
    .mul(surf);
  if (inputs.cliff) {
    // Cliff foot: the swell laps against the wall in a broken foam band whose width breathes, a fainter backwash line
    // runs out from the wall, and the water right at the wall is darker (the wall's shade and wet contact). Replaces
    // the hard straight seam where the wall geometry meets the water plane.
    const wall: ShaderNode = inputs.cliff.mul(CLIFF_FIELD_MAX);
    const phase: ShaderNode = time.mul(1.25).add(along.mul(12));
    const lapWidth: ShaderNode = sin(phase).mul(0.5).add(0.5).mul(CLIFF_FOAM.lap).add(CLIFF_FOAM.base);
    // The wall's foot is a straight geometric edge: jitter the band's reach along it and break it with the lace tile.
    const reach: ShaderNode = laceTile ? lapWidth.mul(mix(float(0.45), float(1.6), laceTile)) : lapWidth;
    const lapFoam: ShaderNode = smoothstep(reach, reach.mul(0.35), wall)
      .mul(laceTile ? smoothstep(0.3, 0.6, laceTile) : smoothstep(0.25, 0.5, lace))
      .mul(mix(float(0.55), float(1), bubbles))
      .mul(CLIFF_FOAM.opacity);
    const backAt: ShaderNode = fract(time.mul(0.18).add(along.mul(3)))
      .mul(CLIFF_FOAM.backReach)
      .add(CLIFF_FOAM.base);
    const backwash: ShaderNode = smoothstep(0.025, 0, abs(wall.sub(backAt)))
      .mul(smoothstep(0.4, 0.62, lace))
      .mul(smoothstep(CLIFF_FOAM.backReach, 0, backAt))
      .mul(CLIFF_FOAM.backOpacity);
    foam = foam.max(lapFoam.max(backwash).mul(waterness));
    body = body.mul(mix(float(CLIFF_FOAM.contactShade), float(1), smoothstep(0, CLIFF_FOAM.contactReach, wall)));
  }
  let sparkle: ShaderNode = vec3(0);
  if (tile) {
    // Painted crest glints, brighter along the sun's glitter path and in gust patches; no grid glints or whitecaps.
    const T = WATER_SURFACE_TILE;
    const path: ShaderNode = pow(max(dot(r, uniforms.sunDirection), 0), T.glintPathPower)
      .mul(T.glintPath)
      .add(T.glintFloor);
    sparkle = uniforms.sunColor.mul(vec3(...T.glintTint)).mul(
      smoothstep(T.glintLow, T.glintHigh, tile.glint)
        .mul(tile.glint.mul(0.6).add(0.4))
        .mul(T.glintGain)
        .mul(path)
        // Clustered like the target's glitter: dense in gust patches and the repaint's rough areas, sparse elsewhere.
        .mul(mix(float(T.glintCalm), float(T.glintGust), gust))
        .mul(pow(max(rough, 0), T.glintRoughPower))
        .mul(open)
        .mul(float(1).sub(uniforms.rain))
        .mul(float(1).sub(night.mul(0.8))),
    );
  } else if (detail && crest) {
    const windiness: ShaderNode = float(0.6)
      .add(uniforms.wind.mul(1.2))
      .mul(mix(float(0.75), float(1.3), gust))
      .mul(rough);
    // Glints: one candidate per cell of a grid across / along the view (x - z, x + z), lit at random, drawn as a short
    // horizontal streak (the sun on a wave facet) and twinkling with its own phase; the cell jitter follows the slope.
    const glintUv: ShaderNode = vec2(xz.x.sub(xz.y), xz.x.add(xz.y).mul(0.5)).mul(WATER_SURFACE.sparkCells);
    const cell: ShaderNode = glintUv.floor();
    const seed: ShaderNode = texture(tex.noise, cell.add(0.5).div(WATER_TEXTURE_SIZE)).a;
    const seed2: ShaderNode = texture(tex.noise, cell.add(vec2(53.5, 117.5)).div(WATER_TEXTURE_SIZE)).a;
    const local: ShaderNode = glintUv
      .fract()
      .sub(vec2(seed, seed2).mul(0.5).add(0.25))
      .add(slope.mul(WATER_SURFACE.sparkJitter));
    const streak: ShaderNode = smoothstep(0.32, 0.06, vec2(local.x.mul(0.55), local.y.mul(1.7)).length());
    const twinkle: ShaderNode = pow(
      sin(time.mul(2.3).add(seed2.mul(40)))
        .mul(0.5)
        .add(0.5),
      3,
    );
    const glint: ShaderNode = smoothstep(WATER_SURFACE.sparkThreshold, 1, seed).mul(streak).mul(twinkle);
    // Whitecaps break into specks: only the hash's brighter points of a high crest turn white.
    const capHash: ShaderNode = texture(tex.noise, xz.mul(WATER_SURFACE.sparkScale * 1.7).sub(slope)).a;
    const whitecap: ShaderNode = smoothstep(WATER_SURFACE.capLow, WATER_SURFACE.capHigh, crest.mul(windiness))
      .mul(smoothstep(WATER_SURFACE.capBreakup, 1, capHash))
      .mul(WATER_SURFACE.capAmount)
      .mul(open);
    foam = foam.max(whitecap);
    const path: ShaderNode = pow(max(dot(r, uniforms.sunDirection), 0), WATER_SURFACE.sparkPathPower)
      .mul(WATER_SURFACE.sparkPath)
      .add(WATER_SURFACE.sparkBase);
    sparkle = uniforms.sunColor.mul(
      glint
        .mul(smoothstep(0.08, 0.3, crest.mul(windiness)))
        .mul(path)
        .mul(WATER_SURFACE.sparkGain)
        .mul(rough)
        .mul(open)
        .mul(float(1).sub(uniforms.rain))
        .mul(float(1).sub(night.mul(0.8))),
    );
  }
  const foamColour: ShaderNode = color(0xf2f6f5).mul(mix(float(1), float(0.5), night));
  const sandSheen: ShaderNode = sky.mul(wetness).mul(float(1).sub(open)).mul(BEACH_WET.sheen);
  const sheetSheen: ShaderNode = sky.mul(sheet).mul(filmFade).mul(BED_SWASH.sheen);
  // Mirrored cliffs, trees and units on water with a detail layer reflect at least OBJECT_REFLECT (the owner asked for
  // clearly readable reflections on every water level); the sky keeps the Fresnel strength.
  const reflectedLight: ShaderNode =
    detail && reflected && inputs.reflection
      ? mix(
          waterSky.mul(strength),
          reflected.mul(max(strength, open.mul(OBJECT_REFLECT))),
          inputs.reflection.coverage.mul(OBJECT_COVERAGE),
        )
      : mirrored.mul(strength);
  const emission: ShaderNode = reflectedLight
    .add(uniforms.sunColor.mul(glitter))
    .add(sparkle)
    .add(lights)
    .mul(waterness)
    .mul(reflectionLevel)
    .add(sandSheen)
    .add(sheetSheen)
    .mul(float(1).sub(foam));
  const roughness: ShaderNode = mix(mix(float(BEACH_WET.roughness), float(BED_SWASH.roughness), sheet), float(1), open);
  const gloss: ShaderNode = wetness.mul(float(1).sub(open)).mul(float(1).sub(foam));
  return {
    normal,
    body,
    emission,
    foam,
    foamColour,
    land,
    coverage,
    openWater: open.mul(waterness),
    wetness,
    roughness,
    gloss,
  };
}
