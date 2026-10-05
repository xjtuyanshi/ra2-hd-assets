import { Vector3, type Mesh, type NodeBuilder } from 'three/webgpu';
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

const corner = new Vector3();

/**
 * Rows the engine's voxel bitmap extends beyond the projected bounds of the model on every side (YR 1.001 0x754510:
 * the surface is the bounds plus eight pixels, placed four pixels before their minimum).
 */
export const VOXEL_BITMAP_MARGIN = 4;

/**
 * Inclusive bottom row of the unit's bitmap below its draw point. The engine (0x754510) takes the screen bounds of
 * the model as it is posed: turned, tilted on a ramp, turret and barrel articulated. Each part's own box is therefore
 * projected corner by corner. (A world-axis box around the posed parts overshot by up to a third of a cell for a body
 * turned 45 degrees or tilted, which let a vehicle draw over a tree or wall it stands behind.) Callers supply original
 * part meshes only, so enlarged shadow/reflection/foam twins never extend the card.
 */
export function voxelBitmapBottom(parts: readonly Mesh[], anchor: Vector3, updateMatrices = true): number {
  let bottom = -Infinity;
  for (const mesh of parts) {
    if (updateMatrices) mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local || local.isEmpty()) continue;
    for (let bits = 0; bits < 8; bits++) {
      corner
        .set(
          bits & 1 ? local.max.x : local.min.x,
          bits & 2 ? local.max.y : local.min.y,
          bits & 4 ? local.max.z : local.min.z,
        )
        .applyMatrix4(mesh.matrixWorld);
      bottom = Math.max(bottom, voxelFragmentRow(corner, anchor));
    }
  }
  return bottom === -Infinity ? 0 : Math.floor(bottom) + VOXEL_BITMAP_MARGIN - 1;
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
