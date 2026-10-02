import { MRTNode, type MeshBasicNodeMaterial, type NodeBuilder } from 'three/webgpu';
import { Fn, float, output, vec4 } from 'three/tsl';
import type { AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { unlitDisplayColour } from '../unlit';

/** Reflectors use unnamed single-colour targets and no renderer MRT; keep the ordinary material output there. */
class UnlitSpriteMRT extends MRTNode {
  override setup(builder: NodeBuilder) {
    if (!builder.renderer.getMRT()) {
      this.members = [output];
      return undefined;
    }
    return super.setup(builder);
  }
}

/**
 * Self-lit instances share an atlas/batch with ordinary art. Capture their noon display colour separately so scene
 * exposure, palette events and the night display transform cannot recolour it. Both targets keep the original
 * coverage: opaque foreground clears old self-lit colour; translucent foreground covers it with the same alpha.
 * Mirrors and depth captures without the attachment retain the material's ordinary output.
 */
export function bindUnlitSpriteMaterial(
  material: MeshBasicNodeMaterial,
  unlit: ShaderNode,
  nodes: AtmosphereNodes,
): void {
  material.mrtNode = new UnlitSpriteMRT({
    output: Fn(([], builder: NodeBuilder) => {
      if (!builder.renderer.getMRT()?.has('unlit')) return output;
      return vec4(output.rgb.mul(float(1).sub(unlit)), output.a);
    })(),
    unlit: vec4(unlitDisplayColour(output.rgb, nodes).mul(unlit), output.a),
  });
}
