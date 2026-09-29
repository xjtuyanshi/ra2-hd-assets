import {
  engineLightDelta,
  nightBaseAmbient,
  type CellGrid,
  type EngineLight,
  type EngineLighting,
} from '../../../ra2-assets/src/lights';
import type { AtmosphereProfile } from '../contract';
import { SHAPE_POOL, type LightEntry, type LightField } from '../lightField';

/** How the engine's light sources are presented: footprint, falloff and strength, and whether they follow the night. */
export interface MapLightStaging {
  /** Share of each source's LightVisibility the light reaches. */
  radiusScale: number;
  /** Falloff exponent on the engine's linear 1 - d (1 = the engine). */
  falloffPower: number;
  /** Share of the engine's light the light field adds. */
  gain: number;
  /** True: the light fades in with the night (static gain); false: always on, as the engine applies it. */
  followsNight: boolean;
  /** Where the engine formula is evaluated: the night ambient, or the map's own [Lighting] ambient. */
  ambient: 'night' | 'map';
}

/**
 * A map built as a night map: its lamps and NEGLAMP darkening exactly as the engine applies them (full LightVisibility,
 * linear falloff, full strength) at its own night ambient. The mapper tuned these for that formula.
 */
export const NIGHT_MAP_STAGING: MapLightStaging = {
  radiusScale: 1,
  falloffPower: 1,
  gain: 1,
  followsNight: true,
  ambient: 'night',
};
/**
 * A dusk map: the engine applies its light sources at all times, so they show at full engine strength at the map's
 * own ambient whatever the hour (the dusk lamps and NEGLAMP shading are part of the map's look, not night dressing).
 */
export const DUSK_MAP_STAGING: MapLightStaging = {
  radiusScale: 1,
  falloffPower: 1,
  gain: 1,
  followsNight: false,
  ambient: 'map',
};
/**
 * A day map forced to night (HD presentation): each source becomes a pool around its post instead of the engine's
 * block-wide wash, with the unlit ground between posts near the moonlit night level (concept C). The engine's 1 - d
 * falloff over the full radius (4000 leptons, 15.6 cells, for INGALITE) lit XMP29U2's whole park to 0.77 of noon.
 * Pool: 0.45 x LightVisibility with a squared falloff at 0.8 of the engine's strength. For INGALITE on XMP29U2 (moon
 * alone 0.345 of noon) that is about 3.1x the moonlit ground at the post, 1.5x three cells out, 1.1x at five and
 * nothing past seven, so the park's seven posts light separate pools with dark lawn between them.
 */
export const FORCED_NIGHT_STAGING: MapLightStaging = {
  radiusScale: 0.45,
  falloffPower: 2,
  gain: 0.8,
  followsNight: true,
  ambient: 'night',
};

/** The staging of a map's light sources for its atmosphere profile. */
export function mapLightStaging(profile: Pick<AtmosphereProfile, 'kind'>): MapLightStaging {
  if (profile.kind === 'night') return NIGHT_MAP_STAGING;
  if (profile.kind === 'dusk') return DUSK_MAP_STAGING;
  return FORCED_NIGHT_STAGING;
}

/** A light source as the dressing tracks it (a map [Structures] entry or a live building). */
export interface SourceLight extends EngineLight {
  type: string;
  cell: [x: number, y: number];
  z: number;
  foundation: [w: number, h: number];
  /** InvisibleInGame: never drawn (INGALITE) and so without a visible lamp head. */
  invisible: boolean;
}

/**
 * The map's own light sources, lit like the engine (engineLightDelta: the per-cell formula of YR 1.001) and handed to
 * the light field's base grid, staged by the map's atmosphere profile (mapLightStaging). The grid is recomputed only
 * when the sources, the profile or `enabled` change (a few milliseconds on the CPU). Visible lamp types (not
 * InvisibleInGame, e.g. GALITE) also get a tight pool under their head.
 */
export class MapLights {
  private sources: SourceLight[] = [];
  /** Bumped by setSources; update() recomputes when it, the profile or `enabled` changed (no per-frame keys). */
  private version = 0;
  private built: { version: number; nightLevel: number; kind: string; enabled: boolean } | null = null;
  private readonly grid: CellGrid;

  constructor(
    grid: CellGrid,
    private readonly lighting: EngineLighting,
    private readonly medianZ: number,
  ) {
    this.grid = grid;
  }

  get count(): number {
    return this.sources.length;
  }

  /** Replace the sources (live matches: whenever the set of light-emitting buildings changes). */
  setSources(sources: readonly SourceLight[]): void {
    this.sources = [...sources];
    this.version++;
  }

  /** Recompute the base grid if the sources or the profile changed; `enabled` false clears it. */
  update(lightField: LightField, profile: AtmosphereProfile, reference: number, enabled: boolean): void {
    const built = this.built;
    if (
      built &&
      built.version === this.version &&
      built.enabled === enabled &&
      (!enabled || (built.nightLevel === profile.nightLevel && built.kind === profile.kind))
    )
      return;
    this.built = { version: this.version, nightLevel: profile.nightLevel, kind: profile.kind, enabled };
    if (!enabled || this.sources.length === 0) {
      lightField.setBase(null);
      return;
    }
    const staging = mapLightStaging(profile);
    const { level, ground } = this.lighting;
    // The cell formula adds Level x z and subtracts Ground itself; the night ambient is defined at the median height.
    const ambient =
      staging.ambient === 'map' ? this.lighting.ambient : nightBaseAmbient(profile) - (level * this.medianZ - ground);
    const sources =
      staging.radiusScale === 1
        ? this.sources
        : this.sources.map((s) => ({ ...s, radius: s.radius * staging.radiusScale }));
    const delta = engineLightDelta(this.grid, this.lighting, sources, ambient, staging.falloffPower);
    lightField.setBase(delta, staging.gain * reference, staging.followsNight);
  }

  /** Tight pools under visible lamp posts (their heads are drawn by the night dressing). */
  visiblePools(reference: number): LightEntry[] {
    return this.sources
      .filter((s) => !s.invisible && s.intensity > 0)
      .map((s) => {
        const tint = s.tint.map((c) => Math.min(1.5, Math.max(0, c)) + 0.25);
        const max = Math.max(...tint, 1e-6);
        const peak = reference * 1.2;
        return {
          x: s.position[0] / 256,
          z: s.position[1] / 256,
          radius: 2.2,
          shape: SHAPE_POOL,
          colour: [(tint[0]! / max) * peak, (tint[1]! / max) * peak, (tint[2]! / max) * peak] as const,
        };
      });
  }

  visibleSources(): SourceLight[] {
    return this.sources.filter((s) => !s.invisible && s.intensity > 0);
  }

  /**
   * Lamp-post dummies: invisible light sources with a positive intensity (INGALITE, INYELWLAMP ...). The engine never
   * draws them; with HD lamps enabled the night dressing gives each an HD post and head, so its light has a source.
   */
  lampPostDummies(): SourceLight[] {
    return this.sources.filter((s) => s.invisible && s.intensity > 0);
  }
}
