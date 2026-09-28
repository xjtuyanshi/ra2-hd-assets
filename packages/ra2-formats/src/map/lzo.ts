// LZO1X-1 decompression.
//
// Ported from minilzo-js by Alistair Braidwood (GPL-2.0-or-later) —
// https://github.com/abraidwood/minilzo-js (src/lzo1x.js), itself a JavaScript
// port of the LZO library's lzo1x_decompress by Markus F.X.J. Oberhumer
// <markus@oberhumer.com>, distributed under the GNU General Public License.
// XCC bundles miniLZO and calls lzo1x_decompress to unpack RA2/YR
// [IsoMapPack5] chunks; this ports the decompressor half only (no compression).
// See http://www.oberhumer.com/opensource/lzo/.

/**
 * Thrown when an LZO1X stream is malformed (framing that would read/write past
 * the buffers) or when the decoded size does not match the caller's expectation.
 */
export class LzoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LzoError';
  }
}

/**
 * Decompress an LZO1X-1 stream.
 *
 * LZO1X streams carry no length header, so most RA2 chunk formats store the
 * expected decoded size alongside the payload. Pass it as {@link outputSize} to
 * get a validated result; omit it to let the buffer grow dynamically.
 *
 * @param input      the compressed LZO1X bytes.
 * @param outputSize optional exact expected decompressed length. When supplied
 *   the result is verified against it and a mismatch throws.
 * @returns a `Uint8Array` of exactly the decoded bytes.
 * @throws {LzoError} on malformed input or a decoded-size mismatch.
 */
export function decodeLzo1x(input: Uint8Array, outputSize?: number): Uint8Array {
  const decoded = decompress(input, outputSize);
  if (outputSize !== undefined && decoded.length !== outputSize) {
    throw new LzoError(
      `LZO output size mismatch: expected ${outputSize}, got ${decoded.length}`,
    );
  }
  return decoded;
}

// Internal decompressor state. Mirrors the pointer-machine structure of the
// reference so the control flow (match/match_next/match_done) maps 1:1.
class Lzo1xState {
  buf: Uint8Array;
  out: Uint8Array;
  ip = 0;
  op = 0;
  t = 0;
  mPos = 0;
  cbl: number;
  ipEnd: number;

  constructor(input: Uint8Array, hint: number | undefined) {
    this.buf = input;
    this.ipEnd = input.length;
    // Start close to the true size when known; otherwise a generous guess that
    // grows as needed. LZO1X-1 rarely exceeds ~4x on this data.
    const initial = hint !== undefined ? hint : Math.max(64, input.length * 4);
    this.out = new Uint8Array(initial);
    this.cbl = this.out.length;
  }

  private extend(minNewSize: number): void {
    // Grow to at least the requested size, rounded up in chunks to amortise.
    const block = 16384;
    const next = minNewSize + (block - (minNewSize % block));
    const grown = new Uint8Array(next);
    grown.set(this.out.subarray(0, this.op));
    this.out = grown;
    this.cbl = this.out.length;
  }

  private ensure(minNewSize: number): void {
    if (minNewSize > this.cbl) this.extend(minNewSize);
  }

  private readByte(): number {
    if (this.ip >= this.ipEnd) throw new LzoError('unexpected end of LZO input');
    return this.buf[this.ip++]!;
  }

  private matchNext(): void {
    this.ensure(this.op + 3);
    this.out[this.op++] = this.readByte();
    if (this.t > 1) {
      this.out[this.op++] = this.readByte();
      if (this.t > 2) this.out[this.op++] = this.readByte();
    }
    this.t = this.readByte();
  }

  private matchDone(): number {
    this.t = this.buf[this.ip - 2]! & 3;
    return this.t;
  }

  private copyMatch(): void {
    this.t += 2;
    this.ensure(this.op + this.t);
    if (this.mPos < 0 || this.mPos >= this.op) {
      throw new LzoError('lookbehind overrun in LZO match');
    }
    do {
      this.out[this.op++] = this.out[this.mPos++]!;
    } while (--this.t > 0);
  }

  private copyFromBuf(): void {
    this.ensure(this.op + this.t);
    do {
      this.out[this.op++] = this.readByte();
    } while (--this.t > 0);
  }

  // Returns true when the end-of-stream marker was reached.
  private match(): boolean {
    for (;;) {
      if (this.t >= 64) {
        this.mPos = this.op - 1 - ((this.t >> 2) & 7) - (this.readByte() << 3);
        this.t = (this.t >> 5) - 1;
        this.copyMatch();
      } else if (this.t >= 32) {
        this.t &= 31;
        if (this.t === 0) {
          while (this.buf[this.ip] === 0) {
            this.t += 255;
            this.ip++;
          }
          this.t += 31 + this.readByte();
        }
        this.mPos = this.op - 1 - (this.buf[this.ip]! >> 2) - (this.buf[this.ip + 1]! << 6);
        this.ip += 2;
        this.copyMatch();
      } else if (this.t >= 16) {
        this.mPos = this.op - ((this.t & 8) << 11);
        this.t &= 7;
        if (this.t === 0) {
          while (this.buf[this.ip] === 0) {
            this.t += 255;
            this.ip++;
          }
          this.t += 7 + this.readByte();
        }
        this.mPos -= (this.buf[this.ip]! >> 2) + (this.buf[this.ip + 1]! << 6);
        this.ip += 2;
        if (this.mPos === this.op) {
          // End-of-stream marker.
          return true;
        }
        this.mPos -= 0x4000;
        this.copyMatch();
      } else {
        this.mPos = this.op - 1 - (this.t >> 2) - (this.readByte() << 2);
        this.ensure(this.op + 2);
        if (this.mPos < 0 || this.mPos >= this.op) {
          throw new LzoError('lookbehind overrun in LZO short match');
        }
        this.out[this.op++] = this.out[this.mPos++]!;
        this.out[this.op++] = this.out[this.mPos]!;
      }

      if (this.matchDone() === 0) {
        return false;
      }
      this.matchNext();
    }
  }

  run(): Uint8Array {
    let skipToFirstLiteral = false;

    if (this.buf[this.ip]! > 17) {
      this.t = this.readByte() - 17;
      if (this.t < 4) {
        this.matchNext();
        if (this.match()) return this.out.subarray(0, this.op);
      } else {
        this.copyFromBuf();
        skipToFirstLiteral = true;
      }
    }

    for (;;) {
      if (!skipToFirstLiteral) {
        this.t = this.readByte();
        if (this.t >= 16) {
          if (this.match()) return this.out.subarray(0, this.op);
          continue;
        } else if (this.t === 0) {
          while (this.buf[this.ip] === 0) {
            this.t += 255;
            this.ip++;
          }
          this.t += 15 + this.readByte();
        }
        this.t += 3;
        this.copyFromBuf();
      } else {
        skipToFirstLiteral = false;
      }

      this.t = this.readByte();
      if (this.t < 16) {
        this.mPos = this.op - (1 + 0x0800);
        this.mPos -= this.t >> 2;
        this.mPos -= this.readByte() << 2;
        this.ensure(this.op + 3);
        if (this.mPos < 0 || this.mPos >= this.op) {
          throw new LzoError('lookbehind overrun in LZO literal-match');
        }
        this.out[this.op++] = this.out[this.mPos++]!;
        this.out[this.op++] = this.out[this.mPos++]!;
        this.out[this.op++] = this.out[this.mPos]!;
        if (this.matchDone() === 0) {
          continue;
        }
        this.matchNext();
      }

      if (this.match()) return this.out.subarray(0, this.op);
    }
  }
}

function decompress(input: Uint8Array, hint: number | undefined): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const state = new Lzo1xState(input, hint);
  const view = state.run();
  // Return a tight copy so callers own a standalone buffer.
  return view.slice();
}
