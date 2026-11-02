import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
  type Material,
} from 'three/webgpu';
import { lights } from 'three/tsl';
import { HdRenderer, LOOK_PRESETS, applyLookPreset, vehicleLookGains, type HdSettings } from '../src/HdRenderer';
import { AtmosphereNodes } from '../src/atmosphere';
import { Lighting } from '../src/lighting';
import { bindSlots } from '../src/materialSlots';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { createVoxelProjectionPart } from '../src/ra2/voxelProjection';
import type { VoxelProjectionManifest } from '../src/ra2/voxelProjectionMath';
import { voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { buildVoxelGeometry, instantiateVoxel } from '../src/ra2/voxels';
import { voxelLightingFor, voxelMaterialFor, voxelProjectedMaterialFor } from '../src/ra2/vpl';
import { createScenario } from '../sandbox/scenario';
import { syntheticSection } from './fixtures/syntheticVoxels';
import type { VoxelModel } from '../../ra2-assets/src/manifest';

/**
 * Vehicle-only look gains (HdSettings.vehicleSunGain / vehicleSpecularSize / vehicleAoPower / vehicleExposure).
 * The cinematic look's scene gains were calibrated on terrain and buildings; measured against the original's frozen
 * frames they pushed light vehicle top faces towards white (a wider, 2.56x stronger glint and a 1.25x sun on the
 * projected redraws). The vehicles therefore take their own gains, and nothing else may change with them.
 */

const SCENE_GAINS = ['sunGain', 'specularSize', 'aoPower', 'contactShade', 'shadowLength', 'shadowDarkness'] as const;

function headlessRenderer(): HdRenderer {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return new HdRenderer(canvas, createScenario(2, 2));
}

type LookUpdater = { lighting: Lighting; updateSpriteLook(scale: number, wetness: number): void };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('vehicle look gains', () => {
  it('lets only the cinematic look light vehicles apart; the other looks follow the scene gains', () => {
    const cinematic = LOOK_PRESETS.cinematic.settings;
    // The scene gains stay the approved terrain / building calibration.
    expect(cinematic).toMatchObject({ sunGain: 1.25, specularSize: 1.6, aoPower: 1.5 });
    // Vehicles: the scene's sun weight and AO power, a much smaller highlight (1.1 instead of 1.6: glint intensity
    // x1.21 instead of x2.56) and a small exposure that returns the hull median the wider glint used to supply.
    expect(cinematic).toMatchObject({ vehicleSunGain: null, vehicleAoPower: null });
    expect(vehicleLookGains(cinematic as HdSettings, true)).toEqual({
      sunGain: 1.25,
      specularSize: 1.1,
      aoPower: 1.5,
      exposure: 1.08,
    });
    for (const preset of ['faithful', 'golden'] as const) {
      const settings = LOOK_PRESETS[preset].settings as HdSettings;
      expect(settings).toMatchObject({
        vehicleSunGain: null,
        vehicleSpecularSize: null,
        vehicleAoPower: null,
        vehicleExposure: 1,
      });
      expect(vehicleLookGains(settings, true)).toEqual({
        sunGain: settings.sunGain,
        specularSize: settings.specularSize,
        aoPower: settings.aoPower,
        exposure: 1,
      });
    }
    // The faithful branch (no enhanced effect on) is neutral whatever a look asks for.
    expect(vehicleLookGains(cinematic as HdSettings, false)).toEqual({
      sunGain: 1,
      specularSize: 1,
      aoPower: 1,
      exposure: 1,
    });
  });

  it('writes the vehicle gains to the voxel uniforms and leaves every sprite / terrain look uniform as it was', () => {
    const hd = headlessRenderer();
    const frame = hd as unknown as LookUpdater;
    const look = spriteLookFor(hd.nodes);
    const voxels = voxelLightingFor(hd.nodes);
    try {
      applyLookPreset(hd.settings, 'cinematic');
      frame.lighting.sunArc = true;
      frame.lighting.update(16.5, 0);
      frame.updateSpriteLook(1, 0);
      expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value, voxels.exposure.value]).toEqual([
        1.25, 1.1, 1.5, 1.08,
      ]);
      // Every numeric and colour uniform of the sprite look (terrain, buildings, infantry, relighting), bit for bit.
      const snapshot = () =>
        Object.entries(look).flatMap(([key, value]) => {
          const v = (value as { value?: unknown })?.value;
          if (typeof v === 'number') return [[key, v]];
          if (v && typeof (v as { toArray?: unknown }).toArray === 'function')
            return [[key, (v as { toArray(): number[] }).toArray()]];
          return [];
        });
      const before = snapshot();
      SCENE_GAINS.forEach((key) => expect(look[key].value).toBe(LOOK_PRESETS.cinematic.settings[key]));
      Object.assign(hd.settings, {
        vehicleSunGain: 0.7,
        vehicleSpecularSize: 2.2,
        vehicleAoPower: 0.5,
        vehicleExposure: 1.3,
      });
      frame.updateSpriteLook(1, 0);
      expect(snapshot()).toEqual(before);
      expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value, voxels.exposure.value]).toEqual([
        0.7, 2.2, 0.5, 1.3,
      ]);
      // null follows the scene gains (golden), and faithful is neutral for vehicles as for everything else.
      applyLookPreset(hd.settings, 'golden');
      frame.updateSpriteLook(1, 0);
      expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value, voxels.exposure.value]).toEqual([
        1, 1, 1, 1,
      ]);
      hd.settings.sunGain = 1.4;
      frame.updateSpriteLook(1, 0);
      expect(voxels.sunGain.value).toBe(1.4);
      applyLookPreset(hd.settings, 'faithful');
      Object.assign(hd.settings, { vehicleSunGain: 2, vehicleSpecularSize: 2, vehicleAoPower: 2, vehicleExposure: 2 });
      frame.updateSpriteLook(1, 0);
      expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value, voxels.exposure.value]).toEqual([
        1, 1, 1, 1,
      ]);
    } finally {
      hd.nodes.dispose();
    }
  });
});

const model: VoxelModel = {
  id: 'HTNK',
  palette: 'unit',
  normalsMode: 4,
  turretOffset: 48,
  parts: (['body', 'turret', 'barrel'] as const).map((role) => ({ role, sections: [syntheticSection(2, true)] })),
};

function manifest(): VoxelProjectionManifest {
  const part = (name: string) => ({
    colour: `HTNK_${name}.png`,
    paint: `HTNK_${name}_paint.png`,
    size: [320, 32] as [number, number],
    frames: Array.from({ length: 16 }, (_, i) => ({
      k: i * 2,
      facing: i * 16,
      pivot: [i * 20 + 8, 24] as [number, number],
      rect: [i * 20 + 1, 1, 16, 16] as [number, number, number, number],
    })),
  });
  return {
    version: 1,
    type: 'HTNK',
    frames: 16,
    facingStep: 16,
    scale: 1.5,
    jacobian: [
      [180, 0, -180],
      [90, -220.45407, 90],
    ],
    house: { first: 16, count: 16 },
    parts: { body: part('body'), turret: part('turret') },
    registration: [],
  };
}

/** The uniform nodes a material's fragment and vertex shaders read (no browser or device needed). */
function uniformNodes(material: Material, nodes: AtmosphereNodes): unknown[] {
  const parts = buildVoxelGeometry(model, null, nodes);
  parts[0]!.material = material as never;
  const unit = instantiateVoxel([parts[0]!], material as never, nodes);
  const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
  const renderer = new WebGPURenderer({
    canvas: {
      width: 64,
      height: 64,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    } as unknown as HTMLCanvasElement,
  });
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
  bindSlots(material);
  const builder = renderer.backend.createNodeBuilder(mesh, renderer);
  builder.scene = new Scene();
  builder.camera = new PerspectiveCamera();
  builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
  builder.build();
  return [...builder.uniforms.vertex, ...builder.uniforms.fragment].flatMap((entry) => {
    const node = entry.node as unknown as { node?: unknown };
    return [entry.node, node.node];
  });
}

describe('vehicle look gains in the voxel shaders', () => {
  it.each(['engine', 'remaster', 'projected'] as const)(
    'the %s voxel material reads the voxel gains, never the sprite look gains',
    (kind) => {
      const nodes = new AtmosphereNodes();
      const look = spriteLookFor(nodes);
      const voxels = voxelLightingFor(nodes);
      const palette = new Uint8Array(768);
      const texture = () => nodes.own(new DataTexture(new Uint8Array(320 * 32 * 4), 320, 32));
      const material =
        kind === 'engine'
          ? voxelMaterialFor(palette, nodes)
          : kind === 'remaster'
            ? voxelPbrMaterialFor(palette, nodes)
            : voxelProjectedMaterialFor(
                palette,
                createVoxelProjectionPart(manifest(), 'body', texture(), texture()),
                nodes,
              );
      const used = uniformNodes(material, nodes);
      // The exposure and AO power reach every voxel material; the sun and highlight gains every lit one.
      expect(used).toContain(voxels.exposure);
      expect(used).toContain(voxels.aoPower);
      expect(used).toContain(voxels.sunGain);
      expect(used).toContain(voxels.specularSize);
      for (const key of ['sunGain', 'specularSize', 'aoPower'] as const) expect(used).not.toContain(look[key]);
      nodes.dispose();
    },
  );
});
