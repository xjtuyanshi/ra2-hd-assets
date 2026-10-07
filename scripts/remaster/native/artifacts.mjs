import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const WT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_OUT = resolve(WT, '../../gameres/s2x/native');
export function outputDirectory(value = process.env.NATIVE_OUT || DEFAULT_OUT) {
  const out = resolve(value);
  if (!out.split(/[\\/]/).includes('gameres')) throw new Error('Game-derived artifacts must stay under gameres');
  mkdirSync(out, { recursive: true });
  return out;
}
function crc32(b) {
  let c = 0xffffffff;
  for (const v of b) {
    c ^= v;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const t = Buffer.from(type),
    n = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  n.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, bytes])));
  return Buffer.concat([n, t, bytes, crc]);
}
export function writePng(path, { width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rgb = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = pixels.readUInt16LE((y * width + x) * 2),
        i = y * (width * 3 + 1) + 1 + x * 3;
      rgb[i] = Math.round((((v >>> 11) & 31) * 255) / 31);
      rgb[i + 1] = Math.round((((v >>> 5) & 63) * 255) / 63);
      rgb[i + 2] = Math.round(((v & 31) * 255) / 31);
    }
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rgb)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
/* Record exact inbound protocol packets. Every record is timeMs f64 LE, length u32 LE, packet. */
export class Recorder {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'wx');
    writeSync(this.fd, Buffer.from('NHREC1\n'));
    this.start = performance.now();
  }
  write(raw) {
    if (this.fd === null) return;
    const h = Buffer.alloc(12);
    h.writeDoubleLE(performance.now() - this.start);
    h.writeUInt32LE(raw.length, 8);
    writeSync(this.fd, h);
    writeSync(this.fd, raw);
  }
  close() {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
