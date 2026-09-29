import { Vector3, type NodeBuilder } from 'three/webgpu';
import { Fn, atan, cameraViewMatrix, depth, positionWorld, userData, vec4 } from 'three/tsl';
import type { ShaderNode } from './tsl';

/** Per-object depth slot; negative depth leaves ordinary scene depth unchanged. */
export interface PainterDepth {
  depth: number;
  slotWidth: number;
  /** Fraction of the slot reserved in front of its centre for a later object component. */
  part: number;
  /** Physical world origin shared by all meshes of an object, including its articulated parts. */
  origin: Vector3;
}

export function createPainterDepth(): PainterDepth {
  return { depth: -1, slotWidth: 0, part: 0, origin: new Vector3() };
}

/** Half-width of the physical geometry's reserved interval inside an object's depth slot. */
export const VOXEL_PAINTER_SPAN = 0.2;

/** CPU counterpart of the shader's monotonic local compression; negative depth is the disabled sentinel. */
export function meshPainterDepth(slotDepth: number, slotWidth: number, part: number, localDepth: number): number {
  if (slotDepth < 0) return -1;
  return slotDepth - part * slotWidth + Math.atan(localDepth) * ((2 * VOXEL_PAINTER_SPAN) / Math.PI) * slotWidth;
}

function isShadowPass(builder: NodeBuilder): boolean {
  return !!(builder.material as { isShadowPassMaterial?: boolean }).isShadowPassMaterial;
}

/** Keep placement independent of ordering; disabled instances retain their existing physical depth. */
export function painterDepthNode(encoded: ShaderNode): ShaderNode {
  return Fn(([], builder: NodeBuilder) =>
    isShadowPass(builder) ? depth : encoded.greaterThanEqual(0).select(encoded, depth),
  )();
}

/**
 * Shared materials read the current mesh's slot rather than owning a per-unit material. Physical geometry depth
 * remains strictly monotonic within 40% of a slot, so parts retain self-occlusion without crossing another object's
 * slot. The bounded mapping does not flatten large models at an arbitrary cutoff. Geometry, lighting and shadow
 * transforms remain physical; only the depth test uses this value.
 */
export function meshPainterDepthNode(): ShaderNode {
  const slot: ShaderNode = userData('painterDepth.depth', 'float');
  const width: ShaderNode = userData('painterDepth.slotWidth', 'float');
  const part: ShaderNode = userData('painterDepth.part', 'float');
  const origin: ShaderNode = userData('painterDepth.origin', 'vec3');
  const localDepth: ShaderNode = cameraViewMatrix.mul(vec4(positionWorld.sub(origin), 0)).z.negate();
  const local: ShaderNode = atan(localDepth)
    .mul((2 * VOXEL_PAINTER_SPAN) / Math.PI)
    .mul(width);
  const encoded: ShaderNode = slot.sub(part.mul(width)).add(local);
  return Fn(([], builder: NodeBuilder) =>
    isShadowPass(builder) ? depth : slot.greaterThanEqual(0).select(encoded, depth),
  )();
}
