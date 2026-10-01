import { Vector3 } from 'three/webgpu';
import type { BeamSpec } from '../effects';
import { SHAPE_LINEAR, SHAPE_POOL, type SourceSpec } from '../lightField';
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
  falloff?: 'wide' | 'pool';
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

export const BUILDING_LIGHTS: Record<string, BuildingLightSpec[]> = {
  // Soviet Tesla reactor: the active NAPOWR_A orb, with the foundation excluded from its blue pool.
  NAPOWR: [
    {
      // The orb hangs a little right of and behind the foundation centre (XMP29U2 bench at zoom 2: the head lands on
      // the orb's centre with at [0.57, 0.40] and 29 px); the pool around it is too small to notice the offset.
      at: [0.57, 0.4],
      height: 29,
      // The target's ground light (battle framing, L*a*b* rings around the orb at the bench scale) is an electric blue
      // next to the base that fades out about two cells away. The light's colour sets the hue on grey asphalt: a pure
      // deep blue ([0.3, 1.6, 24]) tone-mapped to dark navy and bloomed into a lavender veil over the whole base, a
      // cornflower blue (about the target's lit asphalt, linear 0.08 : 0.26 : 1) reads as light, not paint.
      colour: [1.8, 6.0, 24],
      radius: 3.5,
      flicker: 0.3,
      // The orb glass and the reactor's facades take none of the pool (they sample the ground in front of the art and
      // turned dark pure blue, L* 36 for a white orb); the ground, the pads, units and neighbours do.
      groundOnly: 1,
      // A white-hot head about the orb's size over the sprite's own lit glass: near-white, so the tone mapper keeps it
      // bright (a saturated blue head drew a flat blue disc), and modest, so the bloom stays a halo instead of hazing the
      // towers (rings at the bench: orb L* 87-89, b* -11 to -15; target 98, -2).
      glow: [1.0, 1.1, 1.4],
      glowSize: 0.8,
      glowCore: 0.55,
      glowHot: 1.0,
      hole: true,
      damaged: 0.6,
      arcs: 6,
      // Compact pool measured from the foundation's edge (see LightField holes): a linear falloff from the centre
      // washed the concrete three cells away lavender.
      falloff: 'pool',
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
      x,
      z,
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
      shape: spec.falloff === 'wide' ? SHAPE_LINEAR : SHAPE_POOL,
      groundOnly: spec.groundOnly,
      hole: spec.hole ? [w / 2, h / 2] : undefined,
      holeOffset: spec.hole ? [w / 2 - lx, h / 2 - lz] : undefined,
      // Clear the owner's facade depth without moving the head on screen (fixed orthographic camera).
      push: foundationPointPush(lx, lz, w, h) + (spec.push ?? 0.15),
      damaged: spec.damaged,
      arcs: spec.arcs,
      ttl: 0.6,
    };
  });
}

/**
 * Gain of a building light standing in cells the engine's own light sources already brighten (map lamp posts such as
 * INGALITE: radius about 15 cells, +50 % at the post, by day too). `engineLight` is the engine's weighted object light
 * multiplier at the source (1 = plain map light). The source lights are calibrated on plainly lit ground; on lamp-lit
 * ground the same pool clipped into a lavender-white veil over a Tesla reactor and its neighbours in live matches
 * (L5 compose, XMP29U2 next to a lamp dummy), so the gain falls with the square of the extra engine light.
 */
export function lampLitGain(engineLight: number): number {
  if (!(engineLight > 1)) return 1;
  return Math.max(0.35, 1 / (engineLight * engineLight));
}

/** Per-frame source selection; disabled sources perform no library or visibility queries. */
export function buildingLightSources(
  buildings: readonly Building[],
  /** night: the renderer's lamp gain (0 by day, 1 at night) for lights with a `day` share below one. */
  settings: { sourceLights: number; night?: number },
  foundation: (type: string) => readonly [number, number] | undefined,
  shrouded: (building: Building) => boolean,
  conditionYellow = 0.5,
): BuildingLightPlacement[] {
  if (!(settings.sourceLights > 0)) return [];
  const out: BuildingLightPlacement[] = [];
  for (const building of buildings) {
    if (
      building.kind !== 'building' ||
      !BUILDING_LIGHTS[building.type] ||
      building.health <= 0 ||
      (building.buildState !== undefined && building.buildState !== 'done') ||
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
      light.colour = scale(light.colour);
      light.glow = light.glow ? scale(light.glow, gain * glowGain) : null;
      out.push(light);
    }
  }
  return out;
}

/** Radius of the NAPOWR orb in world units (about 17 engine px at the bench's zoom). */
const ORB_RADIUS = 0.28;

/**
 * Decorative arc style: radiance at night and in full daylight (linear RGB, see buildingLightArcs), the reach of the
 * outgoing arcs past the orb's surface (world units) and the share of arcs that crawl over the glass instead.
 */
export const ARC_STYLE = {
  night: [0.15, 0.35, 3.2] as [number, number, number],
  // By day a modest blue: brighter arcs bloomed into a white band across the towers that hid the strokes themselves.
  day: [0.25, 0.45, 1.4] as [number, number, number],
  reach: [0.35, 0.8] as [number, number],
  crawl: 0.4,
};

/**
 * Short decorative arcs, stable for pairs of logic frames; they never spawn impact flashes or particles. `night` is the
 * renderer's lamp gain (0 by day, 1 at night) blending ARC_STYLE.day into ARC_STYLE.night. By day the bloom decides how
 * they read: a saturated bright blue ([0.6, 1.1, 9]) tone-mapped to dark lines inside a lavender haze and a white one
 * ([2, 2.4, 4]) to a white fog band, while a modest blue keeps thin bright strokes with a small halo.
 */
export function buildingLightArcs(lights: readonly BuildingLightPlacement[], frame: number, night = 1): BeamSpec[] {
  const out: BeamSpec[] = [];
  const k = Math.min(1, Math.max(0, night));
  const { day, night: dark, reach, crawl } = ARC_STYLE;
  const colour = new Vector3(
    day[0] + (dark[0] - day[0]) * k,
    day[1] + (dark[1] - day[1]) * k,
    day[2] + (dark[2] - day[2]) * k,
  );
  for (const light of lights) {
    let hash = 2166136261;
    for (const c of light.key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    for (let index = 0; index < light.arcs; index++) {
      const seed = (hash ^ Math.imul(Math.floor(frame / 2), 7919) ^ Math.imul(index + 1, 104729)) >>> 0;
      let state = seed;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const angle = random() * Math.PI * 2;
      // Arcs leave the orb's surface (not its centre, which drew a net of lines across the glass) in every direction
      // but straight up. Even arcs strike the pad, the towers or the air around it; odd ones crawl over the glass to
      // another surface point, the tangle of discharges the target wraps round the sphere.
      const down = -0.55 + 0.8 * random();
      const horizontal = Math.sqrt(1 - down * down);
      const distance = reach[0] + (reach[1] - reach[0]) * random();
      const dir = new Vector3(Math.cos(angle) * horizontal, down, Math.sin(angle) * horizontal);
      const centre = light.headPosition.clone();
      // Match the glow's depth pull; shifting along the view direction preserves its screen position.
      const push = light.push ?? 0;
      centre.add(new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8)).multiplyScalar(push));
      const from = centre.clone().addScaledVector(dir, ORB_RADIUS);
      let to: Vector3;
      // Crawling arcs are spread evenly over the indices (crawl 0.5: every odd arc).
      if (Math.floor((index + 1) * crawl) > Math.floor(index * crawl)) {
        const turn = (random() < 0.5 ? -1 : 1) * (0.9 + random());
        const down2 = Math.max(-0.7, Math.min(0.6, down + (random() - 0.5) * 0.9));
        const h2 = Math.sqrt(1 - down2 * down2);
        const dir2 = new Vector3(Math.cos(angle + turn) * h2, down2, Math.sin(angle + turn) * h2);
        to = centre.clone().addScaledVector(dir2, ORB_RADIUS * 1.12);
      } else {
        to = from.clone().addScaledVector(dir, distance);
      }
      out.push({
        from,
        to,
        // Deep blue like the orb: the bolt shader's own white core and violet fringe would otherwise wash it lavender.
        colour: colour.clone(),
        bolt: true,
        seed,
        flash: false,
      });
    }
  }
  return out;
}
