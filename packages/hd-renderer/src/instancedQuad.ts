import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';

/**
 * A batch whose shader supplies every instance's position. A plain Mesh avoids Three's automatic instanceMatrix
 * transform (and its capacity-dependent uniform/vertex buffers). r186's RenderObject uses Mesh.count for the draw's
 * instanceCount even without InstancedMesh. Only the quad's position and UV are consumed.
 * The layer owns geometry/material disposal, as it does for ordinary meshes. Extra passes may share its geometry;
 * their owner disposes the shared geometry once and each pass's material separately.
 */
export class InstancedQuad extends Mesh<PlaneGeometry, MeshBasicNodeMaterial> {
  constructor(
    material: MeshBasicNodeMaterial,
    readonly capacity: number,
    geometry = new PlaneGeometry(1, 1),
  ) {
    geometry.deleteAttribute('normal');
    super(geometry, material);
    this.count = capacity;
    this.frustumCulled = false;
  }
}
