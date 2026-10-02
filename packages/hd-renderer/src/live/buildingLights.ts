import { Vector3 } from 'three/webgpu';
import {
  orbOccluderDistances,
  orbSilhouetteScale,
  type EmissiveDisc,
  type EmissiveStroke,
  type OverlayRgb,
  type PlasmaOrb,
} from '../emissiveOverlay';
import { flicker, SHAPE_LINEAR, SHAPE_POOL, SHAPE_SOFT, type SourceSpec } from '../lightField';
import { foundationPointPush } from '../ra2/cardDepth';
import { IsoCamera, LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import type { LiveObject } from './liveView';

export interface BuildingLightSpec {
  /** This light represents the building's native ActiveAnim glow. */
  activeAnim?: boolean;
  /** Fractions of the foundation, measured from its top-left cell corner. */
  at: readonly [number, number];
  /** Engine pixels above ground. */
  height: number;
  /** Linear irradiance relative to noon flat ground. */
  colour: readonly [number, number, number];
  radius: number;
  flicker: number;
  /** Linear radiance multiplier for the visible head. */
  glow: readonly [number, number, number] | null;
  glowSize: number;
  /** Core radius of the visible head as a fraction of its half-size (default: a lamp's small bulb). */
  glowCore?: number;
  /** White-hot centre gain of the visible head (default none). */
  glowHot?: number;
  /**
   * Head glow multiplier in full daylight (default 1, blending to 1 at night with the lamp gain). Under the day exposure
   * the night radiance left the reactor's orb a dim blue bubble; the target's orb blazes white-blue in sunlight.
   */
  glowDay?: number;
  /**
   * Extra depth pull of the head and its arcs towards the camera (world units, default 0.15) past the foundation point's
   * card depth: a head inside the art's facade ridge is hidden by its own building card.
   */
  push?: number;
  hole: boolean;
  damaged: number;
  /** Ground falloff: 'wide' reaches beyond a large hole (SHAPE_LINEAR), 'pool' is the compact fire pool. */
  falloff?: 'wide' | 'pool' | 'soft';
  orb?: PlasmaOrb;
  arcStyle?: BuildingArcStyle;
  fadeIn?: number;
  /**
   * Share of the pool that upright building art takes only inside its own foundation (SourceSpec.groundOnly, default
   * 0). The reactor's own facades and orb glass sample the ground just in front of the art and took the full pool: a
   * deep blue light on near-white glass tone-maps to a dark pure blue (the orb measured L* 36 with the pool alone, 95
   * without).
   */
  groundOnly?: number;
  /**
   * Share of the light kept in full daylight (default 1). Work and furnace lights read only after dusk, like the street
   * lamps: the rest fades in with the renderer's lamp gain.
   */
  day?: number;
}

export interface BuildingArcStyle {
  core: OverlayRgb;
  edge: OverlayRgb;
  width: number;
  forkWidth: number;
  coreFraction: number;
  filaments: readonly [number, number];
  strikes: readonly [number, number];
  /** Engine pixels from the orb centre, screen x right and y down. */
  anchors: readonly (readonly [number, number])[];
  maxBeyond: number;
  /** Radians per logic frame; geometry samples this drift at the start of each frame pair. */
  crawl: number;
  glowWidth: number;
  glowAlpha: number;
  /** Filament start radius range as fractions of the orb radius (default [0.12, 0.25]). */
  filamentStart?: readonly [number, number];
  /**
   * Filament end radius range as fractions of the orb radius (default [0.92, 0.985]: spokes reaching the glass). Forks
   * end at the range's maximum (at most 0.95). Ends well inside the glass keep the lightning crawling INSIDE the globe
   * instead of radiating from a hot centre to the rim (the owner read rim-to-centre spokes as a Tesla coil firing).
   */
  filamentEnd?: readonly [number, number];
  /**
   * Glow under-strokes begin at the first vertex at least this fraction of the orb radius from its centre (default 0:
   * whole path). Five filament glows converging on the centre painted the white-hot core saturated blue.
   */
  glowStart?: number;
}

/** Colour-picker values are sRGB; the overlay attachment and post composite are display-linear. */
export function displayLinear(r: number, g: number, b: number): OverlayRgb {
  const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return [linear(r), linear(g), linear(b)];
}

export const BUILDING_LIGHTS: Record<string, BuildingLightSpec[]> = {
  // The measured daytime pool lifted pavement L* 36 -> 53. Keep only a contained blue tint (day luma 0.173),
  // and present the saturated sphere/arcs after the grade so neither can feed bloom's lavender-white veil.
  NAPOWR: [
    {
      // NAPOWR_A redraws the sphere/walls; the type has no Light* keys. Native detail skips are presentation only.
      activeAnim: true,
      // Battle framing at two device pixels per engine pixel: this head is within one engine pixel of the glass centre.
      at: [0.47, 0.4],
      height: 27,
      // Owner feedback (L5H): the energy stays inside the machine. NAPOWR has no Light* keys, so the original lights
      // no ground at all; the pool is a faint tint confined to the reactor's own 3x2 foundation (radius 1 cell from
      // its centre reaches the short axis' edge with zero weight). The L5G 2.6-cell pool painted the night pavement
      // and neighbouring facades blue; at 1.4 cells it still lit 4.5k night px outside the reactor's silhouette.
      // Night value; by day only `day` of it (the same daytime irradiance as L5G, about 0.17 of noon flat ground).
      colour: [0.45, 1.25, 7.6],
      radius: 1,
      flicker: 0.12,
      day: 0.11,
      groundOnly: 1,
      glow: null,
      glowSize: 0,
      hole: false,
      damaged: 0.6,
      falloff: 'soft',
      fadeIn: 0.5,
      orb: {
        // The art's glass radius measures 17.75 engine px / PIXELS_PER_CELL_EDGE = 0.418 world units.
        // No halo may extend that silhouette.
        radius: 0.418,
        // Owner feedback (L5H, "a Tesla coil about to explode"): the original sphere is a GLASS globe with lightning
        // inside, and the HD art's own NAPOWR_A frames already paint that glass, its lightning and the crackle in the
        // cradle. The overlay therefore adds no white-hot core and no plasma body: only a faint blue-violet tint
        // inside the glass (the original's lavender-blue sphere; a pale tint turned the night glass milky grey) so
        // the art's glass reflections and lightning stay visible, day and night.
        hot: displayLinear(120, 140, 255),
        mid: displayLinear(110, 130, 255),
        body: displayLinear(90, 110, 255),
        limb: displayLinear(120, 140, 250),
        filaments: displayLinear(200, 215, 255),
        halo: displayLinear(90, 110, 255),
        coreRadius: 0.55,
        bodyStart: 0.75,
        bodyEnd: 0.92,
        alpha: 1,
        // Sandbox day/night, one and two reactors: 0.25/0.18 left the night glass grey; this tint keeps it the
        // faithful render's deep blue while the box stays below the L5G orb's saturated blue (two reactors 7492 vs
        // 8712; the L5G orb measured 0.90x the live original's).
        coreAlpha: 0.35,
        bodyAlpha: 0.26,
        limbAlpha: 0.1,
        filamentMix: 0,
        haloAlpha: 0,
        haloScale: 1,
        // Front-right tower corner (+11.5, -1.5) engine px; top rises right at -22 degrees, left edge drops at 90.
        occluders: [{ corner: [0.648, -0.085], from: -22, to: 90 }],
      },
      arcStyle: {
        // Thin white-blue lightning that crawls INSIDE the glass (ends at 55-85 % of the radius, never at the rim),
        // with a faint narrow glow; no strikes to the coil or towers. At most one short arc drops from the glass into
        // the cradle below it (the original's crackle between the sphere and its base), inside the footprint.
        core: displayLinear(235, 242, 255),
        edge: displayLinear(110, 130, 255),
        width: 1.1,
        forkWidth: 0.8,
        coreFraction: 0.5,
        glowWidth: 2.2,
        glowAlpha: 0.22,
        filaments: [3, 4],
        strikes: [0, 1],
        filamentStart: [0.08, 0.22],
        filamentEnd: [0.55, 0.85],
        glowStart: 0,
        // Cradle fittings directly below the glass (engine px): left fitting, centre pad emitter, right fitting.
        anchors: [
          [-12, 22],
          [-2, 26],
          [8, 22],
        ],
        maxBeyond: 9,
        crawl: 0.06,
      },
    },
  ],
  // Soviet Tesla coil (image NATESL, 1x1): the charged coil head throws a small flickering blue pool; unlike the
  // reactor the post is too thin to need a hole.
  TESLA: [
    {
      // The coil art stands about 16 engine px left of its cell centre (bench at zoom 2: the head landed right of and
      // below the ball with [0.5, 0.5] and 62 px).
      at: [0.24, 0.76],
      height: 72,
      colour: [0.3, 1.4, 7.0],
      radius: 2.2,
      flicker: 0.35,
      glow: [0.2, 0.5, 2.8],
      glowDay: 2,
      glowSize: 0.8,
      glowCore: 0.3,
      hole: false,
      damaged: 0.5,
      day: 0.5,
    },
  ],
  // Soviet war factory: warm interior light spilling out of the bay door on its +x face onto the apron in front.
  NAWEAP: [
    {
      at: [1.06, 0.55],
      height: 12,
      colour: [2.6, 1.5, 0.55],
      radius: 1.7,
      flicker: 0.04,
      glow: null,
      glowSize: 0,
      hole: false,
      damaged: 0.5,
      day: 0.12,
    },
  ],
  // Allied war factory: the same bay light at its +x door.
  GAWEAP: [
    {
      at: [1.06, 0.5],
      height: 12,
      colour: [2.3, 1.7, 1.0],
      radius: 1.7,
      flicker: 0.04,
      glow: null,
      glowSize: 0,
      hole: false,
      damaged: 0.5,
      day: 0.12,
    },
  ],
  // Soviet refinery: the ore smelter's furnace glow, a warm pool around the foundation from its edge.
  NAREFN: [
    {
      at: [0.5, 0.5],
      height: 10,
      colour: [2.4, 0.95, 0.25],
      radius: 2.6,
      flicker: 0.12,
      glow: null,
      glowSize: 0,
      hole: true,
      // Like the reactor: the furnace lights the apron and the harvester dock, not the smelter's own walls.
      groundOnly: 1,
      damaged: 0.5,
      falloff: 'pool',
      day: 0.1,
    },
  ],
};

type Building = Pick<
  LiveObject,
  'type' | 'kind' | 'x' | 'y' | 'z' | 'health' | 'buildState' | 'buildingDamaged' | 'activeAnim'
> &
  Partial<Pick<LiveObject, 'uid' | 'id'>>;

export interface BuildingLightPlacement extends SourceSpec {
  key: string;
  groundY: number;
  headPosition: Vector3;
  damaged: number;
  orb?: PlasmaOrb;
  arcStyle?: BuildingArcStyle;
  fade?: number;
}

/** Pure placement policy; the foundation is supplied by the type library, never inferred from the art. */
export function buildingLightPlacements(
  type: string,
  building: Pick<Building, 'x' | 'y' | 'z' | 'uid' | 'id'>,
  foundation: readonly [number, number],
): BuildingLightPlacement[] {
  const x0 = Math.floor(building.x / 256);
  const z0 = Math.floor(building.y / 256);
  const groundY = (building.z / 104) * LEVEL_HEIGHT;
  const [w, h] = foundation;
  return (BUILDING_LIGHTS[type] ?? []).map((spec, index) => {
    const lx = spec.at[0] * w;
    const lz = spec.at[1] * h;
    const x = x0 + lx;
    const z = z0 + lz;
    const head = (spec.height / 15) * LEVEL_HEIGHT;
    return {
      key: `building:${building.uid ?? building.id ?? `${type}@${x0},${z0}`}:${index}`,
      x: spec.falloff === 'soft' ? x0 + w / 2 : x,
      z: spec.falloff === 'soft' ? z0 + h / 2 : z,
      groundY,
      head,
      headPosition: new Vector3(x, groundY + head, z),
      colour: spec.colour,
      radius: spec.radius,
      flicker: spec.flicker,
      glow: spec.glow,
      glowSize: spec.glowSize,
      glowCore: spec.glowCore,
      glowHot: spec.glowHot,
      shape: spec.falloff === 'soft' ? SHAPE_SOFT : spec.falloff === 'wide' ? SHAPE_LINEAR : SHAPE_POOL,
      fadeIn: spec.fadeIn,
      orb: spec.orb,
      arcStyle: spec.arcStyle,
      groundOnly: spec.groundOnly,
      hole: spec.hole ? [w / 2, h / 2] : undefined,
      holeOffset: spec.hole ? [w / 2 - lx, h / 2 - lz] : undefined,
      // Clear the owner's facade depth without moving the head on screen (fixed orthographic camera).
      push: foundationPointPush(lx, lz, w, h) + (spec.push ?? 0.15),
      damaged: spec.damaged,
      ttl: 0.6,
      seed: (hashString(`building:${building.uid ?? building.id ?? `${type}@${x0},${z0}`}:${index}`) % 1000) / 1000,
    };
  });
}

/** Per-frame source selection; disabled sources perform no library or visibility queries. */
export function buildingLightSources(
  buildings: readonly Building[],
  /** night: the renderer's lamp gain (0 by day, 1 at night) for lights with a `day` share below one. */
  settings: { sourceLights: number; night?: number; nativeDetail?: 'ignore' | 'mirror' },
  foundation: (type: string) => readonly [number, number] | undefined,
  shrouded: (building: Building) => boolean,
  conditionYellow = 0.5,
  gate?: BuildingLightGate,
): BuildingLightPlacement[] {
  if (!(settings.sourceLights > 0)) return [];
  const out: BuildingLightPlacement[] = [];
  for (const building of buildings) {
    if (
      building.kind !== 'building' ||
      !BUILDING_LIGHTS[building.type] ||
      building.health <= 0 ||
      !(gate ? gate.allowed(building, false) : building.buildState === 'done') ||
      BUILDING_LIGHTS[building.type]!.every(
        (spec) => spec.activeAnim && !activeAnimLit(building, settings.nativeDetail),
      ) ||
      shrouded(building)
    )
      continue;
    const size = foundation(building.type);
    if (!size) continue;
    const specs = BUILDING_LIGHTS[building.type]!;
    const lights = buildingLightPlacements(building.type, building, size);
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index]!;
      const spec = specs[index]!;
      if (
        spec.activeAnim &&
        (!activeAnimLit(building, settings.nativeDetail) || (gate && !gate.allowed(building, true)))
      )
        continue;
      const night = Math.min(1, Math.max(0, settings.night ?? 0));
      const day = spec.day ?? 1;
      const daylight = day + (1 - day) * night;
      const glowDay = spec.glowDay ?? 1;
      const glowGain = glowDay + (1 - glowDay) * night;
      const gain =
        settings.sourceLights *
        daylight *
        (building.buildingDamaged || building.health < conditionYellow ? light.damaged : 1);
      if (!(gain > 0)) continue;
      const scale = (rgb: readonly [number, number, number], k = gain): [number, number, number] => [
        rgb[0] * k,
        rgb[1] * k,
        rgb[2] * k,
      ];
      light.fadeStart = gate?.fadeStart(building, spec.activeAnim === true);
      light.colour = scale(light.colour);
      light.glow = light.glow ? scale(light.glow, gain * glowGain) : null;
      out.push(light);
    }
  }
  return out;
}

function hashString(key: string): number {
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function buildingKey(building: Building): string {
  return String(building.uid ?? building.id ?? `${building.type}@${building.x},${building.y}`);
}

interface GateState {
  frame: number;
  undefinedFrames: number;
  blocked: boolean;
  allowed: boolean;
  born: number;
  animAllowed: boolean;
  animBorn: number;
}

function activeAnimLit(building: Building, nativeDetail: 'ignore' | 'mirror' = 'ignore'): boolean {
  return building.activeAnim !== 'none' && !(nativeDetail === 'mirror' && building.activeAnim === 'detail');
}

const onlyActiveAnimLights = (building: Building) =>
  BUILDING_LIGHTS[building.type]?.every((spec) => spec.activeAnim === true) ?? false;

/** Constructor sentinels must not flash before build-up; sandbox objects in the first snapshot are already present. */
export class BuildingLightGate {
  private first = true;
  private lastFrame = -Infinity;
  private readonly states = new Map<string, GateState>();
  private readonly seen = new Set<string>();

  update(
    buildings: readonly Building[],
    frame: number,
    now: number,
    nativeDetail: 'ignore' | 'mirror' = 'ignore',
  ): void {
    if (frame < this.lastFrame) {
      this.states.clear();
      this.first = true;
    }
    this.lastFrame = frame;
    this.seen.clear();
    for (const b of buildings) {
      if (b.kind !== 'building') continue;
      const key = buildingKey(b);
      this.seen.add(key);
      let state = this.states.get(key);
      const fresh = !state;
      if (!state) {
        state = {
          frame,
          undefinedFrames: 0,
          blocked: false,
          allowed: false,
          born: now,
          animAllowed: false,
          animBorn: now,
        };
        this.states.set(key, state);
        if (this.first && b.buildState === undefined) {
          state.allowed = true;
          state.born = now - (BUILDING_LIGHTS[b.type]?.[0]?.fadeIn ?? 0.25);
        }
      }
      const elapsed = Math.max(0, frame - state.frame);
      state.frame = frame;
      if (b.health <= 0 || b.buildState === 'building' || b.buildState === 'selling') {
        state.allowed = false;
        state.blocked = true;
        state.undefinedFrames = 0;
      } else if (b.buildState === 'done') {
        if (!state.allowed) state.born = now;
        state.allowed = true;
        state.undefinedFrames = 0;
      } else {
        state.undefinedFrames += state.undefinedFrames === 0 ? 1 : elapsed;
        if (!state.allowed && !state.blocked && state.undefinedFrames >= 30) {
          state.allowed = true;
          state.born = now;
        }
      }
      // Track ActiveAnim separately so an unrelated source on the same building retains its own fade.
      const animAllowed = state.allowed && activeAnimLit(b, nativeDetail);
      if (animAllowed && !state.animAllowed) state.animBorn = fresh ? state.born : now;
      state.animAllowed = animAllowed;
    }
    for (const key of this.states.keys()) if (!this.seen.has(key)) this.states.delete(key);
    this.first = false;
  }
  allowed(building: Building, activeAnim = onlyActiveAnimLights(building)): boolean {
    const state = this.states.get(buildingKey(building));
    return !!state?.allowed && (!activeAnim || state.animAllowed);
  }
  fadeStart(building: Building, activeAnim = onlyActiveAnimLights(building)): number | undefined {
    const state = this.states.get(buildingKey(building));
    return activeAnim ? state?.animBorn : state?.born;
  }
}

export interface BuildingLightCamera {
  right: Vector3;
  up: Vector3;
  toCamera: Vector3;
}

// Use the renderer's actual fixed projection, rather than maintaining a second set of yaw/pitch constants.
const fixedView = new IsoCamera();
fixedView.update();
const fixedCamera: BuildingLightCamera = {
  right: new Vector3().setFromMatrixColumn(fixedView.camera.matrixWorld, 0),
  up: new Vector3().setFromMatrixColumn(fixedView.camera.matrixWorld, 1),
  toCamera: new Vector3().setFromMatrixColumn(fixedView.camera.matrixWorld, 2),
};

type ScreenPoint = { x: number; y: number };
const TAU = Math.PI * 2;

function randomSequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Persistent slot phase; pair sampling freezes geometry without turning crawl into a reseeded random direction. */
export function filamentSlotAngle(key: string, slot: number, frame: number, crawl: number): number {
  // Golden-angle spacing prevents adjacent slot hashes from clustering all filaments on the same side of the glass.
  return (hashString(key) / 4294967296) * TAU + slot * Math.PI * (3 - Math.sqrt(5)) + frame * crawl;
}

function polar(radius: number, angle: number): ScreenPoint {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
function clampRadius(point: ScreenPoint, limit: number): ScreenPoint {
  const radius = Math.hypot(point.x, point.y);
  if (radius > limit) {
    point.x *= limit / radius;
    point.y *= limit / radius;
  }
  return point;
}
function lerpPoint(a: ScreenPoint, b: ScreenPoint, t: number): ScreenPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Rotate a whole filament/fork together so neither segments nor their glow can cross the painted tower wedge. */
function clearOccluders(paths: readonly ScreenPoint[][], orb: PlasmaOrb, radius: number, margin: number): boolean {
  const occluders = orb.occluders?.slice(0, 2).filter((o) => o.to > o.from) ?? [];
  if (occluders.length === 0) return true;
  const points = [...new Set(paths.flat())];
  const rotated = (p: ScreenPoint, angle: number): ScreenPoint => ({
    x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: p.x * Math.sin(angle) + p.y * Math.cos(angle),
  });
  const clear = (angle: number): boolean =>
    occluders.every((occluder) => {
      const distances = points.map((p) => {
        const q = rotated(p, angle);
        return orbOccluderDistances(q.x / radius, q.y / radius, occluder);
      });
      // One common separating edge keeps every connecting segment outside this convex wedge as well as its vertices.
      return [0, 1].some((edge) => distances.every((d) => d[edge]! < -margin / radius));
    });
  // Search both directions for the smallest safe rotation. Invalid/all-covering masks emit no hidden filaments.
  const steps = 128;
  for (let step = 0; step <= steps; step++) {
    for (const sign of [1, -1]) {
      const angle = (sign * step * Math.PI) / steps;
      if (!clear(angle)) continue;
      for (const p of points) Object.assign(p, rotated(p, angle));
      return true;
    }
  }
  return false;
}

/** Pure decorative policy: shapes reseed every two logic frames, presentation alpha and orb brightness remain live. */
export function buildingLightOverlay(
  lights: readonly BuildingLightPlacement[],
  frame: number,
  now: number,
  camera: BuildingLightCamera = fixedCamera,
): { discs: EmissiveDisc[]; strokes: EmissiveStroke[] } {
  const discs: EmissiveDisc[] = [];
  const strokes: EmissiveStroke[] = [];
  const pair = Math.floor(frame / 2);
  const pairFrame = pair * 2;
  for (const light of lights) {
    const orb = light.orb;
    const fade = light.fade ?? 1;
    if (!orb) continue;
    const hash = hashString(light.key);
    const push = (light.push ?? 0) + orb.radius * orbSilhouetteScale(orb);
    discs.push({
      centre: light.headPosition,
      orb,
      // Clear the owner's foundation-depth ridge; the explicit screen-space wedge restores the painted tower overlap.
      push,
      seed: light.seed ?? 0,
      alpha: fade,
      brightness: flicker(light.seed ?? 0, now, light.flicker),
    });
    const style = light.arcStyle;
    if (!style || fade <= 0.5) continue;
    const radius = orb.radius * PIXELS_PER_CELL_EDGE;
    const limit = radius + style.maxBeyond;
    const counts = randomSequence((hash ^ Math.imul(pair, 7919)) >>> 0);
    const count = ([min, max]: readonly [number, number]) => min + Math.floor(counts() * (max - min + 1));
    const filaments = count(style.filaments);
    const strikes = style.anchors.length > 0 ? count(style.strikes) : 0;
    for (let index = 0; index < filaments + strikes; index++) {
      const seed = (hash ^ Math.imul(pair, 7919) ^ Math.imul(index + 1, 104729)) >>> 0;
      const random = randomSequence(seed);
      const paths: ScreenPoint[][] = [];
      if (index < filaments) {
        const theta = filamentSlotAngle(light.key, index, pairFrame, style.crawl) + (random() * 2 - 1) * 0.3;
        const [startMin, startMax] = style.filamentStart ?? [0.12, 0.25];
        const r0 = (startMin + random() * (startMax - startMin)) * radius;
        const [endMin, endMax] = style.filamentEnd ?? [0.92, 0.985];
        const r1 = (endMin + random() * (endMax - endMin)) * radius;
        const forkEnd = Math.min(0.95, endMax) * radius;
        const twist = (random() * 2 - 1) * 0.35;
        const points: ScreenPoint[] = [];
        const vertices = 6 + Math.floor(random() * 4);
        for (let j = 0; j < vertices; j++) {
          const t = j / (vertices - 1);
          const angle = theta + twist * (t - 1);
          const p = polar(r0 + (r1 - r0) * t, angle);
          const jitter = (random() * 2 - 1) * 0.08 * radius * Math.sin(Math.PI * t);
          p.x -= Math.sin(angle) * jitter;
          p.y += Math.cos(angle) * jitter;
          points.push(clampRadius(p, 0.985 * radius));
        }
        paths.push(points);
        if (random() < 0.6) {
          const cumulative = [0];
          for (let j = 1; j < points.length; j++)
            cumulative.push(
              cumulative[j - 1]! + Math.hypot(points[j]!.x - points[j - 1]!.x, points[j]!.y - points[j - 1]!.y),
            );
          const total = cumulative.at(-1)!;
          const joints = cumulative.flatMap((d, j) => (d / total >= 0.55 && d / total <= 0.8 ? [j] : []));
          const joint = joints[Math.floor(random() * joints.length)];
          if (joint !== undefined) {
            const start = points[joint]!;
            const angle = theta + (random() < 0.5 ? -1 : 1) * (0.25 + random() * 0.25);
            const end = polar(forkEnd, angle);
            const delta = Math.atan2(
              Math.sin(Math.atan2(start.y, start.x) - angle),
              Math.cos(Math.atan2(start.y, start.x) - angle),
            );
            const middle = polar((Math.hypot(start.x, start.y) + forkEnd) / 2, angle + delta / 2);
            paths.push([start, clampRadius(middle, 0.985 * radius), end]);
          }
        }
        if (!clearOccluders(paths, orb, radius, (style.width * style.glowWidth) / 2)) continue;
      } else {
        const anchor = style.anchors[Math.floor(random() * style.anchors.length)]!;
        const angle = Math.atan2(anchor[1], anchor[0]);
        const start = polar(0.95 * radius, angle);
        const jitter = polar(random() * 2, random() * TAU);
        const end = clampRadius({ x: anchor[0] + jitter.x, y: anchor[1] + jitter.y }, limit);
        const spanAngle = Math.atan2(end.y - start.y, end.x - start.x);
        const points: ScreenPoint[] = [];
        const vertices = 5 + Math.floor(random() * 3);
        for (let j = 0; j < vertices; j++) {
          const t = j / (vertices - 1);
          const p = lerpPoint(start, end, t);
          const offset = (random() * 2 - 1) * 2.5 * Math.sin(Math.PI * t);
          p.x -= Math.sin(spanAngle) * offset;
          p.y += Math.cos(spanAngle) * offset;
          points.push(clampRadius(p, limit));
        }
        paths.push(points);
        if (random() < 0.4) {
          const joint = 1 + Math.floor(random() * (vertices - 2));
          const from = points[joint]!;
          const end = clampRadius({ x: from.x + (random() * 2 - 1) * 3, y: from.y + (random() * 2 - 1) * 3 }, limit);
          paths.push(random() < 0.5 ? [from, end] : [from, clampRadius(lerpPoint(from, end, 0.5), limit), end]);
        }
      }
      // Alpha changes with presentation time even while paused; geometry never depends on presentation time.
      const alpha = (0.7 + 0.3 * ((hashString(`${seed}:${Math.floor(now * 1000)}`) % 10000) / 9999)) * fade;
      const projected = new Map<ScreenPoint, Vector3>();
      for (let path = 0; path < paths.length; path++) {
        const points = paths[path]!.map((p) => {
          let world = projected.get(p);
          if (!world) {
            // Screen y points DOWN. Every vertex has zero view depth before the shader applies the shared push.
            world = light.headPosition
              .clone()
              .addScaledVector(camera.right, p.x / PIXELS_PER_CELL_EDGE)
              .addScaledVector(camera.up, -p.y / PIXELS_PER_CELL_EDGE);
            projected.set(p, world);
          }
          return world;
        });
        const width = path === 0 ? style.width : style.forkWidth;
        const stroke: EmissiveStroke = {
          points,
          width,
          core: style.core,
          edge: style.edge,
          alpha,
          coreFraction: style.coreFraction,
          push: push + 0.05,
        };
        // The glow starts at the first vertex outside glowStart, keeping at least the final segment so every bolt
        // still has its own glow directly underneath.
        const outside = paths[path]!.findIndex((p) => Math.hypot(p.x, p.y) >= (style.glowStart ?? 0) * radius);
        const glowFrom = Math.min(outside < 0 ? points.length - 2 : outside, points.length - 2);
        strokes.push({
          ...stroke,
          points: glowFrom > 0 ? points.slice(glowFrom) : points,
          width: width * style.glowWidth,
          core: style.edge,
          alpha: alpha * style.glowAlpha,
          coreFraction: 0,
        });
        strokes.push(stroke);
      }
    }
  }
  return { discs, strokes };
}
