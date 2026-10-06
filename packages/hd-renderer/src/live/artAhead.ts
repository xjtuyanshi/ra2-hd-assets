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
  const sprite = library.sprites[library.overlays?.[id]?.sprite ?? ''];
  const pages = new Set<number>();
  for (const frame of [...(sprite?.frames ?? []), ...(sprite?.shadows ?? [])])
    if (frame.rect[2] > 0) pages.add(frame.page ?? 0);
  return [...pages].sort((a, b) => a - b);
}
