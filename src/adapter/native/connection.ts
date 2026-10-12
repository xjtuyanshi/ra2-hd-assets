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

/** Only transport loss is eligible for the launcher's independently confirmed exit status. */
export class NativeConnectionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeConnectionLostError';
  }
}

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
  timer: ReturnType<typeof setTimeout> | null;
}
interface Notification {
  type: NativeMessageType;
  timer: ReturnType<typeof setTimeout> | null;
}
interface Outgoing {
  type: NativeMessageType;
  payload: Uint8Array;
  resolve?: (bytes: Uint8Array) => void;
  reject?: (error: Error) => void;
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
  private outgoing: Outgoing[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private mirrors = new Set<(update: NativeMirrorUpdate) => void>();
  private pictures = new Set<(picture: NativePicture) => void>();
  private errors = new Set<(error: Error) => void>();
  private pictureDecoder = new NativePictureDecoder();
  private readonly timeoutMs: number;
  private decodeCounters = { pictureMs: 0, pictures: 0, pictureMaxMs: 0, mirrorMs: 0, mirrors: 0, mirrorMaxMs: 0 };
  private slowDecodes: { kind: string; startEpochMs: number; durationMs: number }[] = [];

  decodeDiagnostics() {
    return { ...this.decodeCounters, recent: this.slowDecodes.slice() };
  }

  private timeDecode(kind: 'picture' | 'mirror', started: number): void {
    const duration = performance.now() - started;
    if (kind === 'picture') {
      this.decodeCounters.pictureMs += duration;
      this.decodeCounters.pictures++;
      this.decodeCounters.pictureMaxMs = Math.max(this.decodeCounters.pictureMaxMs, duration);
    } else {
      this.decodeCounters.mirrorMs += duration;
      this.decodeCounters.mirrors++;
      this.decodeCounters.mirrorMaxMs = Math.max(this.decodeCounters.mirrorMaxMs, duration);
    }
    if (duration >= 5) {
      this.slowDecodes.push({ kind, startEpochMs: performance.timeOrigin + started, durationMs: duration });
      if (this.slowDecodes.length > 32) this.slowDecodes.shift();
    }
  }

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
        this.socket.onerror = () => this.fail(new NativeConnectionLostError('Native WebSocket error'));
        this.socket.onclose = () => this.fail(new NativeConnectionLostError('Native WebSocket closed'));
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
        if (notification.timer) clearTimeout(notification.timer);
        if (packet.type === NativeMessageType.Error)
          this.reportError(new Error(new TextDecoder().decode(packet.payload)));
        else if (packet.type !== notification.type)
          this.reportError(new NativeProtocolError('Native notification response type mismatch'));
        this.drain();
        return;
      }
      this.pending.delete(packet.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (packet.type === NativeMessageType.Error) pending.reject(new Error(new TextDecoder().decode(packet.payload)));
      else if (packet.type !== pending.type) pending.reject(new NativeProtocolError('Native response type mismatch'));
      else pending.resolve(packet.payload);
      this.drain();
      return;
    }
    if (packet.type === NativeMessageType.Mirror) {
      const started = performance.now();
      const update = decodeMirror(packet.payload);
      this.timeDecode('mirror', started);
      for (const handler of this.mirrors) handler(update);
    } else if (packet.type === NativeMessageType.Picture) {
      const started = performance.now();
      const picture = this.pictureDecoder.apply(packet.payload);
      this.timeDecode('picture', started);
      for (const handler of this.pictures) handler(picture);
    } else if (packet.type === NativeMessageType.Error) {
      const error = new Error(new TextDecoder().decode(packet.payload));
      for (const handler of this.errors) handler(error);
    } else throw new NativeProtocolError('Unexpected native stream message');
  }

  private send(type: NativeMessageType, id: number, payload: Uint8Array): void {
    if (this.closed || !this.hello || !this.socket || this.socket.readyState !== 1)
      throw new NativeConnectionLostError('Native agent is not connected');
    this.socket.send(encodePacket(type, id, payload));
  }

  private waitsForGame(type: NativeMessageType): boolean {
    // Native menus/load screens and socket backpressure can delay valid input
    // or read-only results. Keep waiting for completion or connection loss;
    // retrying queued input could double-click.
    return (
      type === NativeMessageType.Input ||
      type === NativeMessageType.Credit ||
      type === NativeMessageType.InputState ||
      type === NativeMessageType.Diagnostics ||
      type === NativeMessageType.Read
    );
  }

  private drain(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.outgoing.length) {
        if (!this.hello || !this.socket || this.socket.readyState !== 1) {
          const error = new NativeConnectionLostError('Native agent is not connected');
          for (const queued of this.outgoing.splice(0)) queued.reject?.(error);
          return;
        }
        if ((this.socket.bufferedAmount ?? 0) > NATIVE_MAX_MESSAGE) {
          // WebSocket has no drain event. Keep bytes owned by this connection
          // until the browser can accept them, without starting a reply timer.
          if (!this.drainTimer)
            this.drainTimer = setTimeout(() => {
              this.drainTimer = null;
              this.drain();
            }, 0);
          return;
        }
        const queued = this.outgoing[0]!;
        if (queued.type !== NativeMessageType.Ack && this.pending.size + this.notifications.size >= 16) return;
        this.outgoing.shift();
        const id = this.nextId++;
        if (this.nextId > 0xffffffff) this.nextId = 1;
        const timer =
          queued.type === NativeMessageType.Ack || this.waitsForGame(queued.type)
            ? null
            : setTimeout(() => {
                this.pending.delete(id);
                this.notifications.delete(id);
                const error = new Error(`Native request ${queued.type} timed out; host completion is unknown`);
                if (queued.reject) queued.reject(error);
                else this.reportError(error);
                this.drain();
              }, this.timeoutMs);
        if (queued.resolve && queued.reject)
          this.pending.set(id, { type: queued.type, resolve: queued.resolve, reject: queued.reject, timer });
        else if (queued.type !== NativeMessageType.Ack) this.notifications.set(id, { type: queued.type, timer });
        try {
          this.send(queued.type, id, queued.payload);
        } catch (cause) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          this.notifications.delete(id);
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (queued.reject) queued.reject(error);
          else this.reportError(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  request(type: NativeMessageType, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    if (type === NativeMessageType.Ack) return Promise.reject(new Error('Native ACK is a notification'));
    if (this.closed || !this.hello || !this.socket || this.socket.readyState !== 1)
      return Promise.reject(new NativeConnectionLostError('Native agent is not connected'));
    return new Promise((resolve, reject) => {
      this.outgoing.push({ type, payload: payload.slice(), resolve, reject });
      this.drain();
    });
  }

  notify(type: NativeMessageType, payload: Uint8Array = new Uint8Array()): void {
    if (this.closed || !this.hello || !this.socket || this.socket.readyState !== 1)
      throw new NativeConnectionLostError('Native agent is not connected');
    // Mirror ACKs release the host's stream slot and must not wait behind the
    // correlated-request window. They still respect browser socket backpressure.
    const queued = { type, payload: payload.slice() };
    if (type === NativeMessageType.Ack) this.outgoing.unshift(queued);
    else this.outgoing.push(queued);
    this.drain();
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
    this.close(error);
    this.reportError(error);
  }
  private reportError(error: Error): void {
    for (const handler of this.errors) handler(error);
  }
  close(reason: string | Error = 'Native connection closed'): void {
    if (this.closed) return;
    this.closed = true;
    const error = reason instanceof Error ? reason : new Error(reason);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.rejectHello?.(error);
    this.resolveHello = this.rejectHello = null;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const queued of this.outgoing.splice(0)) queued.reject?.(error);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    for (const notification of this.notifications.values()) if (notification.timer) clearTimeout(notification.timer);
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
