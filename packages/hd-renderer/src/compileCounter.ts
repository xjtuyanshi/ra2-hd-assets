/** The two backend calls three r186 makes when it has to build something new; both are checked before use. */
interface CompilingBackend {
  createProgram?: (...args: unknown[]) => unknown;
  createRenderPipeline?: (...args: unknown[]) => unknown;
}

/**
 * Tell `onCompile` about every shader module and render pipeline the renderer asks its backend to create.
 *
 * three r186 calls `backend.createProgram` for each new shader stage and `backend.createRenderPipeline` for each new
 * render pipeline, and only then: `Pipelines.getForRender` looks both up in its caches first. Wrapping the two
 * methods therefore costs nothing in a frame that builds nothing, which is every frame but a few; the alternative, a
 * count read once per frame, would be paid by all of them. Building these is what holds a frame up when a new kind of
 * art first appears, and a host that records stalls wants to know whether one coincided with it.
 *
 * Returns false, and wraps nothing, when the backend has neither method (a later three, a test double).
 */
export function countCompilations(backend: unknown, onCompile: (kind: 'shader' | 'pipeline') => void): boolean {
  const target = backend as CompilingBackend | null | undefined;
  if (!target) return false;
  let wrapped = false;
  const wrap = (name: 'createProgram' | 'createRenderPipeline', kind: 'shader' | 'pipeline') => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      onCompile(kind);
      return original.apply(this, args);
    };
    wrapped = true;
  };
  wrap('createProgram', 'shader');
  wrap('createRenderPipeline', 'pipeline');
  return wrapped;
}
