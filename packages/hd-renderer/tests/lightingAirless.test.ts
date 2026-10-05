import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, DataTexture, Vector3 } from 'three/webgpu';
import { mapAtmosphere } from '../../ra2-assets/src/lights';
import type { AtmosphereProfile } from '../src/contract';
import { applyLookPreset, gradeNight, HdRenderer } from '../src/HdRenderer';
import { Lighting, noonFlatLuminance, profileKeys, sunHeight } from '../src/lighting';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { createWaterUniforms } from '../src/waterShading';
import { buildRain, buildSnow } from '../src/weather';
import { createScenario } from '../sandbox/scenario';

const lighting = { ambient: 0.65, red: 1, green: 1, blue: 1.1, ground: 0.05, level: 0.008 };
const lunar = (): AtmosphereProfile => mapAtmosphere(lighting, 4, undefined, 'lunar');
const day: AtmosphereProfile = { kind: 'day', hour: 12, nightLevel: 0.3, tint: [1, 1, 1] };
const luma = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const chroma = (c: Color): number[] => c.toArray().map((v) => v / luma(c));

describe('airless daylight keys', () => {
  it('keeps lunar daylight at neutral noon so the engine grade alone supplies the authored dimming', () => {
    const profile = lunar();
    expect(profile.exposure).toBeUndefined();
    expect(profile.tint).toEqual([1, 1, 1]);
    const key = profileKeys(profile).find((key) => key.hour === 12)!;
    const flat = luma(key.sun) * key.sunIntensity * sunHeight(key.elevation) + luma(key.hemiSky) * key.hemiIntensity;
    expect(flat / noonFlatLuminance()).toBeCloseTo(1, 12);
    const tint = chroma(new Color(...profile.tint));
    for (const colour of [key.sun, key.hemiSky, key.hemiGround, key.skyHorizon, key.skyZenith])
      chroma(colour).forEach((channel, i) => expect(channel).toBeCloseTo(tint[i]!, 12));
    expect(key.night).toBe(0);
  });

  it('keeps the noon flat-ground luminance and neutral grey at every daylight hour', () => {
    const model = new Lighting(2, 2);
    model.setProfile(lunar());
    model.update(12, 0);
    const noon = model.flatIrradianceColor(new Color());
    const noonSun = model.sun.intensity * Math.max(0, model.state.sunDirection.y) * luma(model.sun.color);
    expect(luma(noon)).toBeCloseTo(noonFlatLuminance(), 12);
    for (const hour of [8, 10, 14, 16, 16.5]) {
      model.update(hour, 0);
      const flat = model.flatIrradianceColor(new Color());
      // Hours whose keys carry no night keep the noon luminance and grey exactly; 16.5 (night 0.0666 from the dusk
      // key) keeps both for its day share: within that share of noon, and of the dusk key's sunset colour.
      if (model.state.night === 0) {
        expect(luma(flat) / luma(noon)).toBeCloseTo(1, 12);
        chroma(flat).forEach((channel) => expect(channel).toBeCloseTo(1, 12));
        chroma(model.sun.color).forEach((channel) => expect(channel).toBeCloseTo(1, 12));
      } else {
        expect(luma(flat) / luma(noon)).toBeGreaterThan(1 - 2 * model.state.night);
        chroma(flat).forEach((channel) => expect(Math.abs(channel - 1)).toBeLessThan(model.state.night));
      }
      expect(luma(model.clearFlatIrradianceColor(new Color())) / luma(noon)).toBeCloseTo(luma(flat) / luma(noon), 12);
    }
    // The hour still shapes the light: a lower afternoon sun gives flat ground a smaller direct share than noon's.
    model.update(16, 0);
    const lateSun = model.sun.intensity * Math.max(0, model.state.sunDirection.y) * luma(model.sun.color);
    expect(lateSun / luma(model.flatIrradianceColor(new Color()))).toBeLessThan(noonSun / luma(noon));
    // A terrestrial day map is not calibrated: its afternoon is dimmer and the look's exposure adaptation owns that.
    const earth = new Lighting(2, 2);
    earth.setProfile(day);
    earth.update(16, 0);
    expect(luma(earth.flatIrradianceColor(new Color())) / noonFlatLuminance()).toBeLessThan(0.9);
  });

  it.each(['rain', 'snow'] as const)('keeps explicit %s weather from replacing airless daylight with a sky', (kind) => {
    const model = new Lighting(2, 2);
    model.setProfile(lunar());
    model.update(12, 0);
    const clear = model.flatIrradianceColor(new Color()).toArray();
    const sky = model.state.skyZenith.toArray();
    model.update(12, 0.85, undefined, { kind, intensity: 1 });
    expect(model.flatIrradianceColor(new Color()).toArray()).toEqual(clear);
    expect(model.state.skyZenith.toArray()).toEqual(sky);
    expect(model.state.weatherSunShare).toBe(1);
    expect(model.state.weatherBrightness).toBe(1);
  });

  it('keeps ordinary day keys by identity and all night/dusk keys unchanged', () => {
    const original = profileKeys(day);
    const untouched = profileKeys({ ...day, tint: [1, 0.8, 0.68] });
    const airless = profileKeys({ ...day, exposure: 0.36, airless: true });
    original.forEach((key, i) => {
      if (key.night === 0) expect(untouched[i]).toBe(key);
      else expect(airless[i]).toEqual(key);
    });
  });

  it('scales exposure without changing daylight chroma when airless is absent', () => {
    const original = profileKeys(day);
    const dim = profileKeys({ ...day, exposure: 0.36 });
    original.forEach((key, i) => {
      const changed = dim[i]!;
      if (key.night !== 0) return expect(changed).toEqual(key);
      expect(changed.sun).toBe(key.sun);
      expect(changed.hemiSky).toBe(key.hemiSky);
      expect(changed.sunIntensity).toBe(key.sunIntensity * 0.36);
      expect(changed.hemiIntensity).toBe(key.hemiIntensity * 0.36);
    });
  });

  it('refreshes changed optional fields and cannot restore atmospheric scattering through overcast', () => {
    const model = new Lighting(2, 2);
    model.setProfile(day);
    model.update(12, 0);
    const noon = model.flatIrradianceColor(new Color());
    model.setProfile({ ...day, exposure: 0.36 });
    model.update(12, 0);
    expect(luma(model.flatIrradianceColor(new Color())) / luma(noon)).toBeCloseTo(0.36, 12);
    model.setProfile({ ...day, exposure: 0.36, airless: true });
    model.update(12, 0);
    const clear = model.flatIrradianceColor(new Color());
    chroma(clear).forEach((channel) => expect(channel).toBeCloseTo(1, 12));
    model.update(12, 0.85);
    expect(model.flatIrradianceColor(new Color()).toArray()).toEqual(clear.toArray());
    model.setProfile(day);
    model.update(12, 0);
    expect(model.flatIrradianceColor(new Color()).toArray()).toEqual(noon.toArray());
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('airless renderer staging', () => {
  it('preserves engine lamp pools and neutral light through night-level overrides and cinematic look changes', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
    const state = createScenario(2, 2);
    state.environment.timeOfDay = 12;
    state.map.atmosphere = lunar();
    const hd = new HdRenderer(canvas as unknown as HTMLCanvasElement, state);
    const mapLight = new MapLightGrade(
      { width: 2, height: 2, z: new Uint8Array(4).fill(4), exists: new Uint8Array(4).fill(1) },
      lighting,
    );
    const plainTexels = Array.from(mapLight.texture.image.data as Uint8Array);
    mapLight.setSources([{ position: [128, 128, 416], radius: 256, intensity: 0.25, tint: [0.25, 0, 0.6] }]);
    const litTexels = Array.from(mapLight.texture.image.data as Uint8Array);
    expect(litTexels[2]).toBeGreaterThan(litTexels[0]!);
    expect(litTexels[0]).toBeGreaterThan(litTexels[1]!);
    expect(litTexels[2]).toBeGreaterThan(plainTexels[2]!);
    expect(litTexels.slice(4)).toEqual(plainTexels.slice(4));
    const water = createWaterUniforms();
    const height = new DataTexture();
    const rain = buildRain(2, 2, height, 0, hd.nodes);
    const snow = buildSnow(2, 2, height, 0, hd.nodes);
    // Exercise the complete CPU frame path; the two GPU operations are stubs, with no backend or browser startup.
    const frame = hd as unknown as {
      lighting: Lighting;
      noonIrradiance: Color;
      exposure: { value: Color };
      mist: { amount: { value: number } };
      gradeUniforms: {
        gradeBalance: { value: Vector3 };
        gradeShadowTint: { value: Vector3 };
        gradeHighlightTint: { value: Vector3 };
      };
      profile(): AtmosphereProfile;
    };
    const sprites = {
      light: { value: new Color() },
      cameraRight: { value: new Vector3() },
      cameraUp: { value: new Vector3() },
      toCamera: { value: new Vector3() },
    };
    Object.assign(hd, {
      world: { mapLight, sprites },
      terrain: { wetness: { value: 0 } },
      water: { uniforms: water },
      rain,
      snow,
      lightField: { update: vi.fn(), dynamicLights: () => [] },
      renderPipeline: vi.fn(),
    });
    frame.lighting.update(12, 0);
    frame.lighting.flatIrradianceColor(frame.noonIrradiance);
    hd.atmosphere.nightLevel = 0.4;
    try {
      for (const preset of ['faithful', 'golden', 'cinematic'] as const) {
        applyLookPreset(hd.settings, preset);
        // Exercise both live look edits and the map-preserving night-level override without a GPU pipeline.
        Object.assign(hd.settings, { adaptExposure: 1, whiteAdapt: 1, mapTintAdapt: 1 });
        hd.frame(0);
        expect(frame.profile()).toMatchObject({ ...lunar(), nightLevel: 0.4 });
        const displayed = sprites.light.value.clone().multiply(frame.exposure.value);
        expect(luma(displayed)).toBeCloseTo(1, 12);
        chroma(displayed).forEach((channel, i) =>
          expect(channel).toBeCloseTo(chroma(new Color(...lunar().tint))[i]!, 12),
        );
        expect(mapLight.currentWeight).toBe(1);
        if (hd.settings.mapSourcesByDay === 1)
          expect(Array.from(mapLight.texture.image.data as Uint8Array)).toEqual(litTexels);
        expect(hd.nodes.night.value).toBe(0);
        expect(hd.nodes.windowGain.value).toBe(0);
        expect(hd.emitters.lampGain.value).toBe(0);
        expect(frame.mist.amount.value).toBe(0);
        expect(water.airless.value).toBe(1);
        for (const key of ['gradeBalance', 'gradeShadowTint', 'gradeHighlightTint'] as const)
          expect(frame.gradeUniforms[key].value.toArray()).toEqual([1, 1, 1]);
        if (preset !== 'faithful') {
          const look = spriteLookFor(hd.nodes);
          for (const colour of [look.skyLight.value, look.skyHorizon.value, look.skyZenith.value])
            chroma(colour).forEach((channel, i) =>
              expect(channel).toBeCloseTo(chroma(new Color(...lunar().tint))[i]!, 12),
            );
        }
      }
      state.environment.weather = 'rain';
      state.environment.weatherIntensity = 1;
      hd.frame(0);
      expect(frame.mist.amount.value).toBe(0);
      expect(luma(sprites.light.value.clone().multiply(frame.exposure.value))).toBeCloseTo(1, 12);
      expect(rain.object.visible).toBe(true);
      expect(snow.object.visible).toBe(false);
      state.environment.weather = 'snow';
      hd.frame(0);
      expect(rain.object.visible).toBe(false);
      expect(snow.object.visible).toBe(true);
      expect(frame.mist.amount.value).toBe(0);
      state.environment.weather = 'clear';
      // Airless maps keep the engine's full lamp share whatever a look's daytime share.
      hd.settings.mapSourcesByDay = 0;
      hd.frame(0);
      expect(Array.from(mapLight.texture.image.data as Uint8Array)).toEqual(litTexels);
      expect(litTexels).not.toEqual(plainTexels);
      hd.settings.mapSourcesByDay = 1;
      hd.frame(0);
      expect(Array.from(mapLight.texture.image.data as Uint8Array)).toEqual(litTexels);
      // Another daylight hour: the keys stay at the noon flat-ground luminance (Lighting.update), so a look's
      // afternoon hour neither dims the moon nor needs exposure adaptation. The look's own adaptation stays out:
      // toggling it must not move the exposure.
      state.environment.timeOfDay = 16;
      hd.settings.adaptExposure = 0;
      hd.frame(0);
      const unadapted = frame.exposure.value.toArray();
      expect(new Set(unadapted).size).toBe(1);
      expect(luma(sprites.light.value.clone().multiply(frame.exposure.value))).toBeCloseTo(1, 12);
      expect(hd.nodes.night.value).toBe(0);
      expect(mapLight.currentWeight).toBe(1);
      hd.settings.adaptExposure = 1;
      hd.frame(0);
      expect(frame.exposure.value.toArray()).toEqual(unadapted);
      // The cinematic hour carries a night weight of 0.0666: still the whole grade, a scalar (untinted) exposure
      // and, the keys' day share being calibrated, flat ground within that night share of its noon brightness.
      state.environment.timeOfDay = 16.5;
      hd.frame(0);
      expect(hd.nodes.night.value).toBeCloseTo(0.2 * 0.333, 12);
      expect(mapLight.currentWeight).toBe(1);
      expect(new Set(frame.exposure.value.toArray()).size).toBe(1);
      expect(luma(sprites.light.value.clone().multiply(frame.exposure.value))).toBeGreaterThan(0.93);
      expect(luma(sprites.light.value.clone().multiply(frame.exposure.value))).toBeLessThan(1.001);
      state.environment.timeOfDay = 18.5;
      hd.frame(0);
      expect(hd.nodes.night.value).toBeGreaterThan(0);
      expect(hd.nodes.night.value).toBeLessThan(1);
      expect(mapLight.currentWeight).toBeCloseTo(1 - gradeNight(hd.nodes.night.value), 12);
      state.environment.timeOfDay = 21;
      hd.frame(0);
      expect(mapLight.currentWeight).toBe(0);
      state.environment.timeOfDay = 12;
      state.map.atmosphere = day;
      hd.frame(0);
      expect(frame.profile().exposure).toBeUndefined();
      expect(frame.profile().airless).toBeUndefined();
      expect(mapLight.currentWeight).toBe(1);
      expect(water.airless.value).toBe(0);
      expect(frame.gradeUniforms.gradeShadowTint.value.toArray()).toEqual(hd.settings.gradeShadowTint);
    } finally {
      spriteLookFor(hd.nodes).shadowFollow.value = 0;
      applyLookPreset(hd.settings, 'faithful');
      hd.frame(0);
      rain.dispose();
      snow.dispose();
      height.dispose();
      mapLight.dispose();
      hd.nodes.dispose();
    }
  });
});
