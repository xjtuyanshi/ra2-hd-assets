/** HD renderer: the map's [Lighting] and light sources as the engine applies them by day (per-cell light texture). */
import { describe, expect, it } from 'vitest';
import { MapLightGrade } from '../../packages/hd-renderer/src/ra2/mapLighting';

const grid = (width: number, height: number, z = 0) => ({
  width,
  height,
  z: new Uint8Array(width * height).fill(z),
  exists: new Uint8Array(width * height).fill(1),
});

describe('MapLightGrade', () => {
  it('lights terrain by level x tint and objects by the level only', () => {
    // XMP29U2 "The Alamo": a warm day map without a height term.
    const alamo = new MapLightGrade(grid(4, 4, 2), { ambient: 1, red: 1, green: 0.8, blue: 0.68, ground: 0, level: 0 });
    const cell = alamo.at(1, 2);
    [1, 0.8, 0.68].forEach((v, i) => expect(cell.terrain[i]).toBeCloseTo(v, 5));
    expect(cell.objects).toBeCloseTo(1, 5);
    // RiverRam at height 4 (Ground is not zero): 900 - 50 + 8 * 4 per-mille, like mapLightMultipliers in ra2-assets.
    const river = new MapLightGrade(grid(2, 2, 4), {
      ambient: 0.9,
      red: 1,
      green: 0.9,
      blue: 0.9,
      ground: 0.05,
      level: 0.008,
    });
    expect(river.at(0, 0).objects).toBeCloseTo(0.882, 5);
    expect(river.at(0, 0).terrain[1]).toBeCloseTo(0.882 * 0.9, 5);
  });

  it('adds light sources with the engine falloff and follows their changes', () => {
    const lighting = { ambient: 1, red: 1, green: 0.8, blue: 0.68, ground: 0, level: 0 };
    // An INGALITE post centred on cell (5, 5): LightVisibility 4000, LightIntensity 0.5, tint 0.05/0.05/0.01.
    const lamp = {
      position: [5 * 256 + 128, 5 * 256 + 128, 0] as [number, number, number],
      radius: 4000,
      intensity: 0.5,
      tint: [0.05, 0.05, 0.01] as [number, number, number],
    };
    const grade = new MapLightGrade(grid(40, 40), lighting, [lamp]);
    // At the post: I = 1.5, R/G/B = 1.05/0.85/0.69, normalised by 1.05 -> intensity 1.575.
    expect(grade.at(5, 5).objects).toBeCloseTo(1.575, 5);
    expect(grade.at(5, 5).terrain[0]).toBeCloseTo(1.575, 5);
    expect(grade.at(5, 5).terrain[2]).toBeCloseTo(1.5 * 0.69, 5);
    // Ten cells away (2560 leptons) the light fades linearly: f = floor(1000 * (4000 - 2560) / 4000) = 360, so
    // I = 1.18 and R = 1.018: intensity 1.18 * 1.018.
    expect(grade.at(15, 5).objects).toBeCloseTo(1.18 * 1.018, 5);
    // Out of reach the plain map light remains.
    expect(grade.at(35, 35).objects).toBeCloseTo(1, 5);
    grade.setSources([]);
    expect(grade.at(5, 5).objects).toBeCloseTo(1, 5);
    // Texels store the terrain multiplier / 2 in 8 bits (opaque alpha); objects read the largest channel.
    const data = grade.texture.image.data as Uint8Array;
    expect(Array.from(data.subarray(0, 4))).toEqual([128, 102, 87, 255]);
  });
});

describe('MapLightGrade weight', () => {
  it('bakes the weight into the texels: 1 is the engine light, 0 neutral', () => {
    const grade = new MapLightGrade(grid(3, 2), { ambient: 1, red: 1, green: 0.8, blue: 0.68, ground: 0, level: 0 });
    const data = grade.texture.image.data as Uint8Array;
    expect(Array.from(data.subarray(0, 3))).toEqual([128, 102, 87]);
    grade.setWeight(0);
    expect(Array.from(data.subarray(0, 3))).toEqual([128, 128, 128]);
    grade.setWeight(0.5);
    expect(Array.from(data.subarray(0, 3))).toEqual([128, 115, 107]);
    expect(grade.currentWeight).toBe(0.5);
    // The diagnostics report the engine's own (unweighted) light.
    expect(grade.at(0, 0).terrain[1]).toBeCloseTo(0.8, 5);
  });
});
