import { Vector3 } from 'three/webgpu';
import type { EmissiveDisc, EmissiveStroke, OverlayRgb, PlasmaOrb } from '../emissiveOverlay';
import { flicker, SHAPE_LINEAR, SHAPE_POOL, SHAPE_SOFT, type SourceSpec } from '../lightField';
import { foundationPointPush } from '../ra2/cardDepth';
import { LEVEL_HEIGHT } from '../world';
import type { LiveObject } from './liveView';

export interface BuildingLightSpec {
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
  arcs: number;
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
  reach: readonly [number, number];
  crawl: number;
}

/** Colour-picker values are sRGB; the overlay attachment and post composite are display-linear. */
function displayLinear(r: number, g: number, b: number): OverlayRgb {
  const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return [linear(r), linear(g), linear(b)];
}

export const BUILDING_LIGHTS: Record<string, BuildingLightSpec[]> = {
  // The measured daytime pool lifted pavement L* 36 -> 53. Keep only a contained blue tint (day luma 0.173),
  // and present the saturated sphere/arcs after the grade so neither can feed bloom's lavender-white veil.
  NAPOWR: [
    {
      // The overlay orb must sit on the art's glass sphere (radius about 16.5 engine px): measured on the battle and
      // live-replay framings, [0.57, 0.40] put the disc about 6 engine px right of and 2.5 below the art's centre.
      at: [0.47, 0.4],
      height: 27,
      // Night value; by day only `day` of it (luminance about 0.17 of noon flat ground: measured +16 % luminance on the
      // grass beside two live reactors, the target's contained tint). At a third of this the night pool vanished
      // (pavement next to the reactors unchanged at hour 21).
      colour: [0.75, 2.1, 12.75],
      radius: 2.6,
      flicker: 0.12,
      day: 0.066,
      groundOnly: 1,
      glow: null,
      glowSize: 0,
      hole: false,
      damaged: 0.6,
      arcs: 5,
      falloff: 'soft',
      fadeIn: 0.5,
      orb: {
        // Cover the painted sphere while revealing its glass through a partially transparent body ring.
        radius: 0.55,
        // Cyan-white heat must pass through saturated cyan-blue, avoiding pale blue/lavender in the colour ramp.
        hot: displayLinear(205, 250, 255),
        mid: displayLinear(100, 200, 255),
        body: displayLinear(55, 115, 255),
        limb: displayLinear(110, 175, 255),
        filaments: displayLinear(165, 235, 255),
        halo: displayLinear(45, 95, 255),
        coreRadius: 0.42,
        bodyStart: 0.68,
        bodyEnd: 0.88,
        alpha: 1,
        coreAlpha: 1,
        bodyAlpha: 0.7,
        limbAlpha: 0.88,
        filamentMix: 0.75,
        haloAlpha: 0.4,
        haloScale: 1.4,
      },
      arcStyle: {
        core: displayLinear(210, 250, 255),
        edge: displayLinear(45, 110, 255),
        width: 3.2,
        forkWidth: 2.2,
        coreFraction: 0.45,
        reach: [0.5, 1.15],
        crawl: 0.4,
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
      arcs: 0,
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
      arcs: 0,
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
      arcs: 0,
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
      arcs: 0,
      falloff: 'pool',
      day: 0.1,
    },
  ],
};

type Building = Pick<LiveObject, 'type' | 'kind' | 'x' | 'y' | 'z' | 'health' | 'buildState' | 'buildingDamaged'> &
  Partial<Pick<LiveObject, 'uid' | 'id'>>;

export interface BuildingLightPlacement extends SourceSpec {
  key: string;
  groundY: number;
  headPosition: Vector3;
  damaged: number;
  arcs: number;
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
      arcs: spec.arcs,
      ttl: 0.6,
      seed: (hashString(`building:${building.uid ?? building.id ?? `${type}@${x0},${z0}`}:${index}`) % 1000) / 1000,
    };
  });
}

/** Per-frame source selection; disabled sources perform no library or visibility queries. */
export function buildingLightSources(
  buildings: readonly Building[],
  /** night: the renderer's lamp gain (0 by day, 1 at night) for lights with a `day` share below one. */
  settings: { sourceLights: number; night?: number },
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
      !(gate ? gate.allowed(building) : building.buildState === 'done') ||
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
      light.fadeStart = gate?.fadeStart(building);
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
}

/** Constructor sentinels must not flash before build-up; sandbox objects in the first snapshot are already present. */
export class BuildingLightGate {
  private first = true;
  private lastFrame = -Infinity;
  private readonly states = new Map<string, GateState>();
  private readonly seen = new Set<string>();

  update(buildings: readonly Building[], frame: number, now: number): void {
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
      if (!state) {
        state = { frame, undefinedFrames: 0, blocked: false, allowed: false, born: now };
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
    }
    for (const key of this.states.keys()) if (!this.seen.has(key)) this.states.delete(key);
    this.first = false;
  }
  allowed(building: Building): boolean {
    return this.states.get(buildingKey(building))?.allowed ?? false;
  }
  fadeStart(building: Building): number | undefined {
    return this.states.get(buildingKey(building))?.born;
  }
}

/** Extra depth pull of the arcs past the orb's own (world units). */
const ARC_PUSH = 0.8;
/** Width and opacity of the soft glow stroke drawn under each arc and fork. */
const ARC_GLOW_WIDTH = 3.5;
const ARC_GLOW_ALPHA = 0.5;

function screenDirection(direction: Vector3, toCamera?: Vector3): Vector3 {
  const cameraLengthSq = toCamera?.lengthSq() ?? 0;
  // Suppress view depth before normalising so outgoing glow starts at the silhouette, not over the core as an eye.
  if (toCamera && cameraLengthSq > 0) {
    direction.addScaledVector(toCamera, (-0.85 * direction.dot(toCamera)) / cameraLengthSq);
    const cameraLength = Math.sqrt(cameraLengthSq);
    const depth = direction.dot(toCamera) / cameraLength;
    // Nearly axial seeds can still exceed |dot| 0.5 after 85 % suppression; cap only those residual directions.
    if (Math.abs(depth) > direction.length() * 0.5) {
      direction.addScaledVector(toCamera, -depth / cameraLength);
      if (direction.lengthSq() < 1e-12) {
        if (toCamera.x !== 0 || toCamera.z !== 0) direction.set(-toCamera.z, 0, toCamera.x);
        else direction.set(1, 0, 0);
      }
      direction
        .normalize()
        .multiplyScalar(Math.sqrt(0.75))
        .addScaledVector(toCamera, (Math.sign(depth) * 0.5) / cameraLength);
    }
  }
  return direction.normalize();
}

/** Pure decorative policy: shapes reseed every two logic frames, presentation alpha and orb brightness remain live. */
export function buildingLightOverlay(
  lights: readonly BuildingLightPlacement[],
  frame: number,
  now: number,
  toCamera?: Vector3,
): { discs: EmissiveDisc[]; strokes: EmissiveStroke[] } {
  const discs: EmissiveDisc[] = [];
  const strokes: EmissiveStroke[] = [];
  for (const light of lights) {
    const orb = light.orb;
    const fade = light.fade ?? 1;
    if (!orb) continue;
    const hash = hashString(light.key);
    discs.push({
      centre: light.headPosition,
      orb,
      // The disc and its halo reach radius x haloScale round the head; with only the head's own pull the owner's
      // foundation depth (a wedge whose ridge is the front corner) cut a pie slice out of the right half of the orb.
      push: (light.push ?? 0) + orb.radius * orb.haloScale,
      seed: light.seed ?? 0,
      alpha: fade,
      brightness: flicker(light.seed ?? 0, now, light.flicker),
    });
    const style = light.arcStyle;
    if (!style || fade <= 0.5) continue;
    for (let index = 0; index < light.arcs; index++) {
      const seed = (hash ^ Math.imul(Math.floor(frame / 2), 7919) ^ Math.imul(index + 1, 104729)) >>> 0;
      let state = seed;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const angle = random() * Math.PI * 2;
      const down = -0.55 + 0.8 * random();
      const horizontal = Math.sqrt(1 - down * down);
      const dir = screenDirection(
        new Vector3(Math.cos(angle) * horizontal, down, Math.sin(angle) * horizontal),
        toCamera,
      );
      const centre = light.headPosition;
      const from = centre.clone().addScaledVector(dir, orb.radius);
      const crawling = Math.floor((index + 1) * style.crawl) > Math.floor(index * style.crawl);
      const distance = style.reach[0] + (style.reach[1] - style.reach[0]) * random();
      let to: Vector3;
      if (crawling) {
        const turn = (random() < 0.5 ? -1 : 1) * (0.9 + random());
        const down2 = Math.max(-0.7, Math.min(0.6, down + (random() - 0.5) * 0.9));
        const h2 = Math.sqrt(1 - down2 * down2);
        to = centre
          .clone()
          .addScaledVector(
            screenDirection(new Vector3(Math.cos(angle + turn) * h2, down2, Math.sin(angle + turn) * h2), toCamera),
            orb.radius * 1.12,
          );
      } else to = from.clone().addScaledVector(dir, distance);
      const points: Vector3[] = [];
      const count = 7 + Math.floor(random() * 4);
      const onGlass = (p: Vector3): Vector3 =>
        crawling
          ? p
              .sub(centre)
              .normalize()
              .multiplyScalar(orb.radius * 1.04)
              .add(centre)
          : p;
      for (let j = 0; j < count; j++) {
        const p = from.clone().lerp(to, j / (count - 1));
        if (j > 0 && j < count - 1)
          p.add(new Vector3((random() - 0.5) * 0.1, (random() - 0.5) * 0.1, (random() - 0.5) * 0.1));
        points.push(onGlass(p));
      }
      // Alpha changes with presentation time even while paused; geometry never depends on presentation time.
      const alpha = (0.7 + 0.3 * ((hashString(`${seed}:${Math.floor(now * 1000)}`) % 10000) / 9999)) * fade;
      const stroke = (points: Vector3[], width: number): EmissiveStroke => ({
        points,
        width,
        core: style.core,
        edge: style.edge,
        alpha,
        coreFraction: style.coreFraction,
        // Arcs strike the pads and towers in front of the orb: pull them further towards the camera than the orb so the
        // reactor's own tower cards do not swallow them (units standing in front stay nearer still).
        push: (light.push ?? 0) + ARC_PUSH,
      });
      // A wide, faint saturated glow under each crisp bolt: the electric halo the bloom used to add (as lavender haze).
      strokes.push({
        ...stroke(points, style.width * ARC_GLOW_WIDTH),
        core: style.edge,
        alpha: alpha * ARC_GLOW_ALPHA,
        coreFraction: 0,
      });
      strokes.push(stroke(points, style.width));
      const cumulative = [0];
      for (let j = 1; j < points.length; j++)
        cumulative.push(cumulative[j - 1]! + points[j]!.distanceTo(points[j - 1]!));
      const total = cumulative[cumulative.length - 1]!;
      const joints = cumulative.flatMap((length, j) => (length / total >= 0.3 && length / total <= 0.5 ? [j] : []));
      const forks = 1 + Math.floor(random() * 2);
      for (let f = 0; f < forks; f++) {
        const joint = joints[Math.floor(random() * joints.length)] ?? Math.round(0.4 * (count - 1));
        const start = points[joint]!;
        const end = start
          .clone()
          .add(new Vector3((random() - 0.5) * 0.28, -0.08 - random() * 0.16, (random() - 0.5) * 0.28));
        const fork = [
          start,
          onGlass(
            start
              .clone()
              .lerp(end, 0.5)
              .add(new Vector3((random() - 0.5) * 0.1, (random() - 0.5) * 0.1, (random() - 0.5) * 0.1)),
          ),
          onGlass(end),
        ];
        strokes.push({
          ...stroke(fork, style.forkWidth * ARC_GLOW_WIDTH),
          core: style.edge,
          alpha: alpha * ARC_GLOW_ALPHA,
          coreFraction: 0,
        });
        strokes.push(stroke(fork, style.forkWidth));
      }
    }
  }
  return { discs, strokes };
}
