import { describe, expect, it } from 'vitest';
import { CircleGeometry, Color, DataTexture, InstancedMesh, PlaneGeometry } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { Lighting } from '../src/lighting';
import { buildRain, buildSnow, RAIN_LOOK, SNOW_LOOK } from '../src/weather';
import { PIXELS_PER_CELL_EDGE } from '../src/world';

describe('decorative precipitation dimensions', () => {
  it('allocates thin visible rain and 2..4 px ground rings at native game scale', () => {
    const nodes = new AtmosphereNodes();
    const height = new DataTexture();
    const rain = buildRain(48, 48, height, 0, nodes);
    try {
      const streaks = rain.object.getObjectByName('rain-streaks') as InstancedMesh<PlaneGeometry>;
      const splashes = rain.object.getObjectByName('rain-splashes') as InstancedMesh<CircleGeometry>;
      expect(streaks.count).toBe(12000);
      expect(streaks.geometry.parameters.width).toBeGreaterThanOrEqual(0.02);
      expect(streaks.geometry.parameters.width).toBeLessThanOrEqual(0.03);
      const lengths = RAIN_LOOK.length.map((length) => length * streaks.geometry.parameters.height);
      expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0.55);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(0.85);
      expect(RAIN_LOOK.dayOpacity[0]).toBeGreaterThanOrEqual(0.22);
      expect(RAIN_LOOK.dayOpacity[1]).toBeLessThanOrEqual(0.4);
      expect(splashes.count).toBe(3500);
      // Projection preserves the ring's horizontal diameter; its ground-plane vertical axis is foreshortened.
      const diameters = RAIN_LOOK.splashScale.map(
        (scale) => splashes.geometry.parameters.radius * 2 * scale * PIXELS_PER_CELL_EDGE,
      );
      expect(Math.min(...diameters)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...diameters)).toBeLessThanOrEqual(4);
      expect(RAIN_LOOK.splashOpacity).toBeGreaterThanOrEqual(0.8);
    } finally {
      rain.dispose();
      height.dispose();
      nodes.dispose();
    }
  });

  it('uses three ordered snow size/speed/sway layers with rare larger near flakes and a white daytime floor', () => {
    const nodes = new AtmosphereNodes();
    const height = new DataTexture();
    const snow = buildSnow(48, 48, height, 0, nodes);
    try {
      const flakes = snow.object.getObjectByName('snow-flakes') as InstancedMesh<PlaneGeometry>;
      expect(flakes.count).toBe(9000);
      expect(flakes.geometry.parameters.width).toBe(1);
      expect(flakes.geometry.parameters.height).toBe(1);
      expect(SNOW_LOOK.layers).toHaveLength(3);
      for (const [index, layer] of SNOW_LOOK.layers.entries()) {
        expect(layer.size[0]).toBeGreaterThanOrEqual(0.04);
        expect(layer.size[1]).toBeLessThanOrEqual(0.09);
        expect(layer.size[1]).toBeGreaterThan(layer.size[0]);
        if (index > 0) {
          const previous = SNOW_LOOK.layers[index - 1]!;
          for (const key of ['size', 'speed', 'sway'] as const)
            expect(layer[key][0]).toBeGreaterThanOrEqual(previous[key][1]);
        }
      }
      expect(SNOW_LOOK.largeSize[0]).toBeGreaterThanOrEqual(0.09);
      expect(SNOW_LOOK.largeSize[1]).toBeLessThanOrEqual(0.12);
      expect(SNOW_LOOK.largeFractionOfNear * 0.15).toBeLessThanOrEqual(0.02);
      expect(Math.min(...SNOW_LOOK.dayColour) * SNOW_LOOK.dayBrightnessFloor).toBeGreaterThanOrEqual(0.9);
      // Original maps apply a channel-wise noon exposure before tone mapping; retain the floor through that step.
      const lighting = new Lighting(48, 48);
      lighting.update(12, 0);
      const noon = lighting.flatIrradianceColor(new Color()).toArray();
      const exposedFloor = SNOW_LOOK.dayColour.map(
        (channel, index) => (channel * SNOW_LOOK.dayBrightnessFloor * Math.PI) / noon[index]!,
      );
      expect(Math.min(...exposedFloor)).toBeGreaterThanOrEqual(0.9);
      expect(SNOW_LOOK.dayOpacity[0]).toBeGreaterThanOrEqual(0.8);
      expect(SNOW_LOOK.dayOpacity[1]).toBeLessThanOrEqual(1);
    } finally {
      snow.dispose();
      height.dispose();
      nodes.dispose();
    }
  });

  it('starts disabled without changing the supplied atmosphere uniforms', () => {
    const nodes = new AtmosphereNodes();
    nodes.night.value = 0.35;
    nodes.sceneBrightness.value = 0.63;
    nodes.sceneLevel.value.setRGB(0.8, 0.7, 0.6);
    const height = new DataTexture();
    const rain = buildRain(48, 48, height, 0, nodes);
    const snow = buildSnow(48, 48, height, 0, nodes);
    try {
      for (const system of [rain, snow]) {
        expect(system.intensity.value).toBe(0);
        expect(system.object.visible).toBe(false);
      }
      expect(nodes.night.value).toBe(0.35);
      expect(nodes.sceneBrightness.value).toBe(0.63);
      expect(nodes.sceneLevel.value.toArray()).toEqual([0.8, 0.7, 0.6]);
    } finally {
      rain.dispose();
      snow.dispose();
      height.dispose();
      nodes.dispose();
    }
  });
});
