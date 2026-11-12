import { describe, expect, it } from 'vitest';
import { Color } from 'three/webgpu';
import { LOOK_PRESETS } from '../src/HdRenderer';
import { cinematicGradeRgb } from '../src/post';
import { CLEAR_LAYERS, CLEAR_WATER, clearDepth, clearPalette, clearTransmission } from '../src/ra2/clearWater';

describe('clear water optical policy', () => {
  it('deepens monotonically over five cells and drops steeply beside rocks', () => {
    expect(clearDepth(-1)).toBe(0);
    expect(clearDepth(0)).toBe(0);
    expect(clearDepth(2.5)).toBeCloseTo(0.5);
    expect(clearDepth(5)).toBe(1);
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
  it('reserves open-water saturation headroom in every theatre through the cinematic grade under neutral lighting', () => {
    const palettes = ['temperate', 'snow', 'desert', 'urban', 'newurban'].map(clearPalette);
    for (const palette of palettes) {
      // Test the actual linear palette, absorption and compensation together over a neutral bed.
      for (const depth of [0.4, 0.6, 0.8, 1]) {
        const shallow = new Color(palette.shallow),
          deep = new Color(palette.deep),
          bed = new Color(palette.bed);
        const column = shallow.lerp(deep, depth);
        const transmission = clearTransmission(depth);
        const body = [bed.r, bed.g, bed.b].map(
          (v, i) =>
            (v * transmission[i]! + [column.r, column.g, column.b][i]! * (1 - transmission[i]!)) * [1.1, 1, 0.88][i]!,
        );
        const floor = Math.max(...body) * 0.38;
        const shown = new Color(
          ...(body.map((v) => Math.max(v, floor)) as [number, number, number]),
        ).convertLinearToSRGB();
        const channels = [shown.r, shown.g, shown.b];
        expect(1 - Math.min(...channels) / Math.max(...channels)).toBeLessThan(CLEAR_WATER.saturationTarget);
        // Exercise the actual cinematic grade, over neutral-light exposure variations, without claiming GPU pixels.
        for (const exposure of [0.3, 0.6, 1, 1.5]) {
          const compensated = body.map((v) => Math.max(v, floor) * exposure) as [number, number, number];
          const graded = new Color(
            ...cinematicGradeRgb(compensated, LOOK_PRESETS.cinematic.settings),
          ).convertLinearToSRGB();
          const rgb = [graded.r, graded.g, graded.b];
          expect(1 - Math.min(...rgb) / Math.max(...rgb)).toBeLessThan(CLEAR_WATER.saturationTarget);
          // Teal/grey-blue stays close to green; cobalt has a strongly dominant blue channel.
          expect(graded.b / graded.g).toBeLessThan(1.2);
        }
      }
    }
    expect(clearPalette('SNOW')).toEqual(clearPalette('snow'));
    expect(clearPalette('unknown')).toEqual(clearPalette('temperate'));
    expect(clearPalette('snow')).not.toEqual(clearPalette('desert'));
    expect(clearPalette('urban')).toEqual(clearPalette('newurban'));
  });
  it('balances the two dominant normal-map axes and limits the finest octave', () => {
    const [a, b, fine] = CLEAR_LAYERS;
    expect(b[0] - a[0]).toBeCloseTo(Math.PI / 2);
    expect(a[3]).toBe(b[3]);
    expect(fine[3] ** 2 / CLEAR_LAYERS.reduce((sum, layer) => sum + layer[3] ** 2, 0)).toBeLessThan(0.04);
  });
});
