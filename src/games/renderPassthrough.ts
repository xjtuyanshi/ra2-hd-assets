import type { GuestMemory } from '../vm86/win32';

/**
 * Native overlay passthrough for an external battlefield renderer (the HD remaster bridge). While a category is on,
 * the original game writes no pixels for that part of the world. Only the terrain category replaces pixels with the key
 * colour: with it on, the tactical surface starts every frame filled with the key colour instead of terrain, and
 * objects and effects left off are drawn onto that fill as usual. Without terrain, the native terrain stays and nothing
 * is key-coloured, so the page cannot key the frame and makes the whole tactical rectangle transparent instead, native
 * overlays included (docs/remaster/HD_BRIDGE.md). Drawing code that also maintains game state (selection
 * registration, visibility flags, effect lifetimes and list removal) keeps running with only its pixel output removed;
 * only code that keeps no simulation state is skipped. Skipped code can still touch draw caches, heap objects, timer
 * stamps or non-critical random streams, so the process is not byte-identical to a native run; each game's
 * implementation documents what its skipped code touches (YR: docs/remaster/research/tactical-passthrough.md). With
 * terrain on, the page makes exactly the key-coloured pixels transparent, so the external world shows through while
 * every native overlay the game draws on top (selection brackets, health bars, pips, band box, placement grid, target
 * lines, text, timers, ...) stays pixel-identical.
 * Categories are independent and switch while the game runs, taking effect at the game's next frame boundary; with all
 * off the patched code runs the original instructions.
 */
export const RENDER_PASSTHROUGH = {
  /** Terrain tiles, cliffs, ore/gems, walls, bridges and smudges (the cached terrain surface), key colour fill. */
  terrain: 1,
  /** Buildings (with their own animations), vehicles, infantry, aircraft, trees and their shadows. */
  objects: 2,
  /** Free-standing animations, particles, projectiles, lasers, electric bolts, waves and other effects. */
  effects: 4,
} as const;

export const RENDER_PASSTHROUGH_ALL =
  RENDER_PASSTHROUGH.terrain | RENDER_PASSTHROUGH.objects | RENDER_PASSTHROUGH.effects;

/**
 * Key colour as the RGB565 value written into the 16-bit tactical surface: pure magenta (248, 0, 248 before bit
 * replication, i.e. 255, 0, 255 once expanded), a value no palette or overlay of the supported games produces in
 * practice. The page compares packed values exactly, so no other colour can match.
 */
export const RENDER_PASSTHROUGH_KEY_RGB565 = 0xf81f;

/** Diagnostic counters kept by the guest stubs; names are the game module's gate names. */
export interface RenderPassthroughStats {
  /** Categories last requested through `set`. */
  readonly flags: number;
  /** Categories in effect: those the guest latched at its last frame boundary (equal to `flags` once it rendered). */
  readonly applied: number;
  readonly counters: Readonly<Record<string, number>>;
}

export interface RenderPassthroughControl {
  /** Categories this executable supports (subset of RENDER_PASSTHROUGH_ALL). */
  readonly supported: number;
  readonly keyRgb565: number;
  /** Guest address of the configuration/data page (diagnostics; layout in src/games/shared/guestGates.ts). */
  readonly configAddress: number;
  /**
   * Request category flags; the guest applies them at its next frame boundary (with a full repaint of the tactical
   * view). False when the flags cannot be applied.
   */
  set(memory: GuestMemory, flags: number): boolean;
  read(memory: GuestMemory): RenderPassthroughStats;
}

/**
 * Game-side installer signature, implemented by a game module (GameRuntimeHooks.prepareRenderPassthrough loads it on
 * demand in development builds and calls it): install the (inert) patches before the entry point runs. `reserve` hands
 * out zero-filled guest RAM that nothing else uses (the host takes it from the top of guest memory), aligned as
 * requested. Returns null, leaving the image untouched, when it does not match every documented original byte.
 */
export type PrepareRenderPassthrough = (
  memory: GuestMemory,
  reserve: (size: number, alignment?: number) => number,
) => RenderPassthroughControl | null;
