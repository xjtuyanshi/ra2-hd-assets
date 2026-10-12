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
 * A fixed resolution, the game's INI (null), or a remembered view scale measured at session start.
 * Legacy 'display' retains the wide two-device-pixel view.
 */
export const VIEW_SCALES = { classic: 3, moderate: 2.5, wide: 2 } as const;
export type ViewChoice = keyof typeof VIEW_SCALES;
export type ResolutionChoice = GameResolution | typeof DISPLAY_RESOLUTION | ViewChoice | null;

export function resolutionViewScale(choice: ResolutionChoice): number | null {
  return choice === DISPLAY_RESOLUTION ? 2 : typeof choice === 'string' ? VIEW_SCALES[choice] : null;
}

/**
 * Legacy display choice; the three named views use VIEW_SCALES.
 */
export const DISPLAY_DEVICE_PIXELS = 2;

/** Toolbar select value of a choice. */
export function resolutionChoiceValue(choice: ResolutionChoice): string {
  return typeof choice === 'string' ? choice : choice ? gameResolutionValue(choice) : '';
}

/**
 * Parse a toolbar, stored or URL value: a preset, 'display', or '' / 'ini' for the game's INI. `custom` also accepts any
 * size the VM supports (URL only: the toolbar offers presets). Undefined for anything else, including null.
 */
export function parseResolutionChoice(value: string | null, custom = false): ResolutionChoice | undefined {
  if (value === null) return undefined;
  if (value === '' || value === INI_RESOLUTION) return null;
  if (value === DISPLAY_RESOLUTION) return DISPLAY_RESOLUTION;
  if (Object.hasOwn(VIEW_SCALES, value)) return value as ViewChoice;
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
 * A captured Start-click area takes precedence over a later stage layout; without either it follows the INI.
 */
export function resolveResolutionChoice(
  choice: ResolutionChoice,
  stage: Element | null,
  devicePixelRatio: number,
  measuredArea?: { width: number; height: number },
): GameResolution | null {
  const scale = resolutionViewScale(choice);
  if (scale === null) return choice as GameResolution | null;
  const rect = measuredArea ?? stage?.getBoundingClientRect();
  if (!rect) return null;
  return displayMatchedFrameSize({
    stageWidth: rect.width,
    stageHeight: rect.height,
    devicePixelRatio,
    devicePixelsPerFramePixel: scale,
    limits: GAME_RESOLUTION_LIMITS,
  });
}

/**
 * The effective scale negotiated at startup. Store this result for the session: recalculating it after a resize
 * would mistake a changed window for the original small-window fallback. Even frame rounding leaves a tiny border.
 */
export function resolveResolutionViewScale(
  choice: ResolutionChoice,
  stage: Element | null,
  devicePixelRatio: number,
  negotiatedFrame: GameResolution | null,
  measuredArea?: { width: number; height: number },
): number | undefined {
  const selected = resolutionViewScale(choice);
  const rect = measuredArea ?? stage?.getBoundingClientRect();
  if (selected === null || !rect || !negotiatedFrame) return undefined;
  const fit = Math.min(
    (rect.width * devicePixelRatio) / negotiatedFrame.width,
    (rect.height * devicePixelRatio) / negotiatedFrame.height,
  );
  if (!Number.isFinite(fit) || fit <= 0) return undefined;
  for (let scale = selected; scale >= 1; scale -= 0.5) if (scale <= fit + 1e-6) return scale;
  return fit;
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
  preferredScale = DISPLAY_DEVICE_PIXELS,
): boolean {
  if (!matched || frame.width !== matched.width || frame.height !== matched.height) return false;
  return Math.abs(scale - preferredScale) > 1e-6 || fillScale > scale * 1.1;
}
