import { createHash } from 'node:crypto';
import { Color, Mesh } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScenario } from '../sandbox/scenario';
import {
  applyLookPreset,
  dressingLightGain,
  DUSK_EXPOSURE,
  GRADE_NIGHT_START,
  gradeNight,
  HdRenderer,
  mapPresentation,
  tintWarmth,
} from '../src/HdRenderer';
import type { AtmosphereProfile, MapLighting, Weather } from '../src/contract';
import { Lighting } from '../src/lighting';
import type { LightField } from '../src/lightField';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { MapLights, type SourceLight } from '../src/ra2/mapLights';
import { computeSceneMultipliers, ra2SceneLighting, type Ra2SceneLighting } from '../src/ra2/sceneLighting';
import { buildTerrain } from '../src/terrain';
import { buildWater } from '../src/water';
import { buildRain, buildSnow } from '../src/weather';
import { WeatherGroundMask } from '../src/weatherGroundMask';

const dusk: AtmosphereProfile = { kind: 'dusk', hour: 18.2, nightLevel: 0.3, tint: [1, 0.92, 0.8] };
const duskMap: MapLighting = { ambient: 0.73, red: 1, green: 0.92, blue: 0.8, level: 0.035, ground: 0 };
const grid = { width: 2, height: 2, exists: new Uint8Array(4).fill(1), z: new Uint8Array(4).fill(6) };
const weatherAt = (weather: 'clear' | 'rain' | 'snow') =>
  weather === 'clear' ? undefined : { kind: weather, intensity: 0.8 };
const overcastAt = (weather: 'clear' | 'rain' | 'snow') => (weather === 'clear' ? 0 : weather === 'rain' ? 0.75 : 0.58);

function snapshot(l: Lighting) {
  return {
    sun: l.sun.color.toArray(),
    sunIntensity: l.sun.intensity,
    hemi: l.hemi.color.toArray(),
    hemiGround: l.hemi.groundColor.toArray(),
    hemiIntensity: l.hemi.intensity,
    direction: l.state.sunDirection.toArray(),
    keyElevation: l.state.keyElevation,
    skyZenith: l.state.skyZenith.toArray(),
    skyHorizon: l.state.skyHorizon.toArray(),
    ambient: l.state.ambient.toArray(),
    night: l.state.night,
    exposure: l.state.exposure,
    weatherSunShare: l.state.weatherSunShare,
    weatherBrightness: l.state.weatherBrightness,
    flat: l.flatIrradianceColor(new Color()).toArray(),
    clearFlat: l.clearFlatIrradianceColor(new Color()).toArray(),
  };
}

const expectRgb = (actual: readonly number[], expected: readonly number[]) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 13));

describe('scene-only overcast', () => {
  for (const kind of ['day', 'dusk', 'night'] as const) {
    for (const weather of ['clear', 'rain', 'snow'] as const) {
      it.each([false, true])(`preserves ${kind} ${weather} flat RGB and authored metadata, arc = %s`, (arc) => {
        const l = new Lighting(20, 20);
        l.sunArc = arc;
        const hour = kind === 'dusk' ? 18.2 : kind === 'day' ? 16.5 : 22;
        l.setProfile({ ...dusk, kind, hour });
        const update = () =>
          l.update(hour, overcastAt(weather), weather === 'snow' ? 0.06 : undefined, weatherAt(weather));
        update();
        const before = snapshot(l);
        for (const amount of [0.4, 1]) {
          update();
          l.applySceneOvercast(amount);
          const after = snapshot(l);
          expectRgb(after.flat, before.flat);
          expect(after.sunIntensity).toBeCloseTo(before.sunIntensity * (1 - amount), 13);
          expect(after.sun).toEqual(before.sun);
          expect(after.clearFlat).toEqual(before.clearFlat);
          expect(after.direction).toEqual(before.direction);
          expect(after.skyZenith).toEqual(before.skyZenith);
          expect(after.skyHorizon).toEqual(before.skyHorizon);
          expect(after.hemiGround).toEqual(before.hemiGround);
          expect(after.night).toBe(before.night);
          expect(after.exposure).toBe(before.exposure);
          expect(after.weatherSunShare).toBe(before.weatherSunShare);
          expect(after.weatherBrightness).toBe(before.weatherBrightness);
        }
        update();
        expect(snapshot(l)).toEqual(before);
        l.applySceneOvercast(0);
        expect(snapshot(l)).toEqual(before);
      });
    }
  }
});

describe('authored dusk staging', () => {
  it.each([false, true])('keeps noon-calibrated flat light with a warm low sun and cooler sky, arc = %s', (arc) => {
    const l = new Lighting(20, 20);
    l.sunArc = arc;
    l.setProfile(dusk);
    l.update(dusk.hour, 0);
    const noon = new Lighting(20, 20);
    noon.update(12, 0);
    expectRgb(l.flatIrradianceColor(new Color()).toArray(), noon.flatIrradianceColor(new Color()).toArray());
    expect(l.state.night).toBe(0);
    expect(l.nightAt(dusk.hour)).toBe(0);
    expect(l.state.keyElevation).toBe(10);
    expect(l.state.sunDirection.y).toBeLessThan(0.18);
    expect(l.sun.color.r).toBeGreaterThan(l.sun.color.g);
    expect(l.sun.color.g).toBeGreaterThan(l.sun.color.b);
    expect(l.hemi.color.b / l.hemi.color.r).toBeGreaterThan(1);
    expect(l.hemi.color.b / l.hemi.color.r).toBeGreaterThan(l.sun.color.b / l.sun.color.r);
    l.setProfile({ ...dusk, hour: 19 });
    l.update(19, 0);
    expect(l.state.keyElevation).toBe(10);
    expect(l.nightAt(19)).toBe(0);
  });

  it('keeps all engine source light and disables the three adaptations without mutating look settings', () => {
    const settings = { adaptExposure: 0.85, whiteAdapt: 0.85, mapTintAdapt: 0.3, mapSourcesByDay: 0.2 };
    expect(mapPresentation('dusk', 0, settings)).toEqual({
      exposureScale: DUSK_EXPOSURE,
      mapWeight: 1,
      sourceWeight: 1,
      adaptExposure: 0,
      whiteAdapt: 0,
      mapTintAdapt: 0,
    });
    // Day and night maps share one path: a night map is a day map with night dressing, and the engine grade is the
    // map on both. The moonlit presentation replaces the grade only past GRADE_NIGHT_START of an hour forced to night.
    for (const kind of ['day', 'night'] as const) {
      for (const [night, mapWeight] of [
        [0, 1],
        [0.0666, 1],
        [GRADE_NIGHT_START, 1],
        [0.29304, 1 - (0.29304 - GRADE_NIGHT_START) / (1 - GRADE_NIGHT_START)],
        [1, 0],
      ] as const) {
        const presentation = mapPresentation(kind, night, settings);
        expect(presentation.mapWeight).toBeCloseTo(mapWeight, 12);
        expect({ ...presentation, mapWeight: 0 }).toEqual({
          exposureScale: 1,
          mapWeight: 0,
          sourceWeight: 0.2,
          adaptExposure: 0.85,
          whiteAdapt: 0.85,
          mapTintAdapt: 0.3,
        });
      }
    }
    // Without a map (the procedural sandbox) there is no grade.
    expect(mapPresentation(undefined, 0, settings).mapWeight).toBe(0);
    expect(settings).toEqual({ adaptExposure: 0.85, whiteAdapt: 0.85, mapTintAdapt: 0.3, mapSourcesByDay: 0.2 });
  });

  it('keeps the grade whole at a look hour whose keys already carry a little night', () => {
    // The look presets stage day maps at 16.5, between the 16:00 (night 0) and 18:30 (night 1/3) keys.
    const l = new Lighting(20, 20);
    l.setProfile({ kind: 'day', hour: 12, nightLevel: 0.3, tint: [1, 1, 1] });
    l.update(16.5, 0);
    expect(l.state.night).toBeCloseTo(0.2 * 0.333, 12);
    expect(gradeNight(l.state.night)).toBe(0);
    expect(gradeNight(0)).toBe(0);
    expect(gradeNight(GRADE_NIGHT_START)).toBe(0);
    expect(gradeNight(0.55)).toBeCloseTo(0.5, 12);
    expect(gradeNight(1)).toBe(1);
    expect(gradeNight(2)).toBe(1);
  });

  it('neutralises a warm [Lighting] tint only: a cool tint keeps the game colours', () => {
    // XMP29U2: the approved look takes part of its warm cast out.
    expect(tintWarmth({ red: 1, green: 0.8, blue: 0.68 })).toBe(1);
    // XDeadman, XMP13S4, Transylv: neutralising a blue tint would warm the picture beyond the game's.
    expect(tintWarmth({ red: 0.68, green: 0.68, blue: 1 })).toBe(0);
    expect(tintWarmth({ red: 0.75, green: 0.75, blue: 1.2 })).toBe(0);
    expect(tintWarmth({ red: 0.9, green: 0.9, blue: 1 })).toBe(0);
    expect(tintWarmth({ red: 1, green: 1, blue: 1 })).toBe(0);
    // Fades in over 0.15 of the largest channel.
    expect(tintWarmth({ red: 1, green: 1, blue: 0.925 })).toBeCloseTo(0.5, 12);
    expect(tintWarmth({ red: 1, green: 0.95, blue: 0.85 })).toBeCloseTo(1, 12);
    expect(tintWarmth({ red: 0, green: 0, blue: 0 })).toBe(0);
  });

  it('keeps source deltas in the engine grade and defers the separate irradiance field until night', () => {
    const source: SourceLight = {
      type: 'synthetic-lamp',
      cell: [0, 0],
      z: 6,
      foundation: [1, 1],
      invisible: true,
      position: [128, 128, 624],
      radius: 768,
      intensity: 0.15,
      tint: [0, 0, 0],
    };
    const plain = new MapLightGrade(grid, duskMap);
    const grade = new MapLightGrade(grid, duskMap, [source]);
    try {
      expect(grade.currentWeight).toBe(1);
      expect(grade.at(0, 0).objects).toBeGreaterThan(plain.at(0, 0).objects);
      const setBase = vi.fn();
      const mapLights = new MapLights(grid, duskMap, 6);
      mapLights.setSources([source]);
      mapLights.update({ setBase } as unknown as LightField, dusk, 3, true);
      expect(setBase).toHaveBeenCalledWith(expect.any(Float32Array), 3, true);
    } finally {
      grade.dispose();
      plain.dispose();
    }
  });

  it('keeps the pre-fix day light/uniform matrix bit-identical', () => {
    // SHA-256 of the complete numeric snapshots from the pre-fix lighting.ts, for 48 combinations.
    // Pin the old renderer's output, rather than deriving an expected value from the changed implementation.
    // (The night profile had its own pinned matrix until night maps became day maps with night dressing; the suite
    // "night maps: day keys with night dressing" below compares their light with this day matrix hour by hour.)
    const baseline = '0ee1adfdb7a59247c0dac0a44d70c68ce5ab897d2fb077ebf85fab88f2e6be32';
    const states = [];
    for (const arc of [false, true]) {
      for (const hour of [0, 5.5, 8, 12, 16.5, 18.2, 21, 22]) {
        for (const weather of ['clear', 'rain', 'snow'] as const) {
          const l = new Lighting(20, 20);
          l.sunArc = arc;
          l.setProfile({ kind: 'day', hour: 16.5, nightLevel: 0.3, tint: [1, 0.92, 0.8] });
          l.update(hour, overcastAt(weather), weather === 'snow' ? 0.06 : undefined, weatherAt(weather));
          states.push(snapshot(l));
        }
      }
    }
    expect(createHash('sha256').update(JSON.stringify(states)).digest('hex')).toBe(baseline);
  });
});

/** Execute the real CPU frame; GPU draws and target rebuilding are excluded from this asset-free fixture. */
function headless(profile: AtmosphereProfile, weather: Weather) {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const state = createScenario(2, 2);
  state.map.atmosphere = profile;
  state.map.lighting = duskMap;
  Object.assign(state.environment, { weather, weatherIntensity: 0.8, timeOfDay: profile.hour });
  const hd = new HdRenderer(canvas as unknown as HTMLCanvasElement, state);
  applyLookPreset(hd.settings, 'cinematic');
  const terrain = buildTerrain(state.map, hd.nodes);
  const mask = new WeatherGroundMask(2, 2);
  const rain = buildRain(2, 2, terrain.heightTexture, 0, hd.nodes, mask.texture);
  const snow = buildSnow(2, 2, terrain.heightTexture, 0, hd.nodes, mask.texture);
  const water = buildWater(2, 2, 0, terrain.heightTexture);
  const mapLight = new MapLightGrade(grid, duskMap, [
    { position: [128, 128, 624], radius: 768, intensity: 0.15, tint: [0, 0, 0] },
  ]);
  const fieldUpdate = vi.fn();
  Object.assign(hd, {
    terrain,
    rain,
    snow,
    water,
    weatherGroundMask: mask,
    lightField: { update: fieldUpdate, dynamicLights: () => [], dispose: vi.fn() },
    world: { mapLight },
    renderPipeline: vi.fn(),
    buildPipeline: vi.fn(),
    sceneMedianZ: 6,
  });
  const internals = hd as unknown as {
    lighting: Lighting;
    noonIrradiance: Color;
    exposure: { value: Color };
    bloomThreshold: { value: number };
    nightDisplay: { value: number };
    staticGain: number;
  };
  const noon = new Lighting(2, 2);
  noon.update(12, 0);
  noon.flatIrradianceColor(internals.noonIrradiance);
  internals.lighting.sunArc = true;
  const controls = () => ({
    exposure: internals.exposure.value.toArray(),
    bloom: internals.bloomThreshold.value,
    nightDisplay: internals.nightDisplay.value,
    mapWeight: mapLight.currentWeight,
    grade: Array.from(mapLight.texture.image.data as Uint8Array),
    effectLight: hd.effectLight.toArray(),
    rain: hd.nodes.rainAmount.value,
    weatherDesaturation: hd.nodes.weatherDesaturation.value,
    weatherSunShare: hd.nodes.weatherSunShare.value,
  });
  return {
    hd,
    internals,
    mapLight,
    fieldUpdate,
    controls,
    dispose() {
      rain.dispose();
      snow.dispose();
      mask.dispose();
      mapLight.dispose();
      terrain.heightTexture.dispose();
      for (const root of [hd.effects.root, hd.emitters.root, hd.objects.root, terrain.mesh, water.mesh]) {
        root.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.geometry.dispose();
          for (const material of Array.isArray(object.material) ? object.material : [object.material])
            material.dispose();
        });
      }
      hd.emissiveOverlay.dispose();
      hd.terrainDepth.dispose();
      hd.nodes.dispose();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('renderer faithfulness controls', () => {
  it('consumes neutral presentation gains, partial shadows and overcast without native event fields', () => {
    const f = headless({ ...dusk, kind: 'day', hour: 12 }, 'clear');
    try {
      f.hd.frame(0);
      const before = f.internals.lighting.flatIrradianceColor(new Color()).toArray();
      const sun = f.internals.lighting.sun.intensity;
      f.hd.setSceneLighting({
        terrain: [2, 3, 4],
        objects: [0, 0.5, 6],
        sunShadow: 0.4,
        overcast: 0.35,
        skyFlash: 0.8,
      });
      f.hd.frame(0);
      expectRgb(f.hd.nodes.sceneTerrainMul.value.toArray(), [3.6, 5.4, 7.2]);
      expectRgb(f.hd.nodes.sceneObjectMul.value.toArray(), [0, 0.9, 10.8]);
      expect(f.hd.nodes.sceneSunShadow.value).toBe(0.4);
      expect(f.internals.lighting.sun.intensity).toBeCloseTo(sun * 0.65, 13);
      expectRgb(f.internals.lighting.flatIrradianceColor(new Color()).toArray(), before);
      f.hd.setSceneLighting(null);
      f.hd.frame(0);
      expect(f.hd.nodes.sceneObjectMul.value.toArray()).toEqual([1, 1, 1]);
      expect(f.hd.nodes.sceneSunShadow.value).toBe(1);
    } finally {
      f.dispose();
    }
  });

  for (const kind of ['day', 'dusk', 'night'] as const) {
    it.each(['clear', 'rain', 'snow'] as const)(`keeps ${kind} adaptation and bloom event-free in %s`, (weather) => {
      const f = headless({ ...dusk, kind, hour: kind === 'dusk' ? 18.2 : kind === 'day' ? 16.5 : 22 }, weather);
      try {
        // A second frame settles the existing previous-frame map-tint weight before the event comparison.
        f.hd.frame(0);
        f.hd.frame(0);
        const before = f.controls();
        const flat = f.internals.lighting.flatIrradianceColor(new Color()).toArray();
        const storm: Ra2SceneLighting = {
          ambient: 0.87,
          ground: 0,
          level: 0.035,
          tint: [1, 0.92, 0.8],
          override: [0.3, 0.4, 0.75],
          event: 'storm',
        };
        f.hd.setSceneLighting(ra2SceneLighting(duskMap, storm, 6));
        f.hd.frame(0);
        expect(f.controls()).toEqual(before);
        expectRgb(f.internals.lighting.flatIrradianceColor(new Color()).toArray(), flat);
        expect(f.internals.lighting.sun.intensity).toBe(0);
        expect(f.hd.nodes.sceneSunShadow.value).toBe(0);
        const multipliers = computeSceneMultipliers(duskMap, storm, 6);
        expect(f.hd.nodes.sceneTerrainMul.value.toArray()).toEqual(multipliers.terrain);
        expect(f.hd.nodes.sceneObjectMul.value.toArray()).toEqual(multipliers.objects);
        f.hd.setSceneLighting(null);
        f.hd.frame(0);
        expect(f.controls()).toEqual(before);
        expect(f.hd.nodes.sceneSunShadow.value).toBe(1);
        expect(f.hd.nodes.sceneTerrainMul.value.toArray()).toEqual([1, 1, 1]);
      } finally {
        f.dispose();
      }
    });
  }

  it('uses the complete engine dusk grade with unadapted noon exposure (dusk-calibrated) and no duplicate lamp field', () => {
    const f = headless(dusk, 'clear');
    try {
      f.hd.frame(0);
      expect(f.mapLight.currentWeight).toBe(1);
      expect(f.internals.nightDisplay.value).toBe(0);
      expect(f.internals.staticGain).toBe(0);
      // Neither the static dressing nor the map sources' own field: the grade holds the sources.
      expect(f.fieldUpdate).toHaveBeenLastCalledWith(expect.any(Number), f.hd.renderer, 0, 0);
      const noon = f.internals.noonIrradiance;
      // Noon exposure (no adaptation) with the dusk calibration factor only.
      expectRgb(f.internals.exposure.value.toArray(), [
        (Math.PI / noon.r) * DUSK_EXPOSURE,
        (Math.PI / noon.g) * DUSK_EXPOSURE,
        (Math.PI / noon.b) * DUSK_EXPOSURE,
      ]);
      const before = f.controls();
      Object.assign(f.hd.settings, { adaptExposure: 0, whiteAdapt: 0, mapTintAdapt: 0, mapSourcesByDay: 1 });
      f.hd.frame(0);
      expect(f.controls()).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it('lights a night map exactly like a day map and adds only the night dressing', () => {
    // Same [Lighting], same hour (the look's 16.5), same settings: the two kinds must not differ in light.
    const profile = (kind: 'day' | 'night'): AtmosphereProfile => ({
      kind,
      hour: 12,
      nightLevel: 0.3,
      tint: [0.9, 0.9, 1],
    });
    const day = headless(profile('day'), 'clear');
    const night = headless(profile('night'), 'clear');
    try {
      for (const f of [day, night]) {
        f.hd.state.environment.timeOfDay = 16.5;
        f.hd.frame(0);
      }
      expect(night.controls()).toEqual(day.controls());
      expect(night.mapLight.currentWeight).toBe(1);
      expect(night.internals.nightDisplay.value).toBeCloseTo(0.2 * 0.333, 12);
      expect(night.hd.nodes.night.value).toBe(day.hd.nodes.night.value);
      expect(night.hd.nodes.sceneLevel.value.toArray()).toEqual(day.hd.nodes.sceneLevel.value.toArray());
      // The dressing: lit windows, lamp heads and static lamp pools on the night map, none on the day map.
      expect(day.hd.nodes.windowGain.value).toBe(0);
      expect(day.hd.emitters.lampGain.value).toBe(0);
      expect(day.internals.staticGain).toBe(0);
      expect(night.hd.nodes.windowGain.value).toBe(1);
      expect(night.hd.emitters.lampGain.value).toBe(1);
      expect(night.hd.windowsWanted()).toBe(true);
      expect(day.hd.windowsWanted()).toBe(false);
      // Static pools are scaled back up by the darkness the grade gives the art they multiply.
      expect(night.internals.staticGain).toBeCloseTo(1 / 0.3, 12);
      // The map sources' own field stays off on both: the grade holds them.
      expect(night.fieldUpdate).toHaveBeenLastCalledWith(
        expect.any(Number),
        night.hd.renderer,
        night.internals.staticGain,
        0,
      );
      expect(day.fieldUpdate).toHaveBeenLastCalledWith(expect.any(Number), day.hd.renderer, 0, 0);
      expect(night.internals.lighting.state.dressing).toBe(1);
      expect(day.internals.lighting.state.dressing).toBeCloseTo(0.2 * 0.333, 12);
    } finally {
      day.dispose();
      night.dispose();
    }
  });

  it('hands a night map to the moonlit presentation only when its hour is forced to night', () => {
    const f = headless({ kind: 'night', hour: 12, nightLevel: 0.3, tint: [0.9, 0.9, 1] }, 'clear');
    try {
      f.hd.state.environment.timeOfDay = 22;
      f.hd.frame(0);
      expect(f.mapLight.currentWeight).toBe(0);
      expect(f.internals.nightDisplay.value).toBe(1);
      // Ungraded art again: the static pools at their tuned strength, and the map sources in their own field.
      expect(f.internals.staticGain).toBe(1);
      expect(f.fieldUpdate).toHaveBeenLastCalledWith(expect.any(Number), f.hd.renderer, 1, 1);
    } finally {
      f.dispose();
    }
  });

  it('scales the dressing pools by the grade weight on night maps only', () => {
    const night = { kind: 'night', nightLevel: 0.26 } as const;
    expect(dressingLightGain(night, 1)).toBeCloseTo(1 / 0.26, 12);
    expect(dressingLightGain(night, 0)).toBe(1);
    expect(dressingLightGain(night, 0.5)).toBeCloseTo(1 + (1 / 0.26 - 1) / 2, 12);
    expect(dressingLightGain({ kind: 'night', nightLevel: 0 }, 1)).toBe(10);
    expect(dressingLightGain({ kind: 'day', nightLevel: 0.3 }, 1)).toBe(1);
    expect(dressingLightGain({ kind: 'dusk', nightLevel: 0.3 }, 1)).toBe(1);
    expect(dressingLightGain(null, 1)).toBe(1);
  });
});

describe('night maps: day keys with night dressing', () => {
  const profile = (kind: 'day' | 'night'): AtmosphereProfile => ({
    kind,
    hour: 12,
    nightLevel: 0.36,
    tint: [0.62, 0.62, 1],
  });

  // Decorative weather is a separate matter: night maps keep the overcast curve they had (weatherLighting.test.ts).
  it.each([false, true])('uses the very same clear light as a day map at every hour, arc = %s', (arc) => {
    for (const hour of [0, 5.5, 8, 12, 16.5, 18.2, 21, 22]) {
      for (const weather of ['clear'] as const) {
        const states = (['day', 'night'] as const).map((kind) => {
          const l = new Lighting(20, 20);
          l.sunArc = arc;
          l.setProfile(profile(kind));
          l.update(hour, overcastAt(weather), weather === 'snow' ? 0.06 : undefined, weatherAt(weather));
          return { light: snapshot(l), dressing: l.state.dressing, night: l.state.night };
        });
        const [day, night] = states as [(typeof states)[number], (typeof states)[number]];
        expect(night.light, `${hour} ${weather}`).toEqual(day.light);
        expect(night.night).toBe(day.night);
        // Dressing: always on for the night map, the night weight for the day map.
        expect(night.dressing).toBe(1);
        expect(day.dressing).toBe(day.night);
      }
    }
  });

  it('reports the dressing weight ahead of a frame', () => {
    const l = new Lighting(20, 20);
    l.setProfile(profile('night'));
    for (const hour of [0, 12, 16.5, 22]) expect(l.dressingAt(hour)).toBe(1);
    expect(l.nightAt(12)).toBe(0);
    expect(l.nightAt(22)).toBe(1);
    l.setProfile(profile('day'));
    expect(l.dressingAt(12)).toBe(0);
    expect(l.dressingAt(22)).toBe(1);
    expect(l.dressingAt(16.5)).toBeCloseTo(0.2 * 0.333, 12);
    // Without a profile the legacy keys' dressing follows their night curve.
    const legacy = new Lighting(20, 20);
    legacy.update(22, 0);
    expect(legacy.state.dressing).toBe(legacy.state.night);
  });
});
