import type { GameFrameReader } from './performance';
import type { RenderPassthroughControl } from './renderPassthrough';
import type { CreateGameCommandStateReader } from './commandState';
import type { CreateGameRenderStateReader, GameRenderPreparation } from './renderState';
import type { GuestMemory, VmFrame } from '../vm86/win32';

export interface GamePagePointer {
  read(width: number, height: number): VmFrame['pointer'];
  setDrawing(enabled: boolean): boolean;
}

/**
 * Game runtime extensions callable by the VM core.
 * Keep fixed addresses and game semantics in each game's directory; the adapter sees only these optional capabilities.
 */
export interface GameRuntimeHooks {
  /** Loading metadata for speculative asset preparation; never a visible battle snapshot. */
  readRenderPreparation?(memory: GuestMemory, hash: string): Promise<GameRenderPreparation | null>;
  /** Read-only custom control strings; private message/data layouts belong to the selected game. */
  readMenuTexts?(memory: GuestMemory, hwnds: readonly number[], hash: string): Promise<ReadonlyMap<number, string>>;
  /** Opt-in page cursor: validate the executable, preserve input/shape ownership, and suppress only the final native blit. */
  preparePagePointer?(memory: GuestMemory, hash: string): Promise<GamePagePointer | null>;
  /** Create a read-only native frame counter for explicit performance sampling; null for unsupported versions. */
  createFrameReader?(memory: GuestMemory, hash: string): GameFrameReader | null;
  /**
   * Opt-in (HD bridge only): read-only live battlefield snapshots; see renderState.ts. Asynchronous so a game can load
   * its readers on demand and leave them out of production builds.
   */
  createRenderStateReader?: CreateGameRenderStateReader;
  /**
   * Opt-in (practice sessions only): read-only order state of the local player; see commandState.ts. Asynchronous for
   * the same reason as createRenderStateReader.
   */
  createCommandStateReader?: CreateGameCommandStateReader;
  /** Apply narrow version-specific compatibility patches after copying the PE image into guest memory and before executing its entry point. */
  prepareImage?(memory: GuestMemory): void;
  /**
   * Opt-in (HD bridge only): install the inert native overlay passthrough patches before the entry point; categories
   * are switched later through the returned control. See renderPassthrough.ts (PrepareRenderPassthrough documents
   * `reserve` and the null result). Asynchronous for the same reason as createRenderStateReader; the core awaits it
   * before the entry point runs.
   */
  prepareRenderPassthrough?(
    memory: GuestMemory,
    reserve: (size: number, alignment?: number) => number,
  ): Promise<RenderPassthroughControl | null>;
  /** Explicit startup navigation; the game verifies the target/EXE, and the allocator exclusively owns the static-import-stub tail. */
  prepareStartupPage?(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void;
  writeGameSpeedFlag?(memory: GuestMemory, value: number): number | null;
  /** Repair confirmed vulnerable game state before host input enters the guest message queue. */
  beforeHostMessage?(memory: GuestMemory, message: number): void;
  crashHint?(vector: number, eip: number): string;
}
