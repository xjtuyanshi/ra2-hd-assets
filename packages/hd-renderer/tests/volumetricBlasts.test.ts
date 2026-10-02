import { describe, expect, it, vi } from 'vitest';
import {
  Color,
  Data3DTexture,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Mesh,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  generateBlastNoise,
  VolumetricBlastLayer,
  VOLUMETRIC_BLAST_PRESETS,
  type VolumetricBlast,
} from '../src/volumetricBlasts';

describe('volume noise and bounded renderer', () => {
  it('generates deterministic RGBA8 with exact periodic boundary slices on all axes', () => {
    const size = 24;
    const a = generateBlastNoise(123, size);
    expect(a).toEqual(generateBlastNoise(123, size));
    expect(a).not.toEqual(generateBlastNoise(124, size));
    expect(a.length).toBe(size ** 3 * 4);
    const at = (x: number, y: number, z: number, c: number) => a[((z * size + y) * size + x) * 4 + c];
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++)
        for (let c = 0; c < 4; c++) {
          expect(at(0, i, j, c)).toBe(at(size - 1, i, j, c));
          expect(at(i, 0, j, c)).toBe(at(i, size - 1, j, c));
          expect(at(i, j, 0, c)).toBe(at(i, j, size - 1, c));
        }
    for (let c = 0; c < 4; c++) {
      const channel = a.filter((_, i) => i % 4 === c);
      expect(Math.max(...channel) - Math.min(...channel)).toBeGreaterThan(100);
    }
  });
  const layer = () =>
    new VolumetricBlastLayer({
      capacity: 2,
      light: uniform(new Color(1, 1, 1)),
      sunDirection: uniform(new Vector3(0, 1, 0)),
    });
  it('bounds capacity, copies snapshot data, uploads projection only and releases owned resources', () => {
    const l = layer();
    const b: VolumetricBlast = {
      anchor: new Vector3(1, 0, 2),
      radius: 1,
      progress0: 0,
      t0: 0,
      rate: 1,
      lifeSeconds: 1,
      seed: 77,
      style: VOLUMETRIC_BLAST_PRESETS.fireball,
      fade: 1,
    };
    l.setBlasts([b, b, b]);
    expect(l.stats().count).toBe(2);
    const mesh = l.root.children[0] as Mesh;
    expect(mesh.renderOrder).toBe(7);
    expect(mesh.material).toMatchObject({ transparent: true, depthTest: true, depthWrite: false });
    const data = (l as unknown as { data: { version: number; array: Float32Array } }).data;
    b.anchor.set(9, 9, 9);
    l.update(0.2, new Vector3(1, 0, 0), new Vector3(0, 0.8, -0.6), new Vector3(0, 0.6, 0.8));
    expect(Array.from(data.array.slice(0, 3))).toEqual([1, 0, 2]);
    const version = data.version;
    l.update(0.2, l.cameraRight.value, l.cameraUp.value, l.toCamera.value);
    expect(data.version).toBe(version);
    expect(data.array[27]).toBeGreaterThan(0);
    const noise = (l as unknown as { noise: Data3DTexture }).noise;
    expect(noise.image).toMatchObject({ width: 64, height: 64, depth: 64 });
    expect(noise.image.data.length).toBe(64 ** 3 * 4);
    expect(noise).toMatchObject({
      format: RGBAFormat,
      type: UnsignedByteType,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      wrapR: RepeatWrapping,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
    const releaseNoise = vi.spyOn(noise, 'dispose');
    const releaseMaterial = vi.spyOn(mesh.material as import('three/webgpu').MeshBasicNodeMaterial, 'dispose');
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    l.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(releaseNoise).toHaveBeenCalledOnce();
    expect(releaseMaterial).toHaveBeenCalledOnce();
    expect(l.stats().count).toBe(0);
  });
  it.each([false, true])(
    'generates bounded shaders with 3D reads without a browser/device (WebGL=%s)',
    (forceWebGL) => {
      const l = layer();
      const mesh = l.root.children[0] as Mesh;
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
      vi.spyOn(renderer, 'hasCompatibility').mockReturnValue(false);
      const builder = renderer.backend.createNodeBuilder(mesh, renderer);
      builder.scene = new Scene();
      builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      builder.build();
      expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
      expect(builder.fragmentShader).toMatch(/(?:textureSampleLevel|textureLod)/);
      expect(builder.fragmentShader).toMatch(/(?:texture_3d|sampler3D)/);
      expect(builder.fragmentShader).toMatch(/< 28/);
      expect(builder.fragmentShader).toContain('break;');
      // Three volume taps per step (base noise, fbm octave, soot pocket); self-shadowing is analytic, because two
      // extra density taps toward the sun tripled the per-step cost on the 20-blast benchmark.
      expect(builder.fragmentShader.match(/(?:textureSampleLevel|textureLod)\(/g)).toHaveLength(3);
      expect(builder.getAttributesArray().length).toBeLessThanOrEqual(16);
      const buffers = new Set(
        builder.getAttributesArray().map((a) => {
          const attribute = a.node?.attribute ?? mesh.geometry.getAttribute(a.name);
          return 'data' in attribute ? attribute.data : attribute;
        }),
      );
      expect(buffers.size).toBeLessThanOrEqual(8);
      l.dispose();
    },
  );
});
