/**
 * Map light sidecar (`<map>/lights.json`, written by `pnpm hd:lights`): the map's scene lighting and its light sources
 * exactly as Yuri's Revenge 1.001 reads and applies them, plus the HD-only dressing derived from them (surface classes,
 * street lamp spots). Browser-safe and pure: node/lights.ts reads the install and writes the file, renderers read it.
 * The sidecar is derived from the player's own game files and stays in the gitignored gameres/.
 *
 * Engine behaviour encoded here comes from disassembling the player's gamemd.exe (YR 1.001); addresses and the
 * night-map table are recorded in docs/remaster/research/yr-scene-lighting.md:
 *   - ScenarioClass::ReadLighting @0x68A7F8..0x68AC9A reads [Lighting] with the CRT's atof on the leading numeric
 *     prefix ("0,01" reads 0) and stores Ambient/Red/Green/Blue as int(v * 100 + 0.01) percent and Ground/Level as
 *     int(v * 1000 + 0.01) per-mille (x87 _ftol truncates). Missing keys keep the ScenarioClass constructor defaults
 *     (@0x6838D3..0x683997).
 *   - BuildingTypeClass reads LightVisibility (int, default 5000 leptons), LightIntensity and Light{Red,Green,Blue}Tint
 *     as int(v * 1000 + 0.1) (@0x460C8C..0x460DC4). The constructor (@0x45DE12) leaves the tints at 1000.0 (a
 *     per-mille value of 1000000), which is kept as is.
 *   - A building creates a LightSourceClass only when LightIntensity != 0 (@0x440D6C / @0x4466D5), centred on its
 *     foundation at (256x + 128w, 256y + 128h, 104z) leptons.
 *   - Per cell (@0x484180) every light within LightVisibility adds intensity and tint with a linear 2D falloff (the
 *     light's height is ignored); Ground is subtracted and Level x z added; the tint is normalised by its largest
 *     channel (@0x5558E0). engineCellLight ports this in integer per-mille arithmetic.
 */

export const MAP_LIGHTS_VERSION = 1;

/** Scene lighting in the engine's stored precision (Ambient/RGB in 1/100, Ground/Level in 1/1000). */
export interface EngineLighting {
  ambient: number;
  red: number;
  green: number;
  blue: number;
  ground: number;
  level: number;
}

export interface MapLightingSet {
  normal: EngineLighting;
  ionStorm: EngineLighting;
  dominator: EngineLighting & { ambientChangeRate: number };
  /** INI keys that were missing and took the engine's constructor default. */
  defaulted: string[];
}

/** A BuildingType's light (values in the engine's stored precision, 1/1000). */
export interface LightType {
  /** LightVisibility in leptons (256 per cell). */
  radius: number;
  intensity: number;
  tint: [r: number, g: number, b: number];
  /** rules InvisibleInGame=yes: the engine never draws the building (lamp post dummies such as INGALITE). */
  invisible: boolean;
  /** Art section the type's art comes from (rules Image=, else the id). */
  image: string;
  foundation: [w: number, h: number];
}

/** One light source the map places (a [Structures] entry whose type has LightIntensity != 0). */
export interface MapLightSource {
  type: string;
  /** Index of the entry in the map's [Structures] section. */
  structureIndex: number;
  /** Index into manifest.objects of the same building, when the map extractor exported it. */
  objectIndex?: number;
  owner: string;
  cell: [x: number, y: number];
  /** Cell height level. */
  z: number;
  foundation: [w: number, h: number];
  /** Light centre in leptons: (256x + 128w, 256y + 128h, 104z). */
  position: [x: number, y: number, z: number];
  radius: number;
  intensity: number;
  tint: [r: number, g: number, b: number];
  invisible: boolean;
}

/** TerrainType light keys (TIBTRE* ore trees): recorded for reference, YR creates no light for them. */
export interface InertLight {
  type: string;
  cell: [x: number, y: number];
  z: number;
  radius: number;
  intensity: number;
  tint: [r: number, g: number, b: number];
}

/** How a renderer stages a map by default: its mood, hour and night brightness (see mapAtmosphere). */
export interface AtmosphereProfile {
  kind: 'day' | 'dusk' | 'night';
  /** Default hour of day for the renderer's light keys. */
  hour: number;
  /** Unlit flat ground at night as a fraction of clear noon, in linear light. */
  nightLevel: number;
  /** The map's [Lighting] tint normalised by its largest channel. */
  tint: [r: number, g: number, b: number];
}

/** Per-cell surface class for wetness and HD dressing. */
export const SURFACE = { none: 0, soft: 1, paved: 2, road: 3, water: 4, rock: 5 } as const;
export type SurfaceClass = (typeof SURFACE)[keyof typeof SURFACE];

export interface StreetLamp {
  cell: [x: number, y: number];
  z: number;
}

export interface MapLightsSidecar {
  version: typeof MAP_LIGHTS_VERSION;
  /** Cache directory id (e.g. "XMP29U2"). */
  map: string;
  /** Map file the lights were read from (as recorded in the manifest). */
  source: string;
  theater: string;
  lighting: MapLightingSet;
  atmosphere: AtmosphereProfile;
  /** Every BuildingType with LightIntensity != 0 (the map's own sections override rulesmd.ini), by type id. */
  types: Record<string, LightType>;
  lights: MapLightSource[];
  inertLights: InertLight[];
  /** manifest.objects indices whose type is InvisibleInGame=yes: the engine never draws them. */
  hiddenObjects: number[];
  cells: {
    /** base64 Uint8 SurfaceClass per cell (grid order, row-major by y). */
    surface: string;
    /** Median height level over the map's cells. */
    medianZ: number;
  };
  /** HD-only additions derived from the map (not in the original); renderers may switch them off. */
  hdEmitters: {
    streetLamps: StreetLamp[];
    policy: { spacing: number; theaters: string[] };
  };
  extractor: { tool: 'ra2-assets lights'; manifestSha256: string; warnings: string[] };
}

// ------------------------------------------------------------------ number parsing and storage

/** CRT atof on the leading numeric prefix, as the engine's INI double reader: "0,01" -> 0, ".5" -> 0.5. */
export function parseEngineDouble(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(raw);
  return m ? Number.parseFloat(m[0]) : 0;
}

/** CRT atoi on the leading integer prefix; 0 when there is none. */
export function parseEngineInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*[+-]?\d+/.exec(raw);
  return m ? Number.parseInt(m[0], 10) : 0;
}

/** ScenarioClass percent fields: int(v * 100 + 0.01) / 100. */
export const enginePercent = (v: number): number => Math.trunc(v * 100 + 0.01) / 100;
/** ScenarioClass per-mille fields: int(v * 1000 + 0.01) / 1000. */
export const enginePerMille = (v: number): number => Math.trunc(v * 1000 + 0.01) / 1000;
/** BuildingTypeClass light fields: int(v * 1000 + 0.1) / 1000. */
export const lightPerMille = (v: number): number => Math.trunc(v * 1000 + 0.1) / 1000;

/**
 * A [Lighting] set in the engine's stored precision (percent / per-mille, truncated), from raw INI values such as
 * manifest.lighting. Idempotent: values already in engine precision come back unchanged.
 */
export function engineLighting(l: EngineLighting): EngineLighting {
  return {
    ambient: enginePercent(l.ambient),
    red: enginePercent(l.red),
    green: enginePercent(l.green),
    blue: enginePercent(l.blue),
    ground: enginePerMille(l.ground),
    level: enginePerMille(l.level),
  };
}

type Getter = (key: string) => string | undefined;

/** ScenarioClass constructor defaults (@0x6838D3..0x683997). DominatorGround/Level are not set there: 0. */
const LIGHTING_DEFAULTS: Record<string, number> = {
  Ambient: 1,
  Red: 1,
  Green: 1,
  Blue: 1,
  Ground: 0.05,
  Level: 0.008,
  IonAmbient: 0.87,
  IonRed: 0.3,
  IonGreen: 0.4,
  IonBlue: 0.75,
  IonGround: 0,
  IonLevel: 0,
  DominatorAmbient: 1.5,
  DominatorRed: 0.85,
  DominatorGreen: 0.2,
  DominatorBlue: 0.3,
  DominatorGround: 0,
  DominatorLevel: 0,
  DominatorAmbientChangeRate: 0.001,
};

/** Read a map's [Lighting] section the way ScenarioClass::ReadLighting does. `get` returns the raw INI value. */
export function readEngineLighting(get: Getter): MapLightingSet {
  const defaulted: string[] = [];
  const read = (key: string, store: (v: number) => number): number => {
    const raw = get(key);
    if (raw === undefined) {
      defaulted.push(key);
      return LIGHTING_DEFAULTS[key]!;
    }
    return store(parseEngineDouble(raw)!);
  };
  const set = (prefix: string): EngineLighting => ({
    ambient: read(`${prefix}Ambient`, enginePercent),
    red: read(`${prefix}Red`, enginePercent),
    green: read(`${prefix}Green`, enginePercent),
    blue: read(`${prefix}Blue`, enginePercent),
    ground: read(`${prefix}Ground`, enginePerMille),
    level: read(`${prefix}Level`, enginePerMille),
  });
  const normal = set('');
  const ionStorm = set('Ion');
  const dominator = { ...set('Dominator'), ambientChangeRate: read('DominatorAmbientChangeRate', enginePerMille) };
  return { normal, ionStorm, dominator, defaulted };
}

/**
 * A BuildingType's light from its rules keys (`get` already merges the map's section over rulesmd.ini), or null when
 * LightIntensity is 0 (the engine then creates no light source).
 */
export function readLightType(get: Getter, art: { image: string; foundation: [number, number] }): LightType | null {
  const intensity = lightPerMille(parseEngineDouble(get('LightIntensity')) ?? 0);
  if (intensity === 0) return null;
  const tint = (key: string): number => {
    const raw = get(key);
    // BuildingTypeClass's constructor leaves the tints at 1000.0; kept as is (a missing tint saturates that channel).
    return raw === undefined ? 1000 : lightPerMille(parseEngineDouble(raw)!);
  };
  return {
    radius: parseEngineInt(get('LightVisibility')) ?? 5000,
    intensity,
    tint: [tint('LightRedTint'), tint('LightGreenTint'), tint('LightBlueTint')],
    invisible: /^\s*[yt1]/i.test(get('InvisibleInGame') ?? ''),
    image: art.image,
    foundation: art.foundation,
  };
}

// ------------------------------------------------------------------ engine cell lighting

export interface CellGrid {
  width: number;
  height: number;
  /** Height level per cell. */
  z: Uint8Array;
  /** 1 where the cell exists. */
  exists: Uint8Array;
}

/** What engineCellLight needs of a light source. */
export type EngineLight = Pick<MapLightSource, 'position' | 'radius' | 'intensity' | 'tint'>;

export interface CellLight {
  /** Normalised intensity per cell, 0..2 (1 = the palette unchanged). */
  intensity: Float32Array;
  /** Tint per cell (RGB interleaved), each channel 0..1 after normalisation by the largest one. */
  tint: Float32Array;
}

const toMille = (v: number): number => Math.round(v * 1000);

/**
 * Exact integer per-mille port of the engine's cell lighting (@0x484180) and tint normalisation (@0x5558E0):
 *   cell centre (256x + 128, 256y + 128); d = trunc(hypot(dx, dy)); a light contributes when d <= radius with
 *   f = floor(1000 (r - d) / r);
 *   I = 1000 A + sum(I_l f / 1000) + Level z - Ground, clamped to [0, 2000];
 *   R, G, B = 1000 C + sum(t f / 1000), each clamped to [0, 2000]; M = max(R, G, B);
 *   M * 65.536 < 66 (M <= 1 per-mille) gives a black cell; otherwise intensity = min(2000, I M / 1000) and
 *   tint = (R, G, B) / M.
 * Integer divisions truncate towards zero like the engine's idiv (negative lights such as NEGLAMP).
 * `falloffPower` 1 is the engine exactly; presenters may pass more (f := floor(1000 (f / 1000)^p)) to shape each light
 * as a tighter pool while keeping its centre value.
 */
export function engineCellLight(
  grid: CellGrid,
  lighting: EngineLighting,
  lights: readonly EngineLight[],
  out?: CellLight,
  falloffPower = 1,
): CellLight {
  const n = grid.width * grid.height;
  const result = out ?? { intensity: new Float32Array(n), tint: new Float32Array(n * 3) };
  const ambient = toMille(lighting.ambient);
  const base = [toMille(lighting.red), toMille(lighting.green), toMille(lighting.blue)] as const;
  const level = toMille(lighting.level);
  const ground = toMille(lighting.ground);
  const prepared = lights.map((l) => ({
    x: l.position[0],
    y: l.position[1],
    r: Math.trunc(l.radius),
    i: toMille(l.intensity),
    t: [toMille(l.tint[0]), toMille(l.tint[1]), toMille(l.tint[2])] as const,
  }));
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const c = y * grid.width + x;
      if (!grid.exists[c]) {
        result.intensity[c] = 0;
        result.tint.fill(0, c * 3, c * 3 + 3);
        continue;
      }
      const cx = x * 256 + 128;
      const cy = y * 256 + 128;
      let I = ambient;
      let R = base[0];
      let G = base[1];
      let B = base[2];
      for (const l of prepared) {
        if (l.r <= 0) continue;
        const dx = cx - l.x;
        const dy = cy - l.y;
        if (dx * dx + dy * dy > l.r * l.r) continue;
        const d = Math.trunc(Math.sqrt(dx * dx + dy * dy));
        if (d > l.r) continue;
        let f = Math.trunc((l.r * 1000 - d * 1000) / l.r);
        if (falloffPower !== 1) f = Math.trunc(1000 * (f / 1000) ** falloffPower);
        I += Math.trunc((l.i * f) / 1000);
        R += Math.trunc((l.t[0] * f) / 1000);
        G += Math.trunc((l.t[1] * f) / 1000);
        B += Math.trunc((l.t[2] * f) / 1000);
      }
      I += level * grid.z[c]! - ground;
      I = clampInt(I, 0, 2000);
      R = clampInt(R, 0, 2000);
      G = clampInt(G, 0, 2000);
      B = clampInt(B, 0, 2000);
      const M = Math.max(R, G, B);
      if (M * 65.536 < 66) {
        result.intensity[c] = 0;
        result.tint.fill(0, c * 3, c * 3 + 3);
        continue;
      }
      result.intensity[c] = Math.min(2000, (I * M) / 1000) / 1000;
      result.tint[c * 3] = R / M;
      result.tint[c * 3 + 1] = G / M;
      result.tint[c * 3 + 2] = B / M;
    }
  }
  return result;
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * HD anchor from engine brightness to linear light relative to clear noon. The palette scales display values, so
 * linear light scales by v^2.2; a typical stock night (0.62) is shown at 30 % of noon.
 */
export const NIGHT_ANCHOR = { engine: 0.62, linear: 0.3 } as const;
export function engineToLinear(e: number): number {
  return e <= 0 ? 0 : NIGHT_ANCHOR.linear * Math.pow(e / NIGHT_ANCHOR.engine, 2.2);
}

/**
 * Local light the map's sources add, per cell and channel, in linear light relative to noon (1 = noon irradiance):
 * engineToLinear(intensity * tint) with the lights minus the same without them, both with Ambient := baseAmbient.
 * Negative where a negative light (NEGLAMP) darkens. `falloffPower` as in engineCellLight (1 = the engine).
 */
export function engineLightDelta(
  grid: CellGrid,
  lighting: EngineLighting,
  lights: readonly EngineLight[],
  baseAmbient: number,
  falloffPower = 1,
): Float32Array {
  const n = grid.width * grid.height;
  const out = new Float32Array(n * 3);
  if (lights.length === 0) return out;
  const scene = { ...lighting, ambient: baseAmbient };
  const lit = engineCellLight(grid, scene, lights, undefined, falloffPower);
  const unlit = engineCellLight(grid, scene, []);
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < 3; k++) {
      const a = engineToLinear(lit.intensity[c]! * lit.tint[c * 3 + k]!);
      const b = engineToLinear(unlit.intensity[c]! * unlit.tint[c * 3 + k]!);
      out[c * 3 + k] = a - b;
    }
  }
  return out;
}

// ------------------------------------------------------------------ map atmosphere

/** Night brightness used when a presenter forces night on a map whose own [Lighting] is day or dusk. */
export const DEFAULT_NIGHT_LEVEL = 0.3;
export const NIGHT_LEVEL_RANGE = [0.26, 0.4] as const;

/** Evidence a map was built as a night map besides its [Lighting]: its lamp-post light sources. */
export interface NightEvidence {
  /** Light sources with positive intensity whose type is InvisibleInGame (INGALITE, INYELWLAMP, INBLULMP ...). */
  lamps: number;
}

/** Count the lamp posts among a map's light sources (see NightEvidence). */
export function nightEvidence(lights: readonly Pick<MapLightSource, 'intensity' | 'invisible'>[]): NightEvidence {
  return { lamps: lights.filter((l) => l.invisible && l.intensity > 0).length };
}

/**
 * Stage a map from its own [Lighting]. The class comes from the authored base ambient `base = Ambient - Ground` (the
 * part every cell shares) and the tint = RGB / max(RGB), plus lamp posts as evidence:
 *   night when base <= 0.70, or base <= 0.76 with a blue tint (b - (r + g) / 2 >= 0.15) or with two or more lamp
 *   posts (unless the tint is warm), at 22:00;
 *   dusk when base <= 0.76 with a warm tint (r - b >= 0.15), at 18:12;
 *   day otherwise, at 12:00 (the 0.8 maps with a yellow grade, such as invasion.mmx, are sunny day maps).
 * Level x height is left out of the class on purpose: night maps with raised ground (XMP06T2 "Urban Rush", Level 0.039
 * at median height 4; the snow and jungle night maps at Level 0.028-0.029 on heights 5-6) would otherwise read as day.
 * Evidence: Ambient over all 220 stock scenarios with a [Lighting] section (all-scenarios-lighting.tsv, see the
 * research doc) clusters at 0.6 (5 maps), 0.7 (28), 0.8 (66), 0.9 (40) and 1.0 (77); the 0.55-0.70 maps are the ones
 * built as night maps (lamp posts, blue tints, NEGLAMP darkening), 0.8+ are day maps with a colour grade.
 * nightLevel (night maps): clamp(engineToLinear(Ambient - Ground + Level x medianZ), 0.26, 0.40), what unlit ground
 * at the map's typical height shows, kept readable; otherwise DEFAULT_NIGHT_LEVEL.
 */
export function mapAtmosphere(
  normal: EngineLighting,
  medianZ: number,
  evidence: NightEvidence = { lamps: 0 },
): AtmosphereProfile {
  const base = normal.ambient - normal.ground;
  const eff = base + normal.level * medianZ;
  const max = Math.max(normal.red, normal.green, normal.blue, 1e-6);
  const tint: [number, number, number] = [normal.red / max, normal.green / max, normal.blue / max];
  const blueShift = tint[2] - (tint[0] + tint[1]) / 2;
  const warm = tint[0] - tint[2] >= 0.15 - 1e-9;
  const epsilon = 1e-9;
  let kind: AtmosphereProfile['kind'] = 'day';
  if (
    base <= 0.7 + epsilon ||
    (base <= 0.76 + epsilon && !warm && (blueShift >= 0.15 - epsilon || evidence.lamps >= 2))
  )
    kind = 'night';
  else if (base <= 0.76 + epsilon && warm) kind = 'dusk';
  const hour = kind === 'night' ? 22 : kind === 'dusk' ? 18.2 : 12;
  const nightLevel =
    kind === 'night'
      ? Math.min(NIGHT_LEVEL_RANGE[1], Math.max(NIGHT_LEVEL_RANGE[0], engineToLinear(eff)))
      : DEFAULT_NIGHT_LEVEL;
  return { kind, hour, nightLevel, tint };
}

/** The staging of a map with a light sidecar, recomputed from its raw [Lighting] and light sources. */
export function sidecarAtmosphere(sidecar: Pick<MapLightsSidecar, 'lighting' | 'cells' | 'lights'>): AtmosphereProfile {
  return mapAtmosphere(sidecar.lighting.normal, sidecar.cells.medianZ, nightEvidence(sidecar.lights));
}

/** Engine ambient whose unlit ground maps to the profile's night level (the inverse of engineToLinear). */
export function nightBaseAmbient(profile: Pick<AtmosphereProfile, 'nightLevel'>): number {
  return NIGHT_ANCHOR.engine * Math.pow(profile.nightLevel / NIGHT_ANCHOR.linear, 1 / 2.2);
}

// ------------------------------------------------------------------ surfaces

/**
 * Surface class of a tile from its TMP land type and the mean sRGB colour of its 60x30 diamond. Land types follow the
 * TS/RA2 tile set convention (9 water, 10 beach, 11/12 road, 13 clear, 14 rough, 15 cliff); "clear" and "rough" hold
 * both ground and pavement, so their colour decides (isPavementColour).
 *
 * Evidence, mean colour per template family on both cached maps (tools: the lights-preview.png surface panel):
 *   XMP29U2 (urban): proad/droads roads at 11/12; plat/pvclr red brick (155,99,74) and light concrete (185,178,162)
 *   at 13; its lawns (glat, green rough ~(108,131,61), saturation ~0.53) and its asphalt parking lots (grey rough,
 *   saturation < 0.12) both at 14; rough cliff edges at 15.
 *   RiverRam (temperate): water at 9, shores at 10 and 14, yellow-green grass clat/ramp/slope at 13 ((145,153,66):
 *   green only by a few percent, so a plain "green channel wins" test would call it pavement), dirt/sand at 14
 *   (saturation >= 0.23), cliffs and waterfalls at 15.
 */
export function classifyTileSurface(landType: number, meanRgb: readonly [number, number, number] | null): SurfaceClass {
  if (landType === 9) return SURFACE.water;
  if (landType === 15) return SURFACE.rock;
  if (landType === 11 || landType === 12) return SURFACE.road;
  if (landType === 13 || landType === 14) {
    if (!meanRgb) return landType === 13 ? SURFACE.paved : SURFACE.soft;
    return isPavementColour(meanRgb) ? SURFACE.paved : SURFACE.soft;
  }
  return SURFACE.soft;
}

/** Grey (concrete, asphalt: HSV saturation < 0.2) or brick red (r > 1.3 g and r > 1.5 b). */
export function isPavementColour([r, g, b]: readonly [number, number, number]): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max > 0 ? (max - min) / max : 0;
  return saturation < 0.2 || (r > g * 1.3 && r > b * 1.5);
}

export interface SurfaceCells {
  width: number;
  height: number;
  exists: Uint8Array;
  /** Tile index per cell (0xffff = none). */
  tile: Uint16Array;
}

/** Surface class per cell; `tileMean` gives a tile's mean sRGB colour (null when unknown). */
export function surfaceGrid(
  cells: SurfaceCells,
  tiles: readonly { terrainType: number }[],
  tileMean: (tile: number) => readonly [number, number, number] | null,
): Uint8Array {
  return cellSurfaces(
    cells,
    tiles.map((t, i) => classifyTileSurface(t.terrainType, tileMean(i))),
  );
}

/**
 * Browser fallback when a cache has no sidecar (no tile colours): land types only. Land type 13 counts as pavement in
 * the city theaters (urban, newurban) and as ground elsewhere, 14 as ground, which matches both probed maps except
 * for XMP29U2's asphalt parking lots (14).
 */
export function surfaceFromLandType(
  cells: SurfaceCells,
  tiles: readonly { terrainType: number }[],
  theater: string,
): Uint8Array {
  const city = theater === 'urban' || theater === 'newurban';
  return cellSurfaces(
    cells,
    tiles.map((t) => {
      const c = classifyTileSurface(t.terrainType, null);
      return c === SURFACE.paved && !city ? SURFACE.soft : c;
    }),
  );
}

function cellSurfaces(cells: SurfaceCells, perTile: readonly SurfaceClass[]): Uint8Array {
  const out = new Uint8Array(cells.width * cells.height);
  for (let c = 0; c < out.length; c++) {
    const t = cells.tile[c]!;
    out[c] = cells.exists[c] && t !== 0xffff && perTile[t] !== undefined ? perTile[t]! : SURFACE.none;
  }
  return out;
}

/** Median of the existing cells' height levels. */
export function medianHeight(z: Uint8Array, exists: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  let n = 0;
  for (let i = 0; i < z.length; i++) {
    if (!exists[i]) continue;
    counts[z[i]!]!++;
    n++;
  }
  if (n === 0) return 0;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += counts[v]!;
    if (seen * 2 >= n) return v;
  }
  return 0;
}

// ------------------------------------------------------------------ street lamps (HD dressing)

export interface StreetLampInput {
  width: number;
  height: number;
  exists: Uint8Array;
  surface: Uint8Array;
  /** 1 where a lamp must not stand (building foundations plus a margin, trees). */
  blocked: Uint8Array;
  /** Keep only cells for which this returns true (e.g. inside the playable screen rectangle). */
  bounds?: (x: number, y: number) => boolean;
  seed: number;
  /** Minimum distance between lamps in cells. */
  spacing?: number;
}

/** Deterministic 32-bit hash of a cell and a seed (no Math.random: the same map always gets the same lamps). */
export function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * HD street lamp spots along roads: cells that are not road, water or rock, share an edge with a road cell, are not
 * blocked and lie inside `bounds`; visited in seeded hash order and accepted when at least `spacing` cells from every
 * accepted lamp.
 */
export function placeStreetLamps(input: StreetLampInput): [x: number, y: number][] {
  const { width, height, exists, surface, blocked, bounds, seed } = input;
  const spacing = input.spacing ?? 4.5;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? y * width + x : -1);
  const isRoad = (x: number, y: number) => {
    const c = at(x, y);
    return c >= 0 && exists[c] === 1 && surface[c] === SURFACE.road;
  };
  const candidates: { x: number; y: number; h: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y * width + x;
      const s = surface[c]!;
      if (!exists[c] || blocked[c] || s === SURFACE.none || s === SURFACE.road) continue;
      if (s === SURFACE.water || s === SURFACE.rock) continue;
      if (!(isRoad(x + 1, y) || isRoad(x - 1, y) || isRoad(x, y + 1) || isRoad(x, y - 1))) continue;
      if (bounds && !bounds(x, y)) continue;
      candidates.push({ x, y, h: cellHash(x, y, seed) });
    }
  }
  candidates.sort((a, b) => a.h - b.h || a.y - b.y || a.x - b.x);
  const accepted: [number, number][] = [];
  // Bucket accepted lamps by `spacing`-sized squares so each test only looks at neighbouring buckets.
  const bucket = new Map<number, [number, number][]>();
  const key = (bx: number, by: number) => by * 65536 + bx;
  const s2 = spacing * spacing;
  for (const c of candidates) {
    const bx = Math.floor(c.x / spacing);
    const by = Math.floor(c.y / spacing);
    let ok = true;
    for (let j = by - 1; j <= by + 1 && ok; j++) {
      for (let i = bx - 1; i <= bx + 1 && ok; i++) {
        for (const [ax, ay] of bucket.get(key(i, j)) ?? []) {
          if ((ax - c.x) ** 2 + (ay - c.y) ** 2 < s2) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;
    const lamp: [number, number] = [c.x, c.y];
    accepted.push(lamp);
    const k = key(bx, by);
    const list = bucket.get(k);
    if (list) list.push(lamp);
    else bucket.set(k, [lamp]);
  }
  accepted.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return accepted;
}

// ------------------------------------------------------------------ validation

/** Check a parsed lights.json; throws on a version mismatch or a malformed file. */
export function validateMapLights(json: unknown): MapLightsSidecar {
  const value = json as Partial<MapLightsSidecar> | null;
  if (!value || typeof value !== 'object') throw new Error('lights.json: not an object');
  if (value.version !== MAP_LIGHTS_VERSION)
    throw new Error(`lights.json: version ${String(value.version)}, expected ${MAP_LIGHTS_VERSION}`);
  if (!value.lighting?.normal || !value.atmosphere || !Array.isArray(value.lights) || !value.cells?.surface)
    throw new Error('lights.json: missing lighting, atmosphere, lights or cells');
  if (!Array.isArray(value.hiddenObjects) || !value.types || !value.hdEmitters)
    throw new Error('lights.json: missing hiddenObjects, types or hdEmitters');
  return value as MapLightsSidecar;
}
