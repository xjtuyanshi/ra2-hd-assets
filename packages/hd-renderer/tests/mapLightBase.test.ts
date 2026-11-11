import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { engineCellLight, engineLighting } from '../../ra2-assets/src/lights';
import { MapLightGrade } from '../src/ra2/mapLighting';
import {
  computeSceneMultipliers,
  LIGHT_BASE_STABLE_FRAMES,
  liveNormalLighting,
  NormalLightFollower,
  ra2DisplayPolicy,
  ra2SceneLighting,
  type Ra2SceneLighting,
} from '../src/ra2/sceneLighting';

/** A 6 x 1 strip; a RadSite-like green light source at its left end (B2 #7a). */
const grid = () => ({ width: 6, height: 1, z: new Uint8Array(6), exists: new Uint8Array(6).fill(1) });
const rad = [
  {
    position: [128, 128, 0] as [number, number, number],
    radius: 1200,
    intensity: 0.1,
    tint: [0, 0.3, 0] as [number, number, number],
  },
];
/** Stock day [Lighting] of the farm (XMP27T8) and our night edit's live normal light. */
const day = { ambient: 1, ground: 0, level: 0, red: 1, green: 1, blue: 1 };
const night = { ambient: 0.55, ground: 0, level: 0, red: 0.4, green: 0.4, blue: 0.7 };
const liveNight: Ra2SceneLighting = {
  ambient: 0.55,
  ground: 0,
  level: 0,
  tint: [0.4, 0.4, 0.7],
  override: null,
  event: null,
};
const texels = (g: MapLightGrade) => Array.from(g.texture.image.data as Uint8Array);

describe('map light grade follows the live normal light (B2 #7a)', () => {
  it('setBase gives the texels of a grade built with that light, light sources kept', () => {
    const grade = new MapLightGrade(grid(), day, rad);
    expect(grade.setBase(night)).toBe(true);
    const fresh = new MapLightGrade(grid(), night, rad);
    expect(texels(grade)).toEqual(texels(fresh));
    expect(grade.at(0, 0)).toEqual(fresh.at(0, 0));
    // The authored light stays available (white balance policy); the base is the live one.
    expect(grade.lighting).toEqual(engineLighting(day));
    expect(grade.base).toEqual(engineLighting(night));
    // The same light again (in any precision that stores as it) keeps the texels.
    expect(grade.setBase({ ...night, ambient: 0.551 })).toBe(false);
    // Light sources replaced later are lit on the live base too.
    grade.setSources([]);
    const plain = new MapLightGrade(grid(), night);
    expect(texels(grade)).toEqual(texels(plain));
    grade.dispose();
    fresh.dispose();
    plain.dispose();
  });

  it('adds the radiation to the live ambient like the engine instead of scaling it with the night', () => {
    const engine = engineCellLight(grid(), engineLighting(night), rad);
    const terrain = [0, 1, 2].map((k) => engine.intensity[0]! * engine.tint[k]!);
    const excess = (rgb: readonly number[]) => rgb[1]! - rgb[0]!;

    // Old path: the grade lit with the stock light, all of it scaled by live / stock.
    const stock = new MapLightGrade(grid(), day, rad);
    const k = ra2SceneLighting(stock.lighting, liveNight, 0, 0, stock.base)!.terrain;
    const scaled = stock.at(0, 0).terrain.map((v, i) => v * k[i]!);
    expect(excess(scaled) / excess(terrain)).toBeLessThan(0.6);

    // New path: the grade follows the live light and the scene multiplier is identity.
    const followed = new MapLightGrade(grid(), day, rad);
    followed.setBase(night);
    const presentation = ra2SceneLighting(followed.lighting, liveNight, 0, 0, followed.base)!;
    expect(presentation.terrain).toEqual([1, 1, 1]);
    expect(presentation.objects).toEqual([1, 1, 1]);
    followed.at(0, 0).terrain.forEach((v, i) => expect(v).toBeCloseTo(terrain[i]!, 6));
    expect(followed.at(0, 0).objects).toBeCloseTo(engine.level[0]!, 6);
    stock.dispose();
    followed.dispose();
  });

  it('keeps the display policy relative to the authored light, and scales events relative to the base', () => {
    const base = engineLighting(night);
    const presentation = ra2SceneLighting(day, liveNight, 0, 0, base)!;
    const authored = computeSceneMultipliers(day, liveNight, 0);
    expect(presentation.gradeShare).toEqual(ra2DisplayPolicy(authored.terrain).gradeShare);
    expect(presentation.darkLoss).toEqual(ra2DisplayPolicy(authored.terrain).darkLoss);
    expect(presentation.gradeShare).toBeLessThan(1);

    const storm: Ra2SceneLighting = { ...liveNight, ambient: 0.8, override: [0.9, 0.7, 0.7], event: 'storm' };
    const stormy = ra2SceneLighting(day, storm, 0, 0, base)!;
    expect(stormy.terrain).toEqual(computeSceneMultipliers(base, storm, 0).terrain);
    expect(stormy.objects).toEqual(computeSceneMultipliers(base, storm, 0).objects);
    // Without a base the behaviour is the authored one, unchanged.
    expect(ra2SceneLighting(day, storm, 0)).toEqual(ra2SceneLighting(day, storm, 0, 0, day));
  });

  it('takes only event-free live light, after it has held, from snapshot values', () => {
    expect(liveNormalLighting(liveNight)).toEqual(night);
    for (const event of ['storm', 'nuke', 'dominator', 'timewarp'] as const)
      expect(liveNormalLighting({ ...liveNight, event, override: [1, 1, 1] })).toBeNull();
    expect(liveNormalLighting({ ...liveNight, override: [1, 1, 1] })).toBeNull();
    expect(liveNormalLighting({ ...liveNight, ambient: NaN })).toBeNull();
    expect(liveNormalLighting(null)).toBeNull();

    const follower = new NormalLightFollower();
    expect(follower.update(liveNight, 100)).toBeNull();
    expect(follower.update(liveNight, 100 + LIGHT_BASE_STABLE_FRAMES - 1)).toBeNull();
    expect(follower.update(liveNight, 100 + LIGHT_BASE_STABLE_FRAMES)).toEqual(night);
    // A ramp that changes every few frames never settles.
    for (let f = 200; f < 260; f += 4) expect(follower.update({ ...liveNight, ambient: 0.3 + f / 1000 }, f)).toBeNull();
    // An event in between restarts the wait; so does a frame counter that went back.
    follower.update(liveNight, 300);
    follower.update({ ...liveNight, event: 'storm', override: [0.9, 0.7, 0.7] }, 305);
    expect(follower.update(liveNight, 316)).toBeNull();
    expect(follower.update(liveNight, 316 + LIGHT_BASE_STABLE_FRAMES)).toEqual(night);
    expect(follower.update(liveNight, 10)).toBeNull();
  });

  it('is wired into the live view with snapshot values', () => {
    const source = readFileSync(new URL('../src/live/liveView.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.update\(snapshot\.lighting, snapshot\.frame\)/);
    expect(source).toMatch(/mapLight\.setBase\(normal\)/);
    expect(source).toMatch(/mapLight\?\.base,?\s*\)/);
  });
});
