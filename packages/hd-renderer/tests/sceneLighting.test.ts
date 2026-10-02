import { describe, expect, it } from 'vitest';
import { AtmosphereNodes } from '../src/atmosphere';
import type { MapLighting } from '../src/contract';
import { computeSceneMultipliers, type SceneLighting } from '../src/sceneLighting';

const map: MapLighting = { ambient: 1, ground: 0, level: 0, red: 1, green: 0.8, blue: 0.68 };
const clear: SceneLighting = { ambient: 1, ground: 0, level: 0, tint: [1, 0.8, 0.68], override: null, event: null };
const storm: SceneLighting = { ...clear, ambient: 0.87, override: [0.3, 0.4, 0.75], event: 'storm' };

describe('scene lighting replacement', () => {
  it('matches the measured terrain and object palette ratios independently', () => {
    const value = computeSceneMultipliers(map, storm, 0);
    [0.261, 0.435, (0.87 * 0.75) / 0.68].forEach((v, i) => expect(value.terrain[i]).toBeCloseTo(v, 12));
    [0.261, 0.348, 0.6525].forEach((v, i) => expect(value.objects[i]).toBeCloseTo(v, 12));
  });

  it('evaluates the authored and current ground/level at the same median height', () => {
    const elevated = { ...map, ambient: 0.8, ground: 0.05, level: 0.008 };
    const live = { ...storm, ground: 0.02, level: 0.004 };
    const ratio = (0.87 + 0.004 * 4 - 0.02) / (0.8 + 0.008 * 4 - 0.05);
    const value = computeSceneMultipliers(elevated, live, 4);
    expect(value.objects[0]).toBeCloseTo(ratio * 0.3, 12);
    expect(value.terrain[1]).toBeCloseTo((ratio * 0.4) / 0.8, 12);
  });

  it('returns exact identity when absent or equal to the authored day, dusk or night map', () => {
    const one = { terrain: [1, 1, 1], objects: [1, 1, 1] };
    expect(computeSceneMultipliers(map, null, 4)).toEqual(one);
    expect(computeSceneMultipliers(null, storm, 4)).toEqual(one);
    for (const ambient of [1, 0.65, 0.3, 0]) {
      expect(computeSceneMultipliers({ ...map, ambient }, { ...clear, ambient }, 4)).toEqual(one);
    }
  });

  it('keeps ordinary ambient transitions and prevents negative or invalid gains', () => {
    expect(computeSceneMultipliers(map, { ...clear, ambient: 0.8 }, 0)).toEqual({
      terrain: [0.8, 0.8, 0.8],
      objects: [0.8, 0.8, 0.8],
    });
    expect(computeSceneMultipliers(map, { ...clear, ground: 2 }, 0)).toEqual({
      terrain: [0, 0, 0],
      objects: [0, 0, 0],
    });
    expect(computeSceneMultipliers(map, { ...storm, ambient: NaN }, 0)).toEqual({
      terrain: [1, 1, 1],
      objects: [1, 1, 1],
    });
  });

  it('owns independent neutral uniforms and copies event state into pre-world layers', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    expect(a.sceneTerrainMul.value.toArray()).toEqual([1, 1, 1]);
    expect(a.sceneObjectMul.value.toArray()).toEqual([1, 1, 1]);
    expect(a.sceneSunShadow.value).toBe(1);
    a.sceneTerrainMul.value.fromArray([0.261, 0.435, 0.96]);
    a.sceneObjectMul.value.fromArray([0.261, 0.348, 0.6525]);
    a.sceneSunShadow.value = 0;
    expect(b.sceneTerrainMul.value.toArray()).toEqual([1, 1, 1]);
    b.copyValuesFrom(a);
    expect(b.sceneTerrainMul.value.toArray()).toEqual(a.sceneTerrainMul.value.toArray());
    expect(b.sceneObjectMul.value.toArray()).toEqual(a.sceneObjectMul.value.toArray());
    expect(b.sceneSunShadow.value).toBe(0);
    a.dispose();
    b.dispose();
  });
});
