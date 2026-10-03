import type { GuestMemory } from '../vm86/win32';

/**
 * Live battlefield snapshot for an external renderer (the HD remaster bridge): only what that renderer consumes, in
 * engine units, as plain data that is safe to post between threads. Game modules map their own readers into this
 * shape (YR 1.001: src/games/yr/renderState.ts), so this contract imports nothing game-specific.
 *
 * Units: world positions are leptons (256 per cell on X/Y, 104 per height level on Z); facings are the engine's 16-bit
 * directions (0 = north, increasing clockwise as seen on screen).
 */
export interface GameRenderState {
  /** Logic frame counter; unchanged while the game logic has not advanced. */
  frame: number;
  /** Screen pixel of the tactical view's top-left corner, or null when it cannot be read. */
  view: { x: number; y: number } | null;
  /** The loaded scenario, or null outside a battle. */
  map: GameRenderMap | null;
  houses: GameRenderHouse[];
  /** `index` of the local player's house, or -1. */
  localHouse: number;
  objects: GameRenderObject[];
  /** Native renderer detail diagnostics; absent when unavailable or unsupported by the game. */
  nativeDetail?: { fps: number; lowFrameRate: boolean; level: number };
  /** The local player's per-cell shroud (and fog), null while it cannot be read. */
  shroud: GameRenderShroud | null;
  /** Live cell decorations, null while unavailable (the renderer may use its static map cache). */
  overlays: GameRenderOverlays | null;
  /** Engine-owned ground marks; null enables the renderer's map-cache fallback. */
  smudges: GameRenderSmudges | null;
  /** Live effects the engine is playing, null while they cannot be read. */
  effects: GameRenderEffects | null;
  /** Live scene lighting; absent for unsupported games, null while the read is unavailable. */
  lighting?: GameRenderLighting | null;
  /**
   * The native build sidebar and command bar as the game currently draws them, for an HD interface layer that covers
   * them while every input still goes to the game. Absent when the game has no sidebar reader; null outside a battle or
   * while it cannot be read.
   */
  sidebar?: GameRenderSidebar | null;
}

/** Scene-wide engine lighting, in fractional [Lighting] units rather than integer percentages/per-mille. */
export interface GameRenderLighting {
  /** Current ambient, including the engine's event transition, never the event's target ambient. */
  ambient: number;
  /** Current cell-lighting coefficients selected independently of the palette override. */
  ground: number;
  level: number;
  /** Normal authored scene RGB, before normalization. */
  tint: [number, number, number];
  /** Raw event palette RGB; null restores the normal palette, without replacing the normal cell-light tint. */
  override: [number, number, number] | null;
  /** Event currently selecting the palette; recovery can retain changed ambient with no palette event. */
  event: 'storm' | 'nuke' | 'dominator' | 'timewarp' | null;
  storm?: {
    active: boolean;
    /** A positive countdown is pending, without implying active storm lighting. */
    pending: boolean;
    ending: boolean;
    cell: { x: number; y: number };
  };
}

export interface GameRenderMap {
  /** Scenario file name as the game stores it (for example "RIVERRAM.YRO"); null when it is not a plausible name. */
  fileName: string | null;
}

export interface GameRenderHouse {
  /** What GameRenderObject.owner refers to. */
  index: number;
  /** The game's colour scheme index for this house. */
  colorIndex: number;
}

export type GameRenderObjectKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';

export interface GameRenderPoint {
  x: number;
  y: number;
  z: number;
}

export interface GameRenderObject extends GameRenderPoint {
  /** Stable while the object lives, but may be reused after deletion; see `uid`. */
  id: number;
  /** Unique for the whole game. */
  uid: number;
  kind: GameRenderObjectKind;
  /** Rules type id, for example "MTNK". */
  type: string;
  /** Engine-selected draw image when it differs from the rules type. */
  imageType?: string;
  /** Native whole-object draw gate, including shadows and attached presentation. */
  nativeHidden?: boolean;
  /** Body opacity in 0..1; omitted for ordinary opaque drawing. Does not affect shadows. */
  translucent?: number;
  /** GameRenderHouse.index of the owner, or -1 when unknown. */
  owner: number;
  facingRaw: number;
  /** Only for types with a turret. */
  turretFacingRaw?: number;
  /** Engine construction/sale state; absent when the game cannot report it. */
  buildState?: 'building' | 'selling' | 'done';
  /** Actual make-art frame, with the engine's sale/gate reversal already applied. */
  buildupFrame?: number;
  /** Engine-selected completed-building body frame, including occupancy and damage variants. */
  buildingFrame?: number;
  /** Engine damage condition for bibs and animation layers; independent of the body-frame policy. */
  buildingDamaged?: boolean;
  /** Validated radio contact's stable ID in this snapshot. */
  contactUid?: number;
  /** Host can dock/service units; supplied by the game policy. */
  dock?: boolean;
  /** Engine-selected delivery image, independent of available art. */
  unloading?: 'door' | 'roof';
  /** Completed-building ActiveAnim: missing, drawn, or skipped by the native renderer's detail gate. */
  activeAnim?: 'none' | 'shown' | 'detail';
  /** Current infantry art sequence key, when the game can report it. */
  infantrySequence?: string;
  /** Animation step within infantrySequence, before its start/facing offsets. */
  sequenceFrame?: number;
  /** Optional engine-selected 16-bit infantry art direction; leaves body/travel facing unchanged. */
  infantryDrawFacingRaw?: number;
  /** Native painter layer, position within that layer and game-defined sort key, when available. */
  renderOrder?: { layer: number; index: number; ySort: number };
  /** Current strength 0..1. */
  health: number;
  /** Selected by the local player. */
  isSelected: boolean;
}

/** Values of GameRenderShroud.cells. */
export const GAME_RENDER_SHROUD = Object.freeze({
  /** Not revealed to the local player. */
  shrouded: 0,
  /** Revealed but fogged. */
  fogged: 1,
  visible: 2,
  /** No cell here (outside the map). */
  none: 0xff,
});

export interface GameRenderShroud {
  /** Cell coordinates of cells[0] (cell = floor(lepton / 256)). */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** GAME_RENDER_SHROUD value per cell, row-major: cells[(y - originY) * width + (x - originX)]. */
  cells: Uint8Array;
}

/** Shared publication format for independent layers of cell decorations. */
export interface GameRenderCellSprites {
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Row-major type indices into `types`; -1 means no decoration. */
  index: Int16Array;
  /** Native cell data: overlay frame or smudge footprint offset, in the same cell order. */
  data: Uint8Array;
  types: string[];
  /** Source building type of an IsRubble overlay cell; only the engine's single carrier cell is listed. */
  rubble?: { slot: number; type: string }[];
  /** Increases when published content changes, including a new battle, for this reader's lifetime. */
  revision: number;
}

export type GameRenderOverlays = GameRenderCellSprites;
export type GameRenderSmudges = GameRenderCellSprites;

export interface GameRenderAnim extends GameRenderPoint {
  id: number;
  uid: number;
  /** Anim type id, for example "TWLT070". */
  type: string;
  /** Frames in one iteration; 0 while the engine has not resolved the art. */
  frameCount: number;
  /** Part of a building's own animation rather than a free-standing effect. */
  buildingAnim: boolean;
  /** Updated by the engine but not drawn. */
  invisible: boolean;
  frame?: number;
  stage?: number;
  translucent?: boolean;
  translucency?: number;
  flat?: boolean;
  layer?: 'underground' | 'surface' | 'ground' | 'air' | 'top' | null;
  owner?: number;
  attachedTo?: { id: number; uid: number; kind: string } | null;
}

export interface GameRenderBullet extends GameRenderPoint {
  id: number;
  uid: number;
  /** Never drawn by the original game (instant-hit weapons). */
  inviso: boolean;
  type?: string;
  frame?: number;
  velocity?: GameRenderPoint;
}

export interface GameRenderLaser {
  source: GameRenderPoint;
  target: GameRenderPoint;
  /** sRGB 0..255. */
  innerColor: [number, number, number];
}

export interface GameRenderElectricBolt {
  source: GameRenderPoint;
  target: GameRenderPoint;
  /** Drawn in the game's alternate bolt colours. */
  alternateColor: boolean;
}

export type GameRenderParticleBehaviour = 'smoke' | 'gas' | 'fire' | 'spark' | 'railgun';

export interface GameRenderParticleSystem extends GameRenderPoint {
  id: number;
  uid: number;
  behavesLike: GameRenderParticleBehaviour | null;
}

/** A sinusoidal energy ribbon; progress is the engine's current draw cycle, 0..1. */
export interface GameRenderRadBeam {
  id: number;
  type: 'rad' | 'temporal' | 'eruption';
  source: GameRenderPoint;
  target: GameRenderPoint;
  color: [number, number, number];
  period: number;
  amplitude: number;
  age: number;
  sustained: boolean;
  progress: number;
}

export interface GameRenderWave {
  id: number;
  uid: number;
  type: 'sonic' | 'laser' | 'biglaser' | 'magnetron';
  source: GameRenderPoint;
  target: GameRenderPoint;
  intensity: number;
  progress: number;
}

/** A native-selected/timed control link. Coordinates and arc height are in engine world units. */
export interface GameRenderMindControlLink {
  id: number;
  controller: number;
  targetId: number;
  source: GameRenderPoint;
  target: GameRenderPoint;
  /** The controller house's RGB, in sRGB 0..255. */
  color: [number, number, number];
  arcHeight: number;
  remainingFrames: number;
  selected: boolean;
}

export interface GameRenderEffects {
  anims: GameRenderAnim[];
  bullets: GameRenderBullet[];
  lasers: GameRenderLaser[];
  electricBolts: GameRenderElectricBolt[];
  particleSystems: GameRenderParticleSystem[];
  radBeams?: GameRenderRadBeam[];
  waves?: GameRenderWave[];
  mindControlLinks?: GameRenderMindControlLink[];
}

/**
 * Reads one snapshot; null while the game is not in a state the reader can interpret. While nothing the snapshot
 * depends on has changed it returns the identical object again, so callers can skip work (and cross-thread copies)
 * by comparing references. Returned objects are never mutated afterwards.
 */
export type GameRenderStateReader = () => GameRenderState | null;

/**
 * Hook signature: `size` is the guest memory size in bytes. Resolves to null when the executable or its loaded image
 * is not the supported build, or when the build leaves the renderer bridge out. Asynchronous so that a game can load
 * its readers on demand.
 */
export type CreateGameRenderStateReader = (
  memory: GuestMemory,
  size: number,
  hash: string,
) => Promise<GameRenderStateReader | null>;

/** Half-open rectangle in guest frame (engine) pixels. */
export interface GameRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Native in-game interface (sidebar, command bar) state. All positions are guest frame pixels taken from the game's own
 * layout fields, so an HD layer can be placed exactly over the native pixels at any guest resolution. Values describe
 * what the native interface shows (animated credits, clock frame, flashing), not the underlying economy.
 */
export interface GameRenderSidebar {
  /** Guest frame size the layout refers to. */
  frame: { width: number; height: number };
  /** Faction art family of the interface: 0 Allied, 1 Soviet, 2 the third side (YR: Yuri), -1 unknown. */
  side: number;
  layout: GameRenderSidebarLayout;
  /** Index into `tabs` of the tab whose cameos are shown. */
  activeTab: number;
  tabs: GameRenderSidebarTab[];
  /** Cameos of the active tab that are at least partly inside `layout.strip`, in native draw order. */
  cameos: GameRenderCameo[];
  /** The number the native credits counter currently shows (it animates towards the balance). */
  credits: number;
  power: GameRenderPower;
  /** True while the radar shows the minimap or its open/close animation; false while it shows the faction emblem. */
  radarActive: boolean;
  /** Repair / sell cursor modes armed from the sidebar buttons. */
  modes: { repair: boolean; sell: boolean };
  /** Cameo captions in the game's language (e.g. "Ready", "On Hold"), null when they could not be read. */
  labels: { ready: string | null; hold: string | null };
  /** Software cursor: frame-pixel hotspot position, sheet frame and offset inside that frame. Null when unknown/hidden. */
  pointer?: { x: number; y: number; frame: number; hotspot: { x: number; y: number } } | null;
  /** Shown native tooltip, including its exact frame-pixel bounds and original wide-string line breaks. */
  tooltip?: { rect: GameRenderRect; text: string } | null;
}

export interface GameRenderSidebarLayout {
  /** The whole sidebar column. */
  sidebar: GameRenderRect;
  /** The bottom command bar, null when the game shows none. */
  commandBar: GameRenderRect | null;
  /** Radar aperture (the largest minimap area inside the radar frame). */
  radar: GameRenderRect;
  /** Band holding the credits counter; `creditsAnchor` is the native text anchor (centre x, top y). */
  credits: GameRenderRect;
  creditsAnchor: { x: number; y: number };
  /** Visible cameo area; cameos are clipped to it while the strip scrolls. */
  strip: GameRenderRect;
  /** Size of one cameo picture and the column / row pitch of the cameo grid (first column at `strip.x`). */
  cameo: { width: number; height: number };
  cameoPitch: { x: number; y: number };
  /** Top-left of the first visible cameo row when the strip is not scrolling (the native draw adds 1 px to Location.y). */
  cameoOrigin: { x: number; y: number };
  /** Tab buttons, same order as `GameRenderSidebar.tabs`. */
  tabs: GameRenderRect[];
  /** Sidebar buttons; null when the game has no such button or its rectangle could not be read. */
  buttons: {
    repair: GameRenderRect | null;
    sell: GameRenderRect | null;
    options: GameRenderRect | null;
    diplomacy: GameRenderRect | null;
    scrollUp: GameRenderRect | null;
    scrollDown: GameRenderRect | null;
  };
  /** Power bar: left x, first slot top y, slot pitch in pixels and number of slots (top to bottom). */
  power: { x: number; y: number; width: number; slotHeight: number; slots: number };
}

export interface GameRenderSidebarTab {
  /** Number of cameos the tab holds (0: the native tab is disabled). */
  count: number;
  /** The native tab button is flashing (new cameos appeared while another tab was shown). */
  flashing: boolean;
}

export type GameRenderCameoKind = 'building' | 'defense' | 'infantry' | 'vehicle' | 'naval' | 'aircraft' | 'super';

export interface GameRenderCameo {
  /** Position in the tab's cameo list. */
  index: number;
  /** Top-left of the cameo picture in frame pixels (may lie partly outside `layout.strip` while scrolling). */
  x: number;
  y: number;
  /** Type identifier (YR: the rules section name, e.g. E1, GAPOWR; superweapons: their type name). */
  id: string;
  /** Cameo picture name in lower case without extension (YR: e.g. giicon), null when it could not be read. */
  image: string | null;
  kind: GameRenderCameoKind;
  /** Display name in the game's language. */
  name: string;
  /** Build cost in credits, null when not applicable or unknown. */
  cost: number | null;
  /** Native clock progress 0..1 while the clock shows, null when no clock is drawn. */
  progress: number | null;
  /** The native caption shown on the cameo. */
  ready: boolean;
  hold: boolean;
  /** The native darkening overlay is drawn (not buildable now). */
  darkened: boolean;
  /** Queue number the native cameo shows (0: none). */
  queued: number;
  /** The native flash is active (it blinks while true). */
  flashing: boolean;
  /** The pointer is over this cameo (native hover outline). */
  hovered: boolean;
}

/**
 * Native power bar. The bar is drawn from the top: `slots - (surplus + reserve + used)` empty slots, then the three
 * coloured bands in this order down to the bottom slot. Counts are the native animated values.
 */
export interface GameRenderPower {
  output: number;
  drain: number;
  surplus: number;
  reserve: number;
  used: number;
  /** Low power: output below a non-zero drain. */
  low: boolean;
}
