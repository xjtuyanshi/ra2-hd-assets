import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three/webgpu';
import type { EffectsLayer } from '../src/effects';
import { LightField, heldPulseEnvelope } from '../src/lightField';
import { LiveEffectsDriver, type LiveEffects } from '../src/live/effects';
import { interpolateSceneLighting, stormStrikeLight } from '../src/live/sceneLighting';
import type { SceneLighting } from '../src/sceneLighting';

const lighting: SceneLighting = {
  ambient: 0.87,
  ground: 0,
  level: 0,
  tint: [1, 0.8, 0.68],
  override: [0.3, 0.4, 0.75],
  event: 'storm',
};
const snapshot: LiveEffects = {
  anims: [{ id: 1, uid: 1, type: 'WCLBOLT1', x: 3 * 256, y: 5 * 256, z: 1490 }],
  bullets: [],
  particleSystems: [],
};

describe('storm strike illumination', () => {
  it('interpolates adjacent numeric state only, switching events or unknown reads immediately', () => {
    const previous = { frame: 1, lighting };
    const next = { frame: 2, lighting: { ...lighting, ambient: 0.8 } };
    expect(interpolateSceneLighting(previous, next, 0.5)?.ambient).toBeCloseTo(0.835);
    expect(interpolateSceneLighting(previous, { ...next, frame: 3 }, 0.5)).toBe(next.lighting);
    const clear = { frame: 2, lighting: { ...lighting, ambient: 1, event: null, override: null } };
    expect(interpolateSceneLighting(previous, clear, 0)).toBe(clear.lighting);
    expect(interpolateSceneLighting(previous, { frame: 2, lighting: null }, 0)).toBeNull();
    expect(interpolateSceneLighting(null, next, 0)).toBe(next.lighting);
  });
  it('holds the local pulse for 120 ms then decays over 350 ms without changing legacy pulse timing', () => {
    const pulse = {
      born: 1,
      x: 3,
      z: 5,
      colour: [1, 1, 1] as [number, number, number],
      peak: 2,
      radius: 4.5,
      life: 0.47,
      decay: 4,
    };
    expect(LightField.pulseIntensity(pulse, 1)).toBe(0.4);
    const held = { ...pulse, envelope: { hold: 0.12, fade: 0.35 } };
    expect(LightField.pulseIntensity(held, 1)).toBe(2);
    expect(LightField.pulseIntensity(held, 1.12)).toBeCloseTo(2);
    expect(LightField.pulseIntensity(held, 1.295)).toBeCloseTo(1);
    expect(LightField.pulseIntensity(held, 1.47)).toBeCloseTo(0);
    expect(heldPulseEnvelope(-1, 0.12, 0.35)).toBe(0);
  });

  it('uses a bounded blue-white pool of 4.5 cells, calibrated against the storm-darkened palette luminance', () => {
    const reference = 3.4;
    const strike = stormStrikeLight(lighting, 4, reference);
    expect(strike.radius).toBe(4.5);
    expect(strike.colour).toEqual([0.68, 0.82, 1]);
    const luminance = (rgb: number[]) => rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    const base = luminance(lighting.override!.map((c) => (c * lighting.ambient) ** 2.2));
    const added = (luminance(strike.colour) * strike.peak) / reference;
    expect(((base + added) / base) ** (1 / 2.2)).toBeCloseTo(1.6);
    expect(strike.peak).toBeLessThan(reference);
    expect(stormStrikeLight({ ...lighting, ambient: 0, ground: 1 }, 0, reference).peak).toBe(0);
  });

  it('triggers each native bolt once, including under shroud, with no dependence on enhanced garnish', () => {
    const driver = new LiveEffectsDriver({ setBeams() {} } as unknown as EffectsLayer, () => true);
    driver.sceneEvent = 'storm';
    driver.garnishEnabled = false;
    const strike = vi.fn();
    driver.onStormStrike = strike;
    driver.push(snapshot, 10, 1, new Vector3());
    driver.push(snapshot, 10, 1.01, new Vector3());
    driver.push(snapshot, 11, 1.02, new Vector3());
    expect(strike).toHaveBeenCalledTimes(1);
    const at = strike.mock.calls[0]![0] as Vector3;
    expect([at.x, at.z]).toEqual([3, 5]);
    expect(driver.skyFlash(1)).toBe(0.12);
    expect(driver.skyFlash(1.08)).toBeCloseTo(0.12);
    expect(driver.skyFlash(1.205)).toBeCloseTo(0.06);
    expect(driver.skyFlash(1.33)).toBeCloseTo(0);
    driver.push({ ...snapshot, anims: [{ ...snapshot.anims[0]!, uid: 2, type: 'WCLBOLT3' }] }, 12, 1.1, new Vector3());
    expect(strike).toHaveBeenCalledTimes(2);
    expect(driver.skyFlash(1.1)).toBe(0.12);
    driver.sceneEvent = 'nuke';
    expect(driver.skyFlash(1.11)).toBe(0);
    driver.push({ ...snapshot, anims: [{ ...snapshot.anims[0]!, uid: 3 }] }, 13, 1.12, new Vector3());
    expect(strike).toHaveBeenCalledTimes(2);
    driver.sceneEvent = 'storm';
    expect(driver.skyFlash(1.13)).toBe(0);
    driver.push(snapshot, 1, 1.14, new Vector3());
    expect(strike).toHaveBeenCalledTimes(3);
  });
});
