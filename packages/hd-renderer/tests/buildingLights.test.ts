import { describe, expect, it, vi } from 'vitest';
import { Mesh, Vector3 } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { EffectsLayer } from '../src/effects';
import {
  buildingLightArcs,
  buildingLightPlacements,
  buildingLightSources,
  BUILDING_LIGHTS,
} from '../src/live/buildingLights';
import { LiveEffectsDriver } from '../src/live/effects';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import type { LightField } from '../src/lightField';
import { LEVEL_HEIGHT } from '../src/world';

const reactor: LiveObject = {
  id: 10,
  uid: 42,
  type: 'NAPOWR',
  kind: 'building',
  owner: 0,
  x: 5 * 256 + 100,
  y: 7 * 256 + 20,
  z: 2 * 104,
  health: 1,
  facingRaw: 0,
  isSelected: false,
  buildState: 'done',
};
const foundation = (): [number, number] => [3, 2];
const select = (objects: LiveObject[] = [reactor], gain = 1) =>
  buildingLightSources(objects, { sourceLights: gain }, foundation, () => false);

function disposeMeshes(root: Mesh['parent']) {
  root?.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
      if ('dispose' in o && typeof o.dispose === 'function') o.dispose();
    }
  });
}

describe('building light policy', () => {
  it('places the orb at the foundation centre, above the snapshot ground height, with a full foundation hole', () => {
    const light = buildingLightPlacements('NAPOWR', reactor, [3, 2])[0]!;
    expect(light).toMatchObject({ x: 6.5, z: 8, hole: [1.5, 1], holeOffset: [0, 0], key: 'building:42:0' });
    expect(light.groundY).toBeCloseTo(2 * LEVEL_HEIGHT);
    expect(light.head).toBeCloseTo((44 / 15) * LEVEL_HEIGHT);
    expect(light.headPosition.toArray()).toEqual([light.x, light.groundY + light.head!, light.z]);
    expect(buildingLightPlacements('UNKNOWN', reactor, [3, 2])).toEqual([]);
  });

  it('keeps the exclusion rectangle centred on the foundation for an off-centre table entry', () => {
    BUILDING_LIGHTS.TEST = [{ ...BUILDING_LIGHTS.NAPOWR![0]!, at: [0.25, 0.75] }];
    try {
      const light = buildingLightPlacements('TEST', reactor, [4, 2])[0]!;
      expect(light).toMatchObject({ x: 6, z: 8.5, hole: [2, 1], holeOffset: [1, -0.5] });
      expect(light.x + light.holeOffset![0]).toBe(7);
      expect(light.z + light.holeOffset![1]).toBe(8);
    } finally {
      delete BUILDING_LIGHTS.TEST;
    }
  });

  it('creates nothing at zero gain, without querying foundations or visibility', () => {
    const size = vi.fn(foundation);
    const hidden = vi.fn(() => false);
    expect(buildingLightSources([reactor], { sourceLights: 0 }, size, hidden)).toEqual([]);
    expect(size).not.toHaveBeenCalled();
    expect(hidden).not.toHaveBeenCalled();
  });

  it('filters dead, shrouded, constructing, selling, non-building and unknown-foundation objects', () => {
    expect(
      select([
        { ...reactor, health: 0 },
        { ...reactor, buildState: 'building' },
        { ...reactor, buildState: 'selling' },
        { ...reactor, kind: 'vehicle' },
      ]),
    ).toEqual([]);
    expect(buildingLightSources([reactor], { sourceLights: 1 }, foundation, () => true)).toEqual([]);
    expect(
      buildingLightSources(
        [reactor],
        { sourceLights: 1 },
        () => undefined,
        () => false,
      ),
    ).toEqual([]);
    expect(select([{ ...reactor, buildState: undefined }])).toHaveLength(1);
  });

  it('scales both irradiance and glow by gain and the damaged multiplier', () => {
    const normal = select()[0]!;
    const damaged = select([{ ...reactor, health: 0.4 }], 2)[0]!;
    for (let c = 0; c < 3; c++) {
      expect(damaged.colour[c]).toBeCloseTo(normal.colour[c]! * 2 * 0.6);
      expect(damaged.glow![c]).toBeCloseTo(normal.glow![c]! * 2 * 0.6);
    }
    expect(select([{ ...reactor, health: 0.9, buildingDamaged: true }])[0]!.colour[2]).toBeCloseTo(2.6 * 0.6);
  });

  it('refreshes in the live presentation and clears the enhanced layer on a faithful switch', () => {
    const source = vi.fn();
    const clearSources = vi.fn();
    const setDecorativeBeams = vi.fn();
    const settings = { sourceLights: 0 };
    const view = Object.assign(Object.create(LiveView.prototype), {
      hd: { settings, seconds: () => 2, lightField: { source, clearSources } },
      library: { type: () => ({ foundation: foundation() }), conditionYellow: 0.5 },
      shroud: { isLocationShrouded: () => false },
      effectDriver: { setDecorativeBeams },
      sourceLightsActive: false,
    }) as { updateBuildingLights(snapshot: LiveSnapshot): void };
    const snapshot: LiveSnapshot = { frame: 10, view: null, objects: [reactor], houses: [] };
    view.updateBuildingLights(snapshot);
    expect(source).not.toHaveBeenCalled();
    expect(setDecorativeBeams).not.toHaveBeenCalled();
    settings.sourceLights = 1;
    view.updateBuildingLights(snapshot);
    view.updateBuildingLights(snapshot);
    expect(source).toHaveBeenCalledTimes(2);
    expect(source.mock.calls[0]![0]).toBe('building:42:0');
    expect(setDecorativeBeams.mock.calls[0]![1]).toHaveLength(3);
    settings.sourceLights = 0;
    view.updateBuildingLights(snapshot);
    expect(clearSources).toHaveBeenCalledTimes(1);
    expect(setDecorativeBeams).toHaveBeenLastCalledWith(2, []);
  });
});

describe('decorative source arcs', () => {
  it('is deterministic, stable for two logic frames and within the short downward reach', () => {
    const lights = select();
    const first = buildingLightArcs(lights, 10);
    expect(first).toHaveLength(3);
    expect(first).toEqual(buildingLightArcs(lights, 10));
    expect(first).toEqual(buildingLightArcs(lights, 11));
    expect(first).not.toEqual(buildingLightArcs(lights, 12));
    expect(buildingLightArcs([{ ...lights[0]!, key: 'other' }], 10)).not.toEqual(first);
    expect(buildingLightArcs([{ ...lights[0]!, arcs: 0 }], 10)).toEqual([]);
    for (const beam of first) {
      expect(beam.bolt).toBe(true);
      expect(beam.flash).toBe(false);
      expect(beam.to.distanceTo(beam.from)).toBeGreaterThanOrEqual(0.5);
      expect(beam.to.distanceTo(beam.from)).toBeLessThanOrEqual(1.1);
      expect(beam.to.y).toBeLessThan(beam.from.y);
    }
  });

  it('appends to native beams without extra flash lights or impact garnish, and preserves the native beams when removed', () => {
    const nodes = new AtmosphereNodes();
    const effects = new EffectsLayer(nodes);
    const pulse = vi.fn();
    effects.attachLightField({ pulse } as unknown as LightField);
    const setBeams = vi.spyOn(effects, 'setBeams');
    const driver = new LiveEffectsDriver(effects, () => false);
    const arcs = buildingLightArcs(select(), 10);
    try {
      driver.push(
        {
          anims: [],
          bullets: [],
          particleSystems: [],
          beams: [
            { kind: 'laser', colour: [255, 0, 0], source: { x: 0, y: 0, z: 0 }, target: { x: 256, y: 256, z: 0 } },
          ],
        },
        10,
        1,
        new Vector3(),
      );
      expect(pulse).toHaveBeenCalledTimes(1);
      const native = setBeams.mock.calls[0]![1][0]!;
      driver.setDecorativeBeams(1, arcs);
      expect(setBeams).toHaveBeenLastCalledWith(1, [native, ...arcs], false);
      expect(pulse).toHaveBeenCalledTimes(1);
      driver.setDecorativeBeams(1.1, buildingLightArcs(select(), 11));
      expect(setBeams).toHaveBeenCalledTimes(2);
      driver.setDecorativeBeams(1.2, []);
      expect(setBeams).toHaveBeenLastCalledWith(1.2, [native], false);
      effects.enhancedBeams = true;
      const halo = (effects as unknown as { halo: { spawn: (...args: unknown[]) => void } }).halo;
      const spawn = vi.spyOn(halo, 'spawn');
      effects.setBeams(2, arcs);
      expect(pulse).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      effects.setBeams(2, [native, ...arcs]);
      expect(pulse).toHaveBeenCalledTimes(2);
    } finally {
      disposeMeshes(effects.root);
      nodes.dispose();
    }
  });
});
