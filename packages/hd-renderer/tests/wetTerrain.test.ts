import { describe, expect, it } from 'vitest';
import { WET_GROUND_LOOK, wetGroundResponse } from '../src/ra2/terrain';

const dayLuminance = (response: ReturnType<typeof wetGroundResponse>) => response.diffuse * (1 + response.daySkyGain);

describe('original-map wet terrain analytical response', () => {
  it('keeps the dry albedo, roughness and lack of reflections, including the zero-footprint mask', () => {
    const dry = { diffuse: 1, puddle: 0, roughness: 0.95, gloss: 0, daySkyGain: 0 };
    for (const night of [0, 0.5, 1]) {
      for (const paved of [0, 0.5, 1]) {
        expect(wetGroundResponse(0, paved, 1, night)).toEqual(dry);
        expect(wetGroundResponse(1, paved, 1, night, 0)).toEqual(dry);
      }
    }
  });

  it('darkens soft ground by 8-10 percent at heavy rain wetness without puddles or reflected sky', () => {
    for (const wet of [0.8, 1]) {
      const soil = wetGroundResponse(wet, 0, 1);
      expect(soil.diffuse).toBeGreaterThanOrEqual(0.88);
      expect(soil.diffuse).toBeLessThanOrEqual(0.92);
      expect(soil.puddle).toBe(0);
      expect(soil.daySkyGain).toBe(0);
      expect(soil.gloss).toBe(0);
    }
  });

  it('makes wet pavement darker and glossier while retaining a 0.20 reflected sky weight', () => {
    expect(WET_GROUND_LOOK.skyFresnel).toBeGreaterThanOrEqual(0.15);
    expect(WET_GROUND_LOOK.skyFresnel).toBeLessThanOrEqual(0.25);
    const dry = wetGroundResponse(0, 1, 0);
    for (const wet of [0.8, 1]) {
      const paved = wetGroundResponse(wet, 1, 0);
      expect(dayLuminance(paved)).toBeGreaterThanOrEqual(0.9 - Number.EPSILON);
      expect(dayLuminance(paved)).toBeLessThanOrEqual(0.93);
      expect(paved.roughness).toBeLessThan(dry.roughness / 2);
      expect(paved.gloss).toBe(wet);
      expect(paved.daySkyGain).toBeGreaterThan(0);
    }
  });

  it('raises heavy-rain puddles 11.2-14 percent above surrounding wet asphalt instead of darkening them', () => {
    for (const wet of [0.8, 1]) {
      const asphalt = wetGroundResponse(wet, 1, 0);
      const puddle = wetGroundResponse(wet, 1, 1);
      const ratio = dayLuminance(puddle) / dayLuminance(asphalt);
      expect(ratio).toBeGreaterThanOrEqual(1.08);
      expect(ratio).toBeLessThanOrEqual(1.2);
      // The positive expanding-ring highlight cannot turn a puddle into a dark spot or exceed the requested lift.
      expect(ratio + WET_GROUND_LOOK.rippleLift * wet).toBeLessThanOrEqual(1.2);
      expect(puddle.roughness).toBeLessThan(asphalt.roughness);
      expect(puddle.diffuse).toBe(asphalt.diffuse);
    }
  });

  it('retains the established night diffuse and roughness response', () => {
    const soil = wetGroundResponse(1, 0, 1, 1);
    expect(soil.diffuse).toBe(0.93);
    expect(soil.roughness).toBe(0.7);
    const pavement = wetGroundResponse(1, 1, 0, 1);
    expect(pavement.diffuse).toBe(0.76);
    expect(pavement.roughness).toBeCloseTo(0.45);
    const puddle = wetGroundResponse(1, 1, 1, 1);
    expect(puddle.diffuse).toBeCloseTo(0.76 * 0.6);
    expect(puddle.roughness).toBeCloseTo(0.1);
    expect(puddle.daySkyGain).toBe(0);
  });
});
