import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import Pipelines from 'three/src/renderers/common/Pipelines.js';
// @ts-expect-error r186 exposes this internal module without a matching @types/three declaration.
import Renderer from 'three/src/renderers/common/Renderer.js';
import { installAsyncPipelines } from '../src/asyncPipelines';

/** A renderer with three's shape: `_pipelines.getForRender(renderObject, promises)` creates through the backend. */
function renderer() {
  const resolvers: (() => void)[] = [];
  const data = new Map<unknown, { error?: boolean; pipeline?: object }>();
  const createdSync: unknown[] = [];
  const backend = {
    get: (object: unknown) => {
      let entry = data.get(object);
      if (!entry) data.set(object, (entry = {}));
      return entry;
    },
  };
  const getForRender = vi.fn(function (
    this: unknown,
    renderObject: { pipeline: object },
    promises: Promise<void>[] | null = null,
  ) {
    // What three r186 does: the synchronous call when there is no list, the asynchronous one into the list otherwise.
    if (promises === null) {
      backend.get(renderObject.pipeline).pipeline = {};
      createdSync.push(renderObject);
    } else promises.push(new Promise<void>((resolve) => resolvers.push(resolve)));
    return renderObject.pipeline;
  });
  const host = { _pipelines: { getForRender }, backend };
  return { host, getForRender, resolvers, createdSync, data };
}

describe('asynchronous render pipelines', () => {
  it('relies on internals three r186 has: the draw loop asks Pipelines.getForRender and skips what is not ready', () => {
    expect(typeof Pipelines.prototype.getForRender).toBe('function');
    expect(Pipelines.prototype.getForRender.length).toBe(1);
    expect(typeof Pipelines.prototype.isReady).toBe('function');
    const draw = String(Renderer.prototype._renderObjectDirect);
    expect(draw).toContain('this._pipelines.updateForRender( renderObject )');
    expect(draw).toContain('this._pipelines.isReady( renderObject )');
    expect(String(Pipelines.prototype.updateForRender)).toContain('this.getForRender( renderObject )');
  });

  it('requests the pipeline of a drawn object asynchronously and counts it until it is compiled', async () => {
    const { host, getForRender, resolvers, createdSync } = renderer();
    const installed = installAsyncPipelines(host)!;
    expect(installed).not.toBeNull();
    const mesh = { object: {}, material: { id: 7 }, pipeline: {} };
    expect(host._pipelines.getForRender(mesh)).toBe(mesh.pipeline);
    // three was handed a list: it took the asynchronous path, and nothing was compiled in the frame.
    expect(Array.isArray(getForRender.mock.calls[0]![1])).toBe(true);
    expect(createdSync).toHaveLength(0);
    expect(installed.pending).toBe(1);
    expect(installed.requested).toBe(1);
    const other = { object: {}, material: { id: 8 }, pipeline: {} };
    host._pipelines.getForRender(other);
    expect(installed.pending).toBe(2);
    resolvers[0]!();
    await Promise.resolve();
    expect(installed.pending).toBe(1);
    resolvers[1]!();
    await Promise.resolve();
    expect(installed.pending).toBe(0);
    expect(installed.requested).toBe(2);
    expect(installed.failedMaterials.size).toBe(0);
  });

  it('keeps full-screen passes synchronous and leaves a caller with its own list alone', () => {
    const { host, getForRender, createdSync } = renderer();
    const installed = installAsyncPipelines(host)!;
    const quad = { object: { isQuadMesh: true }, material: { id: 1 }, pipeline: {} };
    host._pipelines.getForRender(quad);
    expect(getForRender.mock.calls[0]![1]).toBeNull();
    expect(createdSync).toEqual([quad]);
    expect(installed.pending).toBe(0);
    // compileAsync passes its list: it is used as it is and its promises are not counted here.
    const list: Promise<void>[] = [];
    host._pipelines.getForRender({ object: {}, material: { id: 2 }, pipeline: {} }, list);
    expect(getForRender.mock.calls[1]![1]).toBe(list);
    expect(list).toHaveLength(1);
    expect(installed.pending).toBe(0);
    expect(installed.requested).toBe(0);
  });

  it('reports the material of a refused pipeline, and can be removed again', async () => {
    const { host, getForRender, resolvers, data } = renderer();
    const installed = installAsyncPipelines(host)!;
    const mesh = { object: {}, material: { id: 41 }, pipeline: {} };
    host._pipelines.getForRender(mesh);
    // three marks the pipeline's backend data and resolves its promise all the same.
    data.set(mesh.pipeline, { error: true });
    resolvers[0]!();
    await Promise.resolve();
    expect(installed.pending).toBe(0);
    expect([...installed.failedMaterials]).toEqual([41]);
    installed.restore();
    expect(host._pipelines.getForRender).toBe(getForRender);
  });

  it('installs nothing on a renderer without these internals', () => {
    expect(installAsyncPipelines({})).toBeNull();
    expect(installAsyncPipelines({ _pipelines: null })).toBeNull();
    expect(installAsyncPipelines({ _pipelines: {} })).toBeNull();
  });
});
