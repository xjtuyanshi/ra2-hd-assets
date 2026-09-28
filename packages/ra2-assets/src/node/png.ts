/**
 * Minimal PNG encoder/decoder (Node only; zlib from node:zlib). Supports 8-bit greyscale, RGB and RGBA, no
 * interlacing — exactly what the HD cache writes and the preview reads back. No npm dependency.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export type PngChannels = 1 | 3 | 4;

export interface PngImage {
  width: number;
  height: number;
  channels: PngChannels;
  /** Row-major pixel bytes, `width * height * channels`. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE: Record<PngChannels, number> = { 1: 0, 3: 2, 4: 6 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  dv.setUint32(8 + payload.length, crc32(out, 4, 8 + payload.length));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Apply filter `type` to one row into `out` (length stride). */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | undefined, bpp: number, out: Uint8Array): void {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp]! : 0;
    const b = prev ? prev[i]! : 0;
    const c = prev && i >= bpp ? prev[i - bpp]! : 0;
    const x = cur[i]!;
    let v = x;
    if (type === 1) v = x - a;
    else if (type === 2) v = x - b;
    else if (type === 3) v = x - ((a + b) >> 1);
    else if (type === 4) v = x - paeth(a, b, c);
    out[i] = v & 0xff;
  }
}

export function encodePng(img: PngImage): Uint8Array {
  const { width, height, channels, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`invalid PNG size ${width}x${height}`);
  }
  const stride = width * channels;
  if (data.length !== stride * height) throw new RangeError(`PNG data length ${data.length} != ${stride * height}`);
  const raw = new Uint8Array((stride + 1) * height);
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : undefined;
    // Standard minimum-sum-of-absolute-differences heuristic over the five filter types.
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type++) {
      filterRow(type, cur, prev, channels, trial);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const v = trial[i]!;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(trial);
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[channels];
  const idat = deflateSync(raw, { level: 9 });
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function decodePng(bytes: Uint8Array): PngImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let channels: PngChannels = 4;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const payload = bytes.subarray(p + 8, p + 8 + len);
    if (crc32(bytes, p + 4, p + 8 + len) !== dv.getUint32(p + 8 + len)) throw new Error(`PNG ${type} CRC mismatch`);
    if (type === 'IHDR') {
      const h = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      const depth = payload[8];
      const ct = payload[9];
      if (depth !== 8 || payload[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs are supported');
      if (ct === 0) channels = 1;
      else if (ct === 2) channels = 3;
      else if (ct === 6) channels = 4;
      else throw new Error(`unsupported PNG colour type ${ct}`);
    } else if (type === 'IDAT') {
      idat.push(payload);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= channels ? prev[i - channels]! : 0;
      const x = src[i]!;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) v = x + paeth(a, b, c);
      else if (type !== 0) throw new Error(`bad PNG filter ${type}`);
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}
