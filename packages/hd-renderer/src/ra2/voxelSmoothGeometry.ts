import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import type { VoxelModel, VoxelSection } from '../../../ra2-assets/src/manifest';
import type { AtmosphereNodes } from '../atmosphere';
import type { VoxelGeometry } from './voxels';
import { buildSmoothSection, smoothVoxelOptions, type SmoothVoxelOptions } from './voxelSmooth';
import { voxelPbrMaterialFor } from './voxelPbr';

/** The only GPU-facing wrapper: the core's arrays can also arrive from a Worker or an offline build. */
export function buildSmoothPartGeometry(
  sections: readonly VoxelSection[],
  options: SmoothVoxelOptions,
): BufferGeometry {
  const meshes = sections.map((section) => buildSmoothSection(section, options));
  const vertices = meshes.reduce((n, m) => n + m.pindex.length, 0);
  const indexCount = meshes.reduce((n, m) => n + m.indices.length, 0);
  const geometry = new BufferGeometry();
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['pindex', 1],
    ['occlusion', 1],
    ['curvature', 1],
    ['vpos', 3],
  ] as const) {
    if (meshes.length === 1) {
      geometry.setAttribute(name, new BufferAttribute(meshes[0]![name], size));
      continue;
    }
    const data = new Float32Array(vertices * size);
    let offset = 0;
    for (const mesh of meshes) {
      data.set(mesh[name], offset);
      offset += mesh[name].length;
    }
    geometry.setAttribute(name, new BufferAttribute(data, size));
  }
  if (meshes.length === 1) {
    geometry.setIndex(new BufferAttribute(meshes[0]!.indices, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
  const indices = vertices > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let offset = 0;
  let base = 0;
  for (const mesh of meshes) {
    for (const index of mesh.indices) indices[offset++] = index + base;
    base += mesh.pindex.length;
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Like the engine path, geometry lifetime follows the model, while material/texture lifetime follows the world. */
const shared = new WeakMap<VoxelModel, Map<string, { role: VoxelGeometry['role']; geometry: BufferGeometry }[]>>();
export function buildSmoothVoxelGeometry(
  model: VoxelModel,
  palette: Uint8Array | null,
  nodes?: AtmosphereNodes,
  options: Partial<SmoothVoxelOptions> = {},
): VoxelGeometry[] {
  const smooth = smoothVoxelOptions(options);
  const key = JSON.stringify(smooth);
  let variants = shared.get(model);
  if (!variants) {
    variants = new Map();
    shared.set(model, variants);
  }
  let parts = variants.get(key);
  if (!parts) {
    parts = model.parts.map((part) => ({ role: part.role, geometry: buildSmoothPartGeometry(part.sections, smooth) }));
    variants.set(key, parts);
  }
  const material = voxelPbrMaterialFor(palette, nodes);
  return parts.map((part) => ({ ...part, turretOffset: (model.turretOffset ?? 0) / 256, material }));
}
