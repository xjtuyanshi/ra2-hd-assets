/**
 * Smooth voxel mesh Worker: one voxel section in, its GPU-independent mesh arrays back (transferred, not copied).
 * buildSmoothSection is pure CPU work (distance transforms, blurs, ambient-occlusion rays: 0.1 to 1 s per model), so
 * it never has to run on the thread that presents frames. See voxelSmoothPool.ts for the owner of these Workers.
 */
import type { VoxelSection } from '../../../ra2-assets/src/manifest';
import { buildSmoothSection, type SmoothMeshData, type SmoothVoxelOptions } from './voxelSmooth';

export interface SmoothSectionRequest {
  id: number;
  section: VoxelSection;
  options: SmoothVoxelOptions;
}

export type SmoothSectionReply = { id: number; mesh: SmoothMeshData } | { id: number; error: string };

/** Every distinct buffer behind a mesh's arrays, for a transfer list. */
export function smoothMeshBuffers(mesh: SmoothMeshData): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const array of Object.values(mesh) as (Float32Array | Uint16Array | Uint32Array)[])
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  return [...buffers];
}

/** Answer one request (exported for tests; the Worker global below is the only production caller). */
export function answerSmoothSection(request: SmoothSectionRequest): {
  reply: SmoothSectionReply;
  transfer: ArrayBuffer[];
} {
  try {
    const mesh = buildSmoothSection(request.section, request.options);
    return { reply: { id: request.id, mesh }, transfer: smoothMeshBuffers(mesh) };
  } catch (error) {
    return { reply: { id: request.id, error: error instanceof Error ? error.message : String(error) }, transfer: [] };
  }
}

// Importing this module on a page thread (tests, type checks) must not install a message handler there.
const scope = globalThis as unknown as {
  document?: unknown;
  onmessage: ((event: MessageEvent<SmoothSectionRequest>) => void) | null;
  postMessage?(message: SmoothSectionReply, transfer: Transferable[]): void;
};
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  scope.onmessage = (event) => {
    const { reply, transfer } = answerSmoothSection(event.data);
    scope.postMessage!(reply, transfer);
  };
}
