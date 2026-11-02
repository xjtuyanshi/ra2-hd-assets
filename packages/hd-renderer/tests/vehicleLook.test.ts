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
import {
  HdRenderer,
  LOOK_PRESETS,
  applyLookPreset,
  vehicleBalanceGain,
  vehicleLookGains,
  type HdSettings,
} from '../src/HdRenderer';
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
 * Vehicle-only look gains (HdSettings.vehicleSunGain / vehicleSpecularSize / vehicleAoPower / vehicleExposure /
 * vehicleGradeBalance / vehicleTopGain). The cinematic look's scene gains and display grade were calibrated on terrain
 * and buildings; measured against the original's frozen frames they drew vehicle hulls cooler than the original and
 * their light top decks towards white. The vehicles therefore take their own gains, and nothing else may change with
 * them.
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
type GradeUniforms = Record<string, { value: number | { toArray(): number[] } }> & {
  gradeBalance: { value: { fromArray(a: readonly number[]): unknown; toArray(): number[] } };
};
const grade = (hd: HdRenderer) => (hd as unknown as { gradeUniforms: GradeUniforms }).gradeUniforms;
const gradeSnapshot = (hd: HdRenderer) =>
  Object.entries(grade(hd)).map(([key, u]) => [key, typeof u.value === 'number' ? u.value : u.value.toArray()]);

/** The cinematic look's vehicle finish (policy; see LOOK_PRESETS.cinematic). */
const CINEMATIC = { exposure: 1.04, gradeBalance: 0, topGain: 0.75 };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('vehicle look gains', () => {
  it('lets only the cinematic look light vehicles apart; the other looks follow the scene gains', () => {
    const cinematic = LOOK_PRESETS.cinematic.settings;
    // The scene gains stay the approved terrain / building calibration.
    expect(cinematic).toMatchObject({ sunGain: 1.25, specularSize: 1.6, aoPower: 1.5 });
    // Vehicles: the scene's sun weight, highlight size and AO power, without the grade's cool balance, with dimmer
    // upward faces and a small exposure that returns the hull median.
    expect(cinematic).toMatchObject({ vehicleSunGain: null, vehicleSpecularSize: null, vehicleAoPower: null });
    expect(vehicleLookGains(cinematic as HdSettings, true)).toEqual({
      sunGain: 1.25,
      specularSize: 1.6,
      aoPower: 1.5,
      exposure: CINEMATIC.exposure,
      gradeBalance: CINEMATIC.gradeBalance,
      topGain: CINEMATIC.topGain,
    });
    for (const preset of ['faithful', 'golden'] as const) {
      const settings = LOOK_PRESETS[preset].settings as HdSettings;
      expect(settings).toMatchObject({
        vehicleSunGain: null,
        vehicleSpecularSize: null,
        vehicleAoPower: null,
        vehicleExposure: 1,
        vehicleGradeBalance: 1,
        vehicleTopGain: 1,
      });
      expect(vehicleLookGains(settings, true)).toEqual({
        sunGain: settings.sunGain,
        specularSize: settings.specularSize,
        aoPower: settings.aoPower,
        exposure: 1,
        gradeBalance: 1,
        topGain: 1,
      });
    }
    // The faithful branch (no enhanced effect on) is neutral whatever a look asks for.
    expect(vehicleLookGains(cinematic as HdSettings, false)).toEqual({
      sunGain: 1,
      specularSize: 1,
      aoPower: 1,
      exposure: 1,
      gradeBalance: 1,
      topGain: 1,
    });
  });

  it('divides the display grade balance out of vehicles by their share, keeping grey luminance', () => {
    const luma = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const balance = LOOK_PRESETS.cinematic.settings.gradeBalance;
    const level = luma({ r: balance[0], g: balance[1], b: balance[2] });
    const graded = balance.map((v) => v / level);
    // Share 0: the vehicle gain times the grade's normalised balance is grey (the same factor on every channel).
    const gain = vehicleBalanceGain(balance, 1, 0);
    const product = [gain.r * graded[0]!, gain.g * graded[1]!, gain.b * graded[2]!];
    for (const v of product) expect(v).toBeCloseTo(product[1]!, 12);
    expect(luma(gain)).toBeCloseTo(1, 12);
    expect(gain.b).toBeLessThan(1);
    expect(gain.r).toBeGreaterThan(1);
    // Half the share: half the logarithmic correction.
    const half = vehicleBalanceGain(balance, 1, 0.5);
    expect(Math.log(half.b / half.g)).toBeCloseTo(Math.log(gain.b / gain.g) / 2, 12);
    expect(luma(half)).toBeCloseTo(1, 12);
    // Share 1, no grade in the display (weight 0) and a neutral balance (airless maps) leave vehicles as they are.
    for (const c of [
      vehicleBalanceGain(balance, 1, 1),
      vehicleBalanceGain(balance, 0, 0),
      vehicleBalanceGain([1, 1, 1], 1, 0),
    ])
      expect(c.toArray()).toEqual([1, 1, 1]);
    // The grade fades at night; the correction fades with it.
    const dusk = vehicleBalanceGain(balance, 0.5, 0);
    expect(Math.log(dusk.b / dusk.g)).toBeCloseTo(Math.log(gain.b / gain.g) / 2, 12);
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
        1.25,
        1.6,
        1.5,
        CINEMATIC.exposure,
      ]);
      expect(voxels.topGain.value).toBe(CINEMATIC.topGain);
      // The renderer's grade uniform (set by applySettings) decides the vehicle balance; applied here by hand.
      grade(hd).gradeBalance.value.fromArray(hd.settings.gradeBalance);
      frame.updateSpriteLook(1, 0);
      expect(voxels.whiteBalance.value.toArray()).toEqual(
        vehicleBalanceGain(hd.settings.gradeBalance, 1, CINEMATIC.gradeBalance).toArray(),
      );
      const gradeBefore = gradeSnapshot(hd);
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
        vehicleGradeBalance: 0.25,
        vehicleTopGain: 0.6,
      });
      frame.updateSpriteLook(1, 0);
      expect(snapshot()).toEqual(before);
      // The display grade itself (terrain, buildings, infantry and the HUD-free scene) is untouched.
      expect(gradeSnapshot(hd)).toEqual(gradeBefore);
      expect(voxels.topGain.value).toBe(0.6);
      expect(voxels.whiteBalance.value.toArray()).toEqual(
        vehicleBalanceGain(hd.settings.gradeBalance, 1, 0.25).toArray(),
      );
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
      Object.assign(hd.settings, {
        vehicleSunGain: 2,
        vehicleSpecularSize: 2,
        vehicleAoPower: 2,
        vehicleExposure: 2,
        vehicleGradeBalance: 0,
        vehicleTopGain: 2,
      });
      frame.updateSpriteLook(1, 0);
      expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value, voxels.exposure.value]).toEqual([
        1, 1, 1, 1,
      ]);
      expect(voxels.topGain.value).toBe(1);
      expect(voxels.whiteBalance.value.toArray()).toEqual([1, 1, 1]);
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
      // The exposure, white balance, top gain and AO power reach every voxel material; the sun and highlight gains
      // every lit one.
      expect(used).toContain(voxels.exposure);
      expect(used).toContain(voxels.whiteBalance);
      expect(used).toContain(voxels.topGain);
      expect(used).toContain(voxels.aoPower);
      expect(used).toContain(voxels.sunGain);
      expect(used).toContain(voxels.specularSize);
      for (const key of ['sunGain', 'specularSize', 'aoPower'] as const) expect(used).not.toContain(look[key]);
      nodes.dispose();
    },
  );
});
