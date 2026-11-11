import { hdInfantryPageIsBare } from '../ra2/infantryArt';
import {
  BoxGeometry,
  Color,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import { mapAtmosphere, medianHeight, sidecarAtmosphere } from '../../../ra2-assets/src/lights';
import type { AtmosphereSettings } from '../atmosphere';
import {
  HOUSE_COLORS,
  RENDER_STATE_VERSION,
  type AtmosphereProfile,
  type RenderState,
  type Weather,
} from '../contract';
import { HdRenderer } from '../HdRenderer';
import type { SceneLighting } from '../sceneLighting';
import {
  interpolateSceneLighting,
  NormalLightFollower,
  ra2SceneLighting,
  stormStrikeLight,
  type Ra2SceneLighting,
} from '../ra2/sceneLighting';
import type { LibraryAnimLayer, LibraryType } from '../../../ra2-assets/src/library';
import { NORMALIZED_RATE_FACTOR, animRateFrames } from '../../../ra2-assets/src/effects';
import type { SourceLight } from '../ra2/mapLights';
import type { WindowBuilding } from '../ra2/nightDressing';
import { sequenceFrame } from '../../../ra2-assets/src/art';
import type { MapObject, SpriteFrame, VoxelModel } from '../../../ra2-assets/src/manifest';
import type { TheaterId } from '../../../ra2-assets/src/theater';
import { addHousePalettes, HD_SUPERSAMPLE_ABOVE_SCALE, paletteFor, type HdAtlas, type Ra2Cache } from '../ra2/cache';
import { SpriteLayer, cardPush, isUnlitMapOverlay, objectAnchor, type SpriteInstance } from '../ra2/sprites';
import {
  assignPainterBias,
  objectYSort,
  painterObject,
  spritePainterBias,
  type PainterObject,
} from '../ra2/painterOrder';
import { NOT_CAPTURED_CODE } from '../objectDepth';
import { packTintColour, tintLight, type ObjectTint } from '../objectTint';
import {
  isNearEngulfFire,
  engulfAnchor,
  FIRE_FOOTPRINT_MARGIN,
  OBJECT_FOOTPRINT_MARGIN,
  type EngulfFire,
  type EngulfObject,
} from '../ra2/fireEngulf';
import { EFFECT_DECAL_LIFT, foundationPointPush, GROUND_DEPTH } from '../ra2/cardDepth';
import { cargoLook } from '../ra2/cargoLook';
import { selectVoxelTurretModel, selectedVoxelTurretIndex } from '../ra2/voxelTurrets';
import {
  addRefineryFoundation,
  harvesterRefineryBonus,
  attachedBodyDepth,
  buildingDepthProfile,
  type NativeSpriteDepth,
} from '../ra2/nativeDepth';
import type { WeatherFoundation } from '../weatherGroundMask';
import { HIGH_BRIDGE_HEIGHT, isHighBridge } from '../ra2/bridgeDepth';
import { setShadowOrigin } from '../ra2/voxelShadow';
import { loadRa2World, type HdWorld } from '../ra2/world';
import { waterPreset, type WaterStyle } from '../ra2/waterLook';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { VolumetricBlastLayer, type VolumetricBlast } from '../volumetricBlasts';
import { spriteLookFor } from '../ra2/spriteLook';
import { EffectArt, type ResolvedAnim } from './effectArt';
import {
  EffectSpriteLayer,
  animAlpha,
  effectDisplayBounds,
  effectPageLoaded,
  engineAnchor,
  type EffectDisplayBounds,
  type EffectInstance,
} from './effectSprites';
import { LiveEffectsDriver, smokeOnVehicle, type EffectStyle, type LiveAnim, type LiveEffects } from './effects';
import { LiveBeams } from './beams';
import { CAPTURABLE_BUILDINGS, EXTRA_LIGHT, NORMALIZED_BUILDINGS, SMOKE_SYSTEMS } from './effectTable';
import { BuildingLightGate, buildingLightOverlay, buildingLightSources } from './buildingLights';
import { BuildingVisualHistory } from './buildingVisualHistory';
import { DEPLOY_TARGETS, cellArtPages, overlayTypePages } from './artAhead';
import { HeldPicture } from './heldPicture';
import { PageGate, PageUploader, type PageUpload } from '../pageUpload';
import { countCompilations } from '../compileCounter';
import { LIBRARY_PALETTE_PREFIX, LiveLibrary } from './library';
import { OverlayInstanceCache, tiberiumCells, type LiveOverlayCells } from './overlays';
import { GlintLayer } from './glintLayer';
import { CellGlints } from '../ra2/cellGlints';
import { SmudgeInstanceCache, type LiveSmudgeCells, type SmudgePage } from './smudges';
import { Projectiles } from './projectiles';
import { shpUnitPose, shpUnitFrame, type ShpUnitState } from './shpUnits';
import { SpritePool } from './spritePool';
import { ShroudLayer, type ShroudCells } from './shroud';
import { VoxelUnits, type VoxelUnit, type VoxelUnitsOptions } from './voxelUnits';

export type { LiveOverlayCells } from './overlays';
export type { LiveSmudgeCells } from './smudges';

/**
 * Live view: draws a running original match (read from game memory by the host page) with the HD renderer, framed
 * exactly like the game's own tactical view. The host polls snapshots and pushes them here; this module never talks to
 * the game. Static map content (terrain, trees) comes from the local HD cache; ore, walls and smudges start from the
 * cache and follow the engine's cells when the host reports them; every building, vehicle, infantry and aircraft, and
 * every effect, comes from the snapshots.
 *
 * Everything that animates is clocked on the engine's logic frames (snapshot.frame), not on the wall clock, so HD art
 * keeps the original's timing at any game speed. Fields marked "bridge" are optional: without them the view falls back
 * to documented estimates (see docs/remaster/HD_BRIDGE.md, "Bridge fields").
 */

export type LiveKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';

/** One live object in engine units: leptons (256 per cell, 104 per height level), 16-bit facings (0 = north). */
export interface LiveObject {
  id: number;
  /** Unique for the whole game; distinguishes a reused native pointer. */
  uid: number;
  kind: LiveKind;
  /** Rules type id, e.g. "MTNK". */
  type: string;
  /** Engine-selected draw image when it differs from `type`, e.g. a harvester's UnloadingClass while it unloads. */
  imageType?: string;
  /** Index into LiveSnapshot.houses (by `index`), -1 when unknown. */
  owner: number;
  x: number;
  y: number;
  z: number;
  facingRaw: number;
  turretFacingRaw?: number;
  /** Engine-selected multi-turret art; absent or zero uses the default turret. */
  turretIndex?: number;
  health: number;
  isSelected: boolean;
  /** Native whole-object draw gate: suppress body, shadow and HD additions. */
  nativeHidden?: boolean;
  /** Body opacity while the native draw mode is translucent; shadows keep their normal opacity. */
  translucent?: number;
  /**
   * How the game changes the whole picture on this frame (objectTint.ts): a factor on its light level (the Iron
   * Curtain's pulse between 0.2 and 0.5, its flashes to 2) and a colour added afterwards (the Force Shield's blue, a
   * Berserk unit's red). Shadows are not tinted. Absent: drawn unchanged.
   */
  tint?: ObjectTint;
  /**
   * One frame of effect-library art the engine draws inside this object's own picture, right before its body (the
   * sparks at a harvesting miner's scoop): art id, absolute frame and the lepton point of the art's canvas centre.
   */
  underlay?: { art: string; frame: number; x: number; y: number; z: number };
  /**
   * What a harvester carries, in the game's storage units (bales) of ordinary ore and of gems; absent for every
   * other object. Selects the look of the bin (ra2/cargoLook.ts).
   */
  cargo?: { ore: number; gems: number };
  /** Bridge (H2): building construction state and the actual make SHP frame, including engine reversal. */
  buildState?: 'building' | 'selling' | 'done';
  buildupFrame?: number;
  buildingFrame?: number;
  buildingDamaged?: boolean;
  /** Validated radio contact's stable ID in this snapshot. */
  contactUid?: number;
  /** Host can dock/service units; supplied by the game policy. */
  dock?: boolean;
  /** Engine-selected delivery image, independent of available art. */
  unloading?: 'door' | 'roof';
  /** Native ActiveAnim presence/draw gate; undefined retains the existing light policy. */
  activeAnim?: 'none' | 'shown' | 'detail';
  /** Bridge (H2): infantry sequence key (e.g. "Walk", "Die1", "FireUp") and sequence-local animation step. */
  infantrySequence?: string;
  sequenceFrame?: number;
  /** Explicit SHP vehicle art pose for deterministic reviews; absent snapshots retain rules/event timing. */
  shpUnitPose?: { state: ShpUnitState; step: number };
  /** Optional engine-selected 16-bit infantry art direction; leaves body/travel facing unchanged. */
  infantryDrawFacingRaw?: number;
  /** Native tactical layer registration; absent in older snapshots. Ground keys exclude altitude/art offsets. */
  renderOrder?: { layer: number; index: number; ySort: number };
  /**
   * Unit up vector the game draws this vehicle's body with, in the engine axes of x/y/z (z up); (0, 0, 1) is level.
   * Absent = the renderer tilts the body with its own terrain.
   */
  tilt?: { x: number; y: number; z: number };
}

export interface LiveHouse {
  index: number;
  /** The game's colour scheme index for this house. */
  colorIndex: number;
  /**
   * Bridge (H1): a civilian house (the map's Neutral and Special houses, HouseClass::PlainName "Neutral"/"Special").
   * Without it `civilianHouses` infers them from what they own.
   */
  civilian?: boolean;
}

/** Bridge (H3): map cells whose overlay or smudge changed (or every cell when `full`). */
export interface LiveCells {
  full: boolean;
  /** [x, y, overlay index (0xff none), overlay frame, smudge index (-1 none), smudge frame]. */
  cells: [number, number, number, number, number, number][];
  /** Rules [OverlayTypes] / [SmudgeTypes] ids by index, when the host resolves them. */
  overlayTypes?: string[];
  smudgeTypes?: string[];
}

export interface LiveSnapshot {
  /** Logic frame counter. */
  frame: number;
  /** Current engine scene illumination; absent/null preserves the map's authored lighting. */
  lighting?: Ra2SceneLighting | null;
  /** Engine screen pixel of the tactical view's top-left corner. */
  view: { x: number; y: number } | null;
  houses: LiveHouse[];
  /** Local player's house index; native walls use this house's colour scheme. */
  localHouse?: number;
  objects: LiveObject[];
  /** Native renderer diagnostics, independently of HD presentation settings. */
  nativeDetail?: { fps: number; lowFrameRate: boolean; level: number };
  /** The local player's per-cell visibility (see ShroudLayer), when the host can read it. */
  shroud?: ShroudCells | null;
  /** The engine's live effects (anims, projectiles, particle systems, beams), when the host reads them. */
  effects?: LiveEffects | null;
  /** Full live overlay grid, including rubble carriers; forwarded intact to the overlay cache. Null/absent or a
   * legacy library without overlay art keeps map-cache overlays. */
  overlays?: LiveOverlayCells | null;
  /** Full live smudge grid; null/absent keeps map-cache smudges. Older libraries use available map-cache art. */
  smudges?: LiveSmudgeCells | null;
  /** Bridge (H3): runtime overlay/smudge cells. */
  cells?: LiveCells | null;
}

/**
 * One kind of object as LiveView.warm takes it: what selects art (rules type, engine image, house colours), nothing
 * about where it stands. A host keeps the list of one match (LiveView.warmTypes) to prepare the next one.
 */
export interface LiveWarmType {
  kind: LiveKind;
  type: string;
  imageType?: string;
  /** The owner's colour scheme index (LiveHouse.colorIndex), -1 when unknown. */
  colorIndex: number;
  /** Owned by a civilian house (map dressing), not by a player. */
  civilian?: boolean;
}

/** Logic frame of the snapshot warm() draws: later than any match, so the first real snapshot starts a new timeline. */
const WARM_FRAME = Number.MAX_SAFE_INTEGER;
/** UIDs of warm objects count down from here: negative, so none can be a match object's (-1 means "none"). */
const WARM_UID_BASE = -1000;
/** House indices of warm objects start here, above any index a match uses (negative owners mean "unknown"). */
const WARM_HOUSE_BASE = 1_000_000;

/** Attached presentation follows its owner's draw eligibility; independent explosions/projectiles remain native. */
function visibleObjectEffects(snapshot: LiveSnapshot): LiveEffects | null | undefined {
  const effects = snapshot.effects;
  if (!effects) return effects;
  const hidden = new Map(
    snapshot.objects.filter((object) => object.nativeHidden).map((object) => [object.uid, object.id]),
  );
  if (!hidden.size) return effects;
  const shown = (attachment: { uid: number; id: number } | null | undefined) =>
    !attachment || hidden.get(attachment.uid) !== attachment.id;
  return {
    ...effects,
    anims: effects.anims.filter((anim) => shown(anim.attachedTo)),
    particleSystems: effects.particleSystems.filter((system) => shown(system.attachedTo)),
    ...(effects.fireEvents ? { fireEvents: effects.fireEvents.filter(shown) } : {}),
  };
}

export interface LiveViewOptions extends VoxelUnitsOptions {
  /** URL of the map's HD cache directory (manifest.json inside). */
  mapBase: string;
  /** URL of the type library root (holding <theater>/library.json and common/effects/), for players' art. */
  libraryBase?: string;
  forceWebGL?: boolean;
  /** 16 remap colours (palette indices 16..31) for a colour scheme index; defaults to ramps of HOUSE_COLORS. */
  houseRemap?: (colorIndex: number) => [number, number, number][];
  /** Hour of day; undefined = the map's own staging (noon; 18:12 for authored dusk). */
  timeOfDay?: number;
  /**
   * Hour for every map but authored dusk (a look preset's suggested hour, e.g. cinematic 16.5); dusk keeps its own
   * staging hour. `timeOfDay` overrides both. Night maps take it too: the engine's own grade makes them dark at any
   * hour, as the game draws them, and their night dressing (lamps, lit windows) does not depend on the hour.
   */
  dayHour?: number;
  weather?: Weather;
  weatherIntensity?: number;
  /**
   * Development: draw a neutral grey box (never a house colour) for objects without art. Defaults to the page's
   * `?hd-debug=placeholders`.
   */
  debugPlaceholders?: boolean;
  /** HD around the engine's own effects: 'faithful' (default) or 'enhanced' (see LiveEffectsDriver.style). */
  effects?: EffectStyle;
  /** Optional RGBA flipbooks, enabled by default in enhanced style; false keeps native effect art. */
  effectsHd?: boolean;
  /** Opt-in raymarched blasts in enhanced style; defaults to off. */
  volumetricEffects?: 'off' | 'ray';
  /** Directory holding effects-hd.json (default: <libraryBase>/common/effects-hd). */
  effectsHdBase?: string;
  /** ActiveAnim glow: ignore native detail skips (default), or mirror them for native/HD reviews. */
  nativeDetail?: 'ignore' | 'mirror';
  /** Water look (ra2/waterLook.ts): 'classic' (default) or the modern 'enhanced' water. */
  water?: WaterStyle;
  /**
   * The engine's own field-wide ore/gem glints (ra2/cellGlints.ts, the pass HD mode skips on the native surface):
   * on by default; false leaves them out.
   */
  oreGlints?: boolean;
  /**
   * Gain of the HD's procedural star twinkle on ore and gems (spriteLook.ts crystalSparkle, an HD addition). Defaults
   * to 0 while the engine's glints are drawn (they would double up) and to 1 without them.
   */
  crystalSparkle?: number;
}

export interface LiveDiagnostics {
  /** Objects tracked without any art to draw (drawn as nothing). */
  placeholders: number;
  /** Rules types that have no art at all (each warned about once). */
  missingTypes: string[];
  /**
   * Building types drawn from the map cache's own body frame because the type library has no record of them: no
   * animation layers, no buildup and no turret. A scenario-defined type without a scenario-types.json entry lands here.
   */
  mapCacheTypes: string[];
  /** Objects whose library art is still loading. */
  pendingArt: number;
  /**
   * Sprites in the frame last drawn that came from their indexed atlas page because the page's HD art (its final
   * layer) was not there yet: drawn in place, at the original's resolution.
   */
  indexedSprites: number;
  /** Sprite objects that showed their previous complete picture because art of their new state had not arrived. */
  heldPictures: number;
  /**
   * Sprite objects of which a part had no art to draw from at all (its page had not arrived) and no earlier picture
   * to show instead: a first appearance that nothing announced (see LiveView.prepare).
   */
  incompletePictures: number;
  /** Voxel units, turrets and projectiles on screen with a stand-in mesh while their own is being built. */
  standInVoxels: number;
  /** Buildings whose voxel turret (TurretAnimIsVoxel) has no model, and whose model is still loading. */
  missingTurrets: number;
  pendingTurrets: number;
  /** Effect cards drawn this frame (native or HD), anims in the list without art, and their types. */
  effectCards: number;
  volumetricBlasts: number;
  effectsWithoutArt: number;
  effectTypesWithoutArt: string[];
  /** Measured logic frames per second. */
  logicFps: number;
  /** True when any live cell bridge is active; the per-kind fields distinguish incomplete coverage. */
  cellsFromEngine: boolean;
  overlaysFromEngine: boolean;
  smudgesFromEngine: boolean;
  /** Smudge types whose art or footprint could not be resolved in the current live grid. */
  smudgeTypesWithoutArt: string[];
}

/**
 * What the view was busy with when it rendered its last frame, for a host that records late frames (see
 * LiveView.activity). Counts of work in progress, and of what that one frame started.
 */
export interface LiveActivity {
  /** Atlas pages whose rows are still being copied to the GPU. */
  pageUploads: number;
  /** Voxel meshes being built and redraw projections being fetched. */
  voxelMeshes: number;
  /** Cumulative successful smooth section requests served from persistent storage / freshly built in this view. */
  voxelCacheHits: number;
  voxelMeshBuilds: number;
  /** Everything that was asked for and is not on screen yet (LiveView.loadingArt). */
  loadingArt: number;
  /** Shader modules and render pipelines the last frame had the backend create; null when they cannot be counted. */
  shaders: number | null;
  pipelines: number | null;
  /** Kinds of object ("building:NAREFN") whose first visual was built in the last frame, at most eight. */
  newKinds: string[];
  /** Measured logic frames per second. */
  logicFps: number;
}

/**
 * Initial hour: an explicit time, else the preset's day hour, else the map's staging. Only authored dusk keeps its own
 * hour under a preset: night maps are lit like day maps (the engine grade is their night, lighting.ts profileKeys) and
 * airless maps keep their noon brightness at any hour (Lighting.update), so both take the hour the look was tuned at.
 */
export function liveTimeOfDay(
  atmosphere: Pick<AtmosphereProfile, 'kind' | 'hour' | 'airless'>,
  options: Pick<LiveViewOptions, 'timeOfDay' | 'dayHour'>,
): number {
  if (options.timeOfDay !== undefined) return options.timeOfDay;
  return atmosphere.kind !== 'dusk' && options.dayHour !== undefined ? options.dayHour : atmosphere.hour;
}

/** Runtime presentation changes (no reload): time, weather and the night dressing switches. */
export interface LiveEnvironment {
  timeOfDay?: number;
  weather?: Weather;
  weatherIntensity?: number;
  lamps?: AtmosphereSettings['lamps'];
  windows?: boolean;
  lights?: boolean;
  mist?: number;
}

const UNIT_FOUNDATION = [1, 1] as const;
const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/** Cells of the map's own tiberium overlays (the static map cache's self-lit overlays), ascending. */
export function staticTiberiumCells(
  objects: readonly Pick<MapObject, 'kind' | 'lighting' | 'x' | 'y'>[],
  terrain: { width: number; height: number; exists: Uint8Array },
): Int32Array {
  const cells = new Set<number>();
  for (const object of objects) {
    if (!isUnlitMapOverlay(object)) continue;
    const { x, y } = object;
    if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) continue;
    const cell = y * terrain.width + x;
    if (terrain.exists[cell]) cells.add(cell);
  }
  return Int32Array.from([...cells].sort((a, b) => a - b));
}
/** A logic-frame move longer than this (cells) is a teleport (chrono, reinforcement) and is not interpolated. */
const TELEPORT_CELLS = 3;
/**
 * Motion playout (see LiveView.scheduleMotion and render). Snapshots of a 20 Hz logic arrive 30 to 75 ms apart
 * (emulator slices plus the bridge's poll), so interpolating each step over the last arrival interval stalled a moving
 * unit when the next snapshot was late and jumped it forward when one was early: on a cruising tank 6 to 10 % of the
 * presented frames showed no movement and the per-frame speed varied by 45 to 80 % of its mean.
 *
 * Each step is instead played at an even speed from the poses on screen to the newest snapshot, which is due at
 * ideal(frame) + (1 + MOTION_MARGIN) periods. ideal(frame) is the arrival time of a logic frame on a clock that
 * advances one smoothed period per logic frame and follows the real arrivals only slowly, so an early or late
 * snapshot no longer changes the speed: it only uses up (or adds to) the margin. A snapshot later than the margin has
 * already let the units come to rest, so the clock moves to it at once (the margin grows quickly and shrinks slowly,
 * like a jitter buffer). Replayed on recorded arrivals this leaves no stalled frame on a cruising tank and a speed
 * variation of 7 to 20 %. The camera scrolls on the same clock (see LiveView.cameraShown), so units stay on their
 * ground while the map pans.
 */
/** Share of a logic period by which a step's end trails the next frame's expected arrival (the jitter it absorbs). */
const MOTION_MARGIN = 0.25;
/** Weight of a new arrival interval in the smoothed logic period, and the plausible range of one period (ms). */
const MOTION_PERIOD_BLEND = 0.1;
const MOTION_PERIOD_MIN = 15;
const MOTION_PERIOD_MAX = 250;
/** Share of an arrival's earliness or small lateness the clock follows per logic frame. */
const MOTION_CLOCK_GAIN = 0.1;
/** A snapshot this many periods ahead of the clock (a resumed tab, a faster game speed) restarts it. */
const MOTION_RESYNC = 4;
/** A step of n logic frames (n capped at MOTION_CATCH_UP) plays over at least this share of n periods. */
const MOTION_MIN_STEP = 0.5;
const MOTION_CATCH_UP = 4;
/** Poses presented longer ago than this (ms) are not continued from then: the page was hidden or stalled. */
const MOTION_PRESENT_GAP = 40;
/** Units standing on a ramp read within this height (world units) of the surface: corner ramps are not planes. */
const GROUND_TOLERANCE = 0.3 * LEVEL_HEIGHT;
/** An object that moved within this many logic frames is walking (its walk frames play). */
const WALK_FRAMES = 2;
/** Buildings first seen after this many logic frames of the view were just placed (their build-up plays). */
const BUILDUP_GRACE_FRAMES = 60;
/**
 * Build-up length without the bridge's build state (H2): rules [General] BuildupTime=0.06 min is 54 logic frames at
 * 900 per minute, spread over the make anim with a whole number of logic frames per frame (floor(54 / frames), at least
 * one), stretched like a Normalized anim (NORMALIZED_RATE_FACTOR) only for buildings whose art says Normalized=yes.
 * Measured on an MCV deploy with the guest frame counter read around each screenshot: the construction yard (29-frame
 * GACNSTMK, art not Normalized) went from its first make frame to the finished building in 23 to 35 logic frames,
 * i.e. one logic frame per make frame; a normalized power plant (GAPOWRMK) placed shortly before frame 32064 had
 * finished by about 32155. H2 gives the engine's own frame.
 */
const BUILDUP_LOGIC_FRAMES = 54;
export function buildupStepFrames(makeFrames: number, normalized = false): number {
  const plain = Math.max(1, Math.floor(BUILDUP_LOGIC_FRAMES / Math.max(1, makeFrames)));
  return normalized ? Math.max(1, Math.round(plain * NORMALIZED_RATE_FACTOR)) : plain;
}

interface Timed {
  snapshot: LiveSnapshot;
  at: number;
  byUid: Map<number, LiveObject>;
}

interface Visual {
  engulf?: EngulfObject;
  painter?: PainterObject;
  /** Resolved art type, including an engine-selected image or its rules-type fallback. */
  type: string;
  /** The redraw page variant a voxel unit is painted with ('' or absent: the pages as drawn), see artVariant. */
  variant?: string;
  /** Extracted turret selection actually drawn (zero when unavailable in an older cache). */
  turretIndex?: number;
  paletteKey: string;
  root: Group;
  turret?: Group;
  /** How it is drawn: a 3D voxel model, sprites from the map cache or the type library, or nothing (no art). */
  mode: 'voxel' | 'map-sprite' | 'library-sprite' | 'placeholder';
  /** Map-cache sprite id (mode 'map-sprite'). */
  sprite?: string;
  libraryType?: LibraryType;
  /** Library art still loading: the visual is rebuilt once it arrives. */
  pending?: boolean;
  /** Logic frame the object was first seen on, and when it last changed position. */
  firstFrame: number;
  lastMoveFrame?: number;
  /** Logic frame of the object's last shot (bridge fire events), for firing frames. */
  firedFrame?: number;
  /** Logic frame its health first read 0 (infantry death fallback). */
  deadFrame?: number;
  /** A building's voxel turret (library turretVoxel), once its model has loaded. */
  buildingTurret?: VoxelUnit;
  /** Whether the building's turret model is drawn, still loading or missing (diagnostics). */
  turretState?: 'ready' | 'loading' | 'missing';
  /** The type's alternate image (library unloadingVoxel) has been loaded ahead of its first use, or has none. */
  alternateWarm?: boolean;
  /** Presented motion of a mobile object (see MOTION_MARGIN). */
  motion?: Motion;
  /** Clock of the frame that built this visual (LiveView.lastRender), see LiveView.activity. */
  builtAt?: number;
  /** The last complete picture of a sprite object, kept while pages of its type are on their way (HeldPicture). */
  held?: HeldPicture;
  /** Every atlas page of the type has arrived (or failed): no sprite of the object can lack a source any more. */
  pagesIn?: boolean;
}

/** The sprites queued for the object being drawn, while pages of its type are on their way (see beginPicture). */
interface Picture {
  sprites: SpriteInstance[];
  indexed: boolean[];
  /** Batch key each sprite was queued under. */
  keys: number[];
  count: number;
  /** A sprite other than a shadow had no page to draw from. */
  incomplete: boolean;
}

/** Engine pose with 16-bit facings kept unwrapped as numbers, and the body's up vector when the game reports it. */
interface MotionPose {
  x: number;
  y: number;
  z: number;
  facing: number;
  turret: number;
  tilt: boolean;
  ux: number;
  uy: number;
  uz: number;
}

interface Motion {
  /** The newest snapshot this object's current step leads to. */
  segment: Timed | null;
  /** Pose the step started from, when one was being shown. */
  from: MotionPose;
  hasFrom: boolean;
  /** Pose of the last presentation. */
  shown: MotionPose;
  hasShown: boolean;
}

const motionPose = (): MotionPose => ({ x: 0, y: 0, z: 0, facing: 0, turret: 0, tilt: false, ux: 0, uy: 0, uz: 1 });
/** Scratch of presentPose: the previous snapshot's pose of an object without a shown one, and the body's up vector. */
const POSE_START = motionPose();
const POSE_UP = new Vector3();
const newMotion = (): Motion => ({
  segment: null,
  from: motionPose(),
  hasFrom: false,
  shown: motionPose(),
  hasShown: false,
});

/** Interpolated engine pose: leptons and a facing in radians. */
interface Pose {
  x: number;
  y: number;
  z: number;
  facing: number;
}

/**
 * A map cell's sprite (overlay, smudge) with its lighting class (MapObject.lighting), for sprite layers that light by
 * class; layers without map lighting ignore it.
 */
type CellSprite = SpriteInstance & { lighting?: MapObject['lighting'] };

/** Sprite instances per atlas: 'map' for the map cache's atlas, page numbers for type library pages. */
type SpriteBatch = Map<'map' | number, SpriteInstance[]>;
const EMPTY_SPRITES: readonly SpriteInstance[] = [];
type StandInPage = { texture: Texture; width: number; height: number };

/**
 * One texel of the kind of an indexed library page or a lit-window mask (one channel, never filtered): what a warm
 * layer holds in place of a page. three writes a texel load or a filtered sample into the shader by the texture's
 * filters, so the stand-in for a page must be of the page's sampling class (materialSlots.ts samplingClass).
 */
function warmPageTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One texel of the kind of an HD page: filtered, like the colour art (sRGB), its house-paint mask (one channel) and
 * the material page (linear RGBA) the loaders make (loadHdTexture, loadSpriteMaterialAtlas).
 */
function warmFilteredTexture(kind: 'colour' | 'mask' | 'data'): DataTexture {
  const texture =
    kind === 'mask'
      ? new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType)
      : new DataTexture(new Uint8Array(4), 1, 1);
  texture.colorSpace = kind === 'colour' ? SRGBColorSpace : NoColorSpace;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
const EMPTY_LAYERS: readonly LibraryAnimLayer[] = [];
const EMPTY_IDS: readonly string[] = [];

/**
 * A sprite instance with its object light: ra2/sprites.ts multiplies the art by `light` (SpriteInstance.light, 1 when
 * absent) where the sprite layer supports it.
 */
type ObjectSprite = SpriteInstance & { light?: number };

/**
 * Extra object light of SHP art on top of the map's: rules [AudioVisual] ExtraInfantryLight / ExtraUnitLight /
 * ExtraAircraftLight (0.2 in YR) for infantry, SHP vehicles and aircraft; buildings get none (the rules have no
 * building value). Same-moment XMP29U2 captures, screen colour over palette colour on the engine's framebuffer: player
 * and AI infantry 1.16-1.29x, while the player's construction yard sits at 0.96x next to civilian buildings at
 * 0.96-1.01x. Brighter buildings elsewhere on that map (a construction yard at 1.25x) stand near lamp posts: map
 * light sources, not object light.
 */
export function objectLight(kind: LiveKind): number {
  if (kind === 'infantry') return 1 + EXTRA_LIGHT.infantry;
  if (kind === 'aircraft') return 1 + EXTRA_LIGHT.aircraft;
  if (kind === 'vehicle') return 1 + EXTRA_LIGHT.unit;
  return 1;
}

/**
 * Houses that are civilian: the bridge's flag where given; otherwise houses that own buildings none of which players
 * build (no make anim). Players own at least one buildable building once their base stands and none before it (an MCV
 * is a vehicle), so they never qualify; a player left with nothing but captured tech buildings would. Without the type
 * library nothing can be inferred and no house counts as civilian.
 */
export function civilianHouses(
  snapshot: Pick<LiveSnapshot, 'houses' | 'objects'>,
  buildable: ((type: string) => boolean | undefined) | null,
): Set<number> {
  const out = new Set<number>();
  const flagged = new Set<number>();
  for (const house of snapshot.houses)
    if (house.civilian !== undefined) {
      flagged.add(house.index);
      if (house.civilian) out.add(house.index);
    }
  if (!buildable) return out;
  const owners = new Set<number>();
  const builders = new Set<number>();
  for (const object of snapshot.objects) {
    if (object.kind !== 'building' || object.owner < 0 || flagged.has(object.owner)) continue;
    owners.add(object.owner);
    if (buildable(object.type)) builders.add(object.owner);
  }
  for (const owner of owners) if (!builders.has(owner)) out.add(owner);
  return out;
}

const CAPTURABLE = new Set(CAPTURABLE_BUILDINGS);
const NORMALIZED = new Set(NORMALIZED_BUILDINGS);

/** Anims every battle shows (explosions, impacts, muzzle flashes, trail smoke, fires): their pages are preloaded. */
const COMBAT_ANIMS = /^(TWLT|S_|EXPLO|GUNFIRE|PIFF|MGUN|VTMUZZLE|SMOKEY|FIRE0)/;

/**
 * Whether a building layer stands still on its first frame although the fallback would play it. Capturable tech
 * buildings (oil derrick, airport, tech power plant ...) owned by a civilian house keep their powered layers (art
 * <key>Powered, default yes) still until a player captures them: in every reader dump CAOILD_A and CAAIRP_A only ever
 * showed frame 0 under the Neutral house, while their unpowered flames (CAOILD_F, CAAIRP_F) and the civilian flag
 * CAUSFGL_A (not capturable) cycle.
 */
export function layerIdle(layer: Pick<LibraryAnimLayer, 'powered'>, type: string, civilianOwner: boolean): boolean {
  return civilianOwner && layer.powered !== false && CAPTURABLE.has(type);
}

/**
 * World units a building's voxel turret is pulled towards the camera beyond its body card's own push: about its half
 * depth, so the part of the turret behind its pivot still draws over the body (the engine draws it after the body).
 */
const TURRET_DEPTH = 0.45;

/** Live sprite instances (buildings: body, bib, shadow, anim layers). */
const LIVE_SPRITE_CAPACITY = 4096;

/**
 * Pixels of freshly decoded atlas pages copied to the GPU per rendered frame (see PageUploader): 8 M pixels, a
 * 4096 x 2048 strip, 32 MiB. Measured in an otherwise idle page, such a strip costs 1 to 6 ms and a whole 8192 x 8096
 * page 16 ms; next to a running match the same whole page held the thread for 100 to 330 ms, most of it waiting for
 * the GPU process to take the data, and 32 M pixel strips still for 80 to 275 ms.
 */
export const UPLOAD_PIXELS_PER_FRAME = 8 << 20;
/** The frame time the per-frame budgets are meant for (a 60 Hz display). */
const FRAME_MS = 1000 / 60;

/**
 * Instance capacity of a cell layer (overlays, smudges) that holds `count` sprites now. A layer cannot grow: its
 * instance buffers are part of its shader graph, so a fuller one is a new layer whose materials are built again
 * (measured: about 50 ms of shader building per layer, a frame of 100 ms when two ore pages grew by two cells in a
 * match's first second). Room for twice the current count makes that rare: ore that spreads, craters that add up.
 */
export function cellLayerCapacity(count: number, current = 0): number {
  return Math.max(64, current, 2 ** Math.ceil(Math.log2(Math.max(1, count) * 2)));
}
/** Legacy fallback only; native buildingFrame includes civilian, occupancy and gate policies. */
const CONDITION_YELLOW = 0.5;

/** Stand-in sizes (world units) for the development placeholder of objects without art. */
const PLACEHOLDER: Record<LiveKind, [number, number, number]> = {
  building: [0.9, 0.55, 0.9],
  vehicle: [0.55, 0.25, 0.38],
  infantry: [0.14, 0.3, 0.14],
  aircraft: [0.6, 0.12, 0.6],
};
/** The development placeholder is neutral grey at 40 % size: it must never read as a house-coloured unit. */
const DEBUG_PLACEHOLDER_COLOUR = 0x808080;
const DEBUG_PLACEHOLDER_SCALE = 0.4;

/**
 * Building layers the fallback draws (without the bridge's building anim list): the always-on ones. ActiveAnim and
 * IdleAnim always; ActiveAnimTwo..Four too, except on ore storage buildings (refineries, silos), where they are the
 * house's storage level (an idle NAREFN's native list holds only NAREFNL1, run3) while on other buildings they run
 * constantly (CAOILD_F, CAAIRP_F and NACNST_C are in every native list). Production, special, super-weapon and
 * low-power layers need engine state and stay off.
 */
export function fallbackLayer(layer: Pick<LibraryAnimLayer, 'key'>, storesOre: boolean): boolean {
  if (layer.key === 'ActiveAnim' || layer.key === 'IdleAnim') return true;
  return !storesOre && /^ActiveAnim(Two|Three|Four)$/.test(layer.key);
}

/** Refinery-like layer set (a numbered ActiveAnim series such as NAREFNL1..L4), for when the rules flag is unknown. */
const STORAGE_LAYERS = new WeakMap<readonly Pick<LibraryAnimLayer, 'key' | 'sprite'>[], boolean>();
export function looksLikeStorage(layers: readonly Pick<LibraryAnimLayer, 'key' | 'sprite'>[]): boolean {
  const known = STORAGE_LAYERS.get(layers);
  if (known !== undefined) return known;
  const series = layers.filter((l) => /^ActiveAnim(Two|Three|Four)?$/.test(l.key)).map((l) => l.sprite);
  const result = series.length > 1 && series.every((s, i) => new RegExp(`${i + 1}$`).test(s));
  STORAGE_LAYERS.set(layers, result);
  return result;
}

/**
 * Stage of a building layer at logic frame `frame` without the bridge: the anim's own step length (animRateFrames from
 * art Rate=/Normalized=, the sidecar's value when known) over its loop. Returns the SHP frame.
 */
export function layerFrame(
  layer: Pick<LibraryAnimLayer, 'anim'>,
  frames: number,
  frame: number,
  rateFrames?: number,
  normalized = false,
): number {
  const first = Math.min(frames - 1, Math.max(0, layer.anim.loopStart ?? layer.anim.start ?? 0));
  const last = Math.min(frames, Math.max(first + 1, layer.anim.loopEnd ?? layer.anim.end ?? frames));
  const step = Math.floor(frame / Math.max(1, rateFrames ?? animRateFrames(layer.anim.rate, normalized)));
  return first + (step % (last - first));
}

/**
 * `value` (engine pixels) on the nearest multiple of one drawing-buffer pixel, `pixelsPerUnit` of which cover an engine
 * pixel; unchanged without a usable scale.
 */
export function snapToPixelGrid(value: number, pixelsPerUnit: number): number {
  return pixelsPerUnit > 0 && Number.isFinite(pixelsPerUnit)
    ? Math.round(value * pixelsPerUnit) / pixelsPerUnit
    : value;
}

export class LiveView {
  private previous: Timed | null = null;
  private current: Timed | null = null;
  /** The current snapshot is warm()'s own list, not a match (see warm). */
  private warming = false;
  /** The list warm() was given, until it has been drawn completely once or the match runs (see push). */
  private warmList: readonly LiveWarmType[] | null = null;
  /** Logic frame of the first match snapshot the list was drawn alongside. */
  private warmFirstFrame: number | null = null;
  /** The current snapshot is a match snapshot with the list's objects added. */
  private warmMerged = false;
  /** The newest match snapshot as the host pushed it (without the list's objects). */
  private matchSnapshot: LiveSnapshot | null = null;
  /** Presented frames in a row that drew everything their snapshot asked for (see `settledFrames`). */
  private settled = 0;
  /**
   * True while the host keeps this view out of sight (the original picture is on screen, or the game still loads).
   * Out of sight nothing has to be drawn early, so art that arrives in steps (a page, then its material page, or a
   * voxel model's stand-in mesh and then its own) is waited for instead of building it twice. A shown view never
   * waits: what the game shows is drawn with the best art that is there.
   */
  get outOfSight(): boolean {
    return this.hiddenFromSight;
  }
  set outOfSight(value: boolean) {
    if (value === this.hiddenFromSight) return;
    this.hiddenFromSight = value;
    // The next stretch out of sight (another match on this map) warms again: only what is new is built.
    if (value) this.warmStage = 0;
    // What waited out of sight is drawn in the next frame, with or without a new snapshot (a paused match).
    this.objectsFor = null;
  }
  private hiddenFromSight = false;
  /** Warm-ups done in this stretch out of sight (see render): 0 none, 1 with the scene, 2 with the match's opening. */
  private warmStage = 0;
  /** Hidden, empty layers of the shader graphs a library page's layers draw with (see warmStandIns), by graph. */
  private readonly standInWarm = new Map<string, SpriteLayer>();
  private standInWarmPage: DataTexture | null = null;
  /** The one-texel pages the warm HD layers hold: colour, house-paint mask, material page. */
  private standInWarmHd: { colour: DataTexture; mask: DataTexture; data: DataTexture } | null = null;
  /**
   * How many new kinds of art (a voxel model in a house's colours, a sprite page's layer) one frame may add to the
   * scene while the view is out of sight. Each brings shaders that are built in the frame that first draws it, 30
   * to 120 ms apiece: all of a match's opening in one frame is a second or more during which the page presents
   * nothing, the picture it shows instead included (measured: 0.83 and 1.3 s). One per frame builds them just as
   * fast (the builds are what takes the time) and keeps that other picture moving. The rest waits its turn and
   * counts as art on its way (loadingArt), so the view is not shown before it is in. A shown view never waits.
   * Not scaled with the frame time: a build is this thread's own work, and a late frame that may build more is
   * followed by a later one (tried: 0.8 s frames).
   * A host that knows nothing moves on screen (a loading screen) sets Infinity: every frame it does not have to
   * render in between is time saved.
   */
  newArtPerFrame = 1;
  /**
   * Pixels of decoded atlas pages copied to the GPU per frame while the view is out of sight. Infinity uploads every
   * page in the frame after it was decoded, for a host that knows nothing moves on screen (see newArtPerFrame).
   */
  hiddenUploadPixels = UPLOAD_PIXELS_PER_FRAME;
  /** Requests more of the library's voxel model files; null once every one has been requested (see render). */
  private fetchAhead: (() => boolean) | null = null;
  /** New kinds added in the frame being drawn, and kinds that had to wait for a later frame. */
  private newArt = 0;
  private waitingArt = 0;
  /** Rules types asked for ahead of their first object (see prepare), and what is still on its way for them. */
  private readonly preparedTypes = new Set<string>();
  private readonly aheadPages = new Set<number>();
  private readonly aheadVoxels = new Set<string>();
  /** Set while applyObjects draws a sprite object whose type still waits for pages (see beginPicture). */
  private picture: Picture | null = null;
  private readonly pictureScratch: Picture = { sprites: [], indexed: [], keys: [], count: 0, incomplete: false };
  private readonly pictureBase = new Vector3();
  /** Per flush: sprites of pages whose final layer is not there, by page (see flushSprites). */
  private readonly indexedMeanwhile = new Map<number, SpriteInstance[]>();
  /**
   * Shader modules and pipelines created in the frame whose clock is `at` (see countCompilations); null when the
   * backend's creations cannot be counted.
   */
  private compiled: { at: number; shaders: number; pipelines: number } | null = null;
  /** Counted while objects are applied and flushed, for diagnostics(). */
  private indexedSprites = 0;
  private heldPictures = 0;
  private incompletePictures = 0;
  /** Copies decoded atlas pages to the GPU a strip per frame; stepped by render(). */
  private readonly pageUploads: PageUploader;
  /** Bounds the decoded atlas pages waiting for their upload (library, effect and material pages alike). */
  readonly pageGate = new PageGate();
  private readonly visuals = new Map<number, Visual>();
  private buildingVisualHistory?: BuildingVisualHistory;
  /** Building appearance by match-unique UID; tolerate brief omissions without retaining every dead object. */
  private readonly appearances = new Map<number, { frame: number; afterGap: boolean; lastSeen: number }>();
  private readonly spriteBatch: SpriteBatch = new Map();
  private readonly spritePool = new SpritePool();
  private readonly painterObjects: PainterObject[] = [];
  private painterDirty = false;
  private readonly cellPool = new SpritePool();
  private readonly cellInstances: CellSprite[] = [];
  private readonly effectInstances: EffectInstance[] = [];
  private readonly engulfFires: EngulfFire[] = [];
  private readonly engulfBounds: EffectDisplayBounds = { x: 0, y: 0, width: 0, height: 0 };
  private readonly engulfRight = new Vector3();
  private readonly engulfUp = new Vector3();
  private engulfActive = false;
  private readonly spriteCaptureCode = (instance: SpriteInstance) =>
    this.visuals.get(instance.painter?.uid ?? -1)?.engulf?.code ?? NOT_CAPTURED_CODE;
  private readonly classifyFireEngulf = () => this.updateFireEngulf();
  private readonly volumeInstances: VolumetricBlast[] = [];
  readonly volumetricBlasts: VolumetricBlastLayer;
  private readonly pose: Pose = { x: 0, y: 0, z: 0, facing: 0 };
  /** Turret facing (radians) and body up vector (world axes) of the pose above; null = follow the terrain. */
  private poseTurret = 0;
  private poseUp: Vector3 | null = null;
  /** Smoothed arrival interval of one logic frame (ms) and the de-jittered arrival time of the newest one. */
  private motionPeriod?: number;
  private motionClock?: { frame: number; time: number };
  /** The current step: when the poses it starts from were presented and when it reaches the newest snapshot. */
  private motionStart = 0;
  private motionEnd?: number;
  /**
   * The camera plays each logic step on the same clock as the units (scheduleMotion): from the view last presented
   * (cameraShown, unsnapped engine pixels) to the newest snapshot's. Blended over the last arrival interval instead, it
   * reached a snapshot early after a short poll gap and stood still, and leapt after a long one (round 9e #14: per-frame
   * scroll steps from 0 to 3 times the mean on a held arrow key).
   */
  private cameraShown?: { x: number; y: number } | null;
  private cameraFrom?: { x: number; y: number } | null;
  private readonly shpPose: ReturnType<typeof shpUnitPose> = { state: 'stand', step: 0 };
  private readonly hidden = (x: number, y: number, z: number): boolean => this.shroud.isLocationShrouded(x, y, z);
  private readonly effectPalette = (resolved: ResolvedAnim, owner: number | undefined): string =>
    this.animPalette(resolved, owner);
  private readonly buildingAnimMatches = new Map<number, LiveAnim[]>();
  private objectsFor: Timed | null = null;
  private objectsAlpha = -1;
  private objectsInterpolate = false;
  private objectLibraryRevision = -1;
  private objectArtRevision = -1;
  private objectsWindows = false;
  private objectsMaterials = false;
  private effectArtRevision = -1;
  private readonly root = new Group();
  private readonly voxelUnits: VoxelUnits;
  private readonly placeholderGeometry = new BoxGeometry(1, 1, 1);
  private placeholderMaterial: MeshStandardNodeMaterial | null = null;
  private readonly housePalettes = new Set<number>();
  private readonly housePaletteKeys = new Map<number, string>();
  private readonly libraryPaletteKeys = new Map<string, string>();
  private readonly houseColour = new Map<number, number>();
  private readonly sprites: SpriteLayer;
  private readonly pageLayers = new Map<number, { layer: SpriteLayer; windows: boolean; materials: boolean }>();
  private readonly shroud: ShroudLayer;
  private readonly effectDriver: LiveEffectsDriver;
  private readonly liveBeams: LiveBeams;
  private readonly effectArt: EffectArt | null;
  private readonly effectSprites: EffectSpriteLayer | null;
  private readonly projectiles: Projectiles | null;
  /** Map overlays and smudges (ore, walls, craters), owned here so runtime cell changes can replace them. */
  private readonly cellLayer: SpriteLayer;
  private readonly cellObjects = new Map<number, MapObject[]>();
  private cellsDirty = true;
  private readonly overlayInstances: OverlayInstanceCache;
  /** The engine's ore/gem glints (see LiveViewOptions.oreGlints); null when switched off. */
  private readonly glints: { state: CellGlints; layer: GlintLayer } | null;
  /** Map cells that carry a glint: the live tiberium overlays, or the map's own ore until those are published. */
  private glintCells: Int32Array = new Int32Array(0);
  private readonly glintAnchor = new Vector3();
  /** `indexed`: built from the indexed page while the page's HD art loads (a shown view), to be rebuilt with it. */
  private readonly overlayLayers = new Map<number, { layer: SpriteLayer; materials: boolean; indexed?: boolean }>();
  private readonly uploadedOverlays = new Map<number, readonly SpriteInstance[]>();
  private overlayPagesDirty = false;
  private readonly warnedOverlayTypes = new Set<string>();
  private readonly warnedOverlayPages = new Set<number>();
  private warnedOverlayLibrary = false;
  private readonly smudgeInstances: SmudgeInstanceCache;
  private readonly smudgeLayers = new Map<SmudgePage, SpriteLayer>();
  /** Smudge layers built from the indexed page while the page's HD art loads (see overlayLayers). */
  private readonly indexedSmudgeLayers = new Set<SmudgePage>();
  private readonly uploadedSmudges = new Map<SmudgePage, readonly SpriteInstance[]>();
  private smudgePagesDirty = false;
  private readonly warnedSmudgeTypes = new Set<string>();
  private readonly warnedSmudgePages = new Set<number>();
  private warnedSmudgeLibrary = false;
  /** Whether the host has reported engine cells (bridge H3); without them ore and walls stay as the map started. */
  private cellsFromEngine = false;
  private warnedCells = false;
  private firstMissingCellsAt: number | undefined;
  private publishedCells = false;
  private readonly wind = new Vector3(Math.cos(0.6), 0, Math.sin(0.6)).multiplyScalar(0.3 * 0.8);
  private readonly warnedTypes = new Set<string>();
  private viewWidth = 800;
  /** Drawing-buffer pixels per engine pixel (see frame()). */
  private bufferScale = 1;
  private readonly bufferSize = new Vector2();
  private viewHeight = 600;
  private lastRender = performance.now();
  private firstFrame: number | null = null;
  private effectStats = { drawn: 0, missing: 0 };
  /** Civilian houses of the newest snapshot (see civilianHouses). */
  private civilian = new Set<number>();
  /** Rebuilt on snapshot/art changes, never for an interpolation-only presentation. */
  private refineryCells = new Set<string>();
  /**
   * The newest snapshot's building anims (bridge flag buildingAnim) by the cell they stand on and by the object they
   * are attached to, with their list index; null when the host flags none (the fallback layers are drawn then).
   * Built once per snapshot, read by every building on every presented frame.
   */
  private buildingAnims: {
    cells: Map<number, [number, LiveAnim][]>;
    attached: Map<number, [number, LiveAnim][]>;
  } | null = null;
  /** Snapshot whose effect cards are on screen; asynchronous art has its own revision. */
  private effectsFor: Timed | null = null;
  private effectsDirty = false;
  /** Particle anchors have the effect snapshot lifetime, never the interpolated object batch lifetime. */
  private readonly particlePool = new SpritePool();
  /**
   * Identity of the light-emitting and window-lit building sets last handed to the night dressing. Null until the
   * first snapshot, which always replaces the sidecar's map-placed sources (even when it has none).
   */
  private lightKey: string | null = null;
  /** Whether the engine supplied the grade's light list when lightKey was last applied, and that list's identity. */
  private lightKeyEngine = false;
  private engineLightKey: string | null = null;
  /** Created on first use (see updateLightBase). */
  private lightBase?: NormalLightFollower;
  private windowKey: string | null = null;
  private blockedKey: string | null = null;

  private readonly sceneMedianZ: number;

  private scenePresentation(lighting: Ra2SceneLighting | null | undefined, skyFlash = 0): SceneLighting | null {
    if (!lighting) return null;
    const mapLight = this.world.mapLight;
    return ra2SceneLighting(
      mapLight?.lighting ?? this.state.map.lighting,
      lighting,
      this.sceneMedianZ,
      skyFlash,
      mapLight?.base,
    );
  }

  /**
   * The map light grade follows the live normal [Lighting] once it has held (NormalLightFollower): the engine adds
   * its light sources (radiation, lamps) to the live ambient, so a grade built from the authored light and scaled by
   * live / authored dimmed them with it (B2 #7a: a night edit's radiation glow at 40-50 % of the original's).
   */
  private updateLightBase(snapshot: LiveSnapshot): void {
    const mapLight = this.world?.mapLight;
    if (!mapLight) return;
    const normal = (this.lightBase ??= new NormalLightFollower()).update(snapshot.lighting, snapshot.frame);
    if (normal) mapLight.setBase(normal);
  }

  private constructor(
    readonly hd: HdRenderer,
    readonly world: HdWorld,
    private readonly cache: Ra2Cache,
    private readonly options: LiveViewOptions,
    private readonly library: LiveLibrary | null,
    private readonly state: RenderState,
  ) {
    hd.enablePainterDepth();
    hd.beforeDepthCapture = this.classifyFireEngulf;
    this.root.name = 'live-objects';
    hd.scene.add(this.root);
    this.voxelUnits = new VoxelUnits(hd, world, cache, options.libraryBase, options);
    // Atlas pages go to the GPU as decoded bitmaps (no main-thread repack of their 16.7 M pixels), in strips over
    // the following frames (render() steps the uploader).
    this.pageUploads = new PageUploader(hd.renderer);
    const compiled = { at: NaN, shaders: 0, pipelines: 0 };
    const counted = countCompilations(hd.renderer.backend, (kind) => {
      // Stamped with the frame that asked for it: nothing is reset per frame.
      if (compiled.at !== this.lastRender) {
        compiled.at = this.lastRender;
        compiled.shaders = compiled.pipelines = 0;
      }
      if (kind === 'shader') compiled.shaders++;
      else compiled.pipelines++;
    });
    if (counted) this.compiled = compiled;
    // Pages are decoded inside the gate: a match start asks for dozens of pages at once (see PageGate). A page
    // loaded ahead of its use says so (`background`), to the gate and to the uploader.
    const upload: PageUpload = Object.assign(
      (texture: Texture, background?: () => boolean) => this.pageUploads.upload(texture, background),
      { gate: this.pageGate },
    );
    if (library) {
      library.uploadPage = upload;
      this.fetchAhead = () => library.preloadVoxels();
    }
    this.shroud = new ShroudLayer(world.width, world.height);
    // The shroud darkens in the renderer's post pass, after the mist and before bloom (see ShroudLayer).
    hd.setVisibility(this.shroud.mask);
    const base = options.libraryBase?.replace(/\/$/, '');
    this.effectArt = base
      ? new EffectArt(
          `${base}/common/effects`,
          cache,
          cache.manifest.theater as TheaterId,
          !!library,
          options.effectsHdBase ?? `${base}/common/effects-hd`,
        )
      : null;
    if (this.effectArt) this.effectArt.uploadPage = upload;
    // The pages of the common combat anims and smoke particles load up front, the rest on first use.
    void this.effectArt?.load().then(() => {
      this.effectArt?.preload(COMBAT_ANIMS, [...new Set(Object.values(SMOKE_SYSTEMS).map((r) => r.particle))]);
      this.effectArt?.preloadVoxels();
      if (this.effectDriver.style === 'enhanced' && this.effectDriver.hdEnabled)
        void this.effectArt?.loadHd().then(() => this.effectArt?.preloadHd(COMBAT_ANIMS));
    });
    this.effectSprites = this.effectArt
      ? new EffectSpriteLayer(
          cache,
          (page) => this.effectArt!.pageState(page),
          (page) => this.effectArt!.release(page),
          (page) => this.effectArt!.hdPageState(page),
          (page) => this.effectArt!.releaseHd(page),
          hd.terrainDepth,
        )
      : null;
    if (this.effectSprites) {
      this.root.add(this.effectSprites.root);
      hd.topScene.add(this.effectSprites.topRoot);
    }
    this.volumetricBlasts = new VolumetricBlastLayer({
      light: uniform(new Color(1, 1, 1)),
      sunDirection: spriteLookFor(hd.nodes).sunDirection,
      displayScale: this.effectSprites?.displayScale,
    });
    this.root.add(this.volumetricBlasts.root);
    this.projectiles = this.effectArt
      ? new Projectiles(this.effectArt, this.voxelUnits, this.root, (owner) => this.unitPalette(owner))
      : null;
    this.effectDriver = new LiveEffectsDriver(
      hd.effects,
      (x, y, z) => this.shroud.isLocationShrouded(x, y, z),
      (type) => !!this.effectArt?.bullet(type),
    );
    this.effectDriver.style = options.effects ?? 'faithful';
    this.effectDriver.hdEnabled = options.effectsHd !== false;
    this.effectDriver.volumetric = options.volumetricEffects ?? 'off';
    const lightingHeight = (this.sceneMedianZ = medianHeight(cache.height, cache.exists));
    this.effectDriver.onStormStrike = (at, now) => {
      const lighting = this.current?.snapshot.lighting;
      if (lighting?.event !== 'storm') return;
      const strike = stormStrikeLight(lighting, lightingHeight, hd.nodes.referenceLevel.value);
      hd.lightField.pulse(now, at, strike.colour, strike.radius, strike.peak, 0.47, 0, 'flash', {
        hold: 0.12,
        fade: 0.35,
      });
    };
    this.liveBeams = new LiveBeams(hd.effects.cameraRight, hd.effects.cameraUp, hd.effects.now);
    this.root.add(this.liveBeams.mesh);
    this.effectDriver.hasHdArt = (type) => !!this.effectArt?.hdAnim(type);
    this.effectDriver.artWidth = (type) => {
      const w = this.effectArt?.anim(type)?.art.visW;
      return w ? w / (60 / Math.SQRT2) : undefined;
    };
    // Smoke, dust and soot are lit like the original art: share the sprite layer's light level.
    if (world.sprites) hd.effects.sceneLight.value = world.sprites.light.value;
    this.sprites = new SpriteLayer(
      cache,
      [],
      LIVE_SPRITE_CAPACITY,
      undefined,
      cache.spriteAtlasHd,
      cache.windows?.texture ?? null,
      null,
      hd.terrainDepth,
    );
    this.sprites.mesh.name = 'live-sprites';
    this.root.add(this.sprites.mesh);
    this.shareSpriteUniforms(this.sprites);
    // Room for the map's own cells (each may add a shadow) plus as many again for cells the engine adds (bridge H3).
    const mapCells = cache.manifest.objects.filter((o) => o.kind === 'overlay' || o.kind === 'smudge').length;
    this.cellLayer = new SpriteLayer(
      cache,
      [],
      Math.max(4096, mapCells * 4),
      undefined,
      cache.spriteAtlasHd,
      null,
      world.spriteMaterials ?? null,
    );
    this.cellLayer.mesh.name = 'live-cells';
    this.root.add(this.cellLayer.mesh);
    this.shareSpriteUniforms(this.cellLayer);
    // LiveView.create loads only kind === 'tree' into world.sprites. Non-live world views can mix buildings there,
    // so registration belongs here, never in HdRenderer/loadRa2World. Ground-pass children keep their own layers.
    if (world.sprites) hd.terrainDepth.register(world.sprites.mesh);
    hd.terrainDepth.register(this.cellLayer.mesh);
    if (this.effectSprites) this.shareSpriteUniforms(this.effectSprites);
    this.shareSpriteUniforms(this.volumetricBlasts);
    // Effect art and procedural smoke retain the authored illumination while the scene follows palette events.
    if (this.effectSprites) this.effectSprites.light.value = hd.effectLight;
    this.volumetricBlasts.light.value = hd.effectLight;
    hd.effects.sceneLight.value = hd.effectLight;
    for (const object of cache.manifest.objects)
      if (object.kind === 'overlay' || object.kind === 'smudge') this.cellList(object.x, object.y).push(object);
    const cellTerrain = {
      width: cache.manifest.grid.width,
      height: cache.manifest.grid.height,
      levels: cache.height,
      exists: cache.exists,
    };
    this.overlayInstances = new OverlayInstanceCache(cellTerrain);
    if (options.oreGlints !== false) {
      const overlay = hd.emissiveOverlay;
      const layer = new GlintLayer(hd.nodes, overlay.cameraRight, overlay.cameraUp, overlay.toCamera);
      this.root.add(layer.mesh);
      this.glints = { state: new CellGlints(cellTerrain.width * cellTerrain.height), layer };
      this.glintCells = staticTiberiumCells(cache.manifest.objects, cellTerrain);
    } else this.glints = null;
    spriteLookFor(hd.nodes).crystalSparkle.value = Math.max(0, options.crystalSparkle ?? (this.glints ? 0 : 1));
    this.smudgeInstances = new SmudgeInstanceCache(cellTerrain, cache.manifest.sprites);
    // What the map itself places will be in the match's first snapshot: the map cache lists it, so its art starts
    // loading now, behind the loading screen, and not when the game has created the objects (see prepare).
    const placed = new Set<string>();
    for (const object of cache.manifest.objects)
      if (object.kind !== 'tree' && object.kind !== 'overlay' && object.kind !== 'smudge') placed.add(object.type);
    this.prepare(placed, false);
    this.preloadCellPages();
    this.warmStandIns();
  }

  /**
   * Put one hidden, empty layer of each shader graph a library page's sprite layers draw with into the scene.
   *
   * A shown view draws a page's sprites from the page's indexed layer while its HD art loads (flushSprites; live
   * overlay and smudge pages do the same in their own flushes), and moves them to the final layer in the flush
   * that builds it. Either layer can be the first of its shader graph (ra2/sprites.ts SpriteGraph): the stand-in
   * almost always is ("the indexed page through the palette" where every final layer draws HD art), and a final
   * layer is whenever the match's opening had no page of its look (HD art with or without a material page, with or
   * without a lit-window mask; all of them when the view was shown by the deadline before any HD page was in). A
   * graph's first layer costs what sharing a graph saves every later one: six shader builds on the thread that
   * presents the frames, and pipelines that are compiled off the frame (asyncPipelines.ts), during which the layer
   * draws nothing. Measured before this: conscripts not drawn for 15 presented frames when their HD page replaced
   * the stand-in, an overlay page for 0.65 s, and in a six-player match a page's first layer of a new look two and
   * a half minutes in, 0.2 to 0.4 s without its objects. The warm frames (HdRenderer.warm) draw what is hidden, in
   * every pass, so with these layers in the scene every such graph is built and compiled behind the loading screen,
   * and a layer made during the match is a clone of materials that are ready. A graph the opening builds anyway
   * costs nothing a second time: three finds the built shader.
   *
   * The graphs: a library page's sprites from the indexed page (pageLayer with a negative key: depth-captured), the
   * same with the lit-window mask (a night map), a live overlay or smudge page from the indexed page (no capture
   * code of its own; overlay pages are registered as occluders), both also with a material page but no HD art yet;
   * and for every look the library's HD pages have (LiveLibrary.hdPageLooks), the final layer of a page and of a
   * cell page, without and with the material page, and at night with the mask. Called again before each warm-up: the hour, and so whether masks are wanted, is
   * known only once the match's light is.
   */
  private warmStandIns(): void {
    const library = this.library;
    if (!library) return;
    const add = (key: string, build: (page: StandInPage) => SpriteLayer): void => {
      if (this.standInWarm.has(key)) return;
      const texture = (this.standInWarmPage ??= warmPageTexture());
      const layer = build({ texture, width: 1, height: 1 });
      layer.mesh.name = `live-warm-${key}`;
      layer.mesh.visible = false;
      this.shareSpriteUniforms(layer);
      this.root.add(layer.mesh);
      this.standInWarm.set(key, layer);
    };
    const captured = (layer: SpriteLayer): SpriteLayer => {
      // An empty layer captures nothing by itself (SpriteLayer.updateCaptureCodes): the capture pass of a warm frame
      // must still meet both captured meshes.
      this.hd.terrainDepth.setCaptured(layer.mesh, true);
      this.hd.terrainDepth.setCaptured(layer.unitMesh, true);
      return layer;
    };
    const occluder = (layer: SpriteLayer): SpriteLayer => {
      this.registerOverlayOccluder(layer);
      return layer;
    };
    const depth = this.hd.terrainDepth;
    const windowsWanted = this.hd.windowsWanted();
    // The arguments are pageLayer's for an indexed-only layer, by day and with the mask.
    add('page', (page) => captured(new SpriteLayer(this.cache, [], 1, page, null, null, null, depth)));
    if (library.windows && windowsWanted)
      add('page-windows', (page) =>
        captured(new SpriteLayer(this.cache, [], 1, page, null, page.texture, null, depth)),
      );
    // flushSmudgePages' and flushOverlayPages' layer of a page whose HD art is still loading.
    add('cells', (page) => occluder(new SpriteLayer(this.cache, [], 1, page, null)));
    // The final layers: pageLayer's arguments for a page with its HD art, flushOverlayPages' / flushSmudgePages' for
    // a cell page, in each state a shown view can build them (the material page and the mask may come later).
    const looks = library.hdPageLooks();
    if (!looks.length) return;
    const materialsWanted = this.hd.materialsWanted();
    const textures = (this.standInWarmHd ??= {
      colour: warmFilteredTexture('colour'),
      mask: warmFilteredTexture('mask'),
      data: warmFilteredTexture('data'),
    });
    const material = { texture: textures.data };
    // A stand-in whose material page arrives before its HD art is rebuilt with it (pageLayer keeps attached
    // sidecars, flushOverlayPages passes the material page whatever the colour page is): two more graphs, seen
    // being built 35 s into a six-player match (an overlay page: six shader builds, one frame of 0.17 s).
    if (materialsWanted && looks.some((look) => look.materials)) {
      add('page-materials', (page) => captured(new SpriteLayer(this.cache, [], 1, page, null, null, material, depth)));
      add('cells-materials', (page) => occluder(new SpriteLayer(this.cache, [], 1, page, null, null, material)));
      if (library.windows && windowsWanted)
        add('page-windows-materials', (page) =>
          captured(new SpriteLayer(this.cache, [], 1, page, null, page.texture, material, depth)),
        );
    }
    // One graph family per house-paint saturation and minification filter (pages above 2x are supersampled).
    const families = new Map<string, { paintSaturation: number; supersample: boolean }>();
    for (const look of looks) {
      const supersample = !!look.supersample;
      families.set(`${look.paintSaturation}|${supersample}`, { paintSaturation: look.paintSaturation, supersample });
    }
    for (const { paintSaturation, supersample } of families.values()) {
      const hd: HdAtlas = {
        color: textures.colour,
        remap: textures.mask,
        paintSaturation,
        ...(supersample ? { scale: HD_SUPERSAMPLE_ABOVE_SCALE * 2 } : {}),
      };
      const mine = looks.filter(
        (look) => look.paintSaturation === paintSaturation && !!look.supersample === supersample,
      );
      const key = `hd${paintSaturation}${supersample ? '-ss' : ''}`;
      add(`page-${key}`, (page) => captured(new SpriteLayer(this.cache, [], 1, page, hd, null, null, depth)));
      add(`cells-${key}`, (page) => occluder(new SpriteLayer(this.cache, [], 1, page, hd)));
      const materials = materialsWanted && mine.some((look) => look.materials);
      if (materials) {
        add(`page-${key}-materials`, (page) =>
          captured(new SpriteLayer(this.cache, [], 1, page, hd, null, material, depth)),
        );
        add(`cells-${key}-materials`, (page) => occluder(new SpriteLayer(this.cache, [], 1, page, hd, null, material)));
      }
      if (!windowsWanted || !mine.some((look) => look.windows)) continue;
      add(`page-${key}-windows`, (page) =>
        captured(new SpriteLayer(this.cache, [], 1, page, hd, page.texture, null, depth)),
      );
      if (materialsWanted && mine.some((look) => look.windows && look.materials))
        add(`page-${key}-windows-materials`, (page) =>
          captured(new SpriteLayer(this.cache, [], 1, page, hd, page.texture, material, depth)),
        );
    }
  }

  /**
   * Layers of live overlay art are terrain-class occluders of the depth capture (always covered). The one place such
   * a layer is registered: a page's own layer, and the warm layer of the overlay stand-in graph, which has to meet
   * the capture pass of a warm frame like the layers it stands for.
   */
  private registerOverlayOccluder(layer: SpriteLayer): void {
    this.hd.terrainDepth.register(layer.mesh);
  }

  /**
   * Fetch the indexed pages of the cell decorations nothing announces now (see cellArtPages): the first rubble,
   * crater or crate of a match then has its indexed page in its first frame, and a shown view draws it from that
   * page while the HD art loads (flushOverlayPages, flushSmudgePages). Ahead of need like prepare(): silent, never
   * waited for.
   */
  private preloadCellPages(): void {
    const library = this.library;
    if (library) for (const page of cellArtPages(library.library)) library.preloadPage(page);
  }

  static async create(canvas: HTMLCanvasElement, options: LiveViewOptions): Promise<LiveView> {
    waterPreset.style = options.water ?? 'classic';
    // Only trees are static: overlays and smudges change during a match and are drawn by the view (cellLayer).
    const [world, requiredLimits] = await Promise.all([
      loadRa2World(options.mapBase, {
        includeObject: (object) => object.kind === 'tree',
        voxelLook: options.voxelLook,
        smoothVoxel: options.smoothVoxel,
        voxelProjection: options.voxelProjection,
      }),
      HdRenderer.adapterLimits(),
    ]);
    const cache = world.cache!;
    // The theater's type library (art for everything players can build), when it has been extracted.
    const library = options.libraryBase
      ? await LiveLibrary.load(`${options.libraryBase.replace(/\/$/, '')}/${cache.manifest.theater}`, cache)
      : null;
    // The map's own [Lighting] stages the view (engine-exact from the light sidecar when present).
    const lighting = cache.lights?.lighting.normal ??
      cache.manifest.lighting ?? { ambient: 1, level: 0.032, red: 1, green: 1, blue: 1, ground: 0 };
    const atmosphere = cache.lights
      ? sidecarAtmosphere(cache.lights, cache.manifest.theater)
      : mapAtmosphere(lighting, medianHeight(cache.height, cache.exists), undefined, cache.manifest.theater);
    const state: RenderState = {
      version: RENDER_STATE_VERSION,
      tick: 0,
      map: {
        width: world.width,
        height: world.height,
        theater: cache.manifest.theater,
        cornerHeights: new Float32Array(0),
        terrain: [],
        waterLevel: 0,
        lighting,
        atmosphere,
      },
      objects: [],
      events: [],
      environment: {
        timeOfDay: liveTimeOfDay(atmosphere, options),
        weather: options.weather ?? 'clear',
        weatherIntensity: options.weatherIntensity ?? 0,
        windDirection: 0.6,
        windStrength: 0.3,
      },
    };
    const hd = new HdRenderer(canvas, state, {
      nodes: world.nodes,
      forceWebGL: options.forceWebGL ?? false,
      requiredLimits,
    });
    await hd.init(world);
    hd.setState(state);
    // The original shows no vignette; keep the frame edge faithful to the game's own view.
    hd.settings.vignette = 0;
    hd.applySettings();
    const debug =
      options.debugPlaceholders ??
      new URLSearchParams(globalThis.location?.search ?? '').get('hd-debug')?.split(',').includes('placeholders') ??
      false;
    return new LiveView(hd, world, cache, { ...options, debugPlaceholders: debug }, library, state);
  }

  /** Change time, weather or the night dressing at runtime (no reload). */
  setEnvironment(change: LiveEnvironment): void {
    const env = this.state.environment;
    if (change.timeOfDay !== undefined) env.timeOfDay = change.timeOfDay;
    if (change.weather !== undefined) env.weather = change.weather;
    if (change.weatherIntensity !== undefined) env.weatherIntensity = change.weatherIntensity;
    const atmosphere = this.hd.atmosphere;
    if (change.lamps !== undefined) atmosphere.lamps = change.lamps;
    if (change.windows !== undefined) atmosphere.windows = change.windows;
    if (change.lights !== undefined) atmosphere.lights = change.lights;
    if (change.mist !== undefined) atmosphere.mist = change.mist;
  }

  /**
   * Canvas size in CSS pixels (the drawing buffer follows the renderer's pixel ratio), and the tactical view size in
   * engine pixels. The camera frustum is set in engine pixels so the HD image lines up with the original pixel for
   * pixel, whatever the display scale.
   */
  resize(cssWidth: number, cssHeight: number, viewWidth: number, viewHeight: number): void {
    this.hd.renderer.setSize(cssWidth, cssHeight, false);
    this.frame(viewWidth, viewHeight);
  }

  /**
   * Like resize, with the drawing buffer given in its own pixels: a host that lays the canvas out on whole device
   * pixels gets exactly that many, with no rounding through a CSS size and a pixel ratio (and no cap on the ratio).
   */
  resizePixels(bufferWidth: number, bufferHeight: number, viewWidth: number, viewHeight: number): void {
    this.hd.renderer.setDrawingBufferSize(
      Math.max(1, Math.round(bufferWidth)),
      Math.max(1, Math.round(bufferHeight)),
      1,
    );
    this.frame(viewWidth, viewHeight);
  }

  private frame(viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.hd.view.zoom = 1;
    this.hd.view.resize(viewWidth, viewHeight);
    // Device pixels per engine pixel: post radii keep their size in the scene, and the camera can stay on the grid.
    this.bufferScale = this.hd.renderer.getDrawingBufferSize(this.bufferSize).x / viewWidth;
    this.hd.setBufferScale(this.bufferScale);
  }

  /** A logic frame is not a publication revision: AI and draw passes can still change it between polls. */
  push(snapshot: LiveSnapshot, at = performance.now()): void {
    if (snapshot.frame !== WARM_FRAME) {
      if (this.matchSnapshot === snapshot) return;
      this.matchSnapshot = snapshot;
    }
    const merged = this.withWarmList(snapshot);
    if (this.warmMerged && merged === snapshot) {
      // The list's objects leave the picture: no building of the list lingers as "just destroyed", and the frames
      // drawn with them do not count for the match.
      this.buildingVisualHistory?.clear();
      this.settled = 0;
    }
    this.warmMerged = merged !== snapshot;
    this.publish(merged, at);
  }

  /**
   * The match snapshot with the objects of an unfinished warm list added, while that is still wanted: the game
   * creates the first objects of a scenario a second or two before the match runs, and a list that was not through
   * by then (a large map's view is ready late) would otherwise be dropped half prepared. The list's objects stand
   * at the middle of the view (inside the frustum, so their shaders are built) until everything has been drawn
   * completely once (render), the logic frame moves on (the match runs: what is not prepared by now loads when it
   * appears, as without a list) or the view is shown. A shown view never contains them.
   */
  private withWarmList(snapshot: LiveSnapshot): LiveSnapshot {
    const list = this.warmList;
    if (!list || snapshot.frame === WARM_FRAME) return snapshot;
    this.warmFirstFrame ??= snapshot.frame;
    if (!this.outOfSight || snapshot.frame !== this.warmFirstFrame) {
      this.warmList = null;
      return snapshot;
    }
    const view = snapshot.view;
    const extra = this.warmObjects(
      list,
      view
        ? [
            ((view.y + this.viewHeight / 2) / 15 + (view.x + this.viewWidth / 2) / 30) / 2,
            ((view.y + this.viewHeight / 2) / 15 - (view.x + this.viewWidth / 2) / 30) / 2,
          ]
        : null,
    );
    if (!extra) {
      this.warmList = null;
      return snapshot;
    }
    return {
      ...snapshot,
      houses: [...snapshot.houses, ...extra.houses],
      objects: [...snapshot.objects, ...extra.objects],
    };
  }

  /**
   * The warm list has been drawn completely: its art, meshes and shaders exist. A match snapshot that carried its
   * objects is published again without them (same logic frame: nothing of the match restarts).
   */
  private finishWarmList(): void {
    this.warmList = null;
    const match = this.matchSnapshot;
    if (!this.warmMerged || !match || !this.current) return;
    this.matchSnapshot = null;
    this.push(match, this.current.at);
  }

  private publish(snapshot: LiveSnapshot, at: number): void {
    if (this.warming && snapshot.frame !== WARM_FRAME) {
      // The first match snapshot after warm(): the warm list is no earlier state of this match, so nothing is
      // interpolated from it and no building of the match counts as having appeared after it.
      this.warming = false;
      this.current = this.previous = null;
      this.cameraShown = this.cameraFrom = null;
      this.objectsFor = this.effectsFor = null;
      this.appearances.clear();
      this.buildingVisualHistory?.clear();
      this.firstFrame = null;
      this.firstMissingCellsAt = undefined;
      this.publishedCells = this.warnedCells = false;
      this.settled = 0;
    }
    const current = this.current;
    const hadEffects = !!current?.snapshot.effects;
    if (current?.snapshot === snapshot) return;
    const sameFrame = current?.snapshot.frame === snapshot.frame;
    (this.buildingVisualHistory ??= new BuildingVisualHistory()).update(snapshot);
    this.painterDirty = true;
    if (current && snapshot.frame < current.snapshot.frame) {
      // Loading an earlier save or starting another match establishes a new appearance timeline.
      this.appearances.clear();
      this.firstFrame = null;
      this.firstMissingCellsAt = undefined;
      this.publishedCells = this.warnedCells = false;
    }
    this.firstFrame ??= snapshot.frame;
    if (!sameFrame) this.previous = current;
    const byUid = new Map<number, LiveObject>();
    const afterGap = !!current && snapshot.frame - current.snapshot.frame > BUILDUP_LOGIC_FRAMES;
    for (const object of snapshot.objects) {
      byUid.set(object.uid, object);
      if (object.kind === 'building') {
        const appearance = this.appearances.get(object.uid);
        if (appearance) appearance.lastSeen = snapshot.frame;
        else this.appearances.set(object.uid, { frame: snapshot.frame, afterGap, lastSeen: snapshot.frame });
      }
    }
    for (const [uid, appearance] of this.appearances)
      if (snapshot.frame - appearance.lastSeen > BUILDUP_LOGIC_FRAMES) this.appearances.delete(uid);
    if (sameFrame) {
      // Replace all discrete state (including removal, death steps and effects), without restarting interpolation.
      current.snapshot = snapshot;
      current.byUid = byUid;
      this.objectsFor = this.effectsFor = null;
    } else {
      if (current) this.scheduleMotion(snapshot.frame - current.snapshot.frame, snapshot.frame, at - current.at, at);
      // The step starts at the view on screen; with nothing shown yet (or a new timeline) from the snapshot's own.
      this.cameraFrom = current ? (this.cameraShown ?? current.snapshot.view) : null;
      this.current = { snapshot, at, byUid };
    }
    // A step still being played out keeps interpolating even when the newest frame moved nothing.
    this.objectsInterpolate = this.objectsAlpha >= 0 && this.objectsAlpha < 1;
    const motionStart = sameFrame ? this.previous : current;
    if (motionStart && !this.objectsInterpolate) {
      for (const object of snapshot.objects) {
        const before = motionStart.byUid.get(object.uid);
        if (
          before &&
          (before.x !== object.x ||
            before.y !== object.y ||
            before.z !== object.z ||
            before.facingRaw !== object.facingRaw ||
            before.turretFacingRaw !== object.turretFacingRaw)
        ) {
          this.objectsInterpolate = true;
          break;
        }
      }
    }
    for (const house of snapshot.houses) this.ensureHouse(house.colorIndex);
    this.houseColour.clear();
    for (const house of snapshot.houses) this.houseColour.set(house.index, house.colorIndex);
    const library = this.library;
    this.civilian = civilianHouses(snapshot, library ? (type) => !!library.type(type)?.building?.buildup : null);
    const effects = visibleObjectEffects(snapshot);
    this.buildingAnims = indexBuildingAnims(effects?.anims);
    this.buildingAnimMatches.clear();
    if (snapshot.shroud) this.shroud.update(snapshot.shroud);
    if (!sameFrame) this.trackMotion(snapshot, current);
    // A damaged vehicle's smoke system sits on the vehicle (see smokeUnlimited).
    const vehicles = snapshot.objects.filter((o) => o.kind === 'vehicle' && !o.nativeHidden);
    this.effectDriver.vehicleAt = (x, y, z) => smokeOnVehicle(vehicles, x, y, z);
    this.effectDriver.sceneEvent = snapshot.lighting?.event ?? null;
    this.updateLightBase(snapshot);
    this.hd.setSceneLighting(this.scenePresentation(snapshot.lighting));
    if (effects || hadEffects)
      this.effectDriver.push(
        effects ?? { anims: [], bullets: [], particleSystems: [] },
        snapshot.frame,
        this.hd.seconds(),
        this.wind,
      );
    this.updateOverlays(snapshot);
    this.liveBeams.update(snapshot.effects, this.effectDriver.style, this.hidden);
    this.updateSmudges(snapshot);
    if (snapshot.cells) {
      this.cellsFromEngine = true;
      this.applyCells(snapshot.cells);
    }
    if (snapshot.cells || snapshot.overlays || snapshot.smudges) this.publishedCells = true;
    if (!this.publishedCells && !this.warnedCells) {
      this.firstMissingCellsAt ??= at;
      // Cell readers publish on a slower cadence and can still be initializing when the first objects arrive.
      if (at - this.firstMissingCellsAt >= 5000) {
        this.warnedCells = true;
        console.warn(
          '[HD] the host reports no overlay/smudge cells (bridge H3): ore, walls and craters show the map as it started ' +
            '(harvested ore stays, walls built in the match are missing). See docs/remaster/HD_BRIDGE.md.',
        );
      }
    }
    this.updateNightSources(snapshot);
  }

  /**
   * Light sources and lit windows follow the buildings standing in the match: the engine creates a building's light
   * source with the building and removes it with it (no power gating), so the engine grid is recomputed whenever the
   * set of light-emitting buildings changes. Nothing under black shroud may give its position away: lit windows (an
   * HD addition) of shrouded buildings stay dark, and so do the light sources of shrouded buildings, except the map's
   * invisible lamp-post dummies (INGALITE and the like), which belong to the map layout every player knows and which
   * the engine lights whatever the shroud.
   */
  private updateNightSources(snapshot: LiveSnapshot): void {
    const dressing = this.world.dressing;
    const types = this.cache.lights?.types;
    // The engine's own active light sources, when the host reads them: the map light grade follows the game on
    // every map, including the many without a light sidecar (whose lamp posts otherwise lit nothing in HD), and it
    // follows lights the engine switches off. The sidecar's type table below remains for the HD dressing (lamp heads,
    // pools of a forced night) and as the grade's source when the host reports no list.
    const engine = snapshot.lighting?.sources;
    if (engine) {
      const key = engine.map((s) => `${s.x},${s.y},${s.z}:${s.radius}:${s.intensity}:${s.tint.join(',')}`).join(';');
      if (key !== this.engineLightKey) {
        this.engineLightKey = key;
        this.world.mapLight?.setSources(
          engine.map((s) => ({ position: [s.x, s.y, s.z], radius: s.radius, intensity: s.intensity, tint: s.tint })),
        );
      }
    }
    if (!dressing) return;
    const buildings = snapshot.objects.filter((o) => o.kind === 'building' && !o.nativeHidden);
    const shrouded = (b: LiveObject) => this.shroud.isLocationShrouded(b.x, b.y, b.z);
    if (types) {
      const sources: SourceLight[] = [];
      for (const b of buildings) {
        const t = types[b.type];
        if (!t || (!t.invisible && shrouded(b))) continue;
        const cell: [number, number] = [Math.floor(b.x / LEPTONS_PER_CELL), Math.floor(b.y / LEPTONS_PER_CELL)];
        const z = Math.round(b.z / LEPTONS_PER_LEVEL);
        sources.push({
          type: b.type,
          cell,
          z,
          foundation: t.foundation,
          position: [
            cell[0] * LEPTONS_PER_CELL + t.foundation[0] * 128,
            cell[1] * LEPTONS_PER_CELL + t.foundation[1] * 128,
            b.z,
          ],
          radius: t.radius,
          intensity: t.intensity,
          tint: t.tint,
          invisible: t.invisible,
        });
      }
      const key = sources.map((s) => `${s.type}@${s.cell[0]},${s.cell[1]}`).join(';');
      if (key !== this.lightKey || !!engine !== this.lightKeyEngine) {
        this.lightKey = key;
        this.lightKeyEngine = !!engine;
        dressing.setSources(sources, !engine);
      }
    }
    // HD street lamps never stand inside a building: foundations of the visible buildings standing now block their
    // spots (shrouded ones do not, so a missing lamp never gives an unseen base away; the shroud hides that lamp).
    const blocked = new Set<number>();
    const width = this.world.width;
    for (const b of buildings) {
      if (shrouded(b) || types?.[b.type]?.invisible) continue;
      const [w, h] = this.library?.type(b.type)?.foundation ?? types?.[b.type]?.foundation ?? [1, 1];
      const x0 = Math.floor(b.x / LEPTONS_PER_CELL);
      const y0 = Math.floor(b.y / LEPTONS_PER_CELL);
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) blocked.add(y * width + x);
    }
    const blockedKey = [...blocked].sort((a, b) => a - b).join(',');
    if (blockedKey !== this.blockedKey) {
      this.blockedKey = blockedKey;
      dressing.setBlockedCells(blocked);
    }
    const lit: WindowBuilding[] = [];
    for (const b of buildings) {
      const type = this.library?.type(b.type);
      const sprite = type?.sprite;
      if (!type || !sprite || shrouded(b)) continue;
      const frame = b.buildingFrame ?? (b.health <= this.library!.conditionYellow ? 1 : 0);
      const count = this.library!.litWindows(sprite, frame);
      if (!count) continue;
      const [w, h] = type.foundation ?? [1, 1];
      lit.push({
        x: Math.floor(b.x / LEPTONS_PER_CELL),
        y: Math.floor(b.y / LEPTONS_PER_CELL),
        w,
        h,
        lit: count,
        // Library draw points are the foundation's top corner too (drawOffset only undoes the cell-centre lepton).
        columns: this.library!.windowColumns(sprite, frame).map(([dx, panes]) => [dx + type.drawOffset[0], panes]),
      });
    }
    const windowKey = lit.map((b) => `${b.x},${b.y},${b.lit}`).join(';');
    if (windowKey !== this.windowKey) {
      this.windowKey = windowKey;
      dressing.setWindowBuildings(lit);
    }
  }

  private sourceLightsActive = false;
  private readonly buildingLightGate = new BuildingLightGate();
  private readonly activeSourceKeys = new Set<string>();

  /** Refresh only visible, completed building sources; a faithful switch clears the enhanced layer immediately. */
  private updateBuildingLights(snapshot: LiveSnapshot | undefined): void {
    const now = this.hd.seconds();
    // Observe real logic frames even while the look is faithful; repeated presentation frames cannot age a sentinel.
    const nativeDetail = this.options?.nativeDetail ?? 'ignore';
    if (snapshot) this.buildingLightGate.update(snapshot.objects, snapshot.frame, now, nativeDetail);
    if (!(this.hd.settings.sourceLights > 0)) {
      if (this.sourceLightsActive) {
        this.hd.lightField.clearSources();
        this.hd.emissiveOverlay.setDiscs([]);
        this.hd.emissiveOverlay.setStrokes([]);
        this.sourceLightsActive = false;
      }
      return;
    }
    const lights = buildingLightSources(
      snapshot?.objects ?? [],
      { sourceLights: this.hd.settings.sourceLights, night: this.hd.emitters.lampGain.value, nativeDetail },
      (type) => this.library?.type(type)?.foundation,
      (building) => this.shroud.isLocationShrouded(building.x, building.y, building.z),
      this.library?.conditionYellow,
      this.buildingLightGate,
    );
    this.activeSourceKeys.clear();
    for (const light of lights) {
      this.hd.lightField.source(light.key, now, light);
      this.activeSourceKeys.add(light.key);
      light.fade = this.hd.lightField.sourceFade(light.key, now);
    }
    this.hd.lightField.retainSources(this.activeSourceKeys);
    const overlay = buildingLightOverlay(lights, snapshot?.frame ?? 0, now, {
      right: this.hd.emissiveOverlay.cameraRight.value,
      up: this.hd.emissiveOverlay.cameraUp.value,
      toCamera: this.hd.emissiveOverlay.toCamera.value,
    });
    this.hd.emissiveOverlay.setDiscs(overlay.discs);
    this.hd.emissiveOverlay.setStrokes(overlay.strokes);
    this.sourceLightsActive = true;
  }

  render(now = performance.now()): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastRender) / 1000));
    // The upload budget is a rate: a frame that comes late (a display at 30 Hz, a busy GPU) gets the share of the
    // frame that did not come, but no more than two frames' worth. Per frame alone, a view at 8 frames a second
    // uploaded one atlas page every three seconds and was shown after 23; with more than twice, the upload of one
    // late frame makes the next one late (tried with eight: frames of 0.6 s).
    const frames = Number.isFinite(now - this.lastRender) ? Math.max(1, (now - this.lastRender) / FRAME_MS) : 1;
    this.lastRender = now;
    this.waitingArt = 0;
    this.pageUploads.step((this.outOfSight ? this.hiddenUploadPixels : UPLOAD_PIXELS_PER_FRAME) * Math.min(2, frames));
    const current = this.current;
    if (current) {
      const previous = this.previous;
      const interval = previous ? Math.min(250, Math.max(10, current.at - previous.at)) : 1;
      // Draw one logic frame behind, blending towards the newest snapshot: smooth motion at any display rate.
      const alpha = previous ? Math.min(1, Math.max(0, (now - current.at) / interval)) : 1;
      this.hd.setSceneLighting(
        this.scenePresentation(
          interpolateSceneLighting(previous?.snapshot, current.snapshot, alpha),
          this.effectDriver.skyFlash(this.hd.seconds()),
        ),
      );
      const cameraAlpha =
        previous && this.motionEnd !== undefined
          ? Math.min(1, Math.max(0, (now - this.motionStart) / (this.motionEnd - this.motionStart)))
          : alpha;
      this.applyCamera(
        previous ? (this.cameraFrom ?? previous.snapshot.view) : null,
        current.snapshot.view,
        cameraAlpha,
      );
      // Sprite pages, voxel models, and the meshes and redraw projections built from them, arrive asynchronously.
      const libraryRevision = (this.library?.revision ?? 0) + this.voxelUnits.revision;
      const artRevision = this.effectArt?.revision ?? 0;
      const windows = this.hd.windowsWanted();
      const materials = this.hd.materialsWanted();
      if (this.objectLibraryRevision !== libraryRevision || this.objectsMaterials !== materials)
        this.overlayPagesDirty = true;
      // Objects play each step from the poses on screen to its due time (scheduleMotion), like the camera above;
      // scene lighting keeps the arrival interval.
      const objectAlpha = !this.objectsInterpolate
        ? 1
        : previous && this.motionEnd !== undefined
          ? Math.min(1, Math.max(0, (now - this.motionStart) / (this.motionEnd - this.motionStart)))
          : alpha;
      if (
        this.objectsFor !== current ||
        this.objectsAlpha !== objectAlpha ||
        this.objectLibraryRevision !== libraryRevision ||
        this.objectArtRevision !== artRevision ||
        this.objectsWindows !== windows ||
        this.objectsMaterials !== materials
      ) {
        if (
          this.objectsFor !== current ||
          this.objectLibraryRevision !== libraryRevision ||
          this.objectArtRevision !== artRevision ||
          this.objectsWindows !== windows ||
          this.objectsMaterials !== materials
        )
          this.painterDirty = true;
        this.applyObjects(previous, current, objectAlpha);
        this.objectsFor = current;
        this.objectsAlpha = objectAlpha;
        this.objectLibraryRevision = libraryRevision;
        this.objectArtRevision = artRevision;
        this.objectsWindows = windows;
        this.objectsMaterials = materials;
      }
      // Effect cards change with the logic frame only: rebuilt per snapshot (and while art is still loading).
      if (this.effectsFor !== current || this.effectArtRevision !== artRevision) {
        this.effectsFor = current;
        this.effectArtRevision = artRevision;
        this.applyEffects(current.snapshot);
      }
    }
    if (this.cellsDirty) this.flushCells();
    if (this.overlayPagesDirty) this.flushOverlayPages();
    if (this.smudgePagesDirty) this.flushSmudgePages();
    if (this.painterDirty) this.applyPainterOrder();
    this.updateBuildingLights(current?.snapshot);
    this.effectDriver.frame(this.hd.seconds(), this.wind);
    if (!current) this.hd.setSceneLighting(null);
    this.liveBeams.displayScale.value = 1 / Math.max(1e-3, this.hd.meanExposure);
    this.updateGlints(now);
    if (this.effectSprites) {
      // Quality tier 1 and up: no copy of the frame for translucent engine effects (see EffectSpriteLayer.backdropMix).
      this.effectSprites.backdropMix = !(this.hd.quality >= 1);
      this.effectSprites.now.value = this.hd.seconds();
      this.effectSprites.displayScale.value = 1 / Math.max(1e-3, this.hd.meanExposure);
    }
    this.volumetricBlasts.displayScale.value = 1 / Math.max(1e-3, this.hd.meanExposure);
    this.volumetricBlasts.update(
      this.hd.seconds(),
      this.volumetricBlasts.cameraRight.value,
      this.volumetricBlasts.cameraUp.value,
      this.volumetricBlasts.toCamera.value,
    );
    // After everything this frame's own objects needed: art ahead of need takes what is left of the frame's pace.
    this.stepAhead();
    // Out of sight is the time to build: once when there is a scene at all (behind the game's loading screen), and
    // once more when the match's opening is in, so the passes and quality tiers have the shaders of its units too.
    if (this.hiddenFromSight && current && !this.hd.warming) {
      const stage =
        current.snapshot.frame !== WARM_FRAME && current.snapshot.frame > 0 && this.settled >= 1 && !this.warmMerged
          ? 2
          : 1;
      if (stage > this.warmStage) {
        this.warmStage = stage;
        this.effectSprites?.warm();
        this.warmStandIns();
        this.hd.warm();
      }
    }
    this.hd.frame(dt);
    // Loads settle between frames, never inside one: what is still on its way now was missing from this frame. A
    // warm frame (HdRenderer.warm) is not a frame of the match either: it draws what is hidden and builds shaders.
    // Nor is one whose objects still wait for their pipelines (compiled off the frame: see asyncPipelines.ts).
    const complete = this.loadingArt() === 0 && !this.hd.warming && !this.hd.pendingPipelines;
    this.settled = current && complete ? this.settled + 1 : 0;
    // Once the opening is in (or the view is shown anyway), the model files of kinds that have not appeared yet are
    // fetched ahead, so the first frame of a new kind of unit has a model to draw (see LiveLibrary.preloadVoxels).
    if (this.fetchAhead && current && (this.settled >= 1 || !this.outOfSight) && this.fetchAhead())
      this.fetchAhead = null;
    if (this.warmList && this.settled >= 1) this.finishWarmList();
    if (this.waitingArt) {
      // What waited for its turn is offered again in the next frame, with or without a new snapshot.
      this.objectsFor = null;
      this.overlayPagesDirty = this.smudgePagesDirty = true;
    }
    this.newArt = 0;
  }

  /**
   * Whether a new kind of art may join the scene in this frame (see newArtPerFrame). Shown views never wait: an
   * object that could be drawn and is not would be a hole in the picture.
   */
  private admitNewArt(): boolean {
    if (!this.outOfSight) return true;
    if (this.newArt >= this.newArtPerFrame) {
      this.waitingArt++;
      return false;
    }
    this.newArt++;
    return true;
  }

  /**
   * How many frames in a row this view has drawn its snapshot completely: every sprite page, voxel mesh, redraw
   * projection and effect page the frame asked for was there, so no object was skipped and no art is about to change.
   * The first such frame also built the shaders and pipelines of whatever was new in it, so from the second one on a
   * frame costs what a frame costs. 0 while art is on its way (and before the first snapshot). A host that keeps the
   * original picture on screen while the view prepares waits for a few of these before it shows the view.
   */
  get settledFrames(): number {
    // Frames that still contain a warm list's objects are not frames of the match.
    return this.warmMerged ? 0 : this.settled;
  }

  /**
   * A failed load settles, but must not let the first HD frame omit the local player's units or building parts.
   * Normal pending work is also covered by settledFrames; this additionally rejects permanently missing art.
   * Other houses do not hold the local picture back, and objects the engine deliberately hides need no picture.
   */
  get localArtComplete(): boolean {
    const snapshot = this.current?.snapshot;
    const local = snapshot?.localHouse;
    if (!snapshot || this.warming || this.warmMerged || local === undefined || local < 0) return false;
    for (const object of snapshot.objects) {
      if (object.owner !== local || object.nativeHidden) continue;
      const visual = this.visuals.get(object.uid);
      const type = visual?.libraryType ?? this.library?.type(object.imageType ?? object.type);
      if (type?.invisible || this.cache.lights?.types[object.type]?.invisible) continue;
      if (
        !visual ||
        visual.mode === 'placeholder' ||
        visual.turretState === 'missing' ||
        visual.turretState === 'loading'
      )
        return false;
      if (visual.mode === 'library-sprite') {
        const pages = type && this.library?.typePages(type);
        if (!pages?.length || pages.some((page) => !this.library!.pageSettled(page) || this.library!.pageFailed(page)))
          return false;
      }
    }
    return true;
  }

  /**
   * Art that was asked for and is not on screen yet: files being fetched or decoded, voxel meshes being built,
   * objects that draw nothing until their model arrives. A model that failed to load is not counted: it will never
   * arrive, and the object is reported by diagnostics() instead.
   */
  loadingArt(): number {
    let count =
      (this.library?.loading ?? 0) + (this.effectArt?.loading ?? 0) + this.voxelUnits.loading + this.waitingArt;
    for (const visual of this.visuals.values()) {
      if (visual.turretState === 'loading') count++;
      if (visual.mode !== 'placeholder' || !visual.pending) continue;
      const voxel = visual.libraryType?.voxel;
      if (this.cache.voxels.has(visual.type) || (voxel && !this.library?.voxelFailed(voxel))) count++;
    }
    return count;
  }

  /**
   * What the frame rendered last was busy with (see LiveActivity). For a host that records stalls: it asks when a
   * frame comes late, before it renders the next one, and learns what the frame before that gap had started. Nothing
   * is counted per frame for this: shader and pipeline creations stamp themselves with their frame's clock, and the
   * visuals built in that frame are looked up here.
   */
  activity(): LiveActivity {
    const frame = this.lastRender;
    const older = new Set<string>();
    const fresh = new Set<string>();
    for (const [uid, visual] of this.visuals) {
      const object = this.current?.byUid.get(uid);
      if (!object) continue;
      (visual.builtAt === frame ? fresh : older).add(`${object.kind}:${visual.type}`);
    }
    const newKinds: string[] = [];
    for (const kind of fresh) if (!older.has(kind) && newKinds.length < 8) newKinds.push(kind);
    const compiled = this.compiled;
    const counted = compiled?.at === frame;
    return {
      pageUploads: this.pageUploads.pending,
      voxelMeshes: this.voxelUnits.loading,
      voxelCacheHits: this.voxelUnits.cacheHits,
      voxelMeshBuilds: this.voxelUnits.meshBuilds,
      loadingArt: this.loadingArt(),
      shaders: compiled ? (counted ? compiled.shaders : 0) : null,
      pipelines: compiled ? (counted ? compiled.pipelines : 0) : null,
      newKinds,
      logicFps: Math.round(this.effectDriver.logicFps * 10) / 10,
    };
  }

  /** The map's theater: art libraries, and so the lists warm() takes, belong to one. */
  get theater(): string {
    return this.cache.manifest.theater;
  }

  /**
   * The kinds of object in the current match snapshot, each once: the list to hand to warm() before the next match
   * with the same players. Empty before the first match snapshot.
   */
  warmTypes(): LiveWarmType[] {
    const snapshot = this.matchSnapshot;
    if (!snapshot || this.warming) return [];
    const types = new Map<string, LiveWarmType>();
    for (const object of snapshot.objects) {
      const colorIndex = this.houseColour.get(object.owner) ?? -1;
      const civilian = this.civilian.has(object.owner);
      const key = `${object.kind}:${object.type}:${object.imageType ?? ''}:${colorIndex}:${civilian}`;
      if (types.has(key)) continue;
      types.set(key, {
        kind: object.kind,
        type: object.type,
        ...(object.imageType ? { imageType: object.imageType } : {}),
        colorIndex,
        ...(civilian ? { civilian: true } : {}),
      });
    }
    return [...types.values()];
  }

  /**
   * Prepare the art of `types` before any of them is in the match: the game creates the players' starting units
   * only as its loading screen ends, and a view that first hears of them then needs seconds to fetch their pages,
   * build their meshes and compile their shaders. One object of each listed kind (a building twice: standing and at
   * the first frame of its build-up) is drawn at the middle of the map, through the same code as a match snapshot,
   * so exactly what a match would load is loaded and nothing else. An empty list still prepares the map and shared
   * effect shaders, before the first match of a fresh browser profile. The host keeps the view out of sight meanwhile
   * (`outOfSight`) and renders frames until `settledFrames` counts. The first match snapshot starts its own
   * timeline; a list that is not through by then stays alongside the match's first snapshots while they are out of
   * sight (see withWarmList). Nothing of a list is ever shown. Ignored once a match snapshot with objects is in.
   */
  warm(types: readonly LiveWarmType[]): void {
    if (this.current && !this.warming && this.current.snapshot.objects.length) return;
    const extra = this.warmObjects(types, null);
    if (!extra) return;
    this.warming = true;
    this.warmList = types.length ? [...types] : null;
    this.warmFirstFrame = null;
    const [cx, cy, level] = extra.cell;
    this.push({
      frame: WARM_FRAME,
      // applyCamera's inverse: the view whose centre is the chosen cell (at its own height on screen).
      view: {
        x: (cx - cy) * 30 - this.viewWidth / 2,
        y: (cx + cy) * 15 - level * 15 - this.viewHeight / 2,
      },
      houses: extra.houses,
      localHouse: -1,
      objects: extra.objects,
    });
  }

  /**
   * One object per listed kind (a building twice: standing and under construction, whose art lies on other pages)
   * with their houses, standing on the existing cell nearest `near` (cell coordinates; the middle of the grid when
   * null). Null when the map has no cell. UIDs and house indices lie outside what a match uses and are the same for
   * a list every time, so the visuals built for it are kept from one snapshot to the next.
   */
  private warmObjects(
    types: readonly LiveWarmType[],
    near: readonly [number, number] | null,
  ): { objects: LiveObject[]; houses: LiveHouse[]; cell: [number, number, number] } | null {
    const { width, height } = this.cache.manifest.grid;
    const [nearX, nearY] = near ?? [width / 2, height / 2];
    let cell = -1;
    let nearest = Infinity;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (!this.cache.exists[y * width + x]) continue;
        const distance = (x - nearX) ** 2 + (y - nearY) ** 2;
        if (distance < nearest) {
          nearest = distance;
          cell = y * width + x;
        }
      }
    if (cell < 0) return null;
    const cx = cell % width;
    const cy = Math.floor(cell / width);
    const level = this.cache.height[cell] ?? 0;
    // One house per colour scheme and kind of owner, flagged as the match's houses are inferred to be: civilian art
    // is drawn differently (see libraryBuildingSprites), and a list is of no use if it prepares the other variant.
    const houseKey = (type: LiveWarmType) => `${type.colorIndex}:${type.civilian ? 1 : 0}`;
    const owners = [...new Set(types.filter((type) => type.colorIndex >= 0).map(houseKey))];
    const objects: LiveObject[] = types.map((type, index) => ({
      id: index + 1,
      uid: WARM_UID_BASE - index,
      kind: type.kind,
      type: type.type,
      ...(type.imageType ? { imageType: type.imageType } : {}),
      owner: type.colorIndex < 0 ? -1 : WARM_HOUSE_BASE + owners.indexOf(houseKey(type)),
      x: (cx + 0.5) * LEPTONS_PER_CELL,
      y: (cy + 0.5) * LEPTONS_PER_CELL,
      z: level * LEPTONS_PER_LEVEL,
      facingRaw: 0,
      health: 1,
      isSelected: false,
    }));
    for (const object of [...objects])
      if (object.kind === 'building')
        objects.push({
          ...object,
          id: objects.length + 1,
          uid: WARM_UID_BASE - objects.length,
          buildState: 'building',
        });
    return {
      objects,
      houses: owners.map((key, index) => ({
        index: WARM_HOUSE_BASE + index,
        colorIndex: Number(key.split(':')[0]),
        civilian: key.endsWith(':1'),
      })),
      cell: [cx, cy, level],
    };
  }

  /**
   * Runs immediately before capture, after effect records, interpolated poses, painter depth and the camera are final.
   * Scratch fires/objects retain their high-water storage; normal frames allocate no records, vectors or callbacks.
   */
  private updateFireEngulf(): void {
    const right = this.engulfRight.setFromMatrixColumn(this.hd.view.camera.matrixWorld, 0);
    const up = this.engulfUp.setFromMatrixColumn(this.hd.view.camera.matrixWorld, 1);
    const fires = this.engulfFires;
    let count = 0;
    for (const effect of this.effectInstances) {
      if (
        effect.alpha <= 0 ||
        effect.draw !== 'card' ||
        effect.pass !== 'air' ||
        (effect.category !== 'explosion' && effect.category !== 'collapse')
      )
        continue;
      const bounds = this.engulfBounds;
      effectDisplayBounds(effect, bounds);
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      const fire = (fires[count] ??= { x: 0, y: 0, z: 0, screenX: 0, screenY: 0, radius: 0 });
      count++;
      const anchor = effect.anchor;
      fire.x = anchor.x;
      fire.y = anchor.y;
      fire.z = anchor.z;
      fire.screenX = anchor.dot(right) + bounds.x + bounds.width / 2;
      fire.screenY = anchor.dot(up) - bounds.y - bounds.height / 2;
      // HD display/merge growth is already in these bounds. Never use the capped fallback sphere for proximity.
      fire.radius = Math.hypot(bounds.width, bounds.height) / 2 + FIRE_FOOTPRINT_MARGIN;
    }
    count = this.hd.effects.appendExplosionFootprints(fires, count, right, up, FIRE_FOOTPRINT_MARGIN);
    this.hd.terrainDepth.setNeeded(count > 0);
    if (!count && !this.engulfActive) return;
    this.engulfActive = count > 0;
    for (const [uid, visual] of this.visuals) {
      const object = this.current?.byUid.get(uid) ?? this.buildingVisualHistory?.retained.get(uid)?.object;
      const state = (visual.engulf ??= { x: 0, y: 0, z: 0, radius: 0, code: NOT_CAPTURED_CODE });
      state.code = NOT_CAPTURED_CODE;
      state.radius = 0;
      if (!count || !visual.root.visible || !object || visual.mode === 'placeholder') continue;
      const foundation = object.kind === 'building' ? (visual.painter?.foundation ?? UNIT_FOUNDATION) : undefined;
      engulfAnchor(visual.root.position, foundation, visual.painter?.x ?? 0, visual.painter?.z ?? 0, state);
      if (object.kind === 'building' && visual.mode !== 'voxel')
        state.y = (object.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT;
      if (visual.mode === 'voxel') {
        state.radius =
          Math.hypot(
            visual.root.position.x - state.x,
            visual.root.position.y - state.y,
            visual.root.position.z - state.z,
          ) +
          this.voxelUnits.captureRadius(visual) +
          OBJECT_FOOTPRINT_MARGIN;
      }
    }
    // Build one generous footprint per owner across ALL SHP parts/pages, so a fire near a tall annex or barrel
    // captures the body too. Shadows/decals/reflections never contribute or receive an object code.
    if (count)
      for (const instances of this.spriteBatch.values())
        for (const instance of instances) {
          if (instance.flat || instance.shadow || instance.kind) continue;
          const uid = instance.painter?.uid ?? -1;
          const visual = this.visuals.get(uid);
          const state = visual?.engulf;
          const object = this.current?.byUid.get(uid) ?? this.buildingVisualHistory?.retained.get(uid)?.object;
          if (!visual?.root.visible || !state || !object || visual.mode === 'placeholder') continue;
          if (object.kind !== 'building' && state.radius === 0) {
            engulfAnchor(instance.anchor, undefined, 0, 0, state);
          }
          const dx =
            (instance.anchor.x - state.x) * right.x +
            (instance.anchor.y - state.y) * right.y +
            (instance.anchor.z - state.z) * right.z;
          const dy =
            (instance.anchor.x - state.x) * up.x +
            (instance.anchor.y - state.y) * up.y +
            (instance.anchor.z - state.z) * up.z;
          const x0 = dx + instance.frame.offset[0] / PIXELS_PER_CELL_EDGE;
          const y0 = dy - instance.frame.offset[1] / PIXELS_PER_CELL_EDGE;
          const x1 = x0 + instance.frame.rect[2] / PIXELS_PER_CELL_EDGE;
          const y1 = y0 - instance.frame.rect[3] / PIXELS_PER_CELL_EDGE;
          state.radius = Math.max(
            state.radius,
            Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(y0), Math.abs(y1))) +
              OBJECT_FOOTPRINT_MARGIN,
          );
        }
    for (const [uid, visual] of this.visuals) {
      const state = visual.engulf!;
      const object = this.current?.byUid.get(uid) ?? this.buildingVisualHistory?.retained.get(uid)?.object;
      if (count && object && visual.root.visible && state.radius > 0) {
        // Flying aircraft retain their original independent layer. Landed aircraft use the same policy as vehicles.
        const airborne =
          object.kind === 'aircraft' &&
          ((visual.painter?.layer ?? 2) >= 4 || state.y > this.world.terrain.heightAt(state.x, state.z) + 0.01);
        if (!airborne) {
          const foundation = visual.painter?.foundation;
          if (foundation)
            state.radius = Math.max(
              state.radius,
              Math.hypot(foundation[0], foundation[1]) / 2 + OBJECT_FOOTPRINT_MARGIN,
            );
          if (visual.buildingTurret)
            state.radius = Math.max(
              state.radius,
              Math.hypot(
                visual.buildingTurret.root.position.x - state.x,
                visual.buildingTurret.root.position.y - state.y,
                visual.buildingTurret.root.position.z - state.z,
              ) +
                this.voxelUnits.captureRadius(visual.buildingTurret) +
                OBJECT_FOOTPRINT_MARGIN,
            );
          if (isNearEngulfFire(state, state.radius, fires, count, right, up))
            state.code = this.hd.terrainDepth.anchorCode(state);
        }
      }
      if (visual.mode === 'voxel') this.voxelUnits.setCaptureCode(visual, state.code);
      if (visual.buildingTurret) this.voxelUnits.setCaptureCode(visual.buildingTurret, state.code);
    }
    this.sprites.updateCaptureCodes(this.spriteCaptureCode);
    for (const { layer } of this.pageLayers.values()) layer.updateCaptureCodes(this.spriteCaptureCode);
  }

  /**
   * One pass of the engine's glint step on the renderer's wall clock (milliseconds, like the engine's timeGetTime):
   * cells under black shroud are left untouched, as cells the engine does not process.
   */
  private updateGlints(now: number): void {
    const glints = this.glints;
    if (!glints) return;
    const { state, layer } = glints;
    const width = this.cache.manifest.grid.width;
    const levels = this.cache.height;
    const centre = (cell: number, axis: 0 | 1): number => {
      const x = cell % width;
      return (axis === 0 ? x : (cell - x) / width) * LEPTONS_PER_CELL + LEPTONS_PER_CELL / 2;
    };
    layer.begin();
    state.step(
      this.glintCells,
      state.elapsed(now),
      (cell, dx, dy, r, g, b) => {
        const z = (levels[cell] ?? 0) * LEPTONS_PER_LEVEL;
        layer.add(engineAnchor(centre(cell, 0), centre(cell, 1), z, undefined, this.glintAnchor), dx, dy, r, g, b);
      },
      (cell) =>
        this.shroud.isLocationShrouded(centre(cell, 0), centre(cell, 1), (levels[cell] ?? 0) * LEPTONS_PER_LEVEL),
    );
    layer.end();
  }

  /** Switch garnish for new effects and card art on the next snapshot (see LiveViewOptions.effects). */
  setEffectStyle(style: EffectStyle): void {
    this.effectDriver.style = style;
    this.liveBeams.update(this.current?.snapshot.effects, style, this.hidden);
    if (style === 'enhanced' && this.effectDriver.hdEnabled)
      void this.effectArt?.loadHd().then(() => this.effectArt?.preloadHd(COMBAT_ANIMS));
  }

  dispose(): void {
    if (this.hd.beforeDepthCapture === this.classifyFireEngulf) this.hd.beforeDepthCapture = undefined;
    this.liveBeams.dispose();
    this.glints?.layer.dispose();
    this.hd.renderer.setAnimationLoop(null);
    for (const { layer } of this.overlayLayers.values()) this.disposeOverlayLayer(layer);
    this.overlayLayers.clear();
    this.uploadedOverlays.clear();
    for (const layer of this.smudgeLayers.values()) this.disposeOverlayLayer(layer);
    this.smudgeLayers.clear();
    this.uploadedSmudges.clear();
    for (const { layer } of this.pageLayers.values()) this.disposeOverlayLayer(layer);
    this.pageLayers.clear();
    for (const layer of this.standInWarm.values()) this.disposeOverlayLayer(layer);
    this.standInWarm.clear();
    this.standInWarmPage?.dispose();
    this.standInWarmPage = null;
    if (this.standInWarmHd) for (const texture of Object.values(this.standInWarmHd)) texture.dispose();
    this.standInWarmHd = null;
    for (const visual of this.visuals.values()) this.removeVisual(visual);
    this.voxelUnits.disposeAll();
    this.pageUploads.dispose();
    this.volumetricBlasts.dispose();
    this.effectSprites?.setInstances([], Infinity);
    this.effectSprites?.topRoot.removeFromParent();
    this.library?.disposeMaterials();
    this.library?.disposeDepthTemplate();
    this.hd.dispose();
    this.visuals.clear();
    this.appearances.clear();
    this.buildingVisualHistory?.clear();
  }

  /** What the view could not draw (a healthy match reports no placeholders and no effects without art). */
  diagnostics(): LiveDiagnostics {
    let placeholders = 0;
    let pendingArt = 0;
    let missingTurrets = 0;
    let pendingTurrets = 0;
    const mapCacheTypes = new Set<string>();
    for (const visual of this.visuals.values()) {
      if (visual.turretState === 'missing') missingTurrets++;
      else if (visual.turretState === 'loading') pendingTurrets++;
      if (visual.mode === 'map-sprite') mapCacheTypes.add(visual.type);
      if (visual.mode !== 'placeholder') continue;
      if (visual.pending) pendingArt++;
      else placeholders++;
    }
    return {
      placeholders,
      missingTypes: [...this.warnedTypes].sort(),
      mapCacheTypes: [...mapCacheTypes].sort(),
      pendingArt,
      indexedSprites: this.indexedSprites,
      heldPictures: this.heldPictures,
      incompletePictures: this.incompletePictures,
      standInVoxels: this.voxelUnits.standInUnits,
      missingTurrets,
      pendingTurrets,
      effectCards: this.effectStats.drawn,
      volumetricBlasts: this.volumetricBlasts.stats().count,
      effectsWithoutArt: this.effectStats.missing,
      effectTypesWithoutArt: [...this.effectDriver.unknownTypes].sort(),
      logicFps: Math.round(this.effectDriver.logicFps * 10) / 10,
      cellsFromEngine: this.overlayInstances.active || this.smudgeInstances.active || this.cellsFromEngine,
      overlaysFromEngine: this.overlayInstances.active || this.cellsFromEngine,
      smudgesFromEngine: this.smudgeInstances.active || this.cellsFromEngine,
      smudgeTypesWithoutArt: [...this.smudgeInstances.instances.missingTypes].sort(),
    };
  }

  private applyCamera(from: LiveSnapshot['view'], to: LiveSnapshot['view'], alpha: number): void {
    if (!to) return;
    const jump = from ? Math.hypot(to.x - from.x, to.y - from.y) > 400 : true;
    // Between two snapshots the view moves by fractions of an engine pixel. Keep it on the drawing buffer's pixel grid:
    // art whose texels match the buffer's pixels (2x art at two device pixels per engine pixel) then stays texel-exact
    // while the map scrolls instead of being resampled half a texel off on every in-between frame.
    const grid = this.bufferScale;
    const shownX = jump || !from ? to.x : from.x + (to.x - from.x) * alpha;
    const shownY = jump || !from ? to.y : from.y + (to.y - from.y) * alpha;
    this.cameraShown = { x: shownX, y: shownY };
    const x = jump || !from ? to.x : snapToPixelGrid(shownX, grid);
    const y = jump || !from ? to.y : snapToPixelGrid(shownY, grid);
    // The camera looks at the ground point (level 0) under the view's centre; orthographic, so height is irrelevant.
    const diff = (x + this.viewWidth / 2) / 30;
    const sum = (y + this.viewHeight / 2) / 15;
    this.hd.view.target.set((sum + diff) / 2, 0, (sum - diff) / 2);
  }

  /** Logic-frame bookkeeping per object: first appearance, last move, last shot, death. */
  private trackMotion(snapshot: LiveSnapshot, previous: Timed | null): void {
    const before = previous?.byUid;
    const fired = new Map((snapshot.effects?.fireEvents ?? []).map((e) => [e.uid, e.frame]));
    for (const object of snapshot.objects) {
      const visual = this.visuals.get(object.uid);
      if (!visual) continue;
      const last = before?.get(object.uid);
      if (last && (last.x !== object.x || last.y !== object.y)) visual.lastMoveFrame = snapshot.frame;
      const shot = fired.get(object.uid);
      if (shot !== undefined) visual.firedFrame = shot;
      if (object.health <= 0) visual.deadFrame ??= snapshot.frame;
    }
  }

  /**
   * Weather-only building footprints (rain splashes and snow stay off roofs). Occlusion does not read this: the
   * native building depth model replaced the old foundation index, and refinery cells are rebuilt separately.
   */
  private updateFoundations(objects: readonly LiveObject[], frame: number): void {
    const weatherFoundations: WeatherFoundation[] = [];
    for (const object of objects) {
      if (object.kind !== 'building') continue;
      const visual = this.visualFor(object, this.houseColour.get(object.owner) ?? -1, frame);
      if (visual.libraryType?.invisible || this.cache.lights?.types[object.type]?.invisible) continue;
      const foundation =
        visual.libraryType?.foundation ??
        (visual.sprite ? this.cache.manifest.sprites[visual.sprite]?.foundation : undefined);
      const x = Math.floor(object.x / LEPTONS_PER_CELL);
      const z = Math.floor(object.y / LEPTONS_PER_CELL);
      // The light sidecar can know a footprint before art resolves; this fallback affects weather alone.
      const weatherFoundation = foundation ?? this.cache.lights?.types[object.type]?.foundation;
      if (weatherFoundation)
        weatherFoundations.push({ x, z, width: weatherFoundation[0], height: weatherFoundation[1] });
    }
    // Snapshots and asynchronous art revisions already rebuild this index; interpolation-only frames do not.
    // The renderer compares footprint keys before touching the texture, including a transition to no buildings.
    this.hd.weatherGroundMask?.updateFoundations(weatherFoundations);
  }

  private applyObjects(previous: Timed | null, current: Timed, alpha: number): void {
    const retained = this.buildingVisualHistory?.retained;
    const objects = retained?.size
      ? [...current.snapshot.objects, ...Array.from(retained.values(), (last) => last.object)]
      : current.snapshot.objects;
    const batch = this.spriteBatch;
    for (const list of batch.values()) list.length = 0;
    this.spritePool.begin();
    this.heldPictures = this.incompletePictures = 0;
    if (this.painterDirty) {
      this.refineryCells = new Set<string>();
      for (const object of current.snapshot.objects) {
        if (object.kind !== 'building') continue;
        const type = this.library?.type(object.type);
        if (!type?.refinery || !type.foundation) continue;
        const x = Math.floor(object.x / LEPTONS_PER_CELL);
        const y = Math.floor(object.y / LEPTONS_PER_CELL);
        addRefineryFoundation(this.refineryCells, true, x, y, type.foundation);
      }
      // Weather exclusions share the drawable building lifetime; native refinery rules use current state above.
      this.updateFoundations(objects, current.snapshot.frame);
    }
    for (const object of objects) {
      const last = retained?.get(object.uid);
      const snapshot = last?.snapshot ?? current.snapshot;
      const frame = snapshot.frame;
      const colorIndex = this.houseColour.get(object.owner) ?? -1;
      const visual = this.visualFor(object, colorIndex, frame);
      // Native techno rendering does not reject the anchor's shroud cell. The common per-pixel mask covers the
      // whole sprite/voxel, including tall art crossing the edge. InvisibleInGame types still never draw.
      const hidden =
        !!object.nativeHidden || !!visual.libraryType?.invisible || !!this.cache.lights?.types[object.type]?.invisible;
      if (visual.root.visible === hidden) this.painterDirty = true;
      visual.root.visible = !hidden;
      if (hidden) {
        if (visual.motion) visual.motion.hasShown = false;
        continue;
      }
      const pose = this.pose;
      this.presentPose(object, visual, last ? undefined : previous?.byUid.get(object.uid), current, alpha);
      const painter = (visual.painter ??= painterObject(2, 0));
      if (this.painterDirty) {
        const registered = object.renderOrder;
        const airborne =
          object.kind === 'aircraft' &&
          (object.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT >
            this.world.terrain.heightAt(object.x / LEPTONS_PER_CELL, object.y / LEPTONS_PER_CELL) + 0.01;
        painter.layer = registered?.layer ?? (airborne ? 4 : 2);
        painter.ySort =
          registered?.ySort ??
          objectYSort(object.x, object.y, object.kind === 'building', !!visual.libraryType?.building?.turretVoxel);
        painter.index = registered?.index;
        painter.uid = object.uid;
        painter.foundation =
          object.kind === 'building'
            ? (visual.libraryType?.foundation ??
              (visual.sprite ? this.cache.manifest.sprites[visual.sprite]?.foundation : undefined))
            : undefined;
        painter.x = Math.floor(object.x / LEPTONS_PER_CELL);
        painter.z = Math.floor(object.y / LEPTONS_PER_CELL);
      }
      this.spritePool.painter = painter;
      // Every card of this object carries its tint as instance data; the next object sets its own.
      this.spritePool.tintLight = tintLight(object.tint);
      this.spritePool.tintColour = packTintColour(object.tint?.add);
      if (visual.mode === 'placeholder') {
        visual.root.position.set(
          pose.x / LEPTONS_PER_CELL,
          (pose.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT,
          pose.y / LEPTONS_PER_CELL,
        );
        continue;
      }
      if (visual.mode === 'map-sprite') {
        this.mapBuildingSprites(object, visual, batch);
        continue;
      }
      if (visual.mode === 'library-sprite') {
        const recorded = this.beginPicture(visual, pose);
        let standing = false;
        if (object.kind === 'building') standing = this.libraryBuildingSprites(object, visual, batch, snapshot);
        else if (object.kind === 'infantry') this.libraryInfantrySprites(object, pose, visual, batch, frame);
        else this.libraryShpUnitSprites(object, pose, visual, batch, frame);
        if (recorded) this.endPicture(visual, batch);
        // A building's turret aims with its PrimaryFacing (the reader's facingRaw): recorded sentry guns turned it
        // (5793 .. 28312) while their SecondaryFacing (turretFacingRaw) stayed 0.
        if (object.kind === 'building') this.buildingTurret(object, visual, standing ? pose.facing : null);
        continue;
      }
      const unit = visual;
      this.voxelUnits.setOpacity(unit, object.translucent ?? 1);
      this.voxelUnits.setTint(unit, object.tint);
      // Buildings are never turned (facing pi/2 is the identity rotation).
      if (object.kind === 'building') {
        pose.facing = Math.PI / 2;
        this.voxelUnits.pose(unit, pose, null);
        continue;
      }
      const grounded = this.groundCard(object);
      this.voxelUnits.pose(unit, pose, this.poseTurret, this.poseUp);
      // On a ramp the native shadow lies in the plane the body is drawn in; a level body keeps the ground's own plane.
      // The engine's vehicle shadow is the footprint on the bottom face of the body section (UnitClass draw); landed
      // aircraft keep the plane through their origin.
      this.voxelUnits.setGroundContact(
        unit,
        grounded,
        this.poseUp && this.poseUp.y < 0.9999 ? this.poseUp : undefined,
        object.kind === 'vehicle',
      );
      this.voxelUnits.setNativeDepth(
        unit,
        unit.root.position,
        this.harvesterBonus(object),
        grounded,
        this.world.terrainObjectCards,
      );
    }
    for (const uid of this.visuals.keys()) {
      if (current.byUid.has(uid) || retained?.has(uid)) continue;
      this.removeVisual(this.visuals.get(uid)!);
      this.visuals.delete(uid);
    }
    if (!this.painterDirty) this.flushSprites(batch, false);
  }

  /**
   * Time the step to a snapshot `frames` logic frames after the previous one, which arrived `elapsed` ms earlier (see
   * MOTION_MARGIN). The poses on screen were presented at the last render and move on from that moment.
   */
  private scheduleMotion(frames: number, frame: number, elapsed: number, at: number): void {
    const steps = Math.max(1, frames);
    // Arrival interval per logic frame; a pause, a load or a stalled tab is not a period.
    const sample = elapsed / steps;
    if (frames > 0 && sample >= MOTION_PERIOD_MIN && sample <= MOTION_PERIOD_MAX)
      this.motionPeriod =
        this.motionPeriod === undefined
          ? sample
          : this.motionPeriod + (sample - this.motionPeriod) * MOTION_PERIOD_BLEND;
    const period = this.motionPeriod;
    if (period === undefined) {
      this.motionEnd = undefined;
      return;
    }
    const clock = (this.motionClock ??= { frame, time: at });
    const expected = clock.time + (frame - clock.frame) * period;
    const late = at - expected;
    // An earlier save or another match (frames <= 0) starts the clock over, like a long gap.
    const restart = frames <= 0 || late > MOTION_MARGIN * period || late < -MOTION_RESYNC * period;
    clock.time = restart ? at : expected + late * MOTION_CLOCK_GAIN;
    clock.frame = frame;
    this.motionStart = Math.min(at, Math.max(this.lastRender, at - MOTION_PRESENT_GAP));
    this.motionEnd = Math.max(
      clock.time + (1 + MOTION_MARGIN) * period,
      this.motionStart + MOTION_MIN_STEP * period * Math.min(steps, MOTION_CATCH_UP),
    );
  }

  /**
   * Fill this.pose (and the turret facing and body up vector) for one presentation. A mobile object plays each logic
   * step from the pose it was last shown in, so a new snapshot never makes it jump; an object first seen, hidden
   * until now or teleported starts from the snapshots as before.
   */
  private presentPose(
    object: LiveObject,
    visual: Visual,
    before: LiveObject | undefined,
    current: Timed,
    alpha: number,
  ): void {
    const pose = this.pose;
    const motion = (visual.motion ??= newMotion());
    if (motion.segment !== current) {
      motion.segment = current;
      motion.hasFrom = motion.hasShown;
      if (motion.hasShown) Object.assign(motion.from, motion.shown);
    }
    const tilt = object.tilt;
    let start = motion.hasFrom ? motion.from : undefined;
    if (!start && before) {
      start = POSE_START;
      start.x = before.x;
      start.y = before.y;
      start.z = before.z;
      start.facing = before.facingRaw;
      start.turret = before.turretFacingRaw ?? before.facingRaw;
      start.tilt = !!before.tilt;
      if (before.tilt) {
        start.ux = before.tilt.x;
        start.uy = before.tilt.y;
        start.uz = before.tilt.z;
      }
    }
    const near = !!start && Math.hypot(object.x - start.x, object.y - start.y) / LEPTONS_PER_CELL < TELEPORT_CELLS;
    const shown = motion.shown;
    if (near) {
      const from = start!;
      shown.x = lerp(from.x, object.x, alpha);
      shown.y = lerp(from.y, object.y, alpha);
      shown.z = lerp(from.z, object.z, alpha);
      shown.facing = wrap16(lerpRaw16(from.facing, object.facingRaw, alpha));
      shown.turret = wrap16(lerpRaw16(from.turret, object.turretFacingRaw ?? object.facingRaw, alpha));
      if (tilt && from.tilt) {
        const ux = lerp(from.ux, tilt.x, alpha);
        const uy = lerp(from.uy, tilt.y, alpha);
        const uz = lerp(from.uz, tilt.z, alpha);
        const length = Math.hypot(ux, uy, uz) || 1;
        shown.ux = ux / length;
        shown.uy = uy / length;
        shown.uz = uz / length;
      }
    } else {
      shown.x = object.x;
      shown.y = object.y;
      shown.z = object.z;
      shown.facing = object.facingRaw;
      shown.turret = object.turretFacingRaw ?? object.facingRaw;
    }
    if (tilt && !(near && start!.tilt)) {
      shown.ux = tilt.x;
      shown.uy = tilt.y;
      shown.uz = tilt.z;
    }
    shown.tilt = !!tilt;
    motion.hasShown = true;
    pose.x = shown.x;
    pose.y = shown.y;
    pose.z = shown.z;
    pose.facing = (shown.facing / 65536) * Math.PI * 2;
    this.poseTurret = (shown.turret / 65536) * Math.PI * 2;
    // Engine axes (x, y, z up) to world axes (x, y up, z).
    this.poseUp = tilt ? POSE_UP.set(shown.ux, shown.uz, shown.uy) : null;
  }

  /** Native current-cell policy uses the rules type, including while its unloading image is substituted. */
  private harvesterBonus(object: LiveObject): number {
    return harvesterRefineryBonus(
      !!this.library?.type(object.type)?.harvester,
      object.x,
      object.y,
      this.refineryCells ?? new Set(),
    );
  }

  /** Ground registrations on terrain or a stock bridge deck; rising/flying art keeps physical depth. */
  private groundCard(object: LiveObject): boolean {
    if ((object.renderOrder?.layer ?? 2) !== 2) return false;
    const x = object.x / LEPTONS_PER_CELL;
    const y = object.y / LEPTONS_PER_CELL;
    const height = (object.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT;
    // The surface under the unit, not the nearest grid node: on a ramp the node is up to a quarter level off, which
    // dropped the ground card (and the contact shadow) for half of every cell driven.
    const terrain = this.world.terrain;
    if (terrain.surfaceHeightAt && height <= terrain.surfaceHeightAt(x, y) + GROUND_TOLERANCE) return true;
    const ground = terrain.heightAt(x, y);
    if (height <= ground + 0.01) return true;
    if (Math.abs(height - ground - HIGH_BRIDGE_HEIGHT) > 0.01) return false;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cells = this.current?.snapshot.overlays;
    if (cells) {
      const dx = cx - cells.originX;
      const dy = cy - cells.originY;
      if (dx < 0 || dy < 0 || dx >= cells.width || dy >= cells.height) return false;
      const type = cells.types[cells.index[dy * cells.width + dx]!];
      return !!type && isHighBridge(type);
    }
    return this.cache.manifest.objects.some(
      (o) => o.kind === 'overlay' && o.x === cx && o.y === cy && isHighBridge(o.type),
    );
  }

  /** Refresh only logic/art/visibility inputs. Static cards have physical depth and never join unit uploads. */
  private applyPainterOrder(): void {
    this.painterDirty = false;
    const objects = this.painterObjects;
    objects.length = 0;
    for (const visual of this.visuals.values()) {
      if (!visual.root.visible || !visual.painter) continue;
      objects.push(visual.painter);
    }
    for (const effect of this.effectInstances) {
      if (effect.pass !== 'ground' || effect.draw !== 'card') continue;
      const painter = (effect.painter ??= painterObject(2, (effect.anchor.x + effect.anchor.z) * LEPTONS_PER_CELL));
      painter.afterEqual = true;
      objects.push(painter);
    }
    if (this.projectiles) for (const entry of this.projectiles.painterEntries()) objects.push(entry.painter);
    assignPainterBias(objects);
    for (const visual of this.visuals.values()) {
      const painter = visual.painter;
      if (!painter || !visual.root.visible) continue;
      if (visual.mode === 'voxel') this.voxelUnits.setPainterBias(visual, spritePainterBias(painter));
      if (visual.buildingTurret) this.voxelUnits.setPainterBias(visual.buildingTurret, spritePainterBias(painter, 0.4));
    }
    if (this.projectiles)
      for (const entry of this.projectiles.painterEntries())
        this.voxelUnits.setPainterBias(entry, spritePainterBias(entry.painter));
    // Effects are uploaded only by their own snapshot/art rebuild, never by an interpolated unit upload.
    if (this.effectsDirty) {
      this.effectsDirty = false;
      this.effectSprites?.setInstances(this.effectInstances, this.hd.seconds());
      this.hd.setTopEffectsVisible(this.effectSprites?.topVisible ?? false);
    }
    this.flushSprites(this.spriteBatch);
  }

  /** Native effect art: anims, smoke particles, projectiles and debris, on the logic frame of the newest snapshot. */
  private applyEffects(snapshot: LiveSnapshot): void {
    if (!this.effectArt || !this.effectSprites) return;
    const instances = this.effectInstances;
    instances.length = 0;
    this.particlePool.begin();
    this.effectsDirty = true;
    this.effectStats = this.effectDriver.cards(this.effectArt, this.effectPalette, instances);
    this.volumeInstances.length = 0;
    this.effectDriver.volumes(this.effectArt, this.volumeInstances);
    this.volumetricBlasts.setBlasts(this.volumeInstances);
    this.effectDriver.smokeCards(this.effectArt, instances);
    this.underlayCards(snapshot, instances);
    const effects = visibleObjectEffects(snapshot);
    this.projectiles?.update(effects?.bullets ?? [], effects?.voxelAnims ?? [], this.hidden, instances);
    if (effects) this.particleCards(effects, instances);
    // An async art revision, rather than every presentation frame, schedules the next rebuild.
    this.painterDirty = true;
  }

  /** Art the engine draws inside an object's own picture, under its body (LiveObject.underlay). */
  private underlayCards(snapshot: LiveSnapshot, out: EffectInstance[]): void {
    const hd = this.effectDriver.style === 'enhanced' && this.effectDriver.hdEnabled;
    for (const object of snapshot.objects) {
      if (!object.underlay) continue;
      const card = objectUnderlayCard(
        object,
        this.effectArt!,
        hd,
        this.hidden,
        this.hd.emissiveOverlay.toCamera.value,
        this.particlePool.anchor(),
      );
      if (card) out.push(card);
    }
  }

  /** Particles the host reports one by one (bridge): their ParticleType art. */
  private particleCards(effects: LiveEffects, out: EffectInstance[]): void {
    for (const system of effects.particleSystems) {
      for (const particle of system.particles ?? []) {
        if (!particle.type || this.shroud.isLocationShrouded(particle.x, particle.y, particle.z)) continue;
        const found = this.effectArt!.particle(particle.type);
        if (!found) continue;
        const frame = found.sprite.frames[(particle.frame ?? 0) % found.sprite.frames.length];
        if (!frame || frame.rect[2] <= 0) continue;
        const anim: LiveAnim = { id: 0, uid: 0, type: particle.type, ...particle };
        out.push({
          anchor: leptonAnchor(anim.x, anim.y, anim.z, 0, 0, this.particlePool.anchor()),
          frame,
          palette: 'fx:anim',
          // Particles (ParticleClass, not AnimClass) take their type's constant Translucency; none of the YR particle
          // types is Translucent=yes, the anim-only staged fade (animAlpha).
          alpha: animAlpha({ translucency: found.art.translucency }),
          push: cardPush(frame),
          draw: 'card',
          pass: 'air',
          depth: ((anim.x + anim.y) * 15) / 256 - (anim.z / 104) * 15,
          glow: false,
        });
      }
    }
  }

  /** Palette row of an anim: AltPalette art takes its owner's colours when the owner is known. */
  private animPalette(resolved: ResolvedAnim, owner: number | undefined): string {
    if (!resolved.remap) return resolved.palette;
    const colorIndex = owner !== undefined && owner >= 0 ? this.houseColour.get(owner) : undefined;
    return paletteFor(this.cache, resolved.palette, true, colorIndex !== undefined ? `live${colorIndex}` : undefined);
  }

  /** Voxel palette (debris, missiles): the library unit palette, house-remapped when the owner is known. */
  private unitPalette(owner: number | undefined): string {
    const base = this.library ? `${LIBRARY_PALETTE_PREFIX}unit` : 'unit';
    const colorIndex = owner !== undefined && owner >= 0 ? this.houseColour.get(owner) : undefined;
    return paletteFor(this.cache, base, true, colorIndex !== undefined ? `live${colorIndex}` : undefined);
  }

  /**
   * Hand each atlas its instances; library pages get their sprite layer when their texture has loaded. Layers that
   * were empty and stay empty are not touched; retained layers compare and upload only dirty attribute ranges.
   *
   * A page's final layer needs its HD art, 50 MB that are still being decoded and uploaded when the 2 MB indexed page
   * is long in. A shown view does not leave the page's objects undrawn until then (measured before this: a
   * construction yard and a refinery without any picture for 46 and 47 presented frames after they were placed, and
   * 25.8 s for the refinery on a loaded machine): their sprites go to the page's indexed layer meanwhile, the one
   * `queue` uses for art that is always drawn indexed. The records are the same ones the final
   * layer gets when it exists (anchor, frame rectangle, palette row with the house colours, depth profile), and both
   * layers place a frame by the indexed atlas's own pixels, so the change to HD art moves and resizes nothing. Out of
   * sight nothing is drawn early: the page counts as art on its way and the view is not shown before it is in.
   */
  private flushSprites(batch: SpriteBatch, reorder = true): void {
    const map = batch.get('map') ?? EMPTY_SPRITES;
    if (map.length || this.sprites.mesh.instances) this.sprites.setInstances(map, reorder);
    const meanwhile = this.indexedMeanwhile;
    for (const list of meanwhile.values()) list.length = 0;
    this.indexedSprites = 0;
    for (const key of batch.keys()) {
      const instances = batch.get(key)!;
      if (key === 'map' || key < 0 || !instances.length) continue;
      const layer = this.pageLayer(key);
      if (layer) {
        layer.setInstances(instances, reorder);
        continue;
      }
      if (this.outOfSight) continue;
      this.requestMasks(key);
      let list = meanwhile.get(key);
      if (!list) meanwhile.set(key, (list = []));
      for (const instance of instances) list.push(instance);
      this.indexedSprites += instances.length;
    }
    for (const [page, list] of meanwhile) {
      if (!list.length) continue;
      // With the page's own indexed sprites in one layer; the layer orders its cards itself.
      for (const instance of batch.get(-1 - page) ?? EMPTY_SPRITES) list.push(instance);
      this.pageLayer(-1 - page)?.setInstances(list, reorder);
    }
    for (const key of batch.keys()) {
      const instances = batch.get(key)!;
      if (key === 'map' || key >= 0 || !instances.length || meanwhile.get(-1 - key)?.length) continue;
      this.pageLayer(key)?.setInstances(instances, reorder);
    }
    for (const key of this.pageLayers.keys()) {
      const layer = this.pageLayers.get(key)!.layer;
      if (!layer.mesh.instances || batch.get(key)?.length) continue;
      if (key < 0 && meanwhile.get(-1 - key)?.length) continue;
      layer.setInstances(EMPTY_SPRITES);
    }
  }

  /**
   * Ask for the masks the final layer of `page` will be built with, while its sprites are drawn from the indexed page:
   * they load beside the HD art instead of after it, so the layer is usually built once, complete.
   */
  private requestMasks(page: number): void {
    const library = this.library!;
    if (this.hd.windowsWanted() && library.hasWindowsPage(page)) library.windowsPage(page);
    if (this.hd.materialsWanted() && library.hasMaterialsPage(page)) library.materialsPage(page);
  }

  /** Sprite layer of a library page; negative keys (-1 - page) are the page's indexed-only layer (see queue). */
  private pageLayer(key: number): SpriteLayer | null {
    const indexedOnly = key < 0;
    const page = indexedOnly ? -1 - key : key;
    const existing = this.pageLayers.get(key);
    // Window masks are atlas-sized (a 4096 page costs 64 MB on the GPU): load a page's mask only once night falls,
    // then rebuild its layer with it; by day and while the mask loads the layer draws without. Decided from the hour
    // (not windowGain, which hd.frame only sets after this), so a match starting at night builds each layer once.
    const wantWindows = this.hd.windowsWanted() && this.library!.hasWindowsPage(page);
    const wantMaterials = !indexedOnly && this.hd.materialsWanted() && this.library!.hasMaterialsPage(page);
    if (existing && (existing.windows || !wantWindows) && (existing.materials || !wantMaterials)) return existing.layer;
    const atlas = this.library?.page(page);
    if (!atlas) return existing?.layer ?? null;
    // Wait for the page's HD art when it has it, so a layer is never built twice for its colour texture. Meanwhile
    // a shown view draws the page's sprites from its indexed layer (flushSprites).
    const hd = indexedOnly ? null : this.library!.hdPage(page);
    if (!indexedOnly && !hd && this.library!.hasHdPage(page)) return existing?.layer ?? null;
    // Retain already attached masks when the other sidecar arrives, even if the hour/look changed meanwhile.
    const windows = wantWindows || existing?.windows ? this.library!.windowsPage(page) : null;
    const materials = wantMaterials || existing?.materials ? this.library!.materialsPage(page) : null;
    // While a wanted mask loads, keep drawing what exists instead of building twice. A first layer waits for it out
    // of sight only: a shown view draws the page's art without lit windows until the mask is in.
    if (wantWindows && !windows && (existing || this.outOfSight)) return existing?.layer ?? null;
    // On first use, draw the available art while materials load. Later arrivals replace the mesh just once.
    if (existing && wantMaterials && !materials) return existing.layer;
    // Out of sight there is no first use to serve: wait for the material page and build the layer once.
    if (!existing && wantMaterials && !materials && this.outOfSight) return null;
    if (!this.admitNewArt()) return existing?.layer ?? null;
    if (existing) {
      const mesh = existing.layer.mesh;
      this.root.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
      mesh.dispose();
    }
    const layer = new SpriteLayer(
      this.cache,
      [],
      LIVE_SPRITE_CAPACITY,
      atlas,
      hd,
      windows,
      materials,
      this.hd.terrainDepth,
    );
    layer.mesh.name = `live-sprites-${key}`;
    this.shareSpriteUniforms(layer);
    this.root.add(layer.mesh);
    this.pageLayers.set(key, { layer, windows: !!windows, materials: !!materials });
    return layer;
  }

  private shareSpriteUniforms(layer: {
    cameraRight: SpriteLayer['cameraRight'];
    cameraUp: SpriteLayer['cameraUp'];
    toCamera: SpriteLayer['toCamera'];
    light: SpriteLayer['light'];
  }): void {
    // The static layer's camera and light uniforms are updated by HdRenderer every frame; share their values.
    const shared = this.world.sprites;
    if (!shared) return;
    layer.cameraRight.value = shared.cameraRight.value;
    layer.cameraUp.value = shared.cameraUp.value;
    layer.toCamera.value = shared.toCamera.value;
    layer.light.value = shared.light.value;
  }

  /**
   * Queue a library frame on its atlas page (skipped while the page loads). `indexed` explicitly retains source art,
   * including shadows whose HD rectangles are empty. Building foregrounds use HD regardless of Remapable=:
   * indexedHousePaint recovers missing/baked house paint through the owner's palette without discarding the redraw.
   */
  private queue(batch: SpriteBatch, instance: ObjectSprite, indexed = false): void {
    const page = instance.frame.page ?? 0;
    const picture = this.picture;
    if (!this.library?.page(page)) {
      // Nothing to draw this sprite from yet. Its HD art is asked for now, beside the indexed page and not after it.
      if (!indexed) this.library?.hdPage(page);
      // A missing shadow leaves a picture usable; a missing part does not.
      if (picture && !instance.shadow) picture.incomplete = true;
      return;
    }
    const key = indexed && this.library.hasHdPage(page) ? -1 - page : page;
    let list = batch.get(key);
    if (!list) batch.set(key, (list = []));
    list.push(instance);
    if (!picture) return;
    const i = picture.count++;
    picture.sprites[i] = instance;
    picture.indexed[i] = indexed;
    picture.keys[i] = key;
  }

  /**
   * Start recording the sprites of the object about to be drawn, when pages of its type are still on their way (see
   * HeldPicture); false once they are all in, which is the normal case and costs one test per object and frame.
   * `pose` is the object's presented position.
   *
   * The type's pages are fetched here, all of them and as indexed pages only: the one the object draws from now is
   * asked for by `queue` anyway, and the others (a build-up on one page and the body on the next, a soldier whose
   * sequences span two) are what a change of state draws from next.
   */
  private beginPicture(visual: Visual, pose: Pose): boolean {
    if (visual.pagesIn) return false;
    const library = this.library!;
    let pagesIn = true;
    for (const page of library.typePages(visual.libraryType!)) if (!library.preloadPage(page)) pagesIn = false;
    if (pagesIn) {
      visual.pagesIn = true;
      visual.held = undefined;
      return false;
    }
    leptonAnchor(pose.x, pose.y, pose.z, 0, 0, this.pictureBase);
    const picture = (this.picture = this.pictureScratch);
    picture.count = 0;
    picture.incomplete = false;
    return true;
  }

  /**
   * The object's sprites are queued. A complete picture is kept; an incomplete one is replaced by the picture kept
   * before, so a change of state shows the old art until the new art can be drawn. Without an earlier picture (the
   * object's first frames) what could be queued stays.
   */
  private endPicture(visual: Visual, batch: SpriteBatch): void {
    const picture = this.picture!;
    this.picture = null;
    if (!picture.incomplete) {
      (visual.held ??= new HeldPicture()).capture(this.pictureBase, picture.sprites, picture.indexed, picture.count);
      return;
    }
    const held = visual.held;
    if (!held?.size) {
      this.incompletePictures++;
      return;
    }
    // The object's own sprites are the last ones of their lists: objects are drawn one after another.
    for (let i = picture.count - 1; i >= 0; i--) batch.get(picture.keys[i]!)!.pop();
    held.replay(this.spritePool, this.pictureBase, (instance, indexed) => this.queue(batch, instance, indexed));
    this.heldPictures++;
  }

  /**
   * A building's library art: bib, shadow, native body frame and its independently damaged animation layers;
   * while it is being built, its make anim instead. Unit-palette buildings wear their owner's colour scheme (the engine
   * remaps unit-palette buildings, e.g. civilian CAOILD shows Neutral light grey), whatever art Remapable= says.
   * ISO-palette building art uses the cell's terrain converter and keeps its original palette ramp.
   */
  private libraryBuildingSprites(
    object: LiveObject,
    visual: Visual,
    batch: SpriteBatch,
    snapshot: LiveSnapshot,
  ): boolean {
    const library = this.library!;
    const type = visual.libraryType!;
    const sprites = library.library.sprites;
    const entry = sprites[type.sprite!];
    if (!entry) return false;

    const anchor = leptonAnchor(
      object.x,
      object.y,
      object.z,
      type.drawOffset[0],
      type.drawOffset[1],
      this.spritePool.anchor(),
    );
    const frame = snapshot.frame;
    const civilian = object.owner < 0 || this.civilian.has(object.owner);

    const buildup = this.buildupFrame(object, visual, frame);
    if (buildup !== null) {
      const make = sprites[type.building!.buildup!]!;
      const mk = make.frames[buildup];
      const shadow = make.shadows?.[buildup];
      if (shadow)
        this.queue(
          batch,
          this.spritePool.take(anchor, shadow, this.buildingPalette(make, visual.paletteKey), 0, true, true),
          true,
        );
      if (mk && mk.rect[2] > 0) {
        const card = this.spritePool.take(
          anchor,
          mk,
          this.buildingPalette(make, visual.paletteKey),
          cardPush(mk),
          false,
        );
        card.nativeDepth = buildingDepthProfile(
          mk,
          type.foundation ?? [1, 1],
          type.building?.zShape,
          object.buildState ?? 'building',
          undefined,
          this.cache.depthTemplate,
        );
        card.indexedHousePaint = !make.remap && make.palette !== 'iso';
        this.queue(batch, card);
      }
      return false;
    }

    const damaged = object.buildingDamaged ?? object.health <= library.conditionYellow;
    const body = object.buildingFrame ?? (damaged && entry.frames.length > 1 ? 1 : 0);
    const bib = type.building?.bib ? sprites[type.building.bib] : undefined;
    const bibFrame = bib?.frames[damaged && bib.frames.length > 1 ? 1 : 0];
    if (bib && bibFrame) {
      const card = this.spritePool.take(
        anchor,
        bibFrame,
        this.buildingPalette(bib, visual.paletteKey),
        this.cache.depthTemplate ? cardPush(bibFrame) : 0,
        false,
        !this.cache.depthTemplate,
      );
      if (this.cache.depthTemplate) card.nativeDepth = { mode: 'ground', bonus: 2 };
      card.indexedHousePaint = !bib.remap && bib.palette !== 'iso';
      this.queue(batch, card);
    }
    const layers = type.building?.layers ?? EMPTY_LAYERS;
    // The native picture changes the delivery image one logic frame after the state (BuildingVisualHistory).
    const unloading = this.buildingVisualHistory
      ? this.buildingVisualHistory.shownUnloading(object, frame)
      : object.unloading;
    const deployingKey = unloading === 'roof' ? 'RoofDeployingAnim' : 'DeployingAnim';
    const doorKey = unloading === 'roof' ? 'UnderRoofDoorAnim' : 'UnderDoorAnim';
    const deploying = unloading ? sprites[layers.find((layer) => layer.key === deployingKey)?.sprite ?? ''] : undefined;
    const door = unloading ? sprites[layers.find((layer) => layer.key === doorKey)?.sprite ?? ''] : undefined;
    // Delivery images are body replacements. Explicit construction/selling state still owns the art path
    // even when a library has no make sprite. The interior uses the native ground gradient.
    const delivering =
      object.buildState !== 'building' &&
      object.buildState !== 'selling' &&
      !!deploying?.frames.length &&
      !!door?.frames.length;
    const bodyArt = delivering ? deploying! : entry;
    // The native cap is inclusive and counts the source SHP's shadow half. At the boundary it really
    // selects that half's first source frame; clamping to the last foreground frame changes the image.
    const sourceFrames = bodyArt.frameCount ?? bodyArt.frames.length + (bodyArt.shadows?.length ?? 0);
    const shownBody = delivering ? Math.min(body, Math.trunc(sourceFrames / 2)) : body;
    const shadow = bodyArt.shadows?.[shownBody];
    if (shadow)
      this.queue(
        batch,
        this.spritePool.take(anchor, shadow, this.buildingPalette(bodyArt, visual.paletteKey), 0, true, true),
        true,
      );
    const bodyFrame =
      bodyArt.frames[shownBody] ?? (delivering ? bodyArt.shadows?.[shownBody - bodyArt.frames.length] : undefined);
    // A body frame without pixels still places the building's layers: the nuclear silo's body SHP is empty and
    // the whole building is its SuperAnim layers. With the empty rectangle the layers took a push of nothing and the
    // depth of a body ending at the canvas top, 101 px above the draw point, so the ground hid the silo entirely
    // (only the tip of its missile showed). The SHP's whole canvas stands in for the body: its push, and the depth of
    // a building of this foundation whose picture fills the canvas. (A flat card at the building's sort line was
    // tried instead: everything below the draw point's row, half the silo, was then cut by the ground.)
    const depthFrame = bodyFrame && bodyFrame.rect[2] <= 0 ? (canvasFrame(bodyArt) ?? bodyFrame) : bodyFrame;
    const push = depthFrame ? cardPush(depthFrame) : 0.03;
    const nativeDepth = depthFrame
      ? buildingDepthProfile(
          depthFrame,
          type.foundation ?? [1, 1],
          type.building?.zShape,
          object.buildState,
          delivering ? unloading : undefined,
          this.cache.depthTemplate,
        )
      : undefined;
    if (bodyFrame && bodyFrame.rect[2] > 0) {
      const card = this.spritePool.take(
        anchor,
        bodyFrame,
        this.buildingPalette(bodyArt, visual.paletteKey),
        push,
        false,
      );
      card.nativeDepth = nativeDepth;
      card.indexedHousePaint = !bodyArt.remap && bodyArt.palette !== 'iso';
      // HD atlases intentionally clear shadow rectangles. An inclusive-cap source shadow used as a body
      // must sample its original indexed pixels instead of that empty HD rectangle.
      this.queue(batch, card, shownBody >= bodyArt.frames.length);
    }

    if (delivering) {
      const doorFrame = door!.frames[Math.min(damaged ? 1 : 0, door!.frames.length - 1)];
      if (doorFrame && doorFrame.rect[2] > 0) {
        const interior = this.spritePool.take(
          anchor,
          doorFrame,
          this.buildingPalette(door!, visual.paletteKey),
          push,
          false,
        );
        if (this.cache.depthTemplate) interior.nativeDepth = { mode: 'ground', bonus: 1 };
        interior.indexedHousePaint = !door!.remap && door!.palette !== 'iso';
        this.queue(batch, interior);
      }
    }
    const native = this.nativeBuildingAnims(object, type);

    if (native) {
      // Bridge: exactly the layers the engine plays, at the engine's frame.
      for (const anim of native) {
        for (const layer of layers) {
          if (animId(layer.sprite) !== anim.type && (!layer.damagedSprite || animId(layer.damagedSprite) !== anim.type))
            continue;
          this.buildingLayerSprites(
            object,
            visual,
            batch,
            frame,
            damaged,
            anchor,
            push,
            layer,
            anim.frame ?? null,
            nativeDepth,
          );
          break;
        }
      }
      return true;
    }
    const storesOre = this.effectArt?.storesOre(object.type) ?? looksLikeStorage(layers);
    for (const layer of layers) {
      if (!fallbackLayer(layer, storesOre)) continue;
      this.buildingLayerSprites(
        object,
        visual,
        batch,
        frame,
        damaged,
        anchor,
        push,
        layer,
        layerIdle(layer, object.type, civilian && object.owner >= 0) ? (layer.anim.start ?? 0) : null,
        nativeDepth,
      );
    }
    return true;
  }

  private libraryPalette(palette: string): string {
    let key = this.libraryPaletteKeys.get(palette);
    if (!key) this.libraryPaletteKeys.set(palette, (key = LIBRARY_PALETTE_PREFIX + palette));
    return key;
  }

  private buildingPalette(art: { palette: string }, owner: string): string {
    // The source ISO contract uses CellClass's terrain converter without a house
    // ramp (YR 1.001: BuildingType +0x1702; drawing at 0x4D1ED2 / 0x705EC7).
    return paletteFor(this.cache, this.libraryPalette(art.palette), art.palette !== 'iso', owner || undefined);
  }

  private buildingLayerSprites(
    object: LiveObject,
    visual: Visual,
    batch: SpriteBatch,
    frame: number,
    damaged: boolean,
    anchor: Vector3,
    push: number,
    layer: LibraryAnimLayer,
    index: number | null,
    nativeDepth?: NativeSpriteDepth,
  ): void {
    const type = visual.libraryType!;
    const sprites = this.library!.library.sprites;
    const art = sprites[damaged && layer.damagedSprite ? layer.damagedSprite : layer.sprite];
    if (!art?.frames.length) return;
    const timing = this.effectArt?.anim(animId(layer.sprite))?.art;
    const shown = Math.min(
      art.frames.length - 1,
      Math.max(
        0,
        index ?? layerFrame(layer, art.frames.length, frame, timing?.rateFrames, timing?.normalized ?? false),
      ),
    );
    const layerFrameArt = art.frames[shown];
    const dx = layer.offset?.[0] ?? 0;
    const dy = (layer.offset?.[1] ?? 0) + (layer.yDrawOffset ?? 0);
    const layerAnchor =
      dx || dy
        ? leptonAnchor(
            object.x,
            object.y,
            object.z,
            type.drawOffset[0] + dx,
            type.drawOffset[1] + dy,
            this.spritePool.anchor(),
          )
        : anchor;
    // Art Shadow=yes layers (the derrick's pump, flags, radar dishes) cast their own shadow frames.
    const layerShadow = layer.anim.shadow ? art.shadows?.[shown] : undefined;
    if (layerShadow && layerShadow.rect[2] > 0)
      this.queue(
        batch,
        this.spritePool.take(layerAnchor, layerShadow, this.buildingPalette(art, visual.paletteKey), 0, true, true),
        true,
      );
    if (!layerFrameArt || layerFrameArt.rect[2] <= 0) return;
    const card = this.spritePool.take(
      layerAnchor,
      layerFrameArt,
      this.buildingPalette(art, visual.paletteKey),
      push + 0.01,
      false,
      false,
      undefined,
      undefined,
      0.1,
    );
    if (nativeDepth) {
      if (layer.key === 'DoorAnim') {
        card.nativeDepth = { mode: 'ground', bonus: 6 };
        card.depthWrite = false;
      } else if (layer.key === 'UnderDoorAnim' || layer.key === 'UnderRoofDoorAnim') {
        card.nativeDepth = { mode: 'ground', bonus: 1 };
      } else card.nativeDepth = attachedBodyDepth(nativeDepth, [dx, dy], dy * GROUND_DEPTH);
    }
    card.indexedHousePaint = !art.remap && art.palette !== 'iso';
    this.queue(batch, card);
  }

  /**
   * A building's voxel turret (rules TurretAnimIsVoxel=yes: sentry gun, flak cannon, Patriot, Grand Cannon, Gattling
   * cannon ...), turned by the building's facing (`turretFacing` in radians; null while the building is being built or
   * sold, when its make anim shows instead). The engine draws the turret at the building's draw point plus
   * TurretAnimX/Y pixels, after the body (TurretAnimZAdjust < 0): here it stands at that screen point on the
   * building's level. The established geometry pull keeps lighting and screen placement unchanged; native depth
   * uses the unpushed draw anchor and the turret's own bitmap card, retaining only the KAPPA physical residual.
   * Its shadow uses a bounded
   * physical origin on that view ray nearest the foundation centre, with ordinary ground shear instead of flight drift.
   * The model file loads on first use (or ahead, see LiveLibrary.preloadVoxels); until then (and when it is missing)
   * it counts in diagnostics().
   */
  private buildingTurret(object: LiveObject, visual: Visual, turretFacing: number | null): void {
    const spec = visual.libraryType?.building?.turretVoxel;
    if (!spec) return;
    if (!visual.buildingTurret) {
      const loaded = this.library!.voxel(spec.voxel);
      // The mesh is built off this thread. A shown turret is drawn from its stand-in until then; out of sight it
      // counts as loading, like its model file (see voxelDrawable).
      const model = loaded && this.voxelDrawable(loaded) ? loaded : null;
      visual.turretState = model ? 'ready' : !loaded && this.library!.voxelFailed(spec.voxel) ? 'missing' : 'loading';
      if (!model) return;
      const key = paletteFor(
        this.cache,
        this.libraryPalette(model.palette),
        visual.libraryType!.remap,
        visual.paletteKey || undefined,
      );
      const cacheKey = `${spec.voxel}@${key}`;
      if (this.outOfSight && !this.voxelUnits.built(cacheKey) && !this.admitNewArt()) {
        visual.turretState = 'loading';
        return;
      }
      visual.buildingTurret = this.voxelUnits.build(model, key, cacheKey);
      this.voxelUnits.setBuildingPart(visual.buildingTurret);
      visual.root.add(visual.buildingTurret.root);
    }
    const unit = visual.buildingTurret;
    unit.root.visible = turretFacing !== null;
    if (turretFacing === null) return;
    const type = visual.libraryType!;
    const at = leptonAnchor(
      object.x,
      object.y,
      object.z,
      type.drawOffset[0] + spec.offset[0],
      type.drawOffset[1] + spec.offset[1],
      this.spritePool.anchor(),
    );
    const groundAnchor = this.spritePool.anchor().copy(at);
    const body = this.library!.library.sprites[type.sprite!]?.frames[0];
    const foundation = type.foundation;
    const push =
      (foundation
        ? foundationPointPush(
            at.x - Math.floor(object.x / LEPTONS_PER_CELL),
            at.z - Math.floor(object.y / LEPTONS_PER_CELL),
            foundation[0],
            foundation[1],
          )
        : body
          ? cardPush(body)
          : 0.5) + TURRET_DEPTH;
    const toCamera = this.world.sprites?.toCamera.value;
    if (toCamera) {
      at.addScaledVector(toCamera, push);
      const [w, h] = foundation ?? [1, 1];
      const centre = this.spritePool
        .anchor()
        .set(
          Math.floor(object.x / LEPTONS_PER_CELL) + w / 2,
          (object.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT,
          Math.floor(object.y / LEPTONS_PER_CELL) + h / 2,
        );
      setShadowOrigin(unit.root, buildingTurretShadowOrigin(at, toCamera, centre, centre));
    } else setShadowOrigin(unit.root);
    const pose = this.pose;
    pose.x = at.x * LEPTONS_PER_CELL;
    pose.y = at.z * LEPTONS_PER_CELL;
    pose.z = (at.y / LEVEL_HEIGHT) * LEPTONS_PER_LEVEL;
    pose.facing = Math.PI / 2;
    this.voxelUnits.pose(unit, pose, turretFacing);
    this.voxelUnits.setTint(unit, object.tint);
    this.voxelUnits.setNativeDepth(
      unit,
      groundAnchor,
      -1 - (spec.zAdjust ?? 0),
      !!this.cache.depthTemplate && (object.renderOrder?.layer ?? 2) === 2,
    );
  }

  /**
   * The building's own anims from the engine list (bridge: entries flagged buildingAnim). The reader leaves their
   * attachment empty, so they are matched by position: an anim belongs to the building whose foundation holds it.
   */
  private nativeBuildingAnims(object: LiveObject, type: LibraryType): LiveAnim[] | null {
    const last = this.buildingVisualHistory?.retained.get(object.uid);
    const index = last ? indexBuildingAnims(last.snapshot.effects?.anims) : this.buildingAnims;
    if (!index) return null;
    const cached = this.buildingAnimMatches.get(object.uid);
    if (cached) return cached;
    const [w, h] = type.foundation ?? [1, 1];
    const x0 = Math.floor(object.x / LEPTONS_PER_CELL);
    const y0 = Math.floor(object.y / LEPTONS_PER_CELL);
    const found: [number, LiveAnim][] = [...(index.attached.get(object.uid) ?? [])];
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) for (const entry of index.cells.get(y * 4096 + x) ?? []) found.push(entry);
    // In the engine's list order, like the list itself.
    const matched = found.sort((a, b) => a[0] - b[0]).map(([, anim]) => anim);
    this.buildingAnimMatches.set(object.uid, matched);
    return matched;
  }

  /**
   * Build-up frame of a building under construction, or null when it stands complete. Bridge (H2): the engine's own
   * state and absolute SHP frame, with engine sale/gate reversal already applied. Fallback: a building first pushed after
   * the view's first BUILDUP_GRACE_FRAMES plays its make anim once, buildupStepFrames logic frames per frame. New
   * objects after a snapshot gap longer than BUILDUP_LOGIC_FRAMES are assumed complete; their actual placement time
   * is unknown. Rendering gaps and delayed art never restart this clock. Selling needs the bridge.
   */
  private buildupFrame(object: LiveObject, visual: Visual, frame: number): number | null {
    const make = visual.libraryType?.building?.buildup;
    const sprite = make ? this.library!.library.sprites[make] : undefined;
    if (!sprite?.frames.length) return null;
    const count = sprite.frames.length;
    if (object.buildState !== undefined) {
      if (object.buildState === 'done') return null;
      const shown = object.buildupFrame ?? (object.buildState === 'selling' ? count - 1 : 0);
      return Math.min(count - 1, Math.max(0, shown));
    }
    const appearance = this.appearances.get(object.uid);
    if (!appearance || appearance.afterGap || this.firstFrame === null) return null;
    if (appearance.frame - this.firstFrame < BUILDUP_GRACE_FRAMES) return null;
    const step = Math.floor((frame - appearance.frame) / buildupStepFrames(count, NORMALIZED.has(object.type)));
    return step < count ? step : null;
  }

  /** Infantry: the bridge's sequence when given, else walking, dying or standing by logic-frame bookkeeping. */
  private libraryInfantrySprites(
    object: LiveObject,
    pose: Pose,
    visual: Visual,
    batch: SpriteBatch,
    frame: number,
  ): void {
    const type = visual.libraryType!;
    const entry = this.library!.library.sprites[type.sprite!];
    const sequences = type.infantry?.sequences;
    if (!entry) return;
    const facingRaw = object.infantryDrawFacingRaw ?? Math.round((pose.facing / (Math.PI * 2)) * 65536);
    const facing = (facingRaw >>> 8) & 255;
    let index: number | undefined;
    const named = object.infantrySequence ? sequences?.[object.infantrySequence] : undefined;
    if (named) index = sequenceFrame(named, facing, object.sequenceFrame ?? 0, facingRaw);
    else if (visual.deadFrame !== undefined && sequences?.Die1) {
      // Health 0: the first death sequence from the frame it died, holding its last frame.
      const die = sequences.Die1;
      index = sequenceFrame(
        die,
        facing,
        Math.min(die.count - 1, Math.floor((frame - visual.deadFrame) / 2)),
        facingRaw,
      );
    } else if (
      visual.firedFrame !== undefined &&
      sequences?.FireUp &&
      frame - visual.firedFrame < sequences.FireUp.count
    ) {
      index = sequenceFrame(sequences.FireUp, facing, frame - visual.firedFrame, facingRaw);
    } else {
      const walking = visual.lastMoveFrame !== undefined && frame - visual.lastMoveFrame <= WALK_FRAMES;
      const sequence = (walking ? sequences?.Walk : undefined) ?? sequences?.Ready ?? sequences?.Guard;
      // A legacy library without sequence metadata still draws its first body frame while awaiting regeneration.
      index = sequence ? sequenceFrame(sequence, facing, walking ? Math.floor(frame / 2) : 0, facingRaw) : 0;
    }
    const spriteFrame = entry.frames[index];
    if (!spriteFrame) return;
    const anchor = leptonAnchor(
      pose.x,
      pose.y,
      pose.z,
      type.drawOffset[0],
      type.drawOffset[1],
      this.spritePool.anchor(),
    );
    const palette = paletteFor(
      this.cache,
      this.libraryPalette(entry.palette),
      entry.remap && type.remap,
      visual.paletteKey || undefined,
    );
    const shadow = entry.shadows?.[index];
    if (shadow && shadow.rect[2] > 0 && shadow.rect[3] > 0) {
      const instance = this.spritePool.take(anchor, shadow, palette, 0, true, true);
      instance.infantryShadow = true;
      instance.infantryBare = hdInfantryPageIsBare(type.image) || undefined;
      this.queue(batch, instance);
    }
    const light = objectLight('infantry');
    const card = this.spritePool.take(anchor, spriteFrame, palette, cardPush(spriteFrame), false, undefined, light);
    card.opacity = object.translucent;
    if (this.groundCard(object))
      card.nativeDepth = { mode: 'card', bottom: spriteFrame.offset[1] + spriteFrame.rect[3] - 1, bonus: 12 };
    this.queue(batch, card);
  }

  /** SHP vehicles and aircraft (terror drone, squid, dolphin): directional frames per state (shpUnits.ts). */
  private libraryShpUnitSprites(
    object: LiveObject,
    pose: Pose,
    visual: Visual,
    batch: SpriteBatch,
    frame: number,
  ): void {
    const type = visual.libraryType!;
    const entry = this.library!.library.sprites[type.sprite!];
    if (!entry || !type.shpUnit) return;
    const facing = Math.round((pose.facing / (Math.PI * 2)) * 256) & 255;
    const moving = visual.lastMoveFrame !== undefined && frame - visual.lastMoveFrame <= WALK_FRAMES;
    const state =
      object.shpUnitPose ??
      shpUnitPose(
        type.shpUnit,
        this.effectArt?.shpUnitRates(object.type),
        frame,
        moving,
        visual.firedFrame ?? null,
        this.shpPose,
      );
    const index = Math.min(entry.frames.length - 1, shpUnitFrame(type.shpUnit, facing, state.state, state.step));
    const spriteFrame = entry.frames[index];
    if (!spriteFrame) return;
    const anchor = leptonAnchor(
      pose.x,
      pose.y,
      pose.z,
      type.drawOffset[0],
      type.drawOffset[1],
      this.spritePool.anchor(),
    );
    const palette = paletteFor(
      this.cache,
      this.libraryPalette(entry.palette),
      entry.remap && type.remap,
      visual.paletteKey || undefined,
    );
    const shadow = entry.shadows?.[index];
    if (shadow && shadow.rect[2] > 0) this.queue(batch, this.spritePool.take(anchor, shadow, palette, 0, true, true));
    const light = objectLight(object.kind);
    if (spriteFrame.rect[2] > 0) {
      const card = this.spritePool.take(anchor, spriteFrame, palette, cardPush(spriteFrame), false, undefined, light);
      card.opacity = object.translucent;
      if (this.groundCard(object))
        card.nativeDepth = {
          mode: 'card',
          bottom: spriteFrame.offset[1] + spriteFrame.rect[3] - 1,
          bonus: this.harvesterBonus(object),
        };
      this.queue(batch, card);
    }
  }

  /** A building whose art only the map cache has (library missing): the still frames the map extractor exported. */
  private mapBuildingSprites(object: LiveObject, visual: Visual, batch: SpriteBatch): void {
    const { manifest } = this.cache;
    const entry = manifest.sprites[visual.sprite!]!;
    const anchor = leptonAnchor(object.x, object.y, object.z, 0, -15, this.spritePool.anchor());
    const owner = visual.paletteKey || undefined;
    const frameIndex = object.buildingFrame ?? (object.health > CONDITION_YELLOW || entry.frames.length < 2 ? 0 : 1);
    const frame = entry.frames[frameIndex];
    if (!frame) return;
    // Buildings always wear their owner's colours (see libraryBuildingSprites).
    const palette = paletteFor(this.cache, entry.palette, true, owner);
    const push = cardPush(frame);
    const nativeDepth = buildingDepthProfile(
      frame,
      entry.foundation ?? [1, 1],
      undefined,
      object.buildState,
      undefined,
      this.cache.depthTemplate,
    );
    let list = batch.get('map');
    if (!list) batch.set('map', (list = []));
    for (const underlay of entry.underlays ?? EMPTY_IDS) {
      const bib = manifest.sprites[underlay];
      if (bib?.frames[0]) {
        const card = this.spritePool.take(
          anchor,
          bib.frames[0],
          paletteFor(this.cache, bib.palette, true, owner),
          nativeDepth ? cardPush(bib.frames[0]) : 0,
          false,
          !nativeDepth,
        );
        if (nativeDepth) card.nativeDepth = { mode: 'ground', bonus: 2 };
        list.push(card);
      }
    }
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) list.push(this.spritePool.take(anchor, shadow, palette, 0, true, true));
    const body = this.spritePool.take(anchor, frame, palette, push, false);
    body.nativeDepth = nativeDepth;
    list.push(body);
    for (const layer of entry.layers ?? EMPTY_IDS) {
      const art = manifest.sprites[layer];
      if (art?.frames[0]) {
        const card = this.spritePool.take(
          anchor,
          art.frames[0],
          paletteFor(this.cache, art.palette, true, owner),
          push + 0.01,
          false,
          false,
          undefined,
          undefined,
          0.1,
        );
        card.nativeDepth = nativeDepth;
        list.push(card);
      }
    }
  }

  private removeVisual(visual: Visual): void {
    if (visual.mode === 'voxel') this.voxelUnits.dispose(visual);
    else visual.root.removeFromParent();
    if (visual.buildingTurret) this.voxelUnits.dispose(visual.buildingTurret);
  }

  private visualFor(object: LiveObject, colorIndex: number, frame: number): Visual {
    const paletteKey = this.housePaletteKeys.get(colorIndex) ?? '';
    const artType = this.drawArt(object, paletteKey);
    const variant = artVariant(object);
    const turretSource = object.turretIndex ? this.voxelSource(artType, paletteKey, variant, object.turretIndex) : null;
    const turretIndex = turretSource ? selectedVoxelTurretIndex(turretSource.model) : 0;
    const existing = this.visuals.get(object.uid);
    const firstFrame = this.appearances.get(object.uid)?.frame ?? existing?.firstFrame ?? frame;
    if (existing) existing.firstFrame = firstFrame;
    // Owner changes (capture, mind control), engine image/turret changes and a page variant (a miner's load)
    // rebuild the visual; pending art is retried. Only a voxel unit is painted with a variant: any other visual
    // stays as it is whatever its object carries.
    if (
      existing &&
      existing.type === artType &&
      existing.paletteKey === paletteKey &&
      (existing.mode !== 'voxel' ||
        ((existing.variant ?? '') === variant && (existing.turretIndex ?? 0) === turretIndex))
    ) {
      const source = existing.pending ? this.voxelSource(artType, paletteKey, variant, object.turretIndex) : null;
      if (!source || !this.voxelDrawable(source.model)) {
        this.warmAlternate(existing, paletteKey);
        return existing;
      }
    }
    if (existing) this.removeVisual(existing);
    const visual = this.buildVisual(object, paletteKey, firstFrame);
    if (existing) {
      visual.lastMoveFrame = existing.lastMoveFrame;
      visual.firedFrame = existing.firedFrame;
      visual.deadFrame = existing.deadFrame;
    }
    this.visuals.set(object.uid, visual);
    this.root.add(visual.root);
    return visual;
  }

  /** Resolve only the draw image; older/incomplete libraries retain the rules type's art. */
  private artType(object: LiveObject): string {
    const artType = object.imageType ?? object.type;
    if (artType === object.type) return artType;
    const type = this.library?.type(artType);
    const sprite = !!type?.sprite && (object.kind === 'building' || object.kind === 'infantry' || !!type.shpUnit);
    return type?.voxel ||
      sprite ||
      this.cache.voxels.has(artType) ||
      (object.kind === 'building' && this.cache.manifest.sprites[`${object.kind}:${artType}`]?.frames.length)
      ? artType
      : object.type;
  }

  /**
   * The art drawn this frame. An engine-selected image (a miner's unloading model) replaces the rules type's art only
   * once it can draw its final look: while its voxel model or redraw projection is still loading (the first swap of
   * a match) or has failed, the object keeps the rules type's picture instead of vanishing or changing look twice.
   */
  private drawArt(object: LiveObject, paletteKey: string): string {
    const artType = this.artType(object);
    if (artType === object.type || this.imageReady(object, artType, paletteKey)) return artType;
    return object.type;
  }

  /** Whether image art other than the rules type's can be drawn now; sprite art draws from its own lazy pages. */
  private imageReady(object: LiveObject, artType: string, paletteKey: string): boolean {
    const type = this.library?.type(artType);
    if (type?.sprite && (object.kind === 'building' || object.kind === 'infantry' || type.shpUnit)) return true;
    if (object.kind === 'building' && this.cache.manifest.sprites[`${object.kind}:${artType}`]?.frames.length)
      return true;
    const source = this.voxelSource(artType, paletteKey, artVariant(object), object.turretIndex);
    return !!source && this.voxelUnits.prepare(source.model, source.key, source.cacheKey, source.variant);
  }

  /**
   * A voxel art type's model (map cache first, then the library; null while its file loads), palette row and cache
   * key. The model's mesh may still be being built: see voxelDrawable.
   */
  private voxelSource(
    artType: string,
    paletteKey: string,
    variant = '',
    turretIndex?: number,
  ): { model: VoxelModel; key: string; cacheKey: string; variant: string } | null {
    const libraryType = this.library?.type(artType);
    const fromMap = this.cache.voxels.get(artType);
    const fromLibrary = !fromMap && libraryType?.voxel ? this.library!.voxel(libraryType.voxel) : null;
    const original = fromMap ?? fromLibrary;
    if (!original) return null;
    const model = selectVoxelTurretModel(original, turretIndex);
    const basePalette = fromMap ? model.palette : this.libraryPalette(model.palette);
    const key = paletteFor(this.cache, basePalette, libraryType?.remap ?? true, paletteKey || undefined);
    const selectedTurret = selectedVoxelTurretIndex(model);
    const baseKey = `${artType}@${key}${selectedTurret ? `:turret${selectedTurret}` : ''}`;
    // Turret geometry and redraw pages have independent selections and share the owner's palette row.
    return { model, key, cacheKey: variant ? `${baseKey}#${variant}` : baseKey, variant };
  }

  /**
   * Whether a loaded voxel model is instantiated now. A shown view always does: while the model's smooth mesh is
   * being built (off this thread, 0.02 to 3.3 s of CPU and more on a busy machine) VoxelUnits.build draws its
   * stand-in mesh in the same place, facing and depth, and changes to the smooth mesh in place when it arrives, so a
   * unit the game shows is never missing. Out of sight nobody would see the stand-in: the view waits for the mesh
   * (asking starts the build) and counts as not settled until then.
   */
  private voxelDrawable(model: VoxelModel): boolean {
    return !this.outOfSight || this.voxelUnits.geometryReady(model);
  }

  /**
   * Load the image a type swaps to (library unloadingVoxel) ahead of its first use: the model file, the shared
   * geometry and the redraw projection are then ready when the engine selects it, so the swap takes one frame.
   */
  private warmAlternate(visual: Visual, paletteKey: string): void {
    if (visual.alternateWarm) return;
    const voxel = visual.mode === 'voxel' ? visual.libraryType?.unloadingVoxel : undefined;
    const artType = voxel ? this.library?.voxelType(voxel) : undefined;
    if (!voxel || !artType || this.library!.voxelFailed(voxel)) {
      visual.alternateWarm = true;
      return;
    }
    const source = this.voxelSource(artType, paletteKey);
    if (source && this.voxelUnits.prepare(source.model, source.key, source.cacheKey)) visual.alternateWarm = true;
  }

  private buildVisual(object: LiveObject, paletteKey: string, firstFrame: number): Visual {
    const artType = this.drawArt(object, paletteKey);
    const libraryType = this.library?.type(artType);
    const base = { type: artType, paletteKey, firstFrame, builtAt: this.lastRender };
    // What this object deploys into is prepared like a type in production (see prepare).
    const target = DEPLOY_TARGETS.get(object.type);
    if (target) this.prepare([target]);
    if (libraryType?.sprite && (object.kind === 'building' || object.kind === 'infantry'))
      return { ...base, root: new Group(), mode: 'library-sprite', libraryType };
    // SHP vehicles and aircraft (terror drone, squid, dolphin) have directional sprites, not voxels.
    if (libraryType?.sprite && libraryType.shpUnit && (object.kind === 'vehicle' || object.kind === 'aircraft'))
      return { ...base, root: new Group(), mode: 'library-sprite', libraryType };
    const spriteId = `${object.kind}:${artType}`;
    if (object.kind === 'building' && this.cache.manifest.sprites[spriteId]?.frames.length)
      return { ...base, root: new Group(), mode: 'map-sprite', sprite: spriteId };
    const variant = artVariant(object);
    const source = this.voxelSource(artType, paletteKey, variant, object.turretIndex);
    // Out of sight a kind waits for its mesh, and one not in the scene yet may have to wait a frame (admitNewArt);
    // it is pending like a model still loading. A shown view builds it at once (see voxelDrawable).
    if (
      source &&
      this.voxelDrawable(source.model) &&
      (!this.outOfSight || this.voxelUnits.built(source.cacheKey) || this.admitNewArt())
    ) {
      const { root, turret } = this.voxelUnits.build(source.model, source.key, source.cacheKey, source.variant);
      return {
        ...base,
        root,
        turret,
        mode: 'voxel',
        libraryType,
        variant,
        turretIndex: selectedVoxelTurretIndex(source.model),
      };
    }
    // No art (yet): the object stays tracked but draws nothing (a block in its place would read as a real, oddly
    // coloured unit); library voxels whose file is still loading are retried on later frames.
    const pending = !!source || !!libraryType?.voxel || this.cache.voxels.has(artType);
    if (!pending && !this.warnedTypes.has(object.type)) {
      this.warnedTypes.add(object.type);
      console.warn(`[HD] no art for ${object.kind} ${object.type}: not drawn (see LiveView.diagnostics())`);
    }
    const root = new Group();
    root.name = `live:${object.type}`;
    if (this.options.debugPlaceholders) {
      this.placeholderMaterial ??= new MeshStandardNodeMaterial({
        color: new Color(DEBUG_PLACEHOLDER_COLOUR),
        roughness: 0.8,
        metalness: 0,
      });
      const [w, h, d] = PLACEHOLDER[object.kind].map((v) => v * DEBUG_PLACEHOLDER_SCALE) as [number, number, number];
      const mesh = new Mesh(this.placeholderGeometry, this.placeholderMaterial);
      mesh.scale.set(w, h, d);
      mesh.position.y = h / 2;
      root.add(mesh);
    }
    return { ...base, root, mode: 'placeholder', libraryType, pending };
  }

  /**
   * Art of these rules types will be needed soon: the host calls this when a type's production starts in the sidebar
   * or it waits to be placed, and the view itself for what the map cache lists as placed on the map (in its
   * constructor: behind the loading screen, before the game has created those objects) and for what an object
   * deploys into (buildVisual). Until then a type's pages were asked for in the frame its first object appeared, and
   * the object was drawn as nothing until they had loaded.
   *
   * Their atlas pages are fetched whole (indexed page, HD art, the masks the look wants) and each page's sprite
   * layer, with its shaders, is built before the first sprite is drawn from it (stepAhead); a vehicle's model, mesh
   * and redraw projection are prepared in the local player's colours. All of it is ahead of need: it does not count
   * as art on its way, so a view that is out of sight is not kept from being shown by it. Types the library does not
   * know, and types asked for before, cost nothing. `local` false leaves vehicles out: their colours are not the
   * local player's (the map's own objects).
   */
  prepare(types: Iterable<string>, local = true): void {
    const library = this.library;
    if (!library) return;
    for (const id of types) {
      if (this.preparedTypes.has(id)) continue;
      this.preparedTypes.add(id);
      const type = library.type(id);
      if (type?.sprite) for (const page of library.typePages(type)) this.aheadPages.add(page);
      else if (local && (type?.voxel || this.cache.voxels.has(id))) this.aheadVoxels.add(id);
      // A wall is a building in the sidebar and an overlay on the map.
      for (const page of overlayTypePages(library.library, id)) this.aheadPages.add(page);
    }
  }

  /**
   * One step of what prepare() asked for, once per rendered frame, after the frame's own objects: requests go out at
   * once, and a page whose files are all in gets its layer built, one page per frame (the frame that builds a layer
   * also builds its shaders; out of sight only in what the frame's own art left of newArtPerFrame, and never as art
   * that waits its turn). A page stays listed until its layer exists with everything the look wants.
   */
  private stepAhead(): void {
    const library = this.library;
    if (!library || (!this.aheadPages.size && !this.aheadVoxels.size)) return;
    const windowsWanted = this.hd.windowsWanted();
    const materialsWanted = this.hd.materialsWanted();
    let built = 0;
    for (const page of this.aheadPages) {
      const windows = windowsWanted && library.hasWindowsPage(page);
      const materials = materialsWanted && library.hasMaterialsPage(page);
      if (!library.preloadPage(page, true, windows, materials)) continue;
      if (library.pageFailed(page)) {
        this.aheadPages.delete(page);
        continue;
      }
      const existing = this.pageLayers.get(page);
      if (!existing || (windows && !existing.windows) || (materials && !existing.materials)) {
        if (this.outOfSight ? this.newArt >= this.newArtPerFrame : built > 0) continue;
        built++;
        // Everything is in: this builds the layer (or rebuilds it with a mask that came later).
        if (!this.pageLayer(page)) continue;
      }
      this.aheadPages.delete(page);
    }
    // A model's mesh is built off this thread and counts as art on its way: not before the view is shown.
    if (!this.aheadVoxels.size || this.outOfSight) return;
    const local = this.current?.snapshot.localHouse;
    const colorIndex = local === undefined ? undefined : this.houseColour.get(local);
    const paletteKey = colorIndex === undefined ? undefined : this.housePaletteKeys.get(colorIndex);
    // The mesh and the projection belong to a model in its owner's colours: nothing to prepare before they are known.
    if (paletteKey === undefined) return;
    for (const id of this.aheadVoxels) {
      const voxel = library.type(id)?.voxel;
      const source = this.voxelSource(id, paletteKey);
      if (
        source
          ? this.voxelUnits.prepare(source.model, source.key, source.cacheKey)
          : !voxel || library.voxelFailed(voxel)
      )
        this.aheadVoxels.delete(id);
    }
  }

  private ensureHouse(colorIndex: number): void {
    if (colorIndex < 0 || this.housePalettes.has(colorIndex)) return;
    this.housePalettes.add(colorIndex);
    this.housePaletteKeys.set(colorIndex, `live${colorIndex}`);
    const remap = this.options.houseRemap?.(colorIndex) ?? this.library?.remap(colorIndex) ?? defaultRemap(colorIndex);
    if (!addHousePalettes(this.cache, this.housePaletteKeys.get(colorIndex)!, remap))
      console.warn(`[HD] palette atlas full: house colours ${colorIndex} not added`);
  }

  // ---------------------------------------------------------------- overlays and smudges

  private updateSmudges(snapshot: LiveSnapshot): void {
    if (snapshot.smudges && !this.library?.library.smudges && !this.warnedSmudgeLibrary) {
      this.warnedSmudgeLibrary = true;
      console.warn('[HD] the theater library has no smudges section; using available map-cache smudge art.');
    }
    const wasActive = this.smudgeInstances.active;
    const changed = this.smudgeInstances.update(
      snapshot.smudges ?? null,
      this.library?.library ?? null,
      (palette, fromLibrary) => paletteFor(this.cache, (fromLibrary ? LIBRARY_PALETTE_PREFIX : '') + palette, false),
    );
    if (!changed) return;
    if (wasActive !== this.smudgeInstances.active) this.cellsDirty = true;
    this.smudgePagesDirty = true;
    for (const type of this.smudgeInstances.instances.missingTypes) {
      if (this.warnedSmudgeTypes.has(type)) continue;
      this.warnedSmudgeTypes.add(type);
      console.warn(`[HD] live smudge ${type} has no usable art/footprint; extract the theater's smudge library.`);
    }
  }

  /** Smudges draw before overlay/object cards, sharing terrain light and the renderer's common shroud pass. */
  private flushSmudgePages(): void {
    this.smudgePagesDirty = false;
    const pages = this.smudgeInstances.instances.pages;
    for (const [page, layer] of this.smudgeLayers) {
      if (pages.has(page)) continue;
      if (layer.mesh.instances) layer.setInstances([]);
      this.uploadedSmudges.delete(page);
    }
    for (const [page, instances] of pages) {
      // A layer that draws from the indexed page until the page's HD art is in (see below); art that failed stays out.
      let waitingHd = page !== 'map' && this.indexedSmudgeLayers.has(page);
      if (waitingHd && page !== 'map' && !this.library!.hasHdPage(page)) {
        this.indexedSmudgeLayers.delete(page);
        waitingHd = false;
      }
      const hdArrived = waitingHd && page !== 'map' && !!this.library!.hdPage(page);
      if (waitingHd && !hdArrived) this.smudgePagesDirty = true;
      if (this.uploadedSmudges.get(page) === instances && !hdArrived) continue;
      const atlas =
        page === 'map'
          ? {
              texture: this.cache.spriteAtlas,
              width: this.cache.manifest.spriteAtlas.width,
              height: this.cache.manifest.spriteAtlas.height,
            }
          : this.library?.page(page);
      if (!atlas) {
        if (page !== 'map' && this.library && !this.library.pageFailed(page)) {
          this.smudgePagesDirty = true;
          // Its HD art is asked for beside the indexed page, not after it.
          this.library.hdPage(page);
        } else if (page !== 'map' && !this.warnedSmudgePages.has(page)) {
          this.warnedSmudgePages.add(page);
          console.warn(`[HD] live smudge atlas page ${page} failed to load.`);
        }
        continue;
      }
      const hd = page === 'map' ? this.cache.spriteAtlasHd : this.library!.hdPage(page);
      const hdPending = page !== 'map' && !hd && this.library!.hasHdPage(page);
      let layer = this.smudgeLayers.get(page);
      if (hdPending) {
        this.smudgePagesDirty = true;
        // Out of sight a page's first layer waits for its HD art and is built once. A shown view draws the first
        // crater of a page from the indexed page meanwhile: the mark is on the ground the moment the game puts it
        // there, and gets its HD art in place.
        if (this.outOfSight && !layer) continue;
      }
      if (layer && (layer.capacity < instances.length || hdArrived)) {
        this.disposeOverlayLayer(layer);
        layer = undefined;
      }
      if (!layer) {
        if (!this.admitNewArt()) continue;
        layer = new SpriteLayer(this.cache, [], cellLayerCapacity(instances.length), atlas, hd);
        layer.mesh.name = `live-smudges-${page}`;
        layer.mesh.renderOrder = 3;
        this.shareSpriteUniforms(layer);
        this.root.add(layer.mesh);
        this.smudgeLayers.set(page, layer);
        if (hdPending) this.indexedSmudgeLayers.add(page);
        else this.indexedSmudgeLayers.delete(page);
      }
      layer.setInstances(instances);
      this.uploadedSmudges.set(page, instances);
    }
  }

  private updateOverlays(snapshot: LiveSnapshot): void {
    if (snapshot.overlays && !this.library?.library.overlays && !this.warnedOverlayLibrary) {
      this.warnedOverlayLibrary = true;
      console.warn('[HD] the theater library has no overlays section; using static map overlays until extracted.');
    }
    const color = this.houseColour.get(snapshot.localHouse ?? -1);
    const house = color === undefined ? undefined : `live${color}`;
    const wasActive = this.overlayInstances.active;
    const changed = this.overlayInstances.update(
      snapshot.overlays ?? null,
      this.library?.library ?? null,
      house ?? '',
      (palette, remap) => paletteFor(this.cache, LIBRARY_PALETTE_PREFIX + palette, remap, house),
      this.state.map.atmosphere,
      this.state.map.lighting,
    );
    if (!changed) return;
    if (this.glints) {
      const { grid } = this.cache.manifest;
      const terrain = { width: grid.width, height: grid.height, exists: this.cache.exists };
      this.glintCells =
        this.overlayInstances.active && snapshot.overlays
          ? tiberiumCells(snapshot.overlays, this.library?.library ?? null, terrain)
          : staticTiberiumCells(this.cache.manifest.objects, terrain);
    }
    if (wasActive !== this.overlayInstances.active) this.cellsDirty = true;
    this.overlayPagesDirty = true;
    for (const type of this.overlayInstances.instances.missingTypes) {
      if (this.warnedOverlayTypes.has(type)) continue;
      this.warnedOverlayTypes.add(type);
      console.warn(`[HD] live overlay ${type} has no library frame; extract the theater's overlay library.`);
    }
  }

  /**
   * Overlay pages have their own meshes, so unchanged cells never join the per-frame unit uploads. Pending textures
   * retry only these page lookups; the grid and instances are not rebuilt. The scene's common shroud post pass masks
   * these meshes exactly as it masks the map's terrain and static overlays.
   */
  private flushOverlayPages(): void {
    this.overlayPagesDirty = false;
    const pages = this.overlayInstances.instances.pages;
    for (const [page, { layer }] of this.overlayLayers) {
      if (pages.has(page)) continue;
      if (layer.mesh.instances) layer.setInstances([]);
      this.uploadedOverlays.delete(page);
    }
    for (const [page, instances] of pages) {
      const existing = this.overlayLayers.get(page);
      const wantMaterials = this.hd.materialsWanted() && !!this.library?.hasMaterialsPage(page);
      const materials = wantMaterials || existing?.materials ? this.library!.materialsPage(page) : null;
      if (wantMaterials && !materials) this.overlayPagesDirty = true;
      // A layer that draws from the indexed page until the page's HD art is in (see below); art that failed stays out.
      if (existing?.indexed && !this.library!.hasHdPage(page)) existing.indexed = false;
      const hdArrived = !!existing?.indexed && !!this.library!.hdPage(page);
      if (existing?.indexed && !hdArrived) this.overlayPagesDirty = true;
      const upgrade = (!!materials && !existing?.materials) || hdArrived;
      if (this.uploadedOverlays.get(page) === instances && !upgrade) continue;
      const atlas = this.library?.page(page);
      if (!atlas) {
        if (this.library && !this.library.pageFailed(page)) {
          this.overlayPagesDirty = true;
          // Its HD art is asked for beside the indexed page, not after it.
          this.library.hdPage(page);
        } else if (!this.warnedOverlayPages.has(page)) {
          this.warnedOverlayPages.add(page);
          console.warn(`[HD] live overlay atlas page ${page} failed to load.`);
        }
        continue;
      }
      const hd = this.library!.hdPage(page);
      const hdPending = !hd && this.library!.hasHdPage(page);
      if (hdPending) {
        this.overlayPagesDirty = true;
        // Out of sight a page's first layer waits for its HD art and is built once. A shown view draws the page's
        // first overlays (a wall the player has just placed) from the indexed page meanwhile, and rebuilds the layer
        // with the HD art when it is in.
        if (this.outOfSight && !existing) continue;
      }
      let layer = existing?.layer;
      const capacity = cellLayerCapacity(instances.length, layer?.capacity);
      if ((!layer || layer.capacity < instances.length || upgrade) && !this.admitNewArt()) continue;
      if (layer && (layer.capacity < instances.length || upgrade)) {
        this.disposeOverlayLayer(layer);
        layer = undefined;
      }
      if (!layer) {
        layer = new SpriteLayer(this.cache, [], capacity, atlas, hd, null, materials);
        layer.mesh.name = `live-overlays-${page}`;
        this.registerOverlayOccluder(layer);
        this.shareSpriteUniforms(layer);
        this.root.add(layer.mesh);
        this.overlayLayers.set(page, { layer, materials: !!materials, indexed: hdPending });
      }
      layer.setInstances(instances);
      this.uploadedOverlays.set(page, instances);
    }
  }

  private disposeOverlayLayer(layer: SpriteLayer): void {
    this.hd.terrainDepth.setCaptured(layer.mesh, false);
    this.root.remove(layer.mesh);
    layer.mesh.geometry.dispose();
    (layer.mesh.material as { dispose(): void }).dispose();
    layer.mesh.dispose();
  }

  private cellList(x: number, y: number): MapObject[] {
    const key = y * 4096 + x;
    let list = this.cellObjects.get(key);
    if (!list) this.cellObjects.set(key, (list = []));
    return list;
  }

  /**
   * Legacy tuple bridge: replaces map cells using only art already in the map cache. The page uses independent
   * overlays/smudges grids above, which resolve additional types through the theater library instead.
   */
  private applyCells(cells: LiveCells): void {
    if (cells.full) this.cellObjects.clear();
    const { manifest } = this.cache;
    for (const [x, y, overlay, overlayFrame, smudge, smudgeFrame] of cells.cells) {
      const key = y * 4096 + x;
      const list: MapObject[] = [];
      const z = this.cache.height[y * manifest.grid.width + x] ?? 0;
      const overlayType = overlay !== 0xff ? cells.overlayTypes?.[overlay] : undefined;
      const smudgeType = smudge >= 0 ? cells.smudgeTypes?.[smudge] : undefined;
      if (smudgeType && manifest.sprites[`smudge:${smudgeType}`])
        list.push({
          kind: 'smudge',
          type: smudgeType,
          x,
          y,
          z,
          sprite: `smudge:${smudgeType}`,
          frame: smudgeFrame,
          flat: true,
          drawOffset: [0, 0],
          lighting: 'full',
        });
      if (overlayType) {
        const known = manifest.objects.find((o) => o.kind === 'overlay' && o.type === overlayType);
        if (known && manifest.sprites[known.sprite ?? '']) list.push({ ...known, x, y, z, frame: overlayFrame });
      }
      this.cellObjects.set(key, list);
    }
    this.cellsDirty = true;
  }

  private flushCells(): void {
    this.painterDirty = true;
    this.cellsDirty = false;
    const { manifest } = this.cache;
    const instances = this.cellInstances;
    instances.length = 0;
    this.cellPool.begin();
    for (const list of this.cellObjects.values())
      for (const object of list) {
        if (object.kind === 'overlay' && this.overlayInstances.active) continue;
        if (object.kind === 'smudge' && this.smudgeInstances.active) continue;
        const entry = object.sprite ? manifest.sprites[object.sprite] : undefined;
        if (!entry?.frames.length) continue;
        const index = Math.min(object.frame ?? 0, entry.frames.length - 1);
        const frame = entry.frames[index]!;
        const anchor = objectAnchor(object, this.cellPool.anchor());
        // Overlays are drawn by the native cell pass, not inserted into the object layer vectors.
        this.cellPool.painter = undefined;
        this.cellPool.deckHeight = isHighBridge(object.type) ? HIGH_BRIDGE_HEIGHT : undefined;
        const palette = paletteFor(this.cache, entry.palette, entry.remap, object.owner);
        // The map object's lighting class (smudges take the full terrain light, ore none), as the static world
        // passes it (ra2/world.ts): absent means 'full'.
        const lighting = object.lighting ?? 'full';
        const shadow = entry.shadows?.[index];
        if (shadow) instances.push(this.cellPool.take(anchor, shadow, palette, 0, true, true, undefined, lighting));
        const body = this.cellPool.take(
          anchor,
          frame,
          palette,
          object.flat ? 0 : cardPush(frame),
          false,
          !!object.flat,
          undefined,
          lighting,
        );
        body.glint = object.kind === 'overlay' && object.flat && lighting === 'none' ? 1 : undefined;
        body.unlit = isUnlitMapOverlay(object);
        instances.push(body);
      }
    this.cellLayer.setInstances(instances);
  }
}

/**
 * Building anims (bridge flag buildingAnim) by the cell they stand on (y * 4096 + x) and by the uid of the object they
 * are attached to, with their index in the list; null when there are none. The reader leaves a building anim's
 * attachment empty, so it is matched by position (the building whose foundation holds it).
 */
export function indexBuildingAnims(
  anims: readonly LiveAnim[] | undefined,
): { cells: Map<number, [number, LiveAnim][]>; attached: Map<number, [number, LiveAnim][]> } | null {
  if (!anims?.some((a) => a.buildingAnim)) return null;
  const cells = new Map<number, [number, LiveAnim][]>();
  const attached = new Map<number, [number, LiveAnim][]>();
  anims.forEach((anim, i) => {
    if (!anim.buildingAnim) return;
    const key = anim.attachedTo ? anim.attachedTo.uid : Math.floor(anim.y / 256) * 4096 + Math.floor(anim.x / 256);
    const map = anim.attachedTo ? attached : cells;
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push([i, anim]);
  });
  return { cells, attached };
}

const ANIM_IDS = new Map<string, string>();
/** Anim type id of a library layer sprite ("anim:NAREFNL1" -> "NAREFNL1"), memoised (read every frame). */
function animId(sprite: string): string {
  let id = ANIM_IDS.get(sprite);
  if (id === undefined) ANIM_IDS.set(sprite, (id = sprite.replace(/^anim:/, '')));
  return id;
}

/**
 * The frame an SHP's whole canvas would be (the canvas centre is the draw origin): what stands in for a body frame
 * without pixels when its layers need a push and a depth profile. Undefined without a canvas size.
 */
export function canvasFrame(art: { canvas?: readonly [number, number] }): SpriteFrame | undefined {
  const canvas = art.canvas;
  if (!canvas || !(canvas[0] > 0) || !(canvas[1] > 0)) return undefined;
  return { rect: [0, 0, canvas[0], canvas[1]], offset: [-Math.floor(canvas[0] / 2), -Math.floor(canvas[1] / 2)] };
}

/** Bright-to-dark ramp of a house colour, shaped like the engine's 16-entry remap range. */
function defaultRemap(colorIndex: number): [number, number, number][] {
  const base = new Color(HOUSE_COLORS[colorIndex % HOUSE_COLORS.length]!);
  return Array.from({ length: 16 }, (_, i) => {
    const k = 1.15 - (i / 15) * 0.85;
    return [
      Math.min(255, Math.round(base.r * 255 * k)),
      Math.min(255, Math.round(base.g * 255 * k)),
      Math.min(255, Math.round(base.b * 255 * k)),
    ];
  });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const wrap16 = (value: number): number => ((value % 65536) + 65536) % 65536;

/** Interpolate 16-bit engine facings along the short arc; returns the facing in the same units, not wrapped. */
function lerpRaw16(a: number, b: number, t: number): number {
  let delta = (((b - a) % 65536) + 65536) % 65536;
  if (delta > 32768) delta -= 65536;
  return a + delta * t;
}

/** World position of an engine lepton coordinate, for hosts that place their own overlays. */
export function leptonToWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x / LEPTONS_PER_CELL, (z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT, y / LEPTONS_PER_CELL);
}

/**
 * Physical turret origin on the drawn origin's view ray: minimise ground-plane distance to the foundation centre,
 * clamping height to the building's ground level through three levels above it. Moving along this ray preserves the
 * turret's screen position; the facade pull is only a rendering offset, not a flight altitude.
 */
export function buildingTurretShadowOrigin(
  drawnOrigin: Vector3,
  toCamera: Vector3,
  foundationCentre: Vector3,
  out = new Vector3(),
): Vector3 {
  const lengthSq = toCamera.x * toCamera.x + toCamera.z * toCamera.z;
  let t =
    lengthSq > 0
      ? ((foundationCentre.x - drawnOrigin.x) * toCamera.x + (foundationCentre.z - drawnOrigin.z) * toCamera.z) /
        lengthSq
      : 0;
  if (toCamera.y !== 0) {
    const low = (foundationCentre.y - drawnOrigin.y) / toCamera.y;
    const high = (foundationCentre.y + 3 * LEVEL_HEIGHT - drawnOrigin.y) / toCamera.y;
    t = Math.max(Math.min(low, high), Math.min(Math.max(low, high), t));
  }
  return out.copy(drawnOrigin).addScaledVector(toCamera, t);
}

/**
 * The redraw page variant an object's state selects: a vehicle that reports a load (a harvester) is painted with the
 * bin of that load. '' for everything else: the pages as drawn.
 */
export function artVariant(object: Pick<LiveObject, 'kind' | 'cargo'>): string {
  return object.kind === 'vehicle' ? cargoLook(object.cargo) : '';
}

/**
 * How far (world units along the view) an object's underlay sits in front of the ground under each of its pixels. The
 * engine draws such art flat, a little in front of the ground layer and before the owner's body, so ground, overlays
 * and shadows are under it and upright things cover it. Here the unit shadows are depth-writing planes above the
 * ground (voxelShadow.ts: SHADOW_LIFT plus the penumbra copies, written at the nearest depth inside each pixel), so the
 * underlay has to clear the highest of them by a screen pixel of ground slope; an ordinary effect decal
 * (EFFECT_DECAL_LIFT) lies under those planes and the owner's own shadow cut the sparks away beside its hull. It
 * stays under an upright body except within about two original pixel rows of the body's lowest row, where a card's
 * depth meets the ground.
 */
export const UNDERLAY_DEPTH_PULL = 0.1;

/**
 * The effect card of an object's underlay, or null when there is nothing to draw (no underlay, a hidden object or
 * point, art or frame not available yet). The engine blits such art flat (ground Z gradient, no Z write) immediately
 * before the owner's body, so it is a ground decal here, pulled UNDERLAY_DEPTH_PULL towards the camera: the body,
 * standing above the ground, covers it wherever the two overlap on screen, and ground, overlays and shadows stay under
 * it. The pull is along the view (`toCamera`, the unit vector from the scene to the camera) and the decal's own lift is
 * taken back out of the anchor, so the canvas centre stays exactly on the engine's pixel. The frame is the engine's on
 * every logic frame; redrawn art (enhanced effects) replaces the pixels only and is held for the whole stage, never
 * blended ahead.
 */
export function objectUnderlayCard(
  object: Pick<LiveObject, 'underlay' | 'nativeHidden'>,
  art: Pick<EffectArt, 'anim' | 'hdAnim' | 'hdPageState'>,
  hd: boolean,
  hidden: (x: number, y: number, z: number) => boolean,
  toCamera: Vector3,
  anchor = new Vector3(),
): EffectInstance | null {
  const under = object.underlay;
  if (!under || object.nativeHidden || hidden(under.x, under.y, under.z)) return null;
  const resolved = art.anim(under.art);
  const frame = resolved?.sprite.frames[under.frame];
  if (!resolved || !frame || frame.rect[2] <= 0) return null;
  leptonAnchor(under.x, under.y, under.z, 0, 0, anchor);
  anchor.y -= EFFECT_DECAL_LIFT;
  anchor.addScaledVector(toCamera, UNDERLAY_DEPTH_PULL);
  const card: EffectInstance = {
    anchor,
    frame,
    palette: resolved.palette,
    alpha: 1,
    push: 0,
    draw: 'flat',
    pass: 'ground',
    depth: ((under.x + under.y) * 15) / LEPTONS_PER_CELL - (under.z / LEPTONS_PER_LEVEL) * 15,
    // Scene-lit like other original art. The engine blits it about 1.1x brighter (the owner's cell light plus the
    // extra unit light), but the layer's glow lift turned the pale grains white in frozen pairs; the orange stays.
    glow: false,
  };
  const redrawn = hd ? art.hdAnim(under.art) : null;
  const hdFrame = redrawn?.frames[under.frame];
  // A redrawn page that is still loading (asking starts the load) leaves the engine's own art on screen meanwhile.
  if (redrawn && hdFrame && effectPageLoaded(art.hdPageState(hdFrame.page)))
    card.hd = { frame: hdFrame, next: null, scale: redrawn.scale, blend0: 0, t0: 0, stageSeconds: 1 };
  return card;
}

/**
 * World anchor of an engine draw point: the object's lepton coordinate projected like the engine, shifted by a screen
 * offset in pixels, and lifted back onto the ground at the object's height (how the type library defines drawOffset).
 */
function leptonAnchor(x: number, y: number, z: number, dx: number, dy: number, out: Vector3): Vector3 {
  const level = z / LEPTONS_PER_LEVEL;
  const cx = x / LEPTONS_PER_CELL;
  const cy = y / LEPTONS_PER_CELL;
  const sx = (cx - cy) * 30;
  const sy = (cx + cy) * 15 - level * 15;
  const diff = (sx + dx) / 30;
  const sum = (sy + dy + level * 15) / 15;
  return out.set((sum + diff) / 2, level * LEVEL_HEIGHT, (sum - diff) / 2);
}
