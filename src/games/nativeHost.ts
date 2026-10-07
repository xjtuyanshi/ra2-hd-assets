import type { GuestMemory } from '../vm86/win32';
import type { GameRenderStateReader } from './renderState';
import type { GameCommandStateReader } from './commandState';
import type { GameFrameReader } from './performance';
import type { RenderPassthroughControl } from './renderPassthrough';

/** Serializable game-selected ranges and pointer-follow rules; host mechanisms interpret them generically. */
export interface NativeHostRange {
  address: number;
  length: number;
}
export interface NativeHostFollowRule {
  kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  source: number;
  bytes: number;
  maxCount: number;
  stride: number;
}

/** Verified native agent hook metadata supplied to version-specific reader/patch policies. */
export interface NativeHostMetadata {
  gameThreadId: number;
  verifiedNativeHook?: {
    site: number;
    original: readonly number[];
    patched: readonly number[];
  };
}

/** Game facts stay in the selected game module; the host owns subscription and memory retry lifecycles. */
export interface NativeGamePolicy {
  readonly ranges: readonly NativeHostRange[];
  readonly rules: readonly NativeHostFollowRule[];
  additionalRanges?(): readonly NativeHostRange[];
  createRenderReader(): GameRenderStateReader | null;
  createCommandReader(): GameCommandStateReader | null;
  createFrameReader(): GameFrameReader | null;
  installPassthrough(
    memory: GuestMemory,
    reserve: (size: number, alignment?: number) => number,
  ): RenderPassthroughControl | null;
  setSpeed(memory: GuestMemory, value: number): number | null;
}
