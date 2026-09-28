// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/crc.h, misc/mix_file.cpp
//
// MIX filename -> 32-bit id hashing for Tiberian Sun / Red Alert 2 (and YR) era
// archives. XCC computes the id as a reflected CRC-32 (IEEE 802.3, the same
// polynomial and reflection as boost::crc_32_type / zlib) over the file name
// after it has been upper-cased, backslash-normalized, and length-padded to a
// multiple of four bytes using Westwood's peculiar tail-padding rule.
//
// Getting the padding wrong yields ids that match zero real files, so the rule
// below mirrors Cmix_file::get_id (game_ts / game_ra2 / game_ra2_yr branch)
// byte-for-byte.

/**
 * Standard reflected CRC-32 (polynomial 0xEDB88320) matching
 * boost::crc_32_type used by XCC's compute_crc.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute the reflected CRC-32 of a byte range. Bit-for-bit identical to
 * `boost::crc_32_type` (initial value 0xFFFFFFFF, final XOR 0xFFFFFFFF,
 * input and output reflected).
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] as number;
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalize a MIX member name the way Westwood/XCC does before hashing:
 * upper-case it and convert forward slashes to backslashes. Returns the raw
 * upper-cased ASCII bytes.
 */
function normalizeName(name: string): Uint8Array {
  const upper = name.toUpperCase().replace(/\//g, '\\');
  const bytes = new Uint8Array(upper.length);
  for (let i = 0; i < upper.length; i++) {
    bytes[i] = upper.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Compute the TS/RA2/YR MIX id (a uint32) for a file name.
 *
 * Mirrors Cmix_file::get_id: after upper-casing and slash normalization the
 * name length `l` is rounded down to `a = l & ~3`. If `l` is not a multiple of
 * four, the name is extended: first append the byte `l - a` (the count of
 * trailing bytes), then repeat the byte at index `a` (the first byte of the
 * final partial group) until the group of four is complete. The reflected
 * CRC-32 of the padded bytes is the id.
 */
export function idFromName(name: string): number {
  const base = normalizeName(name);
  const l = base.length;
  const a = l & ~3;
  const rem = l & 3;
  if (rem === 0) {
    return crc32(base);
  }
  // Pad the final partial group of 4 bytes.
  const padded = new Uint8Array(a + 4);
  padded.set(base.subarray(0, l));
  // XCC: name += (l - a); then name.append(3 - (l & 3), name[a]).
  padded[l] = (l - a) & 0xff;
  const fill = base[a] as number; // first byte of the final partial group
  for (let i = l + 1; i < a + 4; i++) {
    padded[i] = fill;
  }
  return crc32(padded);
}
