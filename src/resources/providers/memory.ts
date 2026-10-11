import type { GameFileProvider, GameFileRemoveResult } from '../contracts';
import { normalizeGuestPath } from '../../vm86/paths';

/** Writable memory-file backend usable by both Node and browser unit tests. */
export class MemoryGameFileProvider implements GameFileProvider {
  readonly label: string;
  readonly files = new Map<string, Uint8Array>();
  private readonly originalFiles = new Map<string, Uint8Array>();
  private readonly writtenFiles = new Set<string>();

  /**
   * With copy=false, retain input bytes directly; the caller guarantees no later modification.
   * ZIP/installer extraction uses this to avoid another full-package copy in the JS heap.
   */
  constructor(files: ReadonlyMap<string, Uint8Array> = new Map(), copy = true, label = '内存测试目录') {
    this.label = label;
    for (const [path, bytes] of files) this.seedOriginalFile(path, copy ? bytes.slice() : bytes);
  }

  /** Extraction can deliver original resources after session writes; keep both owners separate. */
  protected seedOriginalFile(path: string, bytes: Uint8Array): void {
    const normalized = normalizeGuestPath(path);
    this.originalFiles.set(normalized, bytes);
    if (!this.writtenFiles.has(normalized)) this.files.set(normalized, bytes);
  }

  hasKnownFile(path: string): boolean | null {
    return this.files.has(normalizeGuestPath(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(normalizeGuestPath(path))?.slice() ?? null;
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const bytes = this.files.get(normalizeGuestPath(path));
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this.files.get(normalizeGuestPath(path))?.slice(offset, offset + length) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    const original = this.files.get(normalized);
    if (original && !this.writtenFiles.has(normalized) && !this.originalFiles.has(normalized))
      this.originalFiles.set(normalized, original);
    this.writtenFiles.add(normalized);
    this.files.set(normalized, bytes.slice());
  }

  async remove(path: string): Promise<GameFileRemoveResult> {
    const normalized = normalizeGuestPath(path);
    if (!this.writtenFiles.delete(normalized)) return this.files.has(normalized) ? 'read-only' : 'missing';
    const original = this.originalFiles.get(normalized);
    if (original) this.files.set(normalized, original);
    else this.files.delete(normalized);
    return 'removed';
  }

  async flush(): Promise<void> {}

  async list(directory: string): Promise<string[] | null> {
    const prefix = normalizeGuestPath(directory);
    const depth = prefix ? prefix.split('/').length : 0;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      if (parts.length <= depth) continue;
      const parent = parts.slice(0, depth).join('/');
      if (depth ? parent === prefix : true) names.add(parts[depth]!);
    }
    return [...names];
  }
}
