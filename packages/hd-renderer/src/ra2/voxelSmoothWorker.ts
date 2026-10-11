/**
 * Smooth voxel mesh Worker: one voxel section in, its GPU-independent mesh arrays back (transferred, not copied).
 * buildSmoothSection is pure CPU work (distance transforms, blurs, ambient-occlusion rays: 0.1 to 1 s per model), so
 * it never has to run on the thread that presents frames. See voxelSmoothPool.ts for the owner of these Workers.
 */
import type { VoxelSection } from '../../../ra2-assets/src/manifest';
import { buildSmoothSection, type SmoothMeshData, type SmoothVoxelOptions } from './voxelSmooth';

/** Bump when the mesh algorithm or its input interpretation changes; old meshes are never shown across versions. */
const MESH_CACHE_VERSION = 1;
/** Persistent meshes are an optional acceleration, bounded independently of the browser's storage quota. */
const MESH_CACHE_BYTES = 128 * 1024 * 1024;

export interface SmoothSectionCache {
  get(key: string): Promise<unknown>;
  put(key: string, mesh: SmoothMeshData): Promise<void>;
}

/** One database connection per Worker; closing the Worker also releases it. */
let database: Promise<IDBDatabase | null> | undefined;

function meshDatabase(): Promise<IDBDatabase | null> {
  return (database ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open('ra2-hd-smooth-meshes', MESH_CACHE_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // A version describes the arrays themselves, not only the database schema.
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      db.createObjectStore('meshes');
      db.createObjectStore('entries').createIndex('used', 'used');
    };
    let abandoned = false;
    request.onerror = request.onblocked = () => {
      abandoned = true;
      resolve(null);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) return db.close();
      db.onversionchange = () => db.close();
      resolve(db);
    };
  }));
}

function meshBytes(mesh: SmoothMeshData): number {
  return Object.values(mesh).reduce((bytes, array) => bytes + array.byteLength, 0);
}

/** Shape validation makes an incomplete/corrupt record a miss, never an incomplete model. */
function isMesh(value: unknown): value is SmoothMeshData {
  if (!value || typeof value !== 'object') return false;
  const mesh = value as SmoothMeshData;
  if (!(mesh.pindex instanceof Float32Array)) return false;
  const vertices = mesh.pindex.length;
  for (const name of ['position', 'normal', 'vpos'] as const)
    if (
      !(mesh[name] instanceof Float32Array) ||
      mesh[name].length !== vertices * 3 ||
      !mesh[name].every(Number.isFinite)
    )
      return false;
  for (const name of ['pindex', 'pshade', 'occlusion', 'curvature'] as const)
    if (!(mesh[name] instanceof Float32Array) || mesh[name].length !== vertices || !mesh[name].every(Number.isFinite))
      return false;
  return (
    (mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array) &&
    mesh.indices.length % 3 === 0 &&
    mesh.indices.every((index) => index < vertices)
  );
}

const persistentMeshes: SmoothSectionCache = {
  async get(key) {
    const db = await meshDatabase();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meshes', 'entries'], 'readwrite');
      const request = tx.objectStore('meshes').get(key);
      let mesh: unknown = null;
      request.onsuccess = () => {
        mesh = request.result;
        if (isMesh(mesh)) tx.objectStore('entries').put({ bytes: meshBytes(mesh), used: Date.now() }, key);
      };
      tx.oncomplete = () => resolve(mesh);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  },
  async put(key, mesh) {
    const bytes = meshBytes(mesh);
    if (bytes > MESH_CACHE_BYTES) return;
    const db = await meshDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      // One read/write transaction serializes the budget across all mesh Workers.
      const tx = db.transaction(['meshes', 'entries'], 'readwrite');
      const meshes = tx.objectStore('meshes');
      const entries = tx.objectStore('entries');
      const previous = entries.get(key);
      previous.onsuccess = () => {
        const budget = entries.get('total');
        budget.onsuccess = () => {
          let total = Math.max(0, Number(budget.result) || 0) - (previous.result?.bytes ?? 0);
          const save = () => {
            meshes.put(mesh, key);
            entries.put({ bytes, used: Date.now() }, key);
            entries.put(total + bytes, 'total');
          };
          if (total + bytes <= MESH_CACHE_BYTES) return save();
          const oldest = entries.index('used').openCursor();
          oldest.onsuccess = () => {
            const cursor = oldest.result;
            if (!cursor || total + bytes <= MESH_CACHE_BYTES) return save();
            if (cursor.primaryKey !== key) {
              total = Math.max(0, total - cursor.value.bytes);
              meshes.delete(cursor.primaryKey);
              cursor.delete();
            }
            cursor.continue();
          };
        };
      };
      // Commit before transferring the result's buffers back to the page.
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  },
};

export interface SmoothSectionRequest {
  id: number;
  section: VoxelSection;
  options: SmoothVoxelOptions;
}

export type SmoothSectionReply =
  { id: number; mesh: SmoothMeshData; source?: 'cache' | 'build' } | { id: number; error: string };

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

/**
 * Repeat visits reuse byte-identical meshes, including across launcher/browser restarts. Hashing, database I/O and
 * any miss's build all stay in this Worker. Quota denial, unavailable storage and bad records simply rebuild.
 */
export async function answerSmoothSectionCached(
  request: SmoothSectionRequest,
  cache: SmoothSectionCache = persistentMeshes,
): Promise<ReturnType<typeof answerSmoothSection>> {
  let key: string | undefined;
  try {
    const input = new TextEncoder().encode(JSON.stringify([MESH_CACHE_VERSION, request.section, request.options]));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    key = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const mesh = await cache.get(key);
    if (isMesh(mesh)) return { reply: { id: request.id, mesh, source: 'cache' }, transfer: smoothMeshBuffers(mesh) };
  } catch {
    // A storage failure must not become a renderer failure.
  }
  const answer = answerSmoothSection(request);
  if ('mesh' in answer.reply) answer.reply.source = 'build';
  if (key && 'mesh' in answer.reply) {
    try {
      await cache.put(key, answer.reply.mesh);
    } catch {
      // Evicted or quota-limited caches cost only another build next time.
    }
  }
  return answer;
}

// Importing this module on a page thread (tests, type checks) must not install a message handler there.
const scope = globalThis as unknown as {
  document?: unknown;
  onmessage: ((event: MessageEvent<SmoothSectionRequest>) => void) | null;
  postMessage?(message: SmoothSectionReply, transfer: Transferable[]): void;
};
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  scope.onmessage = async (event) => {
    const { reply, transfer } = await answerSmoothSectionCached(event.data);
    scope.postMessage!(reply, transfer);
  };
}
