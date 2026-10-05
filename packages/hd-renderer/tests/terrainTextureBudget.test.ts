import { afterEach, describe, expect, it } from 'vitest';
import { lights } from 'three/tsl';
import {
  DataTexture,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  OrthographicCamera,
  RedFormat,
  Scene,
  WebGPURenderer,
  type Material,
  type Texture,
} from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { applyMaterialFallbacks } from '../src/materialFallback';
import { NO_TILE, type Ra2Cache } from '../src/ra2/cache';
import { MapLightGrade } from '../src/ra2/mapLighting';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { waterPreset, type WaterStyle } from '../src/ra2/waterLook';

/**
 * WebGPU's default per-stage limit, and the one this renderer runs under: a fragment shader may bind 16 sampled
 * textures (maxSampledTexturesPerShaderStage). The pipeline of a material beyond it is refused and the material is
 * simply not drawn (RiverRam's ground: 22 textures, a black battlefield). The sampler limit is 16 as well
 * (maxSamplersPerShaderStage) and three binds at most one sampler per texture, so the texture count bounds both.
 */
const MAX_SAMPLED_TEXTURES = 16;
const FRAGMENT_STAGE = 2; // GPUShaderStage.FRAGMENT, available without a browser GPU global.

const cleanups: (() => void)[] = [];
const originalStyle = waterPreset.style;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  waterPreset.style = originalStyle;
});

/** Only the CPU-facing portion of r186's backend; these internals are absent from @types/three. */
interface BindingBackend {
  createNodeBuilder(
    mesh: Mesh,
    renderer: WebGPURenderer,
  ): {
    camera: OrthographicCamera;
    scene: Scene;
    lightsNode: unknown;
    build(): void;
    /** Nodes the renderer runs before drawing the object, three's planar reflectors among them. */
    updateBeforeNodes: {
      type: string;
      depth?: boolean;
      textureNode?: { value: Texture; getDepthNode(): { value: Texture } };
    }[];
    getBindings(): {
      // r186's SampledTexture extends Sampler: a texture binding carries isSampler too.
      bindings: { isSampledTexture?: boolean; isSampler?: boolean; texture?: Texture; visibility: number }[];
    }[];
  };
}

/**
 * What the fragment shader of `material` binds, from r186's actual WGSLNodeBuilder (no device needed): the textures
 * of the whole node graph, including those inside Fn bodies and whatever the lighting model adds, exactly as the
 * pipeline layout will list them. This checks the generated bindings, not GPU validation.
 */
function fragmentBindings(geometry: Mesh['geometry'], material: Material): { textures: Texture[]; samplers: number } {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  const mesh = new Mesh(geometry, material);
  const builder = (renderer.backend as unknown as BindingBackend).createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  builder.scene = new Scene();
  // Lit as in a match (sun and sky): without lights three skips the lighting model, and with it whatever that binds.
  builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
  builder.build();
  const bindings = builder
    .getBindings()
    .flatMap((group) => group.bindings)
    .filter((binding) => (binding.visibility & FRAGMENT_STAGE) !== 0);
  const textures = bindings.filter((binding) => binding.isSampledTexture).map((binding) => binding.texture!);
  // Until its first render every reflector of three shows one shared placeholder (colour and depth); from then on
  // each owns a render target. Count what a running match binds: the placeholders out, each reflector's own in.
  const reflectors = builder.updateBeforeNodes.filter((node) => node.type === 'ReflectorBaseNode');
  const placeholders = new Set<Texture>();
  const own: Texture[] = [];
  for (const reflector of reflectors) {
    placeholders.add(reflector.textureNode!.value);
    own.push({ name: 'reflector-colour', isRenderTargetTexture: true } as unknown as Texture);
    if (reflector.depth) {
      placeholders.add(reflector.textureNode!.getDepthNode().value);
      own.push({ name: 'reflector-depth', isDepthTexture: true } as unknown as Texture);
    }
  }
  return {
    textures: [...textures.filter((texture) => !placeholders.has(texture)), ...own],
    samplers: bindings.filter((binding) => binding.isSampler && !binding.isSampledTexture).length,
  };
}

const isMirror = (texture: Texture) =>
  !!(
    (texture as { isRenderTargetTexture?: boolean }).isRenderTargetTexture ||
    (texture as { isDepthTexture?: boolean }).isDepthTexture
  );

/**
 * A map with every optional terrain layer the cache can carry (whole-map art, water mask, shore and cliff distance
 * fields, water detail, painted water surface, map light grade) and `levels` water terraces of 12 or more cells each.
 */
function fullMap(levels: number, style: WaterStyle, waterBed = true) {
  waterPreset.style = style;
  const width = 16;
  const height = Math.max(levels, 1) * 8;
  const exists = new Uint8Array(width * height);
  const level = new Uint8Array(exists.length);
  const tile = new Uint16Array(exists.length).fill(NO_TILE);
  for (let row = 0; row < Math.max(levels, 1); row++)
    for (let x = 0; x < 14; x++) {
      const i = row * 8 * width + x;
      exists[i] = 1;
      level[i] = row * 4;
      // A map without water terraces is all land.
      tile[i] = levels ? 0 : 1;
    }
  const pixel = () => new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(item: T): T => (owned.push(item), item);
  const nodes = own(new AtmosphereNodes());
  // In a match the renderer gives every atmosphere slot a texture of its own (light field, paved-surface grid,
  // weather ground mask); the defaults share one placeholder, which would hide two bindings.
  nodes.lightFieldTexture.value = own(pixel());
  nodes.surfaceTexture.value = own(pixel());
  nodes.weatherGroundTexture.value = own(pixel());
  const mapLight = new MapLightGrade(
    { width, height, z: level, exists },
    { ambient: 0.9, red: 1, green: 0.9, blue: 0.9, ground: 0.05, level: 0.008 },
  );
  own(mapLight.texture);
  const cache = {
    nodes,
    exists,
    height: level,
    tile,
    mapLight,
    manifest: {
      grid: { width, height },
      tiles: [
        { terrainType: 9, rampType: 0, file: 'water01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] },
        { terrainType: 13, rampType: 0, file: 'clear01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] },
      ],
    },
    terrainMap: {
      texture: own(pixel()),
      waterMask: own(pixel()),
      shore: own(pixel()),
      cliff: own(new DataTexture(new Uint16Array([0]), 1, 1, RedFormat, HalfFloatType)),
      waterBed,
      waterDetail: own(pixel()),
      waterSurface: { texture: own(pixel()), scale: 13 },
      ref: { file: 'terrain.png', width: 128, height: 64, scale: 1, originX: 0, originY: 0 },
    },
  } as unknown as Ra2Cache;
  const build = buildRa2Terrain(cache);
  build.mesh.userData.fixture = { art: cache.terrainMap!.texture };
  const [ground, wall] = build.mesh.material as Material[];
  cleanups.push(() => {
    build.mirrorAtlas?.dispose();
    for (const material of build.mesh.material as Material[]) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    for (const item of owned) item.dispose();
  });
  return { build, ground: ground!, wall: wall!, cache };
}

describe('terrain material texture budget', () => {
  it.each([
    ['enhanced', true],
    ['enhanced', false],
    ['classic', true],
    ['classic', false],
  ] as const)(
    'binds no more textures or samplers than a default device allows, on a map with every layer and four water levels (%s water, bed=%s)',
    (style, waterBed) => {
      const { build, ground, wall } = fullMap(4, style, waterBed);
      for (const material of [ground, wall]) {
        const bound = fragmentBindings(build.mesh.geometry, material);
        expect(new Set(bound.textures).size).toBe(bound.textures.length); // one binding per texture
        expect(bound.textures.length, `${material === ground ? 'ground' : 'wall'} textures`).toBeLessThanOrEqual(
          MAX_SAMPLED_TEXTURES,
        );
        expect(bound.samplers, `${material === ground ? 'ground' : 'wall'} samplers`).toBeLessThanOrEqual(
          bound.textures.length,
        );
      }
      // The fixture really reaches the layers: the ground is the material with the most textures of the renderer.
      expect(fragmentBindings(build.mesh.geometry, ground).textures.length).toBeGreaterThanOrEqual(waterBed ? 9 : 8);
    },
  );

  it('binds the same two mirror textures for one water level as for four (RiverRam needed eight)', () => {
    const counts = [1, 2, 3, 4].map((levels) => {
      const { build, ground } = fullMap(levels, 'enhanced');
      expect(build.mirrorAtlas!.tiles).toHaveLength(levels);
      const { textures, samplers } = fragmentBindings(build.mesh.geometry, ground);
      expect(textures.filter(isMirror)).toEqual([
        build.mirrorAtlas!.renderTarget.texture,
        build.mirrorAtlas!.renderTarget.depthTexture,
      ]);
      return `${textures.length}/${samplers}`;
    });
    expect(new Set(counts).size).toBe(1);
    // Room to spare under the limit, so one more layer does not silently take the ground away again.
    expect(Number(counts[0]!.split('/')[0])).toBeLessThan(MAX_SAMPLED_TEXTURES);
  });

  it("does not bind three's DFG lookup, which the art lighting model never reads", () => {
    const { build, ground, wall } = fullMap(1, 'enhanced');
    for (const material of [ground, wall])
      expect(fragmentBindings(build.mesh.geometry, material).textures.map((texture) => texture.name)).not.toContain(
        'DFG_LUT',
      );
  });

  it('has ever lighter stand-ins for a ground the GPU refuses: without mirrors, then the painted art alone', () => {
    const { build, ground } = fullMap(4, 'enhanced');
    const full = fragmentBindings(build.mesh.geometry, ground).textures;
    const scene = new Scene();
    scene.add(build.mesh);
    const materials = build.mesh.material as (Material & { id: number })[];
    const wall = materials[1]!;

    // First refusal: the same ground, minus the two mirror textures.
    const first = applyMaterialFallbacks(scene, new Set([(ground as Material & { id: number }).id]));
    expect(first).toHaveLength(1);
    const noMirrors = materials[0]!;
    expect(noMirrors).not.toBe(ground);
    expect(first[0]).toEqual({ from: ground, to: noMirrors });
    const lighter = fragmentBindings(build.mesh.geometry, noMirrors).textures;
    expect(lighter.length).toBe(full.length - 2);
    expect(lighter.filter(isMirror)).toEqual([]);
    for (const texture of lighter) expect(full).toContain(texture);
    expect(materials[1]).toBe(wall); // Cliff walls were not refused and stay.

    // Second refusal: the painted ground under the map's light and the local lights, nothing else.
    const second = applyMaterialFallbacks(scene, new Set([(ground as Material & { id: number }).id, noMirrors.id]));
    expect(second).toHaveLength(1);
    const plain = materials[0]!;
    expect(second[0]).toEqual({ from: noMirrors, to: plain });
    const plainTextures = fragmentBindings(build.mesh.geometry, plain).textures;
    expect(plainTextures).toContain((build.mesh.userData.fixture as { art: Texture }).art);
    expect(plainTextures.length).toBeLessThanOrEqual(3);

    // Nothing lighter exists: a third refusal changes nothing (and does not throw or loop).
    expect(
      applyMaterialFallbacks(scene, new Set([(ground as Material & { id: number }).id, noMirrors.id, plain.id])),
    ).toHaveLength(0);
    expect(materials[0]).toBe(plain);
    noMirrors.dispose();
    plain.dispose();
  });
});
