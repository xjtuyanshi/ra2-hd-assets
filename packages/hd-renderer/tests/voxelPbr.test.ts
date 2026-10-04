import { describe, expect, it, vi } from 'vitest';
import { DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { lights } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import { VOXEL_PBR_DEFAULTS, voxelPbrFor, voxelPbrLookupTexture, voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { ra2VoxelClass, VOXEL_CLASS_ID } from '../src/ra2/voxelClasses';
import { buildSmoothPartGeometry } from '../src/ra2/voxelSmoothGeometry';
import { smoothVoxelOptions } from '../src/ra2/voxelSmooth';
import { instantiateVoxel, updateVoxelNativeDepth } from '../src/ra2/voxels';
import { syntheticSection } from './fixtures/syntheticVoxels';
import { applyLookParams, voxelLookParams } from '../sandbox/look';
import type { HdRenderer } from '../src/HdRenderer';
import type { RenderState } from '../src/contract';

describe('remaster palette material', () => {
  it('encodes raw palette bytes, material class IDs, emissive and the spare row independently', () => {
    const palette = Uint8Array.from({ length: 768 }, (_, i) => (i * 17) % 256);
    const lut = voxelPbrLookupTexture(palette);
    const bytes = lut.image.data as Uint8Array;
    expect(lut.image.width).toBe(256);
    expect(lut.image.height).toBe(3);
    for (let i = 0; i < 256; i++) {
      expect(Array.from(bytes.subarray(i * 4, i * 4 + 3))).toEqual(Array.from(palette.subarray(i * 3, i * 3 + 3)));
      const p = ra2VoxelClass(i, ...(Array.from(palette.subarray(i * 3, i * 3 + 3)) as [number, number, number]));
      expect(bytes[(256 + i) * 4 + 2]).toBe(VOXEL_CLASS_ID[p.kind]);
      expect(bytes[(256 + i) * 4]).toBe(Math.round(p.roughness * 255));
      expect(bytes[(256 + i) * 4 + 1]).toBe(Math.round(p.metalness * 255));
      expect(bytes[(256 + i) * 4 + 3]).toBe(Math.round(p.emissive * 255));
    }
    expect(bytes.subarray(512 * 4).every((v) => v === 0)).toBe(true);
    for (const [index, kind] of [
      [16, 'house'],
      [31, 'house'],
      [32, 'metal'],
      [47, 'metal'],
      [48, 'dark'],
      [56, 'dark'],
      [57, 'rubber'],
      [63, 'rubber'],
      [64, 'paint'],
      [160, 'rubber'],
      [168, 'paint'],
      [199, 'paint'],
      [203, 'paint'],
      [240, 'light'],
      [255, 'light'],
      [12, 'metal'],
      [15, 'paint'],
    ] as const)
      expect(ra2VoxelClass(index, 255, 255, 255).kind).toBe(kind);
    lut.dispose();
  });
  it.each([
    ['paint', [15, 64, 176, 199, 200, 203], 0.45, 0.15, 0],
    ['house', [16, 31], 0.38, 0.1, 0],
    ['metal', [12, 14, 32, 47], 0.42, 0.12, 0],
    ['dark', [48, 56], 0.5, 0.35, 0],
    ['rubber', [57, 63, 160, 167], 0.9, 0, 0],
    ['light', [240, 255], 0.3, 0.1, 0.6],
  ] as const)(
    'uses painted armour and matte tracks while retaining lights: %s',
    (kind, indices, roughness, metalness, emissive) => {
      for (const index of indices)
        expect(ra2VoxelClass(index, 255, 255, 255)).toEqual({ kind, roughness, metalness, emissive });
    },
  );
  it('isolates uniforms/materials by atmosphere and disposes owned GPU resources', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const palette = new Uint8Array(768);
    const m = voxelPbrMaterialFor(palette, a);
    const dispose = vi.spyOn(m, 'dispose');
    expect(voxelPbrMaterialFor(palette, a)).toBe(m);
    expect(voxelPbrMaterialFor(palette, b)).not.toBe(m);
    voxelPbrFor(a).wear.value = 0.9;
    expect(voxelPbrFor(b).wear.value).toBe(0.2);
    for (const knob of [
      'shadeSmooth',
      'edgeLight',
      'tread',
      'treadPeriod',
      'treadHeight',
      'dust',
      'streaks',
    ] as const) {
      voxelPbrFor(a)[knob].value = 0;
      expect(voxelPbrFor(b)[knob].value).toBe(VOXEL_PBR_DEFAULTS[knob]);
    }
    const dustSrgb = voxelPbrFor(b).dustColour.value.clone().convertLinearToSRGB();
    // Three's transfer functions approximate the inverse; tolerate their sub-byte round-trip error.
    expect(dustSrgb.r).toBeCloseTo(0.55, 4);
    expect(dustSrgb.g).toBeCloseTo(0.48, 4);
    expect(dustSrgb.b).toBeCloseTo(0.38, 4);
    voxelPbrFor(a).dustColour.value.setRGB(0, 0, 0);
    expect(voxelPbrFor(b).dustColour.value.r).toBeGreaterThan(0);
    a.dispose();
    b.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('keeps cloned and copied variants on their source lighting without mutating another atmosphere', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const source = voxelPbrMaterialFor(null, a);
    const other = voxelPbrMaterialFor(null, b);
    const copied = other.clone();
    const otherState = voxelPbrFor(b);
    otherState.brightness.value = 0.73;
    b.sceneObjectMul.value.setRGB(0.2, 0.4, 0.6);
    copied.copy(source);
    const clone = copied.clone();
    for (const variant of [copied, clone]) {
      for (const key of ['ao', 'state', 'look', 'sceneMultiplier']) {
        expect(Reflect.get(source, key)).toBeDefined();
        expect(Reflect.get(variant, key)).toBe(Reflect.get(source, key));
      }
      expect(variant.colorNode).toBe(source.colorNode);
      expect(variant.envNode).toBe(source.envNode);
      expect(variant.normalNode).toBe(source.normalNode);
    }
    voxelPbrFor(a).brightness.value = 1.37;
    expect(Reflect.get(clone, 'state').brightness.value).toBe(1.37);
    expect(Reflect.get(other, 'state')).toBe(otherState);
    expect(otherState.brightness.value).toBe(0.73);
    expect(b.sceneObjectMul.value.toArray()).toEqual([0.2, 0.4, 0.6]);
    copied.dispose();
    clone.dispose();
    a.dispose();
    b.dispose();
  });
  it.each(
    [false, true].flatMap((forceWebGL) =>
      (['physical', 'native-ground', 'translucent'] as const).map((pass) => ({ forceWebGL, pass })),
    ),
  )(
    'generates shaders with sun/sky and painter depth without a GPU ($pass, WebGL=$forceWebGL)',
    ({ forceWebGL, pass }) => {
      const nodes = new AtmosphereNodes();
      const material = voxelPbrMaterialFor(null, nodes);
      const geometry = buildSmoothPartGeometry([syntheticSection(2, true)], smoothVoxelOptions({ aoRays: 0 }));
      const unit = instantiateVoxel([{ role: 'body', turretOffset: 0, geometry, material }], material);
      const mesh = unit.root.partMeshes[0]!;
      if (pass === 'native-ground') updateVoxelNativeDepth(unit, new Vector3());
      if (pass === 'translucent') {
        updateVoxelNativeDepth(unit, new Vector3());
        unit.root.setOpacity(0.5);
      }
      expect(mesh.material === material).toBe(pass === 'physical');
      const sourceDispose = vi.spyOn(material, 'dispose');
      const variantDispose = mesh.material !== material ? vi.spyOn(mesh.material as typeof material, 'dispose') : null;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Only the renderer's CPU compiler is used. No init(), context, browser, device, or rendered-pixel claim.
      const canvas = {
        width: 64,
        height: 64,
        style: {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      };
      const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL });
      vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
      const builder = renderer.backend.createNodeBuilder(mesh, renderer);
      builder.scene = new Scene();
      builder.camera = new PerspectiveCamera();
      builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
      try {
        builder.build();
        // TSL reports lifecycle exceptions and continues building; generated shader text alone misses this failure.
        expect(errors.mock.calls).toEqual([]);
        expect(builder.fragmentShader).toContain('voxelValueNoise');
        expect(builder.fragmentShader).toContain('directSpecular');
        expect(builder.fragmentShader).toContain('radiance');
        expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
        expect(builder.vertexShader).toContain('vpos');
        expect(builder.vertexShader).toContain('pshade');
        expect(builder.fragmentShader).toMatch(/\b(?:dFdx|dpdx)\b/);
        expect(material.normalNode).toBeTruthy();
      } finally {
        errors.mockRestore();
        unit.root.disposeOpacityMaterials();
        expect(sourceDispose).not.toHaveBeenCalled();
        geometry.dispose();
        nodes.dispose();
        expect(sourceDispose).toHaveBeenCalledOnce();
        if (variantDispose) expect(variantDispose).toHaveBeenCalledOnce();
      }
    },
  );
});

it('parses remaster geometry and shader parameters without changing engine defaults', () => {
  expect(voxelLookParams(new URLSearchParams()).voxelLook).toBe('engine');
  const params = new URLSearchParams(
    'vlook=remaster&vsmooth=supersample:2,shape:occupancy,groundOcclusion:false,bandOut:0.1,shadeRadius:2,shadeThreshold:2,shadeRamp:8&vk=wear:0.8,brightness:1.1,shadeSmooth:0.5,edgeLight:0.4,tread:1,treadPeriod:1.2,treadHeight:4,dust:0.6,streaks:0.7,unknown:2,aoStrength:NaN',
  );
  const options = voxelLookParams(params);
  expect(options.voxelLook).toBe('remaster');
  expect(options.smoothVoxel).toMatchObject({
    supersample: 2,
    shape: 'occupancy',
    groundOcclusion: false,
    bandOut: 0.1,
    shadeRadius: 2,
    shadeThreshold: 2,
    shadeRamp: 8,
  });
  const nodes = new AtmosphereNodes();
  const hd = { nodes, settings: {} } as HdRenderer;
  applyLookParams(hd, params, {} as RenderState);
  expect(voxelPbrFor(nodes).wear.value).toBe(0.8);
  expect(voxelPbrFor(nodes).brightness.value).toBe(1.1);
  expect(voxelPbrFor(nodes).aoStrength.value).toBe(0.8);
  for (const [knob, value] of Object.entries({
    shadeSmooth: 0.5,
    edgeLight: 0.4,
    tread: 1,
    treadPeriod: 1.2,
    treadHeight: 4,
    dust: 0.6,
    streaks: 0.7,
  }))
    expect(voxelPbrFor(nodes)[knob as keyof typeof VOXEL_PBR_DEFAULTS].value).toBe(value);
  expect(hd.settings.voxelLook).toBe('remaster');
  nodes.dispose();
});
