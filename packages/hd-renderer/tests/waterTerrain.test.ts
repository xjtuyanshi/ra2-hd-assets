import { afterEach, describe, expect, it, vi } from 'vitest';
import { reflector } from 'three/tsl';
import {
  DataTexture,
  Group,
  NodeFrame,
  OrthographicCamera,
  ReflectorNode,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { NO_TILE, type Ra2Cache } from '../src/ra2/cache';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { waterPreset } from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';
import { LEVEL_HEIGHT } from '../src/world';

const cleanups: (() => void)[] = [];
const originalStyle = waterPreset.style;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  waterPreset.style = originalStyle;
  vi.restoreAllMocks();
});

function terrain(waterBed = true, counts = [1, 12, 13, 14, 15, 16]) {
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
      waterBed,
      waterDetail: detailTexture,
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
  cleanups.push(() => {
    for (const mirror of mirrors) mirror.dispose();
    for (const material of materials) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    texture.dispose();
    detailTexture.dispose();
    nodes.dispose();
  });
  const detailSamples = [...seen].filter((node) => node.isTextureNode && node.value === detailTexture);
  const compositeSamples = [...seen].filter((node) => node.isTextureNode && node.value === texture);
  return { build, instances, detailSamples, compositeSamples };
}

describe('terrain water mirrors', () => {
  it('attaches four independently sampled mirror planes under one scene target for enhanced bed water', () => {
    waterPreset.style = 'enhanced';
    const { build, instances, detailSamples, compositeSamples } = terrain();
    expect(build.reflectionTarget).toBeInstanceOf(Group);
    const targets = build.reflectionTarget!.children;
    // Lowest level first: the order the mirrors render in (see selectWaterMirrorLevels).
    expect(targets.map((target) => target.position.y / LEVEL_HEIGHT)).toEqual([8, 12, 16, 20]);
    expect(instances).toHaveLength(4);
    for (const instance of instances) {
      expect(targets).toContain(instance.target);
      expect(instance.target.rotation.x).toBeCloseTo(-Math.PI / 2, 12);
      expect(instance.resolutionScale).toBe(0.5);
    }
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
    expect(detailSamples).toHaveLength(0);
  });

  it('leaves small enhanced-bed pools without a mirror target', () => {
    waterPreset.style = 'enhanced';
    const { build, instances } = terrain(true, [1, 11]);
    expect(instances).toHaveLength(0);
    expect(build.reflectionTarget).toBeNull();
  });

  it.each([WebGLCoordinateSystem, WebGPUCoordinateSystem])(
    'culls off-screen levels and resumes the original update with its receiver (coordinate system %s)',
    (coordinateSystem) => {
      const probe = reflector();
      const update = vi.spyOn(Object.getPrototypeOf(probe.reflector), 'updateBefore').mockReturnValue(false);
      probe.dispose();
      waterPreset.style = 'enhanced';
      const { instances } = terrain(true, [0, 12]);
      const instance = instances[0]!;
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
      frame.camera = camera;
      view(50, 50);
      instance.updateBefore(frame);
      expect(update).not.toHaveBeenCalled();
      // The last cell extends to x=12, padded to x=13. The view still touches its padded right edge.
      view(13.5, 8.5);
      expect(instance.updateBefore(frame)).toBe(false);
      expect(update).toHaveBeenCalledWith(frame);
      expect(update.mock.contexts[0]).toBe(instance);
      update.mockClear();
      view(14.5, 8.5);
      instance.updateBefore(frame);
      expect(update).not.toHaveBeenCalled();
      view(6, 8.5);
      instance.updateBefore(frame);
      expect(update).toHaveBeenCalledTimes(1);
      update.mockClear();
      frame.camera = null;
      instance.updateBefore(frame);
      expect(update).toHaveBeenCalledTimes(1); // Preserve three's behaviour when the frame has no camera.
    },
  );
});
