import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BlendMode,
  Color,
  DataTexture,
  NeutralToneMapping,
  MaterialBlending,
  NormalBlending,
  NoColorSpace,
  NoToneMapping,
  PCFSoftShadowMap,
  RedFormat,
  RenderPipeline,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGPURenderer,
  type Texture,
  type ToneMapping,
  type NodeBuilder,
} from 'three/webgpu';
import {
  Fn,
  depth as physicalDepth,
  dot,
  float,
  length,
  max,
  mix,
  mrt,
  neutralToneMapping,
  output as materialOutput,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  texture,
  toneMapping,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import {
  AtmosphereNodes,
  DEFAULT_ATMOSPHERE,
  DEFAULT_ATMOSPHERE_NODES,
  DEFAULT_ATMOSPHERE_SETTINGS,
  type AtmosphereSettings,
  type FrameAtmosphere,
} from './atmosphere';
import type { AtmosphereProfile, RenderEvent, RenderState } from './contract';
import { EffectsLayer } from './effects';
import { TerrainDepth } from './terrainDepth';
import { FRONT_DISTANCE } from './ra2/fireEngulf';
import { EmitterLayer, type Emitter } from './emitters';
import { EmissiveOverlay, emissiveMrtSupported } from './emissiveOverlay';
import { LightField, type DynamicLight } from './lightField';
import { Lighting, clearLightAt, noonFlatLuminance } from './lighting';
import { computeSceneMultipliers, type SceneLighting } from './sceneLighting';
import { medianHeight } from '../../ra2-assets/src/lights';
import { Mist, MIST_CAP } from './mist';
import { ObjectLayer } from './objects';
import { cinematicGrade, faithfulToneMap, hasCinematicGrade, neutralGrade, type CinematicGradeParams } from './post';
import { buildTerrain, type TerrainBuild } from './terrain';
import type { ShaderNode } from './tsl';
import { buildWater, type WaterUniforms } from './water';
import { buildRain, buildSnow, type RainSystem } from './weather';
import { steepWeatherCells, WeatherGroundMask } from './weatherGroundMask';
import { VOXEL_FILL } from './ra2/voxels';
import { groundFromHeights, setShadowGround, shadowShear, voxelShadowFor } from './ra2/voxelShadow';
import { voxelLightingFor } from './ra2/vpl';
import { voxelPbrFor } from './ra2/voxelPbr';
import {
  ART_REFERENCE_HOUR,
  ART_SKY_SHARE,
  relightFactorUpper,
  shadowStretch,
  shadowTransform,
  spriteLookFor,
} from './ra2/spriteLook';
import type { HdWorld } from './ra2/world';
import { IsoCamera, LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE, cellToWorld } from './world';

/** 'faithful' (default): identity below the knee, hue-preserving shoulder above (see post.ts). */
export type ToneMapper = 'faithful' | 'agx' | 'neutral' | 'aces';

/**
 * 'msaa4': 4x multisampled scene pass (default); 'fxaa': single-sample pass plus FXAA, the cheaper fallback. At
 * 2400x1500 device pixels the multisampled scene colour (RGBA16F) and depth take about 115 MB and 58 MB (plus a
 * 29 MB resolve texture), against about 29 MB and 14 MB single-sampled; devices reporting 4 GB of memory or less
 * (navigator.deviceMemory) default to 'fxaa'.
 */
export type Antialias = 'msaa4' | 'fxaa' | 'none';

/** Without supported MRT blending, keep the legacy scene graph and omit the overlay entirely. */
export function emissiveOverlayEnabled(
  settings: Pick<HdSettings, 'sourceLights' | 'debugView'>,
  supportsMrt: boolean,
): boolean {
  return supportsMrt && settings.sourceLights > 0 && settings.debugView === 'none';
}

/** Default anti-aliasing for this device (see Antialias). */
export function defaultAntialias(): Antialias {
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return memory !== undefined && memory <= 4 ? 'fxaa' : 'msaa4';
}

export interface HdSettings extends CinematicGradeParams {
  /** Load-time voxel geometry selection. Changing it requires rebuilding the world's voxel units. */
  voxelLook: 'engine' | 'remaster';
  toneMapper: ToneMapper;
  exposure: number;
  bloom: number;
  vignette: number;
  shadows: boolean;
  antialias: Antialias;
  /** RCAS sharpening after the display transform: 0 = strongest, 2 = off (three's SharpenNode scale); < 0 disables. */
  sharpness: number;
  /**
   * Mid-scale local contrast ("clarity") on the display-referred image: the luminance band between blurs of
   * CLARITY_FINE and CLARITY_SIGMA CSS px is added back this many times (shaded side at half strength), in the
   * mid-tones only. Models the forms (faces, crevices, canopy masses) the way the approved targets do without adding
   * pixel-scale grain or deepening shade. 0 leaves the pass out entirely.
   */
  clarity: number;
  /**
   * Diagnostics: 'overbright' shows white where the exposed scene (before bloom and tone map) exceeds luminance 1;
   * 'voxel-xy' / 'voxel-z' write raw voxel attributes (see ra2/vpl.ts voxelDebug) straight to the screen, for fitting
   * the voxel lighting against captures of the original.
   */
  debugView: 'none' | 'overbright' | 'voxel-xy' | 'voxel-z';
  /**
   * Enhanced look on original art (ra2/spriteLook.ts), opt-in: with every effect strength 0 and the depth gains below
   * at 1 the frame is the faithful one, bit for bit. relight: the sun relights building and tree art as a delta on its
   * baked shading (needs the map's sprite material atlas or the live library page's); specular: sun highlights on
   * facades and roofs; glass: sky reflection
   * and glints on window panes; occlusion: baked occlusion and soft ground contact under buildings; shadowFollow:
   * SHP shadows turn and stretch with the sun; shadowSoftness: their penumbra grows with distance; wetReflections:
   * buildings and trees mirrored on wet paving; sourceLights: HD emitter gain (0 adds nothing).
   */
  relight: number;
  specular: number;
  /** Window glass of the material atlas: sky reflection and sun glints (0 = the art's panes as drawn). */
  glass: number;
  occlusion: number;
  shadowFollow: number;
  shadowSoftness: number;
  wetReflections: number;
  /** HD source irradiance and emitter glow gain: 0 = none, 1 = authored strength. */
  sourceLights: number;
  /**
   * Directional contrast of the relighting: 1 keeps the scene's own sky-to-sun ratio; above 1 the sun dominates the
   * sky (sunlit faces brighter and warmer, shaded faces darker and cooler), as in low evening light.
   */
  lightContrast: number;
  /** Sun weight in sprite relighting and voxel directional light; 1 preserves the existing light (sky unchanged). */
  sunGain: number;
  /** Highlight roughness gain (capped at 0.9) and squared intensity gain; glass scales by its square root. Neutral: 1. */
  specularSize: number;
  /** Baked sprite/voxel AO exponent; 1 takes the original occlusion value without evaluating a power. */
  aoPower: number;
  /** Enhanced foundation and terrain contact shade gain (alpha capped at 0.85); neutral: 1. */
  contactShade: number;
  /** SHP/voxel sun-following shadow stretch gain, including its readability cap; neutral: 1. */
  shadowLength: number;
  /** Enhanced SHP/voxel shadow opacity gain (capped at 0.9); neutral: 1, faithful retains engine opacity. */
  shadowDarkness: number;
  /** 'fixed': the classic light azimuth at every hour; 'arc': the sun travels east to west (Lighting.sunArc). */
  sunPath: 'fixed' | 'arc';
  /** 0: daylight keeps noon's exposure (faithful); 1: flat ground keeps noon's brightness at every daylight hour. */
  adaptExposure: number;
  /** 0: noon white balance (faithful); 1: current flat-ground white balance, preserving luminance. Fades at night. */
  whiteAdapt: number;
  /**
   * 0: the map's own [Lighting] Red/Green/Blue tint shows as authored (faithful; XMP29U2 is 1/0.8/0.68, a strong warm
   * cast); 1: the tint is divided out of the daylight exposure, luminance kept, so neutral greys render neutral.
   * In between, the correction is the tint's inverse raised to this power. Fades with the map light's own day weight.
   */
  mapTintAdapt: number;
  /**
   * Share of the map's light sources (lamp posts such as INGALITE: +50 % at the post, about 15 cells round) in the
   * map's day light (1: the engine's, faithful; the night presentation owns lamps after dusk). Real street lamps do not
   * brighten sunlit ground; at full share a city park framing renders its lawn at L* 53 against the approved target's
   * 45 (without lamps 34), and a Tesla reactor next to a lamp sits on near-white pavement.
   */
  mapSourcesByDay: number;
  /** Voxel sheen strength, sheen cap and crease occlusion (ra2/vpl.ts); null leaves the voxel material as it is. */
  voxelSheen: number | null;
  voxelSheenCap: number | null;
  voxelOcclusion: number | null;
}

/** Named looks, including the approved S2 direction with medium cooling (settings plus a suggested hour). */
export type LookPreset = 'faithful' | 'golden' | 'cinematic';

type LookSettings = Partial<HdSettings> &
  CinematicGradeParams &
  Pick<
    HdSettings,
    | 'whiteAdapt'
    | 'mapTintAdapt'
    | 'mapSourcesByDay'
    | 'sunGain'
    | 'clarity'
    | 'specularSize'
    | 'aoPower'
    | 'contactShade'
    | 'shadowLength'
    | 'shadowDarkness'
  >;

const GOLDEN_SETTINGS: LookSettings = {
  relight: 1,
  specular: 1,
  glass: 1,
  occlusion: 1,
  shadowFollow: 1,
  shadowSoftness: 1,
  wetReflections: 1,
  sourceLights: 1,
  lightContrast: 1.5,
  sunGain: 1,
  specularSize: 1,
  aoPower: 1,
  contactShade: 1,
  shadowLength: 1,
  shadowDarkness: 1,
  clarity: 0,
  sunPath: 'arc',
  adaptExposure: 0.85,
  bloom: 0.5,
  voxelSheen: 1,
  voxelSheenCap: 0.35,
  voxelOcclusion: 0.35,
  whiteAdapt: 0,
  mapTintAdapt: 0,
  mapSourcesByDay: 1,
  ...neutralGrade(),
};

export const LOOK_PRESETS: Record<LookPreset, { settings: LookSettings; hour?: number }> = {
  faithful: {
    settings: {
      relight: 0,
      specular: 0,
      glass: 0,
      occlusion: 0,
      shadowFollow: 0,
      shadowSoftness: 0,
      wetReflections: 0,
      sourceLights: 0,
      lightContrast: 1,
      sunGain: 1,
      specularSize: 1,
      aoPower: 1,
      contactShade: 1,
      shadowLength: 1,
      shadowDarkness: 1,
      clarity: 0,
      sunPath: 'fixed',
      adaptExposure: 0,
      bloom: 0.55,
      voxelSheen: 0,
      voxelSheenCap: 0.05,
      voxelOcclusion: 0.15,
      whiteAdapt: 0,
      mapTintAdapt: 0,
      mapSourcesByDay: 1,
      ...neutralGrade(),
    },
  },
  golden: {
    hour: 16.5,
    settings: GOLDEN_SETTINGS,
  },
  // The approved S2 grade with medium cooling, calibrated on the three approved targets (city park and battle areas of
  // XMP29U2, ref_river of RiverRam; scratchpad finallook4/water/cal): neutral greys (asphalt, concrete) measured at
  // a* 1.9-2.1 / b* 2.5-4.5 against the targets' 1.1-1.7 / 1.6-1.9 (golden: 5.5 / 9-11), brick and the river's water
  // within about one a*/b* unit. White balance to the hour's flat-ground light, a third of the map's own warm tint divided out,
  // a slightly cool residual balance, cool shadows and warm sunlit highlights (warmth from the sun only).
  cinematic: {
    hour: 16.5,
    settings: {
      ...GOLDEN_SETTINGS,
      sunGain: 1.25,
      specularSize: 1.6,
      aoPower: 1.5,
      contactShade: 1.5,
      shadowLength: 1.4,
      shadowDarkness: 1.15,
      // L5 depth pass (scratchpad finallook5/light, metrics against the battle and park targets): the band-pass clarity
      // brings mid-scale local contrast to the battle target's (|blur2 - blur8| of L* 5.0 -> 5.7, target 5.7) without
      // pixel-scale grain; a gentler S-curve with a higher pivot lifts the too-dark mid-tones and deep-shade share
      // (battle L* median 33 -> 36, target 39; L* < 22 share 23% -> 17%, target 17%), while the stronger sun, contact
      // and AO knobs above keep the sun/shade split at the target's (blurred p90 - p10 of L* 36-38, target 34).
      clarity: 0.55,
      // L5G battle warmth from the light, not the tiles (scratchpad finallook7/light, same battle/park/river framings):
      // the approved targets flip the original grass order (originals: battle grass S-weighted hue 59, park lawn 53;
      // targets: battle 52 golden, park 63 green) on shared foliage, so no global tile or grade change can serve both.
      // Keeping 15 % of the afternoon sun's colour on flat ground (whiteAdapt 0.85) warms the open battle grass
      // (hue 63.6 -> 62.2) and the river's highlights (warmth 0.36 -> 0.37, target 0.44); fewer daytime lamp washes
      // (mapSourcesByDay 0.2) keep the lamp-lit park lawn green (hue 58, the owner's floor) at L* 44 (target 45).
      // Noon flat-ground brightness (adaptExposure 1) helped the battle grass little and over-brightened the river.
      whiteAdapt: 0.85,
      mapTintAdapt: 0.3,
      mapSourcesByDay: 0.2,
      gradeBalance: [0.955, 1, 1.085],
      gradeContrast: 0.14,
      gradePivotLift: 0.045,
      gradeSaturation: 1.08,
      gradeShadowTint: [0.8, 1, 1.2],
      gradeHighlightTint: [1.15, 1, 0.85],
    },
  },
};

/** Apply a named look to renderer settings (call applySettings() afterwards); returns its suggested hour. */
export function applyLookPreset(settings: HdSettings, preset: LookPreset): number | undefined {
  const look = LOOK_PRESETS[preset].settings;
  Object.assign(settings, look);
  // GUI channel edits must never mutate a preset or another renderer's settings.
  settings.gradeBalance = [...look.gradeBalance];
  settings.gradeShadowTint = [...look.gradeShadowTint];
  settings.gradeHighlightTint = [...look.gradeHighlightTint];
  return LOOK_PRESETS[preset].hour;
}

/** Clarity band (CSS px, sigma): above CLARITY_FINE (pixel-scale texture) and below CLARITY_SIGMA (whole faces). */
const CLARITY_FINE = 1.25;
const CLARITY_SIGMA = 5;

/** Exposure adaptation never lifts the frame by more than this factor. */
const MAX_ADAPT = 2.2;

/**
 * Divide a map's [Lighting] colour tint out of the exposure in place (amount 0..1 as a power of the inverse tint),
 * keeping the Rec.709 luminance of a neutral surface under that tint unchanged.
 */
export function neutralizeMapTint(
  exposure: Color,
  tint: { red: number; green: number; blue: number },
  amount: number,
): Color {
  const weight = Math.min(1, Math.max(0, amount));
  if (weight <= 0) return exposure;
  const r = Math.max(1e-3, tint.red);
  const g = Math.max(1e-3, tint.green);
  const b = Math.max(1e-3, tint.blue);
  const level = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const gr = (level / r) ** weight;
  const gg = (level / g) ** weight;
  const gb = (level / b) ** weight;
  const scale = level / (0.2126 * r * gr + 0.7152 * g * gg + 0.0722 * b * gb);
  return exposure.setRGB(exposure.r * gr * scale, exposure.g * gg * scale, exposure.b * gb * scale);
}

/** Adapt exposure in place, keeping the Rec.709 luminance of a flat-lit neutral surface unchanged. */
export function adaptWhiteBalance(exposure: Color, noon: Color, flat: Color, amount: number, night: number): Color {
  const weight = Math.min(1, Math.max(0, amount)) * (1 - night);
  if (weight <= 0) return exposure;
  // Geometric gain interpolation: currentGain / noonGain = noon irradiance / current irradiance.
  const r = (noon.r / Math.max(1e-6, flat.r)) ** weight;
  const g = (noon.g / Math.max(1e-6, flat.g)) ** weight;
  const b = (noon.b / Math.max(1e-6, flat.b)) ** weight;
  const before = 0.2126 * flat.r * exposure.r + 0.7152 * flat.g * exposure.g + 0.0722 * flat.b * exposure.b;
  const after = 0.2126 * flat.r * exposure.r * r + 0.7152 * flat.g * exposure.g * g + 0.0722 * flat.b * exposure.b * b;
  const scale = before / Math.max(1e-6, after);
  return exposure.setRGB(exposure.r * r * scale, exposure.g * g * scale, exposure.b * b * scale);
}

const TONE_MAPPERS: Record<Exclude<ToneMapper, 'faithful'>, ToneMapping> = {
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
};

/** Everything visible: the default visibility mask (no shroud). */
const ALL_VISIBLE = new DataTexture(new Uint8Array([255]), 1, 1, RedFormat, UnsignedByteType);
ALL_VISIBLE.needsUpdate = true;

/**
 * A flat visibility mask on the ground plane y = 0 (a live view's shroud), for setVisibility: a linear-filtered texture
 * covering the world rectangle `origin` .. `origin + size` (x, z) edge to edge, and how a filtered texel turns into
 * visibility 0..1 (default: its red channel).
 */
export interface VisibilityMask {
  texture: Texture;
  origin: readonly [number, number];
  size: readonly [number, number];
  /** Shader function of the sampled texel (vec4); changing it rebuilds the post pipeline. */
  shape?: (texel: ShaderNode) => ShaderNode;
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Share of the moonlit term's saturation removed at full night (see moonDesaturation). */
const NIGHT_DESATURATION = 0.3;
/**
 * Display toe lift at full night (encoded output, cool moonlit grey): out + lift x (1 - out / NIGHT_TOE)^2 below
 * NIGHT_TOE. The tone mapper's toe crushes scene values below about 0.03 quadratically, so shadows and dark facades fell
 * to 6-9 of 255 (5th luminance percentile); this raises them to about 12-15 (concept C: 18) and leaves mid-tones,
 * their saturation and white untouched (a flat lift veiled wide night views in grey). Never under shroud.
 */
const NIGHT_BLACK_LIFT = [0.03, 0.034, 0.042] as const;
const NIGHT_TOE = 0.3;

/** Night weights over which lit windows fade in. */
const WINDOW_NIGHT = [0.25, 0.85] as const;

/** Diagnostics for screenshots and performance runs (window.__hd.stats() in the sandbox). */
export interface HdStats {
  backend: string;
  exposure: number;
  hour: number;
  night: number;
  nightLevel: number | null;
  staticGain: number;
  staticLights: number;
  dynamicLights: { explosion: number; flash: number; kept: number; sources: number };
  lightFieldRenders: number;
  emitters: number;
  mist: number;
  wet: number;
  rain: number;
  snow: number;
  pointLights: number;
  /** Scene light level relative to clear noon (rain streaks and smoke scale with it). */
  sceneBrightness: number;
  /** Lit-window and lamp-head strength (0 by day). */
  windowGain: number;
  lampGain: number;
  dressing: Record<string, number>;
  /**
   * Interval between presented frames (ms): pacing, not cost. The sandbox's ?perf=1 loop drives frames faster than
   * three's own animation loop advances its node frame, so not every interval re-renders every pass. Measure cost with
   * benchmark() (scripts/gpubench.mjs).
   */
  frameMs: { median: number; p95: number; frames: number } | null;
  /**
   * Sum of per-pass GPU timestamp durations per sandbox frame (?perf=1). Unusable on Apple GPUs (hundreds of ms per
   * frame: passes overlap, include queueing, and three keys its queries by its own frame counter); diagnostics only.
   */
  gpuTimestampMs: { median: number; p95: number; frames: number } | null;
}

/**
 * Bloom only picks up light above this exposed luminance. Original art at clear noon stays at or below 1 (see post.ts),
 * so only effect cores and specular glints glow; white cars and concrete do not.
 */
const BLOOM_THRESHOLD = 1.0;
/** Bloom threshold of the night presentation, on the unexposed scene (as it was tuned). */
const NIGHT_BLOOM_THRESHOLD = 0.85;

/**
 * Consumes RenderState snapshots and draws the HD battlefield. It owns no game rules and never writes game state:
 * visual randomness, interpolation and effects live entirely on this side of the contract.
 */
export class HdRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  /** Native top-layer effect art is composited after the ground visibility mask. */
  readonly topScene = new Scene();
  private topEffectsVisible = false;
  private sceneLighting: SceneLighting | null = null;
  private sceneSkyFlash = 0;
  private sceneMedianZ = 0;
  /** Effect art follows the authored time/weather light, never a scene event's overcast or palette. */
  readonly effectLight = new Color(1, 1, 1);
  private readonly eventFreeIrradiance = new Color();
  readonly view = new IsoCamera();
  readonly settings: HdSettings = {
    voxelLook: 'engine',
    toneMapper: 'faithful',
    exposure: 1,
    bloom: 0.55,
    vignette: 0.25,
    shadows: true,
    antialias: defaultAntialias(),
    // Mild: stronger RCAS (toward 0) turns upscaled grass and gravel crunchy at zoom 1.6.
    sharpness: 1,
    debugView: 'none',
    relight: 0,
    specular: 0,
    glass: 0,
    occlusion: 0,
    shadowFollow: 0,
    shadowSoftness: 0,
    wetReflections: 0,
    sourceLights: 0,
    lightContrast: 1,
    sunGain: 1,
    specularSize: 1,
    aoPower: 1,
    contactShade: 1,
    shadowLength: 1,
    shadowDarkness: 1,
    clarity: 0,
    sunPath: 'fixed',
    adaptExposure: 0,
    whiteAdapt: 0,
    mapTintAdapt: 0,
    mapSourcesByDay: 1,
    ...neutralGrade(),
    voxelSheen: null,
    voxelSheenCap: null,
    voxelOcclusion: null,
  };
  /** Night presentation: map lights, HD lamps, windows, mist, night level (changeable at runtime). */
  readonly atmosphere: AtmosphereSettings = { ...DEFAULT_ATMOSPHERE_SETTINGS };
  private pipeline: RenderPipeline | undefined;
  /** Only structural changes rebuild render targets; grade values themselves stay in uniforms. */
  private pipelineKey = '';
  /** Nodes of the current pipeline that own render targets (pass targets, bloom, FXAA and sharpen), freed on rebuild. */
  private pipelineNodes: { dispose(): void }[] = [];
  private readonly bloomStrength = uniform(0.55);
  private readonly clarityAmount = uniform(0);
  /** Bloom threshold on the unexposed scene (see frame()). */
  private readonly bloomThreshold = uniform(NIGHT_BLOOM_THRESHOLD);
  private readonly blackLift = uniform(new Color(0, 0, 0));
  /** Share of PBR Neutral in the faithful display transform: the night weight on original maps (see post.ts). */
  private readonly nightDisplay = uniform(0);
  private readonly gradeUniforms = {
    gradeBalance: uniform(new Vector3(1, 1, 1)),
    gradeContrast: uniform(0),
    gradePivotLift: uniform(0),
    gradeSaturation: uniform(1),
    gradeShadowTint: uniform(new Vector3(1, 1, 1)),
    gradeHighlightTint: uniform(new Vector3(1, 1, 1)),
  };
  private readonly vignetteStrength = uniform(0.25);
  /**
   * Scene exposure per channel, applied before bloom and the display transform (the built-in tone mappers get
   * exposure 1). For original maps it is pi / (flat-ground irradiance at clear noon), per channel: a white balance
   * to the noon reference, so terrain, sprites and voxels show exactly their original colours at noon although the
   * noon sun is slightly warm and the sky blue.
   */
  private readonly exposure = uniform(new Color(1, 1, 1));
  /** Flat-ground irradiance at clear noon (per channel), measured once from the lighting model. */
  private readonly noonIrradiance = new Color();
  private readonly lighting: Lighting;
  private readonly objects: ObjectLayer;
  /** HD effects; live views spawn into it from the game's own effect list. */
  readonly effects: EffectsLayer;
  /** Generic capture; game views select terrain mains and near whole-object parts for per-fire decisions. */
  readonly terrainDepth = new TerrainDepth(FRONT_DISTANCE);
  /** Presentation owner may refresh per-object capture membership after this frame's poses and camera are final. */
  beforeDepthCapture?: () => void;
  /** Lamp heads and wet-ground reflections. */
  readonly emitters: EmitterLayer;
  readonly emissiveOverlay: EmissiveOverlay;
  /** Every local light as irradiance on the ground; created in init() once the map size is known. */
  lightField!: LightField;
  private readonly mist: Mist;
  /** Existing public layers retain their shader nodes if init() adopts a world loaded later. */
  private readonly layerNodes: AtmosphereNodes;
  /** Shader inputs owned by this renderer and its world materials. */
  nodes: AtmosphereNodes;
  private disposed = false;
  /** Whether the current pipeline composites the mist (rebuilt when the mist starts or stops). */
  private mistInPipeline = false;
  private painterDepthEnabled = false;
  /**
   * Per-cell visibility on the flat y = 0 plane (1 visible .. 0 black shroud), applied after the mist and before bloom
   * so nothing under shroud (terrain, lights, mist, glow) shows through. Set by live views; everything visible
   * otherwise.
   */
  private readonly visibility = texture(ALL_VISIBLE);
  private readonly visibilityOrigin = uniform(new Vector2(0, 0));
  private readonly visibilitySize = uniform(new Vector2(1, 1));
  private visibilityShape: VisibilityMask['shape'] | null = null;
  private terrain!: TerrainBuild;
  private water: { uniforms: WaterUniforms } | null = null;
  private rain!: RainSystem;
  private snow!: RainSystem;
  /** Cell exclusions shared by ground splashes and snow landings; live foundations update it only on change. */
  weatherGroundMask!: WeatherGroundMask;
  /** Present when drawing an original map; null for the procedural sandbox. */
  private world: HdWorld | null = null;
  private waterY = 0;
  private bounds = { width: 0, height: 0 };
  private readonly seenEvents = new Set<number>();
  private state: RenderState;
  private startTime = performance.now();
  private readonly shakeOffset = new Vector3();
  private readonly trackTimestamp: boolean;
  private readonly gpuTimes: number[] = [];
  private frames = 0;
  private resolvedFrames = 0;
  private readonly frameIntervals: number[] = [];
  private lastFrameAt = 0;
  private resolving = false;
  private staticGain = 0;
  private readonly dynamicLights: DynamicLight[] = [];
  private readonly dynamicEmitters: Emitter[] = [];
  /** Reused per frame (no allocation per light). */
  private readonly dynamicEmitterPool: (Emitter & {
    glow: [number, number, number];
    streak: [number, number, number];
  })[] = [];
  private readonly cameraRight = new Vector3();
  private readonly cameraUp = new Vector3();
  private readonly toCamera = new Vector3();
  private readonly frameInfo: FrameAtmosphere = {
    now: 0,
    night: 0,
    rain: 0,
    wet: 0,
    profile: DEFAULT_ATMOSPHERE,
    settings: this.atmosphere,
    cameraRight: new Vector3(1, 0, 0),
    cameraUp: new Vector3(0, 1, 0),
    toCamera: new Vector3(0, 1, 0),
  };

  constructor(
    readonly canvas: HTMLCanvasElement,
    initial: RenderState,
    options: {
      forceWebGL?: boolean;
      requiredLimits?: Record<string, number>;
      trackTimestamp?: boolean;
      nodes?: AtmosphereNodes;
    } = {},
  ) {
    this.nodes = options.nodes ?? new AtmosphereNodes();
    this.layerNodes = this.nodes;
    this.objects = new ObjectLayer(this.layerNodes);
    this.effects = new EffectsLayer(this.layerNodes, this.terrainDepth);
    this.emitters = new EmitterLayer(this.layerNodes);
    this.emissiveOverlay = new EmissiveOverlay(PIXELS_PER_CELL_EDGE);
    this.scene.onBeforeRender = () => this.emissiveOverlay.beginRender(this.renderer);
    this.scene.onAfterRender = () => this.emissiveOverlay.endRender();
    this.mist = new Mist(this.layerNodes);
    this.state = initial;
    this.trackTimestamp = options.trackTimestamp ?? false;
    this.renderer = new WebGPURenderer({
      canvas,
      antialias: false,
      forceWebGL: options.forceWebGL ?? false,
      trackTimestamp: this.trackTimestamp,
      ...(options.requiredLimits ? { requiredLimits: options.requiredLimits } : {}),
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.lighting = new Lighting(initial.map.width, initial.map.height);
  }

  /**
   * WebGPU devices default to 8192 px textures and 256 MiB buffers; ask for what the adapter really supports (16384 px
   * and 4 GiB on Apple GPUs) so a large map's upscaled whole-map terrain fits in one texture and its upload staging
   * buffer (DeepFrze's 12000x6664 @2x terrain needs 320 MB, which rendered black under the default). Empty when WebGPU
   * is unavailable.
   */
  static async adapterLimits(): Promise<Record<string, number>> {
    const gpu = (
      navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: Record<string, number> } | null> } }
    ).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    const limits: Record<string, number> = {};
    const max = adapter?.limits.maxTextureDimension2D;
    if (max) limits.maxTextureDimension2D = max;
    const buffer = adapter?.limits.maxBufferSize;
    if (buffer) limits.maxBufferSize = buffer;
    return limits;
  }

  /** 'WebGPU' or 'WebGL2' once init() resolved. */
  /**
   * Mean of the current per-channel scene exposure (see `exposure`). Self-lit effect art divides its display-referred
   * colour by it, so flame shows at its painted hue by day and by night instead of clipping to yellow.
   */
  get meanExposure(): number {
    const e = this.exposure.value;
    return (e.r + e.g + e.b) / 3;
  }

  get backend(): string {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  /** Build the scene from the procedural state, or from an original map when `world` is given. */
  async init(world?: HdWorld): Promise<void> {
    await this.renderer.init();
    // Static map previews use the same analytic cards as live matches; atmosphere must retain geometry depth there too.
    if (world?.sprites) this.painterDepthEnabled = true;
    const worldNodes = world ? (world.nodes ?? world.cache?.nodes ?? DEFAULT_ATMOSPHERE_NODES) : this.nodes;
    this.nodes = worldNodes;
    this.scene.background = new Color(0x0b0c0e);
    let waterY: number | null;
    if (world) {
      this.world = world;
      this.sceneMedianZ = world.cache ? medianHeight(world.cache.height, world.cache.exists) : 0;
      if (world.voxelLook) this.settings.voxelLook = world.voxelLook;
      this.terrain = world.terrain;
      this.bounds = { width: world.width, height: world.height };
      waterY = world.waterY;
      this.scene.add(world.root);
      this.view.target.copy(world.focus);
    } else {
      const map = this.state.map;
      this.terrain = buildTerrain(map, this.nodes);
      this.bounds = { width: map.width, height: map.height };
      waterY = map.waterLevel * LEVEL_HEIGHT;
      this.scene.add(this.objects.root);
      this.view.target.set(map.width / 2, 0, map.height / 2);
    }
    this.waterY = waterY ?? -1000;
    // Voxel units stand on (and tilt with) the ground or the water surface under them, and their flattened shadows
    // fall there (see ra2/voxelShadow.ts). Ramps rise one level per cell; anything steeper is a cliff edge.
    const shadowGround = groundFromHeights(
      (x, z) => Math.max(this.terrain.heightAt(x, z), this.waterY),
      LEVEL_HEIGHT * 1.5,
    );
    shadowGround.waterHeight = this.terrain.waterHeightAt;
    setShadowGround(this.scene, shadowGround);
    if (world?.water) this.water = { uniforms: world.water };
    if (waterY !== null) {
      const water = buildWater(this.bounds.width, this.bounds.height, waterY, this.terrain.heightTexture, this.nodes);
      this.water = water;
      this.scene.add(water.mesh);
    }
    this.weatherGroundMask = new WeatherGroundMask(
      this.bounds.width,
      this.bounds.height,
      world
        ? steepWeatherCells(this.bounds.width, this.bounds.height, this.terrain.heightTexture, LEVEL_HEIGHT * 1.5)
        : undefined,
    );
    this.weatherGroundMask.updateFoundations(world?.weatherFoundations ?? []);
    this.nodes.weatherGroundTexture.value = this.weatherGroundMask.texture;
    this.nodes.weatherGroundSize.value.set(this.bounds.width, this.bounds.height);
    this.rain = buildRain(
      this.bounds.width,
      this.bounds.height,
      this.terrain.heightTexture,
      this.waterY,
      this.nodes,
      this.weatherGroundMask.texture,
    );
    this.snow = buildSnow(
      this.bounds.width,
      this.bounds.height,
      this.terrain.heightTexture,
      this.waterY,
      this.nodes,
      this.weatherGroundMask.texture,
    );
    this.nodes.referenceLevel.value = this.lighting.referenceIrradiance();
    this.lightField = new LightField(this.bounds.width, this.bounds.height, {
      halfFloat: LightField.supportsHalfFloat(this.renderer),
      nodes: this.nodes,
    });
    this.effects.attachLightField(this.lightField);
    if (world?.surfaceTexture) {
      this.nodes.surfaceTexture.value = world.surfaceTexture;
      this.nodes.surfaceSize.value.set(world.width, world.height);
    }
    if (this.layerNodes !== this.nodes) this.layerNodes.copyValuesFrom(this.nodes);
    // Flat-ground irradiance at clear noon (day keys never depend on the map's profile): the day exposure's white point.
    this.lighting.update(12, 0);
    this.lighting.flatIrradianceColor(this.noonIrradiance);
    this.scene.add(
      this.terrain.mesh,
      this.lighting.root,
      this.effects.root,
      this.rain.object,
      this.snow.object,
      this.emitters.root,
      this.emissiveOverlay.root,
    );
    world?.dressing?.attach({
      scene: this.scene,
      nodes: this.nodes,
      lightField: this.lightField,
      emitters: this.emitters,
      reference: this.lighting.referenceIrradiance(),
    });
    this.buildPipeline();
    this.applySettings();
  }

  /**
   * Shroud (or any flat visibility mask) drawn on the ground plane y = 0. A plain texture has one texel per cell, R =
   * 255 visible, 128 fog, 0 black, linear-filtered, over `width` x `height` cells; a VisibilityMask brings its own
   * extent and shaping. Null shows everything.
   */
  setVisibility(mask: Texture | VisibilityMask | null, width = 1, height = 1): void {
    const full: VisibilityMask | null =
      mask && 'isTexture' in mask ? { texture: mask, origin: [0, 0], size: [width, height] } : mask;
    this.visibility.value = full?.texture ?? ALL_VISIBLE;
    this.visibilityOrigin.value.set(full?.origin[0] ?? 0, full?.origin[1] ?? 0);
    this.visibilitySize.value.set(full?.size[0] ?? 1, full?.size[1] ?? 1);
    const shape = full?.shape ?? null;
    if (shape === this.visibilityShape) return;
    this.visibilityShape = shape;
    if (this.pipeline) this.buildPipeline();
  }

  /** Snapshot-driven palette lighting; no independent fade or exposure feedback. */
  setSceneLighting(lighting: SceneLighting | null, skyFlash = 0): void {
    this.sceneLighting = lighting;
    this.sceneSkyFlash = lighting?.event === 'storm' ? Math.min(0.12, Math.max(0, skyFlash)) : 0;
  }

  /** Keep the old post graph exactly when no native top-layer art is present. */
  setTopEffectsVisible(visible: boolean): void {
    if (visible === this.topEffectsVisible) return;
    this.topEffectsVisible = visible;
    if (this.pipeline) this.buildPipeline();
  }

  /** Preserve geometry depth for atmosphere when cards reconstruct analytic occlusion depth in the fragment shader. */
  enablePainterDepth(): void {
    if (this.painterDepthEnabled) return;
    this.painterDepthEnabled = true;
    if (this.pipeline) this.buildPipeline();
  }

  private settingsPipelineKey(): string {
    const { antialias, toneMapper, sharpness, debugView } = this.settings;
    const key: unknown[] = [
      antialias,
      toneMapper,
      sharpness,
      debugView,
      debugView === 'none' && hasCinematicGrade(this.settings),
      // The clarity pass exists only while it is on; its blur radius follows the drawing buffer's pixel ratio.
      this.settings.clarity > 0 ? Math.round(this.renderer.getPixelRatio() * 4) : 0,
    ];
    // No extra key/graph branch for faithful: preserve its original output path exactly.
    if (emissiveOverlayEnabled(this.settings, emissiveMrtSupported(this.renderer))) key.push('emissive');
    if (this.topEffectsVisible) key.push('top-effects');
    return JSON.stringify(key);
  }

  private buildPipeline(): void {
    const { antialias, toneMapper, sharpness, debugView } = this.settings;
    const overlay = emissiveOverlayEnabled(this.settings, emissiveMrtSupported(this.renderer));
    this.emissiveOverlay.setEnabled(overlay);
    this.pipelineKey = this.settingsPipelineKey();
    // Release the previous pipeline's render targets and output material before building the new one (the MSAA scene
    // target alone is over 100 MB at 2400x1500).
    this.pipeline?.dispose();
    for (const node of this.pipelineNodes) node.dispose();
    const nodes: { dispose(): void }[] = (this.pipelineNodes = []);
    const scenePass = pass(this.scene, this.view.camera, { samples: antialias === 'msaa4' ? 4 : 0 });
    this.terrainDepth.setMainPass(scenePass.renderTarget, this.view.camera);
    if (this.painterDepthEnabled || overlay) {
      const outputs: Record<string, ShaderNode> = { output: materialOutput };
      if (this.painterDepthEnabled) {
        // Physical-depth alpha follows depth writes, independently of art coverage; overlays never write depth.
        outputs.physicalDepth = Fn(([], builder: NodeBuilder) =>
          vec4(float(1).sub(physicalDepth), 0, 0, builder.material.depthWrite ? 1 : 0),
        )();
      }
      if (overlay) outputs.emissive = vec4(0, 0, 0, materialOutput.a);
      const attachments = mrt(outputs);
      if (this.painterDepthEnabled)
        attachments
          .setBlendMode('physicalDepth', new BlendMode(NormalBlending))
          .setClearColor('physicalDepth', 0x000000, 0);
      // Use each foreground material's blending: opaque art clears emission, alpha art covers it, additive FX add zero.
      if (overlay)
        attachments.setBlendMode('emissive', new BlendMode(MaterialBlending)).setClearColor('emissive', 0x000000, 0);
      scenePass.setMRT(attachments);
    }
    nodes.push(scenePass);
    const hdr: ShaderNode = scenePass.getTextureNode('output');
    const depth: ShaderNode = this.painterDepthEnabled
      ? float(1).sub(scenePass.getTextureNode('physicalDepth').r)
      : scenePass.getTextureNode('depth');
    const world = this.mist.worldPosition(depth, screenUV);
    // Mist sits in the scene before bloom so lamp halos in it glow like the lamps themselves. With no mist the
    // pipeline leaves it out entirely (frame() rebuilds it when the mist starts or stops).
    this.mistInPipeline = this.mist.amount.value > 0;
    const misted: ShaderNode = this.mistInPipeline ? this.mist.apply(hdr, depth, world) : hdr;
    // The shroud covers the mist and everything under it, and what it hides never feeds the bloom.
    const texel: ShaderNode = texture(
      this.visibility,
      this.mist.groundPlanePoint(world).sub(this.visibilityOrigin).div(this.visibilitySize),
    );
    const visible: ShaderNode = this.visibilityShape ? this.visibilityShape(texel) : texel.r;
    // Colour only: the canvas stays opaque, so shroud is black and not the page behind it.
    let shown: ShaderNode = vec4(misted.rgb.mul(visible), misted.a);
    let topAlpha: ShaderNode | null = null;
    if (this.topEffectsVisible) {
      const topPass = pass(this.topScene, this.view.camera, { samples: antialias === 'msaa4' ? 4 : 0 });
      // Transparent clear is explicit: the renderer's main canvas is intentionally opaque. Normal/custom-alpha
      // blending produces premultiplied colour in this target, so composite it without multiplying alpha twice.
      topPass.setMRT(mrt({ output: materialOutput }).setClearColor('output', 0x000000, 0));
      nodes.push(topPass);
      const top: ShaderNode = topPass.getTextureNode('output');
      topAlpha = top.a;
      shown = vec4(shown.rgb.mul(float(1).sub(top.a)).add(top.rgb), 1);
    }
    // Bloom reads the unexposed scene; frame() sets its threshold from the exposure.
    const glow: ShaderNode = bloom(shown, 1, 0.45, this.bloomThreshold);
    glow.strength = this.bloomStrength;
    nodes.push(glow);
    const vignette = float(1).sub(
      smoothstep(0.45, 1.05, length(screenUV.sub(0.5).mul(1.6))).mul(this.vignetteStrength),
    );
    // Opaque output: the vignette darkens colour only (it used to scale alpha too, letting the page show in corners).
    const bloomVisibility = topAlpha ? max(visible, topAlpha) : visible;
    const composite: ShaderNode = shown.rgb.add(glow.rgb.mul(bloomVisibility)).mul(this.exposure).mul(vignette);
    this.pipeline = new RenderPipeline(this.renderer);
    // Anti-aliasing and sharpening run on the display-referred image.
    this.pipeline.outputColorTransform = false;
    voxelLightingFor(this.nodes).voxelDebug.value = debugView === 'voxel-xy' ? 1 : debugView === 'voxel-z' ? 2 : 0;
    if (debugView === 'overbright') {
      const luminance = dot(hdr.rgb.mul(this.exposure), vec3(0.2126, 0.7152, 0.0722));
      this.pipeline.outputNode = vec4(vec3(luminance.greaterThan(1).select(float(1), float(0))), 1);
      return;
    }
    if (debugView !== 'none') {
      // Raw values, no exposure, tone map or colour conversion: screenshots read them back byte for byte.
      this.pipeline.outputNode = renderOutput(vec4(hdr.rgb, 1), NoToneMapping, NoColorSpace);
      return;
    }
    // 'faithful': the palette's own colours by day, PBR Neutral at night (the night presentation's calibration).
    const faithful: ShaderNode = faithfulToneMap(composite);
    const neutral: ShaderNode = neutralToneMapping(composite, float(1));
    // (TSL's chained a.mix(b, t) is mix(b, t, a); call mix() directly.)
    const mixed: ShaderNode = mix(faithful, neutral, this.nightDisplay);
    let emission: ShaderNode | null = overlay ? scenePass.getTextureNode('emissive').rgb.mul(visible) : null;
    if (emission && topAlpha) emission = emission.mul(float(1).sub(topAlpha));
    const addEmission = (linear: ShaderNode): ShaderNode => (emission ? linear.add(emission) : linear);
    let output: ShaderNode;
    if (hasCinematicGrade(this.settings)) {
      // Grade display-linear colour after the tone map, before renderOutput encodes sRGB and the night toe lift.
      const linear: ShaderNode =
        toneMapper === 'faithful' ? mixed : toneMapping(TONE_MAPPERS[toneMapper], float(1), vec4(composite, 1)).rgb;
      const graded: ShaderNode = mix(cinematicGrade(linear, this.gradeUniforms), linear, this.nightDisplay);
      output = renderOutput(vec4(addEmission(graded), 1), NoToneMapping);
    } else if (overlay) {
      const linear: ShaderNode =
        toneMapper === 'faithful' ? mixed : toneMapping(TONE_MAPPERS[toneMapper], float(1), vec4(composite, 1)).rgb;
      output = renderOutput(vec4(addEmission(linear), 1), NoToneMapping);
    } else {
      // Keep the original graph untouched when all display-grade controls are neutral.
      output =
        toneMapper === 'faithful'
          ? renderOutput(vec4(mixed, 1), NoToneMapping)
          : renderOutput(vec4(composite, 1), TONE_MAPPERS[toneMapper]);
    }
    const toe = float(1).sub(output.rgb.div(NIGHT_TOE)).max(0);
    let display: ShaderNode = vec4(output.rgb.add(this.blackLift.mul(visible).mul(toe.mul(toe))), 1);
    if (this.settings.clarity > 0 && debugView === 'none') {
      // Band-pass (difference of two half-resolution blurs): faces, crevices and canopy masses a few CSS px and up gain
      // contrast while pixel-scale texture (brick, asphalt grain) is left as it is; the plain unsharp mask doubled it.
      const ratio = this.renderer.getPixelRatio();
      const fine: ShaderNode = gaussianBlur(display, null, (CLARITY_FINE * ratio) / 2, { resolutionScale: 0.5 });
      const broad: ShaderNode = gaussianBlur(display, null, (CLARITY_SIGMA * ratio) / 2, { resolutionScale: 0.5 });
      nodes.push(fine, broad);
      const luma = vec3(0.2126, 0.7152, 0.0722);
      const lum = dot(display.rgb, luma);
      const band = dot(fine.rgb, luma).sub(dot(broad.rgb, luma));
      // Lit edges gain fully, shaded sides half as much: deep shade must not grow (the targets keep warm, readable
      // shadows); mid-tones only, so near-white highlights and the darkest pixels do not ring.
      const detail = band.max(0).add(band.min(0).mul(0.5));
      const weight = smoothstep(0.05, 0.25, lum).mul(smoothstep(0.98, 0.75, lum));
      display = vec4(
        display.rgb.mul(float(1).add(detail.mul(this.clarityAmount).mul(weight).div(lum.max(0.05)))).max(0),
        1,
      );
    }
    if (antialias === 'fxaa') {
      display = fxaa(display);
      nodes.push(display);
    }
    if (sharpness >= 0 && sharpness < 2) {
      display = sharpen(display, sharpness);
      nodes.push(display);
    }
    this.pipeline.outputNode = display;
  }

  applySettings(): void {
    // Exposure is applied in the pipeline for every tone mapper.
    this.renderer.toneMapping =
      this.settings.toneMapper === 'faithful' ? NoToneMapping : TONE_MAPPERS[this.settings.toneMapper];
    this.renderer.toneMappingExposure = 1;
    this.nodes.localLightCap.value = this.settings.sourceLights > 0 ? 1 : 0;
    this.bloomStrength.value = this.settings.bloom;
    this.clarityAmount.value = this.settings.clarity;
    this.vignetteStrength.value = this.settings.vignette;
    this.gradeUniforms.gradeBalance.value.fromArray(this.settings.gradeBalance);
    this.gradeUniforms.gradeContrast.value = this.settings.gradeContrast;
    this.gradeUniforms.gradePivotLift.value = this.settings.gradePivotLift;
    this.gradeUniforms.gradeSaturation.value = this.settings.gradeSaturation;
    this.gradeUniforms.gradeShadowTint.value.fromArray(this.settings.gradeShadowTint);
    this.gradeUniforms.gradeHighlightTint.value.fromArray(this.settings.gradeHighlightTint);
    // Original maps have no sun-shadow casters: the tile art paints terrain shading, sprites carry their own shadow
    // frames and voxels draw engine-style flattened shadows. Skipping the empty shadow map saves a full depth pass
    // and the per-pixel shadow lookups of every receiver.
    this.lighting.sun.castShadow = this.settings.shadows && !this.world;
    this.lighting.sunArc = this.settings.sunPath === 'arc';
    const voxels = voxelLightingFor(this.nodes);
    if (this.settings.voxelSheen !== null) voxels.voxelSheen.value = this.settings.voxelSheen;
    if (this.settings.voxelSheenCap !== null) voxels.voxelSheenCap.value = this.settings.voxelSheenCap;
    if (this.settings.voxelOcclusion !== null) voxels.voxelOcclusion.value = this.settings.voxelOcclusion;
    if (!this.pipeline || this.pipelineKey !== this.settingsPipelineKey()) this.buildPipeline();
  }

  setState(state: RenderState): void {
    this.state = state;
    if (!this.world) this.objects.sync(state.objects, this.terrain.heightAt);
    for (const event of state.events) this.handleEvent(event);
  }

  private handleEvent(event: RenderEvent): void {
    // Events are idempotent by id: replays or renderer toggles must not spawn effects twice.
    if (this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 4096) this.seenEvents.clear();
    if (event.kind === 'explosion') {
      const ground = this.terrain.heightAt(event.x, event.y);
      const at = cellToWorld(event.x, event.y, 0).setY(Math.max(ground, this.waterY));
      const env = this.state.environment;
      const wind = new Vector3(Math.cos(env.windDirection), 0, Math.sin(env.windDirection)).multiplyScalar(
        env.windStrength * 0.8,
      );
      this.effects.explode(this.seconds(), at, event.scale, wind);
    }
  }

  /** Seconds since the renderer started: the clock effects are spawned and animated on. */
  seconds(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.view.resize(cssWidth, cssHeight);
    this.terrainDepth.resize(this.renderer);
  }

  /** The profile the lighting follows: the map's (with any night-level override), none for the procedural sandbox. */
  private readonly adjustedProfile: AtmosphereProfile = { ...DEFAULT_ATMOSPHERE };

  private profile(): AtmosphereProfile | null {
    if (!this.world) return null;
    const profile = this.state.map.atmosphere ?? DEFAULT_ATMOSPHERE;
    const level = this.atmosphere.nightLevel;
    if (level === undefined) return profile;
    const adjusted = this.adjustedProfile;
    adjusted.kind = profile.kind;
    adjusted.hour = profile.hour;
    adjusted.tint = profile.tint;
    adjusted.nightLevel = level;
    return adjusted;
  }

  frame(deltaSeconds: number): void {
    const started = performance.now();
    if (this.lastFrameAt) {
      this.frameIntervals.push(started - this.lastFrameAt);
      if (this.frameIntervals.length > 600) this.frameIntervals.shift();
    }
    this.lastFrameAt = started;
    const env = this.state.environment;
    const raining = env.weather === 'rain' || env.weather === 'storm';
    const snowing = env.weather === 'snow';
    // A storm is heavier rain (and wind); no lightning (decorative weather rule, docs/remaster/PLAN.md).
    const rainAmount = raining ? Math.min(1, env.weatherIntensity * (env.weather === 'storm' ? 1.3 : 1)) : 0;
    const snowAmount = snowing ? env.weatherIntensity : 0;
    // Surfaces wet quickly under rain and dry slowly after it stops.
    const wet = this.terrain.wetness;
    // Snow is dry decoration: switching from rain also removes residual puddles and wet reflections.
    wet.value = snowing
      ? 0
      : raining
        ? Math.min(1, wet.value + deltaSeconds * 0.25 * rainAmount)
        : Math.max(0, wet.value - deltaSeconds * 0.02);

    const profile = this.profile();
    this.lighting.setProfile(profile);
    this.lighting.follow(this.view.target);
    this.lighting.update(
      env.timeOfDay,
      raining ? 0.35 + 0.5 * rainAmount : snowing ? 0.3 + 0.35 * snowAmount : 0,
      snowing ? 0.06 : undefined,
      raining ? { kind: 'rain', intensity: rainAmount } : snowing ? { kind: 'snow', intensity: snowAmount } : undefined,
    );
    const light = this.lighting.state;
    this.lighting.flatIrradianceColor(this.eventFreeIrradiance);
    const reference = this.lighting.referenceIrradiance();
    // Original maps only: the procedural sandbox keeps its own look.
    const nightGrade = this.world ? light.night : 0;
    // Original maps are calibrated so flat ground at clear noon shows the tile art at its original colour: by day the
    // exposure is pi / (noon flat-ground irradiance) per channel, a white balance to the noon reference (the noon sun
    // is slightly warm and the sky blue). The night presentation keeps the scalar pi / reference it was tuned with;
    // hours in between blend. The procedural sandbox keeps its own per-key exposure.
    const exposure: Color = this.exposure.value;
    if (this.world) {
      const noon = this.noonIrradiance;
      const k = Math.PI * this.settings.exposure;
      exposure.setRGB(
        k * (1 / noon.r + (1 / reference - 1 / noon.r) * nightGrade),
        k * (1 / noon.g + (1 / reference - 1 / noon.g) * nightGrade),
        k * (1 / noon.b + (1 / reference - 1 / noon.b) * nightGrade),
      );
      // Enhanced look: lift late and early daylight towards noon's brightness (the colour of the light stays).
      const adapt = this.settings.adaptExposure * (1 - nightGrade);
      if (adapt > 0) {
        // Adapt to the hour's clear illumination so exposure does not cancel intentional overcast dimming.
        const flat =
          light.weatherSunShare !== 1
            ? this.lighting.clearFlatIrradianceColor(this.scratchColor)
            : this.lighting.flatIrradianceColor(this.scratchColor);
        const now = 0.2126 * flat.r + 0.7152 * flat.g + 0.0722 * flat.b;
        const noonLum = 0.2126 * noon.r + 0.7152 * noon.g + 0.0722 * noon.b;
        const lift = Math.min(MAX_ADAPT, Math.max(1, noonLum / Math.max(1e-6, now)));
        exposure.multiplyScalar(1 + (lift - 1) * adapt);
      }
      if (this.settings.whiteAdapt > 0 && nightGrade < 1) {
        // Exposure adaptation alone owns brightness; white adaptation changes only the illuminant balance.
        adaptWhiteBalance(
          exposure,
          noon,
          light.weatherSunShare !== 1
            ? this.lighting.clearFlatIrradianceColor(this.scratchColor)
            : this.lighting.flatIrradianceColor(this.scratchColor),
          this.settings.whiteAdapt,
          nightGrade,
        );
      }
      const mapLight = this.world.mapLight;
      if (this.settings.mapTintAdapt > 0 && mapLight) {
        // The map light's day weight is set below for this frame; last frame's weight is the same within a frame.
        neutralizeMapTint(exposure, mapLight.lighting, this.settings.mapTintAdapt * mapLight.currentWeight);
      }
    } else {
      exposure.setScalar(this.settings.exposure * light.exposure);
    }
    // Bloom picks up exposed luminance above 1 by day (effect cores and glints only, never lit art); the night keeps
    // its tuned threshold on the unexposed scene.
    const dayThreshold = BLOOM_THRESHOLD / Math.max(1e-3, (exposure.r + exposure.g + exposure.b) / 3);
    this.bloomThreshold.value = dayThreshold + (NIGHT_BLOOM_THRESHOLD - dayThreshold) * nightGrade;
    this.nightDisplay.value = nightGrade;
    this.nodes.faithfulDisplay.value = this.settings.toneMapper === 'faithful' ? 1 - nightGrade : 0;
    // The map's own light by day ([Lighting] and light sources, mapLighting.ts); the night presentation owns maps staged
    // as night or dusk and the night hours of day maps.
    this.world?.mapLight?.setWeight(profile?.kind === 'day' ? 1 - light.night : 0);
    this.world?.mapLight?.setSourceWeight(this.settings.mapSourcesByDay);
    // Compare against the authored map, without local sources. Adaptation above reads only event-free light;
    // otherwise a dark scene event would immediately be brightened and white-balanced back out.
    const scene = computeSceneMultipliers(
      this.world?.mapLight?.lighting ?? this.state.map.lighting,
      this.sceneLighting,
      this.sceneMedianZ,
    );
    const flash = 1 + this.sceneSkyFlash;
    this.nodes.sceneTerrainMul.value.fromArray(scene.terrain).multiplyScalar(flash);
    this.nodes.sceneObjectMul.value.fromArray(scene.objects).multiplyScalar(flash);
    const storm = this.sceneLighting?.event === 'storm';
    this.nodes.sceneSunShadow.value = storm ? 0 : 1;
    this.lighting.sun.castShadow = this.settings.shadows && !this.world && !storm;
    // This is presentation only: never infer rain, event timing or ambient from the storm flag.
    if (storm) this.lighting.update(env.timeOfDay, 1);
    if (this.settings.voxelLook === 'remaster') {
      const pbr = voxelPbrFor(this.nodes);
      pbr.skyZenith.value.copy(light.skyZenith);
      pbr.skyHorizon.value.copy(light.skyHorizon);
      pbr.groundColour.value
        .copy(this.lighting.hemi.groundColor)
        .multiplyScalar(this.lighting.hemi.intensity / Math.PI);
    }
    if (this.water) {
      const w = this.water.uniforms;
      w.sunDirection.value.copy(light.sunDirection);
      w.sunColor.value.copy(light.sunColor).multiplyScalar(this.lighting.sun.intensity / 3);
      w.skyZenith.value.copy(light.skyZenith);
      w.skyHorizon.value.copy(light.skyHorizon);
      w.ambient.value.copy(light.ambient);
      w.rain.value = rainAmount;
      w.wind.value = env.windStrength + rainAmount * 0.3;
    }
    this.objects.night.value = light.night;

    // Shared atmosphere inputs (atmosphere.ts): scene light level, night, rain.
    this.lighting.flatIrradianceColor(this.nodes.sceneLevel.value).multiplyScalar(1 / reference);
    const level = this.nodes.sceneLevel.value;
    this.nodes.sceneBrightness.value =
      ((0.2126 * level.r + 0.7152 * level.g + 0.0722 * level.b) * reference) / noonFlatLuminance();
    this.nodes.night.value = light.night;
    this.nodes.rainAmount.value = rainAmount;
    this.nodes.weatherSunShare.value = light.weatherSunShare;
    this.nodes.weatherDesaturation.value =
      profile?.kind === 'day' && raining ? 0.15625 * rainAmount * (1 - light.night) : 0;
    this.nodes.moonDesaturation.value = NIGHT_DESATURATION * nightGrade;
    const levelLuminance = 0.2126 * level.r + 0.7152 * level.g + 0.0722 * level.b;
    this.nodes.moonNeutral.value.setRGB(
      levelLuminance / Math.max(1e-4, level.r),
      levelLuminance / Math.max(1e-4, level.g),
      levelLuminance / Math.max(1e-4, level.b),
    );
    this.blackLift.value.setRGB(
      NIGHT_BLACK_LIFT[0] * nightGrade,
      NIGHT_BLACK_LIFT[1] * nightGrade,
      NIGHT_BLACK_LIFT[2] * nightGrade,
    );
    this.staticGain = smooth(0.2, 0.8, light.night);
    this.emitters.lampGain.value = smooth(0.3, 0.8, light.night);
    this.nodes.windowGain.value = this.atmosphere.windows ? smooth(WINDOW_NIGHT[0], WINDOW_NIGHT[1], light.night) : 0;
    this.emitters.wet.value = wet.value;
    this.emitters.sync();
    // Mist: none on a clear day, a trace in day rain, a thin veil at night (thicker in night rain). Capped.
    const baseMist = raining
      ? (1 - light.night) * 0.06 * rainAmount + light.night * (0.045 + 0.04 * rainAmount)
      : snowing
        ? 0.06 * snowAmount
        : 0.05 * light.night;
    this.mist.amount.value = Math.min(MIST_CAP, baseMist * this.atmosphere.mist);
    if (this.mist.amount.value > 0 !== this.mistInPipeline) this.buildPipeline();

    this.rain.intensity.value = rainAmount;
    this.rain.object.visible = rainAmount > 0;
    this.rain.windX.value = Math.cos(env.windDirection) * env.windStrength * 0.4;
    this.rain.windZ.value = Math.sin(env.windDirection) * env.windStrength * 0.4;
    this.rain.center.value.copy(this.view.target);
    this.snow.intensity.value = snowAmount;
    this.snow.object.visible = snowAmount > 0;
    this.snow.windX.value = this.rain.windX.value;
    this.snow.windZ.value = this.rain.windZ.value;
    this.snow.center.value.copy(this.view.target);

    // Camera shake decays quickly; it is purely presentational.
    this.effects.shake = Math.max(0, this.effects.shake - deltaSeconds);
    const s = this.effects.shake * 0.15;
    this.shakeOffset.set((Math.random() - 0.5) * s, 0, (Math.random() - 0.5) * s);
    this.view.update();
    this.view.camera.position.add(this.shakeOffset);
    this.view.camera.updateMatrixWorld();
    this.mist.update(this.view.camera);

    const now = this.seconds();
    const right = this.cameraRight.setFromMatrixColumn(this.view.camera.matrixWorld, 0);
    const up = this.cameraUp.setFromMatrixColumn(this.view.camera.matrixWorld, 1);
    const toCamera = this.toCamera.setFromMatrixColumn(this.view.camera.matrixWorld, 2);
    const shadows = voxelShadowFor(this.nodes);
    shadows.time = now;
    shadows.toCamera.copy(toCamera);
    this.effects.update(now, right, up, toCamera);
    this.emitters.cameraRight.value.copy(right);
    this.emitters.cameraUp.value.copy(up);
    this.emitters.toCamera.value.copy(toCamera);
    this.emissiveOverlay.cameraRight.value.copy(right);
    this.emissiveOverlay.cameraUp.value.copy(up);
    this.emissiveOverlay.toCamera.value.copy(toCamera);
    this.emissiveOverlay.now.value = now;
    const sprites = this.world?.sprites;
    const spriteScale = 1 / Math.PI + (1 / reference - 1 / Math.PI) * nightGrade;
    this.effectLight.copy(this.eventFreeIrradiance).multiplyScalar(spriteScale);
    if (sprites) {
      sprites.cameraRight.value.copy(right);
      sprites.cameraUp.value.copy(up);
      sprites.toCamera.value.copy(toCamera);
      // Unlit original art takes the light a flat Lambert surface would: irradiance / pi, which the day exposure
      // (pi / noon irradiance) turns into colour x E / Enoon, exactly the original colour at clear noon and the same
      // level as the terrain around it. The night keeps the level it was tuned with (irradiance / reference).
      this.lighting.flatIrradianceColor(sprites.light.value).multiplyScalar(spriteScale);
    }
    this.updateSpriteLook(spriteScale, wet.value);
    // Emissive light is not divided by pi like diffuse, so fill = irradiance * k / pi lands at k x albedo at noon.
    this.lighting
      .flatIrradianceColor(voxelLightingFor(this.nodes).voxelFill.value)
      .multiplyScalar(VOXEL_FILL / Math.PI);

    const frame = this.frameInfo;
    frame.now = now;
    frame.night = light.night;
    frame.rain = rainAmount;
    frame.wet = wet.value;
    frame.profile = profile ?? DEFAULT_ATMOSPHERE;
    frame.cameraRight.copy(right);
    frame.cameraUp.copy(up);
    frame.toCamera.copy(toCamera);
    this.world?.dressing?.update(frame);
    if (this.layerNodes !== this.nodes) this.layerNodes.copyValuesFrom(this.nodes);
    this.lightField.update(now, this.renderer, this.staticGain);
    this.mirrorDynamicEmitters(now);
    this.renderPipeline();
    this.frames++;
    if (this.trackTimestamp && this.frames % 2 === 0) void this.collectGpuTimes();
  }

  private renderPipeline(): void {
    this.terrainDepth.setReference(this.view.camera, this.view.target);
    this.beforeDepthCapture?.();
    this.terrainDepth.render(this.renderer, this.scene, this.view.camera);
    this.terrainDepth.renderMainPass(() => this.pipeline!.render());
  }

  private readonly scratchColor = new Color();
  private readonly referenceSun = new Color();
  private readonly referenceSky = new Color();

  /** Enhanced sprite look uniforms (ra2/spriteLook.ts) from the settings and the current sun and sky. */
  private updateSpriteLook(spriteScale: number, wetness: number): void {
    const s = this.settings;
    const look = spriteLookFor(this.nodes);
    const on =
      s.relight > 0 ||
      s.specular > 0 ||
      s.glass > 0 ||
      s.occlusion > 0 ||
      s.shadowFollow > 0 ||
      s.shadowSoftness > 0 ||
      s.wetReflections > 0;
    look.enabled.value = on ? 1 : 0;
    // Depth gains are dormant in faithful mode, including voxel and terrain shaders outside the sprite branch.
    look.sunGain.value = on ? s.sunGain : 1;
    look.factorUpper.value = relightFactorUpper(look.sunGain.value);
    look.specularSize.value = on ? s.specularSize : 1;
    look.aoPower.value = on ? s.aoPower : 1;
    look.contactShade.value = on ? s.contactShade : 1;
    look.shadowLength.value = on ? s.shadowLength : 1;
    look.shadowDarkness.value = on ? s.shadowDarkness : 1;
    for (const pass of look.groundPasses) pass.visible = on;
    if (!on) {
      this.restoreVoxelShear();
      return;
    }
    const state = this.lighting.state;
    const day = 1 - state.night;
    const sun = this.lighting.sun;
    const hemi = this.lighting.hemi;
    const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    // The art's light stands for the clear sky of the reference hour; weights are normalised to its sun, with the
    // art's own sky share (see spriteLook.ts relightFactor).
    clearLightAt(ART_REFERENCE_HOUR, this.referenceSun, this.referenceSky);
    const sunNorm = 1 / Math.max(1e-6, lum(this.referenceSun));
    const skyNorm = ART_SKY_SHARE / Math.max(1e-6, lum(this.referenceSky));
    look.artSunWeight.value.copy(this.referenceSun).multiplyScalar(sunNorm);
    look.artSkyWeight.value.copy(this.referenceSky).multiplyScalar(skyNorm);
    look.sunWeight.value.copy(sun.color).multiplyScalar(sun.intensity * sunNorm);
    if (s.sunGain !== 1) look.sunWeight.value.multiplyScalar(s.sunGain);
    look.skyWeight.value.copy(hemi.color).multiplyScalar((hemi.intensity * skyNorm) / Math.max(0.2, s.lightContrast));
    look.sunLight.value.copy(sun.color).multiplyScalar(sun.intensity * spriteScale * Math.PI);
    look.skyLight.value.copy(hemi.color).multiplyScalar(hemi.intensity * spriteScale);
    look.skyHorizon.value.copy(state.skyHorizon);
    look.skyZenith.value.copy(state.skyZenith);
    // The sun the sprites see: the arc's, or the art's own azimuth at the current elevation.
    const dir = look.sunDirection.value;
    if (this.lighting.sunArc) dir.copy(state.sunDirection);
    else {
      const e = Math.asin(Math.min(1, Math.max(-1, state.sunDirection.y)));
      dir.set(0, Math.sin(e), Math.cos(e));
    }
    look.relight.value = s.relight * day;
    look.specular.value = s.specular;
    look.glass.value = s.glass;
    look.occlusion.value = s.occlusion;
    look.reflections.value = s.wetReflections;
    look.wetness.value = wetness;
    // Shadow length from the key elevation (below the lighting's 28 degree floor: golden hours cast long shadows),
    // relative to the art's own, capped for readability.
    const follow = s.shadowFollow * day;
    const stretch = shadowStretch(state.keyElevation, follow > 0 ? look.shadowLength.value : 1);
    look.shadowFollow.value = follow;
    look.shadowSoftness.value = s.shadowSoftness * day * Math.max(1, stretch);
    shadowTransform(dir, stretch, follow, look.shadowMatrix.value);
    // Voxel units' engine-style shadows (voxelShadow.ts) turn and stretch by the same amount, about their own
    // direction, so vehicles agree with the buildings around them.
    if (follow > 0) {
      const base = (this.voxelShearBase ??= { x: shadowShear.x, z: shadowShear.z });
      const m = look.shadowMatrix.value;
      // M = R(turn) x (stretch along the art's direction): its determinant is the stretch.
      const k = Math.abs(m.x * m.w - m.z * m.y);
      const turn = Math.atan2(m.y, m.x);
      const c = Math.cos(turn) * k;
      const sn = Math.sin(turn) * k;
      shadowShear.x = c * base.x - sn * base.z;
      shadowShear.z = sn * base.x + c * base.z;
    } else this.restoreVoxelShear();
  }

  /** Shear of voxel shadows before the enhanced look turned them (review tooling may have set its own). */
  private voxelShearBase: { x: number; z: number } | null = null;

  private restoreVoxelShear(): void {
    if (!this.voxelShearBase) return;
    shadowShear.x = this.voxelShearBase.x;
    shadowShear.z = this.voxelShearBase.z;
    this.voxelShearBase = null;
  }

  /** Dynamic sources, fires and explosions also show as glows and wet reflections, mirrored from the light field. */
  private mirrorDynamicEmitters(now: number): void {
    const lights = this.lightField.dynamicLights(now, this.dynamicLights);
    const pool = this.dynamicEmitterPool;
    const out = this.dynamicEmitters;
    out.length = 0;
    const k = 1 / this.lighting.referenceIrradiance();
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]!;
      const e = (pool[i] ??= { x: 0, y: 0, z: 0, head: 0, glow: [0, 0, 0], streak: [0, 0, 0] });
      e.x = l.x;
      e.y = Math.max(this.terrain.heightAt(l.x, l.z), this.waterY);
      e.z = l.z;
      // Fires show as flames: only their wet reflection is mirrored here. Explosions also get a glow at their heart.
      const fire = l.kind === 'fire';
      const source = l.kind === 'source';
      e.head = source ? (l.head ?? 0) : fire ? 0.5 : 0.8;
      e.size = source ? l.glowSize : undefined;
      e.core = source ? l.glowCore : undefined;
      e.hot = source ? l.glowHot : undefined;
      e.push = source ? l.push : undefined;
      for (let c = 0; c < 3; c++) {
        e.glow[c] = source ? (l.glow?.[c] ?? 0) : fire ? 0 : l.colour[c]! * k * 0.12;
        e.streak[c] = l.colour[c]! * k * (fire ? 0.45 : 0.35);
      }
      out.push(e);
    }
    this.emitters.setDynamic(out);
  }

  /**
   * Resolve GPU timestamps of every render pass since the last call and record the average GPU time per presented
   * frame over that span (the sandbox drives frames itself, so three's own frame counter does not advance).
   */
  private async collectGpuTimes(): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    const frames = this.frames - this.resolvedFrames;
    this.resolvedFrames = this.frames;
    try {
      await this.renderer.resolveTimestampsAsync('render');
      const pool = (this.renderer.backend as { timestampQueryPool?: { render?: { timestamps?: Map<string, number> } } })
        .timestampQueryPool?.render;
      let total = 0;
      for (const ms of pool?.timestamps?.values() ?? []) total += ms;
      if (frames > 0 && total > 0) this.gpuTimes.push(total / frames);
      if (this.gpuTimes.length > 600) this.gpuTimes.splice(0, this.gpuTimes.length - 600);
    } catch {
      // Timestamp queries unavailable: stats() reports gpuMs null.
    } finally {
      this.resolving = false;
    }
  }

  stats(): HdStats {
    const now = this.seconds();
    const lf = this.lightField.stats(now);
    const summary = (values: readonly number[]) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
      return { median: q(0.5), p95: q(0.95), frames: sorted.length };
    };
    let pointLights = 0;
    this.scene.traverse((o) => {
      if ((o as { isPointLight?: boolean }).isPointLight) pointLights++;
    });
    return {
      backend: this.backend,
      exposure: (this.exposure.value.r + this.exposure.value.g + this.exposure.value.b) / 3,
      hour: this.state.environment.timeOfDay,
      night: this.lighting.state.night,
      nightLevel: this.lighting.nightLevel,
      staticGain: this.staticGain,
      staticLights: lf.static,
      dynamicLights: { explosion: lf.explosion, flash: lf.flash, kept: lf.kept, sources: lf.sources },
      lightFieldRenders: this.lightField.renders,
      emitters: this.emitters.staticEmitters,
      mist: this.mist.amount.value,
      wet: this.terrain.wetness.value,
      rain: this.nodes.rainAmount.value,
      snow: this.snow.intensity.value,
      pointLights,
      sceneBrightness: this.nodes.sceneBrightness.value,
      windowGain: this.nodes.windowGain.value,
      lampGain: this.emitters.lampGain.value,
      dressing: this.world?.dressing?.stats() ?? {},
      frameMs: summary(this.frameIntervals.slice(-300)),
      gpuTimestampMs: summary(this.gpuTimes.slice(-300)),
    };
  }

  /**
   * GPU-bound cost of one frame in milliseconds (WebGPU only, else null): one frame() to apply the current state, then
   * `frames` renders of the pipeline back to back, each with the node frame advanced so every pass really re-renders
   * (three re-renders a pass once per node frame, and only its own animation loop advances it), then the wait for the
   * GPU queue, divided by `frames`. Unlike frame intervals this measures neither vsync nor presentation, and unlike
   * per-pass timestamps it does not over-count passes that overlap on tile-based GPUs. The effect clock keeps running,
   * so particles and lights age as in a real frame.
   */
  async benchmark(frames = 10): Promise<number | null> {
    const queue = (this.renderer.backend as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device
      ?.queue;
    if (!queue) return null;
    const nodeFrame = (this.renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame;
    this.frame(1 / 60);
    await queue.onSubmittedWorkDone();
    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      nodeFrame.update();
      this.renderPipeline();
    }
    await queue.onSubmittedWorkDone();
    return (performance.now() - started) / frames;
  }

  /**
   * Whether lit windows will show at the current hour (windowGain > 0), known before frame() runs: live views decide
   * from it whether an atlas page's layer needs its window mask.
   */
  windowsWanted(): boolean {
    return this.atmosphere.windows && this.lighting.nightAt(this.state.environment.timeOfDay) > WINDOW_NIGHT[0];
  }

  /** Whether per-pixel sprite materials can contribute, known before frame() updates the look uniforms. */
  materialsWanted(): boolean {
    const s = this.settings;
    return s.relight > 0 || s.occlusion > 0 || s.specular > 0 || s.glass > 0;
  }

  /** Release this renderer's shader resources and GPU targets; call once the view stops presenting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pipeline?.dispose();
    for (const node of this.pipelineNodes) node.dispose();
    this.pipelineNodes.length = 0;
    this.lightField?.dispose();
    this.rain?.dispose();
    this.snow?.dispose();
    this.weatherGroundMask?.dispose();
    this.emissiveOverlay.dispose();
    this.beforeDepthCapture = undefined;
    this.terrainDepth.dispose();
    if (this.nodes !== DEFAULT_ATMOSPHERE_NODES) this.nodes.dispose();
    if (this.layerNodes !== this.nodes && this.layerNodes !== DEFAULT_ATMOSPHERE_NODES) this.layerNodes.dispose();
    this.renderer.dispose();
  }

  /** Ground point under a CSS-pixel position, for sandbox interaction. */
  pick(clientX: number, clientY: number): Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = { x: ((clientX - rect.left) / rect.width) * 2 - 1, y: -((clientY - rect.top) / rect.height) * 2 + 1 };
    const origin = new Vector3(ndc.x, ndc.y, -1).unproject(this.view.camera);
    const direction = new Vector3(ndc.x, ndc.y, 1).unproject(this.view.camera).sub(origin).normalize();
    // March along the view ray against the height field; robust and cheap for a single click.
    for (let t = 0; t < 400; t += 0.05) {
      const p = origin.clone().addScaledVector(direction, t);
      if (p.x < 0 || p.z < 0 || p.x > this.bounds.width || p.z > this.bounds.height) continue;
      if (p.y <= Math.max(this.terrain.heightAt(p.x, p.z), this.waterY)) return p;
    }
    return null;
  }
}
