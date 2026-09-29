/**
 * RenderState: the versioned, base-agnostic snapshot the HD renderer consumes.
 *
 * Any game base (RA2 VM memory bridge, a reimplementation such as vera20k, or the procedural sandbox) produces this
 * shape; the renderer never reads engine internals. Coordinates use map cells on the ground plane (x east along the
 * map's X axis, y south along its Y axis) and RA2 height levels for elevation, so adapters can pass through native
 * cell/lepton positions after a single division. The renderer converts to world units in one place (see world.ts).
 */
export const RENDER_STATE_VERSION = 1;

export type Theater = 'temperate' | 'snow' | 'urban' | 'desert' | 'lunar' | 'newurban';

/** Surface class of a cell; drives material selection before any HD tile art exists. */
export type TerrainClass = 'clear' | 'rough' | 'road' | 'pavement' | 'rock' | 'beach' | 'water' | 'cliff';

/** Map-wide lighting as stored in the map's [Lighting] section (palette-domain values, not physical units). */
export interface MapLighting {
  ambient: number;
  level: number;
  red: number;
  green: number;
  blue: number;
  ground: number;
}

/**
 * How a presenter stages a map by default (structurally the same as ra2-assets' AtmosphereProfile, derived from the
 * map's own [Lighting]; the contract stays base-agnostic).
 */
export interface AtmosphereProfile {
  kind: 'day' | 'dusk' | 'night';
  /** Default hour of day. */
  hour: number;
  /** Unlit flat ground at night as a fraction of clear noon, in linear light. */
  nightLevel: number;
  /** The map's light tint normalised by its largest channel. */
  tint: [r: number, g: number, b: number];
}

export interface RenderMap {
  /** Width/height in cells. */
  width: number;
  height: number;
  theater: Theater;
  /** Corner heights in height levels, (width + 1) * (height + 1) entries, row-major by y. */
  cornerHeights: Float32Array;
  /** One entry per cell, row-major by y. */
  terrain: TerrainClass[];
  /** Water surface elevation in height levels. */
  waterLevel: number;
  lighting: MapLighting;
  /** Default staging; absent = day at noon with the default night level. */
  atmosphere?: AtmosphereProfile;
}

export type ObjectKind = 'vehicle' | 'infantry' | 'building' | 'aircraft' | 'ship' | 'tree';

export interface RenderObject {
  /** Stable across snapshots so the renderer can interpolate and keep per-object effects. */
  id: number;
  kind: ObjectKind;
  /** Rules/art type id, e.g. "MTNK" or "GAPOWR". */
  type: string;
  /** Owner palette slot (0-7); -1 for neutral. */
  house: number;
  /** Cell-space position; z in height levels. */
  x: number;
  y: number;
  z: number;
  /** Body facing in radians, continuous (not the 32-step voxel quantisation). 0 = map north-east, clockwise. */
  facing: number;
  turretFacing?: number;
  /** 0..1 */
  health: number;
  /** Building footprint in cells (buildings only). */
  footprint?: { width: number; height: number };
}

export type RenderEventKind = 'explosion' | 'muzzle' | 'impact';

export interface RenderEvent {
  /** Unique per event so replays or renderer switches never spawn an effect twice. */
  id: number;
  tick: number;
  kind: RenderEventKind;
  /** Warhead/animation id, e.g. "EXPLOLRG". */
  type: string;
  x: number;
  y: number;
  z: number;
  /** Relative size, 1 = medium explosion. */
  scale: number;
}

export type Weather = 'clear' | 'rain' | 'storm' | 'snow';

export interface RenderEnvironment {
  /** Hours, 0..24. Purely presentational: the simulation has no day/night. */
  timeOfDay: number;
  weather: Weather;
  /** 0..1 */
  weatherIntensity: number;
  /** Wind direction in radians (map space) and strength 0..1. */
  windDirection: number;
  windStrength: number;
}

export interface RenderState {
  version: typeof RENDER_STATE_VERSION;
  /** Simulation frame of this snapshot. */
  tick: number;
  map: RenderMap;
  objects: RenderObject[];
  /** Events raised since the previous snapshot. */
  events: RenderEvent[];
  environment: RenderEnvironment;
}

export const HOUSE_COLORS: readonly number[] = [
  0xd8b02a, 0x1f63d6, 0xc42424, 0x2aa84a, 0xe07a1f, 0x3ab8c8, 0x9b3fc9, 0xd84aa0,
];
