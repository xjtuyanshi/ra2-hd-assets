import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import type { VoxelModel, VoxelSection } from '../../../ra2-assets/src/manifest';
import type { AtmosphereNodes } from '../atmosphere';
import { buildStandInPartGeometry, type VoxelGeometry, type VoxelShape } from './voxels';
import { buildSmoothSection, smoothVoxelOptions, type SmoothMeshData, type SmoothVoxelOptions } from './voxelSmooth';
import type { SmoothSectionBuilder } from './voxelSmoothPool';
import { voxelPbrMaterialFor } from './voxelPbr';

/** The only GPU-facing wrapper: the core's arrays can also arrive from a Worker or an offline build. */
export function buildSmoothPartGeometry(
  sections: readonly VoxelSection[],
  options: SmoothVoxelOptions,
): BufferGeometry {
  return smoothPartGeometry(sections.map((section) => buildSmoothSection(section, options)));
}

/** One part's geometry from the meshes of its sections, in section order (wherever they were built). */
export function smoothPartGeometry(meshes: readonly SmoothMeshData[]): BufferGeometry {
  const vertices = meshes.reduce((n, m) => n + m.pindex.length, 0);
  const indexCount = meshes.reduce((n, m) => n + m.indices.length, 0);
  const geometry = new BufferGeometry();
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['pindex', 1],
    ['pshade', 1],
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
/** Builds running off the calling thread, per model and option set (see prepareSmoothVoxelGeometry). */
const building = new WeakMap<VoxelModel, Map<string, Promise<void>>>();

/** Whether buildSmoothVoxelGeometry would return this model's shared geometry without building anything. */
export function hasSmoothVoxelGeometry(model: VoxelModel, options: Partial<SmoothVoxelOptions> = {}): boolean {
  return !!shared.get(model)?.has(JSON.stringify(smoothVoxelOptions(options)));
}

/**
 * Build the model's shared geometry with `builder` (a Worker pool) instead of on the calling thread; afterwards
 * buildSmoothVoxelGeometry returns at once. The arrays are the ones the in-place build produces: the same function
 * runs on the same sections. Concurrent calls share one build. If a section cannot be built by the builder (the
 * Worker failed or was closed), the promise rejects and nothing is cached: the caller decides whether to build in
 * place.
 */
export function prepareSmoothVoxelGeometry(
  model: VoxelModel,
  options: Partial<SmoothVoxelOptions>,
  builder: SmoothSectionBuilder,
): Promise<void> {
  const smooth = smoothVoxelOptions(options);
  const key = JSON.stringify(smooth);
  if (shared.get(model)?.has(key)) return Promise.resolve();
  let pending = building.get(model);
  if (!pending) building.set(model, (pending = new Map()));
  let build = pending.get(key);
  if (!build) {
    build = Promise.all(
      model.parts.map(async (part) => ({
        role: part.role,
        meshes: await Promise.all(part.sections.map((section) => builder.build(section, smooth))),
      })),
    )
      .then((parts) => {
        let variants = shared.get(model);
        if (!variants) shared.set(model, (variants = new Map()));
        // An in-place build may have finished first; keep the geometry instances already handed out.
        if (!variants.has(key))
          variants.set(
            key,
            parts.map((part) => ({ role: part.role, geometry: smoothPartGeometry(part.meshes) })),
          );
      })
      .finally(() => pending!.delete(key));
    pending.set(key, build);
  }
  return build;
}

/** The model's shared part geometries for one option set, built here when they do not exist yet. */
function smoothParts(
  model: VoxelModel,
  smooth: Readonly<SmoothVoxelOptions>,
): { role: VoxelGeometry['role']; geometry: BufferGeometry }[] {
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
  return parts;
}

/**
 * The model's shared smooth part geometries for one option set, in the order of `model.parts`; null while they have
 * not been built (see prepareSmoothVoxelGeometry). Never builds.
 */
export function smoothVoxelPartGeometries(
  model: VoxelModel,
  options: Partial<SmoothVoxelOptions> = {},
): BufferGeometry[] | null {
  const parts = shared.get(model)?.get(JSON.stringify(smoothVoxelOptions(options)));
  return parts ? parts.map((part) => part.geometry) : null;
}

/**
 * A stand-in for the model's smooth geometry that is built on the calling thread in milliseconds: the plain
 * exposed-face mesh of every part (voxels.ts buildStandInPartGeometry), in the smooth mesh's attribute layout and in
 * the order of `model.parts`. The same model-local frame and scale as the smooth mesh, whose surface lies within a
 * fraction of a voxel of these faces, so a unit drawn with one and then the other keeps its place, size and
 * silhouette. Not cached: the caller owns the geometries and disposes them when the smooth mesh has replaced them.
 */
export function buildStandInVoxelParts(
  model: VoxelModel,
  shape?: Readonly<VoxelShape>,
): { role: VoxelGeometry['role']; geometry: BufferGeometry }[] {
  return model.parts.map((part) => ({ role: part.role, geometry: buildStandInPartGeometry(part.sections, shape) }));
}

/** Build the model's shared geometry on the calling thread when it is missing (no material is created). */
export function ensureSmoothVoxelGeometry(model: VoxelModel, options: Partial<SmoothVoxelOptions> = {}): void {
  smoothParts(model, smoothVoxelOptions(options));
}

export function buildSmoothVoxelGeometry(
  model: VoxelModel,
  palette: Uint8Array | null,
  nodes?: AtmosphereNodes,
  options: Partial<SmoothVoxelOptions> = {},
): VoxelGeometry[] {
  const parts = smoothParts(model, smoothVoxelOptions(options));
  const material = voxelPbrMaterialFor(palette, nodes);
  return parts.map((part) => ({ ...part, turretOffset: (model.turretOffset ?? 0) / 256, material }));
}
