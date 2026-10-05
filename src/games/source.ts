import type { SupportedGame } from './catalog';
import type { GameFileProvider } from '../resources/contracts';

export interface GameSource {
  game: SupportedGame;
  files: GameFileProvider;
  /** EXE bytes already read during detection, avoiding duplicate disk reads through File System Access. */
  executableBytes: Uint8Array;
  /** Additional startup files scoped to the game root; mount after the Worker rediscovers the game. */
  additionalFiles?: ReadonlyMap<string, Uint8Array>;
  /**
   * Startup speed the host chose for this session (original INI scale, 0 fastest to 6 slowest); replaces the game's
   * catalog default in the same in-memory overlay (see gameSpeed.ts).
   */
  gameSpeed?: number;
}
