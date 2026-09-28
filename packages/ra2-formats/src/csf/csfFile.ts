// CSF (Command & Conquer String File) parser for the Vanguard engine.
//
// CSF is the format Westwood used for RA2/Yuri's Revenge localized UI strings
// (ra2.csf / ra2md.csf). This is original Vanguard code. The exact chunk-tag
// constants, header field order, and the per-16-bit-unit bitwise inversion of
// the wide string payload were cross-checked against the XCC library's
// definitions in cc_structures.h (t_csf_header, csf_*_id) and the reference
// reader in the FinalAlert2 mission editor (both GPLv3, by Olaf van der Spek /
// Matthias Wagner); no XCC code is reproduced here.

/** Four-byte CSF chunk tags, stored little-endian on disk. */
const TAG_FILE = ' FSC'; // file header    (XCC 'CSF ')
const TAG_LABEL = ' LBL'; // label record   (XCC 'LBL ')
const TAG_STRING = ' RTS'; // value, no extra ASCII (XCC 'STR ')
const TAG_STRING_W = 'WRTS'; // value with extra ASCII (XCC 'STRW')

/**
 * Language codes recorded in the CSF header. RA2/YR only ever ships
 * {@link CsfLanguage.EnglishUS}, but the full Westwood table is exposed so the
 * value round-trips meaningfully.
 */
export enum CsfLanguage {
  EnglishUS = 0,
  EnglishUK = 1,
  German = 2,
  French = 3,
  Spanish = 4,
  Italian = 5,
  Japanese = 6,
  Jabberwockie = 7,
  Korean = 8,
  Chinese = 9,
  Unknown = 10,
}

/** A single value attached to a label. */
export interface CsfValue {
  /** The decoded UTF-16 string (16-bit units are un-inverted on read). */
  readonly value: string;
  /**
   * Optional trailing ASCII payload, present only for 'WRTS' values. Westwood
   * used it for a handful of speech/EVA filenames; usually undefined.
   */
  readonly extra?: string;
}

/** A label and the one-or-more values bound to it. */
export interface CsfLabel {
  /** Label name exactly as stored, e.g. `"Name:E1"` or `"GUI:Options"`. */
  readonly name: string;
  /** Values in file order. Almost always length 1; the format permits more. */
  readonly values: readonly CsfValue[];
}

/** Parsed CSF header fields. */
export interface CsfHeader {
  /** Format version. RA2/YR files are version 3. */
  readonly version: number;
  /** Number of label records the header claims. */
  readonly labelCount: number;
  /** Number of value records the header claims (>= labelCount). */
  readonly stringCount: number;
  /** Declared language of the string table. */
  readonly language: CsfLanguage;
}

/** Options controlling {@link CsfFile.parse}. */
export interface CsfParseOptions {
  /**
   * When true (the default), a truncated or malformed record ends parsing
   * gracefully and keeps the labels read so far. When false, such a file
   * throws a {@link RangeError}. The header magic is always validated.
   */
  readonly tolerant?: boolean;
}

const decoderUtf16 = new TextDecoder('utf-16le');
const decoderAscii = new TextDecoder('latin1');

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * A parsed CSF string table with case-insensitive label lookup.
 *
 * @example
 * ```ts
 * const csf = CsfFile.parse(bytes);
 * csf.get('name:e1');        // -> "Conscript" (lookup is case-insensitive)
 * csf.getLabel('GUI:Options')?.values.length;
 * ```
 */
export class CsfFile {
  /** File header fields. */
  readonly header: CsfHeader;

  /** All labels in file order. */
  readonly labels: readonly CsfLabel[];

  // Lowercased-name -> label, for case-insensitive lookup.
  private readonly byName: ReadonlyMap<string, CsfLabel>;

  private constructor(header: CsfHeader, labels: CsfLabel[]) {
    this.header = header;
    this.labels = labels;
    const map = new Map<string, CsfLabel>();
    for (const label of labels) {
      // Later duplicates win, matching how the game's last-write map behaves.
      map.set(label.name.toLowerCase(), label);
    }
    this.byName = map;
  }

  /** Number of distinct labels parsed. */
  get labelCount(): number {
    return this.labels.length;
  }

  /**
   * Parse CSF bytes. Throws {@link RangeError} if the ' FSC' magic is missing.
   */
  static parse(data: Uint8Array, options: CsfParseOptions = {}): CsfFile {
    const tolerant = options.tolerant ?? true;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const len = data.byteLength;

    if (len < 24 || readTag(view, 0) !== TAG_FILE) {
      throw new RangeError('Not a CSF file: missing " FSC" header magic');
    }

    const header: CsfHeader = {
      version: view.getInt32(4, true),
      labelCount: view.getInt32(8, true),
      stringCount: view.getInt32(12, true),
      // bytes 16..20 are unused (zero); byte 20 is the language.
      language: normalizeLanguage(view.getInt32(20, true)),
    };

    const labels: CsfLabel[] = [];
    let offset = 24;

    const fail = (message: string): CsfFile => {
      if (!tolerant) throw new RangeError(message);
      return new CsfFile(header, labels);
    };

    for (let i = 0; i < header.labelCount; i++) {
      // Each label starts with the ' LBL' tag. Scan forward over any stray
      // padding, exactly as the reference reader tolerates it.
      while (offset + 4 <= len && readTag(view, offset) !== TAG_LABEL) {
        offset += 1;
      }
      if (offset + 8 > len) return fail('CSF truncated: expected " LBL" record');
      offset += 4;

      const valueCount = view.getInt32(offset, true);
      offset += 4;
      const nameLen = view.getInt32(offset, true);
      offset += 4;
      if (nameLen < 0 || offset + nameLen > len) {
        return fail('CSF truncated: label name overruns buffer');
      }
      const name = decoderAscii.decode(data.subarray(offset, offset + nameLen));
      offset += nameLen;

      const values: CsfValue[] = [];
      for (let v = 0; v < valueCount; v++) {
        if (offset + 8 > len) return fail('CSF truncated: expected value record');
        const tag = readTag(view, offset);
        const hasExtra = tag === TAG_STRING_W;
        if (tag !== TAG_STRING && tag !== TAG_STRING_W) {
          return fail(`CSF: unexpected value tag "${tag}" for label "${name}"`);
        }
        offset += 4;

        const charCount = view.getInt32(offset, true);
        offset += 4;
        if (charCount < 0 || offset + charCount * 2 > len) {
          return fail('CSF truncated: value text overruns buffer');
        }
        // The wide payload is UTF-16LE with every 16-bit unit bitwise-inverted.
        // Un-invert into a scratch buffer, then decode.
        const units = new Uint8Array(charCount * 2);
        for (let c = 0; c < charCount; c++) {
          const w = view.getUint16(offset + c * 2, true) ^ 0xffff;
          units[c * 2] = w & 0xff;
          units[c * 2 + 1] = (w >> 8) & 0xff;
        }
        offset += charCount * 2;
        const text = decoderUtf16.decode(units);

        let extra: string | undefined;
        if (hasExtra) {
          if (offset + 4 > len) return fail('CSF truncated: expected WRTS extra length');
          const extraLen = view.getInt32(offset, true);
          offset += 4;
          if (extraLen < 0 || offset + extraLen > len) {
            return fail('CSF truncated: WRTS extra data overruns buffer');
          }
          // The extra ASCII payload is NOT inverted.
          extra = decoderAscii.decode(data.subarray(offset, offset + extraLen));
          offset += extraLen;
        }

        values.push(extra === undefined ? { value: text } : { value: text, extra });
      }

      labels.push({ name, values });
    }

    return new CsfFile(header, labels);
  }

  /** Look up a label by name, case-insensitively. */
  getLabel(name: string): CsfLabel | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /**
   * Return the first value's text for a label, case-insensitively, or
   * `undefined` if the label is absent. Multi-value labels expose the rest via
   * {@link getLabel}.
   */
  get(name: string): string | undefined {
    return this.byName.get(name.toLowerCase())?.values[0]?.value;
  }

  /** True if a label with the given name exists (case-insensitive). */
  has(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }
}

function normalizeLanguage(code: number): CsfLanguage {
  return code >= CsfLanguage.EnglishUS && code <= CsfLanguage.Chinese
    ? (code as CsfLanguage)
    : CsfLanguage.Unknown;
}
