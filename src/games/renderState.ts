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
  /** The local player's per-cell shroud (and fog), null while it cannot be read. */
  shroud: GameRenderShroud | null;
  /** Live effects the engine is playing, null while they cannot be read. */
  effects: GameRenderEffects | null;
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
  /** GameRenderHouse.index of the owner, or -1 when unknown. */
  owner: number;
  facingRaw: number;
  /** Only for types with a turret. */
  turretFacingRaw?: number;
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
}

export interface GameRenderBullet extends GameRenderPoint {
  id: number;
  uid: number;
  /** Never drawn by the original game (instant-hit weapons). */
  inviso: boolean;
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

export interface GameRenderEffects {
  anims: GameRenderAnim[];
  bullets: GameRenderBullet[];
  lasers: GameRenderLaser[];
  electricBolts: GameRenderElectricBolt[];
  particleSystems: GameRenderParticleSystem[];
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
