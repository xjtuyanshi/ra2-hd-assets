import { describe, expect, it } from 'vitest';
import { crc32, idFromName } from './crc.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the canonical CRC-32/ISO-HDLC check value', () => {
    // "123456789" -> 0xCBF43926 is the standard test vector for reflected CRC-32.
    expect(crc32(bytes('123456789')) >>> 0).toBe(0xcbf43926);
  });

  it('returns 0 for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('produces a known value for a short string', () => {
    // CRC-32 of "The quick brown fox jumps over the lazy dog" = 0x414FA339.
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(
      0x414fa339,
    );
  });
});

describe('idFromName', () => {
  it('is case-insensitive and slash-normalizing', () => {
    expect(idFromName('Rules.INI')).toBe(idFromName('rules.ini'));
    expect(idFromName('dir/file.shp')).toBe(idFromName('DIR\\FILE.SHP'));
  });

  it('produces the id that matches a real ra2md.mix index entry', () => {
    // Verified against the RA2 install: ra2md.mix contains "localmd.mix" whose
    // index id is 0xfbe0d09d, so this pins the exact TS/RA2 hashing rule.
    expect(idFromName('localmd.mix') >>> 0).toBe(0xfbe0d09d);
    expect(idFromName('local mix database.dat') >>> 0).toBe(0x366e051f);
  });

  it('hashes a 4-byte-aligned name without padding', () => {
    // Length 8 ("ABCD.EFG" is 8) is a multiple of 4, so no tail padding applies;
    // the id is simply crc32 of the upper-cased bytes.
    const name = 'test.ini'; // 8 chars, multiple of 4
    expect(idFromName(name)).toBe(crc32(bytes(name.toUpperCase())));
  });

  it('applies Westwood tail padding for non-aligned lengths', () => {
    // "abc" (length 3): a = 0, rem = 3. Padded bytes are
    //   'A','B','C', then (l-a)=3, then fill = base[a]='A' to complete 4 bytes.
    const padded = new Uint8Array([0x41, 0x42, 0x43, 0x03]);
    expect(idFromName('abc')).toBe(crc32(padded));
  });

  it('pads a length-5 name correctly', () => {
    // "abcde" (length 5): a = 4, rem = 1. Group: keep 5 bytes then append
    //   (l-a)=1, then fill = base[4]='E' twice -> A B C D E 1 E E.
    const padded = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x01, 0x45, 0x45]);
    expect(idFromName('abcde')).toBe(crc32(padded));
  });
});
