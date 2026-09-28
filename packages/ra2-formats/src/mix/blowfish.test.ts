import { describe, expect, it } from 'vitest';
import { Blowfish } from './blowfish.js';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

// Bruce Schneier's published Blowfish ECB test vectors (big-endian block words).
// XCC's encipher/decipher byte-swap each 32-bit word to big-endian internally,
// so feeding big-endian plaintext bytes reproduces the canonical ciphertext.
const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  ['0000000000000000', '0000000000000000', '4ef997456198dd78'],
  ['ffffffffffffffff', 'ffffffffffffffff', '51866fd5b85ecb8a'],
  ['3000000000000000', '1000000000000001', '7d856f9a613063f2'],
  ['fedcba9876543210', '0123456789abcdef', '0aceab0fc6a0a28d'],
  ['7ca110454a1a6e57', '01a1d6d039776742', '59c68245eb05282b'],
];

describe('Blowfish', () => {
  it('matches Schneier ECB test vectors', () => {
    for (const [key, plain, cipher] of VECTORS) {
      const bf = new Blowfish(hex(key));
      expect(toHex(bf.encipher(hex(plain), 8))).toBe(cipher);
    }
  });

  it('round-trips encipher then decipher', () => {
    const bf = new Blowfish(hex('fedcba9876543210'));
    const plain = hex('0123456789abcdeffedcba9876543210');
    const cipher = bf.encipher(plain);
    expect(toHex(cipher)).not.toBe(toHex(plain));
    expect(toHex(bf.decipher(cipher))).toBe(toHex(plain));
  });

  it('accepts a 56-byte key (RA2 MIX key size)', () => {
    const key = new Uint8Array(56);
    for (let i = 0; i < 56; i++) key[i] = i;
    const bf = new Blowfish(key);
    const plain = hex('00112233445566778899aabbccddeeff');
    expect(toHex(bf.decipher(bf.encipher(plain)))).toBe(toHex(plain));
  });
});
