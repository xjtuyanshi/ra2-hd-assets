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

// Camera screen-right in world axes (see world.ts): one native pixel is 1 / PIXELS_PER_CELL_EDGE along it.
const SCREEN_RIGHT = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);

/** Screen place of a world point in native pixels and its view depth in world units, on axes fixed to the map. */
export function voxelScreenPlace(point: Vector3, out: { column: number; row: number; depth: number }): typeof out {
  out.column = point.dot(SCREEN_RIGHT) * PIXELS_PER_CELL_EDGE;
  out.row = point.dot(SCREEN_DOWN) * PIXELS_PER_CELL_EDGE;
  out.depth = point.dot(VIEW_FORWARD);
  return out;
}

export interface VoxelCardExtent {
  /** Projected bounds of the posed parts relative to the draw point, native pixels (top is a row, down positive). */
  left: number;
  right: number;
  top: number;
  /** Least and greatest distance of those bounds behind the unit's own card, world units (see VOXEL_CARD_KAPPA). */
  behindMin: number;
  behindMax: number;
}

export function createVoxelCardExtent(): VoxelCardExtent {
  return { left: 0, right: 0, top: 0, behindMin: 0, behindMax: 0 };
}

/**
 * Screen bounds of the posed parts and the range of their distance behind the card with this bottom and bonus: the
 * part of the fragment depth that the six percent of physical depth still varies by across the model.
 */
export function voxelCardExtent(
  parts: readonly Mesh[],
  anchor: Vector3,
  bottom: number,
  bonus: number,
  out: VoxelCardExtent,
  updateMatrices = true,
): VoxelCardExtent {
  out.left = out.top = out.behindMin = Infinity;
  out.right = out.behindMax = -Infinity;
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
      const row = voxelFragmentRow(corner, anchor);
      corner.sub(anchor);
      const column = corner.dot(SCREEN_RIGHT) * PIXELS_PER_CELL_EDGE;
      const behind = corner.dot(VIEW_FORWARD) + nativeCardPush(Math.min(row, bottom), bottom, bonus);
      out.left = Math.min(out.left, column);
      out.right = Math.max(out.right, column);
      out.top = Math.min(out.top, row);
      out.behindMin = Math.min(out.behindMin, behind);
      out.behindMax = Math.max(out.behindMax, behind);
    }
  }
  if (out.left === Infinity) out.left = out.right = out.top = out.behindMin = out.behindMax = 0;
  return out;
}

/**
 * Whole-object resolution of a ground unit's card against static cards that write depth (the engine's terrain
 * objects, see terrainObjectCards.ts). Two cards step one unit every three rows at their own phases and the unit keeps
 * six percent of its physical depth, so where they nearly tie the winner would alternate from row to row.
 */
export interface VoxelCardTies {
  /**
   * Card units to add to the unit's bonus (zero or negative). `bias` is the unit's additive camera-space bias in
   * world units, `extent` its bounds for the same anchor, bottom and bonus.
   */
  tieBonus(anchor: Vector3, bottom: number, bonus: number, bias: number, extent: VoxelCardExtent): number;
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
