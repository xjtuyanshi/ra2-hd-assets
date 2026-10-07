import type { GuestMemory } from '../vm86/win32';
import type { GameRenderObjectKind, GameRenderSidebar } from './renderState';

/**
 * What the player at this computer has told the game to do, as plain data that is safe to post between threads: the
 * selection, control groups, every object's current order with what it points at, and the native sidebar. It exists
 * for practice sessions that check whether an operation was carried out; nothing here is written back to the game.
 * Game modules map their own readers into this shape (YR 1.001: src/games/yr/commandState.ts), so this contract
 * imports nothing game-specific.
 *
 * Units: world positions are the game's fine units (256 per cell on X/Y); cells are whole cell coordinates.
 */
export interface GameCommandState {
  /** Logic frame counter; unchanged while the game logic is paused. */
  frame: number;
  /** `owner` value of the local player's objects, or -1. */
  localHouse: number;
  /** World pixel of the tactical view's top-left corner, or null when it cannot be read. */
  view: { x: number; y: number } | null;
  objects: GameCommandObject[];
  /** Map cell of the newest alert the game's "jump to the last event" command would centre on; null without one. */
  lastEvent: { x: number; y: number } | null;
  /** The native build sidebar (credits, active tab, production, repair / sell modes); null when it cannot be read. */
  sidebar: GameRenderSidebar | null;
}

/** What an order points at: another object, or a map cell. */
export type GameCommandRef = { kind: 'object'; uid: number } | { kind: 'cell'; x: number; y: number };

export interface GameCommandObject {
  /** Unique for the whole game (the same value as GameRenderObject.uid). */
  uid: number;
  kind: GameRenderObjectKind;
  /** Rules type id, for example "HTNK". */
  type: string;
  /** House index; compare with GameCommandState.localHouse. */
  owner: number;
  x: number;
  y: number;
  z: number;
  /** Remaining strength, 0..1. */
  health: number;
  selected: boolean;
  /** Control group, 0-based (the group made with the "1" key is 0), or -1. */
  group: number;
  /** The engine's name of the order being carried out, for example "Guard", "Move", "Attack", "Area_Guard". */
  mission: string;
  /** An order waiting to replace `mission`, or null. */
  queuedMission: string | null;
  /** What the object is attacking. */
  target: GameCommandRef | null;
  /** Where the object is going (mobile objects only). */
  destination: GameCommandRef | null;
  /** The object or cell an order is about: the escorted or guarded thing; for a factory, its rally point. */
  focus: GameCommandRef | null;
}

/** Reads one snapshot; null while the game is not in a battle the reader can interpret. */
export type GameCommandStateReader = () => GameCommandState | null;

/**
 * Hook signature (see GameRuntimeHooks.createCommandStateReader): `size` is the guest memory size in bytes. Resolves
 * to null when the executable or its loaded image is not the supported build, or when the build leaves practice
 * sessions out.
 */
export type CreateGameCommandStateReader = (
  memory: GuestMemory,
  size: number,
  hash: string,
) => Promise<GameCommandStateReader | null>;
