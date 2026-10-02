import { createHash } from 'node:crypto';
import { Color, Mesh } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScenario } from '../sandbox/scenario';
import { applyLookPreset, DUSK_EXPOSURE, HdRenderer, mapPresentation } from '../src/HdRenderer';
import type { AtmosphereProfile, MapLighting, Weather } from '../src/contract';
import { Lighting } from '../src/lighting';
import type { LightField } from '../src/lightField';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { MapLights, type SourceLight } from '../src/ra2/mapLights';
import { computeSceneMultipliers, type SceneLighting } from '../src/sceneLighting';
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
    for (const kind of ['day', 'night'] as const) {
      for (const night of [0, 0.29304, 1]) {
        expect(mapPresentation(kind, night, settings)).toEqual({
          exposureScale: 1,
          mapWeight: kind === 'day' ? 1 - night : 0,
          sourceWeight: 0.2,
          adaptExposure: 0.85,
          whiteAdapt: 0.85,
          mapTintAdapt: 0.3,
        });
      }
    }
    expect(settings).toEqual({ adaptExposure: 0.85, whiteAdapt: 0.85, mapTintAdapt: 0.3, mapSourcesByDay: 0.2 });
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

  it.each(['day', 'night'] as const)('keeps the pre-fix %s light/uniform matrix bit-identical', (kind) => {
    // SHA-256 of the complete numeric snapshots from the pre-fix lighting.ts, for 48 combinations per profile.
    // Pin the old renderer's output, rather than deriving an expected value from the changed implementation.
    const baseline = {
      day: '0ee1adfdb7a59247c0dac0a44d70c68ce5ab897d2fb077ebf85fab88f2e6be32',
      night: '01c7a2d661c6b95536f64b6cee351fc84879d2574ac4d263c6fae15c4525b724',
    };
    const states = [];
    for (const arc of [false, true]) {
      for (const hour of [0, 5.5, 8, 12, 16.5, 18.2, 21, 22]) {
        for (const weather of ['clear', 'rain', 'snow'] as const) {
          const l = new Lighting(20, 20);
          l.sunArc = arc;
          l.setProfile({ kind, hour: kind === 'day' ? 16.5 : 22, nightLevel: 0.3, tint: [1, 0.92, 0.8] });
          l.update(hour, overcastAt(weather), weather === 'snow' ? 0.06 : undefined, weatherAt(weather));
          states.push(snapshot(l));
        }
      }
    }
    expect(createHash('sha256').update(JSON.stringify(states)).digest('hex')).toBe(baseline[kind]);
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
  for (const kind of ['day', 'dusk', 'night'] as const) {
    it.each(['clear', 'rain', 'snow'] as const)(`keeps ${kind} adaptation and bloom event-free in %s`, (weather) => {
      const f = headless({ ...dusk, kind, hour: kind === 'dusk' ? 18.2 : kind === 'day' ? 16.5 : 22 }, weather);
      try {
        // A second frame settles the existing previous-frame map-tint weight before the event comparison.
        f.hd.frame(0);
        f.hd.frame(0);
        const before = f.controls();
        const flat = f.internals.lighting.flatIrradianceColor(new Color()).toArray();
        const storm: SceneLighting = {
          ambient: 0.87,
          ground: 0,
          level: 0.035,
          tint: [1, 0.92, 0.8],
          override: [0.3, 0.4, 0.75],
          event: 'storm',
        };
        f.hd.setSceneLighting(storm);
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
      expect(f.fieldUpdate).toHaveBeenLastCalledWith(expect.any(Number), f.hd.renderer, 0);
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
});
