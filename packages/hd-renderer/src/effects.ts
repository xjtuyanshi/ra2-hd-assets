import {
  AdditiveBlending,
  Color,
  CustomBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  color,
  cos,
  cross,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, objectLight } from './atmosphere';
import type { LightField } from './lightField';
import { DirtyAttribute } from './dirtyAttribute';
import { waterTextures } from './proceduralTextures';
import type { ShaderNode } from './tsl';

const FIREBALLS = 96;
const FLAMES = 768;
const SMOKE = 1536;
const SPARKS = 1024;
const SCORCHES = 96;
const SHOCKWAVES = 48;
const EMBERS = 256;
/** Garnish flashes of the live view (a hot core inside the native art, muzzle and spark flashes). */
const GARNISH_FLASHES = 128;
const DOTS = 512;
/** Enhanced garnish pools (live view, 'enhanced' effect style): glow halos, rolling smoke, debris, heat haze, dust. */
const HALOS = 128;
const BILLOWS = 1024;
const DEBRIS = 1024;
const SHIMMERS = 64;
const DUST_RINGS = 64;
/** Enhanced fireballs drawn over the native art, and the puffs of the smoke columns that outlive a blast. */
const BLASTS = 96;
const COLUMN_PUFFS = 768;
/** Particle modes, separate from the original sandbox (0) and faithful garnish (1) spark values. */
const SPARK_HOT = 2;
const SPARK_ELECTRIC = 3;
/** Positive halo extras retain the original intensity; negative values select the enhanced colour treatments. */
const HALO_HD = -1;
const HALO_ELECTRIC = -2;

/**
 * Local light of each effect, drawn into the light field (irradiance; the exposure reference is noon flat ground, about
 * 3.4). Explosions are deliberately exaggerated: they light a wide circle for a moment, day or night.
 */
export const EFFECT_LIGHTS = {
  explosion: { colour: [1.0, 0.55, 0.22], radius: 6, peak: 28, life: 0.9, decay: 5 },
  muzzle: { colour: [1.0, 0.72, 0.4], radius: 2.5, peak: 5, life: 0.12, decay: 12 },
  fire: { colour: [1.0, 0.6, 0.26], radius: 3.6, peak: 5.5, flicker: 0.25, ttl: 0.6 },
} as const;
/**
 * Lights of the live view's garnish, far smaller than EFFECT_LIGHTS: the original's own art is the explosion, so HD adds
 * only a hint of its flash on the ground and on nearby units (radius from the effect table row, colour of the original
 * fire; peak at the centre relative to the ~3.4 noon reference, so an explosion of scale 1 adds about 70 %).
 */
export const GARNISH_LIGHTS = {
  explosion: { colour: [1, 0.62, 0.28], radius: 1.5, peak: 2.4, life: 0.6, decay: 9 },
  muzzle: { colour: [1, 0.85, 0.6], radius: 1.2, peak: 1.2, life: 0.12, decay: 18 },
  beam: { radius: 1.5, peak: 1.5, life: 0.1, decay: 12 },
  fire: { colour: [1.0, 0.6, 0.26], radius: 1.4, peak: 1.6, flicker: 0.25, ttl: 0.6 },
} as const;
/**
 * The live view's 'enhanced' effect style (GarnishOptions.enhanced): the original anim stays the base layer with its
 * own timing and size, and the remaster's modern effects play around it. Per unit of the effect table's garnish scale
 * `s` (about 0.2 for a small bang, 0.9 for TWLT070, up to 3.5 for building collapses) and of the native art's width W:
 *   - a real flash of light on the ground, buildings and units around it (light field pulse: radius, peak, life, decay;
 *     the exposure reference is noon flat ground, about 3.4);
 *   - an additive glow halo about 2 W wide for a third of a second (bloom picks it up), over a hotter core;
 *   - hot sparks and tumbling debris chunks that land;
 *   - rolling smoke puffs with sunlit tops, sky-lit rims and the fire's glow underneath, rising after the flash and
 *     outliving the art by a couple of seconds;
 *   - a heat shimmer over the blast and a dust ring racing out over the ground;
 *   - for anims that leave the engine's crater or scorch (Scorch=yes / Crater=yes), the crater glowing hot and cooling
 *     for a few seconds.
 * Round two of the style (the first read as the original with a flash): a detailed, boiling fireball drawn over the
 * native art for its own duration and footprint (it covers most of the pixel art and cools into soot, in the original
 * palette's fire colours); a longer, stronger light; a smoke column that keeps rising and drifting for about ten
 * seconds after a big blast; charred ground around craters that fades over most of a minute (the engine's own crater
 * smudge stays underneath); more and longer sparks; debris that lands and stays on the ground for a few seconds.
 */
export const ENHANCED = {
  /** Temperature, linear RGB and HDR gain. Interpolate the gained colours, never sRGB hex colours. */
  ramp: [
    { temperature: 0, colour: [0.25, 0.03, 0], gain: 0.12 },
    { temperature: 0.25, colour: [1, 0.12, 0.02], gain: 0.6 },
    { temperature: 0.5, colour: [1, 0.38, 0.06], gain: 1.2 },
    { temperature: 0.75, colour: [1, 0.7, 0.25], gain: 2 },
    { temperature: 1, colour: [1, 0.93, 0.75], gain: 3 },
  ],
  light: {
    colour: [1, 0.42, 0.14],
    radius: 1.8,
    // Tighter than the sample-2 blast light (3.8 / 10): a wide pulse washed whole lawns and plazas yellow, which reads
    // as a warm grade; the heat now stays on the blast's own neighbourhood and the objects next to it.
    radiusPerScale: 2.8,
    peak: 4,
    peakPerScale: 6.5,
    life: 1.8,
    decay: 1.7,
  },
  /** The first light pulse: ramp temperature, radius/peak relative to the longer glow, seconds and inverse seconds. */
  flash: { temperature: 0.8, radius: 0.7, peak: 1, life: 0.18, decay: 24 },
  /** HD art carries the fireball: its narrower halo grades from a hot centre to a red rim, cooling over its life. */
  halo: {
    width: 1.6,
    life: 0.4,
    intensity: 1.8,
    hdWidth: 0.9,
    hdIntensity: 0.35,
    hdCore: 0.6,
    rim: 0.25,
    cooling: 0.3,
    falloff: 3,
  },
  /** Fireball over the native art: width and lifetime relative to the art's, share of the art it covers. */
  fireball: { width: 0.95, life: 0.95, cover: 0.82 },
  /**
   * Start temperatures and streak aspect ratios; projected speed in cells/s reaches the longest streak at `speed`.
   * Starts of 0.5..0.85 give yellow-orange streaks; hotter starts clipped to pale cream lines over bright ground.
   */
  sparks: { count: 26, perScale: 44, temperature: [0.5, 0.85], stretch: [2, 6], speed: 8 },
  /**
   * Airborne embers: fixed pool, count per blast, delayed births, life and slowing convection in seconds/cells.
   * `volume` and `height` scale the blast's width; wind/drift are horizontal speeds, wobble is displacement, and
   * flicker is noise amplitude. Wobble ramps in over `wobbleIn` seconds; fades are fractions of particle lifetime.
   * Fires emit `fireRate` per second at scale 1; catch-up is bounded after a stalled frame.
   */
  embers: {
    pool: 512,
    count: 10,
    perScale: 20,
    delay: 0.6,
    life: [1.5, 3.5],
    temperature: [0.7, 0.95],
    size: [0.018, 0.035],
    rise: [0.4, 0.9],
    drag: 0.65,
    wind: 0.7,
    drift: 0.12,
    volume: 0.65,
    height: 0.5,
    wobble: 0.12,
    wobbleRate: 2.5,
    wobbleIn: 0.25,
    flicker: 0.45,
    flickerRate: 16,
    fadeIn: 0.06,
    fadeOut: 0.65,
    fireRate: [2, 4],
    fireWidth: 0.45,
    catchup: 0.5,
  },
  /** Debris: chunks per blast; `rest` seconds on the ground, `glowLife` seconds cooling from core to rim temperature. */
  debris: { count: 5, perScale: 10, rest: 5, glowLife: 1.1, rim: 0.65 },
  smoke: { count: 2, perScale: 5, delay: 0.14, life: 2.8, size: 0.42, opacity: 0.85 },
  /** Smoke column (blasts of scale >= `from`): puffs emitted over `span` seconds, each rising for `life` seconds. */
  column: { from: 0.35, count: 4, perScale: 8, span: 6, life: 11, rise: 0.32, size: 0.55 },
  shimmer: { width: 1.5, life: 1.0 },
  dust: { width: 2.2, life: 0.9 },
  /** Ember-bed width/lifetime and edge temperature; the centre starts at temperature 1 and cools to zero. */
  crater: { width: 0.6, life: 3.5, rim: 0.25 },
  /** Charred ground around a crater: width relative to the art, seconds until it has faded. */
  char: { width: 1.8, life: 45 },
  /**
   * Muzzle star: art-relative width with the existing world-size caps, life in seconds, ray count, radial reach and
   * angular jitter (fraction of ray spacing). Core/ray widths use the unit disc; `rayFade` is the solid share of reach.
   * Temperature falls radially and in time.
   */
  muzzle: {
    width: 0.8,
    minWidth: 0.25,
    maxWidth: 1.5,
    fallbackWidth: 0.9,
    life: [0.06, 0.09],
    rays: [5, 7],
    rayLength: [0.45, 1],
    rayWidth: 0.055,
    rayJitter: 0.3,
    rayFade: 0.65,
    core: 0.2,
    rim: 0.5,
    cooling: 0.3,
    intensity: 1.2,
    haloWidth: 1.8,
    haloLife: 0.12,
    haloIntensity: 1.2,
    light: { colour: [1, 0.78, 0.45], radius: 2.2, peak: 2.8, life: 0.14, decay: 14 },
  },
  /**
   * Bolt widths are fractions of the existing segment quad (no wider geometry); HDR gains separate the white core,
   * beam-coloured inner glow and violet/cyan fringe. Noise varies with position and the presented-frame effect clock.
   * Branch lengths are fractions of BOLT_STEP; impacts use world-cell width, seconds and linear blue-white colour.
   */
  bolts: {
    core: 0.14,
    inner: 0.55,
    coreGain: 2.6,
    innerGain: 1.4,
    outerGain: 0.6,
    violet: [0.55, 0.45, 1],
    violetMix: 0.5,
    flicker: 0.65,
    flickerRate: 48,
    noiseScale: 14,
    branchEvery: 3,
    branchLength: [0.25, 0.5],
    impact: {
      colour: [0.65, 0.82, 1],
      width: 0.6,
      life: 0.12,
      intensity: 1.6,
      sparks: 3,
      sparkSize: 0.035,
      sparkLife: [0.18, 0.35],
      sparkSpeed: 1.8,
    },
  },
} as const;

/**
 * Enhanced incandescent colour in linear HDR light. The five stops include their brightness, so both CPU and TSL
 * interpolate exactly the same radiance and cooling cannot become brighter between stops. The original fireRamp is
 * deliberately separate: native-art garnish and sandbox effects retain their existing palette and exposure.
 */
export function emberRamp(temperature: ShaderNode): ShaderNode {
  const stops = ENHANCED.ramp;
  let rgb: ShaderNode = vec3(...stops[0].colour).mul(stops[0].gain);
  for (let i = 1; i < stops.length; i++) {
    const before = stops[i - 1]!;
    const next = stops[i]!;
    const blend = clamp(temperature.sub(before.temperature).div(next.temperature - before.temperature), 0, 1);
    rgb = mix(rgb, vec3(...next.colour).mul(next.gain), blend);
  }
  return rgb;
}

/** Plain TypeScript twin of emberRamp, including clamping outside the temperature interval [0, 1]. */
export function emberRampRgb(t: number): [number, number, number] {
  const stops = ENHANCED.ramp;
  const rgb: [number, number, number] = stops[0].colour.map((c) => c * stops[0].gain) as [number, number, number];
  for (let i = 1; i < stops.length; i++) {
    const before = stops[i - 1]!;
    const next = stops[i]!;
    const blend = Math.max(0, Math.min(1, (t - before.temperature) / (next.temperature - before.temperature)));
    for (let c = 0; c < 3; c++) rgb[c] = rgb[c]! + (next.colour[c]! * next.gain - rgb[c]!) * blend;
  }
  return rgb;
}

/**
 * Opacity of a live-view garnish smoke puff relative to the renderer's own smoke: the original trail art under it is
 * already the smoke, so the HD puff only softens it.
 */
const GARNISH_SMOKE_OPACITY = 0.45;
/** Seconds between flame tongues of one persistent fire. */
const FIRE_INTERVAL = 1 / 14;
/** Share of a persistent fire's beats that also emit a puff of its dark smoke column. */
const FIRE_SMOKE = 0.45;
/**
 * Fire colours in linear light, golden rather than red: a red-dominant colour pushed into the tone mapper's shoulder
 * desaturates towards pink, a golden one towards the yellow-white of a real flame core.
 */
const FLAME_CORE = vec3(1.0, 0.75, 0.35);
const FLAME_EDGE = vec3(1.0, 0.42, 0.1);
const FLAME_TIP = vec3(0.9, 0.22, 0.04);

/**
 * Multiplier on every live garnish size (1 = matched to the original art's footprint). A single knob in case more
 * exaggeration is wanted later; the live view's native anim art stays the base layer either way.
 */
export const FX_GARNISH = 1;

/**
 * A ring buffer of instanced particles whose per-instance data lives in GPU attributes; only spawns touch the CPU.
 * Materials collapse dead instances to a point in the vertex stage (particleInputs().alive), so particles past their
 * lifetime cost no fragments, and the whole mesh is hidden once the last spawned particle has died (`until`). Spawns
 * write the CPU arrays only; `flush` (once per presented frame, from EffectsLayer.update) uploads the span they wrote
 * as at most two ranges per attribute (the span may wrap around the ring), so a burst of spawns costs a few buffer
 * writes instead of four per particle.
 */
class ParticlePool {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicNodeMaterial;
  readonly start: InstancedBufferAttribute;
  readonly origin: InstancedBufferAttribute;
  readonly velocity: InstancedBufferAttribute;
  readonly params: InstancedBufferAttribute;
  private cursor = 0;
  /** First slot written since the last flush, and how many slots (capped at the pool size). */
  private dirtyFrom = 0;
  private dirtyCount = 0;
  private readonly attributes: readonly InstancedBufferAttribute[];
  /** Seconds (effect clock) at which the last spawned particle dies; the pool draws nothing after that. */
  until = -Infinity;

  constructor(
    count: number,
    geometry: PlaneGeometry,
    material: MeshBasicNodeMaterial,
    build: (pool: ParticlePool) => void,
  ) {
    this.start = new InstancedBufferAttribute(new Float32Array(count).fill(-1e6), 1);
    this.origin = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.velocity = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    // x = size, y = lifetime, z = seed, w = per-pool extra (smoke: soot; sparks: style; garnish fire: ground cover)
    this.params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.attributes = [this.start, this.origin, this.velocity, this.params];
    this.material = material;
    this.mesh = new InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    build(this);
  }

  spawn(now: number, origin: Vector3, velocity: Vector3, size: number, lifetime: number, extra = 0): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.start.count;
    this.start.setX(i, now);
    this.origin.setXYZ(i, origin.x, origin.y, origin.z);
    this.velocity.setXYZ(i, velocity.x, velocity.y, velocity.z);
    this.params.setXYZW(i, size, lifetime, Math.random(), extra);
    this.until = Math.max(this.until, now + lifetime);
    if (this.dirtyCount === 0) this.dirtyFrom = i;
    this.dirtyCount = Math.min(this.start.count, this.dirtyCount + 1);
  }

  /** Upload what spawns wrote since the last flush. */
  flush(): void {
    if (this.dirtyCount === 0) return;
    const count = this.dirtyCount;
    const size = this.start.count;
    const from = count >= size ? 0 : this.dirtyFrom;
    const first = Math.min(count, size - from);
    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(from * attribute.itemSize, first * attribute.itemSize);
      if (first < count) attribute.addUpdateRange(0, (count - first) * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.dirtyCount = 0;
  }
}

/** Slot spans [from, count] of `count` ring-buffer slots written from `from` on, in a ring of `size`. */
export function dirtySpans(from: number, count: number, size: number): [number, number][] {
  if (count <= 0) return [];
  if (count >= size) return [[0, size]];
  const end = from + count;
  return end <= size
    ? [[from, count]]
    : [
        [from, size - from],
        [0, end - size],
      ];
}

/**
 * Garnish fire colour ramp from the original anim.pal entries the explosion and fire SHPs use most (TWLT*, EXPLO*, S_*,
 * FIRE0x): soot brown (the cooling edge, lit by the scene like smoke), orange (255,157,58), orange (255,178,76), pale
 * yellow (255,246,145). Hue stays between 30 and 58 degrees like the art's bright pixels (their measured hot hue is
 * 43-52 degrees); no red end, so neither the rim nor a desaturating highlight drifts towards salmon or pink.
 */
const FIRE_SOOT = color(0x4a3a2e);
const FIRE_DEEP = color(0xff9d3a);
const FIRE_MID = color(0xffb24c);
const FIRE_CORE = color(0xfff691);
function fireRamp(temperature: ShaderNode, sceneLight: ShaderNode): ShaderNode {
  const soot: ShaderNode = FIRE_SOOT;
  const a = mix(soot.mul(sceneLight), FIRE_DEEP, smoothstep(0.0, 0.3, temperature));
  const b = mix(a, FIRE_MID, smoothstep(0.3, 0.6, temperature));
  return mix(b, FIRE_CORE, smoothstep(0.6, 0.95, temperature));
}

/**
 * Limits the live view derives from the native anim a garnish accompanies. Passing options (even empty ones) selects
 * the garnish form of explode / muzzleFlash; without them those methods draw the full procedural effect of the
 * renderer's own events (sandbox explosions), which have no original art under them.
 */
export interface GarnishOptions {
  /** Largest fireball diameter in world units (the native art's width). */
  maxSize?: number;
  /** Seconds the garnish may last at most (1.2 x the native anim). */
  maxLife?: number;
  /** Smoke puffs to add (0 = none). */
  smoke?: number;
  /** Light colour (linear) and radius in world units; omitted = the default garnish light, null = none. */
  light?: readonly [number, number, number, number] | null;
  /** Leave a scorch decal (only when the engine's own crater is not drawn). */
  scorch?: boolean;
  /** The 'enhanced' effect style: the modern effects around the native art (see ENHANCED). */
  enhanced?: boolean;
  /** An HD flipbook replaces the native art; the enhanced explosion draws no procedural fireball over it. */
  hdArt?: boolean;
  /** Enhanced style: the anim leaves the engine's crater or scorch, so the crater glows hot for a moment. */
  hotCrater?: boolean;
}

export class EffectsLayer {
  readonly root = new Object3D();
  /** Seconds, shared by CPU spawns and GPU animation. */
  readonly now = uniform(0);
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  /** Towards the (orthographic) camera: billboards are pulled along it so they never cut into the ground. */
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /**
   * Scene light relative to the noon reference, like the original art's (1 = full daylight): the garnish's cooling soot
   * and the unknown-projectile dots are lit, not emissive. A live view shares the sprite layer's Color here.
   */
  readonly sceneLight = uniform(new Color(1, 1, 1));
  /** Enhanced heat halo around HD-art blasts: gain and centre temperature (ENHANCED.halo; uniforms for look reviews). */
  readonly hdHaloGain = uniform(ENHANCED.halo.hdIntensity);
  readonly hdHaloCore = uniform(ENHANCED.halo.hdCore);
  private readonly fireballs: ParticlePool;
  /** Flame tongues of persistent fires (burning wrecks, napalm). */
  private readonly flames: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly sparks: ParticlePool;
  /** Enhanced style only: airborne, cooling specks, independent of the original ground ember bed. */
  private readonly airborneEmbers: ParticlePool;
  /** Enhanced muzzle star, kept separate so faithful garnish retains its fire mask and timing. */
  private readonly muzzleStar: ParticlePool;
  private readonly scorch: ParticlePool;
  private readonly shock: ParticlePool;
  /** Hot bed of a persistent fire on the ground: the base its flame tongues rise from. */
  private readonly embers: ParticlePool;
  /** Live garnish flashes: premultiplied fire in the original's colours, small and short. */
  private readonly garnishFire: ParticlePool;
  /** Small opaque dots (projectiles whose art is unknown). */
  private readonly dots: ParticlePool;
  /** Energy beams (lasers, bolts) of the current logic frame, as soft-edged segments. */
  private readonly beams: BeamLayer;
  /** Live driver opt-in; sandbox and faithful beams retain their original geometry and shading. */
  enhancedBeams = false;
  /** Enhanced style: additive glow halos (bloomed) around a blast. */
  private readonly halo: ParticlePool;
  /** Enhanced style: rolling smoke puffs, sunlit and glowing from the fire below. */
  private readonly billow: ParticlePool;
  /** Enhanced style: tumbling debris chunks. */
  private readonly debris: ParticlePool;
  /** Enhanced style: heat shimmer (refracts the frame drawn so far). */
  private readonly shimmer: ParticlePool;
  /** Enhanced style: dust rings over the ground. */
  private readonly dust: ParticlePool;
  /** Enhanced style: boiling fireballs over the native art. */
  private readonly blast: ParticlePool;
  /** Enhanced style: long-lived puffs of rising smoke columns. */
  private readonly column: ParticlePool;
  /** Where effect lights go; null until the renderer attaches its light field (effects then cast no light). */
  private lightField: LightField | null = null;
  /** Next flame emission per persistent fire key. */
  private readonly fireEmit = new Map<string, number>();
  /** Tracked fire positions are stable objects; weak ownership releases the schedule when an anim disappears. */
  private readonly emberEmit = new WeakMap<Vector3, number>();
  /** Every pool, in draw order. */
  private readonly pools: readonly ParticlePool[];
  private readonly zeroVelocity = new Vector3();
  /** Seconds of camera shake still pending, scaled by explosion size (the live view never shakes). */
  shake = 0;

  constructor(readonly nodes = DEFAULT_ATMOSPHERE_NODES) {
    const quad = new PlaneGeometry(1, 1);

    this.fireballs = new ParticlePool(FIREBALLS, quad, additive(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.35).add(smoothstep(0, 0.35, t).mul(0.9)));
      pool.material.positionNode = billboard(
        origin.add(vec3(0, t.mul(0.35), 0)).add(this.toCamera.mul(grow.mul(0.5))),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const turbulence = mx_noise_float(vec3(p.mul(2.2), seed.mul(10).add(t.mul(2)))).mul(0.35);
        const radius = length(p).add(turbulence);
        const core = smoothstep(1.0, 0.1, radius);
        const heat = float(1).sub(t);
        // Golden fire: red-orange edges, a yellow core, white-hot only in the first instants.
        const hot = smoothstep(0.3, 0.9, core.mul(heat));
        const tint = mix(mix(FLAME_EDGE, FLAME_CORE, hot), vec3(1.0, 0.92, 0.75), smoothstep(0.75, 1.0, heat).mul(hot));
        // The edge fade keeps the noise-displaced core from showing the quad's square edges.
        const alpha = core
          .mul(smoothstep(1.0, 0.55, t))
          .mul(smoothstep(0.0, 0.04, age))
          .mul(smoothstep(1.0, 0.8, length(p)));
        return vec4(tint.mul(float(1.1).add(heat.mul(1.3))), alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    // Flame tongues: upright (twice as tall as wide), rising, licked sideways by noise, flickering; yellow at the root,
    // orange and red towards the tip.
    this.flames = new ParticlePool(FLAMES, quad, additive(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const width = size
        .mul(
          float(0.7)
            .add(smoothstep(0, 0.25, t).mul(0.3))
            .sub(smoothstep(0.5, 1, t).mul(0.45)),
        )
        .mul(alive);
      // Tongues stay rooted in the fire's bed: the base drifts up only a little while the tongue stretches taller over
      // its life, so flames lick upwards instead of detaching and floating away.
      const height = width.mul(float(1.3).add(t.mul(0.9)));
      const base = velocity.mul(min(age, life)).mul(0.25);
      pool.material.positionNode = origin
        .add(base)
        .add(this.toCamera.mul(size.mul(1.2)))
        .add(this.cameraRight.mul(positionLocal.x.mul(width)))
        .add(this.cameraUp.mul(positionLocal.y.add(0.5).mul(height)));
      pool.material.colorNode = Fn(() => {
        const y = uv().y;
        const lick = mx_noise_float(vec3(y.mul(2.5).sub(this.now.mul(3.5)), seed.mul(13), t.mul(2))).mul(0.3);
        const x = uv().x.sub(0.5).mul(2).add(lick.mul(y));
        // Teardrop: widest a quarter up, closing to a flickering tip.
        const halfWidth = pow(float(1).sub(y), 0.9).mul(smoothstep(0.0, 0.25, y).mul(0.3).add(0.5));
        const tip = mx_noise_float(vec3(x.mul(3), y.mul(4).sub(this.now.mul(5)), seed.mul(7))).mul(0.18);
        const body = smoothstep(halfWidth, halfWidth.mul(0.35), x.abs())
          .mul(smoothstep(1.0, 0.55, y.add(tip)))
          .mul(smoothstep(0.0, 0.14, y));
        const heat = float(1)
          .sub(y)
          .mul(float(1).sub(t.mul(0.6)));
        const tint = mix(
          mix(FLAME_TIP, FLAME_EDGE, smoothstep(0.1, 0.45, heat)),
          FLAME_CORE,
          smoothstep(0.45, 0.9, heat),
        );
        const flicker = float(0.85).add(mx_noise_float(vec3(this.now.mul(11), seed.mul(31), 0)).mul(0.3));
        const alpha = body
          .mul(smoothstep(0.0, 0.12, t))
          .mul(smoothstep(1.0, 0.6, t))
          .mul(t.lessThan(1).select(float(1), float(0)));
        // About eight tongues overlap in a burning wreck (additive): each stays dim, so the stack peaks at 1.5-2x the
        // exposure reference instead of washing out to white.
        return vec4(tint.mul(float(0.16).add(heat.mul(0.26))).mul(flicker), alpha);
      })();
    });

    this.smoke = new ParticlePool(SMOKE, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive, extra } = particleInputs(pool, this.now);
      // params.w: 1 = the dark soot of a burning wreck, 2 = a live-view garnish puff (lighter, over original art).
      const garnish: ShaderNode = step(1.5, extra);
      const soot: ShaderNode = clamp(extra.sub(garnish.mul(2)), 0, 1);
      const t = clamp(age.div(life), 0, 1);
      // Rise and spread while slowing down (drag); wind is folded into the spawn velocity.
      const drift = velocity.mul(float(1).sub(float(1).div(min(age, life).mul(0.9).add(1)))).mul(1.6);
      const grow = size.mul(float(0.5).add(t.mul(1.8))).mul(alive);
      // Pulled towards the camera by half its size, so a puff never cuts a hard edge into the ground or water.
      pool.material.positionNode = billboard(
        origin.add(drift).add(this.toCamera.mul(grow.mul(0.5))),
        grow,
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(1.8), seed.mul(20).add(t.mul(1.5)))).mul(0.3);
        const mask = smoothstep(1.0, 0.2, length(p).add(n));
        // Unlit smoke follows the scene's light level (1 at clear noon) and glows near fires and explosions, lit from
        // below at half the light's saturation (objectLight), so a blast next to water never paints it deep red.
        // Soot glows more from the fire under it (lit from below).
        const lit = this.nodes.sceneBrightness.add(
          objectLight(positionWorld.xz, this.nodes).div(this.nodes.referenceLevel).mul(float(0.5).add(soot)),
        );
        // Neutral greys like the original smoke art (anim.pal 68..137, R = G = B); soot is near black.
        const grey = mix(mix(color(0x3a3a3a), color(0x858585), seed), color(0x141210), soot);
        const shade = grey.mul(mix(float(1.6), float(0.9), smoothstep(0, 0.25, t))).mul(lit);
        // Soot fades in slowly as it rises, so it never lays dark discs on the ground beside the fire.
        const alpha = mask
          .mul(smoothstep(0.0, mix(float(0.08), float(0.3), soot), t))
          .mul(smoothstep(1.0, 0.35, t))
          .mul(mix(float(0.7), float(0.5), soot))
          .mul(mix(float(1), float(GARNISH_SMOKE_OPACITY), garnish));
        return vec4(shade, alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    this.sparks = new ParticlePool(SPARKS, new PlaneGeometry(1, 1), additive(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive, extra: garnish } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const flight = min(age, life);
      const gravity = vec3(0, -9.0, 0).mul(flight.mul(flight).mul(0.5));
      const position = origin.add(velocity.mul(flight)).add(gravity);
      const width = size.mul(float(1).sub(t)).mul(alive);
      const enhanced = step(1.5, garnish);
      const currentVelocity = velocity.add(vec3(0, flight.mul(-9), 0));
      const projected = vec2(dot(currentVelocity, this.cameraRight), dot(currentVelocity, this.cameraUp));
      const speed = length(projected);
      // A spark travelling into the camera has no screen direction; use a finite horizontal streak in that case.
      const direction = speed.greaterThan(1e-4).select(projected.div(max(speed, 1e-4)), vec2(1, 0));
      const along = this.cameraRight.mul(direction.x).add(this.cameraUp.mul(direction.y));
      const across = this.cameraRight.mul(direction.y.negate()).add(this.cameraUp.mul(direction.x));
      const streak = mix(...ENHANCED.sparks.stretch, clamp(speed.div(ENHANCED.sparks.speed), 0, 1));
      const stretched = position
        .add(along.mul(positionLocal.x.mul(width).mul(streak)))
        .add(across.mul(positionLocal.y.mul(width)));
      pool.material.positionNode = mix(
        billboard(position, width, this.cameraRight, this.cameraUp),
        stretched,
        enhanced,
      );
      pool.material.colorNode = Fn(() => {
        const mask = smoothstep(1.0, 0.0, length(uv().sub(0.5).mul(2)));
        // Garnish sparks (live view) are a pale gold just over the bloom threshold; the renderer's own blasts glow hot.
        const original = mix(color(0xffc070).mul(8), color(0xffd27a).mul(3), clamp(garnish, 0, 1));
        const temperature = mix(...ENHANCED.sparks.temperature, seed).mul(float(1).sub(t));
        const hot = emberRamp(temperature);
        // Electrical particles keep their blue-white hue while sharing the hot ramp's cooling radiance.
        const electric = vec3(...ENHANCED.bolts.impact.colour).mul(hot.x);
        const tint = mix(original, garnish.equal(SPARK_ELECTRIC).select(electric, hot), enhanced);
        return vec4(tint, mask.mul(float(1).sub(t)).mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    // Enhanced airborne embers rise with decaying convection, follow the spawn's wind and wobble across it. Births
    // can be delayed inside a blast; clamped age keeps their hidden vertices finite before they start. All motion,
    // flicker and cooling stay on the GPU, and this pool never receives sandbox or faithful particles.
    this.airborneEmbers = new ParticlePool(ENHANCED.embers.pool, quad, additive(), (pool) => {
      const e = ENHANCED.embers;
      const { age, life, size, seed, origin, velocity, alive, extra: temperature } = particleInputs(pool, this.now);
      const flight = clamp(age, 0, life);
      const t = flight.div(life);
      const rise = velocity.y.mul(float(1).sub(exp(flight.mul(-e.drag)))).div(e.drag);
      const wobble = vec3(
        mx_noise_float(vec3(seed.mul(31), flight.mul(e.wobbleRate), 0)),
        0,
        mx_noise_float(vec3(seed.mul(17), flight.mul(e.wobbleRate), 7)),
      )
        .mul(e.wobble)
        .mul(smoothstep(0, e.wobbleIn, flight));
      const at = origin.add(vec3(velocity.x.mul(flight), rise, velocity.z.mul(flight))).add(wobble);
      pool.material.positionNode = billboard(at, size.mul(alive), this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const mask = smoothstep(1, 0, length(uv().sub(0.5).mul(2)));
        const flicker = float(1).add(mx_noise_float(vec3(seed.mul(43), this.now.mul(e.flickerRate), 0)).mul(e.flicker));
        const fade = smoothstep(0, e.fadeIn, t).mul(smoothstep(1, e.fadeOut, t));
        return vec4(emberRamp(temperature.mul(float(1).sub(t))).mul(flicker), mask.mul(fade));
      })();
    });

    // A short muzzle star with independently varied rays inside the old flash's footprint. A bounded unrolled mask
    // draws five to seven rays, with no extra geometry or material per ray; only the enhanced muzzle path spawns it.
    this.muzzleStar = new ParticlePool(GARNISH_FLASHES, quad, additive(), (pool) => {
      const e = ENHANCED.muzzle;
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = billboard(
        origin.add(this.toCamera.mul(size.mul(0.5))),
        size.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const radius = length(p);
        const count = seed
          .mul(e.rays[1] - e.rays[0] + 1)
          .floor()
          .add(e.rays[0])
          .min(e.rays[1]);
        const spacing = float(Math.PI * 2).div(count);
        let mask: ShaderNode = smoothstep(e.core, 0, radius);
        for (let i = 0; i < e.rays[1]; i++) {
          const noise = mx_noise_float(vec3(seed.mul(53), i * 17, 0));
          const angle = seed.mul(Math.PI * 2).add(spacing.mul(float(i).add(noise.mul(e.rayJitter))));
          const direction = vec2(cos(angle), sin(angle));
          const along = dot(p, direction);
          const across = abs(dot(p, vec2(direction.y.negate(), direction.x)));
          const reach = mix(...e.rayLength, clamp(noise.add(0.5), 0, 1));
          const ray = smoothstep(e.rayWidth, 0, across)
            .mul(smoothstep(0, e.core, along))
            .mul(smoothstep(reach, reach.mul(e.rayFade), along))
            .mul(float(i).lessThan(count).select(float(1), float(0)));
          mask = max(mask, ray);
        }
        const temperature = float(1)
          .sub(radius.mul(1 - e.rim))
          .sub(t.mul(e.cooling));
        return vec4(emberRamp(temperature).mul(e.intensity), mask.mul(float(1).sub(t)));
      })();
    });

    const ground = new PlaneGeometry(1, 1);
    ground.rotateX(-Math.PI / 2);
    // Scorch decal. params.w = 1: the enhanced style's charred ground (see enhancedExplosion): soot streaks thrown out
    // radially around the crater, darkest near it, lit by the scene, fading over most of a minute.
    this.scorch = new ParticlePool(SCORCHES, ground, blended(), (pool) => {
      const { age, life, size, seed, origin, alive, extra: charred } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = origin.add(vec3(0, 0.015, 0)).add(positionLocal.mul(size.mul(alive)));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const r = length(p);
        const n = mx_noise_float(vec3(p.mul(3.0), seed.mul(30))).mul(0.35);
        const mask = smoothstep(1.0, 0.3, r.add(n));
        const ember: ShaderNode = color(0xff5a1a).mul(
          smoothstep(0.35, 0.0, r)
            .mul(smoothstep(0.08, 0.0, t))
            .mul(4),
        );
        const plain = vec4(color(0x0d0b09).add(ember), mask.mul(0.8).mul(smoothstep(1.0, 0.6, t)));
        // Charred ground: rays of soot (noise along the angle, stretched along the radius) over a dark disc.
        const angle = p.y.atan(p.x);
        const rays = mx_noise_float(vec3(angle.cos().mul(2.6), angle.sin().mul(2.6), seed.mul(40).add(r.mul(0.7))));
        const fine = mx_noise_float(vec3(p.mul(9.0), seed.mul(11)));
        // (MaterialX noise stays mostly within +-0.4: stretch it to reach the rim with the longest rays.)
        const reach = clamp(float(0.5).add(rays.mul(1.1)).add(fine.mul(0.1)), 0.25, 0.98);
        const soot = smoothstep(reach, reach.mul(0.4), r)
          .mul(0.55)
          .add(smoothstep(0.6, 0.15, r.add(fine.mul(0.08))).mul(0.5));
        const shade: ShaderNode = mix(color(0x120e0b), color(0x2e251c), fine.mul(0.5).add(0.5)).mul(this.sceneLight);
        const char = vec4(
          shade.add(ember.mul(0.6)),
          clamp(soot, 0, 0.88)
            .mul(smoothstep(0.0, 0.02, t))
            .mul(smoothstep(1.0, 0.35, t)),
        );
        return mix(plain, char, step(0.5, charred));
      })();
    });
    this.scorch.mesh.renderOrder = 5;

    // Ground shockwave: a hot ring racing outward in the first half-second, the part that sells "big boom" at RTS zoom.
    this.shock = new ParticlePool(SHOCKWAVES, ground, additive(), (pool) => {
      const { age, life, size, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const radius = size.mul(float(0.15).add(smoothstep(0, 1, t).mul(1.0))).mul(alive);
      pool.material.positionNode = origin.add(vec3(0, 0.03, 0)).add(positionLocal.mul(radius));
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        // A thin hot ring only; a filled disc reads as a coloured halo over dark water.
        const ring = smoothstep(0.1, 0.0, d.sub(0.85).abs());
        const fade = float(1).sub(t).mul(float(1).sub(t));
        return vec4(
          color(0xffe2b8).mul(1.4),
          ring
            .mul(fade)
            .mul(0.8)
            .mul(t.lessThan(1).select(float(1), float(0))),
        );
      })();
    });

    // Ember bed: a flat, flickering, white-yellow core on the ground under a persistent fire (additive), refreshed with
    // every flame beat.
    this.embers = new ParticlePool(EMBERS, ground, additive(), (pool) => {
      const { age, life, size, seed, origin, alive, extra: cooling } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = origin.add(vec3(0, 0.025, 0)).add(positionLocal.mul(size.mul(alive)));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(3.0), seed.mul(17).add(this.now.mul(2.5)))).mul(0.3);
        const d = length(p).add(n);
        const bed = smoothstep(1.0, 0.2, d);
        const core = smoothstep(0.45, 0.0, d);
        const temperature = mix(float(1), float(ENHANCED.crater.rim), clamp(d, 0, 1)).mul(float(1).sub(t));
        const tint = mix(mix(FLAME_EDGE, vec3(1.0, 0.9, 0.6), core), emberRamp(temperature), cooling);
        const fade = smoothstep(0.0, 0.15, t).mul(smoothstep(1.0, 0.5, t));
        return vec4(tint.mul(bed.mul(0.5).add(core.mul(0.9))), fade.mul(0.55));
      })();
    });
    this.embers.mesh.renderOrder = 6;

    // Live garnish flash: centred on the native card (no lift, pulled towards the camera so it sits in front of it),
    // hottest in the middle of a young flash, cooling through the original's oranges to lit soot at the rim.
    this.garnishFire = new ParticlePool(GARNISH_FLASHES, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, alive, extra: cover } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.35).add(smoothstep(0, 0.35, t).mul(0.9)));
      pool.material.positionNode = billboard(
        origin.add(this.toCamera.mul(grow.mul(0.5))),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const turbulence = mx_noise_float(vec3(p.mul(2.2), seed.mul(10).add(t.mul(2)))).mul(0.35);
        const core = smoothstep(1.0, 0.1, length(p).add(turbulence));
        const heat = float(1).sub(t);
        const temperature = clamp(core.mul(heat.add(0.1)), 0, 1);
        // Peak ~1.7 linear: bright enough to bloom, low enough that the tone mapper keeps the hue.
        const rgb = fireRamp(temperature, this.sceneLight).mul(float(0.8).add(temperature.mul(0.9)));
        const alpha = core
          .mul(smoothstep(0.85, 0.5, t))
          .mul(smoothstep(0.0, 0.04, age))
          .mul(smoothstep(1.0, 0.8, length(p)))
          .mul(t.lessThan(1).select(float(1), float(0)));
        // Premultiplied: `cover` of the background is replaced by fire, the rest is added as light.
        return vec4(rgb.mul(alpha), alpha.mul(cover));
      })();
    });

    this.dots = new ParticlePool(DOTS, quad, blended(), (pool) => {
      const { size, origin, alive } = particleInputs(pool, this.now);
      pool.material.positionNode = billboard(origin, size.mul(alive), this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        const disc = smoothstep(1.0, 0.7, d);
        const shade: ShaderNode = color(0x8a8a8a);
        return vec4(shade.mul(this.sceneLight), disc);
      })();
    });

    this.beams = new BeamLayer(this.cameraRight, this.cameraUp, this.now);

    const noise = waterTextures().noise;
    // Enhanced glow halo: a soft Gaussian of fire light around the blast, white-yellow at the centre, orange outside,
    // bright enough for the bloom and gone within a third of a second.
    this.halo = new ParticlePool(HALOS, quad, additive(), (pool) => {
      const { age, life, size, origin, alive, extra: mode } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.6).add(smoothstep(0, 0.3, t).mul(0.4)));
      pool.material.positionNode = billboard(
        origin.add(this.toCamera.mul(grow.mul(0.6))),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        const hd = mode.equal(HALO_HD);
        const falloff = exp(d.mul(d).mul(hd.select(float(-ENHANCED.halo.falloff), float(-5.5)))).mul(
          smoothstep(1.0, 0.8, d),
        );
        const original = mix(vec3(1.0, 0.5, 0.16), vec3(1.0, 0.86, 0.55), exp(d.mul(d).mul(-18))).mul(mode);
        const temperature = mix(this.hdHaloCore, float(ENHANCED.halo.rim), clamp(d, 0, 1)).mul(
          float(1).sub(t.mul(ENHANCED.halo.cooling)),
        );
        const warm = hd.select(emberRamp(temperature).mul(this.hdHaloGain), original);
        const electric = vec3(...ENHANCED.bolts.impact.colour).mul(ENHANCED.bolts.impact.intensity);
        const tint = mode.equal(HALO_ELECTRIC).select(electric, warm);
        const fade = pow(float(1).sub(t), 2).mul(smoothstep(0.0, 0.03, age));
        return vec4(tint.mul(falloff).mul(fade), t.lessThan(1).select(float(1), float(0)));
      })();
    });

    // Enhanced rolling smoke: puffs that rise and spread with drag, turn slowly (rolling), and are shaded as lumpy
    // spheres: lit from the upper left like the original art, a sky-lit rim, the local light field (fires,
    // explosions), and the fire's glow underneath while they are young (params.w = heat). Premultiplied: the glow adds
    // light, the soot covers what is behind.
    this.billow = new ParticlePool(BILLOWS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive, extra: heat } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const flight = min(age, life);
      const drift = velocity.mul(float(1).sub(exp(flight.mul(-1.1)))).div(1.1);
      const grow = size
        .mul(
          float(0.4).add(
            float(1)
              .sub(exp(flight.mul(-1.3)))
              .mul(1.15),
          ),
        )
        .mul(alive);
      pool.material.positionNode = billboard(
        origin.add(drift).add(this.toCamera.mul(grow.mul(0.5))),
        grow,
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const angle = seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(1.2)));
        const c = cos(angle);
        const s = sin(angle);
        const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
        const lumps = texture(noise, q.mul(0.32).add(vec2(seed.mul(3.7), seed.mul(1.9).add(age.mul(0.025))))).g;
        const fine = texture(noise, q.mul(0.9).add(vec2(seed.mul(5.3), age.mul(-0.04)))).b;
        const bump = lumps.sub(0.5).mul(1.2).add(fine.sub(0.5).mul(0.4));
        const r = length(p).add(bump.mul(0.6));
        // A defined, lumpy silhouette over a dense core (a puff, not a haze).
        const density = smoothstep(1.0, 0.72, r).mul(float(0.55).add(smoothstep(0.9, 0.2, r).mul(0.45)));
        // Lumpy sphere normal in billboard space (x right, y up, z towards the camera).
        const z = sqrt(clamp(float(1).sub(dot(p, p)), 0.04, 1));
        const nrm = normalize(vec3(p.x.add(bump.mul(1.1)), p.y.add(bump.mul(1.1)), z));
        const sun = dot(nrm, vec3(-0.5, 0.68, 0.53)).max(0);
        const rim = pow(float(1).sub(nrm.z), 3).mul(0.35);
        const shade = float(0.28).add(sun.mul(1.05)).add(rim);
        const lit = this.nodes.sceneBrightness
          .mul(shade)
          .add(objectLight(positionWorld.xz, this.nodes).div(this.nodes.referenceLevel).mul(0.45));
        // Black-brown soot while young and dense, dispersing to grey.
        const base = mix(color(0x1d1a17), color(0x5f5a54), clamp(t.mul(0.9).add(seed.mul(0.25)), 0, 1));
        // The fire's glow: underneath the young puff, and inside it for the first moments (black-orange smoke).
        const under = smoothstep(0.15, -0.8, nrm.y)
          .mul(pow(float(1).sub(t), 4))
          .mul(1.8);
        const inner = exp(dot(p, p).mul(-3))
          .mul(pow(clamp(float(1).sub(t.mul(4)), 0, 1), 2))
          .mul(1.6);
        const glow = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.66, 0.3), inner.min(1))
          .mul(heat)
          .mul(under.add(inner));
        const alpha = density
          .mul(smoothstep(0.0, 0.08, t))
          .mul(smoothstep(1.0, 0.45, t))
          .mul(ENHANCED.smoke.opacity)
          .mul(t.lessThan(1).select(float(1), float(0)));
        return vec4(base.mul(lit).mul(alpha).add(glow.mul(alpha)), alpha);
      })();
    });

    // Enhanced debris: small dark chunks thrown out ballistically, tumbling, landing on the ground they started from;
    // some glow hot while they fly (params.w).
    this.debris = new ParticlePool(DEBRIS, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive, extra: hot } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      // Ballistic until the chunk is back at its start height, then it lies still (no sliding, no spin).
      const landed = velocity.y.div(4.9).add(0.02);
      const flight = min(min(age, life), landed);
      const flying = origin.add(velocity.mul(flight)).add(vec3(0, flight.mul(flight).mul(-4.9), 0));
      const at = vec3(flying.x, max(flying.y, origin.y.sub(0.02)), flying.z);
      const spin = seed.mul(20).add(flight.mul(seed.mul(10).add(7)));
      const c = cos(spin);
      const s = sin(spin);
      const corner = vec2(positionLocal.x, positionLocal.y.mul(0.65));
      const turned = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(
        size.mul(alive),
      );
      pool.material.positionNode = at
        .add(this.toCamera.mul(0.08))
        .add(this.cameraRight.mul(turned.x))
        .add(this.cameraUp.mul(turned.y));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const chunk = smoothstep(1.0, 0.65, max(abs(p.x), abs(p.y)));
        const shade: ShaderNode = (color(0x3b342d) as ShaderNode)
          .mul(this.sceneLight)
          .mul(float(0.8).add(p.y.mul(0.25)));
        // Hot chunks glow for their first second, however long they then lie on the ground.
        const heat = clamp(float(1).sub(age.div(ENHANCED.debris.glowLife)), 0, 1);
        const temperature = mix(float(1), float(ENHANCED.debris.rim), clamp(length(p), 0, 1)).mul(heat);
        const ember = emberRamp(temperature)
          .mul(hot)
          .mul(smoothstep(ENHANCED.debris.glowLife, 0, age));
        return vec4(
          shade.add(ember),
          chunk.mul(smoothstep(life, life.sub(0.8), age)).mul(t.lessThan(1).select(float(1), float(0))),
        );
      })();
    });

    // Enhanced heat shimmer: the frame drawn so far, refracted by rising noise over the blast for about a second.
    this.shimmer = new ParticlePool(SHIMMERS, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.7).add(t.mul(0.5)));
      pool.material.positionNode = billboard(
        origin.add(vec3(0, t.mul(0.5).add(0.25), 0)).add(this.toCamera.mul(grow)),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const mask = smoothstep(1.0, 0.25, length(p))
          .mul(smoothstep(0.0, 0.08, t))
          .mul(pow(float(1).sub(t), 1.5));
        const flow = uv()
          .mul(1.3)
          .add(vec2(seed.mul(7.1), this.now.mul(-0.45)));
        const bend = vec2(texture(noise, flow).b.sub(0.5), texture(noise, flow.add(vec2(0.37, 0.61))).b.sub(0.5));
        const refracted = viewportSharedTexture(screenUV.add(bend.mul(mask).mul(0.009)));
        return vec4(refracted.rgb, mask.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    // Enhanced dust ring: a brownish ring of dust racing out over the ground and settling.
    this.dust = new ParticlePool(DUST_RINGS, ground, blended(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const radius = size
        .mul(
          float(0.2).add(
            float(1)
              .sub(pow(float(1).sub(t), 2.5))
              .mul(0.8),
          ),
        )
        .mul(alive);
      pool.material.positionNode = origin.add(vec3(0, 0.02, 0)).add(positionLocal.mul(radius));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const d = length(p);
        const lumps = texture(noise, p.mul(0.45).add(vec2(seed.mul(9.1), seed.mul(3.3)))).g;
        const ring = smoothstep(0.55, 0.88, d.add(lumps.sub(0.5).mul(0.35))).mul(smoothstep(1.0, 0.88, d));
        const haze = smoothstep(0.95, 0.3, d).mul(0.18);
        const dustColour: ShaderNode = (color(0xa08e74) as ShaderNode).mul(this.sceneLight);
        const alpha = ring
          .add(haze)
          .mul(pow(float(1).sub(t), 1.4))
          .mul(0.7)
          .mul(t.lessThan(1).select(float(1), float(0)));
        return vec4(dustColour, alpha);
      })();
    });
    this.dust.mesh.renderOrder = 5;

    // Enhanced fireball over the native art (premultiplied: fire adds light and hides `cover` of what is behind, so
    // the pixel art under it reads as a detailed, boiling ball). Three octaves of evolving noise shape a lumpy ball
    // whose hot core cools outwards and with age through the original palette's fire colours into lit soot.
    this.blast = new ParticlePool(BLASTS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, alive, extra: cover } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(
        float(0.5)
          .add(smoothstep(0, 0.18, t).mul(0.38))
          .add(t.mul(0.22)),
      );
      const rise: ShaderNode = t.mul(size).mul(0.22);
      pool.material.positionNode = billboard(
        origin.add(vec3(0, rise, 0)).add(this.toCamera.mul(grow.mul(0.6))),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const q = vec3(p.mul(1.7), seed.mul(17).add(t.mul(1.6)));
        const n1 = mx_noise_float(q);
        const n2 = mx_noise_float(q.mul(2.1).add(vec3(3.1, 1.7, 0.4)));
        const n3 = mx_noise_float(q.mul(4.4).add(vec3(7.7, 2.3, 5.1)));
        const turbulence = n1.mul(0.5).add(n2.mul(0.25)).add(n3.mul(0.13));
        const r = length(p).add(turbulence.mul(0.5));
        const density = smoothstep(1.0, 0.62, r);
        const temperature = clamp(
          smoothstep(0.95, 0.05, r)
            .mul(float(1.3).sub(t.mul(1.45)))
            .add(n2.mul(0.22)),
          0,
          1,
        );
        const z = sqrt(clamp(float(1).sub(dot(p, p)), 0.04, 1));
        const nrm = normalize(vec3(p.x.add(n1.mul(0.9)), p.y.add(n1.mul(0.9)), z));
        const sun = dot(nrm, vec3(-0.5, 0.68, 0.53)).max(0);
        const soot: ShaderNode = mix(color(0x241c16), color(0x6a5b4e), sun)
          .mul(this.sceneLight.mul(0.7).add(0.3))
          .add(color(0xff7a2a).mul(smoothstep(0.02, 0.2, temperature).mul(0.5)));
        const fire = fireRamp(temperature, this.sceneLight).mul(float(0.9).add(temperature.mul(1.2)));
        const rgb = mix(soot, fire, smoothstep(0.12, 0.4, temperature));
        const alpha = density
          .mul(smoothstep(0.0, 0.03, age))
          .mul(smoothstep(1.0, 0.55, t))
          .mul(smoothstep(1.0, 0.86, length(p)))
          .mul(t.lessThan(1).select(float(1), float(0)));
        return vec4(rgb.mul(alpha), alpha.mul(cover));
      })();
    });

    // Enhanced smoke column: puffs that keep rising (no drag) and spreading for about ten seconds, lumpy and lit like
    // the rolling smoke, glowing from the fire below while young (params.w = heat), dispersing to a thin grey.
    this.column = new ParticlePool(COLUMN_PUFFS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive, extra: heat } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const flight = min(age, life);
      const grow = size
        .mul(
          float(0.55).add(
            float(1)
              .sub(exp(flight.mul(-0.35)))
              .mul(1.9),
          ),
        )
        .mul(alive);
      pool.material.positionNode = billboard(
        origin.add(velocity.mul(flight)).add(this.toCamera.mul(grow.mul(0.5))),
        grow,
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const angle = seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(0.4)));
        const c = cos(angle);
        const sn = sin(angle);
        const q = vec2(p.x.mul(c).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(c)));
        const lumps = texture(noise, q.mul(0.3).add(vec2(seed.mul(3.7), seed.mul(1.9).add(age.mul(0.012))))).g;
        const fine = texture(noise, q.mul(0.85).add(vec2(seed.mul(5.3), age.mul(-0.02)))).b;
        const bump = lumps.sub(0.5).mul(1.2).add(fine.sub(0.5).mul(0.4));
        const r = length(p).add(bump.mul(0.6));
        const density = smoothstep(1.0, 0.65, r).mul(float(0.5).add(smoothstep(0.9, 0.2, r).mul(0.5)));
        const z = sqrt(clamp(float(1).sub(dot(p, p)), 0.04, 1));
        const nrm = normalize(vec3(p.x.add(bump.mul(1.1)), p.y.add(bump.mul(1.1)), z));
        const sun = dot(nrm, vec3(-0.5, 0.68, 0.53)).max(0);
        const rim = pow(float(1).sub(nrm.z), 3).mul(0.3);
        const lit = this.nodes.sceneBrightness
          .mul(float(0.32).add(sun.mul(0.95)).add(rim))
          .add(objectLight(positionWorld.xz, this.nodes).div(this.nodes.referenceLevel).mul(0.4));
        const base = mix(color(0x2a2622), color(0x77726b), clamp(t.mul(1.1).add(seed.mul(0.2)), 0, 1));
        const glow = vec3(1.0, 0.42, 0.12)
          .mul(heat)
          .mul(smoothstep(0.1, -0.8, nrm.y))
          .mul(pow(clamp(float(1).sub(t.mul(5)), 0, 1), 2))
          .mul(1.4);
        const alpha = density
          .mul(smoothstep(0.0, 0.06, t))
          .mul(smoothstep(1.0, 0.4, t))
          .mul(0.62)
          .mul(t.lessThan(1).select(float(1), float(0)));
        return vec4(base.mul(lit).mul(alpha).add(glow.mul(alpha)), alpha);
      })();
    });

    // Fire and sparks always draw over smoke (the smoke of a fire rises above and behind its flames).
    this.smoke.mesh.renderOrder = 6;
    this.billow.mesh.renderOrder = 6;
    this.column.mesh.renderOrder = 6;
    // Over the native anim art (the 'air' pass draws at 7).
    this.blast.mesh.renderOrder = 7.5;
    for (const pool of [
      this.flames,
      this.fireballs,
      this.sparks,
      this.airborneEmbers,
      this.muzzleStar,
      this.garnishFire,
      this.debris,
      this.halo,
    ])
      pool.mesh.renderOrder = 7;
    // The heat shimmer refracts everything drawn before it, fire included.
    this.shimmer.mesh.renderOrder = 8;
    this.pools = [
      this.scorch,
      this.shock,
      this.dust,
      this.embers,
      this.smoke,
      this.column,
      this.billow,
      this.dots,
      this.flames,
      this.fireballs,
      this.garnishFire,
      this.blast,
      this.debris,
      this.halo,
      this.sparks,
      this.airborneEmbers,
      this.muzzleStar,
      this.shimmer,
    ];
    for (const pool of this.pools) {
      pool.mesh.visible = false;
      this.root.add(pool.mesh);
    }
    this.root.add(this.beams.mesh);
  }

  /** Route effect lights into a light field (they replace the point lights earlier versions used). */
  attachLightField(lightField: LightField | null): void {
    this.lightField = lightField;
  }

  /**
   * An explosion. Without options: the renderer's full procedural blast (flash, rolling fireballs, shockwave, smoke,
   * sparks, scorch, a big light and camera shake), for events that have no original art. With options: the live
   * view's garnish on top of the original art (garnishExplosion).
   */
  explode(now: number, at: Vector3, scale: number, wind: Vector3, options?: GarnishOptions): void {
    if (options) {
      this.garnishExplosion(now, at, scale, wind, options);
      return;
    }
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    // Initial white-hot flash, then a cluster of rolling fireballs.
    this.fireballs.spawn(now, at.clone().add(new Vector3(0, 0.4, 0)), new Vector3(), 2.2 * scale, 0.12);
    for (let i = 0; i < 5 + Math.round(scale * 3); i++) {
      this.fireballs.spawn(
        now + i * 0.045,
        at.clone().add(new Vector3(r(0.8), 0.15 + Math.random() * 0.5, r(0.8)).multiplyScalar(scale)),
        new Vector3(),
        1.5 * scale * (0.7 + Math.random() * 0.6),
        0.6 + Math.random() * 0.35,
      );
    }
    this.shock.spawn(now, at, new Vector3(), 3.4 * scale, 0.5);
    for (let i = 0; i < 16 + Math.round(scale * 12); i++) {
      const velocity = new Vector3(r(1.6), 1.0 + Math.random() * 1.1, r(1.6)).multiplyScalar(scale).add(wind);
      this.smoke.spawn(
        now + 0.08 + Math.random() * 0.3,
        at.clone().add(new Vector3(r(0.6), 0.25, r(0.6))),
        velocity,
        1.2 * scale,
        3.5 + Math.random() * 2.5,
      );
    }
    for (let i = 0; i < 30 + Math.round(scale * 24); i++) {
      const velocity = new Vector3(r(9), 4 + Math.random() * 6, r(9)).multiplyScalar(0.6 + scale * 0.4);
      this.sparks.spawn(now, at.clone().add(new Vector3(0, 0.2, 0)), velocity, 0.06, 0.5 + Math.random() * 0.6);
    }
    this.scorch.spawn(now, at, new Vector3(), 1.4 * scale, 40);
    const light = EFFECT_LIGHTS.explosion;
    this.lightField?.pulse(
      now,
      at,
      light.colour,
      light.radius * scale,
      light.peak * scale,
      light.life,
      light.decay,
      'explosion',
    );
    this.shake = Math.max(this.shake, 0.35 * scale);
  }

  /**
   * Explosion garnish on top of the original art: a brief hot core at the art's centre (at most 60 % of its width, no
   * second cloud: the native art is the fireball), sparks, a small warm light and optionally some smoke, all inside the
   * native anim's footprint and lifetime (GarnishOptions).
   */
  private garnishExplosion(now: number, at: Vector3, scale: number, wind: Vector3, options: GarnishOptions): void {
    if (options.enhanced) {
      this.enhancedExplosion(now, at, scale, wind, options);
      return;
    }
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    const s = scale * FX_GARNISH;
    const cap = (size: number) => Math.min(size, 0.6 * (options.maxSize ?? Infinity));
    const life = (seconds: number) => Math.min(seconds, options.maxLife ?? Infinity);
    this.garnishFire.spawn(now, at, new Vector3(), cap(0.9 * s), life(0.1), 0.5);
    for (let i = 0; i < Math.round(options.smoke ?? 0); i++) {
      const velocity = new Vector3(r(1.2), 0.8 + Math.random() * 0.8, r(1.2)).multiplyScalar(s).add(wind);
      this.smoke.spawn(
        now + 0.08 + Math.random() * 0.3,
        at.clone().add(new Vector3(r(0.5), 0.2, r(0.5)).multiplyScalar(s)),
        velocity,
        cap(0.9 * s),
        life(2.5 + Math.random() * 1.5),
        2,
      );
    }
    for (let i = 0; i < 12 + Math.round(s * 12); i++) {
      const velocity = new Vector3(r(9), 4 + Math.random() * 6, r(9)).multiplyScalar(0.3 + s * 0.3);
      this.sparks.spawn(now, at, velocity, 0.05, life(0.4 + Math.random() * 0.4), 1);
    }
    if (options.scorch) this.scorch.spawn(now, at, new Vector3(), 1.4 * s, 40);
    const light = GARNISH_LIGHTS.explosion;
    const colour = options.light === undefined ? [...light.colour, light.radius * s] : options.light;
    if (colour)
      this.lightField?.pulse(
        now,
        at,
        [colour[0]!, colour[1]!, colour[2]!],
        Math.max(0.5, colour[3]!),
        light.peak * s,
        light.life,
        light.decay,
        'explosion',
      );
  }

  /**
   * The enhanced style's explosion around the native art (ENHANCED): a flash of light, a glow halo over a hot core,
   * sparks and debris, rolling lit smoke, heat shimmer, a dust ring and, for crater-leaving anims, a cooling hot crater.
   * `options.maxSize` is the native art's width (world units); the core stays inside it, the halo, smoke and dust
   * spread around it.
   */
  private enhancedExplosion(now: number, at: Vector3, scale: number, wind: Vector3, options: GarnishOptions): void {
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    // Building collapses reach a scale of 3.5: their light and particle counts stop growing past these.
    const s = Math.min(2, scale * FX_GARNISH);
    const lightScale = Math.min(1.6, s);
    // Width of the native art (world units); tables without art fall back to the scale.
    const width = Math.max(0.3, Math.min(options.maxSize ?? 1.2 * s, 4 * Math.max(0.3, s)));
    const e = ENHANCED;
    // Hot core inside the art, the detailed fireball over it for the art's own duration, then the halo around it.
    this.garnishFire.spawn(now, at, this.zeroVelocity, (options.hdArt ? 0.35 : 0.7) * width, 0.14, 0.6);
    const artLife = Math.max(0.35, Math.min(options.maxLife ?? 1.2, 3));
    if (!options.hdArt)
      this.blast.spawn(
        now,
        at.clone().add(new Vector3(0, 0.08 * width, 0)),
        this.zeroVelocity,
        e.fireball.width * width,
        e.fireball.life * artLife,
        e.fireball.cover,
      );
    this.halo.spawn(
      now,
      at,
      this.zeroVelocity,
      (options.hdArt ? e.halo.hdWidth : e.halo.width) * width,
      e.halo.life,
      options.hdArt ? HALO_HD : e.halo.intensity,
    );
    const light = e.light;
    const radius = light.radius + light.radiusPerScale * lightScale;
    const peak = light.peak + light.peakPerScale * lightScale;
    const flash = emberRampRgb(e.flash.temperature);
    const brightest = Math.max(...flash);
    // Enhanced lighting owns this hot-to-orange progression, including rows with a native pale-yellow light colour.
    this.lightField?.pulse(
      now,
      at,
      [flash[0] / brightest, flash[1] / brightest, flash[2] / brightest],
      radius * e.flash.radius,
      peak * e.flash.peak,
      e.flash.life,
      e.flash.decay,
      'explosion',
    );
    this.lightField?.pulse(now, at, light.colour, radius, peak, light.life, light.decay, 'explosion');
    const lifted = at.clone().add(new Vector3(0, 0.12, 0));
    for (let i = 0, n = Math.round(e.sparks.count + e.sparks.perScale * s); i < n; i++) {
      // Most sparks stay near the blast; one in four is a long tracer.
      const far = Math.random() < 0.25;
      const velocity = new Vector3(r(10), 3 + Math.random() * 6, r(10)).multiplyScalar(
        (0.35 + 0.35 * s) * (far ? 1.6 : 1),
      );
      this.sparks.spawn(now, lifted, velocity, far ? 0.055 : 0.045, (far ? 0.8 : 0.4) + Math.random() * 0.6, SPARK_HOT);
    }
    for (let i = 0, n = Math.round(e.embers.count + e.embers.perScale * s); i < n; i++)
      this.spawnEmber(now + Math.random() * e.embers.delay, at, width, wind);
    for (let i = 0, n = Math.round(e.debris.count + e.debris.perScale * s); i < n; i++) {
      const velocity = new Vector3(r(5), 2.5 + Math.random() * 3.5, r(5)).multiplyScalar(0.5 + 0.35 * s);
      // Flight time (back to the start height), then a few seconds on the ground.
      const flight = velocity.y / 4.9;
      this.debris.spawn(
        now,
        lifted,
        velocity,
        0.03 + Math.random() * 0.055 * Math.min(2, 0.6 + s),
        flight + e.debris.rest * (0.5 + Math.random()),
        Math.random() < 0.35 ? 1 : 0,
      );
    }
    // A smoke column after bigger blasts: puffs emitted over a few seconds from the blast, rising with the wind.
    if (s >= e.column.from) {
      const n = Math.round(e.column.count + e.column.perScale * Math.min(1.5, s));
      for (let i = 0; i < n; i++) {
        const delay = 0.25 + (i / n) * e.column.span * (0.7 + 0.3 * Math.random());
        const velocity = new Vector3(r(0.12), e.column.rise * (0.8 + Math.random() * 0.4), r(0.12))
          .multiplyScalar(0.8 + 0.3 * s)
          .add(wind.clone().multiplyScalar(0.6));
        this.column.spawn(
          now + delay,
          at.clone().add(new Vector3(r(0.4 * width), 0.2 * width, r(0.4 * width))),
          velocity,
          e.column.size * width * (0.8 + Math.random() * 0.4),
          e.column.life * (0.8 + Math.random() * 0.4),
          Math.max(0, 1 - delay / 2.5),
        );
      }
    }
    for (let i = 0, n = Math.round(e.smoke.count + e.smoke.perScale * s); i < n; i++) {
      const velocity = new Vector3(r(0.5), 0.45 + Math.random() * 0.45, r(0.5)).multiplyScalar(0.6 + 0.4 * s).add(wind);
      this.billow.spawn(
        now + e.smoke.delay + Math.random() * 0.3,
        at.clone().add(new Vector3(r(0.5 * width), 0.1 + Math.random() * 0.25 * width, r(0.5 * width))),
        velocity,
        e.smoke.size * (0.8 + Math.random() * 0.5) * width,
        e.smoke.life * (0.8 + Math.random() * 0.4),
        1,
      );
    }
    this.shimmer.spawn(now + 0.05, at, this.zeroVelocity, e.shimmer.width * width, e.shimmer.life);
    this.dust.spawn(now, at, this.zeroVelocity, e.dust.width * width, e.dust.life);
    if (options.hotCrater) {
      this.embers.spawn(now + 0.05, at, this.zeroVelocity, e.crater.width * width, e.crater.life, 1);
      // Charred ground around the engine's crater smudge (which stays underneath), fading over most of a minute.
      this.scorch.spawn(now + 0.1, at, this.zeroVelocity, e.char.width * width, e.char.life, 1);
    }
  }

  /**
   * Weapon muzzle flash: a brief flash, a few sparks and a small light. With options (live view) a smaller garnish
   * flash capped at the native art's width, with a dimmer light.
   */
  muzzleFlash(now: number, at: Vector3, scale: number, options?: GarnishOptions): void {
    if (options?.enhanced) {
      // Enhanced: a bloomed halo around the native flash and a light that reaches the ground and nearby units.
      const e = ENHANCED.muzzle;
      const width = Math.max(e.minWidth, Math.min(options.maxSize ?? e.fallbackWidth * scale, e.maxWidth));
      this.muzzleStar.spawn(now, at, this.zeroVelocity, e.width * width, randomBetween(e.life));
      this.halo.spawn(now, at, this.zeroVelocity, e.haloWidth * width, e.haloLife, e.haloIntensity);
      for (let i = 0; i < 6; i++) {
        const velocity = new Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(3.5);
        this.sparks.spawn(now, at, velocity, 0.04, 0.2 + Math.random() * 0.25, SPARK_HOT);
      }
      const light = e.light;
      this.lightField?.pulse(now, at, light.colour, light.radius, light.peak, light.life, light.decay, 'flash');
      return;
    }
    if (options) {
      const s = scale * FX_GARNISH;
      this.garnishFire.spawn(now, at, new Vector3(), Math.min(0.9 * s, options.maxSize ?? Infinity), 0.08, 0.5);
      for (let i = 0; i < 4; i++) {
        const velocity = new Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(3);
        this.sparks.spawn(now, at, velocity, 0.04, 0.2 + Math.random() * 0.2, 1);
      }
      const light = GARNISH_LIGHTS.muzzle;
      const colour = options.light === undefined ? [...light.colour, light.radius] : options.light;
      if (colour)
        this.lightField?.pulse(
          now,
          at,
          [colour[0]!, colour[1]!, colour[2]!],
          Math.min(light.radius, Math.max(0.5, colour[3]!)),
          light.peak,
          light.life,
          light.decay,
          'flash',
        );
      return;
    }
    this.fireballs.spawn(now, at, new Vector3(), 0.9 * scale, 0.08);
    for (let i = 0; i < 4; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(3);
      this.sparks.spawn(now, at, velocity, 0.04, 0.2 + Math.random() * 0.2);
    }
    const light = EFFECT_LIGHTS.muzzle;
    this.lightField?.pulse(now, at, light.colour, light.radius, light.peak * scale, light.life, light.decay, 'flash');
  }

  /** A bullet hit (live garnish): a tiny warm flash and a few sparks, no dust and no light. */
  sparkFlash(now: number, at: Vector3, scale: number, options: GarnishOptions = {}): void {
    const s = scale * FX_GARNISH;
    this.garnishFire.spawn(now, at, new Vector3(), Math.min(0.45 * s, options.maxSize ?? Infinity), 0.07, 0.5);
    for (let i = 0; i < 3; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).multiplyScalar(2);
      this.sparks.spawn(now, at, velocity, 0.03, 0.2 + Math.random() * 0.2, 1);
    }
  }

  /** Small impact (bullets hitting ground or armour): a dust puff and a few sparks. */
  impact(now: number, at: Vector3, scale: number, wind: Vector3, options: GarnishOptions = {}): void {
    const s = scale * FX_GARNISH;
    this.smoke.spawn(
      now,
      at,
      new Vector3(0, 0.4, 0).add(wind),
      Math.min(0.45 * s, options.maxSize ?? Infinity),
      Math.min(1.2 + Math.random() * 0.6, options.maxLife ?? Infinity),
    );
    for (let i = 0; i < 6; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).multiplyScalar(2.5);
      this.sparks.spawn(now, at, velocity, 0.035, 0.25 + Math.random() * 0.25);
    }
  }

  /**
   * One smoke puff (a trail puff, or one of a continuous column's); `soot` for a fire's dark smoke. With size or life
   * limits (the live view's garnish over original art) the puff is drawn lighter.
   */
  smokePuff(
    now: number,
    at: Vector3,
    scale: number,
    wind: Vector3,
    options: GarnishOptions & { soot?: boolean } = {},
  ): void {
    const s = scale * FX_GARNISH;
    const jitter = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.25 * s);
    const velocity = new Vector3(0, 0.9 + Math.random() * 0.5, 0).add(wind);
    this.smoke.spawn(
      now,
      at.clone().add(jitter),
      velocity,
      Math.min(0.9 * s, options.maxSize ?? Infinity),
      Math.min(3 + Math.random() * 2, options.maxLife ?? Infinity),
      options.soot ? 1 : options.maxSize !== undefined || options.maxLife !== undefined ? 2 : 0,
    );
  }

  /**
   * One tongue of a continuous fire (burning buildings, napalm). With a `key` (the tracked anim's identity) the fire
   * also keeps a flickering light alive in the light field for as long as tongues keep coming. `maxSize` (live view)
   * caps the tongue at the native art's width.
   */
  flame(now: number, at: Vector3, scale: number, key?: string, options: GarnishOptions = {}): void {
    const jitter = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.55 * scale);
    const rise = new Vector3((Math.random() - 0.5) * 0.15, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.15);
    this.flames.spawn(
      now,
      at.clone().add(jitter),
      rise.multiplyScalar(scale),
      Math.min(0.5 * scale * (0.7 + Math.random() * 0.6), options.maxSize ?? Infinity),
      Math.min(0.45 + Math.random() * 0.3, options.maxLife ?? Infinity),
    );
    if (key === undefined) return;
    // The renderer's own fires light a wide circle; the live view's (options given) only a garnish-sized one.
    const light = options.maxSize === undefined ? EFFECT_LIGHTS.fire : GARNISH_LIGHTS.fire;
    this.lightField?.keep(
      key,
      now,
      at,
      light.colour,
      light.radius * scale,
      light.peak * scale,
      light.flicker,
      light.ttl,
    );
  }

  /**
   * Keep a garnish-sized flickering fire light alive under `key` (the live view's looping fire anims, whose original
   * flames are drawn as they are). Call it a few times a second; the light fades out when the calls stop.
   */
  fireLight(key: string, now: number, at: Vector3, scale: number): void {
    const light = GARNISH_LIGHTS.fire;
    this.lightField?.keep(
      key,
      now,
      at,
      light.colour,
      light.radius * scale,
      light.peak * scale,
      light.flicker,
      light.ttl,
    );
  }

  /**
   * A few airborne embers from a looping enhanced fire, next to its kept light. The caller retains `at` for the anim's
   * lifetime; each position has its own emission schedule, so presentation rate and the number of other fires do not
   * multiply emissions. Wind is sampled at birth. After a long gap only the current beat is emitted, without a backlog.
   */
  fireEmbers(now: number, at: Vector3, scale: number, wind = this.zeroVelocity): void {
    if (scale <= 0) return;
    const e = ENHANCED.embers;
    let next = this.emberEmit.get(at) ?? now;
    if (now - next > e.catchup) next = now;
    let emitted = 0;
    while (next <= now && emitted < e.pool) {
      this.spawnEmber(now, at, e.fireWidth * scale, wind);
      next += 1 / (randomBetween(e.fireRate) * scale);
      emitted++;
    }
    this.emberEmit.set(at, next);
  }

  /** Shared enhanced ember launch volume; vertical convection stays independent of horizontal wind strength. */
  private spawnEmber(now: number, at: Vector3, width: number, wind: Vector3): void {
    const e = ENHANCED.embers;
    const offset = new Vector3(
      (Math.random() - 0.5) * e.volume * width,
      Math.random() * e.height * width,
      (Math.random() - 0.5) * e.volume * width,
    );
    const velocity = new Vector3(
      wind.x * e.wind + (Math.random() - 0.5) * e.drift,
      randomBetween(e.rise),
      wind.z * e.wind + (Math.random() - 0.5) * e.drift,
    );
    this.airborneEmbers.spawn(
      now,
      at.clone().add(offset),
      velocity,
      randomBetween(e.size),
      randomBetween(e.life),
      randomBetween(e.temperature),
    );
  }

  /**
   * A persistent fire (a burning wreck), called every frame: flame tongues at a steady rate, a continuous column of
   * dark smoke and a kept-alive light. Stops (and its light fades) when the calls stop.
   */
  fire(now: number, at: Vector3, scale: number, key: string, wind = new Vector3()): void {
    const next = this.fireEmit.get(key) ?? 0;
    if (now < next) return;
    this.fireEmit.set(key, now + FIRE_INTERVAL);
    if (this.fireEmit.size > 512) this.fireEmit.clear();
    // A burning wreck: a glowing ember bed, two tongues per beat (one larger) rooted in it and a steady soot column
    // rising well above them.
    this.embers.spawn(now, at, new Vector3(), 1.1 * scale * (0.85 + Math.random() * 0.3), 0.35);
    this.flame(now, at, scale, key);
    this.flame(now, at, scale * 1.3);
    if (Math.random() < FIRE_SMOKE)
      this.smokePuff(now, at.clone().setY(at.y + 1.1 * scale), scale, wind, { soot: true });
  }

  /**
   * The energy beams the engine draws this logic frame (lasers, electric and psychic bolts), replacing the previous
   * set; an empty list clears them. They stay until the next call, so the caller sets them once per logic frame and
   * their geometry persists while the game is paused, like the engine's own redrawn beams. Each beam also flashes a
   * short light at its target. Enhanced bolts flicker with the presentation clock and add a blue-white impact pulse.
   */
  setBeams(now: number, beams: readonly BeamSpec[]): void {
    this.beams.setBeams(beams, this.enhancedBeams);
    const light = GARNISH_LIGHTS.beam;
    // Only the last 256 pulses survive the light field's flash ring. Avoid processing discarded pulses.
    for (let i = Math.max(0, beams.length - BEAM_LIGHTS); i < beams.length; i++) {
      const beam = beams[i]!;
      const { x, y, z } = beam.colour;
      const max = Math.max(x, y, z, 1e-3);
      this.lightField?.pulse(
        now,
        beam.to,
        [x / max, y / max, z / max],
        light.radius,
        light.peak * (beam.bolt ? 1.25 : 1),
        light.life,
        light.decay,
        'flash',
      );
    }
    if (this.enhancedBeams) {
      const impact = ENHANCED.bolts.impact;
      // Only the newest HALOS bolt impacts can survive the halo ring. Lasers must not displace that visible subset.
      let emitted = 0;
      for (let i = beams.length - 1; i >= 0 && emitted < HALOS; i--) {
        const beam = beams[i]!;
        if (!beam.bolt) continue;
        emitted++;
        this.halo.spawn(now, beam.to, this.zeroVelocity, impact.width, impact.life, HALO_ELECTRIC);
        for (let j = 0; j < impact.sparks; j++) {
          const velocity = new Vector3(Math.random() - 0.5, Math.random() + 0.5, Math.random() - 0.5).multiplyScalar(
            impact.sparkSpeed,
          );
          this.sparks.spawn(now, beam.to, velocity, impact.sparkSize, randomBetween(impact.sparkLife), SPARK_ELECTRIC);
        }
      }
    }
  }

  /** Beam segments drawn at the moment (diagnostics and tests). */
  get beamSegmentCount(): number {
    return this.beams.count;
  }

  /** A projectile whose art is unknown: a small grey dot for one presented frame. */
  bulletDot(now: number, at: Vector3): void {
    this.dots.spawn(now, at, this.zeroVelocity, 3 / (60 / Math.SQRT2), 0.034);
  }

  /** Shake the camera (super weapons only). */
  shakeCamera(seconds: number): void {
    this.shake = Math.max(this.shake, seconds);
  }

  update(now: number, cameraRight: Vector3, cameraUp: Vector3, toCamera?: Vector3): void {
    this.now.value = now;
    for (const pool of this.pools) {
      pool.flush();
      // Pools whose last particle has died draw nothing at all (no draw call, no vertex work).
      pool.mesh.visible = now < pool.until;
    }
    this.cameraRight.value.copy(cameraRight);
    this.cameraUp.value.copy(cameraUp);
    if (toCamera) this.toCamera.value.copy(toCamera);
  }

  /** Active effect lights per pool and the strongest explosion light (console checks and tests). */
  lightStats(now: number): { explosion: number; flash: number; kept: number; explosionPeak: number } {
    const lf = this.lightField;
    if (!lf) return { explosion: 0, flash: 0, kept: 0, explosionPeak: 0 };
    const s = lf.stats(now);
    return { explosion: s.explosion, flash: s.flash, kept: s.kept, explosionPeak: lf.peakIntensity('explosion', now) };
  }
}

/** One energy beam of a logic frame: endpoints and colour in world space / linear RGB. */
export interface BeamSpec {
  from: Vector3;
  to: Vector3;
  colour: Vector3;
  /** Three jagged strands (electric and psychic bolts) instead of one straight line (lasers). */
  bolt: boolean;
  /** Shape seed: the same seed gives the same jagged shape. */
  seed: number;
}

/** Bolt segment length and sideways/vertical jitter (world units = cells). */
const BOLT_STEP = 0.25;
const BOLT_JITTER = 0.24;

/**
 * Straight pieces of a beam: one for a laser; for a bolt three strands of BOLT_STEP-long pieces whose inner joints are
 * moved up to +-BOLT_JITTER / 2 sideways and vertically, the same for the same seed. Enhanced bolts interleave short
 * side branches, bounded by BEAM_SEGMENTS. A second copy of the same seeded generator preserves the original trunk.
 */
export function beamSegments(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  bolt: boolean,
  seed: number,
  enhanced = false,
): [Vector3, Vector3][] {
  const from = new Vector3(start.x, start.y, start.z);
  const to = new Vector3(end.x, end.y, end.z);
  if (!bolt) return [[from, to]];
  const distance = from.distanceTo(to);
  const side = new Vector3(to.z - from.z, 0, from.x - to.x);
  if (side.lengthSq() > 0) side.normalize();
  const random = mulberry(seed);
  const branchRandom = mulberry(seed);
  const branch = new Vector3();
  const out: [Vector3, Vector3][] = [];
  const pieces = Math.max(1, Math.round(distance / BOLT_STEP));
  const capacity = enhanced ? BEAM_SEGMENTS : Infinity;
  for (let strand = 0; strand < 3 && out.length < capacity; strand++) {
    let previous = from.clone();
    for (let i = 1; i <= pieces && out.length < capacity; i++) {
      const point = new Vector3().lerpVectors(from, to, i / pieces);
      if (i < pieces)
        point
          .addScaledVector(side, (random() - 0.5) * BOLT_JITTER)
          .add(new Vector3(0, (random() - 0.5) * BOLT_JITTER, 0));
      out.push([previous, point]);
      if (enhanced && i % ENHANCED.bolts.branchEvery === 0 && out.length < capacity)
        out.push([point, point.clone().add(boltBranchOffset(branchRandom, branch))]);
      previous = point;
    }
  }
  return out;
}

/** Uniform branch direction and bounded reach; both builders consume the same three random values per branch. */
function boltBranchOffset(random: () => number, target: Vector3): Vector3 {
  const angle = random() * Math.PI * 2;
  const y = random() * 2 - 1;
  const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
  const [short, long] = ENHANCED.bolts.branchLength;
  const reach = BOLT_STEP * (short + (long - short) * random());
  return target.set(Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal).multiplyScalar(reach);
}

export const BEAM_SEGMENTS = 4096;
/** Only this many beam pulses survive the light field's flash ring, regardless of the source beam count. */
export const BEAM_LIGHTS = 256;
/** Glow width of a beam segment (world units, about 2.5 engine pixels) and its white-hot core, as a fraction. */
const BEAM_WIDTH = 0.06;
const BEAM_CORE = 0.42;

/**
 * Beam segments as camera-facing quads stretched between their endpoints with round, soft ends: a thin core in the
 * segment's colour inside a soft glow of it, added to the scene (the original draws its bolts as saturated one-pixel
 * lines, e.g. (82, 80, 255) and white for the Tesla bolt). Replaced wholesale per logic frame (`set`), so a long bolt
 * costs a few hundred instances and one upload of the written range, not thousands of glow points per presented frame.
 */
export class BeamLayer {
  readonly mesh: InstancedMesh;
  private readonly buffer = new BeamSegmentBuffer();

  constructor(cameraRight: ShaderNode, cameraUp: ShaderNode, now: ShaderNode = uniform(0)) {
    const material = additive();
    // The quad's winding depends on the segment's direction on screen (the side vector is a cross product), so half of
    // all segments would face away from the camera: draw both sides.
    material.side = DoubleSide;
    const a: ShaderNode = instancedBufferAttribute(this.buffer.from, 'vec3');
    const b: ShaderNode = instancedBufferAttribute(this.buffer.to, 'vec3');
    const tint: ShaderNode = instancedBufferAttribute(this.buffer.colour, 'vec3');
    const enhanced: ShaderNode = instancedBufferAttribute(this.buffer.enhanced, 'float');
    const width = float(BEAM_WIDTH);
    const span: ShaderNode = length(b.sub(a)).max(1e-5);
    material.positionNode = Fn(() => {
      const axis: ShaderNode = b.sub(a).div(span);
      // Across the segment and across the view: perpendicular to both the axis and the direction to the camera.
      const across: ShaderNode = cross(axis, cross(cameraRight, cameraUp));
      const side: ShaderNode = length(across).greaterThan(1e-4).select(normalize(across), cameraRight);
      const along: ShaderNode = positionGeometry.x.add(0.5).mul(span.add(width)).sub(width.mul(0.5));
      return a.add(axis.mul(along)).add(side.mul(positionGeometry.y.mul(width)));
    })();
    material.colorNode = Fn(() => {
      const along: ShaderNode = uv().x.mul(span.add(width)).sub(width.mul(0.5));
      const cap: ShaderNode = max(along.negate(), along.sub(span)).max(0).div(width.mul(0.5));
      const r: ShaderNode = length(vec2(cap, uv().y.sub(0.5).abs().mul(2)));
      const glow: ShaderNode = smoothstep(1.0, 0.0, r);
      const core: ShaderNode = smoothstep(BEAM_CORE, BEAM_CORE * 0.3, r);
      const original = tint.mul(glow.mul(glow).mul(0.4).add(core.mul(0.9)));
      const e = ENHANCED.bolts;
      const hotCore = smoothstep(e.core, 0, r).mul(e.coreGain);
      const inner = smoothstep(e.inner, 0, r).mul(e.innerGain);
      const outer = mix(tint, vec3(...e.violet), e.violetMix)
        .mul(glow.mul(glow))
        .mul(e.outerGain);
      const position = mix(a, b, clamp(uv().x, 0, 1));
      const flicker = float(1).add(
        mx_noise_float(position.mul(e.noiseScale).add(vec3(now.mul(e.flickerRate), 0, 0))).mul(e.flicker),
      );
      const electric = vec3(hotCore).add(tint.mul(inner)).add(outer).mul(flicker);
      return vec4(mix(original, electric, enhanced), 1);
    })();
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, BEAM_SEGMENTS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.renderOrder = 7;
    this.mesh.name = 'hd-beams';
  }

  get count(): number {
    return this.mesh.count;
  }

  set(segments: readonly [Vector3, Vector3, Vector3][]): void {
    const n = Math.min(BEAM_SEGMENTS, segments.length);
    if (n === 0 && this.mesh.count === 0) return;
    for (let i = 0; i < n; i++) {
      const [p, q, c] = segments[i]!;
      this.buffer.from.setXYZ(i, p.x, p.y, p.z);
      this.buffer.to.setXYZ(i, q.x, q.y, q.z);
      this.buffer.colour.setXYZ(i, c.x, c.y, c.z);
      this.buffer.enhanced.setX(i, 0);
    }
    this.buffer.flush();
    this.mesh.count = n;
    this.mesh.visible = n > 0;
  }

  /** Stream only the fixed-capacity visible prefix; long/many bolts never allocate discarded geometry. */
  setBeams(beams: readonly BeamSpec[], enhanced = false): void {
    this.buffer.set(beams, enhanced);
    this.buffer.flush();
    this.mesh.count = this.buffer.count;
    this.mesh.visible = this.buffer.count > 0;
  }
}

/** Reusable beam geometry, exactly matching beamSegments up to the renderer's existing capacity. */
export class BeamSegmentBuffer {
  readonly from = new DirtyAttribute(new Float32Array(BEAM_SEGMENTS * 3), 3);
  readonly to = new DirtyAttribute(new Float32Array(BEAM_SEGMENTS * 3), 3);
  readonly colour = new DirtyAttribute(new Float32Array(BEAM_SEGMENTS * 3), 3);
  /** Zero for faithful bolts and all lasers; one selects the layered electric shader. */
  readonly enhanced = new DirtyAttribute(new Float32Array(BEAM_SEGMENTS), 1);
  count = 0;
  private seed = 0;
  private readonly branch = new Vector3();

  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  set(beams: readonly BeamSpec[], enhanced = false): void {
    let n = 0;
    for (let beamIndex = 0; beamIndex < beams.length && n < BEAM_SEGMENTS; beamIndex++) {
      const { from, to, colour, bolt, seed } = beams[beamIndex]!;
      if (!bolt) {
        this.from.setXYZ(n, from.x, from.y, from.z);
        this.to.setXYZ(n, to.x, to.y, to.z);
        this.enhanced.setX(n, 0);
        // Preserve the existing straight beam's white strand (its target light carries the beam colour).
        this.colour.setXYZ(n++, 1, 1, 1);
        continue;
      }
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const pieces = Math.max(1, Math.round(distance / BOLT_STEP));
      const inverseSide = 1 / (Math.sqrt(dz * dz + dx * dx) || 1);
      const sideX = dz * inverseSide;
      const sideZ = -dx * inverseSide;
      this.seed = seed >>> 0;
      const branchRandom = mulberry(seed);
      for (let strand = 0; strand < 3 && n < BEAM_SEGMENTS; strand++) {
        let ax = from.x;
        let ay = from.y;
        let az = from.z;
        const white = strand === 0 && !enhanced;
        for (let i = 1; i <= pieces && n < BEAM_SEGMENTS; i++) {
          const t = i / pieces;
          let bx = dx * t + from.x;
          let by = dy * t + from.y;
          let bz = dz * t + from.z;
          if (i < pieces) {
            const jitter = (this.random() - 0.5) * BOLT_JITTER;
            bx += sideX * jitter;
            bz += sideZ * jitter;
            by += (this.random() - 0.5) * BOLT_JITTER;
          }
          this.from.setXYZ(n, ax, ay, az);
          this.to.setXYZ(n, bx, by, bz);
          this.colour.setXYZ(n, white ? 1 : colour.x, white ? 1 : colour.y, white ? 1 : colour.z);
          this.enhanced.setX(n, enhanced ? 1 : 0);
          n++;
          if (enhanced && i % ENHANCED.bolts.branchEvery === 0 && n < BEAM_SEGMENTS) {
            const branch = boltBranchOffset(branchRandom, this.branch);
            this.from.setXYZ(n, bx, by, bz);
            this.to.setXYZ(n, bx + branch.x, by + branch.y, bz + branch.z);
            this.colour.setXYZ(n, colour.x, colour.y, colour.z);
            this.enhanced.setX(n, 1);
            n++;
          }
          ax = bx;
          ay = by;
          az = bz;
        }
      }
    }
    this.count = n;
  }

  flush(): void {
    this.from.flush();
    this.to.flush();
    this.colour.flush();
    this.enhanced.flush();
  }
}

/**
 * Per-instance inputs. `alive` is 1 from spawn to the end of the lifetime and 0 otherwise: materials scale their quad
 * by it, so pending and dead instances collapse to a point and produce no fragments.
 */
function particleInputs(pool: ParticlePool, now: ShaderNode) {
  const start: ShaderNode = instancedBufferAttribute(pool.start, 'float');
  const params: ShaderNode = instancedBufferAttribute(pool.params, 'vec4');
  const age: ShaderNode = now.sub(start);
  const life: ShaderNode = params.y;
  return {
    age,
    alive: step(0, age).mul(step(age, life)) as ShaderNode,
    size: params.x as ShaderNode,
    life,
    seed: params.z as ShaderNode,
    extra: params.w as ShaderNode,
    origin: instancedBufferAttribute(pool.origin, 'vec3') as ShaderNode,
    velocity: instancedBufferAttribute(pool.velocity, 'vec3') as ShaderNode,
  };
}

/** Camera-facing quad around `center`, sized in world units. */
function billboard(center: ShaderNode, size: ShaderNode, right: ShaderNode, up: ShaderNode) {
  return center.add(right.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size)));
}

/** Sample an enhanced tuning interval; the particle's independent shader seed still comes from ParticlePool. */
function randomBetween(range: readonly [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

/** Small seeded generator (mulberry32), so a bolt keeps its shape for the frames the caller chooses. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function additive(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  return material;
}

/** Premultiplied alpha: colour carries its own alpha, `a` says how much of the background it hides. */
function premultiplied(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.premultipliedAlpha = false;
  return material;
}

function blended(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = NormalBlending;
  return material;
}
