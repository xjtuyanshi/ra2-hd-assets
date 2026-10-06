/**
 * Render pipelines compiled off the frame.
 *
 * three r186 creates an object's render pipeline with the synchronous WebGPU call in the frame that first draws it.
 * The call returns at once, but the GPU process compiles the pipeline before it runs the commands that follow, and
 * presents nothing meanwhile: a quarter to half a second per pipeline of the larger materials (measured in a live
 * match: 623 ms for a new voxel unit's two pipelines, 230 to 330 ms for one more blend state of a shader that already
 * existed), with the system's shader compiler at the top of the process list. A match meets new pipelines all the
 * time: a unit type's first appearance, its first translucent frame, the first fireball next to a building.
 *
 * three also has the asynchronous call (`createRenderPipelineAsync`, used by `compileAsync`), and its draw loop
 * already leaves out an object whose pipeline is not there yet (`Pipelines.isReady`). This makes the draw loop's own
 * requests asynchronous too: the object appears when its pipeline has been compiled, a few frames later, and no frame
 * waits for a compiler. `pending` counts the pipelines still being compiled, for a host that keeps a view out of
 * sight until it is complete.
 *
 * Full-screen passes (three's QuadMesh: post-processing, the output) keep the synchronous call: a frame without them
 * would be an empty canvas, and their shaders are small.
 */

/** The renderer internals used (three r186); every member is checked, so another version simply installs nothing. */
interface PipelineInternals {
  _pipelines?: { getForRender?: (renderObject: RenderObjectLike, promises?: Promise<void>[] | null) => unknown } | null;
  backend?: { get?(object: unknown): { error?: boolean } | undefined } | null;
}

interface RenderObjectLike {
  object?: { isQuadMesh?: boolean } | null;
  material?: { id?: number } | null;
  pipeline?: unknown;
}

export interface AsyncPipelines {
  /** Pipelines requested and not yet compiled (or refused). */
  readonly pending: number;
  /** Pipelines requested asynchronously so far. */
  readonly requested: number;
  /**
   * Ids of the materials whose pipeline the GPU refused. A refused asynchronous creation leaves no pipeline object
   * whose label could name the material (materialFallback.ts reads that for the synchronous path).
   */
  readonly failedMaterials: ReadonlySet<number>;
  /** Give the renderer its own method back. */
  restore(): void;
}

/**
 * Make `renderer`'s draw loop request its pipelines asynchronously. Returns null when the renderer does not have the
 * internals this relies on; nothing is changed then.
 */
export function installAsyncPipelines(renderer: unknown): AsyncPipelines | null {
  const host = renderer as PipelineInternals;
  const pipelines = host._pipelines;
  if (!pipelines || typeof pipelines.getForRender !== 'function') return null;
  const original = pipelines.getForRender;
  const failed = new Set<number>();
  let pending = 0;
  let requested = 0;
  pipelines.getForRender = function (
    this: unknown,
    renderObject: RenderObjectLike,
    promises: Promise<void>[] | null = null,
  ): unknown {
    // compileAsync brings its own list; full-screen passes must be there in the frame that needs them.
    if (promises !== null || renderObject.object?.isQuadMesh === true)
      return original.call(this, renderObject, promises);
    const created: Promise<void>[] = [];
    const result = original.call(this, renderObject, created);
    for (const promise of created) {
      pending++;
      requested++;
      const settle = (): void => {
        pending--;
        const id = renderObject.material?.id;
        if (typeof id === 'number' && host.backend?.get?.(renderObject.pipeline)?.error === true) failed.add(id);
      };
      // three resolves its promise whatever the outcome; a rejection would otherwise be counted as pending for ever.
      promise.then(settle, settle);
    }
    return result;
  };
  return {
    get pending() {
      return pending;
    },
    get requested() {
      return requested;
    },
    failedMaterials: failed,
    restore() {
      pipelines.getForRender = original;
    },
  };
}
