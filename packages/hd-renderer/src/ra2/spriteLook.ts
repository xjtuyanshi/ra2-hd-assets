import { Color, Texture, Vector3, Vector4, type Object3D } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  luminance,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, type AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { clearLightAt, Lighting } from '../lighting';

/**
 * Modern light on original building and tree art (opt-in; every strength 0 by default, which leaves the sprites exactly
 * as the faithful renderer draws them).
 *
 * The art keeps its own baked shading. A per-pixel material atlas (packages/ra2-assets python/sprite_normals.py: world
 * normal, specular class, baked occlusion, aligned with the HD sprite atlas) lets the renderer apply the HD sun as a
 * DELTA on that shading: each pixel is scaled by (light the current sun and sky give its normal, relative to flat
 * ground) / (the same under the art's own light, ART_LIGHT with the reference sky share). Under the art's own light the
 * factor is exactly 1; a morning sun from the right swaps the brightness of left- and right-hand walls, overcast skies
 * flatten both. Specular highlights (GGX), a sky reflection on glass and ambient occlusion come on top; shadows of the
 * art can follow the sun (SpriteLayer), and wet paving can mirror buildings in rain.
 */

/** Elevation (degrees) of the light baked into RA2's building and tree art, measured from the SHP shadow frames. */
export const ART_LIGHT_ELEVATION = 38;
/**
 * World direction towards the art's light: from +z (screen lower-left), where the SHP shadows point away from (tree
 * crowns land about 1.1 cells towards -z, 36 px right and 16 px up on screen, at about 38 degrees).
 */
export const ART_LIGHT = new Vector3(
  0,
  Math.sin((ART_LIGHT_ELEVATION * Math.PI) / 180),
  Math.cos((ART_LIGHT_ELEVATION * Math.PI) / 180),
);
/**
 * Sky share of the art's own light (sky irradiance on flat ground per unit of sun irradiance): about 2.6 reproduces
 * the art's contrast between lit (+z) and unlit (+x) walls of the same material (about 1.6 : 1 on the urban blocks)
 * with a wall seeing half the sky. The current sky share scales with the scene's sky-to-sun ratio relative to the
 * reference hour, so overcast light flattens the walls further.
 */
export const ART_SKY_SHARE = 2.6;
/** Hour whose sun and sky the art's baked light stands for (the sun arc passes ART_LIGHT's azimuth at 15:00). */
export const ART_REFERENCE_HOUR = 15;

/** Relight factors are clamped to this range so no face turns black or blows out. */
const FACTOR_RANGE = [0.3, 2.4] as const;

/** The sun gain may lift faces above the original relight ceiling, but never lowers that ceiling. */
export function relightFactorUpper(sunGain: number): number {
  return FACTOR_RANGE[1] * Math.max(1, sunGain);
}

/** Maximum sun-following stretch at neutral shadowLength, relative to the art's own shadow (readability). */
export const MAX_SHADOW_STRETCH = 2;

/** Wet paving reflects a faint image; even stacked look gains must not turn it into a second building. */
export const WET_REFLECTION_MAX_OPACITY = 0.25;

/** Sun-elevation stretch with the original floor/cap; shadowLength scales both the result and its cap. */
export function shadowStretch(keyElevation: number, shadowLength = 1): number {
  const elevation = (Math.max(12, keyElevation) * Math.PI) / 180;
  const stretch = Math.min(
    MAX_SHADOW_STRETCH,
    Math.max(0.75, Math.tan((ART_LIGHT_ELEVATION * Math.PI) / 180) / Math.tan(elevation)),
  );
  return shadowLength === 1 ? stretch : stretch * shadowLength;
}

/** Per-renderer uniforms of the enhanced sprite look (see spriteLookFor). HdRenderer sets them every frame. */
export class SpriteLookState {
  /** 0 = faithful (the enhanced branch is skipped entirely), 1 = on. */
  readonly enabled = uniform(0);
  /** Weight of the relighting factor (0 = baked shading only; values above 1 exaggerate it). */
  readonly relight = uniform(0);
  /** Self-lit crystals use the selected HD gains under clear noon, including on authored dusk/night maps. */
  readonly unlitRelight = uniform(0);
  readonly unlitBaseLight = uniform(new Color(1, 1, 1));
  readonly unlitSunDirection = uniform(new Vector3());
  readonly unlitSunWeight = uniform(new Color());
  readonly unlitSkyWeight = uniform(new Color());
  readonly unlitSunLight = uniform(new Color());
  readonly unlitSkyLight = uniform(new Color());
  /**
   * Gain of the procedural star twinkle on ground crystals (crystalSparkle), an HD addition. A live view that draws
   * the engine's own ore glints (ra2/cellGlints.ts) turns it down so the two do not double up.
   */
  readonly crystalSparkle = uniform(1);
  /** Sun highlights on facades and roofs (and the sheen of wet surfaces). */
  readonly specular = uniform(0);
  /** Window glass: sky reflection and sun glints on the panes of the material atlas (0 = the art's own panes). */
  readonly glass = uniform(0);
  /** Baked occlusion of the material atlas and ground contact decals. */
  readonly occlusion = uniform(0);
  readonly sunGain = uniform(1);
  readonly factorUpper = uniform(FACTOR_RANGE[1]);
  readonly specularSize = uniform(1);
  readonly aoPower = uniform(1);
  readonly contactShade = uniform(1);
  /** CPU-side stretch input; the resulting SHP transform is uploaded through shadowMatrix. */
  readonly shadowLength = uniform(1);
  readonly shadowDarkness = uniform(1);
  /** Opacity of the infantry footprint's core (HdSettings.infantryShadow): 1 = the original's solid black. */
  readonly infantryShadow = uniform(1);
  /** SHP shadow decals follow the sun: 0 = the art's own shadows, 1 = fully turned and stretched. */
  readonly shadowFollow = uniform(0);
  /** Penumbra growth of those shadows with distance from their object (0 = the art's crisp shadow). */
  readonly shadowSoftness = uniform(0);
  /** Mirror images of buildings on wet paving (0 = none). */
  readonly reflections = uniform(0);
  /** Ground wetness 0..1 (the terrain's), for the reflections and wet highlights. */
  readonly wetness = uniform(0);
  /** World direction towards the sun used for the sprites (ART_LIGHT in the faithful sun path). */
  readonly sunDirection = uniform(ART_LIGHT.clone());
  /** Sun and sky weights per channel, in the art's calibration (see ART_SKY_SHARE); reference values below. */
  readonly sunWeight = uniform(new Color(1, 1, 1));
  readonly skyWeight = uniform(new Color(ART_SKY_SHARE, ART_SKY_SHARE, ART_SKY_SHARE));
  readonly artSunWeight = uniform(new Color(1, 1, 1));
  readonly artSkyWeight = uniform(new Color(ART_SKY_SHARE, ART_SKY_SHARE, ART_SKY_SHARE));
  /** Sun irradiance (perpendicular) in the sprites' output scale: highlights are sunLight x BRDF x cos. */
  readonly sunLight = uniform(new Color(0, 0, 0));
  /** Sky radiance in the sprites' output scale, and the sky's horizon and zenith colours (glass reflections). */
  readonly skyLight = uniform(new Color(0, 0, 0));
  readonly skyHorizon = uniform(new Color(0.7, 0.8, 0.92));
  readonly skyZenith = uniform(new Color(0.2, 0.42, 0.82));
  /**
   * Ground transform of SHP shadows (column-major 2x2 on world x/z, applied about the object's base): rotation from the
   * art's shadow direction to the current one, times a stretch along the art's direction.
   */
  readonly shadowMatrix = uniform(new Vector4(1, 0, 0, 1));
  /**
   * CPU side: the ground passes of every sprite layer on this context (SpriteLayer.groundPasses). HdRenderer shows them
   * only while the look is on, so the faithful frame stays a single pass.
   */
  readonly groundPasses = new Set<Object3D>();
}

interface UnlitSpriteSettings {
  relight: number;
  sunGain: number;
  lightContrast: number;
  sunPath: 'fixed' | 'arc';
}

/** Fixed noon light, expressed after the reference white balance (palette colour is already display-linear). */
function noonCrystalReference(arc: boolean) {
  const light = new Lighting(2, 2);
  light.update(12, 0);
  const irradiance = light.flatIrradianceColor(new Color());
  light.sunArc = arc;
  light.update(12, 0);
  const flat = light.flatIrradianceColor(new Color());
  const sun = light.sun.color.clone().multiplyScalar(light.sun.intensity);
  const sky = light.hemi.color.clone().multiplyScalar(light.hemi.intensity);
  const direction = light.state.sunDirection.clone();
  // Fixed-path sprites use the baked azimuth at the directional light's elevation, just as updateSpriteLook does.
  if (!arc) direction.set(0, direction.y, Math.sqrt(Math.max(0, 1 - direction.y * direction.y)));
  const exposure = new Color(Math.PI / irradiance.r, Math.PI / irradiance.g, Math.PI / irradiance.b);
  return {
    sun,
    sky,
    direction,
    baseLight: new Color(flat.r / irradiance.r, flat.g / irradiance.g, flat.b / irradiance.b),
    sunLight: sun.clone().multiply(exposure),
    skyLight: sky
      .clone()
      .multiply(exposure)
      .multiplyScalar(1 / Math.PI),
  };
}
const NOON_CRYSTAL_REFERENCE = { fixed: noonCrystalReference(false), arc: noonCrystalReference(true) };
const CRYSTAL_ART_REFERENCE = clearLightAt(ART_REFERENCE_HOUR);
const crystalLuminance = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Only explicit look settings enter this update; hour, weather, map tint and scene events have no input path. */
export function updateUnlitSpriteLook(state: SpriteLookState, settings: UnlitSpriteSettings): void {
  const noon = NOON_CRYSTAL_REFERENCE[settings.sunPath];
  state.unlitRelight.value = settings.relight;
  state.unlitBaseLight.value.copy(noon.baseLight);
  state.unlitSunDirection.value.copy(noon.direction);
  state.unlitSunWeight.value
    .copy(noon.sun)
    .multiplyScalar(settings.sunGain / crystalLuminance(CRYSTAL_ART_REFERENCE.sun));
  state.unlitSkyWeight.value
    .copy(noon.sky)
    .multiplyScalar(
      ART_SKY_SHARE / crystalLuminance(CRYSTAL_ART_REFERENCE.sky) / Math.max(0.2, settings.lightContrast),
    );
  state.unlitSunLight.value.copy(noon.sunLight);
  state.unlitSkyLight.value.copy(noon.skyLight);
}

const states = new WeakMap<AtmosphereNodes, SpriteLookState>();

/** The sprite look uniforms of a renderer's shader context (shared by all its sprite layers). */
export function spriteLookFor(nodes: AtmosphereNodes = DEFAULT_ATMOSPHERE_NODES): SpriteLookState {
  let state = states.get(nodes);
  if (!state) {
    state = new SpriteLookState();
    states.set(nodes, state);
  }
  return state;
}

/** The loaded material atlas (sprites@2x-normals.png) for a sprite atlas, or null. */
export interface SpriteMaterialAtlas {
  texture: Texture;
}

/** Decoded texel of the material atlas: world normal, specular class, occlusion and whether the texel has data. */
export interface MaterialTexel {
  normal: ShaderNode;
  spec: ShaderNode;
  ao: ShaderNode;
  has: ShaderNode;
}

/**
 * R/G encode world normal x/z in 0..1; alpha stores AO in 0.3..1 (0 means no data).
 * Upright art uses B as its specular class. Ground-crystal decals instead encode dielectric gloss as 2B when
 * B < 0.5, or metal gloss as 2(B - 0.5) otherwise. Gloss 0..1 maps to roughness 0.72..0.09.
 */
export function sampleMaterial(atlas: SpriteMaterialAtlas, uv: ShaderNode): MaterialTexel {
  const t: ShaderNode = texture(atlas.texture, uv);
  const x: ShaderNode = t.r.mul(2).sub(1);
  const z: ShaderNode = t.g.mul(2).sub(1);
  const y: ShaderNode = sqrt(max(float(1).sub(x.mul(x)).sub(z.mul(z)), 0));
  return {
    normal: normalize(vec3(x, y, z)),
    spec: t.b,
    // Alpha 0 = no data; data texels store occlusion in 0.3 .. 1.
    ao: clamp(t.a.sub(0.3).div(0.7), 0, 1).mul(0.7).add(0.3),
    has: smoothstep(0.12, 0.26, t.a),
  };
}

/** Material lookup at a colour-atlas (HD) pixel position of the same layer. */
export type CrystalMaterialAt = (pixel: ShaderNode) => MaterialTexel;

/** Ground-crystal colour, excluding glow/alpha. Call only for layers with a material atlas. */
export function groundCrystalColour(
  lit: ShaderNode,
  m: MaterialTexel,
  crystal: ShaderNode,
  pixel: ShaderNode,
  view: ShaderNode,
  state: SpriteLookState,
  seed: ShaderNode = vec2(0, 0),
  materialAt?: CrystalMaterialAt,
  unlit: ShaderNode = float(0),
): ShaderNode {
  const sunDirection: ShaderNode = mix(state.sunDirection, state.unlitSunDirection, unlit);
  const sunLight: ShaderNode = mix(state.sunLight, state.unlitSunLight, unlit);
  const skyLight: ShaderNode = mix(state.skyLight, state.unlitSkyLight, unlit);
  const relight: ShaderNode = mix(state.relight, state.unlitRelight, unlit);
  const reference = {
    sunDirection,
    sunWeight: mix(state.sunWeight, state.unlitSunWeight, unlit),
    skyWeight: mix(state.skyWeight, state.unlitSkyWeight, unlit),
    artSunWeight: state.artSunWeight,
    artSkyWeight: state.artSkyWeight,
    factorUpper: state.factorUpper,
  };
  const metal: ShaderNode = step(0.5, m.spec).toVar();
  const gloss: ShaderNode = crystalGloss(m.spec).toVar();
  const roughness: ShaderNode = mix(float(0.72), float(0.09), gloss);
  const hue: ShaderNode = lit
    .div(max(luminance(lit), 1e-3))
    .clamp(0, 1.6)
    .toVar();
  const tint: ShaderNode = mix(vec3(1), hue, metal.mul(0.7)).toVar();
  const ao: ShaderNode = mix(float(1), m.ao, state.occlusion.mul(crystal));
  const base: ShaderNode = lit.mul(mix(vec3(1), relightFactor(m.normal, reference), relight.mul(crystal))).mul(ao);
  // Bound the entire tinted highlight, including user strength, to prevent glossy facets producing fireflies.
  const highlight: ShaderNode = min(
    sunHighlight(m.normal, sunDirection, view, roughness, mix(float(0.06), float(0.55), metal))
      .mul(sunLight)
      .mul(state.specular)
      .mul(crystal)
      .mul(m.ao)
      .mul(tint),
    sunLight.mul(1.6),
  );
  if (!materialAt) return base.add(highlight);
  // Self-lit crystals retain the noon sparkle; ordinary decorative crystals follow the current sun.
  const sparkleLight: ShaderNode = sunLight.add(skyLight.mul(0.12));
  const twinkle: ShaderNode = crystalSparkle(pixel, seed, materialAt, view, sunDirection);
  const sparkle: ShaderNode = vec3(1, 0.97, 0.88)
    .mul(twinkle)
    .mul(2.4)
    .mul(state.specular)
    .mul(state.crystalSparkle)
    .mul(crystal)
    .mul(sparkleLight);
  return base.add(highlight).add(sparkle);
}

/** Dielectric gloss is 2B below B = 0.5, metal gloss 2(B - 0.5) above it (see sampleMaterial). */
function crystalGloss(spec: ShaderNode): ShaderNode {
  return clamp(spec.sub(step(0.5, spec).mul(0.5)).mul(2), 0, 1);
}

/** Twinkle grid pitch in colour-atlas pixels; a star stays inside its own grid cell. */
const SPARKLE_PITCH = 10;

/**
 * Sparse star twinkles; TSL time follows the renderer clock, including frozen sandbox captures.
 * Each SPARKLE_PITCH grid cell of the art may hold one star at a jittered centre. Whether it can flash depends on the
 * material at that centre (glossy facet whose mirror direction meets the camera), so the core and its four arms appear
 * together even where an arm crosses soil. `seed` (the instance's ground anchor) decorrelates cells sharing one atlas
 * frame, so a field of identical frames never twinkles in sync; the star layout stays tied to the art.
 */
function crystalSparkle(
  pixel: ShaderNode,
  seed: ShaderNode,
  materialAt: CrystalMaterialAt,
  view: ShaderNode,
  sun: ShaderNode,
): ShaderNode {
  const cell: ShaderNode = floor(pixel.div(SPARKLE_PITCH)).toVar();
  const art = (x: number, y: number): ShaderNode => fract(sin(dot(cell, vec2(x, y))).mul(43758.5));
  const salted: ShaderNode = cell.add(fract(seed.mul(vec2(0.1031, 0.1137))).mul(997)).toVar();
  const hash = (x: number, y: number): ShaderNode => fract(sin(dot(salted, vec2(x, y))).mul(43758.5));
  const centre: ShaderNode = cell
    .add(vec2(art(12.9, 78.2), art(39.3, 11.1)).mul(0.24).add(0.38))
    .mul(SPARKLE_PITCH)
    .toVar();
  const at = materialAt(centre);
  const phase = hash(127.1, 311.7).toVar();
  const rate = mix(float(0.25), float(0.7), hash(269.5, 183.3));
  const flash = pow(
    max(
      sin(
        time
          .mul(rate)
          .add(phase)
          .mul(2 * Math.PI),
      ),
      0,
    ),
    12,
  );
  const local: ShaderNode = pixel.add(0.5).sub(centre).toVar();
  const core = exp(dot(local, local).mul(-1 / (2 * 0.8 ** 2)));
  const reach = SPARKLE_PITCH * 0.36;
  const arms = exp(local.x.mul(local.x).mul(-1 / (2 * 0.32 ** 2)))
    .mul(max(float(1).sub(abs(local.y).div(reach)), 0))
    .add(exp(local.y.mul(local.y).mul(-1 / (2 * 0.32 ** 2))).mul(max(float(1).sub(abs(local.x).div(reach)), 0)));
  // Two independent tilts in x/z let nearby facets catch slightly different sun angles.
  const tilted = normalize(at.normal.add(vec3(hash(419.2, 371.9).sub(0.5), 0, hash(157.7, 113.1).sub(0.5)).mul(0.6)));
  const facing = smoothstep(0.5, 0.92, dot(reflect(sun.negate(), tilted), view));
  return core
    .add(arms.mul(0.6))
    .mul(flash)
    .mul(step(0.45, hash(39.3, 47.1)))
    .mul(smoothstep(0.5, 0.8, crystalGloss(at.spec)))
    .mul(at.has)
    .mul(facing);
}

/** Irradiance of a surface with normal n relative to flat ground (a wall sees half the sky), per channel. */
function relativeIrradiance(n: ShaderNode, l: ShaderNode, sun: ShaderNode, sky: ShaderNode): ShaderNode {
  const skyView: ShaderNode = n.y.mul(0.5).add(0.5);
  const direct: ShaderNode = max(dot(n, l), 0);
  const flat: ShaderNode = sky.add(sun.mul(max(l.y, 0.05)));
  return sky.mul(skyView).add(sun.mul(direct)).div(flat);
}

/** Relighting factor per channel for normal n: current light over the art's own, both relative to flat ground. */
export function relightFactor(
  n: ShaderNode,
  state: Record<
    'sunDirection' | 'sunWeight' | 'skyWeight' | 'artSunWeight' | 'artSkyWeight' | 'factorUpper',
    ShaderNode
  >,
): ShaderNode {
  const now: ShaderNode = relativeIrradiance(n, state.sunDirection, state.sunWeight, state.skyWeight);
  const art: ShaderNode = relativeIrradiance(
    n,
    vec3(ART_LIGHT.x, ART_LIGHT.y, ART_LIGHT.z),
    state.artSunWeight,
    state.artSkyWeight,
  );
  return clamp(now.div(max(art, 1e-3)), FACTOR_RANGE[0], state.factorUpper);
}

/** Preserve the original value at power 1; an explicit variable avoids TSL select's shared-expression branches. */
export function poweredOcclusion(ao: ShaderNode, power: ShaderNode): ShaderNode {
  return Fn(() => {
    const value: ShaderNode = ao.toVar();
    If(power.notEqual(1), () => value.assign(pow(value, power)));
    return value;
  })();
}

/** Broaden a GGX lobe without clamping or recomputing its original roughness at size 1. */
export function highlightRoughness(roughness: ShaderNode, size: ShaderNode): ShaderNode {
  return Fn(() => {
    const value: ShaderNode = roughness.toVar();
    If(size.notEqual(1), () => value.assign(min(value.mul(size), 0.9)));
    return value;
  })();
}

/** Width of a power lobe, preserving its literal exponent at neutral width. */
export function highlightExponent(exponent: number, width: ShaderNode): ShaderNode {
  return Fn(() => {
    const value: ShaderNode = float(exponent).toVar();
    If(width.notEqual(1), () => value.assign(float(exponent).div(max(width, 1e-6))));
    return value;
  })();
}

/** Roughness of a specular class (glass 1 -> 0.12, facade -> 0.62), glossier when wet. */
export function classRoughness(spec: ShaderNode, wet: ShaderNode): ShaderNode {
  const dry: ShaderNode = mix(float(0.62), float(0.12), smoothstep(0.1, 0.9, spec));
  return mix(dry, min(dry, 0.22), wet);
}

/** GGX sun highlight (radiance factor: multiply by sunLight). n, l, v unit world vectors. */
export function sunHighlight(
  n: ShaderNode,
  l: ShaderNode,
  v: ShaderNode,
  roughness: ShaderNode,
  f0: ShaderNode,
): ShaderNode {
  const h: ShaderNode = normalize(l.add(v));
  const nh: ShaderNode = max(dot(n, h), 0);
  const nl: ShaderNode = max(dot(n, l), 0);
  const nv: ShaderNode = max(dot(n, v), 0.05);
  const vh: ShaderNode = max(dot(v, h), 0);
  const a: ShaderNode = roughness.mul(roughness);
  const a2: ShaderNode = a.mul(a);
  const d0: ShaderNode = nh.mul(nh).mul(a2.sub(1)).add(1);
  const distribution: ShaderNode = a2.div(d0.mul(d0).mul(Math.PI));
  const k: ShaderNode = roughness.add(1).mul(roughness.add(1)).div(8);
  const visibility: ShaderNode = float(0.25).div(
    nl
      .mul(float(1).sub(k))
      .add(k)
      .mul(nv.mul(float(1).sub(k)).add(k)),
  );
  const fresnel: ShaderNode = f0.add(
    float(1)
      .sub(f0)
      .mul(pow(float(1).sub(vh), 5)),
  );
  return distribution.mul(visibility).mul(fresnel).mul(nl);
}

/**
 * Share of the environment a window pane mirrors in the enhanced look. Stylised: the Fresnel reflectance of glass at
 * this view angle is about 5 %, which leaves panes as dark as the art's; a fifth reads as glass without washing out.
 */
export const GLASS_REFLECTANCE = 0.14;

/**
 * Window glass as seen from street level (stylised): the fixed camera looks down 30 degrees, so a vertical pane would
 * physically mirror the ground in front of it and never the sun. Panes are shaded with the view ray mirrored upwards
 * instead, the way windows read from the street: the sky towards the horizon with slow cloud streaks over the facade,
 * and a glint when the sun stands in that mirrored direction (east-facing panes in the morning, the sun-facing walls at
 * golden hour). `facade` is a 2D coordinate along the facade (world units); `tint` the pane's own colour, which tints
 * the reflection so blue glass stays blue.
 *
 * Real panes are never perfectly coplanar, but a random tilt per pane made a mosaic of unrelated cells and isolated
 * one-pixel glints. The tilt here is a smooth field over the facade (a few panes across), so the sky gradient and a
 * glint run continuously over neighbouring panes, as a sweep of light over a curtain wall.
 */
export function glassReflection(
  n: ShaderNode,
  v: ShaderNode,
  l: ShaderNode,
  facade: ShaderNode,
  tint: ShaderNode,
  state: SpriteLookState,
): { sky: ShaderNode; glint: ShaderNode } {
  const wobble: ShaderNode = vec3(
    mx_noise_float(vec3(facade.x.mul(1.7), facade.y.mul(1.1), 0.31)),
    mx_noise_float(vec3(facade.x.mul(1.3), facade.y.mul(1.7), 5.17)).mul(0.6),
    mx_noise_float(vec3(facade.x.mul(1.7), facade.y.mul(1.1), 9.73)),
  );
  const tilted: ShaderNode = normalize(n.add(wobble.mul(0.16)));
  const mirrored: ShaderNode = reflect(v.negate(), tilted);
  const r: ShaderNode = normalize(vec3(mirrored.x, abs(mirrored.y), mirrored.z));
  const gradient: ShaderNode = mix(state.skyHorizon, state.skyZenith, smoothstep(0.0, 0.9, r.y));
  const reference: ShaderNode = max(luminance(mix(state.skyHorizon, state.skyZenith, 0.55)), 1e-3);
  const streaks: ShaderNode = mx_noise_float(vec3(facade.x.mul(0.9), facade.y.mul(2.2), 0.37))
    .mul(0.45)
    .add(0.8)
    .clamp(0.3, 1.3);
  // The pane's hue (its colour over its own luminance, at 90 %) tints the mirrored sky, so blue glass stays blue.
  const hue: ShaderNode = tint.div(max(luminance(tint), 0.02)).clamp(0, 2.5);
  const tinted: ShaderNode = mix(vec3(1), hue, 0.9);
  // Panes stay darker than the open sky (tinted glass, the street in the lower half of the view).
  const sky: ShaderNode = gradient.div(reference).mul(luminance(state.skyLight)).mul(streaks).mul(tinted).mul(0.75);
  const alignment: ShaderNode = max(dot(r, l), 0);
  // A glint (the sun's disc blurred by the panes' waviness) over a faint halo; both vanish as the sun sets.
  // Glass keeps a tight lobe: sqrt(size) roughness corresponds to size in the inverse-power lobe width.
  const glint: ShaderNode = pow(alignment, highlightExponent(400, state.specularSize))
    .mul(0.7)
    .add(pow(alignment, highlightExponent(60, state.specularSize)).mul(0.02))
    .mul(max(l.y, 0).mul(4).min(1))
    .mul(state.specularSize.mul(state.specularSize));
  return { sky, glint };
}

/** Soft darkening of ground around a rectangle [0, w] x [0, h] (world units, local xz): 1 inside, fading outside. */
export function contactShade(local: ShaderNode, w: ShaderNode, h: ShaderNode): ShaderNode {
  const dx: ShaderNode = max(max(local.x.negate(), local.x.sub(w)), 0);
  const dz: ShaderNode = max(max(local.y.negate(), local.y.sub(h)), 0);
  const outside: ShaderNode = sqrt(dx.mul(dx).add(dz.mul(dz)));
  return exp(outside.mul(-1 / 0.32));
}

/** Screen row (engine px below the draw point) of the base line of a foundation w x h at screen column px. */
export function foundationBase(px: ShaderNode, w: ShaderNode, h: ShaderNode): ShaderNode {
  return min(h.mul(30).add(px.mul(0.5)), w.mul(30).sub(px.mul(0.5)));
}

/** Ground direction (world x, z) the art's own shadows point to: away from ART_LIGHT. */
export const ART_SHADOW_DIRECTION: readonly [number, number] = (() => {
  const l = Math.hypot(ART_LIGHT.x, ART_LIGHT.z) || 1;
  return [-ART_LIGHT.x / l, -ART_LIGHT.z / l] as const;
})();

/**
 * Where the sun-following look moves one ground point of an SHP shadow (CPU reference of the shader in sprites.ts;
 * points are world x/z relative to the draw point, `m` the uploaded shadow matrix, column-major m00, m10, m01, m11).
 * Shadows without a foundation (trees, SHP units) turn and stretch about the draw point. A building's shadow (one
 * with a foundation) stays where the art draws it. The art's shadow is the shadow of walls and roofs at heights it
 * does not record, standing anywhere inside the foundation, so no transform of the flat shadow can follow a turned
 * sun without tearing it off the building:
 * - turned about the draw point, it landed under or behind the building (live construction yards);
 * - about the foundation centre, the stretch carried it more than a cell off the walls;
 * - sheared off the foundation's shadow-side edge, the shadow beside the side wall was pulled back towards
 *   the sun, leaving bare ground at the wall and a smaller, stepped shadow (live XMP27T8 and IrvineCa: 0.56 and 0.69
 *   of the ground against the original's 0.44 and 0.52); even clamped to the shadow beyond the edge, the yard's art
 *   shadow starts half a cell or more out from that edge, so the turn still opened a gap at the wall.
 * The enhanced look keeps the darkness and softness of a building's shadow; its length and direction are the art's.
 */
export function followedShadowPoint(
  src: readonly [number, number],
  m: Vector4,
  foundation?: { origin: readonly [number, number]; size: readonly [number, number] },
): [number, number] {
  if (foundation) return [src[0], src[1]];
  return [m.x * src[0] + m.z * src[1], m.y * src[0] + m.w * src[1]];
}

/** Shader form of followedShadowPoint for a shadow without a foundation (vec2 `p`, relative to the draw point). */
export function followedShadowNode(p: ShaderNode, m: ShaderNode): ShaderNode {
  return vec2(m.x.mul(p.x).add(m.z.mul(p.y)), m.y.mul(p.x).add(m.w.mul(p.y)));
}

/** Degrees -> unit ground vector helper for CPU-side updates (see HdRenderer). */
export function shadowTransform(current: Vector3, stretch: number, follow: number, out: Vector4): Vector4 {
  // Ground directions the shadows point to: away from the light.
  const ax = -ART_LIGHT.x;
  const az = -ART_LIGHT.z;
  const al = Math.hypot(ax, az) || 1;
  let cx = -current.x;
  let cz = -current.z;
  const cl = Math.hypot(cx, cz);
  if (cl < 1e-4) {
    cx = ax;
    cz = az;
  }
  const angle = Math.atan2(cz, cx) - Math.atan2(az / al, ax / al);
  const theta = angle * follow;
  const k = 1 + (stretch - 1) * follow;
  // M = R(theta) * (I + (k - 1) s0 s0^T), s0 the art's unit shadow direction.
  const s0x = ax / al;
  const s0z = az / al;
  const a00 = 1 + (k - 1) * s0x * s0x;
  const a01 = (k - 1) * s0x * s0z;
  const a11 = 1 + (k - 1) * s0z * s0z;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // Column-major: (m00, m10, m01, m11).
  const m00 = c * a00 - s * a01;
  const m10 = s * a00 + c * a01;
  const m01 = c * a01 - s * a11;
  const m11 = s * a01 + c * a11;
  return out.set(m00, m10, m01, m11);
}
