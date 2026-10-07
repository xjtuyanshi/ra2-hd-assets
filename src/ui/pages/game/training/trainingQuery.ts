import type { SupportedGameId } from '../../../../games/catalog';

/**
 * Practice mode of the page (development builds, `?train=`): `train=menu` shows the lesson list, `train=<lesson id>`
 * starts that lesson. A lesson id begins with its game's id ("yr-camera"), and its scenario's game folder is named by
 * `game-root` (see docs/remaster/TRAINING.md). Every other query parameter is the launcher's and is kept as it is.
 */
export interface TrainingQuery {
  /** The lesson to run, or null for the lesson list. */
  lesson: string | null;
  game: SupportedGameId;
}

const LESSON_ID = /^(yr|ra2)-[a-z0-9-]{1,40}$/;

export function parseTrainingQuery(search: string, dev: boolean = import.meta.env.DEV): TrainingQuery | null {
  if (!dev) return null;
  const value = new URLSearchParams(search).get('train');
  if (value === null) return null;
  if (LESSON_ID.test(value)) return { lesson: value, game: value.startsWith('ra2-') ? 'ra2' : 'yr' };
  return { lesson: null, game: 'yr' };
}

/** Address of a lesson (or with null of the lesson list), keeping the launcher's other parameters. */
export function trainingHref(href: string, lesson: string | null, scenario?: string): string {
  const url = new URL(href);
  url.searchParams.set('train', lesson ?? 'menu');
  if (lesson && scenario) {
    url.searchParams.set('game-root', scenario);
    url.searchParams.set('start-page', 'battle');
  } else {
    url.searchParams.delete('game-root');
    url.searchParams.delete('start-page');
  }
  return url.toString();
}

/** `game-root`: a sub-folder of the development server's game directory holding the session's own game folder. */
export function developmentGameRoot(search: string): string {
  const value = new URLSearchParams(search).get('game-root') ?? '';
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value) ? value : '';
}
