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
import {
  clamp,
  float,
  luminance,
  max,
  mix,
  mx_fractal_noise_float,
  smoothstep,
  texture,
  uniform,
  vec3,
} from 'three/tsl';
import type { AtmosphereProfile } from './contract';
import type { EmitterLayer } from './emitters';
import type { LightField } from './lightField';
import type { ShaderNode } from './tsl';

/** Shader inputs owned by one renderer/world. Legacy exports below remain for standalone material callers. */
export class AtmosphereNodes {
  private disposed = false;
  private readonly resources = new Set<{ dispose(): void }>();
  /** Materials and lookup textures created for this context share its lifetime. */
  own<T extends { dispose(): void }>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }
  readonly sceneLevel = uniform(new Color(1, 1, 1));
  readonly sceneBrightness = uniform(1);
  readonly night = uniform(0);
  readonly moonDesaturation = uniform(0);
  readonly windowGain = uniform(0);
  readonly rainAmount = uniform(0);
  readonly referenceLevel = uniform(1);
  private readonly black = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  private readonly noSurface = new DataTexture(new Uint8Array(2), 1, 1, RGFormat, UnsignedByteType);
  readonly lightFieldTexture = texture(this.black);
  readonly lightFieldSize = uniform(new Vector2(1, 1));
  readonly lightFieldScale = uniform(1);
  readonly surfaceTexture = texture(this.noSurface);
  readonly surfaceSize = uniform(new Vector2(1, 1));
  readonly moonNeutral = uniform(new Color(1, 1, 1));
  readonly faithfulDisplay = uniform(1);

  constructor() {
    this.black.needsUpdate = true;
    this.noSurface.needsUpdate = true;
  }

  /** Mirror a renderer's inputs into layers created before its world was known, without replacing their nodes. */
  copyValuesFrom(source: AtmosphereNodes): void {
    this.sceneLevel.value.copy(source.sceneLevel.value);
    this.sceneBrightness.value = source.sceneBrightness.value;
    this.night.value = source.night.value;
    this.moonDesaturation.value = source.moonDesaturation.value;
    this.windowGain.value = source.windowGain.value;
    this.rainAmount.value = source.rainAmount.value;
    this.referenceLevel.value = source.referenceLevel.value;
    this.lightFieldTexture.value = source.lightFieldTexture.value;
    this.lightFieldSize.value.copy(source.lightFieldSize.value);
    this.lightFieldScale.value = source.lightFieldScale.value;
    this.surfaceTexture.value = source.surfaceTexture.value;
    this.surfaceSize.value.copy(source.surfaceSize.value);
    this.moonNeutral.value.copy(source.moonNeutral.value);
    this.faithfulDisplay.value = source.faithfulDisplay.value;
  }

  /** Only the fallback textures belong here; worlds and light fields own the textures they bind. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.resources) resource.dispose();
    this.resources.clear();
    this.black.dispose();
    this.noSurface.dispose();
  }
}

/** Compatibility context for callers constructing standalone materials without a renderer. */
export const DEFAULT_ATMOSPHERE_NODES = new AtmosphereNodes();
export const {
  sceneLevel,
  sceneBrightness,
  night,
  moonDesaturation,
  windowGain,
  rainAmount,
  referenceLevel,
  lightFieldTexture,
  lightFieldSize,
  lightFieldScale,
  surfaceTexture,
  surfaceSize,
  moonNeutral,
} = DEFAULT_ATMOSPHERE_NODES;
/** Irradiance lamps and fires carry on objects, half-way between their colour and its luminance. */
export const OBJECT_TINT = 0.5;

/** 0..1 how paved (asphalt, concrete, brick) the ground is at a world xz. */
export function pavedAt(xz: ShaderNode, nodes = DEFAULT_ATMOSPHERE_NODES): ShaderNode {
  return texture(nodes.surfaceTexture, xz.div(nodes.surfaceSize)).r;
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

/** `colour` as the moonlit term sees it: pulled towards moonNeutral grey by moonDesaturation (a no-op by day). */
export function moonlit(colour: ShaderNode, nodes = DEFAULT_ATMOSPHERE_NODES): ShaderNode {
  const l: ShaderNode = luminance(colour);
  return mix(colour, (nodes.moonNeutral as ShaderNode).mul(l), nodes.moonDesaturation);
}

/** Local light irradiance at a ground point (world xz), linear RGB. */
export function sampleLightField(xz: ShaderNode, nodes = DEFAULT_ATMOSPHERE_NODES): ShaderNode {
  return texture(nodes.lightFieldTexture, xz.div(nodes.lightFieldSize)).rgb.mul(nodes.lightFieldScale);
}

/**
 * Local light as objects take it: the engine lights objects without the tint of light sources, so art keeps half of
 * the light's colour (OBJECT_TINT) and gets the rest as neutral brightness.
 */
export function objectLight(xz: ShaderNode, nodes = DEFAULT_ATMOSPHERE_NODES): ShaderNode {
  const lf: ShaderNode = sampleLightField(xz, nodes);
  const l: ShaderNode = luminance(lf);
  return mix(vec3(l, l, l), lf, float(OBJECT_TINT));
}

/**
 * Share of a neighbour's ground-only light (a Tesla reactor's blue pool) that upright building art takes inside its
 * own foundation. The pool is ground light; at full strength two adjacent reactors (a common base layout) washed each
 * other's facades and orbs lavender-white and bloomed into a veil over the base in live matches (L5 compose, frozen
 * pairs), while a lone reactor looked right. Neighbours keep a clear blue tint at this share.
 */
export const NEIGHBOUR_GROUND_SHARE = 0.3;

/**
 * objectLight for sprite art. `building` (0 or 1) marks upright building art: it takes the ground-only share of the
 * field (SourceSpec.groundOnly, carried in the field's alpha as luminance) at `own`, a point inside its own foundation,
 * instead of at `xz`, the ground in front of the art that its pixels otherwise sample. A building's own source has a
 * hole over that foundation, so its facades and the reactor's orb glass stay unwashed, while a neighbouring building
 * inside the pool still takes part of the light (NEIGHBOUR_GROUND_SHARE). Without a ground-only share (alpha 0) this
 * equals objectLight(xz) exactly.
 */
export function objectLightAt(
  xz: ShaderNode,
  own: ShaderNode,
  building: ShaderNode,
  nodes = DEFAULT_ATMOSPHERE_NODES,
): ShaderNode {
  const share = (sample: ShaderNode, rgb: ShaderNode): ShaderNode =>
    clamp(sample.a.mul(nodes.lightFieldScale).div(max(luminance(rgb), 1e-4)), 0, 1).mul(building);
  const front: ShaderNode = texture(nodes.lightFieldTexture, xz.div(nodes.lightFieldSize));
  const inside: ShaderNode = texture(nodes.lightFieldTexture, own.div(nodes.lightFieldSize));
  const frontRgb: ShaderNode = front.rgb.mul(nodes.lightFieldScale);
  const insideRgb: ShaderNode = inside.rgb.mul(nodes.lightFieldScale);
  const lf: ShaderNode = frontRgb
    .mul(float(1).sub(share(front, frontRgb)))
    .add(insideRgb.mul(share(inside, insideRgb)).mul(NEIGHBOUR_GROUND_SHARE));
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
  nodes?: AtmosphereNodes;
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
