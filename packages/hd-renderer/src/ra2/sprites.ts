import type { TerrainDepth } from '../terrainDepth';
import { NOT_CAPTURED_CODE } from '../objectDepth';
import { DirtyAttribute } from '../dirtyAttribute';
import { InstancedQuad, instancedQuadGeometry } from '../instancedQuad';
import { applyObjectTint } from '../objectTint';
import { instanceSilhouette, setSilhouette } from '../silhouette';
import { bindSlots, bindSlotsBeforeRender, samplingClass, slotMaterial, textureSlot } from '../materialSlots';
import {
  Color,
  InterleavedBufferAttribute,
  LessDepth,
  MeshBasicNodeMaterial,
  NormalBlending,
  type OrthographicCamera,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu';
import {
  Fn,
  Discard,
  If,
  cameraFar,
  cameraNear,
  clamp,
  dFdx,
  dFdy,
  exp,
  float,
  floor,
  attribute,
  length,
  log2,
  max,
  min,
  mix,
  positionGeometry,
  positionWorld,
  pow,
  luminance,
  round,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { LightingClass, MapObject, SpriteFrame } from '../../../ra2-assets/src/manifest';
import {
  DEFAULT_ATMOSPHERE_NODES,
  moonlit,
  LOCAL_LIGHT_HEIGHT_FALLOFF,
  localLightHeadroom,
  objectLightAt,
  pavedAt,
  puddleNoise,
  weatherGroundClearAt,
} from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { sceneLitColour } from '../lighting';
import { bindUnlitSpriteMaterial } from './unlitSprites';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { hdSupersampled, paletteRowOf, type HdAtlas, type Ra2Cache } from './cache';
import { mapLightAt, srgbScale } from './mapLighting';
import { ENGINE_SHADOW_OPACITY } from './voxelShadow';
import { cardDepthNode, SPRITE_DECAL_LIFT, SPRITE_DECAL_LIFT_ROWS } from './cardDepth';
import { NATIVE_UNIT_RENDER_ORDER, type NativeSpriteDepth } from './nativeDepth';
import { comparePainterOrder, spritePainterBias, type PainterObject } from './painterOrder';
import {
  GLASS_REFLECTANCE,
  WET_REFLECTION_MAX_OPACITY,
  classRoughness,
  contactShade,
  followedShadowNode,
  foundationBase,
  glassReflection,
  groundCrystalColour,
  highlightRoughness,
  poweredOcclusion,
  relightFactor,
  sampleMaterial,
  spriteLookFor,
  sunHighlight,
  type SpriteMaterialAtlas,
} from './spriteLook';

export interface SpriteInstance {
  /** World-space anchor: the engine's draw point for this object (canvas centre goes here). */
  anchor: Vector3;
  frame: SpriteFrame;
  /** Palette row key; remappable art uses its house row (see paletteFor). */
  palette: string;
  /** Recover house paint from the indexed source when an HD page has no encoded paint for this art. */
  indexedHousePaint?: boolean;
  /** World units to pull the card towards the camera so terrain around the base never cuts it (see cardPush). */
  push: number;
  shadow: boolean;
  /** Body-card alpha multiplier, default 1. Shadows and ground extras keep their own opacity. */
  opacity?: number;
  /** Infantry's inline SHP footprint stays at the draw point with a solid contact core in every look. */
  infantryShadow?: boolean;
  /**
   * Infantry footprint of art whose HD body page has no contact shadow of its own (ra2/infantryArt.ts): an enhanced
   * look never draws it lighter than its other shadows (infantryFootprintOpacity).
   */
  infantryBare?: boolean;
  /**
   * A terrain object's (tree's) SHP shadow: the enhanced look turns it with the sun like other shadows without a
   * foundation, but stretches it at most TERRAIN_SHADOW_MAX_STRETCH (spriteLook.ts terrainShadowMatrix).
   */
  terrainShadow?: boolean;
  /** Lay the art on the ground as a decal (ore, smudges, flat overlays) instead of a camera-facing card. */
  flat?: boolean;
  /** Flat decals only: 0..1 ground-crystal relighting, highlights and animated sparkle; absent = unchanged art. */
  glint?: number;
  /**
   * Extra object light on top of the map's (default 1 = none), applied to the palette colour in its own (sRGB) scale
   * and clamped at white, like the engine's palette lighting. For objects (lighting 'ambient') the excess over 1 is
   * ADDED to the map's object level, as the engine does (level + ExtraUnitLight); other classes are multiplied.
   */
  light?: number;
  /**
   * Picture tint of the object this card belongs to (objectTint.ts): the factor on its light level, default 1, and
   * the packed added colour, default 0 (none). Per-instance data; shadows and ground extras never carry one.
   */
  tintLight?: number;
  tintColour?: number;
  /** Caller-selected exemption from the map grade; extra object light and HD received light are unchanged. */
  gradeExempt?: boolean;
  /**
   * How the map's [Lighting] applies (see mapLighting.ts): 'ambient' (default) = level only, for buildings, units,
   * infantry and aircraft; 'full' = level and per-channel colour, for terrain-class art (overlays, smudges, trees);
   * 'none' = no map grade (ore, gems and tiberium trees). `unlit` also bypasses scene/display illumination.
   */
  lighting?: LightingClass;
  /** Display-referred art: preserve its clear-noon HD appearance independently of scene/map light and night grade. */
  unlit?: boolean;
  /** Map-light sample in world X/Z; defaults to the draw anchor. Cell copies can select a texel centre. */
  lightSample?: readonly [number, number];
  /** Optional traversal tie-break and building foundation. Decals/shadows retain physical ground depth. */
  painter?: PainterObject;
  painterPart?: number;
  /**
   * Nearness (world units) added to an upright card without a painter object, to settle depth ties between cards of
   * neighbouring cells: below its base line a card follows the ground under each pixel, so two cards that overlap
   * there have the very same depth and rounding picked the winner row by row (live/overlays.ts overlayTieBias).
   */
  tieBias?: number;
  /** Horizontal high-bridge depth at this height above the draw anchor; leaves screen placement unchanged. */
  deckHeight?: number;
  /** Original-engine body template, horizontal part or bitmap-bottom card; absent preserves analytic depth. */
  nativeDepth?: NativeSpriteDepth;
  /** Test-only native parts such as DoorAnim retain color but never obscure later units through depth writes. */
  depthWrite?: boolean;
  /**
   * Enhanced-look ground decals (see spriteLook.ts), drawn only while their effect is on: 'contact' darkens the ground
   * around `painter.foundation`, 'reflection' mirrors `frame` (an upright card's art) on wet paving below its base.
   */
  kind?: 'contact' | 'reflection';
}

const LIGHTING_CODE: Record<LightingClass, number> = { ambient: 0, full: 1, none: 2 };

/** The map extractor derives overlay 'none' from the rules' Tiberium flag; other ungraded art keeps scene light. */
export function isUnlitMapOverlay(object: Pick<MapObject, 'kind' | 'lighting'>): boolean {
  return object.kind === 'overlay' && object.lighting === 'none';
}

/** World units of depth bias per 15 screen rows of a ground-crystal decal (see placement). */
const CRYSTAL_DECAL_ROW_BIAS = 0.002;

/** flags.x of an instance: 0 card, 1 decal, 2 shadow, 3 contact shade, 4 wet reflection. */
function instanceCode(s: SpriteInstance): number {
  if (s.kind === 'contact') return 3;
  if (s.kind === 'reflection') return 4;
  return s.shadow ? 2 : s.flat ? 1 : 0;
}

/** Draw rank: decals (and contact shades), shadows, wet reflections, then upright cards back to front. */
function instanceRank(s: SpriteInstance): number {
  if (s.kind === 'reflection') return 2;
  return s.flat || s.kind === 'contact' ? 0 : s.shadow ? 1 : 3;
}

/** Draw passes of a sprite layer: the main one, and the enhanced look's ground passes (SpriteLayer.groundPasses). */
type GroundPass = 'main' | 'under' | 'over' | 'readOnly' | 'unit' | 'translucent';

/**
 * Largest penumbra radius (1x texels) of the enhanced look's shadow softness. Six texels laid the shadows of thin parts
 * (a crane jib, a chimney) out as faint smears; three keeps a soft golden-hour edge on a still solid shadow.
 */
export const SHADOW_PENUMBRA_TEXELS = 3;
/** Penumbra taps (unit radius): eight on two rings, as the shader samples them around the filtered coverage. */
const PENUMBRA_TAPS: readonly (readonly [number, number])[] = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2 + 0.4;
  const r = i % 2 === 0 ? 1 : 0.55;
  return [Math.cos(angle) * r, Math.sin(angle) * r] as const;
});

/**
 * Penumbra radius (1x texels) of a shadow point `offset` (world x/z from the draw point) under softness `softness`: it
 * grows with the distance from the object's base, a building's foundation (`centre`, `half`) or the draw point.
 */
export function shadowPenumbraRadius(
  offset: readonly [number, number],
  softness: number,
  foundation?: { centre: readonly [number, number]; half: readonly [number, number] },
): number {
  const dx = Math.max(0, Math.abs(offset[0] - (foundation?.centre[0] ?? 0)) - (foundation?.half[0] ?? 0));
  const dz = Math.max(0, Math.abs(offset[1] - (foundation?.centre[1] ?? 0)) - (foundation?.half[1] ?? 0));
  return Math.min(SHADOW_PENUMBRA_TEXELS, softness * Math.hypot(dx, dz) * 2.2);
}

/**
 * CPU twin of the softened shadow coverage at `texel` (1x atlas texels, texel centres at k + 0.5): the filtered
 * `coverage` there averaged with the eight penumbra taps, each reading the mask `occupied(kx, ky)` (1 or 0)
 * bilinearly, and blended in as the radius grows.
 */
export function shadowPenumbraCoverage(
  occupied: (kx: number, ky: number) => number,
  texel: readonly [number, number],
  coverage: number,
  radius: number,
): number {
  let soft = Math.min(1, Math.max(0, coverage));
  for (const [dx, dy] of PENUMBRA_TAPS) {
    const ax = texel[0] + dx * radius - 0.5;
    const ay = texel[1] + dy * radius - 0.5;
    const kx = Math.floor(ax);
    const ky = Math.floor(ay);
    const fx = ax - kx;
    const fy = ay - ky;
    const top = occupied(kx, ky) * (1 - fx) + occupied(kx + 1, ky) * fx;
    const bottom = occupied(kx, ky + 1) * (1 - fx) + occupied(kx + 1, ky + 1) * fx;
    soft += top * (1 - fy) + bottom * fy;
  }
  const t = Math.min(1, Math.max(0, (radius - 0.3) / 1.2));
  const w = t * t * (3 - 2 * t);
  const c = Math.min(1, Math.max(0, coverage));
  return c + (soft / (PENUMBRA_TAPS.length + 1) - c) * w;
}

/**
 * How far (world units along the view) the enhanced look's 'over' pass pulls SHP shadows and wet reflections in front
 * of their ground plane. Everything stays behind an upright card's base (CARD_CLEARANCE) and ahead of the ground
 * at every sample of 4x MSAA down to 1 engine px per pixel (the farthest sample, 0.375 px from the pixel centre, sees
 * ground 0.0153 nearer); zoomed further out, the nearest samples of a pixel can miss its shadow. Shadows step up with
 * their coverage (five levels): a later, denser shadow still darkens an earlier fringe.
 */
export const GROUND_PULL = { shadow: [0.019, 0.027], infantryCore: 0.028, reflection: 0.0285 } as const;
/**
 * The original infantry blob is solid palette index 12 (black) inside the body frames, not the half-colour shadow
 * blitter used by buildings and voxels: frozen same-frame pairs show the ground under it at 0.00 of the ground beside
 * it, on snow and on temperate ground alike. This is the opacity of that native footprint, and the faithful look's.
 * An enhanced look may draw the footprint as a shadow instead (SpriteLook.infantryShadow, HdSettings.infantryShadow):
 * at twice the resolution the solid blob is a smooth-edged black disc under every soldier, which reads as a hole in
 * bright ground (owner feedback on snow) where the original's few hard pixels read as a contact shadow.
 */
export const INFANTRY_SHADOW_OPACITY = 1;
/**
 * The footprint as a shadow (the cinematic look's HdSettings.infantryShadow): with it the ground under a soldier
 * shows at about half its brightness, like under every other shadow of the engine and under the HD vehicles'
 * contact shadows (0.45 to 0.47 of the ground). This is NOT ENGINE_SHADOW_OPACITY: the HD infantry body pages
 * already carry a soft contact shadow of their own in the footprint's place (alpha 0.25 to 0.5), which the solid
 * footprint used to hide, and the two multiply. Calibrated on same-frame sweeps of this value in frozen live frames
 * (12 conscripts each): 1 -> 0.02 / 0.03 of the ground (snow / temperate), 0.78 -> 0.26 / 0.23, 0.6 -> 0.37 / 0.33,
 * 0.4 -> 0.47 / 0.42, 0.2 -> 0.55 / 0.50, 0 (the body page's shadow alone) -> 0.62 / 0.56.
 */
export const INFANTRY_SHADOW_SOFT_OPACITY = 0.35;
/**
 * Core opacity of an infantry footprint under a look with footprint opacity `look` and shadow darkness `darkness`.
 * The soft footprint opacity counts on the HD body page's own contact shadow; art without one (`bare`, animals) would
 * keep almost no shadow, so it takes at least the look's opacity for every other shadow (the engine's half shadow
 * times the darkness, as buildings and vehicles get). The faithful looks (1) stay solid for all.
 */
export function infantryFootprintOpacity(look: number, bare: boolean, darkness = 1): number {
  return bare ? Math.max(look, Math.min(0.9, darkness * ENGINE_SHADOW_OPACITY)) : look;
}

/**
 * Coverage ramp of infantry contact shadows. The original draws them as solid palette-index-12 blobs inside the body
 * frames; the filtered/upscaled mask is only ~0.5 at the blob's own edge, so a linear ramp left half of every blob
 * lighter than the core. Coverage >= `to` is the full core, while the soft fringe stays at the blob's edge.
 * This affects contact alpha only; the selected native frame and its footprint are unchanged.
 */
export const INFANTRY_SHADOW_RAMP = { from: 0.02, to: 0.22 } as const;

/**
 * CPU twin of the infantry shadow alpha for a filtered mask coverage (0..1). `opacity` is the look's core opacity
 * (SpriteLook.infantryShadow): the native solid footprint by default.
 */
export function infantryShadowAlpha(coverage: number, opacity = INFANTRY_SHADOW_OPACITY): number {
  const t = Math.min(
    1,
    Math.max(0, (coverage - INFANTRY_SHADOW_RAMP.from) / (INFANTRY_SHADOW_RAMP.to - INFANTRY_SHADOW_RAMP.from)),
  );
  return t * t * (3 - 2 * t) * INFANTRY_SHADOW_OPACITY * opacity;
}

/**
 * Displayed brightness of the ground under a shadow of linear-light opacity `alpha`, relative to the ground beside it,
 * for a display transform of gamma 2.2 (the scene blends in linear light): 0.5 for ENGINE_SHADOW_OPACITY.
 */
export function shadowDisplayRatio(alpha: number): number {
  return Math.pow(Math.max(0, 1 - alpha), 1 / 2.2);
}

/**
 * Filtered coverage of a frame's 1x indexed mask at `texel` (quadratic B-spline over the 3x3 texels around it, texels
 * outside the frame rect empty): the same weights as the sprite colour's coverage.
 */
function frameCoverage(atlas: Texture, atlasSize: ShaderNode, texel: ShaderNode, rect: ShaderNode): ShaderNode {
  const k0: ShaderNode = floor(texel);
  const t0: ShaderNode = texel.sub(k0).sub(0.5);
  const weights = (o: number): ShaderNode =>
    o === 0
      ? float(0.75).sub(t0.mul(t0))
      : o < 0
        ? float(0.5).sub(t0).mul(float(0.5).sub(t0)).mul(0.5)
        : float(0.5).add(t0).mul(float(0.5).add(t0)).mul(0.5);
  const lo: ShaderNode = rect.xy;
  const hi: ShaderNode = rect.xy.add(rect.zw);
  let coverage: ShaderNode = float(0);
  for (const oy of [-1, 0, 1]) {
    for (const ox of [-1, 0, 1]) {
      const k: ShaderNode = k0.add(vec2(ox, oy));
      const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
      const occupied: ShaderNode = step(0.5, texture(atlas, k.add(0.5).div(atlasSize)).r.mul(255));
      coverage = coverage.add(weights(ox).x.mul(weights(oy).y).mul(occupied).mul(inside.x).mul(inside.y));
    }
  }
  return coverage;
}

const planeSize = new Vector2();
const probe = new Vector3();

/**
 * Coefficients (c0, cx, cy, cY) with which an orthographic camera's normalised depth of the horizontal plane at height
 * Y, seen through the pixel centre (x, y) of a width x height target (pixels, y down), is c0 + cx x + cy y + cY Y.
 */
export function groundPlaneDepth(camera: OrthographicCamera, width: number, height: number, out: Vector4): Vector4 {
  const inverse = camera.projectionMatrixInverse;
  const world = camera.matrixWorld.elements;
  const range = camera.far - camera.near;
  const depthAt = (x: number, y: number, planeY: number): number => {
    // View-space x and y of the pixel (orthographic: independent of the NDC depth used here).
    probe.set((2 * x) / width - 1, 1 - (2 * y) / height, 0.5).applyMatrix4(inverse);
    // World height along the view ray: y_w = m10 x + m11 y + m12 z + m13; solve for the view z on the plane.
    const z = (planeY - world[1]! * probe.x - world[5]! * probe.y - world[13]!) / world[9]!;
    return (-z - camera.near) / range;
  };
  const c0 = depthAt(0, 0, 0);
  return out.set(c0, depthAt(1, 0, 0) - c0, depthAt(0, 1, 0) - c0, depthAt(0, 0, 1) - c0);
}

/** Default SHP shadow blitter; infantry uses solid palette-index-12 contact pixels instead. */
const SHADOW_OPACITY = ENGINE_SHADOW_OPACITY;

/**
 * Placement push for camera-facing geometry (also used by lighting/shadows). Fragment occlusion is reconstructed
 * independently by cardDepth.ts; native bitmap bounds affect that profile, never this placement offset. A pixel d world
 * units below the anchor on screen sees ground d * cot(30°) nearer to the camera than the anchor, so the card must come
 * forward at least that far for its lowest pixel.
 */
export function cardPush(frame: SpriteFrame): number {
  const below = Math.max(0, frame.offset[1] + frame.rect[3]) / PIXELS_PER_CELL_EDGE;
  return below * Math.sqrt(3) + 0.03;
}

/** Explicit-LOD taps of the supersampled HD minification, in pixels from the centre (HD_SUPERSAMPLE_ABOVE_SCALE). */
const HD_SUPERSAMPLE_TAPS: readonly (readonly [number, number])[] = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/** What changes a sprite layer's shader (as opposed to the data it draws). */
interface SpriteGraphFeatures {
  /** HD colour page and house-paint mask (else the indexed page through the palette). */
  hd: boolean;
  /** The HD pair is minified with supersampled taps (pages above HD_SUPERSAMPLE_ABOVE_SCALE). */
  hdSupersample: boolean;
  /** The HD page's house-paint saturation; below 1 it adds nodes. */
  paintSaturation: number;
  windows: boolean;
  materials: boolean;
  capture: TerrainDepth | null;
  /**
   * Sampling class of each page (see samplingClass): three writes a texel load or a filtered sample into the shader
   * by the texture's filters, so layers whose pages differ in class cannot share a shader.
   */
  sampling: {
    atlas: SamplingClass;
    hd: SamplingClass;
    remap: SamplingClass;
    windows: SamplingClass;
    materials: SamplingClass;
  };
}

type SamplingClass = ReturnType<typeof samplingClass>;

/**
 * The shader graph of sprite layers: the six pass materials every layer with the same features draws with, and the
 * slots their shader reads a layer's pages from (materialSlots.ts). A layer's materials are clones of these, so three
 * builds each pass's shader once per render pass, not once per layer: a layer for an atlas page a match shows for the
 * first time costs its buffers and bind groups, where it used to cost six shader builds of 70 to 100 ms each (again
 * for the mirror and capture passes) on the thread that presents the frames. Per-instance data comes from the drawn
 * mesh's geometry by attribute name.
 */
class SpriteGraph {
  /** Palette sprites' scene light level; display-referred instances bypass it. */
  readonly light = uniform(new Color(1, 1, 1));
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /** Ground-plane depth coefficients of the 'over' pass (see groundPlaneDepth), set per draw. */
  readonly planeCoefficients = uniform(new Vector4());
  /** Slots: the indexed page and its size in texels, the HD pair with its scale to the indexed page, the sidecars. */
  readonly atlasPage: ShaderNode;
  readonly atlasSize = uniform(new Vector2(1, 1));
  readonly hdColour: ShaderNode;
  readonly hdRemap: ShaderNode;
  readonly hdScale = uniform(1);
  readonly windowsPage: ShaderNode;
  readonly materialPage: ShaderNode;
  /** Per-instance anchor code of capture-enabled layers, for the materials that are captured. */
  captureCode: ShaderNode | null = null;
  readonly materials: Record<'main' | 'readOnly' | 'unit' | 'translucent' | 'under' | 'over', MeshBasicNodeMaterial>;

  constructor(cache: Ra2Cache, features: SpriteGraphFeatures) {
    const nodes = cache.nodes ?? DEFAULT_ATMOSPHERE_NODES;
    const { referenceLevel, windowGain } = nodes;
    const look = spriteLookFor(nodes);
    const { capture, sampling } = features;
    this.atlasPage = textureSlot(sampling.atlas);
    this.hdColour = textureSlot(sampling.hd);
    this.hdRemap = textureSlot(sampling.remap);
    this.windowsPage = textureSlot(sampling.windows);
    this.materialPage = textureSlot(sampling.materials);
    // The texture slots stand where the layer's own textures stood: texture() takes a texture node as well.
    const atlasPage = this.atlasPage as unknown as Texture;
    const hdColour = this.hdColour as unknown as Texture;
    const hdRemap = this.hdRemap as unknown as Texture;
    const windowsPage = this.windowsPage as unknown as Texture;
    const materialPage = { texture: this.materialPage as unknown as Texture };

    const atlasSize: ShaderNode = this.atlasSize;
    const paletteRows = float(cache.paletteAtlas.image.height);
    const aAnchor: ShaderNode = attribute('spriteAnchor', 'vec3');
    const aRect: ShaderNode = attribute('spriteRect', 'vec4');
    const aParams: ShaderNode = attribute('spriteParams', 'vec4');
    const aLighting: ShaderNode = attribute('spriteLighting', 'vec3');
    const aLightSample: ShaderNode = aLighting.xy;
    // Constant over an instance: flat, so the untinted value stays exactly (1, 0) in every fragment.
    // (The varying must not share the attribute's name: three then resolves one through the other without end.)
    const aTint: ShaderNode = varying(attribute('spriteTint', 'vec2'), 'spriteTintFlat').setInterpolation(
      'flat',
      'either',
    );
    // Two independent bits share this existing component; no extra instance attribute or vertex buffer is needed.
    const indexedHousePaint: ShaderNode = step(1.5, aLighting.z).toVar('spriteIndexedHousePaint');
    const aGradeExempt: ShaderNode = aLighting.z.sub(indexedHousePaint.mul(2)).toVar('spriteGradeExempt');
    const aFlags: ShaderNode = attribute('spriteFlags', 'vec4');
    const aOcclusion: ShaderNode = attribute('spriteOcclusion', 'vec4');
    const aNative: ShaderNode = attribute('spriteNative', 'vec4');
    const aNativeOffset: ShaderNode = attribute('spriteNativeOffset', 'vec4');
    const aFlat: ShaderNode = aFlags.x;
    const bodyOpacity: ShaderNode = aNativeOffset.w
      .greaterThanEqual(3)
      .select(aNativeOffset.w.sub(3), 1)
      .toVar('spriteBodyOpacity');
    const isInfantryShadow: ShaderNode = step(1.5, aFlat)
      .mul(float(1).sub(step(2.5, aFlat)))
      .mul(step(0.5, aFlags.w));
    // flags.w of a shadow: 1 or 2 an infantry footprint, -1 a terrain object's shadow (see SpriteInstance.terrainShadow).
    const isTerrainShadow: ShaderNode = step(1.5, aFlat)
      .mul(float(1).sub(step(2.5, aFlat)))
      .mul(step(aFlags.w, -0.5));
    // The map's light for this instance's class, times its own extra light, in the palette's sRGB scale (see
    // mapLighting.ts): 'ambient' takes the level, 'full' the per-channel grade, 'none' nothing.
    const isFull: ShaderNode = step(0.5, aFlags.z).mul(float(1).sub(step(1.5, aFlags.z)));
    const isNone: ShaderNode = step(1.5, aFlags.z);
    const isUnlit: ShaderNode = step(2.5, aFlags.z);
    // Ungraded trees retain their former terrain event policy; self-lit overlays bypass scene lighting altogether.
    const sceneMultiplier: ShaderNode = mix(nodes.sceneObjectMul, nodes.sceneTerrainMul, max(isFull, isNone));
    // Objects ('ambient'): the engine ADDS the extra light to the cell's object level (I + ExtraInfantryLight ...), so
    // at Ambient 0.68 infantry shows at 0.88 of its palette, not 0.68 x 1.2 = 0.82. Terrain-class and unlit instances
    // keep the plain factor (their `light` is 1 in practice).
    const extraLight: ShaderNode = aFlags.y.sub(1);
    const mapLight: ShaderNode = mapLightAt(cache.mapLight, aLightSample);
    const grade: ShaderNode = select(
      aGradeExempt.greaterThan(0.5),
      vec3(aFlags.y),
      mix(mix(vec3(mapLight.a.add(extraLight)), mapLight.rgb.mul(aFlags.y), isFull), vec3(aFlags.y), isNone),
    );
    const objectLit = (c: ShaderNode): ShaderNode => srgbScale(c, grade);
    // What the map's light does to white, in linear light: the look's added light (highlights, glints, mirrored sky)
    // is scaled by it, because the game darkens the whole object, not only its painted colour. Left at full strength
    // on a dark map they made relit buildings brighter than the map (frozen pairs under the cinematic look: the
    // construction yard at 1.46 of the native luminance on MoonPatr and Transylv, object level 0.57-0.60, against
    // 1.17-1.29 on maps at 0.98-1). 1 at an object level of 1 or more.
    const gradeLight: ShaderNode = objectLit(vec3(1)).toVar('spriteGradeLight');
    const ppu = float(PIXELS_PER_CELL_EDGE);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = NormalBlending;
    // Edges are soft (filtered coverage, see colorNode) and blend; only fully clear fragments are discarded. No
    // alpha-to-coverage: under MSAA it turns the translucent shadows opaque.
    material.alphaTest = 0.04;
    // Raster-relative coordinates from the quad's own UVs (u right, v down). positionLocal cannot be used here: once
    // positionNode is set it refers to the displaced position in the fragment stage.
    const u: ShaderNode = uv().x;
    const vCard: ShaderNode = float(1).sub(uv().y);
    const pushAmount: ShaderNode = aParams.w;
    // Enhanced-look instance kinds (codes 3 and 4) and the art's base line under a column (the foundation's front edges
    // for buildings, the draw point's row otherwise), for mirror images on wet ground.
    const isContact: ShaderNode = step(2.5, aFlat).mul(float(1).sub(step(3.5, aFlat)));
    const isReflection: ShaderNode = step(3.5, aFlat);
    // occlusion.zw hold the draw point's offset from the foundation (d = x - z, -x - z), zero for map buildings.
    const baseRow = (px: ShaderNode): ShaderNode =>
      select(
        aOcclusion.x.greaterThan(0),
        foundationBase(px.add(aOcclusion.z.mul(30)), aOcclusion.x, aOcclusion.y).add(aOcclusion.w.mul(15)),
        float(0),
      );
    // Foundation origin and centre on the ground relative to the draw point (world x/z), or the draw point itself.
    const foundationOrigin: ShaderNode = vec2(aOcclusion.w.sub(aOcclusion.z), aOcclusion.z.add(aOcclusion.w)).mul(0.5);
    const hasFoundation: ShaderNode = aOcclusion.x.greaterThan(0);
    const foundationHalf: ShaderNode = select(hasFoundation, aOcclusion.xy.mul(0.5), vec2(0, 0));
    const baseCentre: ShaderNode = select(hasFoundation, foundationOrigin.add(foundationHalf), vec2(0, 0));
    // Sun-following shadow transform (spriteLook.ts followedShadowPoint): turned and stretched about the draw point.
    // Terrain objects' shadows take the transform with the capped stretch (spriteLook.ts setShadowTransforms).
    const followed2d = (offset: ShaderNode): ShaderNode =>
      followedShadowNode(offset, select(isTerrainShadow.greaterThan(0.5), look.terrainShadowMatrix, look.shadowMatrix));
    // A reflection's quad spans the rows from the base line down to the mirror image of the frame's top.
    const reflectionRows = (): ShaderNode => {
      const top: ShaderNode = aParams.y;
      const bottom: ShaderNode = select(
        aOcclusion.x.greaterThan(0),
        aOcclusion.x.add(aOcclusion.y).mul(15).add(aOcclusion.w.mul(15)),
        float(0),
      );
      return vec2(float(0).min(bottom), bottom.mul(2).sub(top));
    };
    // Reflections sample the art at the row mirrored about the base line of their column.
    const reflectedV = (): ShaderNode => {
      const rows: ShaderNode = reflectionRows();
      const px: ShaderNode = aParams.x.add(u.mul(aRect.z));
      const qy: ShaderNode = rows.x.add(vCard.mul(rows.y.sub(rows.x)));
      const base: ShaderNode = baseRow(px);
      // Rain-ruffled water: the mirror row wobbles, more with distance from the base (a blurred, broken image).
      const ripple: ShaderNode = sin(qy.mul(0.7).add(px.mul(0.11)))
        .mul(0.6)
        .add(sin(qy.mul(0.23).sub(px.mul(0.05))).mul(0.9))
        .mul(max(qy.sub(base), 0).mul(0.05).add(0.4));
      const source: ShaderNode = base.mul(2).sub(qy).add(ripple);
      return source.sub(aParams.y).div(max(aRect.w, 1));
    };
    const v: ShaderNode = select(isReflection.greaterThan(0.5), reflectedV(), vCard);
    const cardDepth = (): ShaderNode =>
      cardDepthNode(
        aParams.x.add(u.mul(aRect.z)),
        aParams.y.add(vCard.mul(aRect.w)),
        aOcclusion,
        pushAmount,
        aFlags.w,
        aFlat.greaterThan(0.5),
        { data: aNative, offset: aNativeOffset, template: cache.depthTemplate },
      );
    material.depthNode = cardDepth();
    // Vertex stage: corners from the untouched geometry attribute (+-0.5).
    const gu: ShaderNode = positionGeometry.x.add(0.5);
    const gv: ShaderNode = float(0.5).sub(positionGeometry.y);
    // Enhanced-look ground passes (see SpriteLayer.groundPasses): with the look on, the main pass draws only upright
    // cards; decals and contact shades go to the 'under' pass, SHP shadows and wet reflections to the 'over' pass.
    const enhancedOn: ShaderNode = step(0.5, look.enabled);
    const underKind: ShaderNode = step(0.5, aFlat)
      .mul(float(1).sub(step(1.5, aFlat)))
      .add(isContact);
    const overKind: ShaderNode = step(1.5, aFlat)
      .mul(float(1).sub(step(2.5, aFlat)))
      .add(isReflection);
    const skipIn = (pass: GroundPass): ShaderNode =>
      pass === 'translucent'
        ? aNativeOffset.w.greaterThanEqual(3).select(0, 1)
        : pass === 'readOnly'
          ? aNativeOffset.w.equal(1).select(0, 1)
          : pass === 'unit'
            ? aNativeOffset.w.equal(2).select(0, 1)
            : pass === 'main'
              ? enhancedOn.mul(step(0.5, aFlat)).add(step(0.5, aNativeOffset.w))
              : float(1)
                  .sub(enhancedOn.mul(pass === 'under' ? underKind : overKind))
                  .add(step(0.5, aNativeOffset.w));
    const placement = (pass: GroundPass): ShaderNode =>
      Fn(() => {
        const px = aParams.x.add(gu.mul(aRect.z));
        const py = aParams.y.add(gv.mul(aRect.w));
        const card = aAnchor
          .add(this.cameraRight.mul(px.div(ppu)))
          .sub(this.cameraUp.mul(py.div(ppu)))
          .add(this.toCamera.mul(pushAmount));
        // Ground decal: invert the engine projection at the anchor's height (1 px right = (1/60, -1/60) cells,
        // 1 px down = (1/30, 1/30) cells), so the art covers exactly the same screen pixels while lying on the ground.
        // Ground-crystal decals (ore cells whose art spills over the cell edge) overlap their neighbours in one plane.
        // Where a pass writes depth, the decal drawn first would reject the overlap of the next one by rounding, which
        // cuts nuggets along straight lines. A depth bias by the pixel's screen row relative to the anchor makes the
        // decal anchored lower on screen (the front cell, drawn later in painter order) win; at most a few thousandths
        // of a cell, well inside SPRITE_DECAL_LIFT.
        const crystalDecal: ShaderNode = step(0.5, aFlat)
          .mul(float(1).sub(step(1.5, aFlat)))
          .mul(step(1e-4, aFlags.w));
        const rowBias: ShaderNode = clamp(py.div(15), -3, 3).mul(-CRYSTAL_DECAL_ROW_BIAS).mul(crystalDecal);
        // The decal plane sits SPRITE_DECAL_LIFT above the ground; the art slides down that plane by the rows the lift
        // would raise it on screen, so its pixels stay exactly where the engine draws them (see SPRITE_DECAL_LIFT_ROWS).
        const lifted = (gx: ShaderNode, gz: ShaderNode): ShaderNode =>
          aAnchor.add(
            vec3(gx.add(SPRITE_DECAL_LIFT_ROWS / 30), SPRITE_DECAL_LIFT, gz.add(SPRITE_DECAL_LIFT_ROWS / 30)),
          );
        const decal = lifted(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60))).add(this.toCamera.mul(rowBias));
        const placed = aFlat.greaterThan(0.5).select(decal, card);
        // Enhanced look (spriteLook.ts). Shadows follow the sun: their ground offsets turn and stretch about the object's
        // draw point (not a building's: see followedShadowPoint); the faithful path keeps the untouched decal.
        const isShadowKind: ShaderNode = step(1.5, aFlat).mul(float(1).sub(step(2.5, aFlat)));
        const turned: ShaderNode = followed2d(vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60))));
        const followed = lifted(turned.x, turned.y);
        // Inline infantry footprints share the body's screen offsets; rotating them would detach them from its feet.
        // A building's shadow (one with a foundation) keeps the art's own shape and place, see followedShadowPoint.
        const follow: ShaderNode = isShadowKind
          .mul(float(1).sub(isInfantryShadow))
          .mul(hasFoundation.select(0, 1))
          .mul(step(1e-4, look.shadowFollow))
          .mul(look.enabled);
        // Contact shades and reflections exist only while their effect is on; otherwise they collapse to a point.
        const rows: ShaderNode = reflectionRows();
        const qy = rows.x.add(gv.mul(rows.y.sub(rows.x)));
        const mirrored = lifted(px.div(60).add(qy.div(30)), qy.div(30).sub(px.div(60)));
        const contactOn: ShaderNode = step(1e-4, look.occlusion).mul(look.enabled);
        const reflectionOn: ShaderNode = step(1e-4, look.reflections.mul(look.wetness)).mul(look.enabled);
        const hidden: ShaderNode = isContact
          .mul(float(1).sub(contactOn))
          .add(isReflection.mul(float(1).sub(reflectionOn)))
          .add(skipIn(pass));
        const enhanced = select(
          isReflection.greaterThan(0.5),
          mirrored,
          select(follow.greaterThan(0.5), followed, placed),
        );
        return select(hidden.greaterThan(0.5), aAnchor, enhanced);
      })();
    material.positionNode = placement('main');
    // One colour graph per material (the main pass and the enhanced look's ground passes below).
    const colourNode = (): ShaderNode =>
      Fn(() => {
        const texel = vec2(aRect.x.add(u.mul(aRect.z)), aRect.y.add(v.mul(aRect.w))).toVar();
        const atlasUv = texel.div(atlasSize);
        const paletteColour = (i: ShaderNode): ShaderNode =>
          texture(cache.paletteAtlas, vec2(i.add(0.5).div(256), aParams.z.add(0.5).div(paletteRows))).rgb;
        const isShadow: ShaderNode = step(1.5, aFlat).mul(float(1).sub(step(2.5, aFlat)));

        // Coverage of the 1x indexed mask, filtered with a quadratic B-spline (the average of four bilinear taps half a
        // texel apart) over the 3x3 texels around this point, texels outside the frame's rect counting as empty. Its
        // edges run as straight lines at any zoom instead of magnified stair steps. `index` is the texel under this
        // point; `fill` the index of the strongest opaque neighbour, used just outside the art (concave corners) so the
        // soft edge never shows palette entry 0. Everything is accumulated in variables and blended arithmetically, so
        // the shared taps are computed once, in order.
        const k0: ShaderNode = floor(texel).toVar();
        const t0: ShaderNode = texel.sub(k0).sub(0.5).toVar();
        const weights = (o: number): ShaderNode =>
          o === 0
            ? float(0.75).sub(t0.mul(t0))
            : o < 0
              ? float(0.5).sub(t0).mul(float(0.5).sub(t0)).mul(0.5)
              : float(0.5).add(t0).mul(float(0.5).add(t0)).mul(0.5);
        const lo: ShaderNode = aRect.xy;
        const hi: ShaderNode = aRect.xy.add(aRect.zw);
        const coverage: ShaderNode = float(0).toVar();
        const index: ShaderNode = float(0).toVar();
        const fill: ShaderNode = float(0).toVar();
        const fillWeight: ShaderNode = float(0).toVar();
        const houseIndex: ShaderNode | null = features.hd ? float(0).toVar() : null;
        const houseWeight: ShaderNode | null = features.hd ? float(0).toVar() : null;
        for (const oy of [-1, 0, 1]) {
          for (const ox of [-1, 0, 1]) {
            const k: ShaderNode = k0.add(vec2(ox, oy));
            const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
            const i: ShaderNode = floor(texture(atlasPage, k.add(0.5).div(atlasSize)).r.mul(255).add(0.5)).toVar();
            const occupied: ShaderNode = step(0.5, i).mul(inside.x).mul(inside.y).toVar();
            const w: ShaderNode = weights(ox).x.mul(weights(oy).y).mul(occupied).toVar();
            coverage.addAssign(w);
            if (houseIndex && houseWeight) {
              const paintWeight: ShaderNode = w.mul(step(15.5, i)).mul(step(i, 31.5));
              houseIndex.addAssign(i.mul(paintWeight));
              houseWeight.addAssign(paintWeight);
            }
            if (ox === 0 && oy === 0) {
              index.assign(i.mul(occupied));
            } else {
              const stronger: ShaderNode = step(fillWeight.add(1e-6), w);
              fill.assign(mix(fill, i, stronger));
              fillWeight.assign(max(fillWeight, w));
            }
          }
        }
        // Shadows take the filtered coverage itself: solid shadow art stays solid with a soft edge, and the stippled
        // shadows of trees and bushes become an even half shadow (their average at 1x) instead of blotches.
        // Existing building/vehicle shadows retain indexed coverage. Only the new infantry page supplies HD alpha.
        const shadowCoverage: ShaderNode = features.hd
          ? mix(clamp(coverage, 0, 1), max(clamp(coverage, 0, 1), texture(hdColour, atlasUv).a), isInfantryShadow)
          : clamp(coverage, 0, 1);
        const infantryAlpha: ShaderNode = smoothstep(INFANTRY_SHADOW_RAMP.from, INFANTRY_SHADOW_RAMP.to, shadowCoverage)
          .mul(INFANTRY_SHADOW_OPACITY)
          .toVar('spriteInfantryShadowAlpha');
        const shadow: ShaderNode = vec4(
          0,
          0,
          0,
          mix(shadowCoverage.mul(SHADOW_OPACITY), infantryAlpha, isInfantryShadow),
        );
        const edge: ShaderNode = smoothstep(0.35, 0.65, coverage);
        // Local light at the ground point under this pixel (decals: the pixel itself; upright art: straight below it on
        // screen, down to the anchor's ground line), fading with the pixel's height above that ground.
        const px = aParams.x.add(u.mul(aRect.z)).toVar();
        const py = aParams.y.add(v.mul(aRect.w)).toVar();
        const flat = aFlat.greaterThan(0.5);
        const down = select(flat, py, max(py, 0));
        const ground = aAnchor.xz.add(vec2(px.div(60).add(down.div(30)), down.div(30).sub(px.div(60)))).toVar();
        const height = select(flat, float(0), max(py.negate(), 0).div(ppu));
        // Upright building art takes ground-only light (a building's own source) inside its own foundation: the
        // pixel's ground projection, clamped a little inside the foundation (objectLightAt).
        const building: ShaderNode = step(0.5, aOcclusion.x).mul(float(1).sub(step(0.5, aFlat)));
        const inset: ShaderNode = min(aOcclusion.xy.mul(0.5), 0.35);
        const projected: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60)));
        const own: ShaderNode = aAnchor.xz
          .add(foundationOrigin)
          .add(clamp(projected.sub(foundationOrigin), inset, max(aOcclusion.xy.sub(inset), inset)));
        const local: ShaderNode = objectLightAt(ground, own, building, nodes)
          .div(referenceLevel)
          .mul(exp(height.mul(-LOCAL_LIGHT_HEIGHT_FALLOFF)));
        // The map's light, then the scene light on the night-desaturated colour (house paint keeps its colour) and local
        // lights on the full colour.
        const shade = (c: ShaderNode, paint: ShaderNode): ShaderNode => {
          const lit: ShaderNode = objectLit(c);
          const base = mix(moonlit(lit, nodes), lit, paint).mul(this.light);
          const eventBase = sceneLitColour(base, sceneMultiplier);
          return select(
            isUnlit.greaterThan(0.5),
            c.mul(look.unlitBaseLight),
            eventBase.add(localLightHeadroom(eventBase, lit.mul(local), nodes.localLightCap)),
          );
        };
        // Lit windows at night: warm amber panes (85 %) or a dimmer cool white (15 %) by the window's variant, each pane
        // with its own brightness; variants above 0.85 stay dark. Kept below the tone mapper's shoulder so panes stay
        // amber instead of washing out to white.
        let glow: ShaderNode = vec3(0, 0, 0);
        if (features.windows) {
          const mask: ShaderNode = texture(windowsPage, atlasUv);
          const variant = mask.g.div(0.85);
          const brightness = float(0.9).add(variant.mul(7.3).fract().mul(0.4));
          const tint = mix(vec3(1.0, 0.64, 0.27), vec3(0.62, 0.68, 0.8), step(0.85, variant));
          const upright = select(flat, float(0), float(1));
          glow = tint.mul(brightness).mul(mask.r).mul(step(mask.g, 0.85)).mul(windowGain).mul(upright);
        }
        let art: ShaderNode;
        let lit: ShaderNode;
        let litAlpha: ShaderNode;
        let litGlow: ShaderNode;
        if (!features.hd) {
          const shown: ShaderNode = mix(fill, index, step(0.5, index));
          const paint: ShaderNode = step(15.5, shown).mul(step(shown, 31.5));
          lit = shade(paletteColour(shown), paint).toVar();
          litGlow = glow.mul(edge).toVar();
          litAlpha = edge.toVar();
          art = vec4(lit.add(litGlow), litAlpha);
        } else {
          let hdArt: ShaderNode;
          let hdPaint: ShaderNode;
          if (!features.hdSupersample) {
            hdArt = texture(hdColour, atlasUv);
            hdPaint = texture(hdRemap, atlasUv).r;
          } else {
            // See HD_SUPERSAMPLE_ABOVE_SCALE. The footprint is measured in HD texels; colour is averaged weighted by
            // alpha (the pages hold straight alpha, so a transparent tap must not pull its bled colour in).
            const dx: ShaderNode = dFdx(atlasUv).toVar();
            const dy: ShaderNode = dFdy(atlasUv).toVar();
            const hdSize: ShaderNode = atlasSize.mul(this.hdScale);
            const footprint: ShaderNode = max(length(dx.mul(hdSize)), length(dy.mul(hdSize)));
            const lod: ShaderNode = max(log2(max(footprint, 1e-6)).sub(1), 0).toVar();
            const rgb: ShaderNode = vec3(0).toVar();
            const alpha: ShaderNode = float(0).toVar();
            const paintSum: ShaderNode = float(0).toVar();
            for (const [sx, sy] of HD_SUPERSAMPLE_TAPS) {
              const at: ShaderNode = atlasUv.add(dx.mul(sx)).add(dy.mul(sy));
              const tap: ShaderNode = texture(hdColour, at).level(lod).toVar();
              rgb.addAssign(tap.rgb.mul(tap.a));
              alpha.addAssign(tap.a);
              paintSum.addAssign(texture(hdRemap, at).level(lod).r);
            }
            const taps = HD_SUPERSAMPLE_TAPS.length;
            hdArt = vec4(rgb.div(max(alpha, 1e-5)), alpha.div(taps));
            hdPaint = paintSum.div(taps);
          }
          const sourcePaint: ShaderNode = indexedHousePaint.mul(step(15.5, index)).mul(step(index, 31.5));
          const paint: ShaderNode = max(hdPaint, sourcePaint);
          // House paint was written as grey(i) = 255 - (i - 16) * 15 in sRGB; invert it to a fractional remap index and
          // take the instance's house colours from its palette row, blending between neighbouring entries.
          const grey = pow(hdArt.g.max(0), 1 / 2.2).mul(255);
          const encodedIndex = clamp(float(16).add(float(255).sub(grey).div(15)), 16, 31);
          // Buildings are remapped by the engine even when their art says Remapable=no. Some installed pages have
          // encoded grey paint for these sprites (keep its redraw shading); older pages have an empty mask or bake
          // the palette's red into a non-grey masked texel. Reuse the indexed taps for the owner's original ramp in
          // those places, retaining the HD colour/detail everywhere else. The weighted ramp also covers mask fringes.
          const nonGrey: ShaderNode = step(1e-6, max(hdArt.r.sub(hdArt.g).abs(), hdArt.g.sub(hdArt.b).abs()));
          const indexedFallback: ShaderNode = max(
            sourcePaint.mul(float(1).sub(step(1e-6, hdPaint))),
            indexedHousePaint.mul(step(1e-6, hdPaint)).mul(nonGrey),
          );
          const originalIndex: ShaderNode = clamp(
            select(houseWeight!.greaterThan(1e-6), houseIndex!.div(max(houseWeight!, 1e-6)), index),
            16,
            31,
          );
          const remapIndex = mix(encodedIndex, originalIndex, indexedFallback);
          const i0 = floor(remapIndex);
          let house: ShaderNode = mix(paletteColour(i0), paletteColour(i0.add(1).min(31)), remapIndex.sub(i0));
          if (features.paintSaturation < 1) {
            // Palette samples are linear; preserve Rec.709 luminance and the encoded shading. Default pages add no nodes.
            const greyHouse = house.dot(vec3(0.2126, 0.7152, 0.0722));
            house = mix(vec3(greyHouse), house, features.paintSaturation);
          }
          const colour = mix(hdArt.rgb, house, paint);
          // The upscaler saw the art over a flat background, so HD texels next to transparent ones carry a light fringe
          // of it (pale rings around the holes in foliage). Within about one original texel of any transparent texel the
          // HD colour keeps its own hue but is never brighter than the original's texel there (the palette colour of the
          // nearest opaque texel): the pale fringe goes, without a rim of raw palette colours (bright green dots,
          // salmon outlines) around the silhouette.
          const nearest: ShaderNode = paletteColour(mix(fill, index, step(0.5, index)));
          const solid: ShaderNode = smoothstep(0.8, 1.0, coverage);
          const limit: ShaderNode = luminance(nearest)
            .div(max(luminance(colour), 1e-4))
            .min(1);
          lit = shade(mix(colour.mul(limit), colour, solid), paint).toVar();
          litGlow = vec3(glow).toVar();
          litAlpha = hdArt.a.mul(edge).toVar();
          art = vec4(lit.add(litGlow), litAlpha);
        }
        const result: ShaderNode = mix(art, shadow, isShadow).toVar();
        // Enhanced look (spriteLook.ts): skipped entirely in the faithful default, so its colours stay untouched.
        If(look.enabled.greaterThan(0.5), () => {
          const flatArt: ShaderNode = aFlat.greaterThan(0.5);
          const view: ShaderNode = this.toCamera;
          const sun: ShaderNode = look.sunDirection;
          const wet: ShaderNode = look.wetness;
          // Upright art with material data: relight as a delta on the baked shading, occlusion, highlights, glass.
          if (features.materials) {
            const m = sampleMaterial(materialPage, atlasUv);
            const weight: ShaderNode = m.has.mul(float(1).sub(step(0.5, aFlat)));
            const factor: ShaderNode = mix(vec3(1), relightFactor(m.normal, look), look.relight.mul(weight));
            const occlusion: ShaderNode = mix(
              float(1),
              poweredOcclusion(m.ao, look.aoPower),
              look.occlusion.mul(weight),
            );
            const base: ShaderNode = lit.mul(factor).mul(occlusion);
            const glass: ShaderNode = smoothstep(0.75, 0.98, m.spec).mul(weight);
            // Glass: a street-level mirror (see glassReflection) with sky, cloud streaks and a sun glint, tinted by the
            // pane. Its own strength (look.glass) is independent of the facade highlights (look.specular).
            const facade: ShaderNode = vec2(ground.x.add(ground.y), py.div(ppu).negate());
            const pane = glassReflection(m.normal, view, sun, facade, lit, look);
            const reflectance: ShaderNode = look.glass
              .mul(glass.mul(GLASS_REFLECTANCE))
              .add(look.specular.mul(wet.mul(weight).mul(0.05)));
            const roughness: ShaderNode = highlightRoughness(classRoughness(m.spec, wet), look.specularSize);
            // Facades and roofs: a physical GGX highlight, weak on matte classes.
            const highlight: ShaderNode = sunHighlight(m.normal, sun, view, roughness, float(0.03))
              .mul(look.sunLight)
              .mul(gradeLight)
              .mul(look.specularSize.mul(look.specularSize))
              .mul(
                look.specular
                  .mul(weight)
                  .mul(mix(float(0.25), float(1), m.spec))
                  .mul(float(1).sub(glass))
                  .mul(occlusion),
              );
            // Glints only on the full inside of a pane (not its softer rim), so they never sparkle as single pixels.
            const core: ShaderNode = smoothstep(0.92, 0.99, m.spec).mul(weight);
            const glint: ShaderNode = pane.glint
              .mul(look.sunLight)
              .mul(gradeLight)
              .mul(look.glass.mul(core).mul(occlusion));
            const sky: ShaderNode = sceneLitColour(pane.sky.mul(occlusion).mul(gradeLight), sceneMultiplier);
            const relit: ShaderNode = mix(base, sky, reflectance)
              .add(sceneLitColour(highlight, sceneMultiplier))
              .add(sceneLitColour(glint, sceneMultiplier));
            result.assign(select(flatArt, result, vec4(relit.add(litGlow), litAlpha)));
            const isDecal: ShaderNode = step(0.5, aFlat).mul(float(1).sub(step(1.5, aFlat)));
            const crystal: ShaderNode = aFlags.w.mul(isDecal).mul(m.has);
            // Use colour-atlas pixels, not material pixels: material sidecars may have a different resolution.
            const hdScale: ShaderNode = this.hdScale;
            const crystalColour = groundCrystalColour(
              lit,
              m,
              crystal,
              texel.mul(hdScale),
              view,
              look,
              aAnchor.xz,
              (pixel) => sampleMaterial(materialPage, pixel.div(hdScale).div(atlasSize)),
              isUnlit,
            );
            result.assign(select(crystal.greaterThan(0), vec4(crystalColour.add(litGlow), litAlpha), result));
          }
          // Half-colour shadows respond to the look's darkness, length and softness. The infantry footprint keeps its
          // native shape and place; only its core opacity is the look's (1 = the original's solid black).
          If(
            isShadow.greaterThan(0.5).and(isInfantryShadow.greaterThan(0.5)).and(look.infantryShadow.notEqual(1)),
            () => {
              // infantryFootprintOpacity: art without its own contact shadow (code 2) keeps the look's shadow opacity.
              const bare: ShaderNode = step(1.5, aFlags.w);
              const opacity: ShaderNode = mix(
                look.infantryShadow,
                max(look.infantryShadow, look.shadowDarkness.mul(SHADOW_OPACITY).min(0.9)),
                bare,
              );
              result.assign(vec4(0, 0, 0, infantryAlpha.mul(opacity).min(1)));
            },
          );
          const shadowOpacity: ShaderNode = look.shadowDarkness.mul(SHADOW_OPACITY).min(0.9);
          If(isShadow.greaterThan(0.5).and(isInfantryShadow.lessThan(0.5)).and(look.shadowDarkness.notEqual(1)), () => {
            const alpha: ShaderNode = shadowCoverage.mul(shadowOpacity);
            result.assign(vec4(0, 0, 0, alpha));
          });
          // Shadows grow a penumbra with distance from their object's base (golden-hour softness): CPU twin
          // shadowPenumbraRadius / shadowPenumbraCoverage. The base is a building's foundation (its walls) or the
          // draw point; measured from the foundation centre, a yard's shadow was blurred to the maximum right at its
          // walls. The filtered coverage is averaged with eight taps on two rings, each tap reading the 1x mask
          // bilinearly: nearest-texel taps laid eight hard copies of the mask over each other, which showed as
          // stair-stepped bands along every edge (live construction yards on XMP27T8). (Turning the rings per pixel
          // traded the bands for visible grain at 1:1.)
          If(
            isShadow.greaterThan(0.5).and(isInfantryShadow.lessThan(0.5)).and(look.shadowSoftness.greaterThan(1e-4)),
            () => {
              const offset: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60)));
              const reach: ShaderNode = length(max(offset.sub(baseCentre).abs().sub(foundationHalf), vec2(0, 0)));
              const radius: ShaderNode = look.shadowSoftness.mul(reach).mul(2.2).min(SHADOW_PENUMBRA_TEXELS);
              const occupiedAt = (k: ShaderNode): ShaderNode => {
                const inside: ShaderNode = step(lo, k).mul(float(1).sub(step(hi, k)));
                const index: ShaderNode = texture(atlasPage, k.add(0.5).div(atlasSize)).r.mul(255);
                return step(0.5, index).mul(inside.x).mul(inside.y);
              };
              const soft: ShaderNode = clamp(coverage, 0, 1).toVar();
              for (const [dx, dy] of PENUMBRA_TAPS) {
                const at: ShaderNode = texel.add(vec2(dx, dy).mul(radius)).sub(0.5);
                const k0: ShaderNode = floor(at);
                const f: ShaderNode = at.sub(k0);
                const top: ShaderNode = mix(occupiedAt(k0), occupiedAt(k0.add(vec2(1, 0))), f.x);
                const bottom: ShaderNode = mix(occupiedAt(k0.add(vec2(0, 1))), occupiedAt(k0.add(vec2(1, 1))), f.x);
                soft.addAssign(mix(top, bottom, f.y));
              }
              const blended: ShaderNode = mix(
                clamp(coverage, 0, 1),
                soft.div(PENUMBRA_TAPS.length + 1),
                smoothstep(0.3, 1.5, radius),
              );
              result.assign(vec4(0, 0, 0, blended.mul(shadowOpacity)));
            },
          );
          // Contact shade: soft darkening of the ground around a foundation.
          If(isContact.greaterThan(0.5), () => {
            const local: ShaderNode = vec2(px.div(60).add(py.div(30)), py.div(30).sub(px.div(60))).sub(
              foundationOrigin,
            );
            const shadeAlpha: ShaderNode = contactShade(local, aOcclusion.x, aOcclusion.y)
              .mul(look.occlusion)
              .mul(0.42)
              .toVar();
            If(look.contactShade.notEqual(1), () => {
              shadeAlpha.assign(shadeAlpha.mul(look.contactShade).min(0.85));
            });
            result.assign(vec4(0, 0, 0, shadeAlpha));
          });
          // Wet reflection: the lit art mirrored about its base line, on paved ground only, fading with distance.
          If(isReflection.greaterThan(0.5), () => {
            const rows: ShaderNode = reflectionRows();
            const qy: ShaderNode = rows.x.add(vCard.mul(rows.y.sub(rows.x)));
            const base: ShaderNode = baseRow(px);
            const below: ShaderNode = qy.sub(base);
            const tall: ShaderNode = max(base.sub(aParams.y), 8);
            // Wet paving mirrors only the lower part of what stands on it: the image fades within about a quarter of
            // the object's height (at most 42 engine px), sharpest in puddles.
            const fade: ShaderNode = exp(below.div(tall.mul(0.28).min(42)).negate()).mul(step(0, below));
            // Cell-centre class sampling prevents linear texture filtering from reflecting onto adjacent grass.
            const surface: ShaderNode = pavedAt(floor(positionWorld.xz).add(0.5), nodes);
            const puddle: ShaderNode = puddleNoise(positionWorld, float(1).sub(nodes.night));
            const strength: ShaderNode = look.reflections
              .mul(wet)
              .mul(surface)
              .mul(mix(float(0.1), float(0.22), puddle))
              .mul(fade);
            const alpha: ShaderNode = litAlpha
              .mul(strength)
              .min(WET_REFLECTION_MAX_OPACITY)
              .mul(weatherGroundClearAt(positionWorld.xz, nodes));
            result.assign(vec4(lit.mul(0.9), alpha));
          });
        });
        // Black shadow/contact RGB naturally darkens the already transformed receiver. Only cast-shadow coverage
        // fades under overcast (decorative rain/snow sun share, scene-event overcast); foundation contact shades and
        // infantry contact blobs keep their grounding role in every weather. Clear weather leaves this untouched.
        const sunShare = nodes.weatherSunShare.mul(nodes.sceneSunShadow);
        If(isShadow.greaterThan(0.5).and(isInfantryShadow.lessThan(0.5)).and(sunShare.notEqual(1)), () => {
          result.a.mulAssign(sunShare);
        });
        // The object's picture tint last: the game darkens, flashes and colours the whole finished picture.
        return vec4(
          applyObjectTint(result.rgb, aTint.x, aTint.y, grade.x, look.unlitBaseLight),
          result.a.mul(bodyOpacity),
        );
      })();
    const mainColour = colourNode();
    if (capture) {
      // Every vertex of an instance shares the anchor code, including across its SHP component pages.
      const code: ShaderNode = varying(
        attribute('spriteCaptureCode', 'float'),
        'objectDepthInstanceCode',
      ).setInterpolation('flat', 'either');
      this.captureCode = code;
      const kind: ShaderNode = varying(aFlat, 'objectDepthInstanceKind').setInterpolation('flat', 'either');
      material.colorNode = Fn(() => {
        // This object-group gate is recomputed for the actual capture target/camera. Main/mirror output and depth
        // use the original nodes unchanged. Ground-pass children never receive capture layers or this discard.
        If(capture.captureEnabled.greaterThan(0).and(code.equal(NOT_CAPTURED_CODE).or(kind.notEqual(0))), () =>
          Discard(),
        );
        return mainColour;
      })();
    } else material.colorNode = mainColour;

    bindUnlitSpriteMaterial(material, isUnlit, nodes);

    const readOnlyMaterial = new MeshBasicNodeMaterial();
    readOnlyMaterial.name = 'ra2-sprites-read-only';
    readOnlyMaterial.transparent = true;
    readOnlyMaterial.blending = NormalBlending;
    readOnlyMaterial.alphaTest = material.alphaTest;
    readOnlyMaterial.positionNode = placement('readOnly');
    readOnlyMaterial.colorNode = colourNode();
    readOnlyMaterial.depthNode = cardDepth();
    readOnlyMaterial.depthWrite = false;

    const unitMaterial = new MeshBasicNodeMaterial();
    unitMaterial.name = 'ra2-sprites-ground-units';
    unitMaterial.transparent = true;
    unitMaterial.blending = NormalBlending;
    unitMaterial.alphaTest = material.alphaTest;
    unitMaterial.positionNode = placement('unit');
    unitMaterial.colorNode = material.colorNode;
    unitMaterial.depthNode = cardDepth();

    const translucentMaterial = new MeshBasicNodeMaterial();
    translucentMaterial.name = 'ra2-sprites-translucent';
    translucentMaterial.transparent = true;
    translucentMaterial.blending = NormalBlending;
    translucentMaterial.alphaTest = material.alphaTest;
    translucentMaterial.positionNode = placement('translucent');
    translucentMaterial.colorNode = colourNode();
    translucentMaterial.depthNode = cardDepth();
    translucentMaterial.depthWrite = false;

    // Enhanced-look ground passes. In one draw call every ground decal wrote depth on the same plane (0.02 above the
    // ground), so coplanar decals z-fought: SHP shadows over contact shades, bibs and each other passed or failed by
    // rounding, and with shadows turning with the sun the pattern changed every minute of game time (whole shadows
    // popping, ladder stripes). The decals also sat 0.04 world units in front of the ground at their pixel, nearer
    // than an upright card's base (CARD_CLEARANCE 0.03), so a turned shadow hid the bottom rails of fences. With the
    // look on, the ground art is drawn in two passes before the cards (renderOrder just below this mesh's):
    //  - 'under': contact shades and decals (bibs, smudges, ore) in their draw order, without depth writes;
    //  - 'over': SHP shadows and wet reflections, depth-tested against a depth computed exactly from the pixel and the
    //    anchor's ground plane (identical for every instance on that plane), pulled forward by less than a card's
    //    clearance and by more for denser shadow (LessDepth): overlapping shadows darken a pixel once, a denser one
    //    may darken a fringe further, and nothing on the ground can hide a card.
    // The faithful look keeps the single pass (both ground passes are hidden, see HdRenderer).
    // The ground plane's depth under a pixel is affine in the pixel's coordinates and the plane's height for the
    // orthographic camera: depth = c0 + cx * x + cy * y + cY * height. The coefficients are set per draw from the
    // camera and target actually rendering (onBeforeRender below), so a pass with another camera (a reflection's
    // mirrored one) gets its own.
    const planeCoefficients = this.planeCoefficients;
    const planeDepth = Fn(() => {
      // The anchor's height, snapped to 1/64 level so interpolation rounding can never split one plane in two.
      const level: ShaderNode = round(aAnchor.y.div(LEVEL_HEIGHT).mul(64)).div(64).mul(LEVEL_HEIGHT);
      const c: ShaderNode = planeCoefficients;
      const ground: ShaderNode = c.x
        .add(c.y.mul(screenCoordinate.x))
        .add(c.z.mul(screenCoordinate.y))
        .add(c.w.mul(level));
      const texel = vec2(aRect.x.add(uv().x.mul(aRect.z)), aRect.y.add(vCard.mul(aRect.w)));
      const indexedCoverage = frameCoverage(atlasPage, atlasSize, texel, aRect);
      const coverage = features.hd
        ? mix(indexedCoverage, max(indexedCoverage, texture(hdColour, texel.div(atlasSize)).a), isInfantryShadow)
        : indexedCoverage;
      const level5: ShaderNode = floor(clamp(coverage, 0, 1).mul(4).add(0.5));
      // A solid infantry core must pass an earlier half-colour shadow, even when its filtered coverage is only .22.
      // Keep this ahead of ordinary shadow coverage ranks and behind both wet reflections and upright card feet.
      const shadowPull: ShaderNode = mix(
        float(GROUND_PULL.shadow[0]).add(level5.mul((GROUND_PULL.shadow[1] - GROUND_PULL.shadow[0]) / 4)),
        GROUND_PULL.infantryCore,
        isInfantryShadow.mul(step(INFANTRY_SHADOW_RAMP.to, coverage)),
      ).toVar('spriteInfantryShadowPull');
      const pull: ShaderNode = select(isReflection.greaterThan(0.5), float(GROUND_PULL.reflection), shadowPull);
      return ground.sub(pull.div(cameraFar.sub(cameraNear)));
    })();
    const passMaterial = (pass: GroundPass): MeshBasicNodeMaterial => {
      const m = new MeshBasicNodeMaterial();
      m.name = `ra2-sprites-${pass}`;
      m.transparent = true;
      m.blending = NormalBlending;
      m.alphaTest = material.alphaTest;
      m.positionNode = placement(pass);
      m.colorNode = colourNode();
      bindUnlitSpriteMaterial(m, isUnlit, nodes);
      if (pass === 'under') {
        m.depthNode = cardDepth();
        m.depthWrite = false;
      } else {
        m.depthNode = planeDepth;
        m.depthFunc = LessDepth;
      }
      return m;
    };
    this.materials = {
      main: material,
      readOnly: readOnlyMaterial,
      unit: unitMaterial,
      translucent: translucentMaterial,
      under: passMaterial('under'),
      over: passMaterial('over'),
    };
    // Upright cards have an outline of their own for the frame's outline pass (silhouette.ts), one per draw point:
    // the cards of one object (a building's body and the animations at its draw point) share it. Decals, shadows,
    // contact shades and wet reflections belong to the ground.
    const silhouette = instanceSilhouette(aAnchor, float(1).sub(step(0.5, aFlat)));
    for (const one of Object.values(this.materials)) setSilhouette(one, silhouette);
  }
}

const spriteGraphs = new WeakMap<Ra2Cache, Map<string, SpriteGraph>>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

/** A number for an object that is part of a graph's shader (0 for none). */
function objectId(object: object | null | undefined): number {
  if (!object) return 0;
  let id = objectIds.get(object);
  if (!id) objectIds.set(object, (id = nextObjectId++));
  return id;
}

/** The graph for a cache and a set of features, built on first use (the graphs live as long as the cache). */
function spriteGraphFor(cache: Ra2Cache, features: SpriteGraphFeatures): SpriteGraph {
  let graphs = spriteGraphs.get(cache);
  if (!graphs) spriteGraphs.set(cache, (graphs = new Map()));
  const key = [
    features.hd ? `hd${features.paintSaturation < 1 ? features.paintSaturation : ''}` : 'indexed',
    features.hdSupersample ? 'supersample' : '',
    features.windows ? 'windows' : '',
    features.materials ? 'materials' : '',
    objectId(features.capture),
    // The cache's depth template is read by the shader (its texture and size) and arrives with the type library,
    // after the map's own layers were built: layers made before and after it are different shaders.
    objectId(cache.depthTemplate),
    // Read by the shader as well; fixed for a cache's lifetime today, keyed so that a replaced one cannot be missed.
    objectId(cache.paletteAtlas),
    objectId(cache.mapLight),
    features.sampling.atlas,
    features.hd ? `${features.sampling.hd}/${features.sampling.remap}` : '',
    features.windows ? features.sampling.windows : '',
    features.materials ? features.sampling.materials : '',
  ].join('|');
  let graph = graphs.get(key);
  if (!graph) graphs.set(key, (graph = new SpriteGraph(cache, features)));
  return graph;
}

/**
 * Original SHP art as camera-facing cards. With the fixed orthographic camera a card of w x h pixels / PPU world units
 * covers exactly the pixels the engine would draw, so placement matches the original frame for frame. Colour comes
 * from the palette atlas at draw time (index 0 transparent, 16-31 house-remapped), which is also where HD
 * replacements will later plug in.
 */
export class SpriteLayer {
  readonly mesh: InstancedQuad;
  /** Test-only sprite parts share every instance buffer; visible only when such a part exists. */
  readonly readOnlyMesh: InstancedQuad;
  /** Ground cards follow test-only parts, so a door cannot paint over a unit that passed the body. */
  readonly unitMesh: InstancedQuad;
  /** Translucent bodies follow native unit color, retaining depth tests without writing an opaque silhouette. */
  readonly translucentMesh: InstancedQuad;
  /**
   * The enhanced look's ground passes ('under', 'over'; children of `mesh`, shown by HdRenderer only while the look is
   * on). They share this layer's instance buffers.
   */
  readonly groundPasses: InstancedQuad[];
  /**
   * Palette sprites' scene light level (display-referred instances bypass it) and the camera basis the cards face:
   * the uniforms of this layer's shader graph, shared by every layer of the same cache and features.
   */
  readonly light: SpriteGraph['light'];
  readonly cameraRight: SpriteGraph['cameraRight'];
  readonly cameraUp: SpriteGraph['cameraUp'];
  readonly toCamera: SpriteGraph['toCamera'];
  readonly capacity: number;
  private readonly anchor: DirtyAttribute;
  private readonly rect: DirtyAttribute;
  private readonly params: DirtyAttribute;
  /**
   * x: card/decal/shadow/contact/reflection (instanceCode); y: object light; z: map lighting class; w: bounded
   * traversal bias in world units for cards, ground-crystal weight for plain flat decals, or infantry shadow marker.
   * The second vec4 holds foundation width/height and draw-point offsets; width -1 selects an elevated deck.
   * Capture-enabled layers retain their relative anchor code at scalar 8. Two additional vec4s hold the native
   * depth mode/profile and owner offsets/pass (0 ordinary, 1 test-only, 2 ground unit, 3 + opacity translucent).
   * All attributes share one buffer: stride 16, or 17 with
   * capture, so native depth adds no vertex buffer (WebGPU allows eight).
   */
  private readonly flags: DirtyAttribute;
  private instances: readonly SpriteInstance[] = [];
  private readonly orderedCards: SpriteInstance[] = [];
  private instanceCount = 0;
  private readonly uploaded: SpriteInstance[] = [];

  /** Current records; static layers keep these and their depth profiles until the layer itself changes. */
  getInstances(): readonly SpriteInstance[] {
    return this.instances;
  }

  /** `capacity` > instances.length reserves room for setInstances (live objects). */
  constructor(
    private readonly cache: Ra2Cache,
    instances: SpriteInstance[],
    capacity = instances.length,
    /** Indexed atlas to read frames from (a type-library page); defaults to the map cache's sprite atlas. */
    atlas: { texture: Texture; width: number; height: number } = {
      texture: cache.spriteAtlas,
      width: cache.manifest.spriteAtlas.width,
      height: cache.manifest.spriteAtlas.height,
    },
    /**
     * Optional HD version of the same atlas (same layout, normalized UVs unchanged at any scale): full-colour art with
     * house-paint pixels written as a grey ramp, plus a mask of those pixels (see packages/ra2-assets spriteHd).
     * Shadows keep using the indexed atlas.
     */
    hd: HdAtlas | null = null,
    /**
     * Lit-window mask over the same atlas (R = lit, G = variant; ra2-assets windows.ts), same normalized UVs as the
     * indexed and HD atlases. Null: no windows.
     */
    windows: Texture | null = null,
    /**
     * Material atlas over the same atlas (sprites@2x-normals.png: world normal, specular class, occlusion; see
     * spriteLook.ts), same normalized UVs; its pixel dimensions can differ from both colour and indexed atlases.
     * Null: the enhanced look has no per-pixel normals for this layer (shadows, contact shades and reflections still
     * follow it).
     */
    materials: SpriteMaterialAtlas | null = null,
    private readonly capture: TerrainDepth | null = null,
  ) {
    const nodes = cache.nodes ?? DEFAULT_ATMOSPHERE_NODES;
    const look = spriteLookFor(nodes);
    this.capacity = Math.max(1, capacity, instances.length);
    const count = this.capacity;
    // Pack related fields into shared vertex buffers. Capacity never introduces an unused instance matrix.
    // Draw anchor, map-light sample and grade exemption share one buffer/attribute pair.
    // The picture tint (light factor, packed colour) rides in the same buffer: two more floats, no vertex buffer.
    this.anchor = new DirtyAttribute(new Float32Array(count * 8), 8);
    this.rect = new DirtyAttribute(new Float32Array(count * 4), 4);
    this.params = new DirtyAttribute(new Float32Array(count * 4), 4);
    const nativeOffset = capture ? 9 : 8;
    this.flags = new DirtyAttribute(new Float32Array(count * (nativeOffset + 8)), nativeOffset + 8);

    // The shader is the graph's, shared by every layer with the same features: this layer brings its instance
    // buffers (attributes of its geometry, read by name) and its pages (bound to the graph's slots before each draw).
    // Use colour-atlas pixels, not material pixels: material sidecars may have a different resolution.
    const hdScale = hd ? ((hd.color.image as { width?: number } | null)?.width ?? atlas.width) / atlas.width : 1;
    const graph = spriteGraphFor(cache, {
      hd: !!hd,
      hdSupersample: hdSupersampled(hd, hdScale),
      paintSaturation: hd ? (hd.paintSaturation ?? 1) : 1,
      windows: !!windows,
      materials: !!materials,
      capture,
      sampling: {
        atlas: samplingClass(atlas.texture),
        hd: hd ? samplingClass(hd.color) : 'filtered',
        remap: hd ? samplingClass(hd.remap) : 'filtered',
        windows: windows ? samplingClass(windows) : 'filtered',
        materials: materials ? samplingClass(materials.texture) : 'filtered',
      },
    });
    this.light = graph.light;
    this.cameraRight = graph.cameraRight;
    this.cameraUp = graph.cameraUp;
    this.toCamera = graph.toCamera;
    const geometry = instancedQuadGeometry();
    const anchors = this.anchor.interleaved();
    const flags = this.flags.interleaved();
    geometry.setAttribute('spriteAnchor', new InterleavedBufferAttribute(anchors, 3, 0));
    geometry.setAttribute('spriteLighting', new InterleavedBufferAttribute(anchors, 3, 3));
    geometry.setAttribute('spriteTint', new InterleavedBufferAttribute(anchors, 2, 6));
    geometry.setAttribute('spriteRect', this.rect);
    geometry.setAttribute('spriteParams', this.params);
    geometry.setAttribute('spriteFlags', new InterleavedBufferAttribute(flags, 4, 0));
    geometry.setAttribute('spriteOcclusion', new InterleavedBufferAttribute(flags, 4, 4));
    if (capture) geometry.setAttribute('spriteCaptureCode', new InterleavedBufferAttribute(flags, 1, 8));
    geometry.setAttribute('spriteNative', new InterleavedBufferAttribute(flags, 4, nativeOffset));
    geometry.setAttribute('spriteNativeOffset', new InterleavedBufferAttribute(flags, 4, nativeOffset + 4));
    const bind = (): void => {
      graph.atlasPage.value = atlas.texture;
      (graph.atlasSize.value as Vector2).set(atlas.width, atlas.height);
      graph.hdScale.value = hdScale;
      if (hd) {
        graph.hdColour.value = hd.color;
        graph.hdRemap.value = hd.remap;
      }
      if (windows) graph.windowsPage.value = windows;
      if (materials) graph.materialPage.value = materials.texture;
    };
    /** This layer's material for one pass: the graph's, drawn with this layer's pages. */
    const own = (prototype: MeshBasicNodeMaterial, captured = false): MeshBasicNodeMaterial => {
      const material = slotMaterial(prototype, bind);
      if (captured && graph.captureCode) material.userData.objectDepthCodeNode = graph.captureCode;
      return material;
    };
    const quad = (prototype: MeshBasicNodeMaterial, name: string, captured = false): InstancedQuad => {
      const mesh = new InstancedQuad(own(prototype, captured), count, geometry);
      mesh.name = name;
      mesh.onBeforeRender = bindSlotsBeforeRender;
      return mesh;
    };
    const material = graph.materials;
    this.mesh = quad(material.main, 'ra2-sprites', true);
    this.mesh.renderOrder = 4;

    this.readOnlyMesh = quad(material.readOnly, 'ra2-sprites-read-only');
    const main = this.mesh;
    Object.defineProperty(this.readOnlyMesh, 'renderOrder', {
      get: () => main.renderOrder + 0.001,
      set: () => {},
      configurable: true,
    });
    this.mesh.add(this.readOnlyMesh);

    this.unitMesh = quad(material.unit, 'ra2-sprites-ground-units', true);
    this.unitMesh.renderOrder = NATIVE_UNIT_RENDER_ORDER;
    this.mesh.add(this.unitMesh);

    this.translucentMesh = quad(material.translucent, 'ra2-sprites-translucent');
    this.translucentMesh.renderOrder = NATIVE_UNIT_RENDER_ORDER + 0.001;
    this.mesh.add(this.translucentMesh);

    this.groundPasses = (['under', 'over'] as const).map((pass, i) => {
      const passMesh = quad(material[pass], `ra2-sprites-${pass}`);
      passMesh.visible = false;
      // Just before this layer's own pass, whatever renderOrder its owner gives the layer later.
      Object.defineProperty(passMesh, 'renderOrder', {
        get: () => main.renderOrder - 0.02 + i * 0.01,
        set: () => {},
        configurable: true,
      });
      this.mesh.add(passMesh);
      look.groundPasses.add(passMesh);
      if (pass === 'over')
        // The ground plane's depth coefficients are set per draw from the camera and target actually rendering
        // (see SpriteGraph), so a pass with another camera (a reflection's mirrored one) gets its own.
        passMesh.onBeforeRender = (renderer, _scene, camera, _geometry, drawn) => {
          bindSlots(drawn);
          const target = renderer.getRenderTarget();
          if (target) planeSize.set(target.width, target.height);
          else renderer.getDrawingBufferSize(planeSize);
          groundPlaneDepth(camera as OrthographicCamera, planeSize.x, planeSize.y, graph.planeCoefficients.value);
        };
      return passMesh;
    });
    const passes = [this.readOnlyMesh, this.unitMesh, this.translucentMesh, ...this.groundPasses];
    this.mesh.material.addEventListener('dispose', () => {
      for (const passMesh of passes) passMesh.material.dispose();
    });
    this.mesh.addEventListener('dispose', () => {
      this.readOnlyMesh.dispose();
      this.unitMesh.dispose();
      this.translucentMesh.dispose();
      capture?.setCaptured(this.mesh, false);
      capture?.setCaptured(this.unitMesh, false);
      for (const passMesh of this.groundPasses) {
        look.groundPasses.delete(passMesh);
        passMesh.dispose();
      }
    });
    this.setInstances(instances);
  }

  /** With unchanged membership/metadata, interpolation only updates the retained records and skips ordering. */
  setInstances(instances: readonly SpriteInstance[], reorder = true): void {
    this.instances = instances;
    const cards = this.orderedCards;
    // Instanced meshes are not sorted by Three. Back-to-front within each page preserves soft-edge blending;
    // physical fragment depth resolves opaque overlaps between pages and voxel meshes independently of draw calls.
    if (reorder || instances.length !== this.instanceCount) {
      cards.length = 0;
      for (const instance of instances) if (instanceRank(instance) === 3) cards.push(instance);
      cards.sort(compareCards);
    }
    this.instanceCount = instances.length;
    // Stable partition by rank: the former stable sort's exact order, without a copied/sorted array.
    let count = 0;
    let readOnly = false;
    let units = false;
    let translucent = false;
    for (let rank = 0; rank < 4 && count < this.capacity; rank++) {
      const list = rank === 3 ? cards : instances;
      for (let j = 0; j < list.length && count < this.capacity; j++) {
        const s = list[j]!;
        if (instanceRank(s) !== rank) continue;
        const i = count++;
        if (this.capture) this.uploaded[i] = s;
        this.anchor.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
        this.anchor.setComponent(i, 3, s.lightSample?.[0] ?? s.anchor.x);
        this.anchor.setComponent(i, 4, s.lightSample?.[1] ?? s.anchor.z);
        this.anchor.setComponent(i, 5, (s.gradeExempt ? 1 : 0) + (s.indexedHousePaint ? 2 : 0));
        const tinted = !s.shadow && !s.kind;
        this.anchor.setComponent(i, 6, tinted ? (s.tintLight ?? 1) : 1);
        this.anchor.setComponent(i, 7, tinted ? (s.tintColour ?? 0) : 0);
        this.rect.setXYZW(i, s.frame.rect[0], s.frame.rect[1], s.frame.rect[2], s.frame.rect[3]);
        this.params.setXYZW(i, s.frame.offset[0], s.frame.offset[1], paletteRowOf(this.cache, s.palette), s.push);
        this.flags.setXYZW(
          i,
          instanceCode(s),
          s.light ?? 1,
          s.unlit ? 3 : LIGHTING_CODE[s.lighting ?? 'ambient'],
          instanceCode(s) === 1
            ? Math.max(0, Math.min(1, s.glint ?? 0))
            : s.shadow && s.infantryShadow
              ? s.infantryBare
                ? 2
                : 1
              : s.shadow && s.terrainShadow
                ? -1
                : s.flat || s.shadow || s.kind
                  ? 0
                  : s.painter
                    ? spritePainterBias(s.painter, s.painterPart)
                    : (s.tieBias ?? 0),
        );
        const foundation = s.painter?.foundation;
        const dx = foundation ? s.anchor.x - s.painter!.x : 0;
        const dz = foundation ? s.anchor.z - s.painter!.z : 0;
        if (this.capture) this.flags.setComponent(i, 8, NOT_CAPTURED_CODE);
        this.flags.setComponent(i, 4, s.deckHeight !== undefined ? -1 : (foundation?.[0] ?? 0));
        this.flags.setComponent(i, 5, s.deckHeight ?? foundation?.[1] ?? 0);
        this.flags.setComponent(i, 6, dx - dz);
        this.flags.setComponent(i, 7, -dx - dz);
        const native = !s.flat && !s.shadow && !s.kind ? s.nativeDepth : undefined;
        const at = this.capture ? 9 : 8;
        this.flags.setComponent(i, at, native?.mode === 'body' ? 1 : native?.mode === 'ground' ? 2 : native ? 3 : 0);
        this.flags.setComponent(
          i,
          at + 1,
          native?.mode === 'body' ? native.origin[0] : native?.mode === 'card' ? native.bottom : 0,
        );
        this.flags.setComponent(
          i,
          at + 2,
          native?.mode === 'body' ? native.origin[1] : native?.mode === 'card' ? native.bonus : 0,
        );
        this.flags.setComponent(
          i,
          at + 3,
          native?.mode === 'body' ? native.base : native?.mode === 'ground' ? native.bonus : 0,
        );
        this.flags.setComponent(i, at + 4, native?.offset?.[0] ?? 0);
        this.flags.setComponent(i, at + 5, native?.offset?.[1] ?? 0);
        this.flags.setComponent(i, at + 6, native?.anchorPush ?? 0);
        const opacity = instanceCode(s) === 0 ? Math.max(0, Math.min(1, s.opacity ?? 1)) : 1;
        const blending = opacity < 1;
        const testOnly = !blending && s.depthWrite === false && instanceCode(s) === 0;
        const unit = !testOnly && native?.mode === 'card' && !native.writer && !foundation;
        this.flags.setComponent(i, at + 7, blending ? 3 + opacity : testOnly ? 1 : unit ? 2 : 0);
        readOnly ||= testOnly;
        units ||= !blending && unit;
        translucent ||= blending;
      }
    }
    if (this.capture) this.uploaded.length = count;
    // Every pass draws the layer's one geometry: its instance count is theirs.
    this.mesh.instances = count;
    this.readOnlyMesh.visible = readOnly;
    this.unitMesh.visible = units;
    this.translucentMesh.visible = translucent;
    this.anchor.flush();
    this.rect.flush();
    this.params.flush();
    this.flags.flush();
  }
  /** Update only the retained anchor code; main/mirror colours and surface depth are unchanged. */
  updateCaptureCodes(codeFor: (instance: SpriteInstance) => number): void {
    if (!this.capture) return;
    let captured = false;
    let unitsCaptured = false;
    for (let i = 0; i < this.uploaded.length; i++) {
      const instance = this.uploaded[i]!;
      const value =
        instanceCode(instance) === 0 && instance.depthWrite !== false && (instance.opacity ?? 1) >= 1
          ? codeFor(instance)
          : NOT_CAPTURED_CODE;
      this.flags.setComponent(i, 8, value);
      captured ||= value !== NOT_CAPTURED_CODE;
      unitsCaptured ||=
        value !== NOT_CAPTURED_CODE &&
        instance.nativeDepth?.mode === 'card' &&
        !instance.nativeDepth.writer &&
        !instance.painter?.foundation;
    }
    this.flags.flush();
    this.capture.setCaptured(this.mesh, captured);
    this.capture.setCaptured(this.unitMesh, unitsCaptured);
  }
}

function compareCards(a: SpriteInstance, b: SpriteInstance): number {
  if (a.painter && b.painter)
    return comparePainterOrder(a.painter, b.painter) || (a.painterPart ?? 0) - (b.painterPart ?? 0);
  if (a.painter || b.painter) return Number(!!a.painter) - Number(!!b.painter);
  return a.anchor.x + a.anchor.z - b.anchor.x - b.anchor.z;
}

/**
 * World anchor for a map object's engine draw point: the projected top corner of its cell plus `drawOffset`, lifted
 * back onto the ground plane at the object's level so the card sits where the engine draws it.
 */
export function objectAnchor(object: MapObject, out = new Vector3()): Vector3 {
  const sx = (object.x - object.y) * 30;
  const sy = (object.x + object.y) * 15 - object.z * 15;
  const dx = object.drawOffset?.[0] ?? 0;
  const dy = object.drawOffset?.[1] ?? 15;
  const diff = (sx + dx) / 30;
  const sum = (sy + dy + object.z * 15) / 15;
  return out.set((sum + diff) / 2, object.z * LEVEL_HEIGHT, (sum - diff) / 2);
}
