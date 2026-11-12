import { describe, expect, it } from 'vitest';
import { Color } from 'three/webgpu';
import { LOOK_PRESETS } from '../src/HdRenderer';
import { cinematicGradeRgb } from '../src/post';
import {
  CLEAR_WATER,
  CLEAR_LAYERS,
  CLEAR_SURFACE,
  clearDepth,
  clearPalette,
  clearTransmission,
} from '../src/ra2/clearWater';

describe('clear water optical policy', () => {
  it('deepens monotonically within the shallow band and drops steeply beside rocks', () => {
    const cells = CLEAR_WATER.depthCells;
    expect(cells).toBeLessThanOrEqual(2.5);
    expect(clearDepth(-1)).toBe(0);
    expect(clearDepth(0)).toBe(0);
    expect(clearDepth(cells / 2)).toBeCloseTo(0.5);
    expect(clearDepth(cells)).toBe(1);
    expect(clearDepth(10)).toBe(1);
    expect(clearDepth(0, 1)).toBeCloseTo(0.9);
    let previous = 0;
    for (let shore = 0; shore <= 6; shore += 0.1) {
      expect(clearDepth(shore)).toBeGreaterThanOrEqual(previous);
      previous = clearDepth(shore);
    }
  });
  it('keeps the bed at zero depth, absorbs red fastest and hides the deep bed', () => {
    expect(clearTransmission(0)).toEqual([1, 1, 1]);
    for (const depth of [0.1, 0.4, 1]) {
      const [r, g, b] = clearTransmission(depth) as [number, number, number];
      expect(r).toBeLessThan(g);
      expect(g).toBeLessThan(b);
      expect(b).toBeLessThan(1);
    }
    expect(Math.max(...clearTransmission(1))).toBeLessThan(0.07);
  });
  it('keeps every theatre teal-blue (not cobalt or grey) and its open water darker than the shallows', () => {
    const luma = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for (const theater of ['temperate', 'snow', 'desert', 'urban', 'newurban']) {
      const palette = clearPalette(theater);
      const deep = new Color(palette.deep),
        shallow = new Color(palette.shallow);
      expect(luma(deep)).toBeLessThan(luma(shallow) * 0.5);
      for (const colour of [deep, shallow]) {
        const srgb = colour.clone().convertLinearToSRGB();
        // Teal-blue: blue may lead green a little; cobalt has a strongly dominant blue channel, grey has no chroma.
        expect(srgb.b / srgb.g).toBeLessThan(1.35);
        expect(srgb.r).toBeLessThan(srgb.g);
        expect(1 - srgb.r / Math.max(srgb.g, srgb.b)).toBeGreaterThan(0.3);
      }
      // Graded under neutral light, the deep colour stays teal-blue (HSV hue 180-215 degrees) rather than cobalt.
      for (const exposure of [0.3, 1, 1.5]) {
        const graded = new Color(
          ...cinematicGradeRgb(
            [deep.r * exposure, deep.g * exposure, deep.b * exposure],
            LOOK_PRESETS.cinematic.settings,
          ),
        ).convertLinearToSRGB();
        const hsl = { h: 0, s: 0, l: 0 };
        graded.getHSL(hsl);
        expect(hsl.h * 360).toBeGreaterThan(180);
        expect(hsl.h * 360).toBeLessThan(215);
      }
    }
    expect(clearPalette('SNOW')).toEqual(clearPalette('snow'));
    expect(clearPalette('unknown')).toEqual(clearPalette('temperate'));
    expect(clearPalette('snow')).not.toEqual(clearPalette('desert'));
    expect(clearPalette('urban')).toEqual(clearPalette('newurban'));
  });
  it('keeps A at its approved physical scale, scroll directions and comfort clock', () => {
    expect(CLEAR_SURFACE.timeScale).toBe(0.8);
    expect(CLEAR_SURFACE.normalGain).toBe(1.5);
    expect(CLEAR_SURFACE.tileMetres / CLEAR_SURFACE.metresPerCell).toBe(3.25);
    expect(CLEAR_SURFACE.tileMetres / 9 / CLEAR_SURFACE.metresPerCell).toBeCloseTo(0.3611, 4);
    expect(CLEAR_LAYERS).toEqual([
      [103, 103, 1 / 17, 1 / 29],
      [107, 107, 1 / 19, -1 / 31],
      [8907, 9803, 1 / 101, 1 / 97],
      [1091, 1027, -1 / 109, 1 / 113],
    ]);
    expect(CLEAR_WATER.shininess).toBe(900);
    expect(CLEAR_WATER.sparkle).toBe(5);
    expect(CLEAR_WATER.whitecap).toBeLessThanOrEqual(0.15);
  });
});
