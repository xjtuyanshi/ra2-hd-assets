import type { NodeBuilder } from 'three/webgpu';
import { Fn, cameraFar, cameraNear, depth, userData } from 'three/tsl';
import type { ShaderNode } from './tsl';

/** Shared by a mesh object's articulated parts; measured in camera-space world units. */
export interface PainterDepth {
  bias: number;
}

export function createPainterDepth(): PainterDepth {
  return { bias: 0 };
}

/** Orthographic depth conversion; geometry retains its complete local depth range. */
export function biasedDepth(physicalDepth: number, bias: number, range: number): number {
  return physicalDepth - bias / range;
}

export function isShadowPass(builder: NodeBuilder): boolean {
  return !!(builder.material as { isShadowPassMaterial?: boolean }).isShadowPassMaterial;
}

/** Beams, rain, emitters and cards all test in the same physical depth space. Shadow passes stay physical. */
export function painterDepthNode(bias: ShaderNode): ShaderNode {
  return Fn(([], builder: NodeBuilder) =>
    isShadowPass(builder) ? depth : depth.sub(bias.div(cameraFar.sub(cameraNear))),
  )();
}

export function meshPainterDepthNode(): ShaderNode {
  return painterDepthNode(userData('painterDepth.bias', 'float'));
}
