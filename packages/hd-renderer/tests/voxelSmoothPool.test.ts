import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import type { HdRenderer } from '../src/HdRenderer';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { buildSmoothSection, smoothVoxelOptions } from '../src/ra2/voxelSmooth';
import {
  buildSmoothVoxelGeometry,
  hasSmoothVoxelGeometry,
  prepareSmoothVoxelGeometry,
} from '../src/ra2/voxelSmoothGeometry';
import { SmoothVoxelPool, createSmoothVoxelPool, type SmoothWorkerLike } from '../src/ra2/voxelSmoothPool';
import { VoxelShadowMesh } from '../src/ra2/voxelShadow';
import {
  answerSmoothSection,
  smoothMeshBuffers,
  type SmoothSectionReply,
  type SmoothSectionRequest,
} from '../src/ra2/voxelSmoothWorker';
import type { HdWorld } from '../src/ra2/world';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const OPTIONS = smoothVoxelOptions({ aoRays: 0, supersample: 2 });

/** A Worker stand-in that answers with the Worker module's own handler, when the test lets it. */
class FakeWorker implements SmoothWorkerLike {
  onmessage: ((event: MessageEvent<SmoothSectionReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: SmoothSectionRequest[] = [];
  terminated = false;

  postMessage(message: SmoothSectionRequest): void {
    // A real Worker receives a structured clone, never the caller's objects.
    this.requests.push(structuredClone(message));
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the oldest unanswered request. */
  answer(): void {
    const request = this.requests.shift()!;
    const { reply } = answerSmoothSection(request);
    this.onmessage?.({ data: reply } as MessageEvent<SmoothSectionReply>);
  }

  fail(message: string): void {
    this.requests.shift();
    this.onerror?.({ message } as ErrorEvent);
  }
}

function fakePool(size: number, idleMs = 1000) {
  const workers: FakeWorker[] = [];
  const pool = new SmoothVoxelPool(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    size,
    idleMs,
  );
  return { pool, workers };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('smooth voxel Worker', () => {
  it('answers with the arrays the in-place build makes and lists every buffer for transfer', () => {
    const section = syntheticSection(4);
    const { reply, transfer } = answerSmoothSection({ id: 7, section, options: OPTIONS });
    expect(reply).toEqual({ id: 7, mesh: buildSmoothSection(section, OPTIONS) });
    const mesh = (reply as { mesh: ReturnType<typeof buildSmoothSection> }).mesh;
    expect(transfer).toEqual(smoothMeshBuffers(mesh));
    expect(new Set(transfer).size).toBe(transfer.length);
    for (const array of Object.values(mesh)) expect(transfer).toContain(array.buffer);
  });

  it('reports a failed build instead of throwing', () => {
    const { reply, transfer } = answerSmoothSection({
      id: 3,
      section: { ...syntheticSection(2), voxels: '!' },
      options: { ...OPTIONS, supersample: -1 },
    });
    expect(reply).toMatchObject({ id: 3, error: expect.any(String) });
    expect(transfer).toEqual([]);
  });
});

describe('smooth voxel pool', () => {
  it('starts Workers on demand up to its size and hands queued sections out in order', async () => {
    const { pool, workers } = fakePool(2);
    const sections = [syntheticSection(2), syntheticSection(3), syntheticSection(4)];
    const built = sections.map((section) => pool.build(section, OPTIONS));
    expect(workers).toHaveLength(2);
    expect(pool.pending).toBe(3);
    expect(workers[0]!.requests[0]!.section.size).toEqual([2, 2, 2]);
    expect(workers[1]!.requests[0]!.section.size).toEqual([3, 3, 3]);
    // The third section waits for the first Worker that becomes free.
    workers[1]!.answer();
    expect(workers[1]!.requests[0]!.section.size).toEqual([4, 4, 4]);
    workers[0]!.answer();
    workers[1]!.answer();
    const meshes = await Promise.all(built);
    for (const [index, section] of sections.entries())
      expect(meshes[index]).toEqual(buildSmoothSection(section, OPTIONS));
    expect(pool.pending).toBe(0);
    pool.dispose();
  });

  it('replaces a failed Worker and fails only the section it was building', async () => {
    const { pool, workers } = fakePool(1);
    const first = pool.build(syntheticSection(2), OPTIONS);
    const second = pool.build(syntheticSection(3), OPTIONS);
    workers[0]!.fail('boom');
    await expect(first).rejects.toThrow('boom');
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    await expect(second).resolves.toEqual(buildSmoothSection(syntheticSection(3), OPTIONS));
    pool.dispose();
  });

  it('fails what waits when no Worker can be started', async () => {
    const pool = new SmoothVoxelPool(() => {
      throw new Error('no workers here');
    }, 2);
    await expect(pool.build(syntheticSection(2), OPTIONS)).rejects.toThrow('no workers here');
    expect(pool.pending).toBe(0);
    pool.dispose();
  });

  it('terminates its Workers and rejects unfinished sections when disposed', async () => {
    const { pool, workers } = fakePool(1);
    const running = pool.build(syntheticSection(2), OPTIONS);
    const queued = pool.build(syntheticSection(3), OPTIONS);
    pool.dispose();
    await expect(running).rejects.toThrow('disposed');
    await expect(queued).rejects.toThrow('disposed');
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[0]!.onmessage).toBeNull();
    await expect(pool.build(syntheticSection(2), OPTIONS)).rejects.toThrow('disposed');
    expect(workers).toHaveLength(1);
  });

  it('closes idle Workers after the idle time and starts new ones for the next section', async () => {
    vi.useFakeTimers();
    const { pool, workers } = fakePool(2, 500);
    const first = pool.build(syntheticSection(2), OPTIONS);
    workers[0]!.answer();
    await first;
    vi.advanceTimersByTime(499);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(pool.workers).toBe(0);
    const second = pool.build(syntheticSection(2), OPTIONS);
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    await second;
    // A section that arrives before the idle time keeps the Workers.
    vi.advanceTimersByTime(400);
    const third = pool.build(syntheticSection(2), OPTIONS);
    vi.advanceTimersByTime(400);
    expect(workers[1]!.terminated).toBe(false);
    workers[1]!.answer();
    await third;
    pool.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is absent where the host has no Workers', () => {
    expect(typeof Worker).toBe('undefined');
    expect(createSmoothVoxelPool()).toBeNull();
  });
});

describe('smooth voxel geometry built off the calling thread', () => {
  it('fills the shared cache with the geometry the in-place build makes, once per model and option set', async () => {
    const { pool, workers } = fakePool(2);
    const model = syntheticModel([syntheticSection(3), syntheticSection(4)]);
    const reference = syntheticModel([syntheticSection(3), syntheticSection(4)]);
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(false);
    const first = prepareSmoothVoxelGeometry(model, OPTIONS, pool);
    // A second request while the first is running shares its build.
    expect(prepareSmoothVoxelGeometry(model, OPTIONS, pool)).toBe(first);
    expect(workers.reduce((n, worker) => n + worker.requests.length, 0)).toBe(2);
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(false);
    workers[1]!.answer();
    workers[0]!.answer();
    await first;
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(true);
    // Other options are another geometry.
    expect(hasSmoothVoxelGeometry(model, { ...OPTIONS, bandOut: 0.1 })).toBe(false);
    const nodes = new AtmosphereNodes();
    const [part] = buildSmoothVoxelGeometry(model, null, nodes, OPTIONS);
    const [expected] = buildSmoothVoxelGeometry(reference, null, nodes, OPTIONS);
    expect(workers.every((worker) => worker.requests.length === 0)).toBe(true);
    for (const name of ['position', 'normal', 'pindex', 'pshade', 'occlusion', 'curvature', 'vpos'])
      expect(part!.geometry.getAttribute(name).array).toEqual(expected!.geometry.getAttribute(name).array);
    expect(part!.geometry.getIndex()!.array).toEqual(expected!.geometry.getIndex()!.array);
    expect(part!.geometry.boundingSphere).toEqual(expected!.geometry.boundingSphere);
    // Prepared again: nothing to do, no Worker asked.
    await prepareSmoothVoxelGeometry(model, OPTIONS, pool);
    expect(workers.every((worker) => worker.requests.length === 0)).toBe(true);
    part!.geometry.dispose();
    expect(expected!.geometry).not.toBe(part!.geometry);
    expected!.geometry.dispose();
    nodes.dispose();
    pool.dispose();
  });

  it('caches nothing when a section fails', async () => {
    const { pool, workers } = fakePool(1);
    const model = syntheticModel([syntheticSection(2)]);
    const build = prepareSmoothVoxelGeometry(model, OPTIONS, pool);
    workers[0]!.fail('crashed');
    await expect(build).rejects.toThrow('crashed');
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(false);
    pool.dispose();
  });
});

describe('voxel units with a mesh builder', () => {
  function units(builder: SmoothVoxelPool | null) {
    const nodes = new AtmosphereNodes();
    const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
    const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
    const world = { voxelLook: 'remaster', smoothVoxel: OPTIONS } as HdWorld;
    return { nodes, units: new VoxelUnits(hd, world, cache, undefined, { smoothBuilder: builder }) };
  }

  it('reports a model as not ready until its mesh has been built, then builds instances without meshing', async () => {
    const { pool, workers } = fakePool(1);
    const { nodes, units: voxels } = units(pool);
    const model = syntheticModel([syntheticSection(3)]);
    expect(voxels.geometryReady(model)).toBe(false);
    expect(voxels.loading).toBe(1);
    expect(voxels.prepare(model, 'unit', 'synthetic')).toBe(false);
    // Asked again while it builds: still one build.
    expect(voxels.geometryReady(model)).toBe(false);
    expect(workers[0]!.requests).toHaveLength(1);
    const revision = voxels.revision;
    workers[0]!.answer();
    await vi.waitFor(() => expect(voxels.loading).toBe(0));
    expect(voxels.revision).toBeGreaterThan(revision);
    expect(voxels.geometryReady(model)).toBe(true);
    const unit = voxels.build(model, 'unit', 'synthetic');
    const body = unit.root.children.find((o) => o instanceof Mesh && !(o instanceof VoxelShadowMesh)) as Mesh;
    expect(body.geometry.getAttribute('pshade')).toBeDefined();
    expect(workers[0]!.requests).toHaveLength(0);
    body.geometry.dispose();
    voxels.disposeAll();
    expect(workers[0]!.terminated).toBe(true);
    nodes.dispose();
  });

  it('builds in place, with a warning, when the builder fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { pool, workers } = fakePool(1);
    const { nodes, units: voxels } = units(pool);
    const model = syntheticModel([syntheticSection(2)]);
    expect(voxels.geometryReady(model)).toBe(false);
    workers[0]!.fail('crashed');
    await vi.waitFor(() => expect(voxels.loading).toBe(0));
    expect(warn).toHaveBeenCalledOnce();
    expect(voxels.geometryReady(model)).toBe(true);
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(true);
    buildSmoothVoxelGeometry(model, null, nodes, OPTIONS)[0]!.geometry.dispose();
    voxels.disposeAll();
    nodes.dispose();
  });

  it('is always ready without a builder and for the engine look', () => {
    const { nodes, units: voxels } = units(null);
    const model = syntheticModel([syntheticSection(2)]);
    expect(voxels.geometryReady(model)).toBe(true);
    expect(voxels.loading).toBe(0);
    expect(hasSmoothVoxelGeometry(model, OPTIONS)).toBe(false);
    const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
    const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
    const { pool, workers } = fakePool(1);
    const engine = new VoxelUnits(hd, {} as HdWorld, cache, undefined, { voxelLook: 'engine', smoothBuilder: pool });
    expect(engine.geometryReady(model)).toBe(true);
    expect(workers).toHaveLength(0);
    engine.disposeAll();
    voxels.disposeAll();
    nodes.dispose();
  });
});
