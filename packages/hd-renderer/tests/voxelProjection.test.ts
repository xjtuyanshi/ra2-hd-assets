import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { lights, positionGeometry, uniform, vec3 } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import { bindSlots, hasSlotBinder } from '../src/materialSlots';
import {
  facingFromMatrix,
  parseVoxelProjectionIndex,
  parseVoxelProjectionManifest,
  projectVoxelPoint,
  projectionFramePair,
  type VoxelProjectionManifest,
} from '../src/ra2/voxelProjectionMath';
import {
  createVoxelProjectionPart,
  PROJECTION_TABLE_FRAMES,
  VoxelProjectionInputs,
  manifestPartsFor,
  projectionParts,
  voxelProjectionFor,
  voxelProjectionLibrary,
} from '../src/ra2/voxelProjection';
import { voxelLightingFor, voxelMaterialFor, voxelProjectedMaterialFor } from '../src/ra2/vpl';
import { voxelPbrFor, voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import {
  VOXEL_REFLECTION_AMBIENT,
  VOXEL_REFLECTION_TINT,
  voxelReflectionColour,
} from '../src/ra2/voxelReflectionColour';
import { buildVoxelGeometry, instantiateVoxel, projectVoxelMaterials, updateVoxelNativeDepth } from '../src/ra2/voxels';
import { buildSmoothVoxelGeometry } from '../src/ra2/voxelSmoothGeometry';
import { syntheticSection } from './fixtures/syntheticVoxels';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { HdRenderer } from '../src/HdRenderer';
import type { HdWorld } from '../src/ra2/world';
import type { Ra2Cache } from '../src/ra2/cache';
import { voxelLookParams } from '../sandbox/look';
import { selectVoxelTurretModel } from '../src/ra2/voxelTurrets';

function manifest(turret = true): VoxelProjectionManifest {
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
    parts: { body: part('body'), ...(turret ? { turret: part('turret') } : {}) },
    registration: [],
  };
}

function turretManifest(type = 'X:turret'): VoxelProjectionManifest {
  const spec = manifest();
  return { ...spec, type, parts: { turret: spec.parts.turret! } };
}

const model: VoxelModel = {
  id: 'HTNK',
  palette: 'unit',
  normalsMode: 4,
  turretOffset: 48,
  parts: (['body', 'turret', 'barrel'] as const).map((role) => ({ role, sections: [syntheticSection(2, true)] })),
};

const turretModel: VoxelModel = {
  ...model,
  id: 'X:turret',
  parts: model.parts.filter(({ role }) => role !== 'body'),
};

function worldMatrix(facing: number): Matrix4 {
  return new Matrix4().makeRotationY(Math.PI / 2 - (facing * 2 * Math.PI) / 256);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('voxel projection coordinate contract', () => {
  it.each([0, 8, 64, 127.5, 128, 192, 255, 255.75])('gets facing %s from the complete world matrix', (facing) => {
    const m = worldMatrix(facing).scale(new Vector3(2, 0.7, 1.5));
    m.setPosition(66.5, 0.8165, 53.5);
    expect(facingFromMatrix(m.elements)).toBeCloseTo(facing, 10);
  });
  it('includes the parent transform/ground tilt and wraps the last pair towards zero', () => {
    expect(projectionFramePair(255, 32)).toEqual({ k0: 31, k1: 0, w: 0.875 });
    expect(projectionFramePair(-1, 32)).toEqual(projectionFramePair(255, 32));
    expect(projectionFramePair(256, 32)).toEqual({ k0: 0, k1: 1, w: 0 });
    expect(projectionFramePair(252, 32, 0).w).toBe(1);
    expect(projectionFramePair(250, 32, 0).w).toBe(0);
    expect(projectionFramePair(24, 16)).toEqual({ k0: 1, k1: 2, w: 0.5 });
    const parent = new Matrix4().makeRotationFromQuaternion(
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.12),
    );
    const m = parent
      .multiply(worldMatrix(77))
      .scale(new Vector3(1.3, 0.8, 1.1))
      .setPosition(20, 40, 60);
    const axis = new Vector3(1, 0, 0).transformDirection(m);
    const theta = Math.atan2(-axis.z, axis.x);
    expect(facingFromMatrix(m.elements)).toBeCloseTo(((Math.PI / 2 - theta) * 256) / (2 * Math.PI));
  });
  it('projects through pivot + J * R * M with translation excluded and scale/tilt retained', () => {
    const spec = manifest();
    const m = new Matrix4()
      .makeRotationX(0.13)
      .multiply(worldMatrix(53))
      .scale(new Vector3(2, 0.8, 1.3));
    m.setPosition(66.5, 0.8165, 53.5);
    const frame = spec.parts.body!.frames[6]!;
    const local: [number, number, number] = [0.4, 0.15, -0.22];
    const translated = new Vector3(...local).applyMatrix4(m).sub(new Vector3().setFromMatrixPosition(m));
    const theta = Math.atan2(-m.elements[2]!, m.elements[0]!);
    translated.applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2 - (frame.facing * 2 * Math.PI) / 256 - theta);
    const expected = spec.jacobian.map((j, i) => frame.pivot[i]! + new Vector3(...j).dot(translated));
    const result = projectVoxelPoint(local, m.elements, frame, spec.jacobian);
    result.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 10));
    expect(projectVoxelPoint([0, 0, 0], m.elements, frame, spec.jacobian)).toEqual(frame.pivot);
  });
});

describe('projection manifest validation', () => {
  it('accepts civilian and turreted sets with out-of-rect pivots', () => {
    expect(parseVoxelProjectionManifest(manifest(), ['body', 'turret']).frames).toBe(16);
    const civilian = manifest(false);
    civilian.house = null;
    expect(parseVoxelProjectionManifest(civilian).house).toBeNull();
  });
  it('accepts turret-only manifests when requested and still requires body by default', () => {
    const spec = turretManifest();
    expect(parseVoxelProjectionManifest(spec, ['turret'])).toBe(spec);
    expect(parseVoxelProjectionManifest(spec, [])).toBe(spec);
    expect(() => parseVoxelProjectionManifest(spec)).toThrow('Missing projection part: body');
  });
  it('requires at least one known part even without requested parts', () => {
    const spec = { ...manifest(), parts: {} };
    expect(() => parseVoxelProjectionManifest(spec, [])).toThrow('Missing projection part');
    expect(() => parseVoxelProjectionManifest({ ...spec, parts: { barrel: manifest().parts.turret } }, [])).toThrow(
      'Unknown projection part: barrel',
    );
  });
  it.each([
    { type: 'NAFLAK:turret', required: ['turret'] },
    { type: 'HTNK', required: ['body'] },
    { type: 'HTNK:turret-extra', required: ['body'] },
  ])('requires the manifest parts implied by type $type', ({ type, required }) => {
    expect(manifestPartsFor(type)).toEqual(required);
  });
  it('rejects missing parts, incomplete/nonuniform facing sets, and duplicate bake IDs', () => {
    expect(() => parseVoxelProjectionManifest(manifest(false), ['body', 'turret'])).toThrow('Missing projection part');
    const missing = manifest();
    delete missing.parts.body;
    expect(() => parseVoxelProjectionManifest(missing)).toThrow('Missing projection part');
    const short = manifest();
    short.parts.body!.frames.pop();
    expect(() => parseVoxelProjectionManifest(short)).toThrow('Incomplete');
    const spacing = manifest();
    spacing.parts.body!.frames[1]!.facing = 8;
    expect(() => parseVoxelProjectionManifest(spacing)).toThrow('uniformly');
    const duplicates = manifest();
    duplicates.parts.body!.frames[1]!.k = 0;
    expect(() => parseVoxelProjectionManifest(duplicates)).toThrow('duplicate');
  });
  it('accepts a page exposure of 1 to 4 and leaves older manifests without one', () => {
    const spec = manifest();
    expect(parseVoxelProjectionManifest(spec).exposure).toBeUndefined();
    expect(parseVoxelProjectionManifest({ ...spec, exposure: 1.6 }).exposure).toBe(1.6);
    for (const exposure of [0.5, 4.5, NaN, '1.6', null])
      expect(() => parseVoxelProjectionManifest({ ...spec, exposure })).toThrow('exposure');
  });
  it('rejects invalid dimensions, geometry values and escaping asset paths', () => {
    const bad = manifest();
    bad.parts.body!.frames[0]!.rect = [319, 0, 16, 16];
    expect(() => parseVoxelProjectionManifest(bad)).toThrow('outside');
    bad.parts.body!.colour = '../secret.png';
    expect(() => parseVoxelProjectionManifest(bad)).toThrow('path');
    const nan = manifest();
    nan.jacobian[0][0] = NaN;
    expect(() => parseVoxelProjectionManifest(nan)).toThrow('Jacobian');
    expect(() => parseVoxelProjectionIndex({ version: 2, types: {} })).toThrow('version');
    expect(() => parseVoxelProjectionIndex({ version: 1, types: { HTNK: '/HTNK.json' } })).toThrow('path');
  });
  it('keeps default loading opt-in for both sandbox entry points', () => {
    expect(voxelLookParams(new URLSearchParams()).voxelProjection).toBeUndefined();
    expect(voxelLookParams(new URLSearchParams('vlook=remaster&vproj=vehicles-hd'))).toMatchObject({
      voxelLook: 'remaster',
      voxelProjection: '/vehicles-hd',
    });
  });
});

describe('projected materials and shader compilation', () => {
  it('assigns a turret-only atlas material to both turret and barrel geometry', () => {
    const nodes = new AtmosphereNodes();
    const spec = turretManifest();
    const turret = createVoxelProjectionPart(spec, 'turret', nodes.own(new Texture()), nodes.own(new Texture()));
    const palette = new Uint8Array(768);
    const parts = buildVoxelGeometry(turretModel, palette, nodes);
    expect(parts.map(({ role }) => role)).toEqual(['turret', 'barrel']);
    expect(projectionParts(parts)).toEqual(['turret']);
    expect(projectVoxelMaterials(parts, palette, { manifest: spec, parts: { turret } }, nodes)).toBe(true);
    const material = voxelProjectedMaterialFor(palette, turret, nodes);
    for (const part of parts) expect(part.material).toBe(material);
    expect(material.depthNode).toBeTruthy();
    nodes.dispose();
  });
  it('caches per palette and projection part/context, with turret and barrel sharing one material', () => {
    const nodes = new AtmosphereNodes(),
      other = new AtmosphereNodes();
    const spec = manifest();
    const make = (name: 'body' | 'turret') =>
      createVoxelProjectionPart(spec, name, nodes.own(new Texture()), nodes.own(new Texture()));
    const body = make('body'),
      turret = make('turret');
    const palette = new Uint8Array(768),
      palette2 = new Uint8Array(768);
    const material = voxelProjectedMaterialFor(palette, body, nodes);
    const dispose = vi.spyOn(material, 'dispose'),
      disposeTexture = vi.spyOn(body.colour, 'dispose');
    expect(voxelProjectedMaterialFor(palette, body, nodes)).toBe(material);
    expect(voxelProjectedMaterialFor(palette2, body, nodes)).not.toBe(material);
    expect(voxelProjectedMaterialFor(palette, turret, nodes)).not.toBe(material);
    expect(voxelProjectedMaterialFor(palette, body, other)).not.toBe(material);
    expect(voxelMaterialFor(palette, nodes)).not.toBe(material);
    const parts = buildVoxelGeometry(model, palette, nodes);
    expect(projectVoxelMaterials(parts, palette, { manifest: spec, parts: { body, turret } }, nodes)).toBe(true);
    expect(parts[1]!.material).toBe(parts[2]!.material);
    expect(parts[0]!.material).toBe(material);
    const original = parts.map((p) => p.material);
    expect(projectVoxelMaterials(parts, palette, { manifest: spec, parts: { body } }, nodes)).toBe(false);
    expect(parts.map((p) => p.material)).toEqual(original);
    voxelProjectionFor(nodes).strength.value = 0;
    expect(voxelProjectionFor(other).strength.value).toBe(1);
    expect(voxelProjectionFor(other).blend.value).toBe(1);
    expect(voxelProjectionFor(other).relight.value).toBe(0);
    // Form light defaults are per atmosphere context too (formShade/formAO/spec/contrast, see VoxelProjectionState).
    voxelProjectionFor(nodes).formShade.value = 0;
    expect(voxelProjectionFor(other).formShade.value).toBe(0.7);
    expect(voxelProjectionFor(other).formAO.value).toBe(0.25);
    expect(voxelProjectionFor(other).spec.value).toBe(0.5);
    expect(voxelProjectionFor(other).contrast.value).toBe(1.15);
    nodes.dispose();
    nodes.dispose();
    other.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('generates shaders without a browser/device: WebGL=%s smooth=%s', (forceWebGL, smooth) => {
    const nodes = new AtmosphereNodes();
    const spec = manifest();
    const texture = () => {
      const atlas = nodes.own(new DataTexture(new Uint8Array(320 * 32 * 4), 320, 32));
      atlas.magFilter = LinearFilter;
      atlas.minFilter = LinearMipmapLinearFilter;
      atlas.generateMipmaps = true;
      return atlas;
    };
    const body = createVoxelProjectionPart(spec, 'body', texture(), texture());
    const material = voxelProjectedMaterialFor(new Uint8Array(768), body, nodes);
    const parts = smooth
      ? buildSmoothVoxelGeometry(model, null, nodes, { aoRays: 0, supersample: 2 })
      : buildVoxelGeometry(model, null, nodes);
    parts[0]!.material = material;
    const unit = instantiateVoxel([parts[0]!], material);
    const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
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
    // What the renderer does before it draws the mesh (Object3D.onBeforeRender): the part's atlases are in the slots.
    bindSlots(material);
    builder.build();
    expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
    expect(builder.fragmentShader).toMatch(/atan/);
    // Frame tables are texel loads of their own texture; each atlas must be read exactly twice.
    for (const atlas of [body.colour, body.paint]) {
      const entry = builder.uniforms.fragment.find((u) => (u.node as unknown as { value: unknown }).value === atlas);
      expect(entry).toBeDefined();
      const reads = new RegExp(
        `\\b(?:texture|textureLod|textureGrad|textureLoad|textureSample(?:Level|Bias|Grad)?)\\(\\s*${entry!.name}\\b`,
        'g',
      );
      expect(builder.fragmentShader.match(reads)).toHaveLength(2);
    }
    expect(material.depthNode).toBeTruthy();
    nodes.dispose();
  });
  /** WebGPU (WGSL) or WebGL2 (GLSL) shaders of a projected body part and of its water reflection twin. */
  const shaders = (spec: VoxelProjectionManifest, forceWebGL = false, turret = false) => {
    const nodes = new AtmosphereNodes();
    const size = spec.parts.body!.size;
    const texture = () => nodes.own(new DataTexture(new Uint8Array(size[0] * size[1] * 4), size[0], size[1]));
    const part = createVoxelProjectionPart(spec, turret ? 'turret' : 'body', texture(), texture());
    const material = voxelProjectedMaterialFor(new Uint8Array(768), part, nodes);
    const parts = buildVoxelGeometry(model, null, nodes);
    parts[0]!.material = material;
    const unit = instantiateVoxel([parts[0]!], material, nodes);
    const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
    const twin = unit.root.children.find((o) => o instanceof Mesh && o.name === 'voxel-reflection') as Mesh;
    const canvas = {
      width: 64,
      height: 64,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
    const build = (object: Mesh) => {
      bindSlots(material);
      const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL });
      vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
      const builder = renderer.backend.createNodeBuilder(object, renderer);
      builder.scene = new Scene();
      builder.camera = new PerspectiveCamera();
      builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
      builder.build();
      return { vertex: builder.vertexShader as string, fragment: builder.fragmentShader as string };
    };
    const out = { main: build(mesh), reflection: build(twin), part };
    nodes.dispose();
    return out;
  };

  it('keeps the page exposure in a slot: 1 for pages stored without headroom', () => {
    const exposed = shaders({ ...manifest(), exposure: 1.625 });
    const plain = shaders(manifest());
    const inputs = new VoxelProjectionInputs();
    inputs.bind(exposed.part);
    expect(inputs.exposure.value).toBe(1.625);
    inputs.bind(plain.part);
    expect(inputs.exposure.value).toBe(1);
    // 1.625 is exact in binary and appears nowhere else in the projected material: the number is not shader text.
    expect(exposed.main.fragment).not.toContain('1.625');
    expect(exposed.main.fragment).toBe(plain.main.fragment);
    expect(exposed.main.fragment).not.toMatch(/\b(?:NaN|undefined)\b/);
  });

  /** A second manifest with the numbers of a real library type: another Jacobian, atlas sizes and an exposure. */
  const otherManifest = (): VoxelProjectionManifest => {
    const part = (name: string, width: number, height: number) => ({
      colour: `X_${name}.png`,
      paint: `X_${name}_paint.png`,
      size: [width, height] as [number, number],
      frames: Array.from({ length: 16 }, (_, i) => ({
        k: i * 2,
        facing: i * 16,
        pivot: [i * 50 + 17.25, 61.5] as [number, number],
        rect: [i * 50 + 2, 3, 44, 97] as [number, number, number, number],
      })),
    });
    return {
      ...manifest(),
      type: 'AEGIS',
      scale: 0.7709090909090909,
      jacobian: [
        [92.5090909090909, 0, -92.5090909090909],
        [46.25454545454545, -113.30003112727272, 46.25454545454545],
      ],
      exposure: 1.6,
      parts: { body: part('body', 832, 1090), turret: part('turret', 960, 1214) },
    };
  };

  it.each([false, true])('generates one shader for every part, whatever its numbers: WebGL=%s', (forceWebGL) => {
    // The library's 92 types each have their own Jacobian and atlas size; two thirds an exposure. As shader text
    // those gave every type its own shader module and render pipeline, compiled when its first unit was drawn.
    const first = shaders(manifest(), forceWebGL);
    const second = shaders(otherManifest(), forceWebGL);
    const turret = shaders(otherManifest(), forceWebGL, true);
    for (const pass of ['main', 'reflection'] as const) {
      expect(second[pass].vertex).toBe(first[pass].vertex);
      expect(second[pass].fragment).toBe(first[pass].fragment);
      expect(turret[pass].fragment).toBe(first[pass].fragment);
    }
    // The numbers are where the shader reads them from once the part is bound.
    const inputs = new VoxelProjectionInputs();
    inputs.bind(second.part);
    expect((inputs.jacobianX.value as Vector3).toArray()).toEqual([92.5090909090909, 0, -92.5090909090909]);
    expect((inputs.jacobianY.value as Vector3).toArray()).toEqual([
      46.25454545454545, -113.30003112727272, 46.25454545454545,
    ]);
    expect(inputs.atlasSize.value).toMatchObject({ x: 832, y: 1090 });
    expect(inputs.exposure.value).toBe(1.6);
    expect(inputs.frameCount.value).toBe(16);
    expect(inputs.facingStep.value).toBe(16);
    expect(inputs.frameAngle.value).toBeCloseTo(Math.PI / 8, 12);
    expect(inputs.colour.value).toBe(second.part.colour);
    expect(inputs.paint.value).toBe(second.part.paint);
    expect(inputs.frameTable.value).toBe(second.part.frameTable);
    const table = second.part.frameTable.image as unknown as { data: Float32Array; width: number; height: number };
    expect([table.width, table.height]).toEqual([PROJECTION_TABLE_FRAMES, 2]);
    expect([...table.data.subarray(3 * 4, 3 * 4 + 2)]).toEqual([167.25, 61.5]);
    expect([...table.data.subarray((PROJECTION_TABLE_FRAMES + 3) * 4, (PROJECTION_TABLE_FRAMES + 3) * 4 + 4)]).toEqual([
      152, 3, 44, 97,
    ]);
  });

  it('keeps a part without house paint apart from one with it (the only structural difference)', () => {
    const house = shaders(manifest());
    const plain = shaders({ ...manifest(), house: null });
    expect(plain.main.fragment).not.toBe(house.main.fragment);
  });

  it('draws every palette and every part with clones of one shader graph, each bound to its own data', () => {
    const nodes = new AtmosphereNodes();
    const texture = () => nodes.own(new DataTexture(new Uint8Array(4), 1, 1));
    const a = createVoxelProjectionPart(manifest(), 'body', texture(), texture());
    const b = createVoxelProjectionPart(otherManifest(), 'turret', texture(), texture());
    const red = new Uint8Array(768).fill(1);
    const blue = new Uint8Array(768).fill(2);
    const materials = [
      voxelProjectedMaterialFor(red, a, nodes),
      voxelProjectedMaterialFor(blue, a, nodes),
      voxelProjectedMaterialFor(red, b, nodes),
    ];
    // three keys a built shader by the material's node graph (customProgramCacheKey: the node instances) and its
    // state: clones of one prototype share both, so a new palette or part builds no shader and no pipeline.
    const key = (material: (typeof materials)[number]) => [
      material.customProgramCacheKey(),
      material.transparent,
      material.depthWrite,
      material.side,
      material.name,
    ];
    for (const material of materials.slice(1)) {
      expect(material).not.toBe(materials[0]);
      expect(key(material)).toEqual(key(materials[0]!));
      expect(material.colorNode).toBe(materials[0]!.colorNode);
      expect(material.emissiveNode).toBe(materials[0]!.emissiveNode);
    }
    expect(materials.every(hasSlotBinder)).toBe(true);
    // The plain palette material and the remaster material are graphs of their own, shared the same way.
    for (const make of [voxelMaterialFor, voxelPbrMaterialFor]) {
      const first = make(red, nodes);
      const second = make(blue, nodes);
      expect(second).not.toBe(first);
      expect(key(second)).toEqual(key(first));
      expect(key(first)[0]).not.toBe(key(materials[0]!)[0]);
    }
    // Binding is what tells the objects apart: build the shader once and watch the slots it reads.
    const parts = buildVoxelGeometry(model, null, nodes);
    const unit = instantiateVoxel([{ ...parts[0]!, material: materials[0]! }], materials[0]!, nodes);
    const mesh = unit.root.partMeshes[0]!;
    const canvas = {
      width: 64,
      height: 64,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
    const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
    vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new PerspectiveCamera();
    builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
    const draw = (material: (typeof materials)[number]) =>
      // The renderer calls the mesh's onBeforeRender with the material it is about to draw.
      (mesh.onBeforeRender as unknown as (...args: unknown[]) => void).call(mesh, null, null, null, null, material);
    draw(materials[0]!);
    builder.build();
    const textures = () =>
      builder.uniforms.fragment
        .map((entry) => (entry.node as unknown as { value: unknown }).value)
        .filter((value) => (value as { isTexture?: boolean })?.isTexture);
    expect(textures()).toEqual(expect.arrayContaining([a.colour, a.paint, a.frameTable]));
    const lookups = (list: unknown[]) =>
      list.filter((value) => (value as DataTexture).isDataTexture && (value as DataTexture).image.width === 256);
    const redLookup = lookups(textures());
    expect(redLookup).toHaveLength(1);
    draw(materials[2]!);
    expect(textures()).toEqual(expect.arrayContaining([b.colour, b.paint, b.frameTable]));
    expect(textures()).not.toContain(a.colour);
    expect(lookups(textures())).toEqual(redLookup);
    draw(materials[1]!);
    expect(textures()).toEqual(expect.arrayContaining([a.colour, a.paint, a.frameTable]));
    expect(lookups(textures())).toHaveLength(1);
    expect(lookups(textures())).not.toEqual(redLookup);
    // A unit's translucent and native-depth variants are clones of its material: same graph, same data.
    updateVoxelNativeDepth(unit, unit.root.position);
    unit.root.setOpacity(0.5);
    const variant = mesh.material as (typeof materials)[number];
    expect(variant).not.toBe(materials[0]);
    expect(variant.colorNode).toBe(materials[0]!.colorNode);
    draw(materials[2]!);
    draw(variant);
    expect(textures()).toEqual(expect.arrayContaining([a.colour, a.paint, a.frameTable]));
    // The water twin mirrors its source part: it binds that part's data, and its material is one for all parts.
    const twin = unit.root.children.find((o) => o instanceof Mesh && o.name === 'voxel-reflection') as Mesh;
    const other = instantiateVoxel([{ ...parts[0]!, material: materials[2]! }], materials[2]!, nodes);
    // Units give their materials the depth node; it is the same node, so the clones still share their graph.
    expect(materials[2]!.depthNode).toBeTruthy();
    expect(materials[2]!.depthNode).toBe(materials[0]!.depthNode);
    expect(key(materials[2]!)).toEqual(key(materials[0]!));
    const otherTwin = other.root.children.find((o) => o instanceof Mesh && o.name === 'voxel-reflection') as Mesh;
    expect(otherTwin.material).toBe(twin.material);
    (otherTwin.onBeforeRender as unknown as () => void)();
    expect(textures()).toEqual(expect.arrayContaining([b.colour, b.paint, b.frameTable]));
    (twin.onBeforeRender as unknown as () => void)();
    expect(textures()).toEqual(expect.arrayContaining([a.colour, a.paint, a.frameTable]));
    unit.root.disposeOpacityMaterials();
    nodes.dispose();
  });
});

describe('voxel reflection source colour', () => {
  it('attenuates ambient albedo without a brightening water tint', () => {
    expect(VOXEL_REFLECTION_AMBIENT).toBeGreaterThanOrEqual(0.45);
    expect(VOXEL_REFLECTION_AMBIENT).toBeLessThanOrEqual(0.6);
    expect(VOXEL_REFLECTION_TINT.every((channel) => channel > 0 && channel <= 1)).toBe(true);
    expect(VOXEL_REFLECTION_TINT[0]).toBeLessThan(VOXEL_REFLECTION_TINT[2]);
  });

  it.each([
    [false, 'engine', 'physical'],
    [true, 'engine', 'physical'],
    [false, 'engine-vpl', 'physical'],
    [true, 'engine-vpl', 'physical'],
    [false, 'remaster', 'physical'],
    [true, 'remaster', 'physical'],
    [false, 'projected', 'physical'],
    [true, 'projected', 'physical'],
    [false, 'projected', 'native-ground'],
    [true, 'projected', 'native-ground'],
    [false, 'projected', 'chrono'],
    [true, 'projected', 'chrono'],
  ] as const)('builds %s WebGL %s %s source colour without the flattened normal matrix', (forceWebGL, look, pass) => {
    const nodes = new AtmosphereNodes();
    const spec = manifest();
    const atlas = () => nodes.own(new DataTexture(new Uint8Array(320 * 32 * 4), 320, 32));
    const projection = createVoxelProjectionPart(spec, 'body', atlas(), atlas());
    const palette = new Uint8Array(768);
    if (look === 'engine-vpl') {
      voxelLightingFor(nodes).loaded = { table: new Uint8Array(256 * 32), sections: 32 };
    }
    const source =
      look === 'projected'
        ? voxelProjectedMaterialFor(palette, projection, nodes)
        : look === 'remaster'
          ? voxelPbrMaterialFor(palette, nodes)
          : voxelMaterialFor(palette, nodes);
    const geometry =
      look === 'remaster'
        ? buildSmoothVoxelGeometry(model, palette, nodes, { aoRays: 0, supersample: 2 })[0]!.geometry
        : buildVoxelGeometry(model, palette, nodes)[0]!.geometry;
    const original = uniform(
      worldMatrix(53)
        .scale(new Vector3(2, 0.8, 1.3))
        .setPosition(20, 0.4, 30),
    );
    const unit = instantiateVoxel([{ role: 'body', geometry, turretOffset: 0 }], source, nodes);
    if (pass !== 'physical') updateVoxelNativeDepth(unit, unit.root.position);
    if (pass === 'chrono') unit.root.setOpacity(0.5);
    const current = unit.root.partMeshes[0]!.material as typeof source;
    if (pass !== 'physical') expect(current).not.toBe(source);
    const material = nodes.own(new MeshBasicNodeMaterial());
    material.colorNode = voxelReflectionColour(current, original);
    // The water twin binds the part it mirrors before it is drawn (VoxelSurfaceMesh.onBeforeRender).
    bindSlots(current);
    // Reflection ripple is allowed to change positionLocal. Atlas coordinates must still read positionGeometry.
    material.positionNode = positionGeometry.add(vec3(0.1, 0, -0.1));
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeScale(1, 0, 1);
    mesh.updateMatrixWorld(true);
    const renderer = new WebGPURenderer({
      canvas: {
        width: 64,
        height: 64,
        style: {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      } as unknown as HTMLCanvasElement,
      forceWebGL,
    });
    vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new PerspectiveCamera();
    builder.build();
    const shader = `${builder.vertexShader}\n${builder.fragmentShader}`;
    expect(shader).not.toMatch(/\b(?:NaN|undefined|modelNormalMatrix|normalMatrix)\b/);
    expect(shader).toContain('voxelReflectionSourceNormal');
    const uniforms = [...builder.uniforms.vertex, ...builder.uniforms.fragment];
    expect(uniforms.some((entry) => (entry.node as unknown as { value: unknown }).value === original.value)).toBe(true);
    if (look === 'remaster') {
      const values = uniforms.map((entry) => (entry.node as unknown as { value: unknown }).value);
      expect(values).toContain(voxelPbrFor(nodes).reflectionSky.value);
      expect(values).toContain(voxelPbrFor(nodes).reflectionGround.value);
      // voxelFill includes direct flat-ground sun. A physical reflection may read only actual hemisphere light.
      expect(values).not.toContain(voxelLightingFor(nodes).voxelFill.value);
    }
    if (look === 'projected') {
      expect(builder.fragmentShader).toMatch(/atan/);
      for (const texture of [projection.colour, projection.paint]) {
        const entry = builder.uniforms.fragment.find(
          (u) => (u.node as unknown as { value: unknown }).value === texture,
        );
        expect(entry).toBeDefined();
        const reads = new RegExp(
          `\\b(?:texture|textureLod|textureGrad|textureLoad|textureSample(?:Level|Bias|Grad)?)\\(\\s*${entry!.name}\\b`,
          'g',
        );
        expect(builder.fragmentShader.match(reads)).toHaveLength(2);
      }
      // The remapped palette lookup remains alongside both atlases; paint never falls back to a flat hull tint.
      expect(
        builder.uniforms.fragment.some((entry) => {
          const texture = (entry.node as unknown as { value: DataTexture }).value;
          return texture?.isDataTexture && texture.image.width === 256;
        }),
      ).toBe(true);
    }
    unit.root.disposeOpacityMaterials();
    geometry.dispose();
    nodes.dispose();
  });
});

function mockAssets(options: { indexMissing?: boolean; missingPaint?: boolean; spec?: VoxelProjectionManifest } = {}) {
  const spec = options.spec ?? manifest();
  const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('index.json'))
      return new Response(JSON.stringify({ version: 1, types: { [spec.type]: 'model.json' } }), {
        status: options.indexMissing ? 404 : 200,
      });
    if (url.endsWith('model.json')) return new Response(JSON.stringify(spec));
    return new Response('', { status: options.missingPaint && url.endsWith('_paint.png') ? 404 : 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 320, height: 32, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
  return { fetchMock, bitmaps };
}

describe('projection loading and disposal', () => {
  it('fetches the index/type once, shares textures and disposes bitmaps with the atmosphere', async () => {
    const { fetchMock, bitmaps } = mockAssets();
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    expect(voxelProjectionLibrary('/vehicles-hd/', nodes)).toBe(library);
    const [a, b] = await Promise.all([library.loadType('HTNK'), library.loadType('HTNK')]);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const body = a!.parts.body!;
    expect(body.colour.flipY).toBe(false);
    expect(body.colour.generateMipmaps).toBe(true);
    const dispose = vi.spyOn(body.colour, 'dispose');
    nodes.dispose();
    nodes.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
    expect(await library.loadType('HTNK')).toBeNull();
  });
  it("loads turret-only assets while checking each caller's required parts", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchMock, bitmaps } = mockAssets({ spec: turretManifest() });
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    const asset = await library.loadType('X:turret', ['turret']);
    expect(asset).not.toBeNull();
    expect(asset!.parts.body).toBeUndefined();
    expect(asset!.parts.turret).toBeDefined();
    expect(library.get('X:turret', ['turret'])).toBe(asset);
    expect(library.get('X:turret', ['body'])).toBeNull();
    expect(await library.loadType('X:turret', ['body'])).toBeNull();
    expect(await library.loadType('X:turret', ['turret'])).toBe(asset);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledOnce();
    nodes.dispose();
    expect(bitmaps).toHaveLength(2);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('rejects a vehicle manifest without body even when the caller only requests turret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchMock, bitmaps } = mockAssets({ spec: turretManifest('HTNK') });
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    expect(await library.loadType('HTNK', ['turret'])).toBeNull();
    expect(library.get('HTNK', ['turret'])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bitmaps).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing projection part: body'));
    nodes.dispose();
  });
  it('warns once for an absent index or type and preserves fallback materials', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAssets({ indexMissing: true });
    const nodes = new AtmosphereNodes(),
      library = voxelProjectionLibrary('/missing', nodes);
    await Promise.all([library.loadType('HTNK'), library.loadType('CAR')]);
    await library.loadType('HTNK');
    expect(warn).toHaveBeenCalledTimes(1);
    nodes.dispose();
    mockAssets();
    warn.mockClear();
    const next = new AtmosphereNodes(),
      absent = voxelProjectionLibrary('/assets', next);
    await absent.loadType('CAR');
    await absent.loadType('CAR');
    expect(warn).toHaveBeenCalledTimes(1);
    next.dispose();
  });
  it('rejects partial atlases and releases every completed texture on failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bitmaps } = mockAssets({ missingPaint: true });
    const nodes = new AtmosphereNodes();
    expect(await voxelProjectionLibrary('/assets', nodes).loadType('HTNK')).toBeNull();
    expect(bitmaps).toHaveLength(2);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
    nodes.dispose();
    mockAssets({ spec: manifest(false) });
    const next = new AtmosphereNodes();
    expect(await voxelProjectionLibrary('/assets', next).loadType('HTNK', ['body', 'turret'])).toBeNull();
    next.dispose();
  });
  it('cancels a decode finishing after disposal instead of reviving an old world', async () => {
    mockAssets();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closes: ReturnType<typeof vi.fn>[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        await ready;
        const close = vi.fn();
        closes.push(close);
        return { width: 320, height: 32, close };
      }),
    );
    const nodes = new AtmosphereNodes(),
      library = voxelProjectionLibrary('/assets', nodes);
    const loading = library.loadType('HTNK');
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(4));
    nodes.dispose();
    release();
    expect(await loading).toBeNull();
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });
  it('prepares a model ahead of its first instance, which then draws the projected look at once', async () => {
    mockAssets();
    const nodes = new AtmosphereNodes();
    const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
    const world = { nodes, voxelProjection: '/vehicles-hd' } as HdWorld;
    const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
    const units = new VoxelUnits(hd, world, cache);
    // The redraw atlas is still loading: an instance built now would show the engine look, then change.
    expect(units.prepare(model, 'unit', `${model.id}@unit`)).toBe(false);
    expect(units.prepare(model, 'unit', `${model.id}@unit`)).toBe(false);
    await vi.waitFor(() => expect(units.prepare(model, 'unit', `${model.id}@unit`)).toBe(true));
    const unit = units.build(model, 'unit', `${model.id}@unit`);
    const sources: Mesh[] = [];
    unit.root.traverse((object) => {
      if (object instanceof Mesh && object.userData.painterDepth) sources.push(object);
    });
    expect(sources.length).toBeGreaterThan(0);
    for (const mesh of sources) expect((mesh.material as { name: string }).name).toContain('-projected');
    nodes.dispose();
  });
  it.each([false, true])(
    'projects only the hull of an alternate turret, with preloaded pages=%s',
    async (preloaded) => {
      mockAssets();
      const nodes = new AtmosphereNodes();
      const hd = {
        nodes,
        settings: { voxelLook: 'engine' },
        terrainDepth: { setCaptured: vi.fn() },
      } as unknown as HdRenderer;
      const world = { nodes, voxelProjection: '/vehicles-hd' } as HdWorld;
      const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
      const units = new VoxelUnits(hd, world, cache);
      const source = {
        ...model,
        turretVariants: { '2': [{ role: 'turret' as const, sections: [syntheticSection(3)] }] },
      };
      const selected = selectVoxelTurretModel(source, 2);
      if (preloaded) await voxelProjectionLibrary('/vehicles-hd', nodes).loadType(model.id);
      const unit = units.build(selected, 'unit', `${model.id}@unit:turret2`);
      const meshes: Mesh[] = [];
      unit.root.traverse((object) => {
        if (object instanceof Mesh && object.userData.painterDepth) meshes.push(object);
      });
      const turretMaterial = meshes[1]!.material;
      units.pose(unit, { x: 512, y: 768, z: 104, facing: 1 }, 2);
      units.setNativeDepth(unit, unit.root.position, 13);
      await vi.waitFor(() => expect((meshes[0]!.material as { name: string }).name).toContain('-projected'));
      expect(meshes).toHaveLength(2);
      expect((meshes[1]!.material as { name: string }).name).not.toContain('-projected');
      expect(unit.turret!.position.x).toBe(48 / 256);
      expect(unit.turret!.rotation.y).toBe(-1);
      // Returning to default uses the original projected gun, independently of the alternate's palette material.
      const normal = units.build(source, 'unit', `${model.id}@unit`);
      expect(((normal.turret!.children[0] as Mesh).material as { name: string }).name).toContain('-projected');
      units.setNativeDepth(unit, unit.root.position, 0, false);
      expect(meshes[1]!.material).toBe(turretMaterial);
      const again = units.build(selected, 'unit', `${model.id}@unit:turret2`);
      expect((again.turret!.children[0] as Mesh).geometry).toBe(meshes[1]!.geometry);
      units.dispose(unit);
      units.dispose(normal);
      units.dispose(again);
      nodes.dispose();
    },
  );
  it.each(['no projection library', 'a type absent from the index'])(
    'settles preparation at once with %s',
    async (kind) => {
      mockAssets({ spec: turretManifest() });
      const nodes = new AtmosphereNodes();
      const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
      const world = {
        nodes,
        ...(kind === 'no projection library' ? {} : { voxelProjection: '/vehicles-hd' }),
      } as HdWorld;
      const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
      const units = new VoxelUnits(hd, world, cache);
      if (kind === 'no projection library') expect(units.prepare(model, 'unit', `${model.id}@unit`)).toBe(true);
      // An absent or failed type settles after its lookup and keeps the engine look: nothing more will change.
      else await vi.waitFor(() => expect(units.prepare(model, 'unit', `${model.id}@unit`)).toBe(true));
      const unit = units.build(model, 'unit', `${model.id}@unit`);
      unit.root.traverse((object) => {
        if (object instanceof Mesh && object.userData.painterDepth)
          expect((object.material as { name: string }).name).not.toContain('-projected');
      });
      nodes.dispose();
    },
  );
  it.each([
    { model, spec: manifest(), opacity: 1 },
    { model: turretModel, spec: turretManifest(), opacity: 1 },
    { model, spec: manifest(), opacity: 0.5 },
    { model: turretModel, spec: turretManifest(), opacity: 0.5 },
  ])(
    'updates live $model.id units at opacity $opacity when a type arrives, retaining turret pivots and shadow twins',
    async ({ model: liveModel, spec, opacity }) => {
      mockAssets({ spec });
      const nodes = new AtmosphereNodes();
      const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
      const world = { nodes, voxelProjection: '/vehicles-hd' } as HdWorld;
      const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
      const units = new VoxelUnits(hd, world, cache);
      const unit = units.build(liveModel, 'unit', `${liveModel.id}@unit`);
      units.setOpacity(unit, opacity);
      units.setNativeDepth(unit, unit.root.position, 13);
      const meshes: Mesh[] = [];
      unit.root.traverse((object) => {
        if (object instanceof Mesh) meshes.push(object);
      });
      const originals = meshes.map((mesh) => mesh.material);
      await vi.waitFor(() => expect((meshes[0]!.material as { name: string }).name).toContain('-projected'));
      // No pose/publication follows the asynchronous load: the callback itself must retain the native pass.
      for (let i = 0; i < meshes.length; i++) {
        if (meshes[i]!.userData.painterDepth) {
          expect(meshes[i]!.material).not.toBe(originals[i]);
          expect(meshes[i]!.material).toMatchObject({ transparent: true, depthWrite: opacity === 1, opacity });
          expect((meshes[i]!.material as { name: string }).name).toContain(
            opacity === 1 ? ':native-ground' : ':translucent',
          );
        } else expect(meshes[i]!.material).toBe(originals[i]);
      }
      expect(unit.turret!.position.x).toBe(48 / 256);
      expect((unit.turret!.children[0] as Mesh).material).toBe((unit.turret!.children[1] as Mesh).material);
      units.setOpacity(unit, 1);
      units.setNativeDepth(unit, unit.root.position, 0, false);
      for (const mesh of meshes.filter((mesh) => mesh.userData.painterDepth)) {
        expect(mesh.material).toMatchObject({ transparent: false });
        expect((mesh.material as { name: string }).name).toContain('-projected');
        expect((mesh.material as { name: string }).name).not.toContain(':native-ground');
      }
      nodes.dispose();
    },
  );
});
