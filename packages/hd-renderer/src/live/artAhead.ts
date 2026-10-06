import type { TypeLibrary } from '../../../ra2-assets/src/library';

/**
 * What a vehicle turns into when it deploys: rules DeploysInto of YR 1.001 (read from the player's own rulesmd.ini:
 * the three MCVs and the Slave Miner). The type library does not record it. A construction yard has no sidebar
 * production to announce it: it appears in the logic frame its MCV deploys, and its pages were asked for only then
 * (measured before this: no picture for 46 presented frames after the deploy on a quiet machine). The view loads a
 * deploy target's art when the vehicle first appears instead (LiveView.prepare).
 *
 * A hint only: rules that change DeploysInto lose the head start for that building and nothing else.
 */
export const DEPLOY_TARGETS: ReadonlyMap<string, string> = new Map([
  ['AMCV', 'GACNST'],
  ['SMCV', 'NACNST'],
  ['PCV', 'YACNST'],
  ['SMIN', 'YAREFN'],
]);

/** Atlas pages of a live overlay type's art (a wall a player builds is an overlay, not a building), in page order. */
export function overlayTypePages(library: Pick<TypeLibrary, 'overlays' | 'sprites'>, id: string): number[] {
  const pages = new Set<number>();
  addSpritePages(library, library.overlays?.[id]?.sprite, pages);
  return [...pages].sort((a, b) => a - b);
}

/**
 * Every atlas page that holds art of a cell decoration nothing announces: the overlay types that are not walls
 * (rubble where a building fell, a crate, ore, bridges) and all smudge types (craters, scorch marks), in page order.
 * Their pages are few and small (two overlay pages and one smudge page, about 9 M pixels together, in each of the six
 * extracted theatre libraries), so a view fetches the indexed ones when it is created and such a cell always has
 * something to draw from (LiveView.preloadCellPages). Walls are left out: their art shares pages with buildings (17 M
 * pixels each, four more pages), and a wall is announced by the sidebar that builds it (LiveView.prepare) or stands
 * on the map from the start.
 */
export function cellArtPages(library: Pick<TypeLibrary, 'overlays' | 'smudges' | 'sprites'>): number[] {
  const pages = new Set<number>();
  for (const overlay of Object.values(library.overlays ?? {}))
    if (!overlay.wall) addSpritePages(library, overlay.sprite, pages);
  for (const smudge of Object.values(library.smudges ?? {})) addSpritePages(library, smudge.sprite, pages);
  return [...pages].sort((a, b) => a - b);
}

function addSpritePages(library: Pick<TypeLibrary, 'sprites'>, id: string | undefined, pages: Set<number>): void {
  const sprite = library.sprites[id ?? ''];
  for (const frame of sprite?.frames ?? []) if (frame.rect[2] > 0) pages.add(frame.page ?? 0);
  for (const frame of sprite?.shadows ?? []) if (frame.rect[2] > 0) pages.add(frame.page ?? 0);
}
