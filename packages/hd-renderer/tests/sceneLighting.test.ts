import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AtmosphereNodes } from '../src/atmosphere';
import type { MapLighting } from '../src/contract';
import {
  computeSceneMultipliers,
  ra2DisplayPolicy,
  ra2SceneLighting,
  SURFACE_565_LOSS,
  type Ra2SceneLighting,
} from '../src/ra2/sceneLighting';

import { resolveSceneLighting } from '../src/sceneLighting';

const map: MapLighting = { ambient: 1, ground: 0, level: 0, red: 1, green: 0.8, blue: 0.68 };
const clear: Ra2SceneLighting = { ambient: 1, ground: 0, level: 0, tint: [1, 0.8, 0.68], override: null, event: null };
const storm: Ra2SceneLighting = { ...clear, ambient: 0.87, override: [0.3, 0.4, 0.75], event: 'storm' };

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

  it('carries a live normal tint that differs from the authored map to terrain only', () => {
    // A day-built cache (1/1/1/1, no ground/level) under an edited night [Lighting]: 0.55 ambient, level 0.003,
    // RGB 0.40/0.40/0.70. Engine terrain = I x absolute RGB, objects = I alone.
    const day: MapLighting = { ambient: 1, ground: 0, level: 0, red: 1, green: 1, blue: 1 };
    const night: Ra2SceneLighting = {
      ambient: 0.55,
      ground: 0,
      level: 0.003,
      tint: [0.4, 0.4, 0.7],
      override: null,
      event: null,
    };
    const i = 0.55 + 0.003 * 4;
    const value = computeSceneMultipliers(day, night, 4);
    [i * 0.4, i * 0.4, i * 0.7].forEach((v, c) => expect(value.terrain[c]).toBeCloseTo(v, 12));
    value.objects.forEach((v) => expect(v).toBeCloseTo(i, 12));
    // A tinted authored map: the gain is live / authored per channel, so the grade's baked tint is replaced.
    const tinted: MapLighting = { ambient: 0.8, ground: 0, level: 0.028, red: 0.87, green: 1, blue: 1.1 };
    const k = computeSceneMultipliers(tinted, night, 4);
    const ratio = i / (0.8 + 0.028 * 4);
    [0.4 / 0.87, 0.4 / 1, 0.7 / 1.1].forEach((t, c) => expect(k.terrain[c]).toBeCloseTo(ratio * t, 12));
    // Only the tint differs: intensity stays, terrain channels follow the tint.
    expect(computeSceneMultipliers(map, { ...clear, tint: [0.5, 0.8, 0.68] }, 0)).toEqual({
      terrain: [0.5, 1, 1],
      objects: [1, 1, 1],
    });
    // Invalid tint keeps the authored light rather than inventing one.
    for (const tint of [
      [NaN, 1, 1],
      [-0.1, 1, 1],
    ] as [number, number, number][])
      expect(computeSceneMultipliers(map, { ...clear, ambient: 0.5, tint }, 0)).toEqual({
        terrain: [1, 1, 1],
        objects: [1, 1, 1],
      });
  });

  it('keeps the live tint largest channel under a palette event on a re-tinted map', () => {
    const day: MapLighting = { ambient: 1, ground: 0, level: 0, red: 1, green: 1, blue: 1 };
    const nightStorm: Ra2SceneLighting = {
      ambient: 0.87,
      ground: 0,
      level: 0,
      tint: [0.4, 0.4, 0.7],
      override: [0.3, 0.4, 0.75],
      event: 'storm',
    };
    const value = computeSceneMultipliers(day, nightStorm, 4);
    [0.3, 0.4, 0.75].forEach((v, c) => expect(value.terrain[c]).toBeCloseTo(0.87 * 0.7 * v, 12));
    [0.3, 0.4, 0.75].forEach((v, c) => expect(value.objects[c]).toBeCloseTo(0.87 * v, 12));
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

describe('adapter boundary and neutral scene presentation', () => {
  it('keeps event vocabulary and palette normalization out of the generic contract and renderer', () => {
    const contract = readFileSync(new URL('../src/sceneLighting.ts', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    const renderer = readFileSync(new URL('../src/HdRenderer.ts', import.meta.url), 'utf8');
    expect(contract).not.toMatch(
      /\b(?:MapLighting|ambient|ground|level|override|event|storm|nuke|dominator|timewarp)\b/,
    );
    expect(renderer).not.toMatch(/sceneLighting\?\.event|lighting\?\.event|computeSceneMultipliers|sceneMedianZ/);
    expect(renderer).not.toMatch(/from ['"]\.\/ra2\/sceneLighting['"]/);
  });

  it('translates all native event policies without changing raw snapshot/replay input', () => {
    for (const event of [null, 'storm', 'nuke', 'dominator', 'timewarp'] as const) {
      const input = { ...storm, event };
      const before = structuredClone(input);
      const presentation = ra2SceneLighting(map, input, 0, 0.8)!;
      const multipliers = computeSceneMultipliers(map, input, 0);
      expect(presentation).toEqual({
        ...multipliers,
        ...ra2DisplayPolicy(multipliers.terrain),
        sunShadow: event === 'storm' ? 0 : 1,
        overcast: event === 'storm' ? 1 : 0,
        skyFlash: event === 'storm' ? 0.12 : 0,
      });
      expect(input).toEqual(before);
      expect(Object.keys(presentation).sort()).toEqual([
        'darkLoss',
        'gradeShare',
        'objects',
        'overcast',
        'skyFlash',
        'sunShadow',
        'terrain',
      ]);
    }
    expect(ra2SceneLighting(map, null, 0)).toBeNull();
    expect(ra2SceneLighting(map, storm, 0, NaN)?.skyFlash).toBe(0);
  });

  it('protects numeric uniforms without applying a game-specific flash cap or mutating callers', () => {
    const input = {
      terrain: [2, 3, 4] as [number, number, number],
      objects: [0, 0.5, 6] as [number, number, number],
      sunShadow: 0.4,
      overcast: 0.35,
      skyFlash: 0.8,
    };
    const presentation = resolveSceneLighting(input);
    expect(presentation).toEqual({ ...input, gradeShare: 1, darkLoss: [0, 0, 0] });
    expect(presentation.terrain).not.toBe(input.terrain);
    expect(
      resolveSceneLighting({
        ...input,
        terrain: [1, NaN, 2],
        objects: [-1, 1, 1],
        sunShadow: NaN,
        overcast: Infinity,
        skyFlash: NaN,
      }),
    ).toEqual(resolveSceneLighting(null));
    expect(resolveSceneLighting({ ...input, sunShadow: -2, overcast: 4, skyFlash: -2 })).toMatchObject({
      sunShadow: 0,
      overcast: 1,
      skyFlash: 0,
    });
    expect(resolveSceneLighting({ ...input, gradeShare: 0.25, darkLoss: [0.01, 0, 2] })).toMatchObject({
      gradeShare: 0.25,
      darkLoss: [0.01, 0, 1],
    });
    expect(resolveSceneLighting({ ...input, gradeShare: NaN, darkLoss: [0.01, -1, 0] })).toMatchObject({
      gradeShare: 1,
      darkLoss: [0, 0, 0],
    });
    expect(resolveSceneLighting({ ...input, gradeShare: 3 }).gradeShare).toBe(1);
  });

  it('keeps the full grade and no surface loss in the authored light, including dark stock maps', () => {
    for (const ambient of [1, 0.65, 0.3]) {
      const presentation = ra2SceneLighting({ ...map, ambient }, { ...clear, ambient }, 4)!;
      expect(presentation.gradeShare).toBe(1);
      expect(presentation.darkLoss).toEqual([0, 0, 0]);
    }
    // A brighter scene than authored (a flash or a lit event) keeps the grade and adds no loss.
    expect(ra2DisplayPolicy([1.4, 1.2, 1])).toEqual({ gradeShare: 1, darkLoss: [0, 0, 0] });
    expect(ra2DisplayPolicy([NaN, 1, 1])).toEqual({ gradeShare: 1, darkLoss: [0, 0, 0] });
  });

  it('fades the grade and adds the 16-bit surface loss on a night [Lighting] edit of a day map', () => {
    // Round 9e #3: XMP27T8's day cache under the edited night (ambient 0.55, level 0.003, tint 0.4/0.4/0.7), z = 4.
    const day: MapLighting = { ambient: 1, ground: 0, level: 0, red: 1, green: 1, blue: 1 };
    const night: Ra2SceneLighting = { ...clear, ambient: 0.55, level: 0.003, tint: [0.4, 0.4, 0.7] };
    const presentation = ra2SceneLighting(day, night, 4)!;
    const terrain = [0.562 * 0.4, 0.562 * 0.4, 0.562 * 0.7];
    terrain.forEach((v, i) => expect(presentation.terrain[i]).toBeCloseTo(v, 12));
    expect(presentation.gradeShare).toBeCloseTo(0.2126 * terrain[0]! + 0.7152 * terrain[1]! + 0.0722 * terrain[2]!, 12);
    expect(presentation.gradeShare).toBeCloseTo(0.237, 3);
    terrain.forEach((v, i) => expect(presentation.darkLoss[i]).toBeCloseTo(SURFACE_565_LOSS[i]! * (1 - v), 12));
    // About 3.1 / 1.5 / 2.4 levels of 255.
    expect(presentation.darkLoss.map((v) => Math.round(v * 2550) / 10)).toEqual([3.1, 1.5, 2.4]);
  });

  it('fades the grade under a storm palette by the storm terrain level, the blue channel losing almost nothing', () => {
    const presentation = ra2SceneLighting(map, storm, 0)!;
    const t = presentation.terrain;
    expect(presentation.gradeShare).toBeCloseTo(0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2], 12);
    expect(presentation.gradeShare).toBeGreaterThan(0.4);
    expect(presentation.gradeShare).toBeLessThan(0.5);
    expect(presentation.darkLoss[2]).toBeLessThan(presentation.darkLoss[1]);
    expect(presentation.darkLoss[1]).toBeLessThan(presentation.darkLoss[0]);
  });
});
