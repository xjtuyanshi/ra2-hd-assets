// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/mix_decode.cpp, misc/mix_decode.h
//
// Westwood key-source decode: an 80-byte "key source" embedded at the front of
// an encrypted MIX is run through an RSA "decrypt" (modular exponentiation with
// a fixed public key) to produce the 56-byte Blowfish key that decrypts the
// header + index.
//
// XCC implements the big-integer arithmetic by hand with 16-bit-word Montgomery
// routines. This port reproduces the same *algorithm* — decode the embedded
// public key (modulus + exponent 0x10001), then for each `a+1`-byte block of
// the key source compute `block^exponent mod modulus` and take the low `a`
// bytes — but uses JavaScript's native arbitrary-precision BigInt for the
// modular exponentiation. The result is byte-for-byte identical to XCC's
// get_blowfish_key while avoiding a fragile hand-rolled bignum implementation.

import { BLOWFISH_KEY_SIZE } from './blowfish.js';

/** Length in bytes of the key source at the start of an encrypted MIX. */
export const KEY_SOURCE_SIZE = 80;

// The embedded public key, base64-encoded (XCC's pubkey_str). Decoding it yields
// a DER-ish blob: a 0x02 tag, a length byte, then the big-endian modulus.
const PUBKEY_STR = 'AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V';

function char2num(c: number): number {
  // Standard base64 alphabet: A-Z=0-25, a-z=26-51, 0-9=52-61, '+'=62, '/'=63.
  if (c >= 0x41 && c <= 0x5a) return c - 0x41;
  if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26;
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;
  if (c === 0x2b) return 62;
  if (c === 0x2f) return 63;
  return -1;
}

interface PubKey {
  /** RSA modulus. */
  modulus: bigint;
  /** RSA public exponent (always 0x10001 for Westwood). */
  exponent: bigint;
  /** bitlen(modulus) - 1, matching XCC's pubkey.len. */
  len: number;
}

let cachedPubKey: PubKey | undefined;

/** Decode PUBKEY_STR into the modulus + exponent used for the RSA decrypt. */
function initPubKey(): PubKey {
  // Base64-decode the key string into raw bytes.
  const raw: number[] = [];
  for (let i = 0; i + 3 < PUBKEY_STR.length; i += 4) {
    let tmp = char2num(PUBKEY_STR.charCodeAt(i));
    tmp = (tmp << 6) | char2num(PUBKEY_STR.charCodeAt(i + 1));
    tmp = (tmp << 6) | char2num(PUBKEY_STR.charCodeAt(i + 2));
    tmp = (tmp << 6) | char2num(PUBKEY_STR.charCodeAt(i + 3));
    raw.push((tmp >> 16) & 0xff, (tmp >> 8) & 0xff, tmp & 0xff);
  }

  // key_to_bignum: expect a 0x02 tag, then a length (short form only for RA2),
  // then a big-endian modulus of that many bytes.
  let p = 0;
  if (raw[p++] !== 0x02) {
    throw new Error('Malformed Westwood public key');
  }
  let keylen: number;
  const lenByte = raw[p]!;
  if (lenByte & 0x80) {
    const count = lenByte & 0x7f;
    keylen = 0;
    for (let i = 0; i < count; i++) keylen = (keylen << 8) | raw[p + i + 1]!;
    p += count + 1;
  } else {
    keylen = lenByte;
    p++;
  }

  let modulus = 0n;
  for (let i = 0; i < keylen; i++) {
    modulus = (modulus << 8n) | BigInt(raw[p + i]!);
  }

  const len = modulus.toString(2).length - 1;
  return { modulus, exponent: 0x10001n, len };
}

/** Modular exponentiation: base^exp mod mod. */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % mod;
    e >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Decode an 80-byte MIX key source into the 56-byte Blowfish key.
 *
 * `keySource` must be at least {@link KEY_SOURCE_SIZE} bytes (the bytes that
 * immediately follow the 4-byte MIX flags header in an encrypted archive).
 */
export function getBlowfishKey(keySource: Uint8Array): Uint8Array {
  if (!cachedPubKey) cachedPubKey = initPubKey();
  const { modulus, exponent, len } = cachedPubKey;

  // XCC: a = (pubkey.len - 1) / 8. Each input block is (a + 1) bytes and yields
  // a bytes of key material. Blocks are little-endian.
  const a = Math.floor((len - 1) / 8);
  const blockIn = a + 1;

  const key = new Uint8Array(256);
  let outOff = 0;
  let inOff = 0;
  // XCC caps input at len_predata() = (55 / a + 1) * (a + 1) bytes — enough
  // blocks to yield the 56-byte key (80 for the real key); mirror that so
  // longer buffers decode identically.
  const lenPredata = (Math.floor((BLOWFISH_KEY_SIZE - 1) / a) + 1) * blockIn;
  let remaining = Math.min(keySource.length, lenPredata);
  while (blockIn <= remaining) {
    // Little-endian block -> bigint.
    let n = 0n;
    for (let i = blockIn - 1; i >= 0; i--) {
      n = (n << 8n) | BigInt(keySource[inOff + i]!);
    }
    let r = modPow(n, exponent, modulus);
    // Low `a` bytes, little-endian.
    for (let i = 0; i < a; i++) {
      key[outOff + i] = Number(r & 0xffn);
      r >>= 8n;
    }
    inOff += blockIn;
    outOff += a;
    remaining -= blockIn;
  }

  return key.subarray(0, BLOWFISH_KEY_SIZE);
}
