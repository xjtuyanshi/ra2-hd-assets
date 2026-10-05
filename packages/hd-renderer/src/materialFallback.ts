import type { Material, Object3D } from 'three/webgpu';

/**
 * A visible picture when the GPU refuses a material.
 *
 * WebGPU validates a render pipeline when it is created (texture and sampler counts per stage, shader code). A
 * refused pipeline does not throw: three logs the error, marks the pipeline, and every later draw with it is dropped,
 * so the object silently disappears (a refused ground material left the battlefield the clear colour while units were
 * still drawn). Materials whose loss would be that visible register a simpler stand-in here; the renderer polls for
 * refused pipelines and swaps the stand-in in.
 */

const fallbacks = new WeakMap<Material, () => Material | null>();
const resolved = new WeakMap<Material, Material | null>();

/**
 * Register the stand-in built when `material`'s pipeline is refused. The stand-in may register one of its own (a
 * ladder of ever simpler materials); the builder runs at most once per material.
 */
export function setMaterialFallback(material: Material, build: () => Material | null): void {
  fallbacks.set(material, build);
}

/** three's label of a render pipeline: `renderPipeline_<material name or type>_<material id>` (r186). */
export function materialIdOfPipelineLabel(label: string | null | undefined): number | null {
  const match = /^renderPipeline_.*_(\d+)$/.exec(label ?? '');
  return match ? Number(match[1]) : null;
}

/** The renderer internals read by failedPipelineMaterials (three r186; every member is optional on purpose). */
export interface PipelineHost {
  _pipelines?: { caches?: Map<unknown, unknown> } | null;
  backend?: { get?(object: unknown): { error?: boolean; pipeline?: { label?: string } | null } | undefined } | null;
}

/**
 * Ids of the materials whose render pipeline the GPU refused so far. three r186 keeps every pipeline in
 * `renderer._pipelines.caches` and sets `error` on its backend data when the creation's validation scope reports one
 * (WebGPUPipelineUtils.createRenderPipeline); the GPU pipeline object keeps the label that names the material. A
 * renderer without these internals (another backend or version) reports nothing, which leaves materials as they are.
 */
export function failedPipelineMaterials(renderer: PipelineHost): Set<number> {
  const failed = new Set<number>();
  const caches = renderer._pipelines?.caches;
  const backend = renderer.backend;
  if (!(caches instanceof Map) || typeof backend?.get !== 'function') return failed;
  for (const pipeline of caches.values()) {
    const data = backend.get(pipeline);
    if (!data?.error) continue;
    const id = materialIdOfPipelineLabel(data.pipeline?.label);
    if (id !== null) failed.add(id);
  }
  return failed;
}

/**
 * Swap the registered stand-in into every mesh of `root` that draws a refused material. Returns the swaps made, so
 * the caller can report them; a refused material without a stand-in is left alone (and reported by three already).
 */
export function applyMaterialFallbacks(
  root: Object3D,
  failed: ReadonlySet<number>,
): { from: Material; to: Material }[] {
  const swaps: { from: Material; to: Material }[] = [];
  if (!failed.size) return swaps;
  const standIn = (material: Material): Material | null => {
    // three assigns every material a numeric id (the one in its pipeline's label); the typings omit it here.
    if (!failed.has((material as Material & { id: number }).id)) return null;
    // One attempt per material, shared by every mesh that draws it: a stand-in that cannot be built is not retried.
    if (resolved.has(material)) return resolved.get(material)!;
    const build = fallbacks.get(material);
    const replacement = build ? build() : null;
    resolved.set(material, replacement);
    if (replacement) swaps.push({ from: material, to: replacement });
    return replacement;
  };
  root.traverse((object) => {
    const mesh = object as Object3D & { material?: Material | Material[] };
    if (!mesh.material) return;
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material, index) => {
        const replacement = standIn(material);
        if (replacement) (mesh.material as Material[])[index] = replacement;
      });
    } else {
      const replacement = standIn(mesh.material);
      if (replacement) mesh.material = replacement;
    }
  });
  return swaps;
}
