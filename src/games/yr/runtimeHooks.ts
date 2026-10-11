import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { writeGameSpeedFlag } from '../shared/gameSpeedFlag';
import { skipStartupMovieBlock } from '../shared/startupMovieSkip';
import { createYrFrameReader } from './performance';
import { installYrBattleStartup } from './battleStartup';
import { installYrLanStartup, installYrSkirmishStartup } from './startupPage';

const YR_STARTUP_MOVIE_BLOCK = 0x0052_c5e0;
const YR_STARTUP_MOVIE_CONTINUATION = 0x0052_c5f3;
const YR_STARTUP_MOVIE_SIGNATURE = [0x8b, 0xd5, 0xb9, 0x20, 0x5f] as const;
const YR_SETTINGS_POINTER = 0x0088_71e0;
const YR_GAME_SPEED_OFFSET = 0x14a0;

/** Accept only the original seven settings 0..6; see YR_SETTINGS_POINTER for the Settings singleton pointer and field offset. */
export function writeYrGameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, YR_SETTINGS_POINTER, YR_GAME_SPEED_OFFSET, value);
}

/**
 * YR 1.001 unconditionally creates and plays EA_WWLOGO at 0x52c5e0; unlike RA2's WESTLOGO branch, it has no usable INI switch. Jump to 0x52c5f3 to retain native shared movie cleanup without creating the startup-movie window. Campaign briefings and in-game EVA windows use other call sites and remain unaffected.
 */
export function skipYrStartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(
    memory,
    YR_STARTUP_MOVIE_BLOCK,
    YR_STARTUP_MOVIE_CONTINUATION,
    YR_STARTUP_MOVIE_SIGNATURE,
  );
}

/**
 * HD bridge extensions (the render-state readers and the native overlay passthrough patches) are development-only.
 * The render-state module owns the 250 ms overlay poll alongside the other readers. Each hook loads its module on first use through a dynamic import behind `import.meta.env.DEV`, a build-time
 * constant, so production bundles contain none of that code and the hooks resolve to null there. A static import of
 * any of those modules elsewhere would ship them again; tests/basic/architecture/dependencies.test.ts rejects that.
 */
const YR_HD_BRIDGE_HOOKS: Pick<
  GameRuntimeHooks,
  | 'createRenderStateReader'
  | 'createCommandStateReader'
  | 'prepareRenderPassthrough'
  | 'preparePagePointer'
  | 'readMenuTexts'
> = {
  async readMenuTexts(memory, hwnds, hash) {
    if (import.meta.env.DEV) {
      const { YR_STARTUP_PAGE_HASH } = await import('./startupPage');
      if (hash === YR_STARTUP_PAGE_HASH) {
        const { readYrVmMenuTexts } = await import('./menuText');
        return readYrVmMenuTexts(memory, hwnds);
      }
    }
    return new Map();
  },
  async preparePagePointer(memory, hash) {
    if (import.meta.env.DEV) {
      const { YR_STARTUP_PAGE_HASH } = await import('./startupPage');
      if (hash !== YR_STARTUP_PAGE_HASH) return null;
      const { readYrVmPointer, setYrNativePointerDrawing } = await import('./nativeCursor');
      if (!setYrNativePointerDrawing(memory, false)) return null;
      return {
        read: (width, height) => readYrVmPointer(memory, width, height),
        setDrawing: (enabled) => setYrNativePointerDrawing(memory, enabled),
      };
    }
    return null;
  },
  async createRenderStateReader(memory, size, hash) {
    if (import.meta.env.DEV) {
      const { createYrRenderStateReader } = await import('./renderState');
      return createYrRenderStateReader(memory, size, hash);
    }
    return null;
  },
  async createCommandStateReader(memory, size, hash) {
    if (import.meta.env.DEV) {
      const { createYrCommandStateReader } = await import('./commandState');
      return createYrCommandStateReader(memory, size, hash);
    }
    return null;
  },
  async prepareRenderPassthrough(memory, reserve) {
    if (import.meta.env.DEV) {
      const { prepareYrRenderPassthrough } = await import('./tacticalPassthrough');
      return prepareYrRenderPassthrough(memory, reserve);
    }
    return null;
  },
};

export const YR_RUNTIME_HOOKS: GameRuntimeHooks = Object.freeze({
  createFrameReader: createYrFrameReader,
  ...YR_HD_BRIDGE_HOOKS,
  prepareStartupPage(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void {
    if (page === 'battle') {
      installYrBattleStartup(memory, reserve, hash);
      return;
    }
    if (page === 'lan') {
      installYrLanStartup(memory, reserve, hash);
      return;
    }
    if (page !== 'skirmish') throw new Error(`YR 尚不支持直达页面：${page}`);
    installYrSkirmishStartup(memory, reserve, hash);
  },
  prepareImage: skipYrStartupMovies,
  writeGameSpeedFlag: writeYrGameSpeed,
});
