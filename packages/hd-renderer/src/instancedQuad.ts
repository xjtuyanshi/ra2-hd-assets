import { InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, PlaneGeometry, type BufferGeometry } from 'three/webgpu';

/**
 * A batch whose shader supplies every instance's position. A plain Mesh avoids Three's automatic instanceMatrix
 * transform (and its capacity-dependent uniform/vertex buffers). Only the quad's position and UV are consumed.
 * The layer owns geometry/material disposal, as it does for ordinary meshes. Extra passes may share its geometry;
 * their owner disposes the shared geometry once and each pass's material separately.
 *
 * The instance count lives in one of two places:
 *  - `Mesh.count` (the default geometry): r186's RenderObject uses it for the draw's instanceCount even without
 *    InstancedMesh, and gives every such mesh a shader build of its own (its uuid is part of the builder's cache
 *    key), whatever its material;
 *  - an InstancedBufferGeometry's `instanceCount` (pass one, see `instancedQuadGeometry`): `Mesh.count` stays 1, so
 *    meshes whose materials share a shader graph (materialSlots.ts) also share the built shader. Their per-instance
 *    data must then be attributes of the geometry, read by name.
 * `instances` reads and writes the count wherever it lives.
 */
export class InstancedQuad extends Mesh<BufferGeometry, MeshBasicNodeMaterial> {
  constructor(
    material: MeshBasicNodeMaterial,
    readonly capacity: number,
    geometry: BufferGeometry = new PlaneGeometry(1, 1),
  ) {
    if (geometry.hasAttribute('normal')) geometry.deleteAttribute('normal');
    super(geometry, material);
    if (!(geometry as InstancedBufferGeometry).isInstancedBufferGeometry) this.count = capacity;
    this.frustumCulled = false;
  }

  /** Instances drawn. */
  get instances(): number {
    const geometry = this.geometry as InstancedBufferGeometry;
    return geometry.isInstancedBufferGeometry ? geometry.instanceCount : this.count;
  }
  set instances(value: number) {
    const geometry = this.geometry as InstancedBufferGeometry;
    if (geometry.isInstancedBufferGeometry) geometry.instanceCount = value;
    else this.count = value;
  }
}

/**
 * A unit quad whose instance count is the geometry's own (see InstancedQuad). The caller adds its per-instance
 * attributes by name and disposes the geometry.
 */
export function instancedQuadGeometry(instances = 0): InstancedBufferGeometry {
  // Its own four vertices: a geometry's disposal frees the GPU buffers of all its attributes.
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(quad.index);
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));
  geometry.instanceCount = instances;
  return geometry;
}
