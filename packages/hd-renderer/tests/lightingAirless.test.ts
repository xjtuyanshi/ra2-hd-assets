import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, Vector3 } from 'three/webgpu';
import { mapAtmosphere } from '../../ra2-assets/src/lights';
import type { AtmosphereProfile } from '../src/contract';
import { applyLookPreset, HdRenderer } from '../src/HdRenderer';
import { Lighting, noonFlatLuminance, profileKeys, sunHeight } from '../src/lighting';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { createWaterUniforms } from '../src/waterShading';
import { createScenario } from '../sandbox/scenario';

const lighting = { ambient: 0.65, red: 1, green: 1, blue: 1.1, ground: 0.05, level: 0.008 };
const lunar = (): AtmosphereProfile => mapAtmosphere(lighting, 4, undefined, 'lunar');
const day: AtmosphereProfile = { kind: 'day', hour: 12, nightLevel: 0.3, tint: [1, 1, 1] };
const luma = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const chroma = (c: Color): number[] => c.toArray().map((v) => v / luma(c));

describe('airless daylight keys', () => {
  it('gives MoonPatr flat ground 0.36 of noon within 2 percent and only its normalised map tint', () => {
    const profile = lunar();
    const key = profileKeys(profile).find((key) => key.hour === 12)!;
    const flat = luma(key.sun) * key.sunIntensity * sunHeight(key.elevation) + luma(key.hemiSky) * key.hemiIntensity;
    expect(flat / noonFlatLuminance()).toBeCloseTo(profile.exposure!, 12);
    expect(Math.abs(flat / noonFlatLuminance() / 0.36 - 1)).toBeLessThan(0.02);
    const tint = chroma(new Color(...profile.tint));
    for (const colour of [key.sun, key.hemiSky, key.hemiGround, key.skyHorizon, key.skyZenith])
      chroma(colour).forEach((channel, i) => expect(channel).toBeCloseTo(tint[i]!, 12));
    expect(key.night).toBe(0);
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
  it('preserves exposure and tint through night-level overrides, adaptation and cinematic look changes', () => {
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
    const water = createWaterUniforms();
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
      rain: { intensity: { value: 0 }, windX: { value: 0 }, windZ: { value: 0 }, center: { value: new Vector3() } },
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
        expect(luma(displayed)).toBeCloseTo(lunar().exposure!, 12);
        chroma(displayed).forEach((channel, i) =>
          expect(channel).toBeCloseTo(chroma(new Color(...lunar().tint))[i]!, 12),
        );
        expect(mapLight.currentWeight).toBe(0);
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
      expect(luma(sprites.light.value.clone().multiply(frame.exposure.value))).toBeCloseTo(lunar().exposure!, 12);
      state.environment.weather = 'clear';
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
      mapLight.dispose();
      hd.nodes.dispose();
    }
  });
});
