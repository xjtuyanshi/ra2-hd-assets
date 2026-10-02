import {
  AdditiveBlending,
  Color,
  CustomBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Vector3,
  type NodeBuilder,
} from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  cameraFar,
  cameraNear,
  color,
  cos,
  cross,
  dot,
  depth,
  exp,
  float,
  floor,
  fract,
  fwidth,
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
  varying,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, objectLight } from './atmosphere';
import type { LightField } from './lightField';
import { DirtyAttribute } from './dirtyAttribute';
import { waterTextures } from './proceduralTextures';
import { isShadowPass } from './painterDepth';
import { CARD_CLEARANCE } from './ra2/cardDepth';
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
const BILLOWS = 1536;
const DEBRIS = 1536;
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
 * own timing; optional HD flipbooks enlarge its footprint, and modern effects play around it. Per unit of the garnish
 * scale `s` (about 0.2 for a small bang, 0.9 for TWLT070, up to 3.5 for building collapses) and displayed art width W:
 *   - a real flash of light on the ground, buildings and units around it (light field pulse: radius, peak, life, decay;
 *     the exposure reference is noon flat ground, about 3.4);
 *   - an additive glow halo about 2 W wide for a third of a second (bloom picks it up), over a hotter core;
 *   - hot sparks and tumbling debris chunks that land;
 *   - rolling smoke puffs with sunlit tops, sky-lit rims and the fire's glow underneath, rising after the flash and
 *     outliving the art by a couple of seconds;
 *   - a heat shimmer over the blast and a dust ring racing out over the ground;
 *   - for anims that leave the engine's crater or scorch (Scorch=yes / Crater=yes), the crater glowing hot and cooling
 *     briefly, with charred ground fading over most of a minute while the engine's smudge stays underneath.
 * Ground-anchored depth keeps rising smoke behind foreground units; sparse rubble and short ground rests keep a
 * building collapse readable after its fireball has gone. All enhanced look tuning lives here for visual reviews.
 */
/**
 * Shared particle budget of a blast cluster. A building collapse is a dozen or more explosion anims over its
 * foundation within a second or two; with every blast throwing its own debris (up to ~100 chunks resting for seconds)
 * and a thirteen-second smoke column, a collapse buried the base under a black swarm of chunks and a smoke wall in live
 * matches (L5 compose, frozen pairs of a construction yard's death). Blasts within `radius` world units and `window`
 * seconds of each other therefore share `debris` chunks, `smoke` billows and a separate `late` column allowance.
 * Each blast keeps a small `floor` while budget remains. The ceiling includes that floor: otherwise a collapse still
 * exceeds the rubble target even after spending its shared budget. A lone blast keeps its counts up to each ceiling.
 */
export const BLAST_CROWD = {
  window: 2.5,
  radius: 2.5,
  debris: 36,
  smoke: 10,
  late: 3,
  floor: { debris: 2, smoke: 1, late: 0 },
  /** Reserve some of the remaining allowance for later anims in the same collapse. */
  followupShare: 0.5,
};

/** Recent enhanced blasts by place, for BLAST_CROWD. */
export class BlastCrowd {
  private recent: { t: number; x: number; z: number; debris: number; smoke: number; late: number }[] = [];
  constructor(private readonly budget = BLAST_CROWD) {}
  /** Grants chunks, billows and column puffs independently, given what the blast's cluster already used. */
  grant(
    now: number,
    at: Vector3,
    debris: number,
    smoke: number,
    late = 0,
  ): { debris: number; smoke: number; late: number } {
    const b = this.budget;
    this.recent = this.recent.filter((r) => now - r.t <= b.window && r.t <= now);
    let usedDebris = 0;
    let usedSmoke = 0;
    let usedLate = 0;
    for (const r of this.recent)
      if ((r.x - at.x) ** 2 + (r.z - at.z) ** 2 <= b.radius * b.radius) {
        usedDebris += r.debris;
        usedSmoke += r.smoke;
        usedLate += r.late;
      }
    const grant = (wanted: number, used: number, limit: number, floor: number) => {
      const remaining = Math.max(0, limit - used);
      const share = used > 0 ? Math.max(floor, Math.floor(remaining * b.followupShare)) : remaining;
      return Math.min(wanted, remaining, share);
    };
    const granted = {
      debris: grant(debris, usedDebris, b.debris, b.floor.debris),
      smoke: grant(smoke, usedSmoke, b.smoke, b.floor.smoke),
      late: grant(late, usedLate, b.late, b.floor.late),
    };
    this.recent.push({ t: now, x: at.x, z: at.z, ...granted });
    return granted;
  }
}

export const ENHANCED = {
  /** Extra ground-card clearance envelops the anchor's own unit without reaching the next foreground cell. */
  anchorBias: 0.5,
  anchorEpsilon: 1e-6,
  /** HD display size by effect-table category; native art and all other categories retain their size. */
  hdSize: { explosion: 1.3, collapse: 1.3, debris: 1.3, impact: 1.15 },
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
    // Tighter than the sample-2 blast light (3.8 / 10): a wide pulse washed whole lawns and plazas yellow, which reads
    // as a warm grade; the heat stays on the blast's own neighbourhood and the objects next to it. The fix round made
    // it stronger and shorter (review: "the ground is barely lit"; the target painting's pavement and grass next to
    // the fireball are lit orange): about +1x noon light at 0.7 s, mostly gone by 1 s.
    radius: 2.4,
    radiusPerScale: 3.2,
    peak: 6,
    peakPerScale: 10,
    life: 1.2,
    decay: 2.0,
  },
  /** The first light pulse: ramp temperature, radius/peak relative to the longer glow, seconds and inverse seconds. */
  flash: { temperature: 0.8, radius: 0.7, peak: 1, life: 0.18, decay: 24 },
  /** HD art carries the fireball: its narrower halo grades from a hot centre to a red rim, cooling over its life. */
  halo: {
    width: 1.6,
    life: 0.4,
    intensity: 1.8,
    hdWidth: 0.9,
    // L5 volumetric redraws carry their own flash: a wide additive glow washed their soot into an orange haze.
    hdIntensity: 0.12,
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
  sparks: { count: 14, perScale: 20, temperature: [0.5, 0.85], stretch: [2, 6], speed: 8 },
  /**
   * Airborne embers: fixed pool, count per blast, delayed births, life and slowing convection in seconds/cells.
   * `volume` and `height` scale the blast's width; wind/drift are horizontal speeds, wobble is displacement, and
   * flicker is noise amplitude. Wobble ramps in over `wobbleIn` seconds; fades are fractions of particle lifetime.
   * Fires emit `fireRate` per second at scale 1; catch-up is bounded after a stalled frame.
   */
  embers: {
    pool: 512,
    count: 3,
    perScale: 6,
    delay: 0.25,
    life: [0.5, 1.2],
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
  /** Short flights and rests avoid floating rubble after the fireball; shared ballistics also drive contact shadows. */
  debris: {
    count: 6,
    perScale: 12,
    size: 1.35,
    rest: 0.9,
    restRange: [0.7, 1.3],
    fade: 0.6,
    blur: 0.25,
    blurTail: 0.55,
    aspect: 0.65,
    velocityEpsilon: 1e-6,
    gravity: 9.8,
    lift: 0.12,
    spread: 8,
    rise: [2, 3.5],
    // Cap flight height at every scale so flight + maximum rest + fade remains below 2.5 seconds.
    maxRise: 3.2,
    speedBase: 0.5,
    speedPerScale: 0.35,
    bigChance: 0.2,
    bigSpeed: 0.6,
    bigSize: 1.25,
    sizeBase: 0.07,
    sizeJitter: 0.09,
    sizeScaleBase: 0.6,
    sizeScaleMax: 2,
    hotChance: 0.35,
    colours: [0x3e342b, 0x4e4337, 0x2f2820, 0x5a4b3c],
    ambient: 0.14,
    sun: 0.5,
    rimLight: 0.1,
    colourBreaks: [0.4, 0.72, 0.94],
    glowLife: 1.1,
    rim: 0.65,
    renderOrder: 5.9,
    alphaTest: 0.5,
    cameraPush: 0.08,
    shadow: {
      renderOrder: 5.5,
      lift: 0.02,
      radius: 1.3,
      aspect: 0.7,
      opacity: 0.45,
      airborneOpacity: 0.1,
      height: 1.5,
      edge: [1, 0.15],
      colour: 0x17120e,
    },
  },
  /**
   * Billows keep forming over `spread` seconds after the first birth at `delay`. Across `lateFrom` seconds of puff
   * age, opacity smoothly reaches the `lateOpacity` multiplier with a final `maxLate` cap, and lobe radii shrink by
   * `lateEdge` in quad space. Before that interval, opacity and radii retain their original values.
   */
  smoke: {
    count: 2,
    perScale: 3,
    delay: 0.1,
    spread: 0.9,
    life: 2.7,
    size: 0.8,
    /** World units: a merged collapse fireball is several cells wide, and art-sized puffs merged into one sheet. */
    maxSize: 1.8,
    opacity: 0.8,
    lateOpacity: 0.6,
    lateFrom: [0.3, 1.0],
    maxLate: 0.5,
    lateEdge: 0.15,
    boundary: [1, 0.6],
    lobes: 4,
    lobeRadius: [0.42, 0.62],
    lobeSpread: 0.36,
    lobeLift: 0.12,
    densityNoise: 0.45,
    ambient: 0.1,
    sun: 1.6,
    underside: 0.35,
    undersideRange: [-0.5, 0.5],
  },
  /**
   * Smoke column (blasts of scale >= `from`): puffs emitted over `span` seconds, each rising for `life` seconds.
   * `lateFrom`, `lateOpacity`, `maxLate` and `lateEdge` thin and cap the lobes as for billows.
   */
  column: {
    from: 0.35,
    count: 3,
    perScale: 3,
    span: 1.0,
    life: 2.4,
    rise: 0.32,
    size: 0.9,
    maxSize: 1.8,
    lateOpacity: 0.8,
    lateFrom: [0.3, 1.0],
    maxLate: 0.5,
    lateEdge: 0.15,
    boundary: [1, 0.6],
    lobes: 4,
    lobeRadius: [0.42, 0.62],
    lobeSpread: 0.36,
    lobeLift: 0.12,
    densityNoise: 0.45,
    ambient: 0.12,
    sun: 1.5,
    underside: 0.35,
    undersideRange: [-0.5, 0.5],
  },
  /** Trail puffs over native trail anims (SMOKEY2 behind debris, missile trails): world-unit size and seconds caps. */
  trail: { maxSize: 0.4, maxLife: 1.2 },
  shimmer: { width: 1.5, life: 1.0 },
  dust: { width: 2.2, life: 0.9 },
  /** Brief broken hot rim over the charred decal; fade thresholds are fractions of the flash's life. */
  crater: {
    width: 0.6,
    life: 0.3,
    delay: 0,
    opacity: 0.25,
    /** Rim band (normalized radius where the glow starts) and the share of scattered embers inside it. */
    rim: [0.38, 0.72],
    inner: 0.5,
    /** Emission of the thin cracks (additive): they read hot although they cover little of the crater. */
    gain: 1.8,
    colourCore: [1, 0.5, 0.16],
    colourEdge: [1, 0.3, 0.06],
    fadeIn: 0.05,
    fadeOut: 0.4,
  },
  /** Charred ground around a crater: width relative to the art, seconds until it has faded. */
  /**
   * Charred ground around a crater: width relative to the art, seconds until it has faded, seconds to darken in (under
   * the crater flash). It carries no glow of its own: a saturated orange core lasting seconds read as a flat lava decal.
   */
  char: { width: 1.8, life: 45, fadeIn: 0.15 },
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
 * Camera-space push relative to the physical fragment. viewDir points away from the orthographic camera.
 * Intersect its ray with an upright card at the centre's ground point, switching to the ground below the card.
 * Billboard lift and growth must not advance this depth: otherwise smoke hides units in front of the blast.
 */
export function anchoredDepthShift(fragment: Vector3, centre: Vector3, ground: number, viewDir: Vector3): number {
  const direction = viewDir.clone().normalize();
  const horizontal = direction.x * direction.x + direction.z * direction.z;
  const vertical =
    horizontal > ENHANCED.anchorEpsilon
      ? ((centre.x - fragment.x) * direction.x + (centre.z - fragment.z) * direction.z) / horizontal
      : Infinity;
  const floor = Math.abs(direction.y) > ENHANCED.anchorEpsilon ? (ground - fragment.y) / direction.y : Infinity;
  return CARD_CLEARANCE + ENHANCED.anchorBias - Math.min(vertical, floor);
}

/** Same ray intersection as anchoredDepthShift; orthographic depth is linear in camera-space world units. */
function anchoredDepthNode(centre: ShaderNode, ground: ShaderNode, toCamera: ShaderNode): ShaderNode {
  return Fn(([], builder: NodeBuilder) => {
    // Shadow cameras have different rays: their pass must retain physical geometry depth.
    if (isShadowPass(builder)) return depth;
    const anchor: ShaderNode = varying(centre);
    const groundHeight: ShaderNode = varying(ground);
    const direction: ShaderNode = normalize(toCamera).negate();
    const horizontal = dot(direction.xz, direction.xz);
    const vertical = dot(anchor.xz.sub(positionWorld.xz), direction.xz).div(max(horizontal, ENHANCED.anchorEpsilon));
    const verticalSpeed = max(abs(direction.y), ENHANCED.anchorEpsilon);
    const denominator = direction.y.lessThan(0).select(verticalSpeed.negate(), verticalSpeed);
    const floor = groundHeight.sub(positionWorld.y).div(denominator);
    // Parallel rays omit that plane, matching the CPU mirror without dividing by zero in either select branch.
    const both = abs(direction.y).greaterThan(ENHANCED.anchorEpsilon).select(min(vertical, floor), vertical);
    const intersection = horizontal.greaterThan(ENHANCED.anchorEpsilon).select(both, floor);
    const push = float(CARD_CLEARANCE + ENHANCED.anchorBias).sub(intersection);
    return depth.sub(push.div(cameraFar.sub(cameraNear)));
  })();
}

/** Union of seeded lobes, shaded at the front-most surface; all lobes reuse the puff's three noise samples. */
function smokeLobes(
  p: ShaderNode,
  seed: ShaderNode,
  angle: ShaderNode,
  edge: ShaderNode,
  fine: ShaderNode,
  broad: ShaderNode,
  bump: ShaderNode,
  e: typeof ENHANCED.smoke | typeof ENHANCED.column,
) {
  const nearest = float(10).toVar();
  const front = float(-1).toVar();
  const normal = vec3(0, 0, 1).toVar();
  const centreY = float(0).toVar();
  const c = cos(angle);
  const s = sin(angle);
  // Unroll at graph construction: the lobe count adds no buffers or per-fragment texture fetches.
  for (let j = 0; j < e.lobes; j++) {
    const hash = (salt: number) => fract(sin(seed.mul(17.13).add(j * 3.71 + salt)).mul(43758.5453));
    const theta = hash(0).mul(Math.PI * 2);
    const spread = sqrt(hash(1.37)).mul(e.lobeSpread);
    const x = cos(theta).mul(spread);
    const y = sin(theta).mul(spread);
    const centre = vec2(x.mul(c).sub(y.mul(s)), x.mul(s).add(y.mul(c)).add(e.lobeLift)).toVar();
    const radius = mix(...e.lobeRadius, hash(2.83)).sub(edge);
    const q = p.sub(centre).div(radius).toVar();
    const d = length(q).add(fine.sub(0.5).mul(0.15)).toVar();
    const h = sqrt(max(0, float(1).sub(d.mul(d)))).toVar();
    const surface = h.mul(radius).add(hash(4.19).mul(0.25)).toVar();
    const visible = d.lessThan(1).and(surface.greaterThan(front)).toVar();
    const n = normalize(vec3(q.x.add(bump.mul(0.5)), q.y.add(bump.mul(0.5)), h.add(0.05)));
    nearest.assign(min(nearest, d));
    normal.assign(visible.select(n, normal));
    centreY.assign(visible.select(centre.y, centreY));
    front.assign(visible.select(surface, front));
  }
  const density = smoothstep(1, 0.62, nearest)
    .mul(smoothstep(...e.boundary, length(p)))
    .mul(mix(1 - e.densityNoise, 1, broad));
  const shadow = mix(0.7, 1, smoothstep(-0.4, 0.4, centreY));
  return { density, normal, shadow };
}

/** Exact ground contact time, including the spawn lift; the shadow must not stop at the lifted origin. */
function debrisFlightTime(rise: number, height: number): number {
  return (rise + Math.sqrt(rise * rise + 2 * ENHANCED.debris.gravity * Math.max(0, height))) / ENHANCED.debris.gravity;
}

/** Shared GPU trajectory prevents rubble and its shadow from separating at landing or while the chunk fades. */
function debrisMotion(age: ShaderNode, origin: ShaderNode, velocity: ShaderNode, ground: ShaderNode) {
  const gravity = ENHANCED.debris.gravity;
  const landed = velocity.y
    .add(sqrt(velocity.y.mul(velocity.y).add(max(0, origin.y.sub(ground)).mul(2 * gravity))))
    .div(gravity);
  const flight = clamp(age, 0, landed);
  const at = origin.add(velocity.mul(flight)).add(vec3(0, flight.mul(flight).mul(-gravity / 2), 0));
  const airborne = age.lessThan(landed);
  return { at: vec3(at.x, max(at.y, ground), at.z), flight, landed, airborne };
}

function debrisFade(age: ShaderNode, life: ShaderNode): ShaderNode {
  return smoothstep(life, life.sub(ENHANCED.debris.fade), age);
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
  readonly origin: InterleavedBufferAttribute;
  readonly velocity: InstancedBufferAttribute;
  readonly params: InstancedBufferAttribute;
  readonly ground: InterleavedBufferAttribute;
  private cursor = 0;
  /** First slot written since the last flush, and how many slots (capped at the pool size). */
  private dirtyFrom = 0;
  private dirtyCount = 0;
  private readonly attributes: readonly (InstancedBufferAttribute | InstancedInterleavedBuffer)[];
  /** Seconds (effect clock) at which the last spawned particle dies; the pool draws nothing after that. */
  until = -Infinity;

  constructor(
    count: number,
    geometry: PlaneGeometry,
    material: MeshBasicNodeMaterial,
    build: (pool: ParticlePool) => void,
  ) {
    this.start = new InstancedBufferAttribute(new Float32Array(count).fill(-1e6), 1);
    // Ground is a separate float attribute, interleaved with origin so large matrix-fallback pools stay at 8 buffers.
    const placement = new InstancedInterleavedBuffer(new Float32Array(count * 4), 4);
    this.origin = new InterleavedBufferAttribute(placement, 3, 0);
    this.ground = new InterleavedBufferAttribute(placement, 1, 3);
    this.velocity = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    // x = size, y = lifetime, z = seed, w = per-pool extra (smoke: soot; sparks: style; garnish fire: ground cover)
    this.params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.attributes = [this.start, placement, this.velocity, this.params];
    this.material = material;
    this.mesh = new InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    build(this);
  }

  spawn(
    now: number,
    origin: Vector3,
    velocity: Vector3,
    size: number,
    lifetime: number,
    extra = 0,
    ground = origin.y,
    seed = Math.random(),
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.start.count;
    this.start.setX(i, now);
    this.origin.setXYZ(i, origin.x, origin.y, origin.z);
    this.velocity.setXYZ(i, velocity.x, velocity.y, velocity.z);
    this.params.setXYZW(i, size, lifetime, seed, extra);
    this.ground.setX(i, ground);
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
      const stride = 'stride' in attribute ? attribute.stride : attribute.itemSize;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(from * stride, first * stride);
      if (first < count) attribute.addUpdateRange(0, (count - first) * stride);
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
  /** Largest fireball diameter in world units (art width, including any HD display multiplier). */
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
  /** Ground contact cues share every chunk's seed, clock and ballistic inputs. */
  private readonly debrisShadow: ParticlePool;
  /** Particle budget shared by clustered enhanced blasts (BLAST_CROWD). */
  private readonly crowd = new BlastCrowd();
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
        // The hot rim is the crater flash's (embers pool); the char itself is cold soot that darkens in quickly.
        const char = vec4(
          shade,
          clamp(soot, 0, 0.88)
            .mul(smoothstep(0.0, ENHANCED.char.fadeIn, age))
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
        const tint = mix(FLAME_EDGE, vec3(1.0, 0.9, 0.6), core);
        const fade = smoothstep(0.0, 0.15, t).mul(smoothstep(1.0, 0.5, t));
        const original = vec4(tint.mul(bed.mul(0.5).add(core.mul(0.9))), fade.mul(0.55));
        // A broken hot rim and faint embers reveal the charred decal underneath; the persistent-fire bed stays intact.
        const e = ENHANCED.crater;
        const outline = mx_noise_float(vec3(p.mul(1.8), seed.mul(29).add(t.mul(0.12))));
        const radius = length(p).add(outline.mul(0.18));
        const rim = smoothstep(...e.rim, radius).mul(smoothstep(1, 0.8, radius));
        // Ridged noise: glowing cracks and ember segments, never a closed ring or a filled disc.
        const crackNoise = mx_noise_float(vec3(p.mul(6), seed.mul(41).add(t.mul(0.3))));
        const cracks = smoothstep(0.8, 0.95, float(1).sub(abs(crackNoise)));
        const fineNoise = mx_noise_float(vec3(p.mul(12), seed.mul(53)));
        const embers = smoothstep(0.88, 0.97, float(1).sub(abs(fineNoise)))
          .mul(smoothstep(0.85, 0.2, radius))
          .mul(e.inner);
        // A faint hot band along the rim, brighter along thin crack segments, and scattered ember specks inside.
        const glow = rim
          .mul(cracks.mul(0.7).add(0.3))
          .add(embers)
          .min(1)
          .mul(smoothstep(1, 0.94, length(p)));
        // Thin glowing cracks: low coverage (opacity) but emissive (gain, picked up by the bloom), hottest along the rim
        // and cooling to deep orange as the flash ends.
        const rgb = mix(vec3(...e.colourCore), vec3(...e.colourEdge), t).mul(
          float(e.gain).mul(float(1).add(rim.mul(0.4))),
        );
        const alpha = glow
          .mul(e.opacity)
          .mul(smoothstep(0, e.fadeIn, t))
          .mul(smoothstep(1, e.fadeOut, t));
        return cooling.greaterThan(0).select(vec4(rgb, alpha), original);
      })();
    });
    this.embers.mesh.renderOrder = 6;

    // Live garnish flash: centred on the native card (no lift, pulled towards the camera so it sits in front of it),
    // hottest in the middle of a young flash, cooling through the original's oranges to lit soot at the rim.
    this.garnishFire = new ParticlePool(GARNISH_FLASHES, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, ground, alive, extra: cover } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.35).add(smoothstep(0, 0.35, t).mul(0.9)));
      const centre = origin;
      pool.material.depthNode = anchoredDepthNode(centre, ground, this.toCamera);
      pool.material.positionNode = billboard(centre, grow.mul(alive), this.cameraRight, this.cameraUp);
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
      const { age, life, size, origin, ground, alive, extra: mode } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.6).add(smoothstep(0, 0.3, t).mul(0.4)));
      const centre = origin;
      pool.material.depthNode = anchoredDepthNode(centre, ground, this.toCamera);
      pool.material.positionNode = billboard(centre, grow.mul(alive), this.cameraRight, this.cameraUp);
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
    // lobes: lit from the upper left like the original art, a sky-lit rim, the local light field (fires,
    // explosions), and the fire's glow underneath while they are young (params.w = heat). Premultiplied: the glow adds
    // light, the soot covers what is behind.
    this.billow = new ParticlePool(BILLOWS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, velocity, ground, alive, extra: heat } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const flight = min(age, life);
      // The initial surge slows, but convection and wind keep carrying the cloud through its longer tail.
      const drift = velocity.mul(
        float(1)
          .sub(exp(flight.mul(-1.1)))
          .div(1.1)
          .add(flight.mul(0.12)),
      );
      const grow = size
        .mul(
          float(0.55).add(
            float(1)
              .sub(exp(flight.mul(-0.8)))
              .mul(1.0),
          ),
        )
        .mul(alive);
      const centre = origin.add(drift);
      pool.material.depthNode = anchoredDepthNode(centre, ground, this.toCamera);
      pool.material.positionNode = billboard(centre, grow, this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const angle = seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(1.2)));
        const c = cos(angle);
        const s = sin(angle);
        const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
        const lumps = texture(noise, q.mul(0.32).add(vec2(seed.mul(3.7), seed.mul(1.9).add(age.mul(0.025))))).g.toVar();
        const broad = texture(noise, q.mul(0.16).add(vec2(seed.mul(7.1), seed.mul(2.3).add(age.mul(0.018))))).r.toVar();
        const fine = texture(noise, q.mul(0.9).add(vec2(seed.mul(5.3), age.mul(-0.04)))).b.toVar();
        const bump = lumps.sub(0.5).mul(1.2).add(broad.sub(0.5).mul(0.6)).add(fine.sub(0.5).mul(0.4)).toVar();
        const e = ENHANCED.smoke;
        const late = smoothstep(...e.lateFrom, age);
        const edge = late.mul(e.lateEdge);
        const { density, normal: nrm, shadow } = smokeLobes(p, seed, angle, edge, fine, broad, bump, e);
        const sun = dot(nrm, vec3(-0.5, 0.68, 0.53)).max(0);
        const rim = pow(float(1).sub(nrm.z), 3).mul(0.35);
        const shade = float(e.ambient)
          .add(sun.mul(e.sun))
          .add(rim)
          .mul(mix(e.underside, 1, smoothstep(...e.undersideRange, nrm.y)))
          .mul(shadow);
        const lit = this.nodes.sceneBrightness
          .mul(shade)
          .add(objectLight(positionWorld.xz, this.nodes).div(this.nodes.referenceLevel).mul(0.45));
        // Young soot retains the fire's warmth; cold lobes age to neutral grey so sunlit tops stay distinct.
        const base = mix(color(0x1d1a17), color(0x86847f), clamp(t.mul(1.6).add(seed.mul(0.25)), 0, 1));
        // The fire's glow: underneath the young puff, and inside it for the first moments (black-orange smoke).
        // The fire's glow fades in seconds, not in shares of the (long) life: a lingering cloud is cold soot.
        const under = smoothstep(0.15, -0.8, nrm.y)
          .mul(exp(age.mul(-3.2)))
          .mul(1.8);
        const inner = exp(dot(p, p).mul(-3))
          .mul(pow(clamp(float(1).sub(age.div(0.7)), 0, 1), 2))
          .mul(1.6);
        const glow = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.66, 0.3), inner.min(1))
          .mul(heat)
          .mul(under.add(inner));
        const alpha = density
          .mul(smoothstep(0.0, 0.08, t))
          .mul(smoothstep(1.0, 0.35, t))
          .mul(e.opacity)
          .mul(mix(1, e.lateOpacity, late))
          .mul(t.lessThan(1).select(float(1), float(0)))
          .min(mix(1, e.maxLate, late));
        return vec4(base.mul(lit).mul(alpha).add(glow.mul(alpha)), alpha);
      })();
    });

    this.debrisShadow = new ParticlePool(DEBRIS, ground, blended(), (pool) => {
      const { age, life, size, origin, velocity, ground, alive } = particleInputs(pool, this.now);
      const e = ENHANCED.debris.shadow;
      const { at } = debrisMotion(age, origin, velocity, ground);
      // Follow the chunk's horizontal flight; height weakens contact rather than lifting the decal into the smoke.
      const radius = size.mul(2 * e.radius).mul(alive);
      pool.material.positionNode = vec3(at.x, ground.add(e.lift), at.z).add(
        positionLocal.mul(vec3(radius, 0, radius.mul(e.aspect))),
      );
      pool.material.colorNode = Fn(() => {
        const ellipse = smoothstep(...e.edge, length(uv().sub(0.5).mul(2)));
        const opacity = mix(e.opacity, e.airborneOpacity, clamp(at.y.sub(ground).div(e.height), 0, 1));
        const tint: ShaderNode = color(e.colour);
        return vec4(tint, ellipse.mul(opacity).mul(debrisFade(age, life)));
      })();
    });
    this.debrisShadow.mesh.renderOrder = ENHANCED.debris.shadow.renderOrder;

    // Sparse rubble is depth-tested (not written) before smoke and effect cards; coverage cut-outs keep crisp polygons.
    this.debris = new ParticlePool(DEBRIS, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, velocity, ground, alive, extra: hot } = particleInputs(pool, this.now);
      const e = ENHANCED.debris;
      const t = clamp(age.div(life), 0, 1);
      const { at, flight, landed, airborne } = debrisMotion(age, origin, velocity, ground);
      const currentVelocity = vec3(velocity.x, velocity.y.sub(flight.mul(e.gravity)), velocity.z);
      const projected = vec2(dot(currentVelocity, this.cameraRight), dot(currentVelocity, this.cameraUp));
      const speed = length(projected);
      const direction = projected.div(max(speed, e.velocityEpsilon));
      const stretch = airborne.select(float(1).add(speed.mul(e.blur)), float(1));
      const spin = seed.mul(20).add(flight.mul(seed.mul(10).add(7)));
      const c = cos(spin);
      const s = sin(spin);
      const corner = vec2(positionLocal.x, positionLocal.y.mul(e.aspect));
      const turned = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(
        size.mul(alive),
      );
      const blurred = turned.add(direction.mul(dot(turned, direction)).mul(stretch.sub(1)));
      pool.material.positionNode = at
        .add(this.toCamera.mul(e.cameraPush))
        .add(this.cameraRight.mul(blurred.x))
        .add(this.cameraUp.mul(blurred.y));
      pool.material.colorNode = Fn(() => {
        const p: ShaderNode = uv().sub(0.5).mul(2);
        // A seeded 5-7 vertex polygon, intersected by the fragment's radial ray. Wrapping the last vertex keeps
        // the outline continuous at atan's seam; derivatives hold its antialiasing to about 1-2 screen pixels.
        const hash = (index: ShaderNode): ShaderNode =>
          fract(sin(index.mul(127.1).add(seed.mul(311.7))).mul(43758.5453));
        const sides = floor(seed.mul(3)).add(5);
        const sector = float(Math.PI * 2).div(sides);
        const angle = p.y.atan(p.x).add(Math.PI);
        const vertex = floor(angle.div(sector)).min(sides.sub(1));
        const local = angle.sub(vertex.mul(sector));
        const radius0 = hash(vertex).mul(0.24).add(0.74);
        const radius1 = hash(vertex.add(1).mod(sides)).mul(0.24).add(0.74);
        const radius = radius0
          .mul(radius1)
          .mul(sin(sector))
          .div(max(radius1.mul(sin(sector.sub(local))).add(radius0.mul(sin(local))), 0.01));
        const edgeDistance = length(p).sub(radius);
        const aa = max(fwidth(edgeDistance), 0.008);
        const chunk = smoothstep(aa.mul(0.65), aa.mul(-0.65), edgeDistance);
        // A raised top face meets angular side faces. Rotate their normals with the tumbling chunk, using the
        // smoke's upper-left light because this layer has no directional-sun input; sceneLight supplies day/night.
        const faceAngle = vertex.add(0.5).mul(sector).sub(Math.PI);
        const side = normalize(vec3(cos(faceAngle).mul(0.85), sin(faceAngle).mul(0.85), 0.45));
        const top = normalize(vec3(seed.sub(0.5).mul(0.4), 0.6, 0.8));
        const topFace: ShaderNode = p.y.greaterThan(p.x.mul(seed.sub(0.5).mul(0.6)).sub(0.12));
        const normal: ShaderNode = topFace.select(top, side);
        const turnedNormal = vec3(normal.x.mul(c).sub(normal.y.mul(s)), normal.x.mul(s).add(normal.y.mul(c)), normal.z);
        const sun = dot(turnedNormal, vec3(-0.5, 0.68, 0.53)).max(0);
        const material = hash(float(11));
        const base = mix(
          mix(color(e.colours[0]), color(e.colours[1]), step(e.colourBreaks[0], material)),
          mix(color(e.colours[2]), color(e.colours[3]), step(e.colourBreaks[2], material)),
          step(e.colourBreaks[1], material),
        );
        const edge = float(1).sub(smoothstep(0, aa.mul(0.9), edgeDistance.negate()));
        const upperEdge = dot(vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))), vec2(-0.59, 0.81)).max(0);
        // Mostly dark silhouettes against the fire (the target painting's rubble), with a faint lit facet: bright
        // sunlit faces and pale rims read as grey slabs floating in the fireball.
        const shade = base
          .mul(float(e.ambient).add(sun.mul(e.sun)))
          .mul(float(1).sub(edge.mul(0.65)))
          .add(color(0xa49988).mul(edge).mul(upperEdge).mul(e.rimLight))
          .mul(this.sceneLight);
        // Hot chunks keep their ember ramp while airborne and cool before their short ground rest ends.
        const heat = clamp(float(1).sub(age.div(ENHANCED.debris.glowLife)), 0, 1);
        const temperature = mix(float(1), float(ENHANCED.debris.rim), clamp(length(p), 0, 1)).mul(heat);
        const ember = emberRamp(temperature)
          .mul(hot)
          .mul(smoothstep(ENHANCED.debris.glowLife, 0, age))
          .mul(age.lessThan(landed).select(float(1), float(0)));
        const screenP = vec2(p.x, p.y.mul(e.aspect));
        const turnedP = vec2(screenP.x.mul(c).sub(screenP.y.mul(s)), screenP.x.mul(s).add(screenP.y.mul(c)));
        // Thin the streak ends while preserving cut-out coverage in its core; landed chunks regain their facets.
        const streakAlpha = airborne.select(mix(1, e.blurTail, clamp(abs(dot(turnedP, direction)), 0, 1)), float(1));
        const rgb: ShaderNode = shade.add(ember);
        return vec4(
          rgb,
          chunk
            .mul(streakAlpha)
            .mul(debrisFade(age, life))
            .mul(t.lessThan(1).select(float(1), float(0))),
        );
      })();
    });
    // No depth write: effect cards and smoke drawn later cover the chunks they overlap. Writing depth let chunks inside
    // the fireball punch through its anchored card as dark triangular specks on the white-yellow core (L5F review).
    this.debris.material.depthWrite = false;
    this.debris.material.alphaTest = ENHANCED.debris.alphaTest;
    this.debris.mesh.renderOrder = ENHANCED.debris.renderOrder;

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
        // Kicked-up soil, not a disc: a ragged front whose radius wobbles with direction (noise read along the unit
        // circle), broken into clumps, with a thin trailing skirt. The earlier pale filled ellipse read as a flat
        // grey decal beside the fireball.
        const dir = p.div(max(d, 1e-3));
        const offset = vec2(seed.mul(9.1), seed.mul(3.3));
        const lumps = texture(noise, dir.mul(0.3).add(offset)).g;
        const clumps = texture(noise, p.mul(0.9).add(offset.yx)).r;
        const front = float(0.8).add(lumps.sub(0.5).mul(0.32));
        const ring = smoothstep(front.sub(0.42), front.sub(0.04), d).mul(
          smoothstep(front.add(0.05), front.sub(0.02), d),
        );
        const broken = smoothstep(0.32, 0.62, clumps.add(lumps.sub(0.5).mul(0.5)));
        const skirt = smoothstep(front, front.sub(0.6), d).mul(0.12);
        // Dark, slightly warm soil; the inner skirt is scorched darker still.
        const dustColour: ShaderNode = mix(color(0x3e342a), color(0x75644f), smoothstep(0.3, 0.75, d)).mul(
          this.sceneLight,
        );
        const alpha = ring
          .mul(mix(float(0.35), float(1), broken))
          .add(skirt)
          .mul(pow(float(1).sub(t), 1.5))
          .mul(0.62)
          .mul(t.lessThan(1).select(float(1), float(0)));
        return vec4(dustColour, alpha);
      })();
    });
    this.dust.mesh.renderOrder = 5;

    // Enhanced fireball over the native art (premultiplied: fire adds light and hides `cover` of what is behind, so
    // the pixel art under it reads as a detailed, boiling ball). Three octaves of evolving noise shape a lumpy ball
    // whose hot core cools outwards and with age through the original palette's fire colours into lit soot.
    this.blast = new ParticlePool(BLASTS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, ground, alive, extra: cover } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(
        float(0.5)
          .add(smoothstep(0, 0.18, t).mul(0.38))
          .add(t.mul(0.22)),
      );
      const rise: ShaderNode = t.mul(size).mul(0.22);
      const centre = origin.add(vec3(0, rise, 0));
      pool.material.depthNode = anchoredDepthNode(centre, ground, this.toCamera);
      pool.material.positionNode = billboard(centre, grow.mul(alive), this.cameraRight, this.cameraUp);
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

    // Enhanced smoke column: a few large puffs rise and spread, lumpy and lit like the rolling
    // smoke, glowing from the fire below while young (params.w = heat), dispersing to a thin grey.
    this.column = new ParticlePool(COLUMN_PUFFS, quad, premultiplied(), (pool) => {
      const { age, life, size, seed, origin, velocity, ground, alive, extra: heat } = particleInputs(pool, this.now);
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
      const centre = origin.add(velocity.mul(flight));
      pool.material.depthNode = anchoredDepthNode(centre, ground, this.toCamera);
      pool.material.positionNode = billboard(centre, grow, this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const angle = seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(0.4)));
        const c = cos(angle);
        const sn = sin(angle);
        const q = vec2(p.x.mul(c).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(c)));
        const lumps = texture(noise, q.mul(0.3).add(vec2(seed.mul(3.7), seed.mul(1.9).add(age.mul(0.012))))).g.toVar();
        const broad = texture(noise, q.mul(0.16).add(vec2(seed.mul(7.1), seed.mul(2.3).add(age.mul(0.018))))).r.toVar();
        const fine = texture(noise, q.mul(0.85).add(vec2(seed.mul(5.3), age.mul(-0.02)))).b.toVar();
        const bump = lumps.sub(0.5).mul(1.2).add(fine.sub(0.5).mul(0.4)).toVar();
        const e = ENHANCED.column;
        const late = smoothstep(...e.lateFrom, age);
        const edge = late.mul(e.lateEdge);
        const { density, normal: nrm, shadow } = smokeLobes(p, seed, angle, edge, fine, broad, bump, e);
        const sun = dot(nrm, vec3(-0.5, 0.68, 0.53)).max(0);
        const rim = pow(float(1).sub(nrm.z), 3).mul(0.3);
        const lit = this.nodes.sceneBrightness
          .mul(
            float(e.ambient)
              .add(sun.mul(e.sun))
              .add(rim)
              .mul(mix(e.underside, 1, smoothstep(...e.undersideRange, nrm.y)))
              .mul(shadow),
          )
          .add(objectLight(positionWorld.xz, this.nodes).div(this.nodes.referenceLevel).mul(0.4));
        const base = mix(color(0x2a2622), color(0x8e8c87), clamp(t.mul(1.5).add(seed.mul(0.2)), 0, 1));
        const glow = vec3(1.0, 0.42, 0.12)
          .mul(heat)
          .mul(smoothstep(0.1, -0.8, nrm.y))
          .mul(pow(clamp(float(1).sub(t.mul(5)), 0, 1), 2))
          .mul(1.4);
        const alpha = density
          .mul(smoothstep(0.0, 0.06, t))
          .mul(smoothstep(1.0, 0.4, t))
          .mul(0.62)
          .mul(mix(1, e.lateOpacity, late))
          .mul(t.lessThan(1).select(float(1), float(0)))
          .min(mix(1, e.maxLate, late));
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
      this.debrisShadow,
      this.debris,
      this.smoke,
      this.column,
      this.billow,
      this.dots,
      this.flames,
      this.fireballs,
      this.garnishFire,
      this.blast,
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
   * `options.maxSize` is the displayed art's width (world units); the core stays inside it, the halo, smoke and dust
   * spread around it.
   */
  private enhancedExplosion(now: number, at: Vector3, scale: number, wind: Vector3, options: GarnishOptions): void {
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    // Building collapses reach a scale of 3.5: their light and particle counts stop growing past these.
    const s = Math.min(2, scale * FX_GARNISH);
    const lightScale = Math.min(1.6, s);
    // Displayed art width (world units), already enlarged for HD; tables without art fall back to the scale.
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
        at.y,
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
    const lifted = at.clone().add(new Vector3(0, e.debris.lift, 0));
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
    // Clustered blasts share independent budgets (BLAST_CROWD); a lone blast keeps its requests up to each ceiling.
    const wantDebris = Math.round(e.debris.count + e.debris.perScale * s);
    const wantColumn = s >= e.column.from ? Math.round(e.column.count + e.column.perScale * Math.min(1.5, s)) : 0;
    const wantBillows = Math.round(e.smoke.count + e.smoke.perScale * s);
    const granted = this.crowd.grant(now, at, wantDebris, wantBillows, wantColumn);
    for (let i = 0, n = granted.debris; i < n; i++) {
      const d = e.debris;
      const big = Math.random() < d.bigChance;
      const velocity = new Vector3(r(d.spread), randomBetween(d.rise), r(d.spread)).multiplyScalar(
        (d.speedBase + d.speedPerScale * s) * (big ? d.bigSpeed : 1),
      );
      velocity.y = Math.min(velocity.y, d.maxRise);
      const size =
        (d.sizeBase + Math.random() * d.sizeJitter * Math.min(d.sizeScaleMax, d.sizeScaleBase + s)) *
        (big ? d.bigSize : 1) *
        d.size;
      const lifetime = debrisFlightTime(velocity.y, lifted.y - at.y) + d.rest * randomBetween(d.restRange) + d.fade;
      const hot = Math.random() < d.hotChance ? 1 : 0;
      const seed = Math.random();
      // Identical inputs give the shadow the exact same flight, landing and fade, without per-frame CPU updates.
      this.debris.spawn(now, lifted, velocity, size, lifetime, hot, at.y, seed);
      this.debrisShadow.spawn(now, lifted, velocity, size, lifetime, hot, at.y, seed);
    }
    // Larger blasts emit their separately budgeted column puffs over the first second, rising with the wind.
    for (let i = 0, n = granted.late; i < n; i++) {
      const delay = 0.25 + (i / n) * e.column.span * (0.7 + 0.3 * Math.random());
      const velocity = new Vector3(r(0.12), e.column.rise * (0.8 + Math.random() * 0.4), r(0.12))
        .multiplyScalar(0.8 + 0.3 * s)
        .add(wind.clone().multiplyScalar(0.6));
      this.column.spawn(
        now + delay,
        at.clone().add(new Vector3(r(0.4 * width), 0.2 * width, r(0.4 * width))),
        velocity,
        Math.min(e.column.size * width, e.column.maxSize) * (0.8 + Math.random() * 0.4),
        e.column.life * (0.8 + Math.random() * 0.4),
        Math.max(0, 1 - delay / 2.5),
        at.y,
      );
    }
    for (let i = 0, n = granted.smoke; i < n; i++) {
      const velocity = new Vector3(r(0.5), 0.45 + Math.random() * 0.45, r(0.5)).multiplyScalar(0.6 + 0.4 * s).add(wind);
      const x = r(0.7 * width);
      const z = r(0.7 * width);
      // Births fill a dome: outer puffs start lower than those over the blast centre.
      const height = Math.max(0.1, Math.sqrt((0.55 * width) ** 2 - x * x - z * z));
      this.billow.spawn(
        now + e.smoke.delay + ((i + Math.random()) / n) * e.smoke.spread,
        at.clone().add(new Vector3(x, 0.1 + Math.random() * (height - 0.1), z)),
        velocity,
        Math.min(e.smoke.size * width, e.smoke.maxSize) * (0.8 + Math.random() * 0.5),
        e.smoke.life * (0.8 + Math.random() * 0.4),
        1,
        at.y,
      );
    }
    this.shimmer.spawn(now + 0.05, at, this.zeroVelocity, e.shimmer.width * width, e.shimmer.life);
    this.dust.spawn(now, at, this.zeroVelocity, e.dust.width * width, e.dust.life);
    if (options.hotCrater) {
      this.embers.spawn(now + e.crater.delay, at, this.zeroVelocity, e.crater.width * width, e.crater.life, 1);
      // Charred ground around the engine's crater smudge (which stays underneath), fading over most of a minute.
      this.scorch.spawn(now + 0.05, at, this.zeroVelocity, e.char.width * width, e.char.life, 1);
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
   * short light at its target unless its flash flag is false. `flash` false updates only geometry, keeping an appended
   * decorative layer from retriggering native impacts. Enhanced bolts flicker with the presentation clock and add a
   * blue-white impact pulse.
   */
  setBeams(now: number, beams: readonly BeamSpec[], flash = true): void {
    this.beams.setBeams(beams, this.enhancedBeams);
    if (!flash) return;
    const light = GARNISH_LIGHTS.beam;
    const flashing = beams.some((beam) => beam.flash === false) ? beams.filter((beam) => beam.flash !== false) : beams;
    // Only the last 256 pulses survive the light field's flash ring. Avoid processing discarded pulses.
    for (let i = Math.max(0, flashing.length - BEAM_LIGHTS); i < flashing.length; i++) {
      const beam = flashing[i]!;
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
        if (!beam.bolt || beam.flash === false) continue;
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
  /** False for decorative beams whose owning source already provides the light; also skips impact garnish. */
  flash?: boolean;
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
    origin: instancedBufferAttribute(
      pool.origin.data,
      'vec3',
      pool.origin.data.stride,
      pool.origin.offset,
    ) as ShaderNode,
    ground: instancedBufferAttribute(
      pool.ground.data,
      'float',
      pool.ground.data.stride,
      pool.ground.offset,
    ) as ShaderNode,
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
