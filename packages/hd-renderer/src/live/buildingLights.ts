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
  hole: boolean;
  damaged: number;
  arcs: number;
  /** Ground falloff: 'wide' reaches beyond a large hole (SHAPE_LINEAR), 'pool' is the compact fire pool. */
  falloff?: 'wide' | 'pool';
}

export const BUILDING_LIGHTS: Record<string, BuildingLightSpec[]> = {
  // Soviet Tesla reactor: the active NAPOWR_A orb, with the foundation excluded from its blue pool.
  NAPOWR: [
    {
      // The orb hangs a little right of and behind the foundation centre (XMP29U2 bench at zoom 2: the head lands on
      // the orb's centre with at [0.57, 0.40] and 29 px); the pool around it is too small to notice the offset.
      at: [0.57, 0.4],
      height: 29,
      // Strong enough to read on dark asphalt in full sun (the target's blue pool); the concrete pad around a base
      // takes about twice the asphalt's share and still stays below white.
      colour: [0.3, 1.0, 12],
      radius: 4.5,
      flicker: 0.3,
      // A head about the orb's own size: a wider quad hazed the left tower white-blue.
      glow: [0.5, 1.2, 4.0],
      glowSize: 0.9,
      hole: true,
      damaged: 0.6,
      arcs: 3,
      // Compact pool measured from the foundation's edge (see LightField holes): a linear falloff from the centre
      // washed the concrete three cells away lavender.
      falloff: 'pool',
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
      shape: spec.falloff === 'wide' ? SHAPE_LINEAR : SHAPE_POOL,
      hole: spec.hole ? [w / 2, h / 2] : undefined,
      holeOffset: spec.hole ? [w / 2 - lx, h / 2 - lz] : undefined,
      // Clear the owner's facade depth without moving the head on screen (fixed orthographic camera).
      push: foundationPointPush(lx, lz, w, h) + 0.15,
      damaged: spec.damaged,
      arcs: spec.arcs,
      ttl: 0.6,
    };
  });
}

/** Per-frame source selection; disabled sources perform no library or visibility queries. */
export function buildingLightSources(
  buildings: readonly Building[],
  settings: { sourceLights: number },
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
    for (const light of buildingLightPlacements(building.type, building, size)) {
      const gain =
        settings.sourceLights * (building.buildingDamaged || building.health < conditionYellow ? light.damaged : 1);
      const scale = (rgb: readonly [number, number, number]): [number, number, number] => [
        rgb[0] * gain,
        rgb[1] * gain,
        rgb[2] * gain,
      ];
      light.colour = scale(light.colour);
      light.glow = light.glow ? scale(light.glow) : null;
      out.push(light);
    }
  }
  return out;
}

/** Radius of the NAPOWR orb in world units (about 17 engine px at the bench's zoom). */
const ORB_RADIUS = 0.28;

/** Short decorative arcs, stable for pairs of logic frames; they never spawn impact flashes or particles. */
export function buildingLightArcs(lights: readonly BuildingLightPlacement[], frame: number): BeamSpec[] {
  const out: BeamSpec[] = [];
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
      // but straight up, and strike the pad, the towers or the air around it.
      const down = -0.55 + 0.8 * random();
      const horizontal = Math.sqrt(1 - down * down);
      const distance = 0.35 + 0.5 * random();
      const dir = new Vector3(Math.cos(angle) * horizontal, down, Math.sin(angle) * horizontal);
      const from = light.headPosition.clone();
      // Match the glow's depth pull; shifting along the view direction preserves its screen position.
      const push = light.push ?? 0;
      from.add(new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8)).multiplyScalar(push));
      from.addScaledVector(dir, ORB_RADIUS);
      const to = from.clone().addScaledVector(dir, distance);
      out.push({
        from,
        to,
        // Brighter than the weapon bolt's palette blue so the white-hot core reads in daylight next to the orb.
        colour: new Vector3(0.16, 0.2, 1.6),
        bolt: true,
        seed,
        flash: false,
      });
    }
  }
  return out;
}
