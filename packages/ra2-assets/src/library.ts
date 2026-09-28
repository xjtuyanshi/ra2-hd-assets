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
import type { AtlasRef, LightingClass, SpriteEntry } from './manifest.ts';
import type { InfantrySequence } from './art.ts';
import type { Hsv, Rgb } from './remap.ts';
import type { TheaterId } from './theater.ts';

export const TYPE_LIBRARY_VERSION = 1;

/** Largest atlas page edge; pages are split so each fits a 4096x4096 texture (WebGL2 guaranteed minimum is 2048). */
export const LIBRARY_ATLAS_MAX = 4096;

export type LibraryKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';

export interface TypeLibrary {
  version: typeof TYPE_LIBRARY_VERSION;
  theater: TheaterId;
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
   *   start + (facingMultiplier > 0 ? facingFrame(f, 8) * facingMultiplier : 0) + t % count.
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
