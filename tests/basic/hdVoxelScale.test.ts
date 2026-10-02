/** HD renderer voxel placement: scale, turret offset and engine-style flattened shadows. */
import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../../packages/ra2-assets/src/manifest';
import { PIXELS_PER_CELL_EDGE } from '../../packages/hd-renderer/src/world';
import { VOXEL_TO_WORLD, buildVoxelGeometry, instantiateVoxel } from '../../packages/hd-renderer/src/ra2/voxels';
import {
  AIRBORNE_SHADOW_HALF,
  SHADOW_COPIES,
  SHADOW_LIFT,
  SHADOW_SHEAR_X,
  SHADOW_SHEAR_Z,
  VoxelShadowMesh,
  VoxelWaterMesh,
  airborneShadowProjection,
  airborneShadowScale,
  shadowProjection,
} from '../../packages/hd-renderer/src/ra2/voxelShadow';

/** One 2x1x1 voxel section per part, identity transform. */
function model(turretOffset: number): VoxelModel {
  const voxels = btoa(String.fromCharCode(0, 0, 0, 100, 0, 1, 0, 0, 101, 0));
  const section = {
    name: 's',
    size: [2, 1, 1] as [number, number, number],
    scale: 1 / 12,
    minBounds: [0, 0, 0] as [number, number, number],
    maxBounds: [2, 1, 1] as [number, number, number],
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    voxels,
  };
  return {
    id: 'TEST',
    palette: 'unit',
    normalsMode: 4,
    turretOffset,
    parts: [
      { role: 'body', sections: [section] },
      { role: 'turret', sections: [section] },
    ],
  };
}

const palette = new Uint8Array(768).map((_, i) => i % 256);

/** three's Vector3 through the renderer's own instances (the repository root does not depend on three). */
const unit = instantiateVoxel(
  buildVoxelGeometry(model(0), palette),
  buildVoxelGeometry(model(0), palette)[0]!.material!,
);
const vec = (x: number, y: number, z: number) => unit.root.position.clone().set(x, y, z);

describe('voxel scale', () => {
  it('draws one voxel as one pixel of the voxel camera: 1 / PIXELS_PER_CELL_EDGE world units, 6.034 leptons', () => {
    expect(VOXEL_TO_WORLD).toBe(1 / PIXELS_PER_CELL_EDGE);
    expect(VOXEL_TO_WORLD * 256).toBeCloseTo(256 / (30 * Math.SQRT2), 9);
    expect(VOXEL_TO_WORLD * 256).toBeCloseTo(6.034, 3);
  });

  it('turns the turret around the art TurretOffset (leptons along the nose), not the turret bounds', () => {
    const parts = buildVoxelGeometry(model(-100), palette);
    expect(parts.map((p) => p.role)).toEqual(['body', 'turret']);
    expect(parts[1]!.turretOffset).toBeCloseTo(-100 / 256, 9);
    const { root, turret } = instantiateVoxel(parts, parts[0]!.material!);
    expect(turret?.type).toBe('Group');
    expect(turret!.position.toArray()).toEqual([-100 / 256, 0, 0]);
    expect(turret!.children[0]!.position.toArray()).toEqual([0, 0, 0]);
    // Voxel meshes cast no sun shadow; each part has contact-shadow twins instead, after all parts.
    const meshes = root.children.filter((c) => (c as { isMesh?: boolean }).isMesh);
    const twins = meshes.filter((m) => m instanceof VoxelShadowMesh);
    expect(twins.length).toBe(2 * SHADOW_COPIES.length);
    expect(meshes.filter((m) => !(m instanceof VoxelShadowMesh)).every((m) => !m.castShadow)).toBe(true);
    // Body mesh, turret group, then all surface twins (their sources update first).
    expect(root.children.slice(2).every((c) => c instanceof VoxelShadowMesh || c instanceof VoxelWaterMesh)).toBe(true);
    const water = meshes.filter((m) => m instanceof VoxelWaterMesh);
    expect(water.filter((m) => m.layer === 'foam')).toHaveLength(2 * SHADOW_COPIES.length);
    expect(water.filter((m) => m.layer === 'reflection')).toHaveLength(2);
    expect(water.every((m) => !m.visible)).toBe(true);
    expect(meshes.length).toBe(1 + 2 * (2 * SHADOW_COPIES.length + 1));
  });
});

describe('flattened voxel shadow projection', () => {
  it('drops a point h above the ground plane to (x + a h, g + lift, z + b h)', () => {
    const g = 0.4;
    const matrix = shadowProjection(vec(10, g, 20));
    for (const h of [0, 0.1, 0.35, 1.2]) {
      const p = vec(10.3, g + h, 19.6).applyMatrix4(matrix);
      expect(p.x).toBeCloseTo(10.3 + SHADOW_SHEAR_X * h, 9);
      expect(p.y).toBeCloseTo(g + SHADOW_LIFT, 9);
      expect(p.z).toBeCloseTo(19.6 + SHADOW_SHEAR_Z * h, 9);
    }
  });

  it('lands every point on a sloped ground plane (lifted along its normal)', () => {
    const ground = vec(5, 1, 5);
    const normal = vec(0.3, 1, -0.2).normalize();
    const matrix = shadowProjection(ground, normal);
    for (const q of [vec(5, 1.5, 5), vec(4.2, 2.3, 6.1), vec(5.5, 1.1, 4.4)]) {
      const p = q.clone().applyMatrix4(matrix);
      expect(p.clone().sub(ground).dot(normal)).toBeCloseTo(SHADOW_LIFT, 9);
      // The offset from the source point is along the shadow direction.
      const offset = p.clone().sub(q).sub(normal.clone().multiplyScalar(SHADOW_LIFT));
      const dir = vec(SHADOW_SHEAR_X, -1, SHADOW_SHEAR_Z);
      expect(offset.clone().cross(dir).length()).toBeLessThan(1e-9);
    }
  });
});

describe('airborne voxel shadows', () => {
  it('shrink with height: full size on the ground, half at the calibrated height', () => {
    expect(airborneShadowScale(0)).toBe(1);
    expect(airborneShadowScale(AIRBORNE_SHADOW_HALF)).toBeCloseTo(0.5, 9);
    expect(airborneShadowScale(3 * AIRBORNE_SHADOW_HALF)).toBeCloseTo(0.25, 9);
  });

  it('drop the model straight down onto the ground point, scaled about it, keeping only its own body shear', () => {
    const origin = vec(10, 6, 20);
    const ground = vec(10.2, 0.8, 19.7);
    const scale = 0.5;
    const matrix = airborneShadowProjection(origin, ground, scale);
    // The unit's origin lands on the ground point; a point h above the origin moves by the shear times h, scaled.
    const o = origin.clone().applyMatrix4(matrix);
    expect(o.toArray().map((v) => +v.toFixed(9))).toEqual([10.2, +(0.8 + SHADOW_LIFT).toFixed(9), 19.7]);
    const p = vec(11, 6.4, 19).applyMatrix4(matrix);
    expect(p.x).toBeCloseTo(10.2 + scale * (1 + SHADOW_SHEAR_X * 0.4), 9);
    expect(p.y).toBeCloseTo(0.8 + SHADOW_LIFT, 9);
    expect(p.z).toBeCloseTo(19.7 + scale * (-1 + SHADOW_SHEAR_Z * 0.4), 9);
  });
});

describe('voxel geometry sharing', () => {
  it('builds geometry once per model and gives each palette its own material', () => {
    const m = model(0);
    const other = new Uint8Array(768).map((_, i) => (i * 7) % 256);
    const a = buildVoxelGeometry(m, palette);
    const b = buildVoxelGeometry(m, other);
    expect(b[0]!.geometry).toBe(a[0]!.geometry);
    expect(b[0]!.material).not.toBe(a[0]!.material);
    expect(buildVoxelGeometry(m, palette)[0]!.material).toBe(a[0]!.material);
    // Palette indices, not colours, travel with the vertices.
    expect(a[0]!.geometry.getAttribute('pindex')).toBeDefined();
    expect(a[0]!.geometry.getAttribute('color')).toBeUndefined();
  });
});
