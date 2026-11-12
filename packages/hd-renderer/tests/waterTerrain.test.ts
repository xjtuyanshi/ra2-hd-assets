import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  HalfFloatType,
  NodeFrame,
  OrthographicCamera,
  RedFormat,
  ReflectorNode,
  Vector2,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type RenderTarget,
} from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { NO_TILE, type Ra2Cache } from '../src/ra2/cache';
import { mirrorAtlasTileRect } from '../src/mirrorAtlas';
import { buildRa2Terrain, waterLevelBounds } from '../src/ra2/terrain';
import { waterPreset } from '../src/ra2/waterLook';
import * as waterLook from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';
import { IsoCamera, LEVEL_HEIGHT, MIRROR_SKIP_LAYER } from '../src/world';

const cleanups: (() => void)[] = [];
const originalStyle = waterPreset.style;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  waterPreset.style = originalStyle;
  vi.restoreAllMocks();
});

function terrain(waterBed = true, counts = [1, 12, 13, 14, 15, 16], hasCliff = false) {
  const width = Math.max(...counts, 1);
  const height = counts.length * 8;
  const exists = new Uint8Array(width * height);
  const levels = new Uint8Array(exists.length);
  const tile = new Uint16Array(exists.length).fill(NO_TILE);
  counts.forEach((count, row) => {
    for (let x = 0; x < count; x++) {
      const i = row * 8 * width + x;
      exists[i] = 1;
      levels[i] = row * 4;
      tile[i] = 0;
    }
  });
  const texture = new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
  const detailTexture = new DataTexture(new Uint8Array([24, 72, 96, 128]), 1, 1);
  const cliffTexture = hasCliff ? new DataTexture(new Uint16Array([0]), 1, 1, RedFormat, HalfFloatType) : null;
  const nodes = new AtmosphereNodes();
  const cache = {
    nodes,
    exists,
    height: levels,
    tile,
    mapLight: null,
    manifest: {
      grid: { width, height },
      tiles: [{ terrainType: 9, rampType: 0, file: 'water01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] }],
    },
    terrainMap: {
      texture,
      waterMask: texture,
      shore: texture,
      cliff: cliffTexture,
      waterBed,
      waterDetail: detailTexture,
      waterSurface: null,
      ref: { file: 'terrain.png', width: 128, height: 64, scale: 1, originX: 0, originY: 0 },
    },
  } as unknown as Ra2Cache;
  const build = buildRa2Terrain(cache);
  const materials = Array.isArray(build.mesh.material) ? build.mesh.material : [build.mesh.material];
  const mirrors = new Set<ReflectorNode>();
  const seen = new Set<ShaderNode>();
  const visit = (node: ShaderNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof ReflectorNode) mirrors.add(node.getBase() as ReflectorNode);
    for (const child of node.getChildren()) visit(child);
  };
  for (const material of materials) visit((material as unknown as { emissiveNode: ShaderNode }).emissiveNode);
  const instances = [...new Set([...mirrors].map((mirror) => mirror.reflector))];
  const atlas = build.mirrorAtlas;
  // Taps are the `.sample(uv)` clones; each refers back to the atlas's own node, which is not a tap itself.
  const atlasSamples = (value: unknown) =>
    [...seen].filter((node) => node.isTextureNode && node.value === value && node.referenceNode);
  cleanups.push(() => {
    atlas?.dispose();
    for (const mirror of mirrors) mirror.dispose();
    for (const material of materials) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    texture.dispose();
    detailTexture.dispose();
    cliffTexture?.dispose();
    nodes.dispose();
  });
  const detailSamples = [...seen].filter((node) => node.isTextureNode && node.value === detailTexture);
  const compositeSamples = [...seen].filter((node) => node.isTextureNode && node.value === texture);
  const renderTargetTextures = new Set(
    [...seen]
      .filter((node) => node.isTextureNode && (node.value?.isRenderTargetTexture || node.value?.isDepthTexture))
      .map((node) => node.value),
  );
  return { build, instances, detailSamples, compositeSamples, cliffTexture, atlas, atlasSamples, renderTargetTextures };
}

describe('terrain water mirrors', () => {
  it('exposes water levels only for existing water cells, including elevated water and map boundaries', () => {
    const { build } = terrain(true, [1, 12]);
    expect(build.waterHeightAt!(0.5, 0.5)).toBe(0);
    expect(build.waterHeightAt!(4.5, 8.5)).toBe(4 * LEVEL_HEIGHT);
    for (const [x, z] of [
      [-0.1, 0],
      [0, -0.1],
      [12, 8],
      [0, 16],
      [1.5, 0.5],
      [0.5, 1.5],
    ])
      expect(build.waterHeightAt!(x!, z!)).toBeUndefined();
  });
  it.each([false, true])(
    'passes the optional cliff distance to bed water with composite UVs (cliff=%s)',
    (hasCliff) => {
      waterPreset.style = 'enhanced';
      const bed = vi.spyOn(waterLook, 'bedWaterLook');
      const { cliffTexture } = terrain(true, [1], hasCliff);
      expect(bed).toHaveBeenCalledTimes(1);
      const inputs = bed.mock.calls[0]![0];
      if (hasCliff) {
        expect(inputs.cliff.components).toBe('x'); // TSL canonicalises the red-channel swizzle to x.
        expect(inputs.cliff.node.value).toBe(cliffTexture);
        expect(inputs.cliff.node.uvNode).toBe(inputs.detail.uvNode);
      } else {
        expect(inputs.cliff).toBeUndefined();
      }
    },
  );

  it('mirrors the four water levels of the enhanced bed in one atlas under one scene target', () => {
    waterPreset.style = 'enhanced';
    const { build, instances, detailSamples, compositeSamples, atlas, atlasSamples, renderTargetTextures } = terrain();
    expect(atlas).not.toBeNull();
    // The scene target the mirrors hang from (their plane heights are local to it).
    expect(build.reflectionTarget).toBe(atlas!.target);
    // Lowest level first: the order the mirrors render in (see selectWaterMirrorLevels).
    expect(atlas!.tiles.map((tile) => tile.plane.y / LEVEL_HEIGHT)).toEqual([8, 12, 16, 20]);
    expect(atlas!.layout).toEqual({ columns: 2, rows: 2 });
    expect(atlas!.resolutionScale).toBe(0.5);
    // Each level is culled by the box of its own cells (rows 2..5 of the fixture hold 13..16 cells at levels 8..20).
    atlas!.tiles.forEach((tile, index) => {
      const count = 13 + index;
      const level = {
        level: 8 + index * 4,
        count,
        minX: 0,
        maxX: count - 1,
        minY: (index + 2) * 8,
        maxY: (index + 2) * 8,
      };
      expect(tile.plane.bounds).toEqual(waterLevelBounds(level));
    });
    // No mirror of three's own (one render target each) is left: four levels cost two sampled textures, not eight.
    expect(instances).toHaveLength(0);
    expect([...renderTargetTextures]).toEqual(
      expect.arrayContaining([atlas!.renderTarget.texture, atlas!.renderTarget.depthTexture]),
    );
    expect(renderTargetTextures.size).toBe(2);
    // Every level still takes its own three colour and four depth taps (rippledReflection), now inside its tile.
    expect(atlasSamples(atlas!.renderTarget.texture)).toHaveLength(4 * 3);
    expect(atlasSamples(atlas!.renderTarget.depthTexture)).toHaveLength(4 * 4);
    expect(build.waterY).toBeNull(); // Original maps still have no separate visible water plane.
    expect(detailSamples).toHaveLength(1);
    expect(compositeSamples.some((sample) => sample.uvNode === detailSamples[0]!.uvNode)).toBe(true);
  });

  it.each([
    { style: 'classic', bed: true },
    { style: 'enhanced', bed: false },
  ] as const)('keeps the uncapped single lowest plane for $style (bed=$bed)', ({ style, bed }) => {
    waterPreset.style = style;
    const { build, instances, detailSamples } = terrain(bed);
    expect(instances).toHaveLength(1);
    expect(build.reflectionTarget).toBe(instances[0]!.target);
    expect(build.reflectionTarget!.position.y).toBe(0); // Only one water cell: legacy does not apply the new threshold.
    expect(build.mirrorAtlas).toBeNull();
    expect(detailSamples).toHaveLength(0);
  });

  it('keeps flat shadows on the water out of the single-plane mirror, as the mirror atlas does', () => {
    waterPreset.style = 'classic';
    const { instances } = terrain(true);
    const sceneCamera = new IsoCamera().camera;
    expect(sceneCamera.layers.isEnabled(MIRROR_SKIP_LAYER)).toBe(true);
    const virtual = (instances[0] as unknown as { getVirtualCamera(c: Camera): Camera }).getVirtualCamera(sceneCamera);
    expect(virtual).not.toBe(sceneCamera);
    // Without this the mirror drew the shadow lying on its own plane and the water darkened it a second time.
    expect(virtual.layers.isEnabled(MIRROR_SKIP_LAYER)).toBe(false);
    expect(virtual.layers.isEnabled(0)).toBe(true);
    expect(sceneCamera.layers.isEnabled(MIRROR_SKIP_LAYER)).toBe(true);
  });

  it('leaves small enhanced-bed pools without a mirror target', () => {
    waterPreset.style = 'enhanced';
    const { build, instances } = terrain(true, [1, 11]);
    expect(instances).toHaveLength(0);
    expect(build.reflectionTarget).toBeNull();
    expect(build.mirrorAtlas).toBeNull();
  });

  it.each([WebGLCoordinateSystem, WebGPUCoordinateSystem])(
    'culls off-screen levels and renders a visible level into its tile with the ground hidden (coordinate system %s)',
    (coordinateSystem) => {
      waterPreset.style = 'enhanced';
      const { build, atlas } = terrain(true, [0, 12]);
      expect(atlas!.tiles).toHaveLength(1);
      const ground = (build.mesh.material as { visible: boolean }[])[0]!;
      const renders: { camera: Camera; viewport: number[]; groundVisible: boolean }[] = [];
      let target: RenderTarget | null = null;
      const renderer = {
        coordinateSystem,
        autoClear: true,
        autoClearColor: true,
        autoClearDepth: true,
        autoClearStencil: true,
        getDrawingBufferSize: (size: Vector2) => size.set(800, 600),
        getRenderTarget: () => target,
        setRenderTarget: (next: RenderTarget | null) => void (target = next),
        getMRT: () => null,
        setMRT: () => undefined,
        getScissorTest: () => false,
        setScissorTest: () => undefined,
        render: (_scene: unknown, camera: Camera) =>
          void renders.push({ camera, viewport: target!.viewport.toArray(), groundVisible: ground.visible }),
      };
      const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
      camera.coordinateSystem = coordinateSystem;
      camera.updateProjectionMatrix();
      camera.up.set(0, 0, -1);
      const view = (x: number, z: number) => {
        camera.position.set(x, 10, z);
        camera.lookAt(x, 4 * LEVEL_HEIGHT, z);
        camera.updateMatrixWorld();
      };
      const frame = new NodeFrame();
      Object.assign(frame, { camera, renderer, scene: { name: '' }, material: ground, object: build.mesh });
      view(50, 50);
      atlas!.node.updateBefore(frame);
      expect(renders).toHaveLength(0);
      // The last cell extends to x=12, padded to x=13. The view still touches its padded right edge.
      view(13.5, 8.5);
      atlas!.node.updateBefore(frame);
      expect(renders).toHaveLength(1);
      expect(renders[0]!.camera).toBe(atlas!.tiles[0]!.reflector.getVirtualCamera(camera));
      expect(renders[0]!.viewport).toEqual(mirrorAtlasTileRect(0, 1, 400, 300));
      // The ground samples the atlas, so it is not drawn into it; afterwards it is visible again.
      expect(renders[0]!.groundVisible).toBe(false);
      expect(ground.visible).toBe(true);
      expect(target).toBeNull();
      renders.length = 0;
      view(14.5, 8.5);
      atlas!.node.updateBefore(frame);
      expect(renders).toHaveLength(0);
      view(6, 8.5);
      atlas!.node.updateBefore(frame);
      expect(renders).toHaveLength(1);
      renders.length = 0;
      // A frame without a camera has no view to mirror: nothing is rendered and nothing throws.
      Object.assign(frame, { camera: null });
      expect(atlas!.node.updateBefore(frame)).toBe(false);
      expect(renders).toHaveLength(0);
    },
  );
});

describe('runtime water look switching', () => {
  it.each([false, true])('reuses enhanced material and mirror graph across looks (bed=%s)', (bed) => {
    waterPreset.style = 'enhanced';
    const { build } = terrain(bed);
    const materials = build.mesh.material,
      mirror = build.reflectionTarget,
      atlas = build.mirrorAtlas;
    const ground = (materials as { version: number }[])[0]!;
    const version = ground.version;
    for (const style of ['faithful', 'muted', 'calm', 'enhanced', 'faithful'] as const) {
      expect(build.setWaterLook(style)).toBe(style);
      expect(build.mesh.material).toBe(materials);
      expect(build.reflectionTarget).toBe(mirror);
      expect(build.mirrorAtlas).toBe(atlas);
      expect(ground.version).toBe(version);
    }
    expect(build.water.artToneForce?.value).toBe(1);
    expect(build.waterTuning.artToneReflection.value).toBe(0.06);
  });
  it.each([false, true])('parks classic, enhanced and clear once and restores each material (bed=%s)', (bed) => {
    waterPreset.style = 'classic';
    const { build } = terrain(bed);
    const classic = build.mesh.material;
    build.setWaterLook('enhanced');
    const enhanced = build.mesh.material;
    expect(enhanced).not.toBe(classic);
    build.setWaterLook('clear');
    const clear = build.mesh.material;
    expect(clear).not.toBe(enhanced);
    expect(clear).not.toBe(classic);
    build.setWaterLook('classic');
    expect((build.mesh.material as unknown[])[0]).toBe((classic as unknown[])[0]);
    build.setWaterLook('muted');
    expect((build.mesh.material as unknown[])[0]).toBe((enhanced as unknown[])[0]);
    build.setWaterLook('clear');
    expect((build.mesh.material as unknown[])[0]).toBe((clear as unknown[])[0]);
    expect(build.waterTuning.level.value).toBe(1);
    expect(build.water.artToneForce?.value).toBe(0);
    build.disposeWaterLooks();
  });
});
