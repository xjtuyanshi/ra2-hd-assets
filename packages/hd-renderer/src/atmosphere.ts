import {
  Color,
  DataTexture,
  FloatType,
  RGBAFormat,
  RGFormat,
  type Scene,
  UnsignedByteType,
  Vector2,
  type Vector3,
} from 'three/webgpu';
import { float, luminance, mix, mx_fractal_noise_float, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import type { AtmosphereProfile } from './contract';
import type { EmitterLayer } from './emitters';
import type { LightField } from './lightField';
import type { ShaderNode } from './tsl';

/**
 * Scene-wide atmosphere inputs shared by every material (terrain, sprites, voxels, rain, smoke, mist). Like voxelFill,
 * these are module singletons: one HdRenderer per page drives them each frame.
 */

/** Flat-ground irradiance of the sun and sky relative to clear noon, per channel (1 = the original's daylight). */
export const sceneLevel = uniform(new Color(1, 1, 1));
/** Luminance of sceneLevel relative to clear noon (1 at clear noon exactly): unlit effects (smoke, rain) scale by it. */
export const sceneBrightness = uniform(1);
/** 0 = day, 1 = night. */
export const night = uniform(0);
/**
 * Desaturation of the moonlit (sun and sky) term at night, 0 by day: concept C keeps the unlit city a muted blue-grey
 * so lamps, windows and fires stand out as the saturated accents. Materials apply it to the albedo that meets the sun
 * and sky only (moonlit()); local lights (the light field), lit windows and fires keep full colour.
 */
export const moonDesaturation = uniform(0);
/** Lit-window strength: smoothstep(0.25, 0.85, night) while windows are enabled, else 0. */
export const windowGain = uniform(0);
/** 0..1 rain intensity. */
export const rainAmount = uniform(0);
/** Flat-ground noon irradiance (the exposure reference): light-field values divided by it are relative to noon. */
export const referenceLevel = uniform(1);

const black = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
black.needsUpdate = true;
/**
 * The light field: every local light (map light sources, lamps, explosions, fires) as irradiance on the ground, one
 * whole-map texture addressed by world x/z. The renderer swaps its value for the LightField render target; the default
 * is black, so every consumer adds exactly nothing until a light field exists.
 */
export const lightFieldTexture = texture(black);
/** World extent (x, z) the light field covers. */
export const lightFieldSize = uniform(new Vector2(1, 1));
/** Encoding scale (1 for float targets; 8 when an 8-bit target stores irradiance / 8). */
export const lightFieldScale = uniform(1);
/** Irradiance lamps and fires carry on objects, half-way between their colour and its luminance. */
export const OBJECT_TINT = 0.5;

const noSurface = new DataTexture(new Uint8Array(2), 1, 1, RGFormat, UnsignedByteType);
noSurface.needsUpdate = true;
/**
 * Per-cell surface texture (R: paved 0..1, linear-filtered; G: open water), addressed by world x/z like the light
 * field. Default: nothing paved, so wet sheen, puddles and reflection streaks stay off without a map.
 */
export const surfaceTexture = texture(noSurface);
export const surfaceSize = uniform(new Vector2(1, 1));

/** 0..1 how paved (asphalt, concrete, brick) the ground is at a world xz. */
export function pavedAt(xz: ShaderNode): ShaderNode {
  return texture(surfaceTexture, xz.div(surfaceSize)).r;
}

/** Puddle mask 0..1 on wet paved ground (the same noise the terrain uses, so streaks brighten over puddles). */
export function puddleNoise(position: ShaderNode): ShaderNode {
  return smoothstep(0.62, 0.68, mx_fractal_noise_float(position.mul(0.55), 2, 2, 0.5, 1).mul(0.5).add(0.5));
}

/**
 * Grey that the current sun and sky light turns neutral: luminance(sceneLevel) / sceneLevel per channel, set each frame
 * by the renderer. Desaturating towards plain grey let the blue night sky take over the grey share (yellow-green grass
 * turned teal); towards this grey the desaturated share is lit neutral and the night keeps its hues, only muted.
 */
export const moonNeutral = uniform(new Color(1, 1, 1));

/** `colour` as the moonlit term sees it: pulled towards moonNeutral grey by moonDesaturation (a no-op by day). */
export function moonlit(colour: ShaderNode): ShaderNode {
  const l: ShaderNode = luminance(colour);
  return mix(colour, (moonNeutral as ShaderNode).mul(l), moonDesaturation);
}

/** Local light irradiance at a ground point (world xz), linear RGB. */
export function sampleLightField(xz: ShaderNode): ShaderNode {
  return texture(lightFieldTexture, xz.div(lightFieldSize)).rgb.mul(lightFieldScale);
}

/**
 * Local light as objects take it: the engine lights objects without the tint of light sources, so art keeps half of
 * the light's colour (OBJECT_TINT) and gets the rest as neutral brightness.
 */
export function objectLight(xz: ShaderNode): ShaderNode {
  const lf: ShaderNode = sampleLightField(xz);
  const l: ShaderNode = luminance(lf);
  return mix(vec3(l, l, l), lf, float(OBJECT_TINT));
}

/** Presentation settings of the atmosphere (sandbox parameters, live view environment). */
export interface AtmosphereSettings {
  /** Map light sources (the engine's LightSource washes) at night. */
  lights: boolean;
  /** HD street lamps: 'auto' = city theaters only. */
  lamps: 'auto' | 'on' | 'off';
  /** Lit windows at night. */
  windows: boolean;
  /** Mist multiplier (1 = default amount). */
  mist: number;
  /** Override of the profile's night level (unlit ground at night relative to noon). */
  nightLevel?: number;
}

export const DEFAULT_ATMOSPHERE_SETTINGS: AtmosphereSettings = { lights: true, lamps: 'auto', windows: true, mist: 1 };

/** Profile used when a map carries none (and for maps whose own [Lighting] reads as day). */
export const DEFAULT_ATMOSPHERE: AtmosphereProfile = { kind: 'day', hour: 12, nightLevel: 0.3, tint: [1, 1, 1] };

/** What a world's night dressing gets once the renderer is ready. */
export interface AtmosphereContext {
  scene: Scene;
  lightField: LightField;
  emitters: EmitterLayer;
  /** Flat-ground noon irradiance. */
  reference: number;
}

/** Per-frame state handed to a world's dressing. */
export interface FrameAtmosphere {
  now: number;
  night: number;
  rain: number;
  wet: number;
  profile: AtmosphereProfile;
  settings: AtmosphereSettings;
  /** Camera basis for camera-facing art. */
  cameraRight: Vector3;
  cameraUp: Vector3;
  toCamera: Vector3;
}

/** Game-specific night dressing a world may carry (map light sources, street lamps, windows). */
export interface WorldDressing {
  attach(context: AtmosphereContext): void;
  update(frame: FrameAtmosphere): void;
  stats(): Record<string, number>;
}
