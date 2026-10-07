import {
  NativeMessageType,
  NativePictureDecoder,
  NativeProtocolError,
  NATIVE_MAX_MESSAGE,
  NATIVE_NO_FRAME,
  decodePacket,
  decodeHello,
  decodeMirror,
  encodePacket,
  encodeU32,
  encodeWrite,
  encodeBatch,
} from './protocol';
import type { NativeHello, NativeMirrorUpdate, NativePicture, NativeBatchWrite } from './protocol';

/** Browser WebSocket and Node ws both expose these event properties. */
export interface NativeWebSocket {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(bytes: Uint8Array): void;
  close(): void;
}
export interface NativeConnectionOptions {
  url: string;
  token: string;
  createWebSocket?: (url: string) => NativeWebSocket;
  timeoutMs?: number;
}
interface Pending {
  type: NativeMessageType;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Notification {
  type: NativeMessageType;
  timer: ReturnType<typeof setTimeout>;
}

/** A session owns one socket; disconnect rejects all pending work and never replays mutations. */
export class NativeConnection {
  private socket: NativeWebSocket | null = null;
  private hello: NativeHello | null = null;
  private connecting: Promise<NativeHello> | null = null;
  private resolveHello: ((hello: NativeHello) => void) | null = null;
  private rejectHello: ((error: Error) => void) | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifications = new Map<number, Notification>();
  private mirrors = new Set<(update: NativeMirrorUpdate) => void>();
  private pictures = new Set<(picture: NativePicture) => void>();
  private errors = new Set<(error: Error) => void>();
  private pictureDecoder = new NativePictureDecoder();
  private readonly timeoutMs: number;

  constructor(private readonly options: NativeConnectionOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid native timeout');
  }

  connect(): Promise<NativeHello> {
    if (this.closed) return Promise.reject(new Error('Native connection is closed'));
    if (this.connecting) return this.connecting;
    let url: URL;
    try {
      url = new URL(this.options.url);
      if (
        url.protocol !== 'ws:' ||
        url.hostname !== '127.0.0.1' ||
        !/^1545[0-9]$/.test(url.port) ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.hash ||
        !/^[0-9a-fA-F]{32,128}$/.test(this.options.token)
      )
        throw new Error('Invalid loopback native agent URL or token');
      url.search = '';
      url.searchParams.set('token', this.options.token);
    } catch (error) {
      return Promise.reject(error);
    }
    this.connecting = new Promise<NativeHello>((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
      this.helloTimer = setTimeout(() => this.fail(new Error('Native hello timed out')), this.timeoutMs);
      try {
        const create =
          this.options.createWebSocket ?? ((address: string) => new WebSocket(address) as unknown as NativeWebSocket);
        this.socket = create(url.href);
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => {};
        this.socket.onmessage = (event) => {
          try {
            this.receive(event.data);
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        this.socket.onerror = () => this.fail(new Error('Native WebSocket error'));
        this.socket.onclose = () => this.fail(new Error('Native WebSocket closed'));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.connecting;
  }

  onMirror(handler: (update: NativeMirrorUpdate) => void): () => void {
    this.mirrors.add(handler);
    return () => this.mirrors.delete(handler);
  }
  onPicture(handler: (picture: NativePicture) => void): () => void {
    this.pictures.add(handler);
    return () => this.pictures.delete(handler);
  }
  onError(handler: (error: Error) => void): () => void {
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array))
      throw new NativeProtocolError('Native message must be binary');
    const packet = decodePacket(data);
    if (packet.type === NativeMessageType.Hello) {
      if (packet.id || this.hello) throw new NativeProtocolError('Duplicate or correlated native hello');
      this.hello = decodeHello(packet.payload);
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.resolveHello?.(this.hello);
      this.resolveHello = this.rejectHello = null;
      return;
    }
    if (!this.hello) throw new NativeProtocolError('Native message arrived before hello');
    if (packet.id) {
      const pending = this.pending.get(packet.id);
      // A timed-out operation can still finish at the host. Never retry it automatically.
      if (!pending) {
        const notification = this.notifications.get(packet.id);
        if (!notification) return;
        this.notifications.delete(packet.id);
        clearTimeout(notification.timer);
        if (packet.type === NativeMessageType.Error)
          this.reportError(new Error(new TextDecoder().decode(packet.payload)));
        else if (packet.type !== notification.type)
          this.reportError(new NativeProtocolError('Native notification response type mismatch'));
        return;
      }
      this.pending.delete(packet.id);
      clearTimeout(pending.timer);
      if (packet.type === NativeMessageType.Error) pending.reject(new Error(new TextDecoder().decode(packet.payload)));
      else if (packet.type !== pending.type) pending.reject(new NativeProtocolError('Native response type mismatch'));
      else pending.resolve(packet.payload);
      return;
    }
    if (packet.type === NativeMessageType.Mirror) {
      const update = decodeMirror(packet.payload);
      for (const handler of this.mirrors) handler(update);
    } else if (packet.type === NativeMessageType.Picture) {
      const picture = this.pictureDecoder.apply(packet.payload);
      for (const handler of this.pictures) handler(picture);
    } else if (packet.type === NativeMessageType.Error) {
      const error = new Error(new TextDecoder().decode(packet.payload));
      for (const handler of this.errors) handler(error);
    } else throw new NativeProtocolError('Unexpected native stream message');
  }

  private send(type: NativeMessageType, id: number, payload: Uint8Array): void {
    if (this.closed || !this.hello || !this.socket || this.socket.readyState !== 1)
      throw new Error('Native agent is not connected');
    if ((this.socket.bufferedAmount ?? 0) > NATIVE_MAX_MESSAGE)
      throw new Error('Native outgoing socket backlog exceeds limit');
    this.socket.send(encodePacket(type, id, payload));
  }

  request(type: NativeMessageType, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    if (type === NativeMessageType.Ack) return Promise.reject(new Error('Native ACK is a notification'));
    if (this.pending.size + this.notifications.size >= 16)
      return Promise.reject(new Error('Native request limit reached'));
    const id = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native request ${type} timed out; host completion is unknown`));
      }, this.timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        this.send(type, id, payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(type: NativeMessageType, payload: Uint8Array = new Uint8Array()): void {
    if (type !== NativeMessageType.Ack && this.pending.size + this.notifications.size >= 16)
      throw new Error('Native notification limit reached');
    const id = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    if (type === NativeMessageType.Ack) {
      this.send(type, id, payload);
      return;
    }
    const timer = setTimeout(() => {
      this.notifications.delete(id);
      this.reportError(new Error(`Native notification ${type} timed out; host completion is unknown`));
    }, this.timeoutMs);
    this.notifications.set(id, { type, timer });
    try {
      this.send(type, id, payload);
    } catch (error) {
      clearTimeout(timer);
      this.notifications.delete(id);
      throw error;
    }
  }

  async read(
    address: number,
    length: number,
    expectedFrame = NATIVE_NO_FRAME,
  ): Promise<{ frame: number; address: number; bytes: Uint8Array }> {
    const reply = await this.request(NativeMessageType.Read, encodeU32(address, length, expectedFrame));
    if (reply.byteLength < 12) throw new NativeProtocolError('Short native read reply');
    const source = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    if (
      source.getUint32(4, true) !== address ||
      source.getUint32(8, true) !== length ||
      reply.byteLength !== length + 12
    ) {
      throw new NativeProtocolError('Native read reply does not match request');
    }
    const frame = source.getUint32(0, true);
    if (expectedFrame !== NATIVE_NO_FRAME && frame !== expectedFrame)
      throw new NativeProtocolError('Native read frame does not match request');
    return { frame, address, bytes: reply.slice(12) };
  }
  async write(address: number, bytes: Uint8Array): Promise<void> {
    await this.request(NativeMessageType.Write, encodeWrite(address, bytes));
  }
  async allocate(size: number, preferred = 0, executable = false): Promise<number> {
    const reply = await this.request(NativeMessageType.Alloc, encodeU32(size, preferred, executable ? 1 : 0));
    if (reply.byteLength !== 8) throw new NativeProtocolError('Invalid native allocation reply');
    const source = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    const address = source.getUint32(0, true);
    if (!address || source.getUint32(4, true) !== size)
      throw new NativeProtocolError('Native allocation does not match request');
    return address;
  }
  async free(address: number): Promise<void> {
    await this.request(NativeMessageType.Free, encodeU32(address));
  }
  async batch(writes: readonly NativeBatchWrite[]): Promise<void> {
    await this.request(NativeMessageType.Batch, encodeBatch(writes));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error.message);
    this.reportError(error);
  }
  private reportError(error: Error): void {
    for (const handler of this.errors) handler(error);
  }
  close(reason = 'Native connection closed'): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.rejectHello?.(error);
    this.resolveHello = this.rejectHello = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const notification of this.notifications.values()) clearTimeout(notification.timer);
    this.notifications.clear();
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = null;
    this.pictureDecoder.reset();
    this.mirrors.clear();
    this.pictures.clear();
  }
  dispose(): void {
    this.close();
    this.errors.clear();
  }
}
