/**
 * Art file-name resolution rules (pure).
 *
 * - `Theater=yes` art (trees, smudges, ore/gems, rocks, low bridges) is stored as `<image>.<theater ext>`.
 * - NewTheater art swaps the image's second character for the theater letter (T/A/U/N/D/L); when that file is
 *   missing the engine falls back to the generic letter G, then the plain name. The swap only applies when the name
 *   starts with one of the engine's prefix letters (G, N, C, Y) and its second character is one of the theater
 *   letters A, T, U, D, L, N (the list in the Chrono Divide-derived reference, huangkaoya/ts-redalert2
 *   src/engine/ImageFinder.ts applyNewTheaterIfNeeded). So `CABHUT` becomes `ctbhut.shp` on temperate (the file
 *   lives in temperat.mix), while `TSTLAMP` (T is not a prefix letter) stays untouched.
 *   The engine applies it to every such name whatever the art `NewTheater=` says (ArtSource always requests it):
 *   YR 1.001 ships per-theater files for art marked `NewTheater=no` (country flags CAUSFGL..CAUKFGL and the guard
 *   shack CAGARD01 have ct/cu/cn/cd/cl variants next to the snow-only ca- file), and the shipyards GAYARD/NAYARD/
 *   YAYARD and NAPSIS/NAPSYB have no NewTheater key while only the gg-, ng- and yg- files exist outside snow. For every other
 *   rules type (overlays, terrain, units, infantry, aircraft, smudges) the flag-based and the unconditional rule pick
 *   the same file on all six theaters of the stock install.
 * - Everything else is `<image>.shp`.
 * - Voxels: `<image>.vxl/.hva`, turret `<image>tur`, barrel `<image>barl`.
 */

const NEW_THEATER_PREFIX = new Set(['G', 'N', 'C', 'Y']);
const THEATER_LETTERS = new Set(['A', 'T', 'U', 'D', 'L', 'N']);

/** Candidate SHP file names, most specific first. */
export function artFileCandidates(
  image: string,
  opts: { theater: boolean; newTheater: boolean; theaterExt: string; theaterLetter: string },
): string[] {
  const stem = image.trim().toLowerCase();
  if (!stem) return [];
  if (opts.theater) return [`${stem}.${opts.theaterExt}`, `${stem}.shp`];
  const out: string[] = [];
  const upper = stem.toUpperCase();
  if (opts.newTheater && stem.length >= 2 && NEW_THEATER_PREFIX.has(upper[0]!) && THEATER_LETTERS.has(upper[1]!)) {
    out.push(`${stem[0]}${opts.theaterLetter.toLowerCase()}${stem.slice(2)}.shp`);
    out.push(`${stem[0]}g${stem.slice(2)}.shp`);
  }
  out.push(`${stem}.shp`);
  return [...new Set(out)];
}

/** First candidate for which `has` is true. */
export function resolveArtFile(candidates: readonly string[], has: (name: string) => boolean): string | undefined {
  return candidates.find((c) => has(c));
}

/** Parse an art `Foundation=WxH` value; "Custom" and garbage fall back to 1x1. */
export function parseFoundation(value: string | undefined): [number, number] {
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)/.exec(value ?? '');
  if (!m) return [1, 1];
  return [Math.max(1, Number(m[1])), Math.max(1, Number(m[2]))];
}

/**
 * Directional frame for an engine facing (0..255, 0 = map north, clockwise). Map north (cell -Y) points to screen
 * up-right, while RA2/TS directional SHPs start with the frame facing straight up the screen and run
 * counter-clockwise, so facing 0 is the frame one eighth of a turn before the end (7 of 8, 28 of 32). Same mapping as
 * the Chrono Divide-derived reference (huangkaoya/ts-redalert2 src/game/Game.ts facing -> degrees, then
 * Infantry.ts / Vehicle.ts: frame = round(((deg - 45 + 360) % 360) / 360 * n) % n).
 */
export function facingFrame(facing: number, facings: number): number {
  const n = Math.max(1, facings);
  const deg = (((-((((facing % 256) + 256) % 256) / 256) * 360) % 360) + 360) % 360;
  return Math.round((((deg - 45 + 360) % 360) / 360) * n) % n;
}

/**
 * Parse an INI fraction the way the engine does: "50%" -> 0.5, "0.5" -> 0.5. Returns `fallback` for garbage.
 * rulesmd [AudioVisual] ConditionYellow/ConditionRed are written as percentages in YR.
 */
export function parseIniFraction(value: string | undefined, fallback: number): number {
  const v = (value ?? '').trim();
  if (!v) return fallback;
  const pct = v.endsWith('%');
  const n = Number.parseFloat(pct ? v.slice(0, -1) : v);
  if (!Number.isFinite(n)) return fallback;
  return pct ? n / 100 : n;
}

/**
 * Building body frame for a map health value (0..256 of full strength): frame 0 above ConditionYellow, the damaged
 * frame 1 at or below it (when the SHP has one).
 */
export function buildingConditionFrame(health: number, conditionYellow: number, bodyFrames: number): number {
  return bodyFrames > 1 && health / 256 <= conditionYellow ? 1 : 0;
}

/**
 * Representative still frame of a looping building anim (ActiveAnim etc.) from its art LoopStart/LoopEnd (inclusive;
 * LoopStart defaults to Start, LoopEnd to the last body frame): the middle of the loop. Frame 0 is often not a
 * typical idle frame (e.g. CAMOV01_A's drive-in screen is dark at frame 0).
 */
export function animStillFrame(
  art: { start?: number; loopStart?: number; loopEnd?: number },
  bodyFrames: number,
): number {
  if (bodyFrames <= 0) return 0;
  const last = bodyFrames - 1;
  const clampF = (v: number): number => Math.min(last, Math.max(0, v));
  const a = clampF(art.loopStart ?? art.start ?? 0);
  const b = clampF(art.loopEnd ?? last);
  return b >= a ? a + Math.floor((b - a) / 2) : a;
}

/** Parse an artmd sequence entry "start,count,facingMultiplier[,...]". */
export function parseSequenceEntry(
  value: string | undefined,
): { start: number; count: number; facingMultiplier: number } | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((p) => Number.parseInt(p.trim(), 10));
  if (parts.length < 1 || !Number.isFinite(parts[0])) return undefined;
  return {
    start: parts[0]!,
    count: Number.isFinite(parts[1]) ? parts[1]! : 1,
    facingMultiplier: Number.isFinite(parts[2]) ? parts[2]! : 0,
  };
}

/** Split a SHP into body and shadow halves when its second half is a pure shadow (index 1 only) set. */
export function splitShadowHalf(frames: readonly { pixels: Uint8Array }[]): { body: number; hasShadows: boolean } {
  const n = frames.length;
  if (n < 2 || n % 2 !== 0) return { body: n, hasShadows: false };
  const half = n / 2;
  for (let i = half; i < n; i++) {
    for (const v of frames[i]!.pixels) if (v > 1) return { body: n, hasShadows: false };
  }
  // An all-empty second half is still the shadow convention (e.g. shadowless infantry), but only split when the
  // first half has real art so a 2-frame sprite of two identical empties is not misread.
  let bodyPixels = 0;
  for (let i = 0; i < half; i++) for (const v of frames[i]!.pixels) if (v > 1) bodyPixels++;
  if (bodyPixels === 0) return { body: n, hasShadows: false };
  return { body: half, hasShadows: true };
}

/** One artmd infantry sequence entry: `Name=Start,Count,FacingMultiplier[,Facing]`. */
export interface InfantrySequence {
  start: number;
  count: number;
  /** Frames per facing step (0 = the sequence does not depend on facing). */
  facingMultiplier: number;
  /** Optional fixed direction letters (N, NE, E, SE, S, SW, W, NW) the infantry turns to while playing it. */
  facing?: string;
}

/**
 * Parse every entry of an artmd `[<Sequence>]` section. Values whose first field is not a plain integer (YR's
 * `Idle2Sounds=9 TrexDie` style sound lists) are skipped; a repeated key keeps its last value, as the INI does. Count
 * defaults to 1 and the facing multiplier to 0 like parseSequenceEntry.
 */
export function parseInfantrySequences(
  entries: readonly { key: string; value: string }[],
): Record<string, InfantrySequence> {
  const out: Record<string, InfantrySequence> = {};
  for (const { key, value } of entries) {
    const parts = value.split(',').map((p) => p.trim());
    if (!/^-?\d+$/.test(parts[0] ?? '')) continue;
    const num = (i: number, fallback: number): number => (/^-?\d+$/.test(parts[i] ?? '') ? Number(parts[i]) : fallback);
    const seq: InfantrySequence = { start: num(0, 0), count: Math.max(1, num(1, 1)), facingMultiplier: num(2, 0) };
    const dir = (parts[3] ?? '').toUpperCase();
    if (/^(N|NE|E|SE|S|SW|W|NW)$/.test(dir)) seq.facing = dir;
    out[key] = seq;
  }
  return out;
}

/**
 * SHP frame of an infantry sequence for engine facing `facing` (0..255, 0 = north) at animation step `step`, with the
 * same facing -> frame convention as facingFrame (8 directions).
 */
export function sequenceFrame(seq: InfantrySequence, facing: number, step: number): number {
  const dir = seq.facingMultiplier > 0 ? facingFrame(facing, 8) * seq.facingMultiplier : 0;
  const n = Math.max(1, seq.count);
  return seq.start + dir + (((step % n) + n) % n);
}

/**
 * Building art keys naming an anim layer drawn over the body (each may have <key>Damaged, <key>X, <key>Y,
 * <key>ZAdjust, <key>YSort and <key>Powered companions). Collected from every BuildingTypes art section of YR 1.001's
 * artmd.ini; ActiveAnim..ActiveAnimFour are the ones the map extractor draws as still frames.
 */
export const BUILDING_LAYER_KEYS = [
  'ActiveAnim',
  'ActiveAnimTwo',
  'ActiveAnimThree',
  'ActiveAnimFour',
  'IdleAnim',
  'IdleAnimTwo',
  'SpecialAnim',
  'SpecialAnimTwo',
  'SpecialAnimThree',
  'SpecialAnimFour',
  'SuperAnim',
  'SuperAnimTwo',
  'SuperAnimThree',
  'SuperAnimFour',
  'ProductionAnim',
  'DeployingAnim',
  'UnderDoorAnim',
  'RoofDeployingAnim',
  'UnderRoofDoorAnim',
  'ActiveAnimGarrisoned',
  'LowPower',
  'SuperLowPower',
] as const;

/** The subset the map extractor draws (one still frame each). */
export const BUILDING_ACTIVE_ANIM_KEYS = BUILDING_LAYER_KEYS.slice(0, 4);

/** Minimal INI section view (satisfied by ra2-formats' IniSection). */
export interface ArtSectionView {
  has(key: string): boolean;
  getString(key: string, fallback?: string): string;
}

const intOf = (sec: ArtSectionView | undefined, key: string): number | undefined => {
  if (!sec?.has(key)) return undefined;
  const v = Number.parseInt(sec.getString(key, ''), 10);
  return Number.isFinite(v) ? v : undefined;
};
const boolOf = (sec: ArtSectionView | undefined, key: string): boolean | undefined =>
  sec?.has(key) ? /^(y|t|1)/i.test(sec.getString(key, '').trim()) : undefined;

/** Placement companions of one building layer key (only the keys art actually sets). */
export interface BuildingLayerArt {
  key: string;
  anim: string;
  damaged?: string;
  offset?: [number, number];
  zAdjust?: number;
  ySort?: number;
  powered?: boolean;
}

/** Read layer `key` of a building art section, or undefined when the building has no such layer. */
export function buildingLayerArt(sec: ArtSectionView | undefined, key: string): BuildingLayerArt | undefined {
  const anim = sec?.getString(key, '').trim();
  if (!sec || !anim) return undefined;
  const out: BuildingLayerArt = { key, anim };
  const damaged = sec.getString(`${key}Damaged`, '').trim();
  if (damaged) out.damaged = damaged;
  const x = intOf(sec, `${key}X`);
  const y = intOf(sec, `${key}Y`);
  if (x !== undefined || y !== undefined) out.offset = [x ?? 0, y ?? 0];
  const z = intOf(sec, `${key}ZAdjust`);
  if (z !== undefined) out.zAdjust = z;
  const ys = intOf(sec, `${key}YSort`);
  if (ys !== undefined) out.ySort = ys;
  const powered = boolOf(sec, `${key}Powered`);
  if (powered !== undefined) out.powered = powered;
  return out;
}

/** Timing keys of an anim art section (only those present). */
export function animTimingArt(sec: ArtSectionView | undefined): {
  start?: number;
  end?: number;
  loopStart?: number;
  loopEnd?: number;
  loopCount?: number;
  rate?: number;
  reverse?: boolean;
  shadow?: boolean;
} {
  const out: ReturnType<typeof animTimingArt> = {};
  const ints = [
    ['start', 'Start'],
    ['end', 'End'],
    ['loopStart', 'LoopStart'],
    ['loopEnd', 'LoopEnd'],
    ['loopCount', 'LoopCount'],
    ['rate', 'Rate'],
  ] as const;
  for (const [field, key] of ints) {
    const v = intOf(sec, key);
    if (v !== undefined) out[field] = v;
  }
  const reverse = boolOf(sec, 'Reverse');
  if (reverse !== undefined) out.reverse = reverse;
  const shadow = boolOf(sec, 'Shadow');
  if (shadow !== undefined) out.shadow = shadow;
  return out;
}
