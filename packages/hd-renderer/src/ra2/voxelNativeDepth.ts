import { Box3, Vector3, type Mesh, type NodeBuilder } from 'three/webgpu';
import { Fn, cameraFar, cameraNear, depth, dot, floor, positionWorld, userData, vec3 } from 'three/tsl';
import { isShadowPass } from '../painterDepth';
import type { ShaderNode } from '../tsl';
import { PIXELS_PER_CELL_EDGE } from '../world';
import { GROUND_DEPTH, nativeCardPush } from './nativeDepth';

/**
 * Native voxel compositing uses a bitmap card, not the rasterizer's internal depth. Retaining six percent of
 * the physical distance to that card keeps the HD model's faces ordered: its error from the ideal card is
 * bounded by KAPPA * max(abs(dot(fragment - anchor, viewForward) + cardPush)) over the posed model bounds.
 */
export const VOXEL_CARD_KAPPA = 0.06;

// The fixed dimetric camera axes from world.ts: +screen Y is down and +view Z points away from the camera.
const VIEW_FORWARD = new Vector3(-Math.sqrt(3 / 8), -0.5, -Math.sqrt(3 / 8));
const SCREEN_DOWN = new Vector3(Math.SQRT1_2 * 0.5, -Math.sqrt(3) / 2, Math.SQRT1_2 * 0.5);

export interface VoxelNativeDepth {
  anchor: Vector3;
  bottom: number;
  bonus: number;
  enabled: number;
}

export function createVoxelNativeDepth(): VoxelNativeDepth {
  return { anchor: new Vector3(), bottom: 0, bonus: 0, enabled: 0 };
}

/** Native screen rows below the draw anchor, independent of camera translation and zoom. */
export function voxelFragmentRow(fragment: Vector3, anchor: Vector3): number {
  return (
    ((fragment.x - anchor.x) * SCREEN_DOWN.x +
      (fragment.y - anchor.y) * SCREEN_DOWN.y +
      (fragment.z - anchor.z) * SCREEN_DOWN.z) *
    PIXELS_PER_CELL_EDGE
  );
}

/** CPU twin of the shader's physical-to-card pull, without the separately additive painter/clearance bias. */
export function voxelCardDelta(fragment: Vector3, anchor: Vector3, bottom: number, bonus = 0): number {
  const physical =
    (fragment.x - anchor.x) * VIEW_FORWARD.x +
    (fragment.y - anchor.y) * VIEW_FORWARD.y +
    (fragment.z - anchor.z) * VIEW_FORWARD.z;
  return (1 - VOXEL_CARD_KAPPA) * (physical + nativeCardPush(voxelFragmentRow(fragment, anchor), bottom, bonus));
}

const bounds = new Box3();
const partBounds = new Box3();
const corner = new Vector3();

/**
 * Native 0x754510 uses the rasterized bitmap's inclusive bottom. A posed world AABB is the asset-free HD
 * approximation: union the turned body, turret and barrel bounds, then project its eight corners. Callers
 * supply original part meshes only, so enlarged shadow/reflection/foam twins never extend the card.
 */
export function voxelBitmapBottom(parts: readonly Mesh[], anchor: Vector3, updateMatrices = true): number {
  bounds.makeEmpty();
  for (const mesh of parts) {
    if (updateMatrices) mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (local && !local.isEmpty()) bounds.union(partBounds.copy(local).applyMatrix4(mesh.matrixWorld));
  }
  if (bounds.isEmpty()) return 0;
  let bottom = -Infinity;
  for (let bits = 0; bits < 8; bits++) {
    corner.set(
      bits & 1 ? bounds.max.x : bounds.min.x,
      bits & 2 ? bounds.max.y : bounds.min.y,
      bits & 4 ? bounds.max.z : bounds.min.z,
    );
    bottom = Math.max(bottom, voxelFragmentRow(corner, anchor));
  }
  return Math.floor(bottom);
}

/** Ground cards and physical flight share one material; shadow passes always retain physical depth. */
export function voxelNativeDepthNode(): ShaderNode {
  return Fn(([], builder: NodeBuilder) => {
    if (isShadowPass(builder)) return depth;
    const anchor: ShaderNode = userData('voxelNativeDepth.anchor', 'vec3');
    const relative: ShaderNode = positionWorld.sub(anchor);
    const down: ShaderNode = dot(relative, vec3(SCREEN_DOWN.x, SCREEN_DOWN.y, SCREEN_DOWN.z));
    const py = down.mul(PIXELS_PER_CELL_EDGE).toVar('voxelNativeRow');
    const bottom: ShaderNode = userData('voxelNativeDepth.bottom', 'float');
    const push = bottom
      .add(userData('voxelNativeDepth.bonus', 'float'))
      .add(floor(bottom.sub(py).div(3)))
      .mul(GROUND_DEPTH);
    const physical: ShaderNode = dot(relative, vec3(VIEW_FORWARD.x, VIEW_FORWARD.y, VIEW_FORWARD.z));
    const delta = physical
      .add(push)
      .mul(1 - VOXEL_CARD_KAPPA)
      .mul(userData('voxelNativeDepth.enabled', 'float'))
      .toVar('voxelNativeDelta');
    return depth.sub(delta.add(userData('painterDepth.bias', 'float')).div(cameraFar.sub(cameraNear)));
  })();
}
