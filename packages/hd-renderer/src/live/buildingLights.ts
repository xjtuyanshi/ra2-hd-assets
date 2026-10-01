import { Vector3 } from 'three/webgpu';
import type { BeamSpec } from '../effects';
import type { SourceSpec } from '../lightField';
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
}

export const BUILDING_LIGHTS: Record<string, BuildingLightSpec[]> = {
  // Soviet Tesla reactor: the active NAPOWR_A orb, with the foundation excluded from its blue pool.
  NAPOWR: [
    {
      at: [0.5, 0.5],
      height: 44,
      colour: [0.35, 0.75, 2.6],
      radius: 3.6,
      flicker: 0.3,
      glow: [0.9, 1.6, 4.0],
      glowSize: 1.5,
      hole: true,
      damaged: 0.6,
      arcs: 3,
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
      const down = -0.15 - 0.5 * random();
      const horizontal = Math.sqrt(1 - down * down);
      const distance = 0.5 + 0.6 * random();
      const from = light.headPosition.clone();
      // Match the glow's depth pull; shifting along the view direction preserves its screen position.
      const push = light.push ?? 0;
      from.add(new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8)).multiplyScalar(push));
      const to = from
        .clone()
        .add(new Vector3(Math.cos(angle) * horizontal, down, Math.sin(angle) * horizontal).multiplyScalar(distance));
      out.push({
        from,
        to,
        colour: new Vector3(Math.pow(82 / 255, 2.2), Math.pow(80 / 255, 2.2), 1),
        bolt: true,
        seed,
        flash: false,
      });
    }
  }
  return out;
}
