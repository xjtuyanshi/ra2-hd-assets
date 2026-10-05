import type { LiveWarmType } from '../../../../packages/hd-renderer/src/live/liveView';

/**
 * What the HD view should prepare before the next match starts (development only, with the HD bridge).
 *
 * The game creates the players' starting units as its loading screen ends, so a view that first hears of them in the
 * match's first snapshot spends the opening seconds fetching their pages, building their meshes and compiling their
 * shaders. The kinds of object a match showed in its first minutes are therefore remembered here, and the next
 * match's view draws them out of sight while the game still loads (LiveView.warm). Only kinds are kept (rules type,
 * engine image, colour scheme): never positions, counts or anything else about a match.
 *
 * Three lists: one per map (everything that match showed, the map's own civilian buildings included), one per
 * theater for maps not played yet, and one for theaters not played yet (both players' objects only: starting units
 * and base buildings are the same on every map, a map's dressing is not; rules types are the same in every theater,
 * each theater's library has its own art for them). A list that does not fit the next match (another side or colour)
 * costs nothing but the art it loaded: the view still waits for what the match really needs before it is shown.
 */
export interface HdWarmStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'ra2-hd-warm:1:';
const KINDS = new Set(['building', 'vehicle', 'infantry', 'aircraft']);
/** Most kinds kept per list: the opening minutes of an eight-player match stay well below it. */
export const WARM_TYPES_LIMIT = 320;

const mapKey = (map: string): string => `${PREFIX}map:${map.toLowerCase()}`;
const theaterKey = (theater: string): string => `${PREFIX}theater:${theater.toLowerCase()}`;
const PLAYERS_KEY = `${PREFIX}players`;

/** Identity of a kind: two objects that share it draw the same art with the same colours and kind of owner. */
export function warmTypeKey(type: LiveWarmType): string {
  return `${type.kind}:${type.type}:${type.imageType ?? ''}:${type.colorIndex}:${type.civilian ? 1 : 0}`;
}

function parse(raw: string | null): LiveWarmType[] | null {
  if (!raw) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const types: LiveWarmType[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, WARM_TYPES_LIMIT)) {
    // [kind, type, imageType or '', colorIndex, civilian 0/1]; anything else was not written by this module.
    if (!Array.isArray(row)) return null;
    const [kind, type, imageType, colorIndex, civilian] = row as unknown[];
    if (
      typeof kind !== 'string' ||
      !KINDS.has(kind) ||
      typeof type !== 'string' ||
      !/^[\w.-]{1,32}$/.test(type) ||
      typeof imageType !== 'string' ||
      !/^[\w.-]{0,32}$/.test(imageType) ||
      !Number.isInteger(colorIndex) ||
      (colorIndex as number) < -1 ||
      (colorIndex as number) > 255
    )
      return null;
    const entry: LiveWarmType = {
      kind: kind as LiveWarmType['kind'],
      type,
      ...(imageType ? { imageType } : {}),
      colorIndex: colorIndex as number,
      ...(civilian === 1 ? { civilian: true } : {}),
    };
    const key = warmTypeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    types.push(entry);
  }
  return types;
}

const serialize = (types: readonly LiveWarmType[]): string =>
  JSON.stringify(
    types
      .slice(0, WARM_TYPES_LIMIT)
      .map((type) => [type.kind, type.type, type.imageType ?? '', type.colorIndex, type.civilian ? 1 : 0]),
  );

/**
 * The list to warm for a match on `map`: the map's own when it was played before, else the theater's, else the
 * players' objects of the last match anywhere. Null when there is none (or storage is unavailable, e.g. private
 * browsing): the view then prepares from the match itself.
 */
export function readWarmTypes(storage: HdWarmStorage | null, map: string, theater: string): LiveWarmType[] | null {
  if (!storage) return null;
  try {
    const own = parse(storage.getItem(mapKey(map)));
    if (own?.length) return own;
    const shared = parse(storage.getItem(theaterKey(theater)));
    if (shared?.length) return shared;
    const players = parse(storage.getItem(PLAYERS_KEY));
    return players?.length ? players : null;
  } catch {
    return null;
  }
}

/** Remember what a match on `map` showed. Storage errors (quota, private browsing) only lose the hint. */
export function writeWarmTypes(
  storage: HdWarmStorage | null,
  map: string,
  theater: string,
  types: readonly LiveWarmType[],
): void {
  if (!storage || !types.length) return;
  try {
    const players = serialize(types.filter((type) => !type.civilian));
    storage.setItem(mapKey(map), serialize(types));
    storage.setItem(theaterKey(theater), players);
    storage.setItem(PLAYERS_KEY, players);
  } catch {
    // Nothing to do: the next match prepares from its own first snapshot.
  }
}

/** Drawing-buffer width and height and view width and height (engine pixels) the HD view was last shown with. */
export type HdShownLayout = readonly [bufferWidth: number, bufferHeight: number, viewWidth: number, viewHeight: number];

const LAYOUT_KEY = `${PREFIX}layout`;

/**
 * The layout of the last match's HD view, or null. The game shows its loading screen in another video mode than the
 * match, so a view prepared behind it would be laid out for a size it is never shown at, and its post passes would
 * be built a second time when the match's first frame arrives.
 */
export function readShownLayout(storage: HdWarmStorage | null): HdShownLayout | null {
  if (!storage) return null;
  try {
    const values: unknown = JSON.parse(storage.getItem(LAYOUT_KEY) ?? 'null');
    if (
      !Array.isArray(values) ||
      values.length !== 4 ||
      !values.every((value) => Number.isInteger(value) && value >= 1 && value <= 32768)
    )
      return null;
    return values as unknown as HdShownLayout;
  } catch {
    return null;
  }
}

export function writeShownLayout(storage: HdWarmStorage | null, layout: HdShownLayout): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The next loading screen prepares at its own size.
  }
}

const TOP_EFFECTS_KEY = `${PREFIX}top-effects`;

/**
 * Whether an earlier match showed top-layer art (the marker of a unit behind a building, storm clouds). Its pass
 * joins the view's post graph with the first such art, which rebuilds every post material once (half a second); a
 * view that is told beforehand has the pass from the start. Not on by default: the pass has a multisampled target of
 * its own (about 0.4 GiB at 3120 x 2096).
 */
export function readTopEffects(storage: HdWarmStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(TOP_EFFECTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeTopEffects(storage: HdWarmStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(TOP_EFFECTS_KEY, '1');
  } catch {
    // The next match adds the pass when its first top-layer art shows.
  }
}

/** `localStorage`, or null where reading it throws (blocked storage). */
export function browserWarmStorage(): HdWarmStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
