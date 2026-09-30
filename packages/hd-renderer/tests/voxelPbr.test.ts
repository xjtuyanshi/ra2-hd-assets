import { describe, expect, it, vi } from 'vitest';
import { DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { lights } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import { voxelPbrFor, voxelPbrLookupTexture, voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { ra2VoxelClass, VOXEL_CLASS_ID } from '../src/ra2/voxelClasses';
import { buildSmoothPartGeometry } from '../src/ra2/voxelSmoothGeometry';
import { smoothVoxelOptions } from '../src/ra2/voxelSmooth';
import { instantiateVoxel } from '../src/ra2/voxels';
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
  it('isolates uniforms/materials by atmosphere and disposes owned GPU resources', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const palette = new Uint8Array(768);
    const m = voxelPbrMaterialFor(palette, a);
    const dispose = vi.spyOn(m, 'dispose');
    expect(voxelPbrMaterialFor(palette, a)).toBe(m);
    expect(voxelPbrMaterialFor(palette, b)).not.toBe(m);
    voxelPbrFor(a).wear.value = 0.9;
    expect(voxelPbrFor(b).wear.value).toBe(0.5);
    a.dispose();
    b.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it.each([false, true])('generates shaders with sun/sky and painter depth without a GPU (WebGL=%s)', (forceWebGL) => {
    const nodes = new AtmosphereNodes();
    const material = voxelPbrMaterialFor(null, nodes);
    const geometry = buildSmoothPartGeometry([syntheticSection(2, true)], smoothVoxelOptions({ aoRays: 0 }));
    const unit = instantiateVoxel([{ role: 'body', turretOffset: 0, geometry, material }], material);
    const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
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
    builder.build();
    expect(builder.fragmentShader).toContain('voxelValueNoise');
    expect(builder.fragmentShader).toContain('directSpecular');
    expect(builder.fragmentShader).toContain('radiance');
    expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
    expect(builder.vertexShader).toContain('vpos');
    geometry.dispose();
    nodes.dispose();
  });
});

it('parses remaster geometry and shader parameters without changing engine defaults', () => {
  expect(voxelLookParams(new URLSearchParams()).voxelLook).toBe('engine');
  const params = new URLSearchParams(
    'vlook=remaster&vsmooth=supersample:2,shape:occupancy,groundOcclusion:false,bandOut:0.1&vk=wear:0.8,brightness:1.1,unknown:2,aoStrength:NaN',
  );
  const options = voxelLookParams(params);
  expect(options.voxelLook).toBe('remaster');
  expect(options.smoothVoxel).toMatchObject({
    supersample: 2,
    shape: 'occupancy',
    groundOcclusion: false,
    bandOut: 0.1,
  });
  const nodes = new AtmosphereNodes();
  const hd = { nodes, settings: {} } as HdRenderer;
  applyLookParams(hd, params, {} as RenderState);
  expect(voxelPbrFor(nodes).wear.value).toBe(0.8);
  expect(voxelPbrFor(nodes).brightness.value).toBe(1.1);
  expect(voxelPbrFor(nodes).aoStrength.value).toBe(0.8);
  expect(hd.settings.voxelLook).toBe('remaster');
  nodes.dispose();
});
