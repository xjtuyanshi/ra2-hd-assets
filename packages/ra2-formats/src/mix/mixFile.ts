// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/mix_file.cpp, misc/cc_structures.h
//
// Parser for Westwood MIX archives as used by Red Alert 2 / Yuri's Revenge (and
// Tiberian Sun). Supports the RA2-era format with an optional 4-byte flags
// header (checksum / encrypted), Blowfish-encrypted header+index, and the
// classic Tiberian Dawn headerless layout is intentionally out of scope for the
// RA2 engine (RA2/YR always use the flagged format).

import { Blowfish } from './blowfish.js';
import { idFromName } from './crc.js';
import { getBlowfishKey, KEY_SOURCE_SIZE } from './wskey.js';

/** Flag bit: archive body is followed by a 20-byte checksum. */
export const MIX_FLAG_CHECKSUM = 0x00010000;
/** Flag bit: header + index are Blowfish-encrypted. */
export const MIX_FLAG_ENCRYPTED = 0x00020000;

const HEADER_SIZE = 6; // int16 c_files + int32 size (packed)
const INDEX_ENTRY_SIZE = 12; // uint32 id + int32 offset + int32 size
const CHECKSUM_SIZE = 20;

/** One entry in a MIX index: a file's id, byte offset, and byte size. */
export interface MixEntry {
  /** CRC-based file id (see {@link idFromName}). */
  readonly id: number;
  /** Absolute byte offset of the file's data within the archive. */
  readonly offset: number;
  /** File size in bytes. */
  readonly size: number;
}

/**
 * A parsed MIX archive. Holds a reference to the backing buffer and an index of
 * its members; file data is sliced lazily on lookup (no copy of the whole body).
 */
export class MixFile {
  private readonly data: Uint8Array;
  private readonly entries: MixEntry[];
  private readonly byId: Map<number, MixEntry>;

  /** Whether the archive carried the encrypted-header flag. */
  readonly encrypted: boolean;
  /** Whether the archive carried the checksum flag. */
  readonly checksum: boolean;

  private constructor(
    data: Uint8Array,
    entries: MixEntry[],
    encrypted: boolean,
    checksum: boolean,
  ) {
    this.data = data;
    this.entries = entries;
    this.encrypted = encrypted;
    this.checksum = checksum;
    this.byId = new Map();
    for (const e of entries) this.byId.set(e.id, e);
  }

  /** Parse a MIX archive from a byte buffer. Throws if the layout is invalid. */
  static parse(data: Uint8Array): MixFile {
    if (data.length < 4) {
      throw new Error('MIX too small to contain a flags header');
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = view.getUint32(0, true);

    // RA2/YR always use the flagged format. Reject stray high bits so we do not
    // misparse a headerless (Tiberian Dawn) MIX as a flagged one.
    if (flags & ~(MIX_FLAG_CHECKSUM | MIX_FLAG_ENCRYPTED)) {
      throw new Error(`Unsupported MIX flags 0x${flags.toString(16)}`);
    }
    const checksum = (flags & MIX_FLAG_CHECKSUM) !== 0;
    const encrypted = (flags & MIX_FLAG_ENCRYPTED) !== 0;

    const entries = encrypted
      ? MixFile.parseEncrypted(data, view, checksum)
      : MixFile.parsePlain(data, view, checksum);

    return new MixFile(data, entries, encrypted, checksum);
  }

  private static parsePlain(data: Uint8Array, view: DataView, checksum: boolean): MixEntry[] {
    // Layout: [flags:4][c_files:2][size:4][index...][body...][checksum?]
    const cFiles = view.getUint16(4, true);
    const cbIndex = cFiles * INDEX_ENTRY_SIZE;
    const bodySize = view.getInt32(4 + 2, true);
    const dataBase = 4 + HEADER_SIZE + cbIndex;
    const expected = dataBase + bodySize + (checksum ? CHECKSUM_SIZE : 0);
    if (data.length !== expected) {
      throw new Error(`MIX size mismatch: expected ${expected}, got ${data.length}`);
    }
    const entries: MixEntry[] = [];
    let p = 4 + HEADER_SIZE;
    for (let i = 0; i < cFiles; i++) {
      const id = view.getUint32(p, true) >>> 0;
      const offset = view.getInt32(p + 4, true) + dataBase;
      const size = view.getInt32(p + 8, true);
      entries.push({ id, offset, size });
      p += INDEX_ENTRY_SIZE;
    }
    return entries;
  }

  private static parseEncrypted(data: Uint8Array, _view: DataView, checksum: boolean): MixEntry[] {
    // Layout: [flags:4][keySource:80][enc(header+index)...][body...][checksum?]
    if (data.length < 4 + KEY_SOURCE_SIZE + 8) {
      throw new Error('Encrypted MIX too small');
    }
    const keySource = data.subarray(4, 4 + KEY_SOURCE_SIZE);
    const key = getBlowfishKey(keySource);
    const bf = new Blowfish(key);

    // Decrypt the first 8-byte block to read the header (c_files, size) plus the
    // first 2 bytes of the index.
    const encStart = 4 + KEY_SOURCE_SIZE; // 84
    const firstBlock = bf.decipher(data.subarray(encStart, encStart + 8), 8);
    const headerView = new DataView(firstBlock.buffer, firstBlock.byteOffset, 8);
    const cFiles = headerView.getUint16(0, true);
    const bodySize = headerView.getInt32(2, true);

    const cbIndex = cFiles * INDEX_ENTRY_SIZE;
    // Number of encrypted bytes covering header(6) + index, rounded up to a
    // multiple of 8: (6 + cbIndex + 7) & ~7 == (cbIndex + 5) & ~7 accounting for
    // the 2 index bytes already in the first block.
    const cbF = (cbIndex + 5) & ~7;
    const dataBase = encStart + 8 + cbF;
    const expected = dataBase + bodySize + (checksum ? CHECKSUM_SIZE : 0);
    if (data.length !== expected) {
      throw new Error(`Encrypted MIX size mismatch: expected ${expected}, got ${data.length}`);
    }

    // Reassemble the raw index bytes: first 2 bytes come from firstBlock[6..8],
    // the rest from the remaining decrypted blocks.
    const indexBytes = new Uint8Array(cbIndex);
    if (cFiles > 0) {
      indexBytes[0] = firstBlock[6]!;
      indexBytes[1] = firstBlock[7]!;
      const rest = bf.decipher(data.subarray(encStart + 8, encStart + 8 + cbF), cbF);
      indexBytes.set(rest.subarray(0, cbIndex - 2), 2);
    }

    const idxView = new DataView(indexBytes.buffer);
    const entries: MixEntry[] = [];
    let p = 0;
    for (let i = 0; i < cFiles; i++) {
      const id = idxView.getUint32(p, true) >>> 0;
      const offset = idxView.getInt32(p + 4, true) + dataBase;
      const size = idxView.getInt32(p + 8, true);
      entries.push({ id, offset, size });
      p += INDEX_ENTRY_SIZE;
    }
    return entries;
  }

  /** Number of files in the archive. */
  get count(): number {
    return this.entries.length;
  }

  /** Return a shallow copy of the index entries. */
  list(): MixEntry[] {
    return this.entries.slice();
  }

  /** Look up an entry by its already-computed id, or undefined if absent. */
  getEntryById(id: number): MixEntry | undefined {
    return this.byId.get(id >>> 0);
  }

  /** Look up an entry by file name (hashed via {@link idFromName}). */
  getEntry(name: string): MixEntry | undefined {
    return this.byId.get(idFromName(name));
  }

  /** Extract a file's bytes by name, or undefined if not present. */
  read(name: string): Uint8Array | undefined {
    return this.readById(idFromName(name));
  }

  /** Extract a file's bytes by id, or undefined if not present. */
  readById(id: number): Uint8Array | undefined {
    const e = this.byId.get(id >>> 0);
    if (!e) return undefined;
    return this.data.subarray(e.offset, e.offset + e.size);
  }

  /**
   * The backing buffer. Used by the VFS to mount a MIX nested inside another
   * MIX (the nested archive's data is a sub-range of this buffer).
   */
  get buffer(): Uint8Array {
    return this.data;
  }
}
