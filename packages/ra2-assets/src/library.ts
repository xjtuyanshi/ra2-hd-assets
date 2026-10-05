/**
 * HD type library: the contract between the library extraction step (Node, reads the player's own install) and an HD
 * renderer that follows a LIVE match. The per-map cache (manifest.ts) only holds art for objects a map places; the
 * live-memory reader (src/games/yr/stateReader.ts) reports every building, vehicle, infantry and aircraft by rules type
 * id, owner colour scheme index, lepton position, facing, turret facing and health, so the renderer needs art for every
 * TechnoType of the game. Everything under gameres/hd-cache/_library/ is derived from EA assets and must never be
 * committed or redistributed.
 *
 * Layout (one directory per theater, plus shared theater-independent data):
 *   _library/<theater>/library.json      this file (TypeLibrary)
 *   _library/<theater>/buildngz.bin      transformed native building depth template (signed 8-bit samples)
 *   _library/<theater>/sprites-<n>.png   indexed sprite atlas pages (SpriteFrame.page = n)
 *   _library/<theater>/palettes/<key>.png 256x1 RGB palettes
 *   _library/common/voxels/<ID>.json     voxel models (VoxelModel from manifest.ts), shared by all theaters: VXL/HVA
 *                                        files carry no theater art, and models only name their palette key
 * Every path inside library.json is relative to the library.json that contains it (voxel paths therefore start with
 * "../common/").
 *
 * Drawing a live object of type `t = types[id]` (see LibraryType for each field):
 *   1. screen point P = project(object lepton coordinate) + t.drawOffset, with the manifest.ts screen convention
 *      (256 leptons per cell, 104 per height level: sx = (x - y) * 30 / 256, sy = (x + y) * 15 / 256 - z * 15 / 104).
 *   2. palette = palettes[sprite.palette] (or the voxel's palette) with indices 16..31 replaced by
 *      colorSchemes[owner colorIndex].remap when the sprite/type is remappable, then lit per t.lighting.
 *   3. SHP frames are drawn with their canvas centre on P (SpriteFrame.offset is relative to it); shadows (index 1
 *      masks, same order as frames) darken what is below; voxels use their HVA transforms like the map cache.
 * Frame choice per kind: buildings LibraryBuilding, infantry LibraryInfantry, SHP vehicles/aircraft LibraryShpUnit;
 * voxel units only need the facings.
 */
import type { AtlasRef, LightingClass, SpriteAtlasHdRef, SpriteEntry } from './manifest.ts';
import type { InfantrySequence } from './art.ts';
import type { Hsv, Rgb } from './remap.ts';
import type { TheaterId } from './theater.ts';

export const TYPE_LIBRARY_VERSION = 1;

/** Largest atlas page edge; pages are split so each fits a 4096x4096 texture (WebGL2 guaranteed minimum is 2048). */
export const LIBRARY_ATLAS_MAX = 4096;

export type LibraryKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';

/** Native BUILDNGZ.SHA frame 0 after the engine loader's transform; every path is relative to library.json. */
export interface LibraryDepthTemplate {
  file: string;
  width: number;
  height: number;
}

export interface TypeLibrary {
  version: typeof TYPE_LIBRARY_VERSION;
  theater: TheaterId;
  /**
   * Row-major width * height bytes: raw 0 stays 0, otherwise (raw - 65) & 255. Consumers interpret signed int8;
   * zero is a valid depth correction, never transparency. Absent in older libraries; full extractions require it.
   */
  depthTemplate?: LibraryDepthTemplate;
  /** 256-entry RGB palettes as 256x1 PNGs keyed like the map cache ("unit", "iso", custom art Palette= names). */
  palettes: Record<string, string>;
  /** Original palette file per key (e.g. { unit: "unittem.pal" }). */
  paletteSources: Record<string, string>;
  /**
   * Sprite atlas pages, each at most LIBRARY_ATLAS_MAX square. Single-channel 8-bit PNGs: the value is the palette
   * index, 0 = transparent (unlike the map cache's RGBA sprites.png). SpriteFrame.page indexes this list; frames of
   * one sprite may sit on different pages, so a renderer typically uploads all pages as one texture array.
   */
  spriteAtlases: AtlasRef[];
  /**
   * Optional offline 2x RGBA/remap atlases, indexed exactly like spriteAtlases. Null means a page has not been
   * processed. Normalized UVs are unchanged; shadows still come from the indexed source pages.
   */
  spriteAtlasesHd?: (SpriteAtlasHdRef | null)[];
  /**
   * SHP art keyed by `<class>:<art name>`: "building:<art section>", "infantry:<art section>",
   * "vehicle:<art section>", "aircraft:<art section>", "anim:<anim section>" (building layers, buildup, deploy anims)
   * and "bib:<BibShape>". Unlike the map cache every sprite keeps ALL its body frames (no `sourceFrames`), with the
   * matching shadow frames when the SHP has a shadow half.
   */
  sprites: Record<string, SpriteEntry>;
  /** Voxel models keyed by voxel id (the rules type id, or "<BUILDING>:turret" for building turrets). */
  voxels: Record<string, string>;
  /** Every TechnoType whose art resolved, keyed by rules type id (e.g. "GAPOWR", "HTNK", "E1", "ORCA"). */
  types: Record<string, LibraryType>;
  /** Every rules [OverlayTypes] entry whose art resolved, plus rubble carriers; absent in older libraries. */
  overlays?: Record<string, LibraryOverlay>;
  /** Diagnostics of a later overlays-only append; the original extraction record is preserved. */
  overlayExtractor?: { tool: string; counts: Record<string, number>; warnings: string[] };
  /** Every rules [SmudgeTypes] entry whose theater art resolved; absent in older libraries. */
  smudges?: Record<string, LibrarySmudge>;
  /** Diagnostics of a later smudges-only append; the original extraction record is preserved. */
  smudgeExtractor?: { tool: string; counts: Record<string, number>; warnings: string[] };
  /**
   * The game's runtime ColorScheme array in order, so the live reader's HouseClass::ColorSchemeIndex (`colorIndex`)
   * indexes it directly. See ColorSchemeEntry and colorSchemeSlots in remap.ts for the ordering evidence.
   */
  colorSchemes: ColorSchemeEntry[];
  /** rules [Colors] name -> the index houses use for it (the second copy, 2k + 1). */
  colorSchemesByName: Record<string, number>;
  /** rules [AudioVisual] ConditionYellow/ConditionRed as fractions of full strength (YR: 0.5 / 0.25). */
  conditionYellow: number;
  conditionRed: number;
  extractor: { tool: string; counts: Record<string, number>; warnings: string[] };
}

/** Cell art uses the engine's OverlayData directly as its body-frame index, without animation or facing logic. */
export interface LibraryOverlay {
  /** Absent for rubble carriers, which draw their source building's rubble frame instead. */
  sprite?: string;
  /** Rules IsRubble=yes: the overlay's Image is never drawn. */
  rubble?: true;
  /** Number of body frames, excluding a detected shadow half. */
  frames: number;
  palette: 'unit' | 'theater' | 'iso';
  wall: boolean;
  tiberium: boolean;
  /** Stock YR walls use the current player's colour scheme, not the cell's wall-owner index. */
  remap: boolean;
  flat: boolean;
  /** Offset from the projected cell top corner, shared with the map extractor. */
  drawOffset: [x: number, y: number];
  lighting: LightingClass;
}

/** Ground decals draw body frame 0; the engine's SmudgeData is an index within this type's footprint. */
export interface LibrarySmudge {
  sprite: string;
  /** Number of body frames, excluding a detected shadow half. */
  frames: number;
  /** Rules Width/Height in cells. SmudgeData = dy * width + dx reconstructs the multi-cell origin. */
  width: number;
  height: number;
  palette: 'iso';
  remap: false;
  flat: true;
  /** Offset from the projected cell top corner, shared with the map extractor. */
  drawOffset: [x: number, y: number];
  lighting: 'full';
}

/**
 * One entry of the runtime ColorScheme array. YR 1.001 creates two schemes per rules [Colors] entry, in file order
 * (entry k -> indices 2k and 2k + 1; the engine keeps one with 1 shade and one with 53 lighting shades). Houses use
 * the odd copy. Both copies carry the same remap colours.
 */
export interface ColorSchemeEntry {
  /** rules [Colors] key, e.g. "DarkRed". */
  name: string;
  hsv: Hsv;
  /** 0 = first copy (index 2k), 1 = second copy (2k + 1, the one HouseClass::ColorSchemeIndex points at). */
  copy: 0 | 1;
  /**
   * 16 RGB entries replacing palette indices 16..31 (brightest first), from remapRamp in remap.ts over this theater's
   * unit palette — the same approximation the map cache uses for `houses`. In-game measurement shows the engine's
   * ramp is less saturated at the bright end (about 0.77 x the [Colors] saturation on index 16, rising to 1.0 on
   * index 28) with a similar brightness profile; see the library README section.
   */
  remap: Rgb[];
}

export interface LibraryType {
  kind: LibraryKind;
  /** Art section used (rules Image= or the id itself). */
  image: string;
  /** Body sprite id (buildings, infantry, SHP vehicles/aircraft). */
  sprite?: string;
  /** Voxel id in TypeLibrary.voxels (voxel vehicles/aircraft). */
  voxel?: string;
  /** rules Turret=yes: voxel models then have a turret (and maybe barrel) part turned by the turret facing. */
  turret?: boolean;
  /** Building footprint (art Foundation=WxH) in cells. */
  foundation?: [width: number, height: number];
  /**
   * Screen offset in pixels from the projection of the object's engine coordinate as the live reader reports it
   * (buildings: centre of the foundation's top-left cell; everything else: the object's own coordinate) to the SHP
   * canvas centre / voxel origin. Buildings (0, -15): their canvas centre is the top corner of the foundation.
   */
  drawOffset: [x: number, y: number];
  lighting: LightingClass;
  /** Palette indices 16..31 take the owner's colour scheme (art Remapable=, default yes). */
  remap: boolean;
  /** rules InvisibleInGame=yes (lamp posts and other light-source dummies): the engine never draws it. */
  invisible?: boolean;
  /** Vehicle rules Harvester=yes; relevant to native depth while the current cell contains a refinery. */
  harvester?: true;
  /** Building rules Refinery=yes; together with a harvester's current-cell building, enables its depth adjustment. */
  refinery?: true;
  /** rules UnloadingClass (harvesters, miners, Siege Chopper): voxel id of the model shown while unloading/deployed. */
  unloadingVoxel?: string;
  /** rules DeployingAnim= SHP (e.g. the Siege Chopper's deploy): anim sprite id, played once. */
  deployingAnim?: string;
  /**
   * Every atlas page (index into TypeLibrary.spriteAtlases) holding a frame of any sprite this type uses (body, bib,
   * layers, buildup, deploy anim), for renderers that load pages lazily. Frames of one sprite are packed together,
   * so most types need one or two pages. Absent for voxel-only types.
   */
  atlasPages?: number[];
  building?: LibraryBuilding;
  infantry?: LibraryInfantry;
  shpUnit?: LibraryShpUnit;
}

export interface LibraryBuilding {
  /** Non-default native body-depth inputs from this type's art section; plain ZAdjust is not NormalZAdjust. */
  zShape?: {
    /** Art ZShapePointMove, in native template pixels; absent means [0, 0]. */
    pointMove?: [x: number, y: number];
    /** Art NormalZAdjust, in native Z units; absent means 0. */
    normalZAdjust?: number;
  };
  /**
   * Body frames of `sprite`: frame 0 healthy, frame 1 damaged (health / strength <= conditionYellow), later frames
   * exported as-is (their meaning, e.g. extra damage stages, is not decoded). Frames may be empty: the nuclear silo
   * NAMISL is drawn entirely by its SuperAnim layers.
   */
  bodyFrames: number;
  /** BibShape sprite id, drawn below the body with the same origin (frame 0 healthy, 1 damaged when present). */
  bib?: string;
  /**
   * Art layers drawn over the body with the same origin, in art key order (ActiveAnim..Four, IdleAnim(Two),
   * SpecialAnim..Four, SuperAnim..Four, ProductionAnim, the war factory door anims, ActiveAnimGarrisoned, LowPower,
   * SuperLowPower). Which one plays when is engine state (power, production, super weapon charge) the live reader
   * does not report yet; ActiveAnim* layers run whenever the building is powered and not under construction.
   */
  layers: LibraryAnimLayer[];
  /** The "make" animation played when placed (art Buildup=, else <image>MK when such a file exists). */
  buildup?: string;
  /**
   * Voxel turret (rules TurretAnimIsVoxel=yes, e.g. GTGCAN, NASAM, NAFLAK, YAGGUN): model id, rules TurretAnimX/Y
   * pixel offset from the building's draw point (its SHP canvas centre = foundation top corner) and TurretAnimZAdjust.
   * The reference point is inferred from the stock values (YAGGUN 1x1 uses Y=15, GTGCAN 2x2 Y=28, i.e. the foundation
   * centre measured from the top corner) and looks right on the contact sheet; not compared with in-game screenshots.
   */
  turretVoxel?: { voxel: string; offset: [x: number, y: number]; zAdjust: number };
  /** art Height= (cells), a sorting hint. */
  height?: number;
  /**
   * art TerrainPalette=yes (lamp posts, CITY06), recorded raw and not applied: the sprite keeps the unit palette,
   * because gglite.shp drawn with iso<th>.pal is colour noise while unit<th>.pal gives natural colours.
   */
  terrainPalette?: boolean;
  /** art AltPalette=yes (bunkers, CAMIAM01): recorded, not applied (unit palette kept; meaning unverified). */
  altPalette?: boolean;
  /** art Flat=yes: drawn in the ground pass (service depots, airfields). */
  flat?: boolean;
}

/** One building art layer (e.g. key "ActiveAnim" -> anim "GAPOWR_A"). */
export interface LibraryAnimLayer {
  /** Art key the layer came from, e.g. "ActiveAnimTwo", "IdleAnim", "SuperAnim". */
  key: string;
  /** Anim sprite id with every frame of the anim SHP. */
  sprite: string;
  /** <key>Damaged anim sprite id, used instead of `sprite` while the building shows its damaged frame. */
  damagedSprite?: string;
  /** Art <key>X / <key>Y pixel offset from the building's draw point. */
  offset?: [x: number, y: number];
  /** Art <key>ZAdjust / <key>YSort (engine depth adjustments, recorded raw). */
  zAdjust?: number;
  ySort?: number;
  /** Anim art YDrawOffset (default 0), added by native drawing to position and Z; not folded into offset here. */
  yDrawOffset?: number;
  /** Art <key>Powered=yes: only shown/animated while the building has power. */
  powered?: boolean;
  /** The anim section's timing: Start/End/LoopStart/LoopEnd/LoopCount/Rate/Reverse, recorded raw when present. */
  anim: AnimTiming;
}

export interface AnimTiming {
  start?: number;
  end?: number;
  loopStart?: number;
  loopEnd?: number;
  loopCount?: number;
  rate?: number;
  reverse?: boolean;
  /** Anim art Shadow=yes: the SHP's second half holds shadow frames. */
  shadow?: boolean;
}

export interface LibraryInfantry {
  /** art Sequence= section name. */
  sequenceName: string;
  /**
   * Every entry of the sequence section (Ready, Guard, Walk, FireUp, Prone, Crawl, Die1..5, Deploy, Swim, ...).
   * Frame for engine facing f at animation step t: see sequenceFrame in art.ts
   *   start + direction * facingMultiplier + t % count (direction contributes only for a positive multiplier).
   * sequenceFrame's optional raw facing preserves the infantry art's finer sector-boundary quantization.
   */
  sequences: Record<string, InfantrySequence>;
  /** art Crawls= (default yes) and FireUp= (frames before firing), recorded raw. */
  crawls?: boolean;
  fireUp?: number;
}

/** SHP vehicles/aircraft (terror drone, squid, dolphin): TS-style directional frames. */
export interface LibraryShpUnit {
  /** art Facings= (default 8); frame of a standing unit = facingFrame(facing, facings) when no walk frames. */
  facings: number;
  /** Raw art frame layout keys when present (StartWalkFrame, WalkFrames, StartFiringFrame, FiringFrames, ...). */
  frames: Record<string, number>;
}

/** File name of a map cache's scenario-type sidecar, next to its manifest.json. */
export const SCENARIO_TYPES_FILE = 'scenario-types.json';
export const SCENARIO_TYPES_VERSION = 1;

/**
 * A type whose picture depends on the scenario's own rules. A map file is one more rules pass for the engine: it can
 * register new types (its own [BuildingTypes], [InfantryTypes] ... lists plus a section, e.g. the capturable Grand
 * Cannon clone `GTGCANA` with `Image=GTGCAN`) and change stock ones (a lamp post made visible with
 * `InvisibleInGame=no`). The theatre library is built from rulesmd.ini alone and knows neither, so the map cache
 * records them here.
 *
 * An entry never carries art of its own: `art` names the stock library type drawn with the same art (same art
 * section, and for voxel units a model of the same parts), and the remaining fields are the traits the extractor
 * derives from rules, as the scenario sets them. scenarioLibraryType() turns an entry into a LibraryType.
 */
export interface ScenarioType {
  kind: LibraryKind;
  /** Stock type id in the theatre library whose art this type uses (the type itself when only its rules changed). */
  art: string;
  /** rules Turret=. */
  turret?: true;
  /** rules InvisibleInGame=. */
  invisible?: true;
  /** rules Harvester= (vehicles) and Refinery= (buildings). */
  harvester?: true;
  refinery?: true;
  /** rules UnloadingClass: a voxel id of the theatre library. */
  unloadingVoxel?: string;
  /** rules DeployingAnim: an anim sprite id of the theatre library. */
  deployingAnim?: string;
  /** Building voxel turret: a voxel id of the theatre library, with the scenario's TurretAnimX/Y/ZAdjust. */
  turretVoxel?: NonNullable<LibraryBuilding['turretVoxel']>;
}

/** <map cache>/scenario-types.json. Absent when the scenario changes no type's picture. */
export interface ScenarioTypesSidecar {
  version: typeof SCENARIO_TYPES_VERSION;
  theater: TheaterId;
  /** Map source file name, as in the manifest. */
  source: string;
  types: Record<string, ScenarioType>;
  /** Scenario types that could not be bound to library art (they keep the renderer's fallback), with the reason. */
  warnings: string[];
}

/**
 * The library record of a scenario type: the art-derived fields of the stock type it shares art with, and the
 * rules-derived traits of the scenario entry. Nothing rules-derived is inherited from the stock type: a clone without
 * a turret must not get the stock type's turret.
 */
export function scenarioLibraryType(stock: LibraryType, entry: ScenarioType): LibraryType {
  const {
    turret: _turret,
    invisible: _invisible,
    harvester: _harvester,
    refinery: _refinery,
    unloadingVoxel: _unloadingVoxel,
    deployingAnim: _deployingAnim,
    building,
    ...art
  } = stock;
  const type: LibraryType = { ...art };
  if (entry.turret) type.turret = true;
  if (entry.invisible) type.invisible = true;
  if (entry.harvester) type.harvester = true;
  if (entry.refinery) type.refinery = true;
  if (entry.unloadingVoxel) type.unloadingVoxel = entry.unloadingVoxel;
  if (entry.deployingAnim) type.deployingAnim = entry.deployingAnim;
  if (building) {
    const { turretVoxel: _turretVoxel, ...body } = building;
    type.building = { ...body, ...(entry.turretVoxel ? { turretVoxel: entry.turretVoxel } : {}) };
  }
  return type;
}

/**
 * A library's type table with a scenario's types laid over it: scenario-defined ids are added, redefined stock ids
 * replaced. An entry whose stock type this library does not have (a sidecar made for another library generation) is
 * reported through `warn` and skipped, leaving whatever the table had.
 */
export function scenarioTypeTable(
  stock: Readonly<Record<string, LibraryType>>,
  entries: Readonly<Record<string, ScenarioType>>,
  warn: (message: string) => void = () => {},
): Record<string, LibraryType> {
  const types: Record<string, LibraryType> = { ...stock };
  for (const [id, entry] of Object.entries(entries)) {
    const donor = stock[entry.art];
    if (!donor || donor.kind !== entry.kind) {
      warn(`scenario type ${id}: the library has no ${entry.kind} ${entry.art} to draw it with`);
      continue;
    }
    types[id] = scenarioLibraryType(donor, entry);
  }
  return types;
}

/** Shape check of a scenario-type sidecar; throws with the offending path so a renderer never guesses. */
export function validateScenarioTypes(json: unknown): ScenarioTypesSidecar {
  const fail = (what: string): never => {
    throw new Error(`${SCENARIO_TYPES_FILE}: ${what}`);
  };
  if (!json || typeof json !== 'object') fail('not an object');
  const sidecar = json as ScenarioTypesSidecar;
  if (sidecar.version !== SCENARIO_TYPES_VERSION) fail(`unsupported version ${String(sidecar.version)}`);
  if (!sidecar.types || typeof sidecar.types !== 'object' || Array.isArray(sidecar.types)) fail('types is not a map');
  const kinds: readonly string[] = ['building', 'vehicle', 'infantry', 'aircraft'];
  for (const [id, entry] of Object.entries(sidecar.types)) {
    if (!entry || typeof entry !== 'object') fail(`types.${id} is not an object`);
    if (!kinds.includes(entry.kind)) fail(`types.${id}.kind is ${String(entry.kind)}`);
    if (typeof entry.art !== 'string' || !entry.art) fail(`types.${id}.art is missing`);
    const turret = entry.turretVoxel;
    if (
      turret !== undefined &&
      (typeof turret.voxel !== 'string' ||
        !Array.isArray(turret.offset) ||
        turret.offset.length !== 2 ||
        !turret.offset.every(Number.isFinite) ||
        !Number.isFinite(turret.zAdjust))
    )
      fail(`types.${id}.turretVoxel is malformed`);
  }
  return sidecar;
}
