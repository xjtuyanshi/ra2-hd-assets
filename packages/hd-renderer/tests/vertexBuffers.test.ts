import { describe, expect, it } from 'vitest';
import {
  type BufferAttribute,
  type InterleavedBufferAttribute,
  DataTexture,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  QuadMesh,
  REVISION,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { float, texture as textureNode, uv, vec4 } from 'three/tsl';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import { InstancedQuad } from '../src/instancedQuad';
import { SpriteLayer } from '../src/ra2/sprites';
import { EffectSpriteLayer, MESH_IDLE_SECONDS, type EffectInstance } from '../src/live/effectSprites';
import { EffectsLayer } from '../src/effects';
import { EmitterLayer } from '../src/emitters';
import { LightField } from '../src/lightField';
import { buildRain } from '../src/weather';
import { buildWater } from '../src/water';
import { buildTerrain } from '../src/terrain';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { buildVoxelGeometry } from '../src/ra2/voxels';
import { voxelShadowMaterial } from '../src/ra2/voxelShadow';
import { Ra2NightDressing } from '../src/ra2/nightDressing';
import { AtmosphereNodes } from '../src/atmosphere';
import { ObjectLayer } from '../src/objects';
import { Mist } from '../src/mist';
import { faithfulToneMap } from '../src/post';
import { MapLightGrade } from '../src/ra2/mapLighting';
import type { Ra2Cache } from '../src/ra2/cache';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const MAX_VERTEX_BUFFERS = 8;
const MAX_UNIFORM_BYTES = 65536;

type VertexAttribute = BufferAttribute | InterleavedBufferAttribute;
interface VertexLayout {
  stepMode: string;
  attributes: { shaderLocation: number; offset: number; format: string }[];
}
/** Only the CPU-facing portion of r186's backend; these internals are absent from @types/three. */
interface LayoutBackend {
  capabilities: { getUniformBufferLimit(): number };
  createNodeBuilder(
    mesh: Mesh,
    renderer: WebGPURenderer,
  ): {
    camera: OrthographicCamera;
    scene: Scene;
    build(): void;
    getAttributesArray(): { name: string; node?: { attribute?: VertexAttribute } }[];
    getBindings(): { bindings: { isUniformBuffer?: boolean; byteLength: number }[] }[];
  };
  attributeUtils: { createShaderVertexBuffers(object: { getAttributes(): VertexAttribute[] }): VertexLayout[] };
}

/**
 * Run r186's actual Instance.js -> WGSLNodeBuilder -> WebGPUAttributeUtils, without initializing a device.
 * getAttributesArray includes TSL buffer attributes as well as geometry attributes. The backend deduplicates
 * interleaved attributes by their data buffer: the four fallback matrix columns cost ONE buffer, not four.
 * This checks generated layouts/bindings, not WGSL validation or GPU execution.
 */
function layout(mesh: Mesh, uniformLimit = MAX_UNIFORM_BYTES) {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  const backend = renderer.backend as unknown as LayoutBackend;
  backend.capabilities.getUniformBufferLimit = () => uniformLimit;
  // Obtain the bundled builder from the backend. Importing src/NodeBuilder separately would create a second TSL
  // stack alongside three/webgpu and silently omit shader assignments.
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  builder.scene = new Scene();
  builder.build();
  const attributes = builder.getAttributesArray().map((a) => a.node?.attribute ?? mesh.geometry.getAttribute(a.name));
  expect(attributes.every(Boolean)).toBe(true);
  const buffers = backend.attributeUtils.createShaderVertexBuffers({ getAttributes: () => attributes });
  const uniformBytes = builder
    .getBindings()
    .flatMap((group) =>
      group.bindings.filter((binding) => binding.isUniformBuffer).map((binding) => binding.byteLength),
    );
  return { buffers, attributes, uniformBytes };
}

function assertLimits(mesh: Mesh, uniformLimit = MAX_UNIFORM_BYTES) {
  const result = layout(mesh, uniformLimit);
  expect(result.buffers.length, mesh.name).toBeGreaterThan(0);
  expect(result.buffers.length, mesh.name).toBeLessThanOrEqual(MAX_VERTEX_BUFFERS);
  expect(result.attributes.length, mesh.name).toBeLessThanOrEqual(16);
  for (const bytes of result.uniformBytes) expect(bytes, mesh.name).toBeLessThanOrEqual(uniformLimit);
  return result;
}

const texture = () => new DataTexture(new Uint8Array(256 * 4 * 4), 256, 4);
function cache(): Ra2Cache {
  const atlas = texture();
  return {
    nodes: new AtmosphereNodes(),
    manifest: {
      grid: { width: 2, height: 2 },
      theater: 'urban',
      sprites: {},
      spriteAtlas: { width: 256, height: 4 },
      terrainAtlas: { width: 256, height: 4 },
      tiles: [{ rect: [0, 0, 60, 30], anchor: [30, 0], x: 0, y: 0, rampType: 0, terrainType: 0, file: 'synthetic' }],
    },
    exists: new Uint8Array(4).fill(1),
    height: new Uint8Array(4),
    tile: new Uint16Array(4),
    spriteAtlas: atlas,
    terrainAtlas: atlas,
    paletteAtlas: atlas,
    waterMask: atlas,
    paletteRow: new Map(),
    mapLight: new MapLightGrade(
      { width: 2, height: 2, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
      { ambient: 1, level: 0, ground: 0, red: 1, green: 1, blue: 1 },
    ),
  } as unknown as Ra2Cache;
}

function meshes(root: Object3D): Mesh[] {
  const result: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) result.push(object);
  });
  return result;
}

function dispose(mesh: Mesh): void {
  mesh.geometry.dispose();
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  mesh.dispose();
}

describe('r186 vertex and uniform binding budget', () => {
  it('submits the live instance count on a plain Mesh, including empty and full batches', () => {
    const mesh = new InstancedQuad(new MeshBasicNodeMaterial(), 4096);
    const renderObject = {
      object: mesh,
      material: mesh.material,
      geometry: mesh.geometry,
      group: null,
      drawRange: mesh.geometry.drawRange,
      getIndex: () => mesh.geometry.index,
    };
    for (const count of [0, 1, 4096, 7, 0]) {
      mesh.count = count;
      const draw = RenderObject.prototype.getDrawParameters.call(renderObject);
      if (count === 0) expect(draw).toBeNull();
      else expect(draw).toMatchObject({ instanceCount: count, vertexCount: 6 });
    }
    dispose(mesh);
  });
  it.each([16384, MAX_UNIFORM_BYTES])(
    'uses allocation capacity, interleaving and the %i-byte uniform boundary',
    (limit) => {
      expect(REVISION).toBe('186');
      const capacity = limit / 64;
      const material = new MeshBasicNodeMaterial();
      const small = new InstancedMesh(new PlaneGeometry(), material, capacity);
      const large = new InstancedMesh(new PlaneGeometry(), material, capacity + 1);
      // A hidden/empty draw still compiles at the allocation's capacity, exactly as live page meshes do.
      small.count = large.count = 0;
      const uniform = assertLimits(small, limit);
      const fallback = assertLimits(large, limit);
      expect(uniform.uniformBytes).toContain(limit);
      expect(fallback.uniformBytes).not.toContain((capacity + 1) * 64);
      expect(fallback.buffers.length).toBe(uniform.buffers.length + 1);
      expect(fallback.attributes.length).toBe(uniform.attributes.length + 4);
      expect(fallback.buffers.some((buffer) => buffer.stepMode === 'instance' && buffer.attributes.length === 4)).toBe(
        true,
      );
      dispose(small);
      dispose(large);
    },
  );

  // Live objects allocate 4096. Cells grow with mapCells * 4; overlay/smudge pages grow to a power of two and have
  // no finite hard cap. Test both uniform thresholds and a large grown page: these matrix-free layouts are invariant.
  it.each([1024, 1025, 4096, 131072])('bounds sprites/cells/overlays/smudges at capacity %i', (capacity) => {
    const source = cache();
    const layer = new SpriteLayer(source, [], capacity, undefined, { color: texture(), remap: texture() }, texture());
    const result = assertLimits(layer.mesh);
    expect(result.buffers.length).toBe(6);
    expect(result.attributes.length).toBe(8);
    expect(layer.mesh.geometry.getAttribute('normal')).toBeUndefined();
    expect('instanceMatrix' in layer.mesh).toBe(false);
    expect(layer.mesh.count).toBe(0);
    expect(assertLimits(layer.mesh, 16384).buffers.length).toBe(6);
    dispose(layer.mesh);
    source.nodes!.dispose();
  });

  it.each(['ground', 'air', 'top'] as const)(
    'bounds opaque/translucent %s animation, projectile and particle cards',
    (pass) => {
      const source = cache();
      const layer = new EffectSpriteLayer(source, () => ({ texture: texture(), width: 256, height: 4 }));
      const card: EffectInstance = {
        anchor: new Vector3(),
        frame: { rect: [0, 0, 8, 8], offset: [-4, -4], page: 0 },
        palette: '',
        alpha: 1,
        push: 1,
        draw: 'card',
        pass,
        depth: 0,
        glow: true,
      };
      for (const alpha of [1, 0.5]) {
        layer.setInstances([{ ...card, alpha }], 0);
        const mesh = meshes(layer.root)[0]!;
        expect(assertLimits(mesh).buffers.length).toBe(6);
        expect('instanceMatrix' in mesh).toBe(false);
        expect((mesh as { capacity?: number }).capacity).toBe(4096);
      }
      layer.setInstances([], MESH_IDLE_SECONDS + 1);
      source.nodes!.dispose();
    },
  );

  it('audits every procedural effect, beam, emitter, light-field and weather batch at allocated capacity', () => {
    const nodes = new AtmosphereNodes();
    const effects = new EffectsLayer(nodes);
    const emitters = new EmitterLayer(nodes);
    const lights = new LightField(2, 2, { nodes });
    const rain = buildRain(2, 2, texture(), 0, nodes);
    const groups = [effects.root, emitters.root, (lights as unknown as { scene: Scene }).scene, rain.object];
    const audited = groups.flatMap(meshes);
    // Nine particle pools, beams; four emitter batches; base grid + two light batches; rain + splashes.
    expect(audited.length).toBe(19);
    for (const mesh of audited) {
      assertLimits(mesh);
      assertLimits(mesh, 16384);
    }
    expect(meshes(effects.root).map((m) => (m as InstancedMesh).instanceMatrix.count)).toContain(4096);
    expect(meshes(rain.object).map((m) => (m as InstancedMesh).instanceMatrix.count)).toEqual([9000, 2500]);
    for (const root of [effects.root, emitters.root, rain.object]) meshes(root).forEach(dispose);
    lights.dispose();
    nodes.dispose();
  });

  it('audits data-sized night poles above the instance-matrix fallback threshold', () => {
    const source = cache();
    const root = new Object3D();
    const emitters = new EmitterLayer(source.nodes);
    const dressing = new Ra2NightDressing({ cache: source, root, objects: [], heightAt: () => 0 });
    // This private factory is the actual sidecar-sized path; there is no fixed pole capacity.
    const factory = dressing as unknown as { setPoles(posts: Vector3[], emitters: EmitterLayer): void };
    factory.setPoles(
      Array.from({ length: 4096 }, () => new Vector3()),
      emitters,
    );
    expect(meshes(root).length).toBe(1);
    expect(assertLimits(meshes(root)[0]!).buffers.length).toBeLessThanOrEqual(5);
    meshes(root).forEach(dispose);
    meshes(emitters.root).forEach(dispose);
    source.nodes!.dispose();
  });

  it('audits terrain/cliffs, water, voxel units/projectiles/debris and their shadow materials', () => {
    const source = cache();
    const terrain = buildRa2Terrain(source);
    expect(Array.isArray(terrain.mesh.material)).toBe(true);
    for (const material of terrain.mesh.material as MeshBasicNodeMaterial[]) {
      assertLimits(new Mesh(terrain.mesh.geometry, material));
    }
    const generic = buildTerrain(
      {
        width: 2,
        height: 2,
        theater: 'temperate',
        waterLevel: 0,
        lighting: { ambient: 1, level: 0, ground: 0, red: 1, green: 1, blue: 1 },
        cornerHeights: new Float32Array(9),
        terrain: ['clear', 'clear', 'clear', 'clear'],
      },
      source.nodes,
    );
    assertLimits(generic.mesh);
    const water = buildWater(2, 2, 0, generic.heightTexture);
    assertLimits(water.mesh);
    // Geometry size changes vertex/index storage, never binding count. A >64K-vertex voxel exercises that boundary.
    const parts = buildVoxelGeometry(syntheticModel([syntheticSection(24)]), new Uint8Array(768), source.nodes);
    for (const part of parts) {
      expect(part.geometry.getAttribute('position').count).toBeGreaterThan(65536);
      expect(assertLimits(new Mesh(part.geometry, part.material)).buffers.length).toBe(4);
      assertLimits(new Mesh(part.geometry, voxelShadowMaterial()));
      part.geometry.dispose();
    }
    [terrain.mesh, generic.mesh, water.mesh].forEach(dispose);
    source.nodes!.dispose();
  });

  it('audits composite terrain, shoreline water and the reflection sampling variant', () => {
    const source = cache();
    source.terrainMap = {
      ref: { width: 256, height: 4, originX: 0, originY: 0, scale: 1 },
      texture: texture(),
      waterMask: texture(),
      shore: texture(),
    } as Ra2Cache['terrainMap'];
    source.manifest.tiles[0]!.terrainType = 9;
    const terrain = buildRa2Terrain(source);
    expect(terrain.reflectionTarget).not.toBeNull();
    for (const material of terrain.mesh.material as MeshBasicNodeMaterial[]) {
      assertLimits(new Mesh(terrain.mesh.geometry, material));
    }
    dispose(terrain.mesh);
    source.nodes!.dispose();
  });

  it('audits sandbox object/window materials and custom full-screen mist/tone mapping', () => {
    const layer = new ObjectLayer();
    layer.sync(
      (['vehicle', 'infantry', 'building', 'aircraft', 'ship', 'tree'] as const).map((kind, id) => ({
        id,
        type: 'SYNTHETIC',
        kind,
        house: 0,
        x: 0,
        y: 0,
        z: 0,
        facing: 0,
        health: 1,
      })),
      () => 0,
    );
    const objects = meshes(layer.root);
    expect(objects.length).toBeGreaterThan(6);
    for (const object of objects) assertLimits(object);
    const nodes = new AtmosphereNodes();
    const mist = new Mist(nodes);
    const pixel = textureNode(texture(), uv());
    const depth = float(0.5);
    const colour = mist.apply(pixel, depth, mist.worldPosition(depth, uv()));
    const material = new MeshBasicNodeMaterial();
    material.fragmentNode = vec4(faithfulToneMap(colour.rgb), 1);
    const quad = new QuadMesh(material);
    expect(assertLimits(quad).buffers.length).toBeLessThanOrEqual(2);
    [...objects, quad].forEach(dispose);
    nodes.dispose();
  });
});
