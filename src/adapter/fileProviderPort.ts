import type { GameFileProvider, GameFileRemoveResult } from '../resources/contracts';
import { normalizeGuestPath } from '../vm86/paths';

type Request = {
  id: number;
  method: 'read' | 'readPrefix' | 'readRange' | 'list' | 'write' | 'remove' | 'flush';
  path: string;
  offset?: number;
  length?: number;
  bytes?: Uint8Array;
};
type Result = Uint8Array | { bytes: Uint8Array; totalSize: number } | string[] | GameFileRemoveResult | null | void;
type Response = { id: number; value?: Result; error?: string };

/**
 * The Worker reads the main-thread provider on demand through a dedicated port; unextracted resources must not become empty files, and init must not copy the entire package. Provider reads must return independently owned buffers for safe transfer.
 */
export function serveFileProvider(provider: GameFileProvider, port: MessagePort): () => void {
  let closed = false;
  port.onmessage = async (event: MessageEvent<Request>) => {
    const { id, method, path, offset = 0, length = 0, bytes } = event.data;
    try {
      let value: Result = undefined;
      switch (method) {
        case 'read':
          value = await provider.read(path);
          break;
        case 'list':
          value = await provider.list(path);
          break;
        case 'write':
          await provider.write(path, bytes!);
          break;
        case 'remove':
          value = provider.remove ? await provider.remove(path) : 'read-only';
          break;
        case 'flush':
          await provider.flush?.();
          break;
        case 'readPrefix': {
          const all = provider.readPrefix ? null : await provider.read(path);
          value = provider.readPrefix
            ? await provider.readPrefix(path, length)
            : all
              ? { bytes: all.slice(0, length), totalSize: all.length }
              : null;
          break;
        }
        case 'readRange':
          value = provider.readRange
            ? await provider.readRange(path, offset, length)
            : ((await provider.read(path))?.slice(offset, offset + length) ?? null);
          break;
        default:
          throw new Error('未知文件请求');
      }
      if (closed) return;
      const buffer =
        value instanceof Uint8Array
          ? value.buffer
          : value && typeof value === 'object' && 'bytes' in value
            ? value.bytes.buffer
            : null;
      port.postMessage({ id, value }, buffer instanceof ArrayBuffer ? [buffer] : []);
    } catch (error) {
      if (!closed) port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  port.start();
  return () => {
    if (closed) return;
    closed = true;
    port.postMessage({ id: -1, error: '文件服务已关闭' });
    port.onmessage = null;
    port.close();
  };
}

export class PortGameFileProvider implements GameFileProvider {
  readonly deepDiscovery = false;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void }>();
  private readonly names: Set<string>;
  private readonly uncertainNames = new Set<string>();
  constructor(
    readonly label: string,
    private readonly port: MessagePort,
    names: string[],
  ) {
    this.names = new Set(names.map(normalizeGuestPath));
    port.onmessage = (event: MessageEvent<Response>) => {
      const { id, value, error } = event.data;
      if (id === -1) {
        this.dispose();
        return;
      }
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (error) waiter?.reject(new Error(error));
      else waiter?.resolve(value);
    };
    port.start();
  }
  hasKnownFile(path: string): boolean | null {
    const name = normalizeGuestPath(path);
    if (this.uncertainNames.has(name)) return null;
    return this.names.has(name) ? true : name.includes('/') ? null : false;
  }
  private request(message: Omit<Request, 'id'>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('文件端口已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.port.postMessage({ ...message, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async read(path: string): Promise<Uint8Array | null> {
    return (await this.request({ method: 'read', path })) as Uint8Array | null;
  }
  async readPrefix(path: string, length: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    return (await this.request({ method: 'readPrefix', path, length })) as {
      bytes: Uint8Array;
      totalSize: number;
    } | null;
  }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return (await this.request({ method: 'readRange', path, offset, length })) as Uint8Array | null;
  }
  async list(path: string): Promise<string[] | null> {
    return (await this.request({ method: 'list', path })) as string[] | null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.request({ method: 'write', path, bytes });
    this.names.add(normalizeGuestPath(path));
    this.uncertainNames.delete(normalizeGuestPath(path));
  }
  async remove(path: string): Promise<GameFileRemoveResult> {
    const result = (await this.request({ method: 'remove', path })) as GameFileRemoveResult;
    const name = normalizeGuestPath(path);
    if (result === 'removed') {
      this.names.delete(name);
      // Removing writeback may reveal an original resource; the port has no synchronous source index.
      this.uncertainNames.add(name);
    } else if (result === 'missing') {
      this.names.delete(name);
      this.uncertainNames.delete(name);
    }
    return result;
  }
  async flush(): Promise<void> {
    await this.request({ method: 'flush', path: '' });
  }
  dispose(): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error('文件端口已关闭'));
    this.pending.clear();
    this.port.onmessage = null;
    this.port.close();
  }
}
