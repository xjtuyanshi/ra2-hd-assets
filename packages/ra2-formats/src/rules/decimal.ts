// Platform-exact decimal-string -> Q16.16 fixed-point conversion.
//
// WHY STRING ARITHMETIC (NOT parseFloat)
// --------------------------------------
// RA2/YR rules store many quantities as decimals (`BuildSpeed=0.7`,
// `Verses=100%,60%`, `ROT=5.0`). The Vanguard sim is bitwise-deterministic and
// consumes these as Q16.16 integers (see packages/sim/src/fixed/fixed.ts, where
// the same integer domain is defined: raw = value * 65536, floored toward
// -Infinity). If we routed through IEEE-754 `parseFloat` the last fractional
// bit could differ between JS engines / CPUs and seed a multiplayer desync.
//
// Instead we parse the sign, integer part and fractional part as *strings* and
// combine them with plain integer / BigInt math, so `'0.7'` yields exactly
// 45875 on every platform (0.7 * 65536 = 45875.2, floored -> 45875).
//
// ROUNDING (documented, deliberate)
// ---------------------------------
// The scaled value is FLOORED toward negative infinity, matching
// `packages/sim/src/fixed` `mul`/`fromRatio`-family truncation and the
// arithmetic-shift flooring the engine's fixed-point code performs. So:
//   '0.7'   -> floor(0.7   * 65536) = floor(45875.2)  = 45875
//   '-0.7'  -> floor(-0.7  * 65536) = floor(-45875.2) = -45876
//   '1.0'   -> 65536
//   '2'     -> 131072
// Flooring (not round-to-nearest) is chosen because it is what an
// arithmetic-right-shift-based fixed-point pipeline yields and keeps the whole
// conversion monotone and reproducible.

/** Number of fractional bits — Q16.16, identical to packages/sim/src/fixed. */
export const FRACT_BITS = 16;

/** Scale factor 2^16 as a BigInt for exact scaling. */
const ONE = 1n << BigInt(FRACT_BITS); // 65536n

/**
 * A raw Q16.16 fixed-point integer (value * 65536), stored as a plain JS
 * number in the signed 32-bit domain. Interoperates directly with
 * `packages/sim/src/fixed` via its `fromRaw`/`toRaw` escape hatches — this is
 * the same representation, produced here without any float math.
 *
 * Kept as a plain `number` (not the sim's branded `Fx`) so this package need
 * not take a build dependency on @vanguard/sim; the sim brands it on ingest.
 */
export type FxRaw = number;

/**
 * Parse a decimal string to a raw Q16.16 fixed-point integer using only
 * string/integer/BigInt arithmetic (never `parseFloat`), flooring toward
 * negative infinity.
 *
 * Accepts optional leading sign, an integer part, and an optional fractional
 * part (`123`, `0.7`, `.5`, `-2.25`, `+3.`). Surrounding whitespace is
 * tolerated. Returns `fallback` (default 0) if the string is not a
 * well-formed decimal.
 *
 * The result is wrapped into the signed 32-bit domain (`| 0`) to match the
 * sim's `Fx` overflow behaviour.
 */
export function parseDecimalToFx(raw: string, fallback: FxRaw = 0): FxRaw {
  const parsed = tryParseDecimalToFx(raw);
  return parsed === undefined ? fallback : parsed;
}

/**
 * Like {@link parseDecimalToFx} but returns `undefined` for malformed input
 * instead of a fallback, so callers can distinguish "absent/garbage" from a
 * legitimate zero.
 */
export function tryParseDecimalToFx(raw: string): FxRaw | undefined {
  const s = raw.trim();
  // sign? intpart? ('.' frac?)?  — at least one digit somewhere is required.
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return undefined;
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  // Require at least one digit total; a bare '.', '+', '-' or '' is invalid.
  if (intPart === '' && fracPart === '') return undefined;

  const intVal = intPart === '' ? 0n : BigInt(intPart);
  // Scale the fractional digits exactly: frac * 2^16 / 10^len, floored.
  let fracScaled = 0n;
  if (fracPart !== '') {
    const fracVal = BigInt(fracPart);
    const denom = 10n ** BigInt(fracPart.length);
    // Floor(fracVal * 2^16 / 10^len) — BigInt `/` truncates toward zero, and
    // both operands are non-negative here so truncation == floor.
    fracScaled = (fracVal * ONE) / denom;
  }

  const magnitude = intVal * ONE + fracScaled;
  // Apply sign, then floor toward -Infinity. For negatives, the magnitude was
  // floored toward zero above, so negating overshoots by up to 1 lsb when a
  // fractional remainder was dropped; correct it to true floor.
  let scaled: bigint;
  if (sign < 0n) {
    // Detect whether any fractional precision was truncated below 2^-16.
    const remainderLost =
      fracPart !== '' && (BigInt(fracPart) * ONE) % (10n ** BigInt(fracPart.length)) !== 0n;
    scaled = -magnitude - (remainderLost ? 1n : 0n);
  } else {
    scaled = magnitude;
  }
  return Number(scaled) | 0;
}

/**
 * Parse a percent field to an integer percentage (0..100+ scale, but stored as
 * the plain integer the string denotes). Accepts an optional trailing `%`, an
 * optional sign, and decimal forms, rounding toward -Infinity to a whole
 * percent. Both `'100%'` and `'100'` yield 100; `'60%'` -> 60; `'.5'`
 * (a bare fraction with no %) -> 0 (floor of 0.5). Used for armor `Verses`
 * tables where each entry is a percentage of full damage.
 *
 * Returns `fallback` (default 0) for malformed input.
 */
export function parsePercentInt(raw: string, fallback = 0): number {
  let s = raw.trim();
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  const fx = tryParseDecimalToFx(s);
  if (fx === undefined) return fallback;
  // Floor the Q16.16 value to a whole integer (arithmetic shift, matches sim).
  return fx >> FRACT_BITS;
}
