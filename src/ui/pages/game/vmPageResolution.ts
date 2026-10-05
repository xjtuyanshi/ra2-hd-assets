/**
 * Local game-resolution preference persistence, extracted from page.ts.
 * Reuse storage keys/parsing from games/resolution, shared by page and toolbar actions.
 */
import {
  customGameResolution,
  GAME_RESOLUTION_LIMITS,
  gameResolutionValue,
  parseGameResolution,
  type GameResolution,
} from '../../../games/resolution';
import type { SupportedGameId } from '../../../games/catalog';
import { displayMatchedFrameSize } from './canvasFit';

const STORED_RESOLUTION_PREFIX = 'vm-resolution-';

/** Toolbar/URL value of the display-matched choice. */
export const DISPLAY_RESOLUTION = 'display';
/** Stored/URL value of an explicit "follow the INI" choice (the toolbar's value for it is the empty string). */
const INI_RESOLUTION = 'ini';

/**
 * What the player picked: a preset, the game's own INI (null), or 'display': a size computed at every start so that
 * one game pixel covers exactly DISPLAY_DEVICE_PIXELS device pixels of the window the game starts in.
 */
export type ResolutionChoice = GameResolution | typeof DISPLAY_RESOLUTION | null;

/**
 * Device pixels per game pixel of the display-matched choice. The HD remaster art has two texels per game pixel, so it
 * is only shown texel for pixel at this scale; the original picture gets exact 2x pixels. Windows too small for it use
 * scale 1 (see displayMatchedFrameSize).
 */
export const DISPLAY_DEVICE_PIXELS = 2;

/** Toolbar select value of a choice. */
export function resolutionChoiceValue(choice: ResolutionChoice): string {
  return choice === DISPLAY_RESOLUTION ? DISPLAY_RESOLUTION : choice ? gameResolutionValue(choice) : '';
}

/**
 * Parse a toolbar, stored or URL value: a preset, 'display', or '' / 'ini' for the game's INI. `custom` also accepts any
 * size the VM supports (URL only: the toolbar offers presets). Undefined for anything else, including null.
 */
export function parseResolutionChoice(value: string | null, custom = false): ResolutionChoice | undefined {
  if (value === null) return undefined;
  if (value === '' || value === INI_RESOLUTION) return null;
  if (value === DISPLAY_RESOLUTION) return DISPLAY_RESOLUTION;
  const preset = parseGameResolution(value);
  if (preset) return preset;
  const match = custom ? /^(\d{3,4})x(\d{3,4})$/.exec(value) : null;
  return (match && customGameResolution(Number(match[1]), Number(match[2]))) || undefined;
}

/** The stored choice, or undefined when the player never chose (or storage is unavailable). */
export function loadStoredResolutionChoice(gameId: SupportedGameId): ResolutionChoice | undefined {
  try {
    return parseResolutionChoice(window.localStorage.getItem(`${STORED_RESOLUTION_PREFIX}${gameId}`));
  } catch {
    return undefined;
  }
}

export function storeResolutionChoice(gameId: SupportedGameId, choice: ResolutionChoice): void {
  try {
    // An explicit "follow the INI" is stored too: a page whose default is another choice must not override it.
    window.localStorage.setItem(
      `${STORED_RESOLUTION_PREFIX}${gameId}`,
      resolutionChoiceValue(choice) || INI_RESOLUTION,
    );
  } catch {
    // Persistence may be unavailable in private mode; safely fall back to the original INI after this restart.
  }
}

/**
 * The resolution a choice means right now. 'display' measures `stage` (the element the game canvas is fitted into);
 * without a measurable stage it falls back to the INI.
 */
export function resolveResolutionChoice(
  choice: ResolutionChoice,
  stage: Element | null,
  devicePixelRatio: number,
): GameResolution | null {
  if (choice !== DISPLAY_RESOLUTION) return choice;
  const rect = stage?.getBoundingClientRect();
  if (!rect) return null;
  return displayMatchedFrameSize({
    stageWidth: rect.width,
    stageHeight: rect.height,
    devicePixelRatio,
    devicePixelsPerFramePixel: DISPLAY_DEVICE_PIXELS,
    limits: GAME_RESOLUTION_LIMITS,
  });
}

/**
 * Whether a display-matched session should be restarted to match its window again. The size is measured once, at
 * start: a window changed since then shows the matched frame resampled (not a whole scale) or with wide borders (a
 * whole scale well below the one that would fill the stage). A frame of any other size says nothing about the window:
 * the games' menu pages have their own fixed size whatever resolution the match will use.
 */
export function displayMatchIsStale(
  matched: GameResolution | null,
  frame: GameResolution,
  scale: number,
  fillScale: number,
): boolean {
  if (!matched || frame.width !== matched.width || frame.height !== matched.height) return false;
  const whole = Math.abs(scale - Math.round(scale)) < 1e-6;
  return !whole || fillScale > scale * 1.1;
}
