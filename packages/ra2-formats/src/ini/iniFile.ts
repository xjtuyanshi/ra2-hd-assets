// Ported from the FinalSun/FinalAlert 2 Mission Editor (GPLv3), Copyright (C)
// 1999-2024 Electronic Arts, Inc., authored by Matthias Wagner — the
// CIniFile::InsertFile tokeniser in MissionEditor/IniFile.cpp. (This logic is
// NOT part of Olaf van der Spek's XCC `misc` library; only the mix/crc/blowfish
// ports come from there.)
//
// Westwood-dialect INI parser for the Vanguard engine.
//
// This implements the *vanilla* Westwood INI semantics used by Red Alert 2 /
// Yuri's Revenge rules files (rules.ini, art.ini, FAData.ini, map files, ...).
// The tokenisation rules (section detection, ';' comment stripping, first-'='
// key/value split) are ported verbatim from the XCC MissionEditor `CIniFile`
// loader, then adjusted to match the behaviour of the actual game engine's
// `CCINIClass`, which — unlike the FinalAlert2 editor's optional `bNoSpaces`
// flag — *always* trims surrounding whitespace from section names, keys and
// values.
//
// Deliberate v1 limitations (documented, not accidental):
//   * No Ares/Phobos extensions. `+=` auto-numbered appends and `[Section]:[Base]`
//     section inheritance are NOT interpreted; they are parsed as ordinary keys /
//     section names with vanilla last-wins semantics.
//   * No `$Include` / nested-file directives.
// These are vanilla semantics only, matching a stock Westwood engine.

/**
 * A parsed INI section: the last-wins key/value map plus the ordered raw
 * entries exactly as they appeared in the file.
 *
 * Both representations are kept because Westwood uses sections in two distinct
 * ways. Most sections are property bags where a duplicate key means "last value
 * wins" (e.g. `[SomeUnit]`). But *list-registry* sections such as
 * `[InfantryTypes]` or `[VehicleTypes]` use every line as an ordered list entry
 * where the key is only an index — there the raw ordered entries are what
 * matter, exposed via {@link IniFile.readRegistry}.
 */
export interface IniSectionData {
  /** Original-case section name (first spelling encountered wins). */
  readonly name: string;
  /**
   * Last-wins key/value map. Keys are stored lower-cased for case-insensitive
   * lookup; values retain their original text (trimmed).
   */
  readonly values: ReadonlyMap<string, string>;
  /** Original-case spelling for each lower-cased key (first spelling wins). */
  readonly keyCase: ReadonlyMap<string, string>;
  /**
   * Every key=value line in file order, unfiltered by duplicate keys. Keys and
   * values carry their original case (both trimmed).
   */
  readonly entries: readonly IniEntry[];
}

/** A single ordered `key=value` line as it appeared in the file. */
export interface IniEntry {
  /** Original-case key text (trimmed). */
  readonly key: string;
  /** Original-case value text (trimmed, comment already stripped). */
  readonly value: string;
}

/** Coerce common Westwood boolean spellings. Case-insensitive. */
function parseBool(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'yes':
    case 'true':
    case '1':
    case 'on':
      return true;
    case 'no':
    case 'false':
    case '0':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

/**
 * A typed handle onto a single INI section with defaulting accessors.
 *
 * All lookups are case-insensitive on the key. Every accessor takes a default
 * that is returned when the key is missing or (for numeric/bool accessors) the
 * stored value fails to parse.
 */
export class IniSection {
  constructor(private readonly data: IniSectionData) {}

  /** Original-case section name. */
  get name(): string {
    return this.data.name;
  }

  /** True if the section contains the given key (case-insensitive). */
  has(key: string): boolean {
    return this.data.values.has(key.trim().toLowerCase());
  }

  /**
   * Raw string value for `key`, or `fallback` if absent. The stored value is
   * already trimmed and has any trailing `;` comment removed.
   */
  getString(key: string, fallback = ''): string {
    const v = this.data.values.get(key.trim().toLowerCase());
    return v ?? fallback;
  }

  /**
   * Boolean value using Westwood spellings (yes/no/true/false/1/0/on/off,
   * case-insensitive). Returns `fallback` if the key is missing or the value is
   * not a recognised boolean.
   */
  getBool(key: string, fallback = false): boolean {
    const v = this.data.values.get(key.trim().toLowerCase());
    if (v === undefined) return fallback;
    const parsed = parseBool(v);
    return parsed ?? fallback;
  }

  /**
   * Integer value. Parses a leading signed integer (base 10); any trailing
   * non-numeric text is ignored, matching the game's lenient atoi-style read.
   * Returns `fallback` if the key is missing or no integer can be read.
   */
  getInt(key: string, fallback = 0): number {
    const v = this.data.values.get(key.trim().toLowerCase());
    if (v === undefined) return fallback;
    const m = /^[+-]?\d+/.exec(v.trim());
    if (!m) return fallback;
    const n = Number.parseInt(m[0], 10);
    return Number.isNaN(n) ? fallback : n;
  }

  /**
   * The raw string for a numeric field, without parsing. Callers that need
   * fixed-point conversion own the string→fixed step; this parser stays free of
   * float math. Returns `fallback` if the key is missing.
   */
  getNumberRaw(key: string, fallback = ''): string {
    return this.getString(key, fallback);
  }

  /**
   * Comma-separated list, each element trimmed. Empty elements (e.g. a trailing
   * comma) are dropped. Returns `fallback` (default `[]`) if the key is missing
   * or the value is empty after trimming.
   */
  getList(key: string, fallback: readonly string[] = []): string[] {
    const v = this.data.values.get(key.trim().toLowerCase());
    if (v === undefined) return [...fallback];
    const trimmed = v.trim();
    if (trimmed === '') return [...fallback];
    const parts = trimmed
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    return parts;
  }

  /**
   * Ordered raw entries for this section in file order, including duplicate
   * keys. Used for list-registry sections where every line matters.
   */
  get entries(): readonly IniEntry[] {
    return this.data.entries;
  }

  /** Number of distinct (last-wins) keys in this section. */
  get size(): number {
    return this.data.values.size;
  }
}

/** Mutable internal accumulator used while building a section. */
interface MutableSection {
  name: string;
  values: Map<string, string>;
  keyCase: Map<string, string>;
  entries: IniEntry[];
}

/**
 * A parsed Westwood INI file. Section and key lookups are case-insensitive
 * while original casing is preserved for round-tripping and display.
 */
export class IniFile {
  /** lower-cased section name -> section data. */
  private readonly sections = new Map<string, IniSectionData>();
  /** lower-cased section name -> original-case name, in first-seen order. */
  private readonly order: string[] = [];

  private constructor(sections: Map<string, IniSectionData>, order: string[]) {
    this.sections = sections;
    this.order = order;
  }

  /**
   * Parse Westwood INI content from either decoded text or raw bytes.
   *
   * When given a `Uint8Array` the bytes are decoded as windows-1252 (the code
   * page stock RA2/YR data files use). A leading UTF-8 BOM (`EF BB BF`) or a
   * decoded U+FEFF is stripped so BOM-prefixed files (e.g. FinalAlert2's
   * FAData.ini) parse cleanly.
   */
  static parse(input: string | Uint8Array): IniFile {
    const text = typeof input === 'string' ? input : decodeWindows1252(input);
    return IniFile.parseText(text);
  }

  private static parseText(rawText: string): IniFile {
    // Strip a leading BOM if the decoder (or a string caller) left one.
    const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

    const sections = new Map<string, MutableSection>();
    const order: string[] = [];
    let current: MutableSection | undefined;

    // Split on LF; a trailing CR is stripped per-line so CRLF and LF both work.
    const lines = text.split('\n');
    for (let line of lines) {
      // Strip everything from the first CR, LF (already split) or ';' — this is
      // the XCC comment/newline truncation. ';' anywhere begins a comment, so
      // both full-line (`;...`) and trailing (`x=1 ;...`) comments are handled.
      const cut = indexOfCommentOrEol(line);
      if (cut >= 0) line = line.slice(0, cut);

      const open = line.indexOf('[');
      const close = line.indexOf(']');
      const eq = line.indexOf('=');

      if (open !== -1 && close !== -1 && open < close && (eq === -1 || eq > open)) {
        // Section header.
        const name = line.slice(open + 1, close).trim();
        const lower = name.toLowerCase();
        let sec = sections.get(lower);
        if (!sec) {
          // Duplicate sections merge: keep the first-seen spelling and reuse the
          // existing accumulator so later keys append to it.
          sec = { name, values: new Map(), keyCase: new Map(), entries: [] };
          sections.set(lower, sec);
          order.push(lower);
        }
        current = sec;
      } else if (eq !== -1 && current) {
        // key=value within the current section.
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        const keyLower = key.toLowerCase();
        // Last value wins for the map; first spelling wins for case display.
        current.values.set(keyLower, value);
        if (!current.keyCase.has(keyLower)) current.keyCase.set(keyLower, key);
        // Ordered raw list keeps every line, duplicates included.
        current.entries.push({ key, value });
      }
      // Lines that are neither a section header nor a key=value (blank lines,
      // stray comments, key=value before any section) are ignored — matching
      // the engine, which drops keys seen before the first section header.
    }

    const finalized = new Map<string, IniSectionData>();
    for (const [lower, sec] of sections) {
      finalized.set(lower, {
        name: sec.name,
        values: sec.values,
        keyCase: sec.keyCase,
        entries: sec.entries,
      });
    }
    return new IniFile(finalized, order);
  }

  /** Case-insensitive test for a section's presence. */
  hasSection(name: string): boolean {
    return this.sections.has(name.trim().toLowerCase());
  }

  /**
   * Return a typed handle for `name`, or `undefined` if absent. Lookup is
   * case-insensitive.
   */
  getSection(name: string): IniSection | undefined {
    const data = this.sections.get(name.trim().toLowerCase());
    return data ? new IniSection(data) : undefined;
  }

  /**
   * Section names in first-seen file order, with their original casing.
   */
  sectionNames(): string[] {
    return this.order.map((lower) => {
      const s = this.sections.get(lower);
      // `order` and `sections` are kept in lock-step, so this is always defined.
      return s ? s.name : lower;
    });
  }

  /** Total number of distinct sections. */
  get sectionCount(): number {
    return this.sections.size;
  }

  /**
   * Read a list-registry section (a TypeList such as `[InfantryTypes]`) as the
   * ordered list of *values* in file order — the way the engine consumes type
   * lists, where the key is a positional index and only the value matters.
   * Duplicate keys are preserved (every line contributes). Returns `[]` for a
   * missing or empty section.
   */
  readRegistry(sectionName: string): string[] {
    const data = this.sections.get(sectionName.trim().toLowerCase());
    if (!data) return [];
    return data.entries.map((e) => e.value);
  }
}

/**
 * Index of the first character that terminates the significant part of an INI
 * line: a `;` comment marker, or a stray CR/LF the split didn't remove.
 * Returns -1 if the whole line is significant.
 */
function indexOfCommentOrEol(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x3b /* ; */ || c === 0x0d /* CR */ || c === 0x0a /* LF */) {
      return i;
    }
  }
  return -1;
}

/**
 * The 32 windows-1252 code points that differ from latin-1, per the WHATWG
 * encoding spec's index. Node's TextDecoder('windows-1252') leaves the C1
 * range 0x80-0x9F unmapped on some ICU builds (observed: en dash byte 0x96
 * decoding to U+0096 on a fresh clone), so the mapping is applied explicitly
 * to keep retail INI strings identical across every runtime.
 */
const CP1252_C1: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Decode raw bytes as windows-1252, stripping a leading UTF-8 BOM. */
function decodeWindows1252(bytes: Uint8Array): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  const out = new Array<string>(bytes.length - start);
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i]!;
    out[i - start] = String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_C1[b - 0x80]! : b);
  }
  return out.join('');
}

/**
 * Convenience wrapper: parse Westwood INI content from text or windows-1252
 * bytes. Equivalent to {@link IniFile.parse}.
 */
export function parseIni(input: string | Uint8Array): IniFile {
  return IniFile.parse(input);
}
