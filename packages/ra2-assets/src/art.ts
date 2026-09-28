/**
 * Art file-name resolution rules (pure).
 *
 * - `Theater=yes` art (trees, smudges, ore/gems, rocks, low bridges) is stored as `<image>.<theater ext>`.
 * - `NewTheater=yes` art (most buildings, some anims) swaps the image's second character for the theater letter
 *   (T/A/U/N/D/L); when that file is missing the engine falls back to the generic letter G, then the plain name.
 *   The swap only applies when the name starts with one of the engine's prefix letters (G, N, C, Y) and its second
 *   character is one of the theater letters A, T, U, D, L, N (the list in the Chrono Divide-derived reference,
 *   huangkaoya/ts-redalert2 src/engine/ImageFinder.ts applyNewTheaterIfNeeded). So `CABHUT` becomes `ctbhut.shp`
 *   on temperate (the file lives in temperat.mix), while `TSTLAMP` (T is not a prefix letter) stays untouched.
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
