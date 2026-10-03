import { describe, expect, it } from 'vitest';
import {
  AmbientLight,
  type BufferAttribute,
  type InterleavedBufferAttribute,
  type Texture,
  DataTexture,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  QuadMesh,
  RedFormat,
  REVISION,
  Scene,
  Vector3,
  UnsignedByteType,
  WebGPURenderer,
} from 'three/webgpu';
import { float, lights, texture as textureNode, uv, vec4 } from 'three/tsl';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import { InstancedQuad } from '../src/instancedQuad';
import { SpriteLayer } from '../src/ra2/sprites';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { waterPreset } from '../src/ra2/waterLook';
import { EffectSpriteLayer, MESH_IDLE_SECONDS, type EffectInstance } from '../src/live/effectSprites';
import { ENHANCED, EffectsLayer } from '../src/effects';
import { EmitterLayer } from '../src/emitters';
import { LightField } from '../src/lightField';
import { buildRain, buildSnow } from '../src/weather';
import { buildWater } from '../src/water';
import { buildTerrain } from '../src/terrain';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { buildVoxelGeometry } from '../src/ra2/voxels';
import { voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { VoxelWaterMesh, voxelShadowMaterial, voxelWaterMaterial } from '../src/ra2/voxelShadow';
import { Ra2NightDressing } from '../src/ra2/nightDressing';
import { AtmosphereNodes } from '../src/atmosphere';
import { ObjectLayer } from '../src/objects';
import { Mist } from '../src/mist';
import { TerrainDepth } from '../src/terrainDepth';
import { faithfulToneMap } from '../src/post';
import { MapLightGrade } from '../src/ra2/mapLighting';
import type { Ra2Cache } from '../src/ra2/cache';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const MAX_VERTEX_BUFFERS = 8;
const MAX_UNIFORM_BYTES = 65536;
const FRAGMENT_STAGE = 2; // GPUShaderStage.FRAGMENT, available without a browser GPU global.

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
    vertexShader: string;
    fragmentShader: string;
    getAttributesArray(): { name: string; node?: { attribute?: VertexAttribute } }[];
    getBindings(): {
      bindings: {
        isUniformBuffer?: boolean;
        isSampledTexture?: boolean;
        texture?: Texture;
        byteLength: number;
        visibility: number;
      }[];
    }[];
  };
  attributeUtils: { createShaderVertexBuffers(object: { getAttributes(): VertexAttribute[] }): VertexLayout[] };
}

/**
 * Run r186's actual Instance.js -> WGSLNodeBuilder -> WebGPUAttributeUtils, without initializing a device.
 * getAttributesArray includes TSL buffer attributes as well as geometry attributes. The backend deduplicates
 * interleaved attributes by their data buffer: the four fallback matrix columns cost ONE buffer, not four.
 * This checks generated layouts/bindings, not WGSL validation or GPU execution.
 */
function layout(mesh: Mesh, uniformLimit = MAX_UNIFORM_BYTES, capture?: TerrainDepth) {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  if (capture) {
    renderer.setRenderTarget(capture.target);
    renderer.setMRT(capture.captureMRT);
  }
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
  const sampledTextures = builder
    .getBindings()
    .flatMap((group) => group.bindings.filter((binding) => binding.isSampledTexture).map((binding) => binding.texture));
  const fragmentSampledTextures = builder
    .getBindings()
    .flatMap((group) =>
      group.bindings
        .filter((binding) => binding.isSampledTexture && (binding.visibility & FRAGMENT_STAGE) !== 0)
        .map((binding) => binding.texture),
    );
  return {
    buffers,
    attributes,
    uniformBytes,
    sampledTextures,
    fragmentSampledTextures,
    vertexShader: builder.vertexShader,
    fragmentShader: builder.fragmentShader,
  };
}

function assertLimits(mesh: Mesh, uniformLimit = MAX_UNIFORM_BYTES, capture?: TerrainDepth) {
  const result = layout(mesh, uniformLimit, capture);
  expect(result.buffers.length, mesh.name).toBeGreaterThan(0);
  expect(result.buffers.length, mesh.name).toBeLessThanOrEqual(MAX_VERTEX_BUFFERS);
  expect(result.attributes.length, mesh.name).toBeLessThanOrEqual(16);
  for (const bytes of result.uniformBytes) expect(bytes, mesh.name).toBeLessThanOrEqual(uniformLimit);
  return result;
}

/** The backend binds interleaved views once, regardless of how many shader attributes read them. */
function attributeBuffer(attribute: VertexAttribute) {
  return 'isInterleavedBufferAttribute' in attribute ? attribute.data : attribute;
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
  it('builds solid infantry contact alpha in indexed and HD main/ground passes before enhanced look controls', () => {
    const source = cache();
    const look = spriteLookFor(source.nodes);
    look.enabled.name = 'testEnhancedLook';
    for (const hd of [null, { color: texture(), remap: texture() }]) {
      const layer = new SpriteLayer(source, [], 1, undefined, hd);
      try {
        for (const mesh of [layer.mesh, ...layer.groundPasses]) {
          const { fragmentShader } = assertLimits(mesh);
          const alpha = fragmentShader.indexOf('spriteInfantryShadowAlpha =');
          const enhanced = fragmentShader.indexOf('if ( ( object.testEnhancedLook > 0.5 ) )');
          expect(alpha, mesh.name).toBeGreaterThan(-1);
          expect(fragmentShader).toMatch(
            /spriteInfantryShadowAlpha = \( smoothstep\( 0\.02, 0\.22, [^\n]+\) \* 1\.0 \)/,
          );
          expect(enhanced, mesh.name).toBeGreaterThan(alpha);
          if (mesh === layer.groundPasses[1]) {
            expect(fragmentShader).toMatch(/spriteInfantryShadowPull = mix\([^\n]+0\.028,[^\n]+step\( 0\.22,/);
          }
        }
      } finally {
        dispose(layer.mesh);
        hd?.color.dispose();
        hd?.remap.dispose();
      }
    }
  });

  it('builds native signed integer template loads and a test-only door pass without adding vertex buffers', () => {
    const source = cache();
    source.depthTemplate = {
      texture: new DataTexture(new Uint8Array(396 * 477), 396, 477, RedFormat, UnsignedByteType),
      width: 396,
      height: 477,
    };
    const layer = new SpriteLayer(source, [
      {
        anchor: new Vector3(),
        frame: { rect: [0, 0, 16, 24], offset: [-8, -12] },
        palette: '',
        push: 0,
        shadow: false,
        nativeDepth: { mode: 'ground', bonus: 6 },
        depthWrite: false,
      },
    ]);
    try {
      const main = assertLimits(layer.mesh);
      const readOnly = assertLimits(layer.readOnlyMesh);
      expect(main.buffers.length).toBe(6);
      expect(readOnly.buffers.length).toBe(6);
      expect(main.attributes.length).toBe(10);
      expect(main.fragmentShader).toContain('textureLoad(');
      expect(main.fragmentShader).toContain('>= 128.0');
      expect(main.fragmentShader).toContain('- 256.0');
      expect(main.fragmentShader).toContain('floor(');
      expect(layer.readOnlyMesh.material.depthWrite).toBe(false);
      expect(layer.readOnlyMesh.material.depthTest).toBe(true);
    } finally {
      dispose(layer.mesh);
      source.depthTemplate.texture.dispose();
    }
  });

  it('emits per-instance map-grade exemption in every sprite colour path and pass', () => {
    const source = cache();
    for (const hd of [null, { color: texture(), remap: texture() }]) {
      for (const materials of [null, { texture: texture() }]) {
        const layer = new SpriteLayer(source, [], 1, undefined, hd, texture(), materials);
        for (const mesh of [layer.mesh, ...layer.groundPasses]) {
          const { fragmentShader } = assertLimits(mesh);
          const exemptionLines = fragmentShader.split('\n').filter((line) => line.includes('spriteGradeExempt'));
          const label = `${mesh.name}: ${hd ? 'HD' : 'indexed'}, ${materials ? 'materials' : 'plain'}`;
          // Compile the real TSL graph: uploading an attribute alone does not prove the fragment shader reads it.
          expect(exemptionLines.join('\n'), label).toMatch(/spriteGradeExempt\s*=\s*\w+\.z;/);
          // The per-instance flag chooses unit palette light; default instances keep the existing class grade.
          const exemption = fragmentShader.match(
            /if \( \( spriteGradeExempt > 0\.5 \) \) \{\s*(\w+) = vec3<f32>\( 1\.0, 1\.0, 1\.0 \);\s*\} else \{([\s\S]*?)\n\s*\}/,
          );
          expect(exemption, label).not.toBeNull();
          expect(exemption![2], label).toContain('mix(');
          expect(exemption![2], label).toContain('max(');
          expect(exemption![2], label).toContain('textureSample(');
          expect(fragmentShader, label).not.toContain('spriteReceivedLightGain');
        }
        dispose(layer.mesh);
      }
    }
    source.nodes!.dispose();
  });

  it('builds crystal sparkle in every material pass, including under, with no sparkle nodes on default pages', () => {
    const source = cache();
    for (const materials of [null, { texture: texture() }]) {
      const layer = new SpriteLayer(
        source,
        [],
        1,
        undefined,
        { color: new DataTexture(new Uint8Array(512 * 8 * 4), 512, 8), remap: texture() },
        null,
        materials,
      );
      for (const mesh of [layer.mesh, ...layer.groundPasses]) {
        const { fragmentShader } = assertLimits(mesh);
        // This is the cell hash's constant in the generated WGSL, not a source-text assertion.
        expect(fragmentShader.includes('43758.5'), mesh.name).toBe(materials !== null);
      }
      dispose(layer.mesh);
    }
  });

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
  it.each(
    [1024, 1025, 4096, 131072].flatMap((capacity) =>
      (['faithful', 'indexed', 'hd'] as const).map((variant) => [capacity, variant] as const),
    ),
  )('bounds every sprite-look pass at capacity %i with %s art', (capacity, variant) => {
    const source = cache();
    source.depthTemplate = {
      texture: new DataTexture(new Uint8Array(396 * 477), 396, 477, RedFormat, UnsignedByteType),
      width: 396,
      height: 477,
    };
    const look = spriteLookFor(source.nodes);
    for (const key of [
      'enabled',
      'relight',
      'specular',
      'glass',
      'occlusion',
      'shadowFollow',
      'shadowSoftness',
      'reflections',
      'wetness',
    ] as const)
      look[key].value = 1;
    const terrainDepth = new TerrainDepth(1.5);
    // Both palette and HD colour paths include windows, normals, glass/AO, contact shade and wet reflections.
    // Also compile the faithful variant, which has no material atlas.
    {
      look.enabled.value = variant === 'faithful' ? 0 : 1;
      const layer = new SpriteLayer(
        source,
        [],
        capacity,
        undefined,
        variant === 'indexed' ? null : { color: texture(), remap: texture() },
        texture(),
        variant === 'faithful' ? null : { texture: texture() },
        terrainDepth,
      );
      const main = assertLimits(layer.mesh);
      const captured = assertLimits(layer.mesh, MAX_UNIFORM_BYTES, terrainDepth);
      expect(captured.buffers.length).toBe(6);
      expect(captured.attributes.length).toBe(11);
      expect(captured.fragmentShader).toContain('@location( 0 ) m0 : vec4<f32>');
      expect(captured.fragmentShader).toContain('objectDepthInstanceCode');
      // Material MRT colour outputs must not replace the capture's code/coverage contract or its blend alpha.
      expect(captured.fragmentShader).toContain('objectDepthInstanceCode * DiffuseColor.w');
      const shared = new Set(main.attributes.map(attributeBuffer));
      expect(layer.groundPasses).toHaveLength(2);
      for (const mesh of [
        layer.mesh,
        ...layer.groundPasses,
        layer.readOnlyMesh,
        layer.unitMesh,
        layer.translucentMesh,
      ]) {
        const result = mesh === layer.mesh ? main : assertLimits(mesh);
        expect(result.buffers.length).toBe(6);
        expect(result.attributes.length).toBe(
          mesh === layer.mesh || mesh === layer.unitMesh ? 11 : mesh === layer.groundPasses[1] ? 9 : 10,
        );
        expect(result.fragmentShader.includes('objectDepthCaptureEnabled')).toBe(
          mesh === layer.mesh || mesh === layer.unitMesh,
        );
        if (mesh === layer.translucentMesh) {
          expect(result.fragmentShader).toContain('spriteBodyOpacity');
          expect(mesh.material.depthWrite).toBe(false);
          expect(mesh.renderOrder).toBeGreaterThan(layer.readOnlyMesh.renderOrder);
          expect(mesh.renderOrder).toBeGreaterThan(layer.unitMesh.renderOrder);
        }
        if (mesh === layer.mesh || mesh === layer.unitMesh) {
          expect(result.fragmentShader).toMatch(/@interpolate\( flat, either \) objectDepthInstanceCode/);
          expect(result.fragmentShader).toMatch(/objectDepthCaptureEnabled > 0\.0/);
          expect(result.fragmentShader).toContain('-65504.0');
        }
        const buffers = new Set(result.attributes.map(attributeBuffer));
        expect(buffers.size).toBe(shared.size);
        for (const buffer of buffers) expect(shared.has(buffer)).toBe(true);
        expect(mesh).toBeInstanceOf(InstancedQuad);
        expect(mesh.geometry).toBe(layer.mesh.geometry);
        expect(mesh.geometry.getAttribute('normal')).toBeUndefined();
        expect('instanceMatrix' in mesh).toBe(false);
        expect(mesh.capacity).toBe(capacity);
        expect(mesh.count).toBe(0);
        expect(assertLimits(mesh, 16384).buffers.length).toBe(6);
      }
      dispose(layer.mesh);
      expect(look.groundPasses.size).toBe(0);
    }
    terrainDepth.dispose();
    source.nodes!.dispose();
    source.depthTemplate.texture.dispose();
  });

  it.each(['ground', 'air', 'top'] as const)(
    'bounds opaque/translucent %s animation, projectile and particle cards',
    (pass) => {
      const source = cache();
      const atlas = { texture: texture(), width: 256, height: 4 };
      const terrainDepth = new TerrainDepth(1.5);
      const layer = new EffectSpriteLayer(
        source,
        () => atlas,
        undefined,
        () => atlas,
        undefined,
        terrainDepth,
      );
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
        category: 'explosion',
      };
      for (const alpha of [1, 0.5]) {
        layer.setInstances([{ ...card, alpha }], 0);
        const mesh = meshes(pass === 'top' ? layer.topRoot : layer.root)[0]!;
        const native = assertLimits(mesh);
        expect(native.buffers.length).toBe(6);
        expect(native.fragmentShader.includes('terrainDepthPullEnabled')).toBe(pass === 'air');
        expect('instanceMatrix' in mesh).toBe(false);
        expect((mesh as { capacity?: number }).capacity).toBe(4096);
      }
      layer.setInstances(
        [
          {
            ...card,
            hd: {
              frame: { page: 0, rect: [0, 0, 128, 128], offset: [-32, -48] },
              next: null,
              scale: 2,
              size: 1.3,
              blend0: 0,
              t0: 0,
              stageSeconds: 0.1,
            },
          },
        ],
        0,
      );
      const hd = meshes(pass === 'top' ? layer.topRoot : layer.root).find((mesh) =>
        mesh.name.startsWith('live-effects-hd-'),
      )!;
      const result = assertLimits(hd);
      expect(result.fragmentShader.includes('terrainDepthPullEnabled')).toBe(pass === 'air');
      // Six vec4 instance fields, one position buffer and one fallback matrix buffer: no seventh field.
      expect(result.buffers.length).toBe(8);
      if (pass === 'top') {
        // Top never tests/writes fragment depth; only draw mode is needed for its vertex placement.
        expect(result.fragmentShader).not.toContain('sqrt(');
      } else {
        expect(result.fragmentShader).toContain('sqrt(');
        expect(result.fragmentShader).toContain('fract(');
      }
      layer.setInstances([], MESH_IDLE_SECONDS + 1);
      atlas.texture.dispose();
      source.nodes!.dispose();
      terrainDepth.dispose();
    },
  );

  it('audits every procedural effect, beam, emitter, light-field and weather batch at allocated capacity', () => {
    const nodes = new AtmosphereNodes();
    const terrainDepth = new TerrainDepth(1.5);
    const effects = new EffectsLayer(nodes, terrainDepth);
    const emitters = new EmitterLayer(nodes);
    const lights = new LightField(2, 2, { nodes });
    const height = texture();
    const groundMask = new DataTexture(new Uint8Array(4), 2, 2, RedFormat);
    const rain = buildRain(2, 2, height, 0, nodes, groundMask);
    const snow = buildSnow(2, 2, height, 0, nodes, groundMask);
    const groups = [
      effects.root,
      emitters.root,
      (lights as unknown as { scene: Scene }).scene,
      rain.object,
      snow.object,
    ];
    const audited = groups.flatMap(meshes);
    // Nineteen particle pools (including the enhanced contact-shadow pool), beams; four emitter batches;
    // base grid + two light batches; rain + splashes + snow. Check every named pool's actual allocation below.
    expect(audited.length).toBe(30);
    const capacities = {
      fireballs: 96,
      flames: 768,
      smoke: 1536,
      sparks: 1024,
      airborneEmbers: 512,
      muzzleStar: 128,
      scorch: 96,
      shock: 48,
      embers: 256,
      garnishFire: 128,
      dots: 512,
      halo: 128,
      billow: 1536,
      // Keep capacity for independent blasts; shadows allocate the same slots as their matching chunks.
      debris: 1536,
      debrisShadow: 1536,
      shimmer: 64,
      dust: 64,
      blast: 96,
      column: 768,
      beams: 4096,
    };
    const pools = effects as unknown as Record<keyof typeof capacities, { mesh: InstancedMesh }>;
    expect(new Set(Object.keys(capacities).map((key) => pools[key as keyof typeof capacities].mesh))).toEqual(
      new Set(meshes(effects.root)),
    );
    for (const key of Object.keys(capacities) as (keyof typeof capacities)[]) {
      const mesh = pools[key].mesh;
      mesh.name = `effects-${key}`;
      expect(mesh.instanceMatrix.count, key).toBe(capacities[key]);
      // No effect pool writes depth (debris included: chunks must not punch through later fireball cards).
      expect(mesh.material).toMatchObject({ depthTest: true, depthWrite: false });
      if (key === 'debris') expect(mesh.material).toMatchObject({ alphaTest: ENHANCED.debris.alphaTest });
    }
    for (const mesh of audited) {
      assertLimits(mesh);
      assertLimits(mesh, 16384);
    }
    expect(meshes(effects.root).map((m) => (m as InstancedMesh).instanceMatrix.count)).toContain(4096);
    expect(meshes(rain.object).map((m) => (m as InstancedMesh).instanceMatrix.count)).toEqual([12000, 3500]);
    expect(rain.object.visible).toBe(false);
    expect(meshes(snow.object).map((m) => (m as InstancedMesh).instanceMatrix.count)).toEqual([9000]);
    expect(snow.object.visible).toBe(false);
    expect(meshes(snow.object)[0]!.material).toMatchObject({
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
    });
    for (const root of [effects.root, emitters.root]) meshes(root).forEach(dispose);
    rain.dispose();
    snow.dispose();
    height.dispose();
    groundMask.dispose();
    lights.dispose();
    nodes.dispose();
    terrainDepth.dispose();
  });

  it('binds the per-cell ground mask only for rain splashes and snow landing', () => {
    const nodes = new AtmosphereNodes();
    const height = texture();
    const groundMask = new DataTexture(new Uint8Array([0, 255, 0, 0]), 2, 2, RedFormat);
    const rain = buildRain(2, 2, height, 0, nodes, groundMask);
    const snow = buildSnow(2, 2, height, 0, nodes, groundMask);
    const [streaks, splashes] = meshes(rain.object);
    expect(assertLimits(streaks!).sampledTextures).not.toContain(groundMask);
    const splash = assertLimits(splashes!);
    expect(splash.sampledTextures).toContain(groundMask);
    // Clipping only ring centers lets adjacent rings draw across building/cliff edges.
    expect(splash.fragmentSampledTextures).toContain(groundMask);
    const flakes = assertLimits(meshes(snow.object)[0]!);
    expect(flakes.sampledTextures).toContain(groundMask);
    expect(flakes.sampledTextures).toContain(height);
    expect(flakes.sampledTextures).toContain(nodes.surfaceTexture.value);
    // Generated shader stages must retain the swaying flight and procedural disc opacity.
    expect(flakes.vertexShader).toContain('sin(');
    expect(flakes.fragmentShader).toContain('smoothstep(');
    rain.dispose();
    snow.dispose();
    groundMask.dispose();
    height.dispose();
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
    const weatherMask = new DataTexture(new Uint8Array([255, 0, 0, 0]), 2, 2, RedFormat);
    source.nodes!.weatherGroundTexture.value = weatherMask;
    const terrain = buildRa2Terrain(source);
    expect(Array.isArray(terrain.mesh.material)).toBe(true);
    for (const [index, material] of (terrain.mesh.material as MeshBasicNodeMaterial[]).entries()) {
      const result = assertLimits(new Mesh(terrain.mesh.geometry, material));
      // Ground samples the renderer-owned footprint texture per fragment; vertical art has no wet-film path.
      expect(result.fragmentSampledTextures.includes(source.nodes!.weatherGroundTexture.value)).toBe(index === 0);
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
      assertLimits(new Mesh(part.geometry, voxelWaterMaterial(source.nodes!, 'foam')));
      assertLimits(new Mesh(part.geometry, voxelWaterMaterial(source.nodes!, 'reflection')));
      const reflection = voxelWaterMaterial(source.nodes!, 'reflection', part.material);
      expect(reflection.colorNode).not.toBeNull();
      assertLimits(new Mesh(part.geometry, reflection));
      part.geometry.dispose();
    }
    [terrain.mesh, generic.mesh, water.mesh].forEach(dispose);
    weatherMask.dispose();
    source.nodes!.dispose();
  });

  it.each([false, true])(
    'generates the complete coloured naval reflection shader without a device (WebGL=%s)',
    (forceWebGL) => {
      const nodes = new AtmosphereNodes();
      const parts = buildVoxelGeometry(syntheticModel([syntheticSection(2)]), new Uint8Array(768), nodes);
      const part = parts[0]!;
      const source = new Mesh(part.geometry, part.material);
      const reflection = new VoxelWaterMesh(source, nodes, 'reflection');
      const canvas = {
        width: 64,
        height: 64,
        style: {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      };
      try {
        const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL });
        renderer.hasFeature = () => false;
        renderer.hasCompatibility = () => false;
        const builder = renderer.backend.createNodeBuilder(reflection, renderer);
        builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
        builder.scene = new Scene();
        builder.build();
        expect(builder.vertexShader).not.toMatch(/\b(?:NaN|undefined)\b/);
        expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
        expect(builder.fragmentShader).toMatch(/\bsin\(/);
        expect(builder.fragmentShader).toMatch(/\bfloor\(/);
        expect(builder.fragmentShader).toMatch(/texture(?:Sample|Load|Lod|Grad)?\(/);
        expect(builder.fragmentShader).not.toContain('modelNormalMatrix');
      } finally {
        parts.forEach((p) => p.geometry.dispose());
        nodes.dispose();
      }
    },
  );

  it.each(['classic', 'enhanced'] as const)('audits %s shoreline water with and without scene reflections', (style) => {
    const source = cache();
    source.terrainMap = {
      ref: { width: 256, height: 4, originX: 0, originY: 0, scale: 1 },
      texture: texture(),
      waterMask: texture(),
      shore: texture(),
    } as Ra2Cache['terrainMap'];
    const previous = waterPreset.style;
    try {
      waterPreset.style = style;
      for (const reflections of [false, true]) {
        source.manifest.tiles[0]!.terrainType = reflections ? 9 : 0;
        const terrain = buildRa2Terrain(source);
        expect(terrain.reflectionTarget !== null).toBe(reflections);
        for (const material of terrain.mesh.material as MeshBasicNodeMaterial[]) {
          const mesh = new Mesh(terrain.mesh.geometry, material);
          assertLimits(mesh);
          assertLimits(mesh, 16384);
        }
        dispose(terrain.mesh);
      }
    } finally {
      waterPreset.style = previous;
      source.nodes!.dispose();
    }
  });

  it('compiles scene multipliers after physical lighting and on every sprite lighting class', () => {
    const source = cache();
    const terrain = buildRa2Terrain(source);
    for (const material of terrain.mesh.material as MeshBasicNodeMaterial[]) {
      material.lightsNode = lights([new AmbientLight(0xffffff, 1)]);
      expect(assertLimits(new Mesh(terrain.mesh.geometry, material)).fragmentShader).toContain('sceneTerrainMul');
    }
    const palette = new Uint8Array(768);
    const parts = buildVoxelGeometry(syntheticModel([syntheticSection(2)]), palette, source.nodes);
    for (const part of parts) {
      part.material.lightsNode = lights([new AmbientLight(0xffffff, 1)]);
      expect(assertLimits(new Mesh(part.geometry, part.material)).fragmentShader).toContain('sceneObjectMul');
      const pbr = voxelPbrMaterialFor(palette, source.nodes);
      pbr.lightsNode = lights([new AmbientLight(0xffffff, 1)]);
      expect(assertLimits(new Mesh(part.geometry, pbr)).fragmentShader).toContain('sceneObjectMul');
      part.geometry.dispose();
    }
    const sprites = new SpriteLayer(source, [], 1);
    const shader = assertLimits(sprites.mesh).fragmentShader;
    expect(shader).toContain('sceneTerrainMul');
    expect(shader).toContain('sceneObjectMul');
    expect(shader).toContain('sceneSunShadow');
    dispose(sprites.mesh);
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
