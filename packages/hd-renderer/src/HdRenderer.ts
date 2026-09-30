import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BlendMode,
  Color,
  DataTexture,
  NeutralToneMapping,
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
  mix,
  mrt,
  neutralToneMapping,
  output as materialOutput,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  texture,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
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
import { EmitterLayer, type Emitter } from './emitters';
import { LightField, type DynamicLight } from './lightField';
import { Lighting, noonFlatLuminance } from './lighting';
import { Mist, MIST_CAP } from './mist';
import { ObjectLayer } from './objects';
import { faithfulToneMap } from './post';
import { buildTerrain, type TerrainBuild } from './terrain';
import type { ShaderNode } from './tsl';
import { buildWater, type WaterUniforms } from './water';
import { buildRain, type RainSystem } from './weather';
import { VOXEL_FILL } from './ra2/voxels';
import { groundFromHeights, setShadowGround } from './ra2/voxelShadow';
import { voxelLightingFor } from './ra2/vpl';
import type { HdWorld } from './ra2/world';
import { IsoCamera, LEVEL_HEIGHT, cellToWorld } from './world';

/** 'faithful' (default): identity below the knee, hue-preserving shoulder above (see post.ts). */
export type ToneMapper = 'faithful' | 'agx' | 'neutral' | 'aces';

/**
 * 'msaa4': 4x multisampled scene pass (default); 'fxaa': single-sample pass plus FXAA, the cheaper fallback. At
 * 2400x1500 device pixels the multisampled scene colour (RGBA16F) and depth take about 115 MB and 58 MB (plus a
 * 29 MB resolve texture), against about 29 MB and 14 MB single-sampled; devices reporting 4 GB of memory or less
 * (navigator.deviceMemory) default to 'fxaa'.
 */
export type Antialias = 'msaa4' | 'fxaa' | 'none';

/** Default anti-aliasing for this device (see Antialias). */
export function defaultAntialias(): Antialias {
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return memory !== undefined && memory <= 4 ? 'fxaa' : 'msaa4';
}

export interface HdSettings {
  toneMapper: ToneMapper;
  exposure: number;
  bloom: number;
  vignette: number;
  shadows: boolean;
  antialias: Antialias;
  /** RCAS sharpening after the display transform: 0 = strongest, 2 = off (three's SharpenNode scale); < 0 disables. */
  sharpness: number;
  /**
   * Diagnostics: 'overbright' shows white where the exposed scene (before bloom and tone map) exceeds luminance 1;
   * 'voxel-xy' / 'voxel-z' write raw voxel attributes (see ra2/vpl.ts voxelDebug) straight to the screen, for fitting
   * the voxel lighting against captures of the original.
   */
  debugView: 'none' | 'overbright' | 'voxel-xy' | 'voxel-z';
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
  dynamicLights: { explosion: number; flash: number; kept: number };
  lightFieldRenders: number;
  emitters: number;
  mist: number;
  wet: number;
  rain: number;
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
  readonly view = new IsoCamera();
  readonly settings: HdSettings = {
    toneMapper: 'faithful',
    exposure: 1,
    bloom: 0.55,
    vignette: 0.25,
    shadows: true,
    antialias: defaultAntialias(),
    // Mild: stronger RCAS (toward 0) turns upscaled grass and gravel crunchy at zoom 1.6.
    sharpness: 1,
    debugView: 'none',
  };
  /** Night presentation: map lights, HD lamps, windows, mist, night level (changeable at runtime). */
  readonly atmosphere: AtmosphereSettings = { ...DEFAULT_ATMOSPHERE_SETTINGS };
  private pipeline: RenderPipeline | undefined;
  /** Nodes of the current pipeline that own render targets (pass targets, bloom, FXAA and sharpen), freed on rebuild. */
  private pipelineNodes: { dispose(): void }[] = [];
  private readonly bloomStrength = uniform(0.55);
  /** Bloom threshold on the unexposed scene (see frame()). */
  private readonly bloomThreshold = uniform(NIGHT_BLOOM_THRESHOLD);
  private readonly blackLift = uniform(new Color(0, 0, 0));
  /** Share of PBR Neutral in the faithful display transform: the night weight on original maps (see post.ts). */
  private readonly nightDisplay = uniform(0);
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
  private readonly objects = new ObjectLayer();
  /** HD effects; live views spawn into it from the game's own effect list. */
  readonly effects: EffectsLayer;
  /** Lamp heads and wet-ground reflections. */
  readonly emitters: EmitterLayer;
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
    this.effects = new EffectsLayer(this.layerNodes);
    this.emitters = new EmitterLayer(this.layerNodes);
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
   * WebGPU devices default to 8192 px textures; ask for what the adapter really supports (16384 on Apple GPUs) so a
   * large map's upscaled whole-map terrain fits in one texture. Empty when WebGPU is unavailable.
   */
  static async adapterLimits(): Promise<Record<string, number>> {
    const gpu = (
      navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: Record<string, number> } | null> } }
    ).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    const max = adapter?.limits.maxTextureDimension2D;
    return max ? { maxTextureDimension2D: max } : {};
  }

  /** 'WebGPU' or 'WebGL2' once init() resolved. */
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
    setShadowGround(
      this.scene,
      groundFromHeights((x, z) => Math.max(this.terrain.heightAt(x, z), this.waterY), LEVEL_HEIGHT * 1.5),
    );
    if (world?.water) this.water = { uniforms: world.water };
    if (waterY !== null) {
      const water = buildWater(this.bounds.width, this.bounds.height, waterY, this.terrain.heightTexture);
      this.water = water;
      this.scene.add(water.mesh);
    }
    this.rain = buildRain(this.bounds.width, this.bounds.height, this.terrain.heightTexture, this.waterY, this.nodes);
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
    this.scene.add(this.terrain.mesh, this.lighting.root, this.effects.root, this.rain.object, this.emitters.root);
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

  /** Preserve geometry depth for atmosphere when cards reconstruct analytic occlusion depth in the fragment shader. */
  enablePainterDepth(): void {
    if (this.painterDepthEnabled) return;
    this.painterDepthEnabled = true;
    if (this.pipeline) this.buildPipeline();
  }

  private buildPipeline(): void {
    const { antialias, toneMapper, sharpness, debugView } = this.settings;
    // Release the previous pipeline's render targets and output material before building the new one (the MSAA scene
    // target alone is over 100 MB at 2400x1500).
    this.pipeline?.dispose();
    for (const node of this.pipelineNodes) node.dispose();
    const nodes: { dispose(): void }[] = (this.pipelineNodes = []);
    const scenePass = pass(this.scene, this.view.camera, { samples: antialias === 'msaa4' ? 4 : 0 });
    if (this.painterDepthEnabled) {
      // Store inverse physical depth: a black clear texel represents the untouched far plane. Alpha is a write
      // mask, independent of the art's coverage, matching which fragments write the scene's depth attachment.
      const preserved = Fn(([], builder: NodeBuilder) =>
        vec4(float(1).sub(physicalDepth), 0, 0, builder.material.depthWrite ? 1 : 0),
      )();
      scenePass.setMRT(
        mrt({ output: materialOutput, physicalDepth: preserved })
          .setBlendMode('physicalDepth', new BlendMode(NormalBlending))
          .setClearColor('physicalDepth', 0x000000, 0),
      );
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
    const shown: ShaderNode = vec4(misted.rgb.mul(visible), misted.a);
    // Bloom reads the unexposed scene; frame() sets its threshold from the exposure.
    const glow: ShaderNode = bloom(shown, 1, 0.45, this.bloomThreshold);
    glow.strength = this.bloomStrength;
    nodes.push(glow);
    const vignette = float(1).sub(
      smoothstep(0.45, 1.05, length(screenUV.sub(0.5).mul(1.6))).mul(this.vignetteStrength),
    );
    // Opaque output: the vignette darkens colour only (it used to scale alpha too, letting the page show in corners).
    const composite: ShaderNode = shown.rgb.add(glow.rgb.mul(visible)).mul(this.exposure).mul(vignette);
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
    const output: ShaderNode =
      toneMapper === 'faithful'
        ? renderOutput(vec4(mixed, 1), NoToneMapping)
        : renderOutput(vec4(composite, 1), TONE_MAPPERS[toneMapper]);
    const toe = float(1).sub(output.rgb.div(NIGHT_TOE)).max(0);
    let display: ShaderNode = vec4(output.rgb.add(this.blackLift.mul(visible).mul(toe.mul(toe))), 1);
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
    this.bloomStrength.value = this.settings.bloom;
    this.vignetteStrength.value = this.settings.vignette;
    // Original maps have no sun-shadow casters: the tile art paints terrain shading, sprites carry their own shadow
    // frames and voxels draw engine-style flattened shadows. Skipping the empty shadow map saves a full depth pass
    // and the per-pixel shadow lookups of every receiver.
    this.lighting.sun.castShadow = this.settings.shadows && !this.world;
    this.buildPipeline();
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
    // A storm is heavier rain (and wind); no lightning (decorative weather rule, docs/remaster/PLAN.md).
    const rainAmount = raining ? Math.min(1, env.weatherIntensity * (env.weather === 'storm' ? 1.3 : 1)) : 0;
    // Surfaces wet quickly under rain and dry slowly after it stops.
    const wet = this.terrain.wetness;
    wet.value = raining
      ? Math.min(1, wet.value + deltaSeconds * 0.25 * rainAmount)
      : Math.max(0, wet.value - deltaSeconds * 0.02);

    const profile = this.profile();
    this.lighting.setProfile(profile);
    this.lighting.follow(this.view.target);
    this.lighting.update(env.timeOfDay, raining ? 0.35 + 0.5 * rainAmount : 0);
    const light = this.lighting.state;
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
      : 0.05 * light.night;
    this.mist.amount.value = Math.min(MIST_CAP, baseMist * this.atmosphere.mist);
    if (this.mist.amount.value > 0 !== this.mistInPipeline) this.buildPipeline();

    this.rain.intensity.value = rainAmount;
    this.rain.windX.value = Math.cos(env.windDirection) * env.windStrength * 0.4;
    this.rain.windZ.value = Math.sin(env.windDirection) * env.windStrength * 0.4;
    this.rain.center.value.copy(this.view.target);

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
    this.effects.update(now, right, up, toCamera);
    this.emitters.cameraRight.value.copy(right);
    this.emitters.cameraUp.value.copy(up);
    this.emitters.toCamera.value.copy(toCamera);
    const sprites = this.world?.sprites;
    if (sprites) {
      sprites.cameraRight.value.copy(right);
      sprites.cameraUp.value.copy(up);
      sprites.toCamera.value.copy(toCamera);
      // Unlit original art takes the light a flat Lambert surface would: irradiance / pi, which the day exposure
      // (pi / noon irradiance) turns into colour x E / Enoon, exactly the original colour at clear noon and the same
      // level as the terrain around it. The night keeps the level it was tuned with (irradiance / reference).
      const spriteScale = 1 / Math.PI + (1 / reference - 1 / Math.PI) * nightGrade;
      this.lighting.flatIrradianceColor(sprites.light.value).multiplyScalar(spriteScale);
    }
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
    this.pipeline!.render();
    this.frames++;
    if (this.trackTimestamp && this.frames % 2 === 0) void this.collectGpuTimes();
  }

  /** Fires and explosions also show as glows and wet reflections, mirrored from the light field. */
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
      e.head = fire ? 0.5 : 0.8;
      for (let c = 0; c < 3; c++) {
        e.glow[c] = fire ? 0 : l.colour[c]! * k * 0.12;
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
      dynamicLights: { explosion: lf.explosion, flash: lf.flash, kept: lf.kept },
      lightFieldRenders: this.lightField.renders,
      emitters: this.emitters.staticEmitters,
      mist: this.mist.amount.value,
      wet: this.terrain.wetness.value,
      rain: this.nodes.rainAmount.value,
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
      this.pipeline!.render();
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

  /** Release this renderer's shader resources and GPU targets; call once the view stops presenting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pipeline?.dispose();
    for (const node of this.pipelineNodes) node.dispose();
    this.pipelineNodes.length = 0;
    this.lightField?.dispose();
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
