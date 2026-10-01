import { describe, expect, it, vi } from 'vitest';
import { float, reflector, time, vec3 } from 'three/tsl';
import { NodeFrame, OrthographicCamera, Plane, Vector3, Vector4, WebGPUCoordinateSystem } from 'three/webgpu';
import { bedWaterLook, reflectionWorldPerDepth, rippledReflection, waterPreset } from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';
import { createWaterUniforms } from '../src/waterShading';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../src/world';

/** Synthetic virtual camera below the water, with the same dimetric view and oblique projection as r186. */
function obliqueMirror(waterY: number, zoom: number, width: number, height: number): OrthographicCamera {
  const halfWidth = width / PIXELS_PER_CELL_EDGE / zoom / 2;
  const halfHeight = height / PIXELS_PER_CELL_EDGE / zoom / 2;
  const camera = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 400);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  const target = new Vector3(13, waterY, -9);
  const pitch = Math.PI / 6;
  camera.position
    .copy(target)
    .addScaledVector(
      new Vector3(Math.cos(pitch) * Math.SQRT1_2, -Math.sin(pitch), Math.cos(pitch) * Math.SQRT1_2),
      150,
    );
  camera.up.set(0, -1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  // Match ReflectorNode.updateBefore(), including its q construction (do not substitute a different ortho formula).
  const plane = new Plane(new Vector3(0, 1, 0), -waterY).applyMatrix4(camera.matrixWorldInverse);
  const clip = new Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const e = camera.projectionMatrix.elements;
  const q = new Vector4(
    (Math.sign(clip.x) + e[8]!) / e[0]!,
    (Math.sign(clip.y) + e[9]!) / e[5]!,
    -1,
    (1 + e[10]!) / e[14]!,
  );
  clip.multiplyScalar(1 / clip.dot(q));
  e[2] = clip.x;
  e[6] = clip.y;
  e[10] = clip.z; // WebGPU, clipBias = 0.
  e[14] = clip.w;
  return camera;
}

describe('orthographic mirror depth to height', () => {
  it.each([
    [0, 1, 1280, 720],
    [7 * LEVEL_HEIGHT, 0.5, 1920, 1080],
    [-3 * LEVEL_HEIGHT, 2, 800, 600],
  ])('recovers height without an offset at waterY=%s, zoom=%s (%s x %s)', (waterY, zoom, width, height) => {
    const camera = obliqueMirror(waterY, zoom, width, height);
    const worldPerDepth = reflectionWorldPerDepth(camera.projectionMatrix.elements);
    expect(worldPerDepth).toBeGreaterThan(0);
    for (const h of [-0.1, 0, 0.01, LEVEL_HEIGHT, 2 * LEVEL_HEIGHT, 3 * LEVEL_HEIGHT, 5]) {
      for (const [x, z] of [
        [13, -9],
        [3, 4],
        [-6, -2],
      ]) {
        const clip = new Vector4(x, waterY + h, z, 1)
          .applyMatrix4(camera.matrixWorldInverse)
          .applyMatrix4(camera.projectionMatrix);
        expect(clip.w).toBe(1);
        const depth = clip.z / clip.w;
        expect(depth * worldPerDepth).toBeCloseTo(h, 10);
        if (h > 0) {
          expect(depth).toBeGreaterThan(0);
          expect(depth).toBeLessThan(0.999);
        }
      }
    }
    // Depth 1 is the renderer's clear/sky sentinel, far outside the object's measured height range.
    expect(worldPerDepth).toBeGreaterThan(100 * LEVEL_HEIGHT);
  });

  it('keeps the previous value for zero, non-finite or overflowing inverse scales', () => {
    const elements = new Array<number>(16).fill(0);
    expect(reflectionWorldPerDepth(elements)).toBe(0);
    for (const invalid of [0, NaN, Infinity, -Infinity, Number.MIN_VALUE]) {
      elements[6] = invalid;
      expect(reflectionWorldPerDepth(elements, 123)).toBe(123);
    }
    elements[2] = 3;
    elements[6] = 4;
    expect(reflectionWorldPerDepth(elements, 123)).toBe(0.2);
  });
});

describe('rippled lake-bed reflection graph', () => {
  it('builds with shared colour/depth tap UVs and refreshes height scale for the current camera', () => {
    const previousStyle = waterPreset.style;
    waterPreset.style = 'enhanced';
    const mirror = reflector({ resolutionScale: 0.5, depth: true });
    const depth = mirror.getDepthNode();
    const originalUv = mirror.uvNode;
    const originalDepthUv = depth.uvNode;
    const colourSamples = vi.spyOn(mirror, 'sample');
    const depthSamples = vi.spyOn(depth, 'sample');
    try {
      const water = createWaterUniforms();
      const reflection = rippledReflection(mirror, vec3(2, 0, 3), water);
      expect(reflection.colour.isNode).toBe(true);
      expect(reflection.coverage.isNode).toBe(true);
      expect(colourSamples).toHaveBeenCalledTimes(3);
      expect(depthSamples).toHaveBeenCalledTimes(4); // One height probe, then the same three UVs as colour.
      for (let i = 0; i < 3; i++) {
        expect(depthSamples.mock.calls[i + 1]![0]).toBe(colourSamples.mock.calls[i]![0]);
        expect(colourSamples.mock.results[i]!.value.getBase()).toBe(mirror);
        expect(depthSamples.mock.results[i + 1]!.value.getBase()).toBe(depth);
      }
      expect(mirror.uvNode).toBe(originalUv);
      expect(depth.uvNode).toBe(originalDepthUv);
      expect(() =>
        bedWaterLook({
          position: vec3(2, 0, 3),
          shore: float(1),
          waterness: float(1),
          art: vec3(0.4),
          uniforms: water,
          reflection,
          bedAt: () => vec3(0.4),
          columnForDisplay: (column) => column,
          reflectionLevel: float(1),
        }),
      ).not.toThrow();

      const dependencies = new Set<ShaderNode>();
      const visit = (node: ShaderNode) => {
        if (dependencies.has(node)) return;
        dependencies.add(node);
        for (const child of node.getChildren()) visit(child);
      };
      visit(reflection.colour);
      visit(reflection.coverage);
      expect(dependencies.has(water.wind)).toBe(true);
      expect(dependencies.has(water.rain)).toBe(true);
      const scales = [...dependencies].filter(
        (node) => node.isUniformNode && node.updateType === 'render' && node !== time,
      );
      expect(scales).toHaveLength(1);
      const scale = scales[0]!;
      const frame = new NodeFrame();
      frame.camera = new OrthographicCamera();
      scale.update(frame);
      expect(scale.value).toBe(0); // The cloned projection has not yet been made oblique.
      mirror.reflector.hasOutput = true;
      const virtualCamera = mirror.reflector.getVirtualCamera(frame.camera);
      virtualCamera.projectionMatrix.copy(obliqueMirror(0, 1, 1280, 720).projectionMatrix);
      scale.update(frame);
      const firstScale = scale.value;
      expect(firstScale).toBeCloseTo(reflectionWorldPerDepth(virtualCamera.projectionMatrix.elements), 10);
      virtualCamera.projectionMatrix.elements[6] = NaN;
      scale.update(frame);
      expect(scale.value).toBe(firstScale);
      frame.camera = new OrthographicCamera();
      const otherVirtualCamera = mirror.reflector.getVirtualCamera(frame.camera);
      otherVirtualCamera.projectionMatrix.copy(obliqueMirror(LEVEL_HEIGHT, 2, 800, 600).projectionMatrix);
      scale.update(frame);
      expect(scale.value).toBeCloseTo(reflectionWorldPerDepth(otherVirtualCamera.projectionMatrix.elements), 10);
      expect(scale.value).not.toBe(firstScale);
    } finally {
      waterPreset.style = previousStyle;
      mirror.dispose();
    }
  });
});
