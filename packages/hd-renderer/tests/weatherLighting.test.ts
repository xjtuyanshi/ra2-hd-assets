import { Color } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Lighting } from '../src/lighting';

const luminance = (colour: Color) => 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
const snapshot = (lighting: Lighting) => ({
  sun: lighting.sun.color.toArray(),
  sunIntensity: lighting.sun.intensity,
  hemi: lighting.hemi.color.toArray(),
  hemiIntensity: lighting.hemi.intensity,
  skyZenith: lighting.state.skyZenith.toArray(),
  skyHorizon: lighting.state.skyHorizon.toArray(),
  ambient: lighting.state.ambient.toArray(),
  night: lighting.state.night,
  exposure: lighting.state.exposure,
});

describe('optional weather daylight dimming cap', () => {
  it('keeps the original two-argument clear, rain and storm values bit-identical', () => {
    const lighting = new Lighting(20, 20);
    // Baseline values from the pre-cap legacy curve; include the public state used by renderer uniforms.
    const baseline = [
      {
        hour: 8,
        overcast: 0,
        values: {
          sun: [1, 0.86, 0.7],
          sunIntensity: 2.6,
          hemi: [0.6, 0.72, 0.9],
          hemiIntensity: 0.9,
          skyZenith: [0.25, 0.45, 0.8],
          skyHorizon: [0.75, 0.82, 0.9],
          ambient: [0.27, 0.324, 0.405],
          night: 0,
          exposure: 1,
        },
      },
      {
        hour: 12,
        overcast: 0.75,
        values: {
          sun: [0.76375, 0.76525, 0.7625000000000001],
          sunIntensity: 1.88,
          hemi: [0.59375, 0.68625, 0.8262499999999999],
          hemiIntensity: 1.1125,
          skyZenith: [0.24500000000000002, 0.34199999999999997, 0.5139999999999999],
          skyHorizon: [0.61, 0.6679999999999999, 0.74],
          ambient: [0.3302734375, 0.38172656250000003, 0.4596015625],
          night: 0,
          exposure: 1,
        },
      },
      {
        hour: 22,
        overcast: 0.85,
        values: {
          sun: [0.52975, 0.5962, 0.7739],
          sunIntensity: 0.31949999999999995,
          hemi: [0.32575, 0.373, 0.505],
          hemiIntensity: 1.0711249999999999,
          skyZenith: [0.19020000000000004, 0.202, 0.22360000000000002],
          skyHorizon: [0.38360000000000005, 0.41039999999999993, 0.4536],
          ambient: [0.17445948437499997, 0.19976481249999997, 0.27045906249999996],
          night: 1,
          exposure: 1.75,
        },
      },
    ];
    for (const { hour, overcast, values } of baseline) {
      lighting.update(hour, overcast);
      expect(snapshot(lighting)).toEqual(values);
    }
  });

  it.each([8, 12, 16])('keeps snow within six percent of clear flat-ground light at %s:00', (hour) => {
    const capped = new Lighting(20, 20);
    capped.update(hour, 0);
    const clear = luminance(capped.flatIrradianceColor(new Color()));
    capped.update(hour, 0.65, 0.06);
    const snowy = luminance(capped.flatIrradianceColor(new Color()));
    expect(snowy / clear).toBeGreaterThanOrEqual(0.94 - 1e-12);
    expect(snowy / clear).toBeLessThanOrEqual(1);

    const legacy = new Lighting(20, 20);
    legacy.update(hour, 0.65);
    expect(capped.hemi.intensity).toBeGreaterThan(legacy.hemi.intensity);
    // Only the diffuse sky's intensity changes: retain the overcast colours, direct sun and exposure.
    expect(capped.sun.color.toArray()).toEqual(legacy.sun.color.toArray());
    expect(capped.sun.intensity).toBe(legacy.sun.intensity);
    expect(capped.hemi.color.toArray()).toEqual(legacy.hemi.color.toArray());
    expect(capped.state.skyZenith.toArray()).toEqual(legacy.state.skyZenith.toArray());
    expect(capped.state.skyHorizon.toArray()).toEqual(legacy.state.skyHorizon.toArray());
    expect(capped.state.exposure).toBe(legacy.state.exposure);
    expect(capped.state.ambient.toArray()).toEqual(
      capped.hemi.color
        .clone()
        .multiplyScalar(capped.hemi.intensity * 0.5)
        .toArray(),
    );
  });

  it('does not alter clear weather, full night or profiled map lighting', () => {
    const capped = new Lighting(20, 20);
    const legacy = new Lighting(20, 20);
    for (const [hour, overcast] of [
      [12, 0],
      [0, 0.65],
      [22, 0.65],
    ]) {
      capped.update(hour!, overcast!, 0.06);
      legacy.update(hour!, overcast!);
      expect(snapshot(capped)).toEqual(snapshot(legacy));
    }
    for (const lighting of [capped, legacy])
      lighting.setProfile({ kind: 'day', hour: 12, nightLevel: 0.3, tint: [1, 1, 1] });
    capped.update(12, 0.65, 0.06);
    legacy.update(12, 0.65);
    expect(snapshot(capped)).toEqual(snapshot(legacy));
  });

  it('does not retain the optional cap after switching back to the two-argument weather path', () => {
    const switched = new Lighting(20, 20);
    const legacy = new Lighting(20, 20);
    switched.update(12, 0.65, 0.06);
    for (const overcast of [0.75, 0, 0.85]) {
      switched.update(12, overcast);
      legacy.update(12, overcast);
      expect(snapshot(switched)).toEqual(snapshot(legacy));
    }
  });
});
