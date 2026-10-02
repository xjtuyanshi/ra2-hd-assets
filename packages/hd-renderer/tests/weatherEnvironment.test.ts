import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, Mesh, NodeFrame } from 'three/webgpu';
import { HdRenderer } from '../src/HdRenderer';
import { DEFAULT_ATMOSPHERE } from '../src/atmosphere';
import type { Weather } from '../src/contract';
import { Lighting, noonFlatLuminance } from '../src/lighting';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { wetGroundResponse } from '../src/ra2/terrain';
import { SHADOW_COPIES, SHADOW_OPACITY, voxelShadowFor, voxelShadowMaterial } from '../src/ra2/voxelShadow';
import { buildTerrain } from '../src/terrain';
import { buildWater } from '../src/water';
import { buildRain, buildSnow } from '../src/weather';
import { WeatherGroundMask } from '../src/weatherGroundMask';
import { createScenario } from '../sandbox/scenario';

/** Real CPU frame and shader uniforms; only GPU draws/targets and pipeline rebuilds are replaced. */
function headlessWeather(weather: Weather, intensity: number, hour = 12, mapProfile = false) {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const state = createScenario(2, 2);
  Object.assign(state.environment, {
    weather,
    weatherIntensity: intensity,
    timeOfDay: hour,
    windDirection: 0.7,
    windStrength: 0.4,
  });
  const hd = new HdRenderer(canvas as unknown as HTMLCanvasElement, state);
  const terrain = buildTerrain(state.map, hd.nodes);
  const mask = new WeatherGroundMask(2, 2);
  const rain = buildRain(2, 2, terrain.heightTexture, 0, hd.nodes, mask.texture);
  const snow = buildSnow(2, 2, terrain.heightTexture, 0, hd.nodes, mask.texture);
  const water = buildWater(2, 2, 0, terrain.heightTexture);
  const lightField = { update: vi.fn(), dynamicLights: () => [], dispose: vi.fn() };
  Object.assign(hd, {
    terrain,
    rain,
    snow,
    water,
    weatherGroundMask: mask,
    lightField,
    world: mapProfile ? {} : null,
    renderPipeline: vi.fn(),
    buildPipeline: vi.fn(),
  });
  hd.settings.wetReflections = 1;
  hd.nodes.weatherGroundTexture.value = mask.texture;
  hd.nodes.weatherGroundSize.value.set(2, 2);
  const lighting = (hd as unknown as { lighting: Lighting }).lighting;
  const update = vi.spyOn(lighting, 'update');
  const mist = (hd as unknown as { mist: { amount: { value: number } } }).mist;
  const dispose = () => {
    rain.dispose();
    snow.dispose();
    mask.dispose();
    terrain.heightTexture.dispose();
    for (const root of [hd.effects.root, hd.emitters.root, hd.objects.root, terrain.mesh, water.mesh]) {
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
    }
    hd.terrainDepth.dispose();
    hd.nodes.dispose();
  };
  return { hd, state, terrain, rain, snow, water, mask, lighting, update, mist, dispose };
}

afterEach(() => vi.unstubAllGlobals());

describe('HdRenderer weather environment', () => {
  it.each([0, 0.2, 0.8, 1])('drives only dry snow at intensity %s, including rain-to-snow transitions', (intensity) => {
    const f = headlessWeather('rain', 0.8);
    try {
      f.terrain.wetness.value = 0.6;
      f.hd.frame(1 / 60);
      expect(f.rain.intensity.value).toBe(0.8);
      expect(f.terrain.wetness.value).toBeGreaterThan(0.6);
      f.state.environment.weather = 'snow';
      f.state.environment.weatherIntensity = intensity;
      f.hd.frame(1 / 60);
      expect(f.rain.intensity.value).toBe(0);
      expect(f.rain.object.visible).toBe(false);
      expect(f.snow.intensity.value).toBe(intensity);
      expect(f.snow.object.visible).toBe(intensity > 0);
      expect(f.terrain.wetness.value).toBe(0);
      expect(f.hd.emitters.wet.value).toBe(0);
      expect(spriteLookFor(f.hd.nodes).wetness.value).toBe(0);
      expect(f.water.uniforms.rain.value).toBe(0);
      expect(f.hd.nodes.rainAmount.value).toBe(0);
      expect(f.mist.amount.value).toBe(0.06 * intensity);
      expect(f.update).toHaveBeenLastCalledWith(12, 0.3 + 0.35 * intensity, 0.06, { kind: 'snow', intensity });
      expect(f.snow.windX.value).toBe(Math.cos(0.7) * 0.4 * 0.4);
      expect(f.snow.windZ.value).toBe(Math.sin(0.7) * 0.4 * 0.4);
      expect(f.snow.center.value.equals(f.hd.view.target)).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('hides both particle groups in clear weather after snow and preserves gradual clear-weather drying', () => {
    const f = headlessWeather('snow', 0.8);
    try {
      f.hd.frame(1 / 60);
      f.state.environment.weather = 'clear';
      f.terrain.wetness.value = 0.5;
      f.hd.frame(0.5);
      expect(f.rain.intensity.value).toBe(0);
      expect(f.snow.intensity.value).toBe(0);
      expect(f.rain.object.visible).toBe(false);
      expect(f.snow.object.visible).toBe(false);
      expect(f.terrain.wetness.value).toBe(0.5 - 0.5 * 0.02);
      expect(f.mist.amount.value).toBe(0);
      expect(f.update).toHaveBeenLastCalledWith(12, 0, undefined, undefined);
    } finally {
      f.dispose();
    }
  });

  // These expressions are the pre-snow frame contract: keep strict equality, including storm's 1.3 saturation.
  for (const weather of ['clear', 'rain', 'storm'] as const) {
    it.each([12, 22])(`retains every weather uniform for ${weather} at hour %s`, (hour) => {
      const f = headlessWeather(weather, 0.8, hour);
      try {
        f.terrain.wetness.value = 0.4;
        const raining = weather === 'rain' || weather === 'storm';
        const amount = raining ? Math.min(1, 0.8 * (weather === 'storm' ? 1.3 : 1)) : 0;
        const reference = new Lighting(2, 2);
        reference.update(hour, raining ? 0.35 + 0.5 * amount : 0);
        const level = reference.flatIrradianceColor(new Color()).multiplyScalar(1 / reference.referenceIrradiance());
        const night = reference.state.night;
        const mist = raining ? (1 - night) * 0.06 * amount + night * (0.045 + 0.04 * amount) : 0.05 * night;
        f.hd.frame(0.2);
        expect(f.rain.intensity.value).toBe(amount);
        expect(f.snow.intensity.value).toBe(0);
        expect(f.snow.object.visible).toBe(false);
        expect(f.rain.windX.value).toBe(Math.cos(0.7) * 0.4 * 0.4);
        expect(f.rain.windZ.value).toBe(Math.sin(0.7) * 0.4 * 0.4);
        expect(f.rain.center.value.equals(f.hd.view.target)).toBe(true);
        const wet = raining ? Math.min(1, 0.4 + 0.2 * 0.25 * amount) : Math.max(0, 0.4 - 0.2 * 0.02);
        expect(f.terrain.wetness.value).toBe(wet);
        expect(spriteLookFor(f.hd.nodes).wetness.value).toBe(wet);
        expect(f.hd.emitters.wet.value).toBe(wet);
        expect(f.mist.amount.value).toBe(mist);
        expect(f.hd.nodes.rainAmount.value).toBe(amount);
        expect(f.hd.nodes.sceneLevel.value.toArray()).toEqual(level.toArray());
        expect(f.hd.nodes.sceneBrightness.value).toBe(
          ((0.2126 * level.r + 0.7152 * level.g + 0.0722 * level.b) * reference.referenceIrradiance()) /
            noonFlatLuminance(),
        );
        expect(f.water.uniforms.rain.value).toBe(amount);
        expect(f.water.uniforms.wind.value).toBe(0.4 + amount * 0.3);
        expect(f.water.uniforms.skyZenith.value.toArray()).toEqual(reference.state.skyZenith.toArray());
        expect(f.water.uniforms.skyHorizon.value.toArray()).toEqual(reference.state.skyHorizon.toArray());
        expect(f.water.uniforms.ambient.value.toArray()).toEqual(reference.state.ambient.toArray());
      } finally {
        f.dispose();
      }
    });
  }

  it.each([false, true])('limits day snow dimming with map profile = %s', (mapProfile) => {
    const f = headlessWeather('snow', 1, 12, mapProfile);
    try {
      const clear = new Lighting(2, 2);
      clear.setProfile(mapProfile ? DEFAULT_ATMOSPHERE : null);
      clear.update(12, 0);
      const luminance = (color: Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
      f.hd.frame(1 / 60);
      const ratio =
        luminance(f.lighting.flatIrradianceColor(new Color())) / luminance(clear.flatIrradianceColor(new Color()));
      expect(ratio).toBeGreaterThanOrEqual((mapProfile ? 0.9 : 0.94) - 1e-12);
      expect(ratio).toBeLessThanOrEqual(1);
    } finally {
      f.dispose();
    }
  });

  it.each(['rain', 'snow'] as const)(
    'retains the intended %s change with exposure and white adaptation enabled',
    (weather) => {
      const f = headlessWeather('clear', 0.8, 12, true);
      const lum = (colour: Color) => 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
      try {
        f.hd.settings.adaptExposure = 1;
        f.hd.settings.whiteAdapt = 1;
        const exposure = (f.hd as unknown as { exposure: { value: Color } }).exposure;
        f.hd.frame(0);
        const clearExposure = exposure.value.toArray();
        const clear = lum(f.lighting.flatIrradianceColor(new Color()));
        f.state.environment.weather = weather;
        f.terrain.wetness.value = weather === 'rain' ? 1 : 0;
        f.hd.frame(0);
        expect(exposure.value.toArray()).toEqual(clearExposure);
        const incident = lum(f.lighting.flatIrradianceColor(new Color())) / clear;
        const shadowRatio =
          (lum(f.lighting.hemi.color) * f.lighting.hemi.intensity) / lum(f.lighting.flatIrradianceColor(new Color()));
        expect(shadowRatio).toBeGreaterThanOrEqual(weather === 'rain' ? 0.78 : 0.72);
        expect(f.hd.nodes.weatherSunShare.value).toBe(f.lighting.state.weatherSunShare);
        expect(f.hd.nodes.weatherDesaturation.value).toBe(weather === 'rain' ? 0.125 : 0);
        // Include the material's diffuse + sky response: incident light alone is not a rendered asphalt/grass value.
        for (const paved of [0, 1]) {
          const response = wetGroundResponse(f.terrain.wetness.value, paved, 0);
          const flat = incident * response.diffuse * (1 + response.daySkyGain);
          expect(flat).toBeGreaterThanOrEqual(weather === 'rain' ? 0.8 : 0.9);
          expect(flat).toBeLessThanOrEqual(weather === 'rain' ? 0.88 : 0.97);
        }
        // Evaluate the actual CPU-updated voxel alpha, including its multi-copy composition.
        const opacity = voxelShadowMaterial(f.hd.nodes).opacityNode!;
        const frame = new NodeFrame();
        frame.object = new Mesh();
        for (const soft of [false, true]) {
          voxelShadowFor(f.hd.nodes).soft = soft;
          opacity.update(frame);
          const alpha = (opacity as unknown as { value: number }).value;
          expect(1 - (1 - alpha) ** (soft ? SHADOW_COPIES.length : 1)).toBeCloseTo(
            SHADOW_OPACITY * f.lighting.state.weatherSunShare,
            12,
          );
        }
        frame.object.geometry.dispose();
        (frame.object.material as { dispose(): void }).dispose();
      } finally {
        f.dispose();
      }
    },
  );

  it.each([false, true])('restores every weather-facing uniform after dry clear weather, profiled = %s', (profiled) => {
    const f = headlessWeather('clear', 0.8, 12, profiled);
    const uniforms = (source: object): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(source).flatMap(([key, node]) => {
          if (!node?.isUniformNode || node.isTextureNode) return [];
          const value = node.value;
          return [[key, typeof value === 'number' ? value : value?.toArray?.()]];
        }),
      );
    const snapshot = () => ({
      atmosphere: uniforms(f.hd.nodes),
      look: uniforms(spriteLookFor(f.hd.nodes)),
      rain: uniforms(f.rain),
      snow: uniforms(f.snow),
      water: uniforms(f.water.uniforms),
      renderer: uniforms(f.hd),
      mist: f.mist.amount.value,
    });
    try {
      f.hd.frame(0);
      const before = snapshot();
      expect(before.atmosphere.weatherSunShare).toBe(1);
      expect(before.atmosphere.weatherDesaturation).toBe(0);
      for (const weather of ['rain', 'snow'] as const) {
        f.state.environment.weather = weather;
        f.hd.frame(0);
        f.state.environment.weather = 'clear';
        f.terrain.wetness.value = 0;
        f.hd.frame(0);
        expect(snapshot()).toEqual(before);
      }
    } finally {
      f.dispose();
    }
  });

  it('releases both particle systems and the ground mask exactly once with the renderer', () => {
    const f = headlessWeather('clear', 0);
    const rain = vi.spyOn(f.rain, 'dispose');
    const snow = vi.spyOn(f.snow, 'dispose');
    const mask = vi.spyOn(f.mask, 'dispose');
    // The GPU backend was never initialized; its own disposal is not under test here.
    vi.spyOn(f.hd.renderer, 'dispose').mockImplementation(() => {});
    f.hd.dispose();
    f.hd.dispose();
    expect(rain).toHaveBeenCalledOnce();
    expect(snow).toHaveBeenCalledOnce();
    expect(mask).toHaveBeenCalledOnce();
  });
});
