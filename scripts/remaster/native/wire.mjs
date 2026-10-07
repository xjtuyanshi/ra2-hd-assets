import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export const Type = Object.freeze({
  HELLO: 1,
  READ: 2,
  WRITE: 3,
  ALLOC: 4,
  FREE: 5,
  SUBSCRIBE: 6,
  MIRROR: 7,
  CREDIT: 8,
  PICTURE: 9,
  INPUT: 10,
  DIAGNOSTICS: 11,
  HOOK: 12,
  ERROR: 13,
  INPUT_STATE: 14,
  ACK: 15,
  BATCH: 16,
  SAMPLE: 17,
});
export const PAGE = 4096;
export function words(...values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}
export function packet(type, id = 0, payload = Buffer.alloc(0)) {
  if (payload.length > 32 * 1024 * 1024) throw new Error('Message too large');
  return Buffer.concat([Buffer.from([0x4e, 0x48, 0x42, 0x31, 1, 0, type, 0]), words(id, payload.length), payload]);
}
export function decodePacket(raw) {
  const b = Buffer.from(raw);
  if (
    b.length < 16 ||
    b.readUInt32LE(0) !== 0x3142484e ||
    b.readUInt16LE(4) !== 1 ||
    b.readUInt32LE(12) !== b.length - 16 ||
    b.length > 32 * 1024 * 1024 + 16
  )
    throw new Error('Invalid agent packet');
  return { type: b.readUInt16LE(6), id: b.readUInt32LE(8), payload: b.subarray(16) };
}
export function decodeMirror(payload) {
  const b = Buffer.from(payload);
  if (b.length < 16) throw new Error('Short mirror');
  const frame = b.readUInt32LE(0),
    flags = b.readUInt32LE(4),
    n = b.readUInt32LE(8),
    sn = b.readUInt32LE(12);
  if (n > 4096 || sn > 64) throw new Error('Mirror bounds');
  let at = 16;
  const pages = [],
    samples = [];
  for (let i = 0; i < n; i++) {
    if (at + 4 + PAGE > b.length) throw new Error('Short page');
    const address = b.readUInt32LE(at);
    if (address % PAGE) throw new Error('Unaligned page');
    pages.push({ address, bytes: b.subarray(at + 4, at + 4 + PAGE) });
    at += 4 + PAGE;
  }
  for (let i = 0; i < sn; i++) {
    if (at + 8 > b.length) throw new Error('Short sample');
    const address = b.readUInt32LE(at),
      length = b.readUInt32LE(at + 4);
    at += 8;
    if (length > PAGE || at + length > b.length) throw new Error('Sample bounds');
    samples.push({ address, bytes: b.subarray(at, at + length) });
    at += length;
  }
  if (at !== b.length) throw new Error('Trailing mirror data');
  return { frame, flags, pages, samples };
}
export class Mirror {
  pages = new Map();
  frame = 0;
  apply(update) {
    if (update.flags & 2) this.pages.clear();
    for (const p of update.pages) this.pages.set(p.address, Buffer.from(p.bytes));
    this.frame = update.frame;
  }
  read(address, length) {
    const out = Buffer.alloc(length);
    for (let at = 0; at < length;) {
      const page = Math.floor((address + at) / 4096) * 4096,
        offset = address + at - page,
        n = Math.min(length - at, PAGE - offset),
        b = this.pages.get(page >>> 0);
      if (!b) throw new Error(`Mirror miss 0x${(address + at).toString(16)}`);
      b.copy(out, at, offset, offset + n);
      at += n;
    }
    return out;
  }
}
export class Picture {
  pixels = null;
  width = 0;
  height = 0;
  apply(payload) {
    const b = Buffer.from(payload);
    if (b.length < 16) throw new Error('Short picture');
    const frame = b.readUInt32LE(0),
      w = b.readUInt32LE(4),
      h = b.readUInt32LE(8),
      rows = b.readUInt32LE(12);
    if (!w || !h || w > 4096 || h > 4096 || w * h > 4194304 || rows > h) throw new Error('Picture bounds');
    if (w !== this.width || h !== this.height) {
      if (rows !== h) throw new Error('Picture requires initial full rows');
      this.pixels = Buffer.alloc(w * h * 2);
      this.width = w;
      this.height = h;
    }
    let at = 16;
    const seen = new Set();
    for (let r = 0; r < rows; r++) {
      if (at + 8 > b.length) throw new Error('Short row');
      const y = b.readUInt32LE(at),
        len = b.readUInt32LE(at + 4);
      at += 8;
      const end = at + len;
      if (y >= h || seen.has(y) || end > b.length) throw new Error('Row bounds');
      seen.add(y);
      let x = 0;
      while (at < end) {
        if (at + 2 > end) throw new Error('Short segment');
        const seg = b.readUInt16LE(at);
        at += 2;
        const count = seg & 0x7fff;
        if (!count || x + count > w) throw new Error('Run bounds');
        if (seg & 0x8000) {
          for (let j = 0; j < count; j++) this.pixels.writeUInt16LE(0xf81f, 2 * (y * w + x + j));
        } else {
          if (at + count * 2 > end) throw new Error('Short literal');
          b.copy(this.pixels, 2 * (y * w + x), at, at + count * 2);
          at += count * 2;
        }
        x += count;
      }
      if (x !== w) throw new Error('Incomplete row');
    }
    if (at !== b.length) throw new Error('Trailing picture bytes');
    return { frame, width: w, height: h, pixels: this.pixels };
  }
}
export function subscription(ranges, rules = [], { maxPages = 4096, budgetUs = 1500, sampleCount = 32 } = {}) {
  if (ranges.length > 4096 || rules.length > 256 || maxPages > 4096 || sampleCount > 64)
    throw new Error('Subscription bounds');
  return Buffer.concat([
    words(ranges.length, rules.length, maxPages, budgetUs, sampleCount),
    ...ranges.map((r) => words(r.address, r.length)),
    ...rules.map((r) => words(r.kind, r.source, r.bytes, r.maxCount ?? 4096, r.stride ?? 4)),
  ]);
}
export class AgentClient extends EventEmitter {
  nextId = 1;
  pending = new Map();
  hello = null;
  constructor(url, token, origin = 'http://127.0.0.1:15451') {
    super();
    const u = new URL(url);
    if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || +u.port < 15450 || +u.port > 15459)
      throw new Error('Agent must use allowed loopback port');
    u.searchParams.set('token', token);
    this.ws = new WebSocket(u, { origin, maxPayload: 32 * 1024 * 1024 + 16 });
    this.ws.on('message', (raw) => {
      try {
        const p = decodePacket(raw);
        this.emit('raw', Buffer.from(raw));
        if (p.type === Type.HELLO) {
          this.hello = JSON.parse(p.payload.toString());
          this.emit('hello', this.hello);
        }
        if (p.id && this.pending.has(p.id)) {
          const { resolve, reject, timer } = this.pending.get(p.id);
          clearTimeout(timer);
          this.pending.delete(p.id);
          p.type === Type.ERROR ? reject(new Error(p.payload.toString())) : resolve(p.payload);
        } else if (p.type === Type.ERROR) {
          this.emit('agent-error', new Error(p.payload.toString()));
        } else this.emit('packet', p);
      } catch (e) {
        this.emit('failure', e);
        this.ws.close();
      }
    });
    this.ws.on('error', (e) => this.emit('failure', e));
    this.ws.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Agent disconnected'));
      }
      this.pending.clear();
      this.emit('closed');
    });
  }
  async connect() {
    if (this.hello) return this.hello;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Agent hello timeout'));
        this.close();
      }, 5000);
      const ready = (h) => {
          cleanup();
          resolve(h);
        },
        fail = (e) => {
          cleanup();
          reject(e);
        };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('hello', ready);
        this.off('failure', fail);
        this.off('closed', closed);
      };
      const closed = () => fail(new Error('Agent disconnected before hello'));
      this.once('hello', ready);
      this.once('failure', fail);
      this.once('closed', closed);
    });
  }
  request(type, payload = Buffer.alloc(0)) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent request ${type} timeout`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(packet(type, id, payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  send(type, payload = Buffer.alloc(0)) {
    this.ws.send(packet(type, this.nextId++, payload));
  }
  async read(address, length, frame = 0xffffffff) {
    const p = await this.request(Type.READ, words(address, length, frame));
    if (p.length !== 12 + length || p.readUInt32LE(4) !== address || p.readUInt32LE(8) !== length)
      throw new Error('Read response mismatch');
    return { frame: p.readUInt32LE(0), bytes: p.subarray(12) };
  }
  close() {
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws.close();
  }
}
