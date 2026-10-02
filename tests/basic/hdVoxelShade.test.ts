/** HD renderer voxel shading: the engine's shade-section rule (YR 1.001 @0x7586F0), CPU twin of the shader. */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_SECTION_SCALE,
  ENGINE_SPECULAR,
  derivedVoxelLight,
  engineVoxelSection,
} from '../../packages/hd-renderer/src/ra2/vpl';

describe('engine voxel shade section', () => {
  const light = derivedVoxelLight();

  it('derives the voxel light from the engine constants', () => {
    expect(light.x).toBeCloseTo(0.2013, 3);
    expect(light.y).toBeCloseTo(-0.3622, 3);
    expect(light.z).toBeCloseTo(0.9101, 3);
    expect(ENGINE_SECTION_SCALE).toBe(16);
    expect(ENGINE_SPECULAR).toBe(3);
  });

  it('adds the diffuse term and the rational highlight around the light and the model up axis', () => {
    // Facing the light: diffuse 1, highlight b / (3 - 2b) with b = L . H.
    const h = light.clone();
    h.y += 1;
    h.normalize();
    const b = light.dot(h);
    expect(engineVoxelSection([light.x, light.y, light.z])).toBe(Math.trunc(16 * (1 + b / (3 - 2 * b))));
    // Straight up: no diffuse (the light is below the horizon in HD axes), the highlight alone.
    expect(engineVoxelSection([0, 1, 0])).toBe(Math.trunc(16 * (h.y / (3 - 2 * h.y))));
    // Along the half vector the highlight is 1 and the diffuse L . H.
    expect(engineVoxelSection([h.x, h.y, h.z])).toBe(Math.trunc(16 * (light.dot(h) + 1)));
  });

  it('is 0 for normals facing away from the light and its half vector', () => {
    expect(engineVoxelSection([-light.x, -light.y, -light.z])).toBe(0);
  });
});
