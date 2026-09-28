import { describe, expect, it } from 'vitest';
import { parseDecimalToFx, parsePercentInt, tryParseDecimalToFx } from './decimal.js';

const ONE = 65536;

describe('parseDecimalToFx', () => {
  it('converts the documented BuildSpeed example 0.7 -> 45875 (floored)', () => {
    // 0.7 * 65536 = 45875.2, floored toward -Infinity -> 45875.
    expect(parseDecimalToFx('0.7')).toBe(45875);
  });

  it('handles whole integers exactly', () => {
    expect(parseDecimalToFx('0')).toBe(0);
    expect(parseDecimalToFx('1')).toBe(ONE);
    expect(parseDecimalToFx('2')).toBe(2 * ONE);
    expect(parseDecimalToFx('10')).toBe(10 * ONE);
  });

  it('handles exact binary fractions with no rounding', () => {
    expect(parseDecimalToFx('0.5')).toBe(ONE / 2);
    expect(parseDecimalToFx('0.25')).toBe(ONE / 4);
    expect(parseDecimalToFx('1.5')).toBe(ONE + ONE / 2);
    expect(parseDecimalToFx('2.25')).toBe(2 * ONE + ONE / 4);
  });

  it('floors positive non-terminating fractions toward -Infinity', () => {
    // 0.1 * 65536 = 6553.6 -> 6553
    expect(parseDecimalToFx('0.1')).toBe(6553);
    // 0.3 * 65536 = 19660.8 -> 19660
    expect(parseDecimalToFx('0.3')).toBe(19660);
  });

  it('floors negatives toward -Infinity (not toward zero)', () => {
    // -0.7 * 65536 = -45875.2 -> floor -> -45876
    expect(parseDecimalToFx('-0.7')).toBe(-45876);
    // -0.5 is exact -> -32768, no correction
    expect(parseDecimalToFx('-0.5')).toBe(-ONE / 2);
    // -2 exact
    expect(parseDecimalToFx('-2')).toBe(-2 * ONE);
    // -0.1 -> -(6553) - 1 = -6554
    expect(parseDecimalToFx('-0.1')).toBe(-6554);
  });

  it('accepts leading +, bare fraction, trailing dot, and whitespace', () => {
    expect(parseDecimalToFx('+1.5')).toBe(ONE + ONE / 2);
    expect(parseDecimalToFx('.5')).toBe(ONE / 2);
    expect(parseDecimalToFx('3.')).toBe(3 * ONE);
    expect(parseDecimalToFx('  0.25  ')).toBe(ONE / 4);
  });

  it('returns the fallback for malformed input', () => {
    expect(parseDecimalToFx('', -1)).toBe(-1);
    expect(parseDecimalToFx('abc', 7)).toBe(7);
    expect(parseDecimalToFx('.', 3)).toBe(3);
    expect(parseDecimalToFx('1.2.3', 9)).toBe(9);
    expect(parseDecimalToFx('+', 5)).toBe(5);
  });

  it('tryParseDecimalToFx distinguishes zero from garbage', () => {
    expect(tryParseDecimalToFx('0')).toBe(0);
    expect(tryParseDecimalToFx('0.0')).toBe(0);
    expect(tryParseDecimalToFx('garbage')).toBeUndefined();
    expect(tryParseDecimalToFx('')).toBeUndefined();
  });

  it('is exact for high-precision fractional strings (string arithmetic, not float)', () => {
    // 0.123456789 * 65536 = 8090.99... floor -> 8090. parseFloat could differ
    // in the last ulp on some engines; string math is deterministic.
    expect(parseDecimalToFx('0.123456789')).toBe(8090);
  });
});

describe('parsePercentInt', () => {
  it('accepts both % and bare forms', () => {
    expect(parsePercentInt('100%')).toBe(100);
    expect(parsePercentInt('100')).toBe(100);
    expect(parsePercentInt('60%')).toBe(60);
    expect(parsePercentInt('60')).toBe(60);
    expect(parsePercentInt('0%')).toBe(0);
  });

  it('floors fractional percents', () => {
    expect(parsePercentInt('62.5%')).toBe(62);
    expect(parsePercentInt('99.9%')).toBe(99);
  });

  it('handles values above 100 (armor can amplify damage)', () => {
    expect(parsePercentInt('150%')).toBe(150);
    expect(parsePercentInt('200')).toBe(200);
  });

  it('returns fallback for garbage', () => {
    expect(parsePercentInt('', 100)).toBe(100);
    expect(parsePercentInt('abc', 100)).toBe(100);
  });
});
