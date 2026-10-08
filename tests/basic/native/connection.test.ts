import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeConnection } from '../../../src/adapter/native/connection';
import type { NativeWebSocket } from '../../../src/adapter/native/connection';
import {
  NativeMessageType,
  decodePacket,
  encodePacket,
  encodeU32,
  NATIVE_MAX_MESSAGE,
} from '../../../src/adapter/native/protocol';

class FakeSocket implements NativeWebSocket {
  binaryType = '';
  readyState = 1;
  bufferedAmount = 0;
  onopen: NativeWebSocket['onopen'] = null;
  onmessage: NativeWebSocket['onmessage'] = null;
  onerror: NativeWebSocket['onerror'] = null;
  onclose: NativeWebSocket['onclose'] = null;
  sent: Uint8Array[] = [];
  closes = 0;
  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  close(): void {
    this.closes++;
    this.readyState = 3;
  }
  emit(type: NativeMessageType, id: number, payload: Uint8Array = new Uint8Array()): void {
    this.onmessage?.({ data: encodePacket(type, id, payload) });
  }
}
const hello = new TextEncoder().encode(
  JSON.stringify({
    protocol: 1,
    pid: 12,
    gameThreadId: 0,
    exe: { size: 1000, peTimestamp: 12345, sha256: 'a'.repeat(64), verified: true },
    surface: { width: 0, height: 0, bpp: 0, format: 'RGB565' },
    limits: { messageBytes: NATIVE_MAX_MESSAGE, pages: 4096, rules: 256 },
  }),
);
const sessions: NativeConnection[] = [];
function setup() {
  const socket = new FakeSocket();
  const create = vi.fn(() => socket);
  const connection = new NativeConnection({
    url: 'ws://127.0.0.1:15450',
    token: 'a'.repeat(32),
    createWebSocket: create,
    timeoutMs: 100,
  });
  sessions.push(connection);
  return { socket, connection, create };
}
async function connected() {
  const result = setup();
  const connecting = result.connection.connect();
  result.socket.emit(NativeMessageType.Hello, 0, hello);
  await connecting;
  return result;
}
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.useRealTimers();
});

describe('native connection lifecycle', () => {
  it('connects once, includes the secret in the exact path and correlates out-of-order replies', async () => {
    const { socket, connection, create } = await connected();
    expect((await connection.connect()).pid).toBe(12);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([`ws://127.0.0.1:15450/?token=${'a'.repeat(32)}`]);
    expect(socket.binaryType).toBe('arraybuffer');
    const first = connection.request(NativeMessageType.Diagnostics),
      second = connection.request(NativeMessageType.InputState);
    const a = decodePacket(socket.sent[0]!),
      b = decodePacket(socket.sent[1]!);
    socket.emit(b.type, b.id, new Uint8Array([2]));
    socket.emit(a.type, a.id, new Uint8Array([1]));
    expect(await first).toEqual(new Uint8Array([1]));
    expect(await second).toEqual(new Uint8Array([2]));
  });
  it('rejects correlated errors without treating unknown requests as successful', async () => {
    const { socket, connection } = await connected();
    const request = connection.request(NativeMessageType.Write);
    socket.emit(NativeMessageType.Error, decodePacket(socket.sent[0]!).id, new TextEncoder().encode('bad address'));
    await expect(request).rejects.toThrow('bad address');
    const next = connection.request(NativeMessageType.Read);
    socket.emit(NativeMessageType.Write, decodePacket(socket.sent[1]!).id);
    await expect(next).rejects.toThrow('type mismatch');
  });
  it('rejects pending requests on close and releases event handlers', async () => {
    const { socket, connection } = await connected();
    const pending = connection.request(NativeMessageType.Diagnostics);
    const rejected = expect(pending).rejects.toThrow('closed');
    socket.onclose?.({});
    await rejected;
    expect(socket.closes).toBe(1);
    expect(socket.onmessage).toBeNull();
    await expect(connection.connect()).rejects.toThrow('closed');
  });
  it('times out sent mutations without replay and queues requests beyond the in-flight window', async () => {
    vi.useFakeTimers();
    const { socket, connection } = await connected();
    const pending = connection.request(NativeMessageType.Write);
    const rejected = expect(pending).rejects.toThrow('completion is unknown');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(socket.sent).toHaveLength(1);
    socket.emit(NativeMessageType.Write, decodePacket(socket.sent[0]!).id);
    const requests = Array.from({ length: 40 }, () => connection.request(NativeMessageType.Read));
    expect(socket.sent).toHaveLength(17);
    const first = decodePacket(socket.sent[1]!);
    socket.emit(first.type, first.id);
    expect(socket.sent).toHaveLength(18);
    expect(await requests[0]).toEqual(new Uint8Array());
    const rejections = requests.slice(1).map((request) => expect(request).rejects.toThrow('closed'));
    connection.close();
    await Promise.all(rejections);
  });
  it('waits through socket backpressure and native GUI delays without a busy error or replay', async () => {
    vi.useFakeTimers();
    const { socket, connection } = await connected();
    const errors = vi.fn();
    connection.onError(errors);
    socket.bufferedAmount = NATIVE_MAX_MESSAGE + 1;
    const payload = encodeU32(3, 10, 20, 0);
    const input = connection.request(NativeMessageType.Input, payload);
    payload[4] = 99;
    connection.notify(NativeMessageType.Ack, encodeU32(42));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.map((bytes) => decodePacket(bytes).type)).toEqual([
      NativeMessageType.Ack,
      NativeMessageType.Input,
    ]);
    expect(decodePacket(socket.sent[1]!).payload).toEqual(encodeU32(3, 10, 20, 0));
    const delayed = [NativeMessageType.Credit, NativeMessageType.InputState, NativeMessageType.Diagnostics].map(
      (type) => connection.request(type),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(5);
    for (const bytes of socket.sent.slice(1)) {
      const packet = decodePacket(bytes);
      socket.emit(packet.type, packet.id);
    }
    await Promise.all([input, ...delayed]);
  });
  it('allows mirror ACKs through a saturated request window and rejects all queued work on close', async () => {
    const { socket, connection } = await connected();
    const requests = Array.from({ length: 50 }, () => connection.request(NativeMessageType.InputState));
    const closed = requests.map((request) => expect(request).rejects.toThrow('closed'));
    expect(socket.sent).toHaveLength(16);
    connection.notify(NativeMessageType.Ack, encodeU32(42));
    expect(socket.sent).toHaveLength(17);
    expect(decodePacket(socket.sent[16]!).type).toBe(NativeMessageType.Ack);
    connection.close();
    await Promise.all(closed);
  });
  it('waits for delayed read-only memory results and rejects unresolved reads on socket close without replay', async () => {
    vi.useFakeTimers();
    const { socket, connection } = await connected();
    const errors = vi.fn();
    const completed = vi.fn();
    const failed = vi.fn();
    connection.onError(errors);
    const read = connection.read(0x1234, 2, 10);
    void read.then(completed, failed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(1);
    const response = new Uint8Array(14);
    response.set(encodeU32(10, 0x1234, 2));
    response.set([7, 8], 12);
    socket.emit(NativeMessageType.Read, decodePacket(socket.sent[0]!).id, response);
    await expect(read).resolves.toEqual({ frame: 10, address: 0x1234, bytes: new Uint8Array([7, 8]) });
    const pending = connection.read(0x1234, 2, 10);
    const rejected = expect(pending).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
    socket.onclose?.({});
    await rejected;
    expect(socket.sent).toHaveLength(2);
  });
  it('rejects handshake timeout and non-loopback connection parameters', async () => {
    vi.useFakeTimers();
    const { connection, socket } = setup();
    const rejected = expect(connection.connect()).rejects.toThrow('hello timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(socket.closes).toBe(1);
    for (const url of ['ws://example.org:15450', 'ws://127.0.0.1:1234', 'ws://127.0.0.1:15450/path']) {
      const bad = new NativeConnection({ url, token: 'a'.repeat(32) });
      await expect(bad.connect()).rejects.toThrow('loopback');
      bad.dispose();
    }
  });
  it('delivers mirror data before the caller acknowledges it and closes on malformed binary input', async () => {
    const { connection, socket } = await connected();
    const mirror = vi.fn((update) => connection.notify(NativeMessageType.Ack, encodeU32(update.frame)));
    const remove = connection.onMirror(mirror);
    socket.emit(NativeMessageType.Mirror, 0, encodeU32(42, 2, 0, 0));
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(decodePacket(socket.sent[0]!)).toMatchObject({ type: NativeMessageType.Ack, payload: encodeU32(42) });
    remove();
    const errors = vi.fn();
    connection.onError(errors);
    socket.onmessage?.({ data: 'unexpected text' });
    expect(errors).toHaveBeenCalledWith(expect.any(Error));
    expect(socket.closes).toBe(1);
  });
  it('checks read replies against requested address, length and frame', async () => {
    const { socket, connection } = await connected();
    const result = connection.read(0x1234, 2, 10);
    const payload = new Uint8Array(14);
    payload.set(encodeU32(10, 0x1234, 2));
    payload.set([7, 8], 12);
    socket.emit(NativeMessageType.Read, decodePacket(socket.sent[0]!).id, payload);
    expect(await result).toEqual({ frame: 10, address: 0x1234, bytes: new Uint8Array([7, 8]) });
    const bad = connection.read(0x1234, 2, 10);
    payload.set(encodeU32(9), 0);
    socket.emit(NativeMessageType.Read, decodePacket(socket.sent[1]!).id, payload);
    await expect(bad).rejects.toThrow('frame');
  });
  it('reports host refusals for fire-and-forget input instead of silently ignoring them', async () => {
    const { socket, connection } = await connected();
    const errors = vi.fn();
    connection.onError(errors);
    connection.notify(NativeMessageType.Input, encodeU32(1, 1, 0, 0));
    socket.emit(
      NativeMessageType.Error,
      decodePacket(socket.sent[0]!).id,
      new TextEncoder().encode('input unsupported'),
    );
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'input unsupported' }));
    connection.notify(NativeMessageType.Input, encodeU32(2, 65, 1, 0));
    socket.emit(NativeMessageType.Input, decodePacket(socket.sent[1]!).id);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
