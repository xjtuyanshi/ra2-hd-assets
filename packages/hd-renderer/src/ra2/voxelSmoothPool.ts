import type { VoxelSection } from '../../../ra2-assets/src/manifest';
import type { SmoothMeshData, SmoothVoxelOptions } from './voxelSmooth';
import type { SmoothSectionReply, SmoothSectionRequest } from './voxelSmoothWorker';

/** Builds smooth section meshes somewhere other than the calling thread. */
export interface SmoothSectionBuilder {
  build(section: VoxelSection, options: SmoothVoxelOptions): Promise<SmoothMeshData>;
}

/** The part of a Worker the pool uses (tests supply their own). */
export interface SmoothWorkerLike {
  onmessage: ((event: MessageEvent<SmoothSectionReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SmoothSectionRequest): void;
  terminate(): void;
}

interface Job {
  request: SmoothSectionRequest;
  resolve(mesh: SmoothMeshData): void;
  reject(error: Error): void;
}

interface Slot {
  worker: SmoothWorkerLike;
  job: Job | null;
}

/**
 * Workers left idle this long are closed; the next build starts new ones. A match needs the pool in bursts (its
 * start, a new unit type leaving a factory), and each idle Worker keeps its own copy of the mesh code and heap.
 */
export const SMOOTH_POOL_IDLE_MS = 20_000;

/**
 * A small pool of voxelSmoothWorker.ts Workers. One section per Worker at a time, first come first served; Workers
 * start on demand, up to `size`. The owner (VoxelUnits) calls dispose(): it terminates every Worker and rejects what
 * was still queued, so nothing outlives the view.
 */
export class SmoothVoxelPool implements SmoothSectionBuilder {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private disposed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly createWorker: () => SmoothWorkerLike,
    readonly size = defaultPoolSize(),
    private readonly idleMs = SMOOTH_POOL_IDLE_MS,
  ) {}

  /** Sections being built or waiting for a Worker. */
  get pending(): number {
    return this.queue.length + this.slots.reduce((n, slot) => n + (slot.job ? 1 : 0), 0);
  }

  /** Workers currently alive (diagnostics and tests). */
  get workers(): number {
    return this.slots.length;
  }

  build(section: VoxelSection, options: SmoothVoxelOptions): Promise<SmoothMeshData> {
    if (this.disposed) return Promise.reject(new Error('smooth voxel pool disposed'));
    return new Promise<SmoothMeshData>((resolve, reject) => {
      // Plain data only: frozen option objects and JSON sections clone as they are.
      this.queue.push({ request: { id: this.nextId++, section, options: { ...options } }, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const error = new Error('smooth voxel pool disposed');
    for (const slot of this.slots.splice(0)) {
      slot.worker.onmessage = slot.worker.onerror = null;
      slot.worker.terminate();
      slot.job?.reject(error);
    }
    for (const job of this.queue.splice(0)) job.reject(error);
  }

  private pump(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    while (this.queue.length) {
      let slot = this.slots.find((candidate) => !candidate.job);
      if (!slot && this.slots.length < this.size) slot = this.start();
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      try {
        slot.worker.postMessage(job.request);
      } catch (error) {
        slot.job = null;
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!this.pending && this.slots.length) this.idleTimer = setTimeout(() => this.closeIdle(), this.idleMs);
  }

  private start(): Slot | undefined {
    let worker: SmoothWorkerLike;
    try {
      worker = this.createWorker();
    } catch (error) {
      // No Worker can be started (blocked by policy, out of resources): fail what waits instead of hanging it.
      const reason = error instanceof Error ? error : new Error(String(error));
      if (!this.slots.length) for (const job of this.queue.splice(0)) job.reject(reason);
      return undefined;
    }
    const slot: Slot = { worker, job: null };
    worker.onmessage = (event) => {
      const job = slot.job;
      const reply = event.data;
      if (!job || reply.id !== job.request.id) return;
      slot.job = null;
      if ('mesh' in reply) job.resolve(reply.mesh);
      else job.reject(new Error(reply.error));
      this.pump();
    };
    worker.onerror = (event) => {
      // A Worker that failed (script error, crash) is replaced; only the section it was building fails.
      const job = slot.job;
      slot.job = null;
      const at = this.slots.indexOf(slot);
      if (at >= 0) this.slots.splice(at, 1);
      worker.onmessage = worker.onerror = null;
      worker.terminate();
      job?.reject(new Error(event.message || 'smooth voxel Worker failed'));
      if (!this.disposed) this.pump();
    };
    this.slots.push(slot);
    return slot;
  }

  private closeIdle(): void {
    this.idleTimer = null;
    if (this.disposed || this.pending) return;
    for (const slot of this.slots.splice(0)) {
      slot.worker.onmessage = slot.worker.onerror = null;
      slot.worker.terminate();
    }
  }
}

/**
 * Leave cores for the page's own thread and the emulator's: two to four Workers build a match's opening models in
 * well under a second on current machines, and more would compete with the game for the remaining cores.
 */
export function defaultPoolSize(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 2));
}

/** A pool of real Workers, or null where there are none (tests, non-browser hosts): callers then build in place. */
export function createSmoothVoxelPool(): SmoothVoxelPool | null {
  if (typeof Worker === 'undefined') return null;
  return new SmoothVoxelPool(
    () => new Worker(new URL('./voxelSmoothWorker.ts', import.meta.url), { type: 'module' }) as SmoothWorkerLike,
  );
}
