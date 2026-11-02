import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
  type Material,
} from 'three/webgpu';
import { lights, uniform, vec3 } from 'three/tsl';
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
import { voxelReflectionColour } from '../src/ra2/voxelReflectionColour';
import { buildVoxelGeometry, instantiateVoxel, VoxelUnit } from '../src/ra2/voxels';
import {
  meshVehicleLook,
  vehicleLookWeight,
  voxelLightingFor,
  voxelLookFinish,
  voxelMaterialFor,
  voxelMeshGains,
  voxelProjectedMaterialFor,
  voxelReflectionFinish,
} from '../src/ra2/vpl';
import type { ShaderNode } from '../src/tsl';
import { createScenario } from '../sandbox/scenario';
import { syntheticSection } from './fixtures/syntheticVoxels';
import type { VoxelModel } from '../../ra2-assets/src/manifest';

/**
 * Vehicle-only look gains (HdSettings.vehicleSunGain / vehicleSpecularSize / vehicleAoPower / vehicleExposure /
 * vehicleGradeBalance / vehicleTopGain). The cinematic look's scene gains and display grade were calibrated on terrain
 * and buildings; measured against the original's frozen frames they drew vehicle hulls cooler than the original and
 * their light top decks towards white. The vehicles therefore take their own gains, and nothing else may change with
 * them: not terrain, building sprites or infantry, and not buildings' voxel turrets, which keep the scene's gains and
 * no vehicle finish so they cannot part from the sprite body they stand on.
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

describe('vehicle finish wiring', () => {
  it('keeps the vehicle finish neutral in every debug view, and follows the night fade and airless maps', () => {
    const hd = headlessRenderer();
    const frame = hd as unknown as LookUpdater & {
      nightDisplay: { value: number };
      updateGrade(airless: boolean): void;
    };
    const voxels = voxelLightingFor(hd.nodes);
    const finish = () => [voxels.exposure.value, voxels.topGain.value, ...voxels.whiteBalance.value.toArray()];
    try {
      applyLookPreset(hd.settings, 'cinematic');
      frame.lighting.sunArc = true;
      frame.lighting.update(16.5, 0);
      frame.updateGrade(false);
      frame.updateSpriteLook(1, 0);
      const day = vehicleBalanceGain(hd.settings.gradeBalance, 1, CINEMATIC.gradeBalance).toArray();
      expect(finish()).toEqual([CINEMATIC.exposure, CINEMATIC.topGain, ...day]);
      // Debug views draw raw encodings (voxel normals, palette index, occlusion) or diagnostics: no exposure, top gain
      // or balance on them. The light gains stay the vehicles' (the debug encodings do not read them).
      for (const view of ['voxel-xy', 'voxel-z', 'overbright', 'silhouette'] as const) {
        hd.settings.debugView = view;
        frame.updateSpriteLook(1, 0);
        expect(finish()).toEqual([1, 1, 1, 1, 1]);
        expect([voxels.sunGain.value, voxels.specularSize.value, voxels.aoPower.value]).toEqual([1.25, 1.6, 1.5]);
        expect(vehicleLookGains(hd.settings, true)).toMatchObject({ exposure: 1, gradeBalance: 1, topGain: 1 });
      }
      hd.settings.debugView = 'none';
      // Night: the grade fades out of the display (nightDisplay), and the balance correction with it.
      frame.nightDisplay.value = 0.6;
      frame.updateSpriteLook(1, 0);
      const night = voxels.whiteBalance.value.toArray();
      expect(night).toEqual(vehicleBalanceGain(hd.settings.gradeBalance, 0.4, CINEMATIC.gradeBalance).toArray());
      expect(Math.abs(Math.log(night[2]! / night[1]!))).toBeLessThan(Math.abs(Math.log(day[2]! / day[1]!)));
      expect([voxels.exposure.value, voxels.topGain.value]).toEqual([CINEMATIC.exposure, CINEMATIC.topGain]);
      frame.nightDisplay.value = 1;
      frame.updateSpriteLook(1, 0);
      expect(voxels.whiteBalance.value.toArray()).toEqual([1, 1, 1]);
      // Airless maps: the grade keeps a neutral balance, so there is nothing to divide out; exposure and top gain stay.
      frame.nightDisplay.value = 0;
      frame.updateGrade(true);
      frame.updateSpriteLook(1, 0);
      expect(finish()).toEqual([CINEMATIC.exposure, CINEMATIC.topGain, 1, 1, 1]);
      frame.updateGrade(false);
      frame.updateSpriteLook(1, 0);
      expect(voxels.whiteBalance.value.toArray()).toEqual(day);
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

/**
 * The uniform nodes a material's fragment and vertex shaders read (no browser or device needed). `draw` replaces the
 * drawn material (a water reflection twin's colour graph of `material`) on the same voxel geometry.
 */
function uniformNodes(material: Material, nodes: AtmosphereNodes, draw?: Material): unknown[] {
  const parts = buildVoxelGeometry(model, null, nodes);
  parts[0]!.material = material as never;
  const unit = instantiateVoxel([parts[0]!], material as never, nodes);
  const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
  if (draw) mesh.material = draw;
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

type VoxelKind = 'engine' | 'remaster' | 'projected';

function voxelMaterial(kind: VoxelKind, nodes: AtmosphereNodes): Material {
  const palette = new Uint8Array(768);
  const texture = () => nodes.own(new DataTexture(new Uint8Array(320 * 32 * 4), 320, 32));
  return kind === 'engine'
    ? voxelMaterialFor(palette, nodes)
    : kind === 'remaster'
      ? voxelPbrMaterialFor(palette, nodes)
      : voxelProjectedMaterialFor(palette, createVoxelProjectionPart(manifest(), 'body', texture(), texture()), nodes);
}

/**
 * CPU value of a small TSL expression of constants and uniforms (the finish and gain selections below): enough node
 * kinds to evaluate them exactly as written, and an error for anything else.
 */
function evaluate(node: unknown): number[] {
  const n = node as Record<string, unknown> & {
    value?: unknown;
    node?: unknown;
    aNode?: unknown;
    bNode?: unknown;
    cNode?: unknown;
  };
  if (n.isConstNode || n.isUniformNode) {
    const v = n.value as number | { isColor?: boolean; r: number; g: number; b: number; toArray(): number[] };
    if (typeof v === 'number') return [v];
    return v.isColor ? [v.r, v.g, v.b] : v.toArray();
  }
  const width = (a: number[], b: number[]) => Math.max(a.length, b.length);
  const at = (v: number[], i: number) => (v.length === 1 ? v[0]! : v[i]!);
  const each = (args: number[][], f: (...x: number[]) => number) => {
    const size = Math.max(...args.map((a) => a.length));
    return Array.from({ length: size }, (_, i) => f(...args.map((a) => at(a, i))));
  };
  if (n.isSplitNode) {
    const v = evaluate(n.node);
    return [...(n.components as string)].map((c) => v['xyzw'.includes(c) ? 'xyzw'.indexOf(c) : 'rgba'.indexOf(c)]!);
  }
  if (n.isConvertNode) {
    const v = evaluate(n.node);
    const size = { float: 1, vec2: 2, vec3: 3, color: 3, vec4: 4 }[n.convertTo as string] ?? v.length;
    return v.length === 1 ? Array<number>(size).fill(v[0]!) : v.slice(0, size);
  }
  if (n.isJoinNode) return (n.nodes as unknown[]).flatMap(evaluate);
  if (n.isVarNode) return evaluate(n.node);
  if (n.isOperatorNode) {
    const a = evaluate(n.aNode);
    const b = evaluate(n.bNode);
    const f = { '*': (x: number, y: number) => x * y, '+': (x: number, y: number) => x + y }[n.op as string];
    if (!f || width(a, b) < 1) throw new Error(`operator ${String(n.op)}`);
    return each([a, b], f);
  }
  if (n.isMathNode) {
    const [a, b, c] = [n.aNode, n.bNode, n.cNode].map((x) => (x ? evaluate(x) : []));
    switch (n.method) {
      case 'mix':
        return each([a!, b!, c!], (x, y, t) => x * (1 - t) + y * t);
      case 'smoothstep':
        return each([a!, b!, c!], (e0, e1, x) => {
          const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
          return t * t * (3 - 2 * t);
        });
      case 'step':
        return each([a!, b!], (edge, x) => (x < edge ? 0 : 1));
      case 'max':
        return each([a!, b!], Math.max);
      case 'dot':
        return [a!.reduce((sum, x, i) => sum + x * b![i]!, 0)];
    }
  }
  throw new Error(`cannot evaluate ${String((n as { type?: string }).type ?? Object.keys(n))}`);
}

describe('vehicle look gains in the voxel shaders', () => {
  it.each(['engine', 'remaster', 'projected'] as const)(
    'the %s voxel material reads the voxel gains, selected per drawn mesh against the scene gains',
    (kind) => {
      const nodes = new AtmosphereNodes();
      const look = spriteLookFor(nodes);
      const voxels = voxelLightingFor(nodes);
      const used = uniformNodes(voxelMaterial(kind, nodes), nodes);
      // The exposure, white balance, top gain and AO power reach every voxel material; the sun and highlight gains
      // every lit one. Each gain is the drawn mesh's choice (meshVehicleLook) between the vehicles' and the scene's.
      for (const node of [voxels.exposure, voxels.whiteBalance, voxels.topGain, meshVehicleLook])
        expect(used).toContain(node);
      for (const key of ['sunGain', 'specularSize', 'aoPower'] as const) {
        expect(used).toContain(voxels[key]);
        expect(used).toContain(look[key]);
      }
      nodes.dispose();
    },
  );

  it.each(['engine', 'remaster', 'projected'] as const)(
    "the %s voxel material's water reflection takes exposure and white balance, never the top gain",
    (kind) => {
      const nodes = new AtmosphereNodes();
      const voxels = voxelLightingFor(nodes);
      const material = voxelMaterial(kind, nodes);
      const reflection = new MeshBasicNodeMaterial();
      reflection.colorNode = voxelReflectionColour(material, uniform(new Matrix4()));
      const used = uniformNodes(material, nodes, reflection);
      for (const node of [voxels.exposure, voxels.whiteBalance, meshVehicleLook]) expect(used).toContain(node);
      expect(used).not.toContain(voxels.topGain);
      nodes.dispose();
    },
  );

  it('darkens upward-facing surfaces by the top gain, leaves sides alone and finishes nothing in debug-neutral gains', () => {
    const nodes = new AtmosphereNodes();
    const voxels = voxelLightingFor(nodes);
    const colour = vec3(0.4, 0.3, 0.2) as ShaderNode;
    const finished = (normal: [number, number, number]) =>
      evaluate(voxelLookFinish(colour, voxels, vec3(...normal) as ShaderNode));
    try {
      voxels.exposure.value = 1.04;
      voxels.topGain.value = 0.75;
      voxels.whiteBalance.value.setRGB(1, 1, 1);
      const up = finished([0, 1, 0]);
      const side = finished([1, 0, 0]);
      const down = finished([0, -1, 0]);
      const tilted = finished([0.6, 0.8, 0]);
      [0.4, 0.3, 0.2].forEach((c, i) => {
        expect(up[i]).toBeCloseTo(c * 1.04 * 0.75, 12);
        expect(side[i]).toBeCloseTo(c * 1.04, 12);
        expect(down[i]).toBeCloseTo(c * 1.04, 12);
        // Between the start (n.y 0.6) and full weight (0.95): part of the gain.
        expect(tilted[i]).toBeLessThan(c * 1.04);
        expect(tilted[i]).toBeGreaterThan(c * 1.04 * 0.75);
      });
      // The reflection finish never applies the top gain.
      expect(evaluate(voxelReflectionFinish(colour, voxels))).toEqual(side);
      // Neutral gains (faithful branch, debug views) give the colour back exactly.
      voxels.exposure.value = 1;
      voxels.topGain.value = 1;
      expect(finished([0, 1, 0])).toEqual(evaluate(colour));
    } finally {
      nodes.dispose();
    }
  });
});

describe("buildings' voxel turrets keep the scene's look", () => {
  it('marks a building part on its meshes and their water twins; vehicles stay vehicles', () => {
    const nodes = new AtmosphereNodes();
    try {
      const make = () => {
        const parts = buildVoxelGeometry(model, null, nodes);
        return instantiateVoxel(parts, voxelMaterialFor(new Uint8Array(768), nodes) as never, nodes).root;
      };
      const vehicle = make();
      const turret = make();
      turret.setBuildingPart(true);
      expect(vehicle.buildingPart).toBe(false);
      expect(turret.buildingPart).toBe(true);
      const meshes = (root: VoxelUnit) => {
        const all: Mesh[] = [];
        root.traverse((o) => o instanceof Mesh && all.push(o));
        return all;
      };
      // Every drawn mesh of the turret (parts, shadow, foam and reflection twins) reads 0, every vehicle mesh 1.
      expect(meshes(turret).length).toBeGreaterThan(turret.partMeshes.length);
      for (const mesh of meshes(turret)) expect(vehicleLookWeight(mesh)).toBe(0);
      for (const mesh of meshes(vehicle)) expect(vehicleLookWeight(mesh)).toBe(1);
      expect(vehicleLookWeight(null)).toBe(1);
    } finally {
      nodes.dispose();
    }
  });

  it('gives a building turret mesh the scene gains and no finish, a vehicle mesh its own', () => {
    const nodes = new AtmosphereNodes();
    const look = spriteLookFor(nodes);
    const voxels = voxelLightingFor(nodes);
    const gains = voxelMeshGains(voxels, look);
    const colour = vec3(0.4, 0.3, 0.2) as ShaderNode;
    const up = vec3(0, 1, 0) as ShaderNode;
    const weight = meshVehicleLook as unknown as { value: number };
    try {
      Object.assign(look.sunGain, { value: 1.25 });
      Object.assign(look.specularSize, { value: 1.6 });
      Object.assign(look.aoPower, { value: 1.5 });
      voxels.sunGain.value = 0.7;
      voxels.specularSize.value = 2.2;
      voxels.aoPower.value = 0.5;
      voxels.exposure.value = 1.04;
      voxels.topGain.value = 0.75;
      voxels.whiteBalance.value.setRGB(1.05, 1, 0.9);
      weight.value = 0;
      // Exactly the scene's values: the selection returns them unchanged, so the turret matches its sprite base.
      expect([gains.sunGain, gains.specularSize, gains.aoPower].map((g) => evaluate(g)[0])).toEqual([1.25, 1.6, 1.5]);
      expect(evaluate(voxelLookFinish(colour, voxels, up))).toEqual(evaluate(colour));
      expect(evaluate(voxelReflectionFinish(colour, voxels))).toEqual(evaluate(colour));
      weight.value = 1;
      expect([gains.sunGain, gains.specularSize, gains.aoPower].map((g) => evaluate(g)[0])).toEqual([0.7, 2.2, 0.5]);
      evaluate(voxelLookFinish(colour, voxels, up)).forEach((v, i) =>
        expect(v).toBeCloseTo([0.4, 0.3, 0.2][i]! * [1.05, 1, 0.9][i]! * 1.04 * 0.75, 12),
      );
    } finally {
      weight.value = 1;
      nodes.dispose();
    }
  });
});
