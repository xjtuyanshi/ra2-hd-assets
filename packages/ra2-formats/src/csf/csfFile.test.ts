import { describe, expect, it } from 'vitest';
import { CsfFile, CsfLanguage } from './csfFile.js';

// --- Synthetic CSF encoder used only by these tests -------------------------
// Builds byte-exact CSF payloads (including the per-16-bit-unit inversion) so
// the parser is exercised against constructed specimens, never real assets.

interface EncValue {
  value: string;
  /** ASCII extra payload; when present the value is written as 'WRTS'. */
  extra?: string;
}
interface EncLabel {
  name: string;
  values: EncValue[];
}

function tagBytes(tag: string): number[] {
  return [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
}

function int32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function encode(labels: EncLabel[], language = CsfLanguage.EnglishUS, version = 3): Uint8Array {
  const bytes: number[] = [];
  const stringCount = labels.reduce((n, l) => n + l.values.length, 0);
  // Header: ' FSC', version, labelCount, stringCount, unused, language.
  bytes.push(...tagBytes(' FSC'));
  bytes.push(...int32(version));
  bytes.push(...int32(labels.length));
  bytes.push(...int32(stringCount));
  bytes.push(...int32(0));
  bytes.push(...int32(language));

  for (const label of labels) {
    bytes.push(...tagBytes(' LBL'));
    bytes.push(...int32(label.values.length));
    const nameBytes = [...label.name].map((c) => c.charCodeAt(0));
    bytes.push(...int32(nameBytes.length));
    bytes.push(...nameBytes);

    for (const v of label.values) {
      const hasExtra = v.extra !== undefined;
      bytes.push(...tagBytes(hasExtra ? 'WRTS' : ' RTS'));
      // UTF-16LE code units, each bitwise-inverted. Encode by 16-bit code
      // units (charCodeAt), which is exactly what CSF stores on disk.
      const units: number[] = [];
      const codeUnits: number[] = [];
      for (let i = 0; i < v.value.length; i++) codeUnits.push(v.value.charCodeAt(i));
      bytes.push(...int32(codeUnits.length));
      for (const u of codeUnits) {
        const inv = u ^ 0xffff;
        units.push(inv & 0xff, (inv >> 8) & 0xff);
      }
      bytes.push(...units);
      if (hasExtra) {
        const extraBytes = [...v.extra!].map((c) => c.charCodeAt(0));
        bytes.push(...int32(extraBytes.length));
        bytes.push(...extraBytes);
      }
    }
  }
  return new Uint8Array(bytes);
}

describe('CsfFile', () => {
  it('parses the header fields', () => {
    const csf = CsfFile.parse(encode([{ name: 'A', values: [{ value: 'x' }] }], CsfLanguage.German, 3));
    expect(csf.header.version).toBe(3);
    expect(csf.header.labelCount).toBe(1);
    expect(csf.header.stringCount).toBe(1);
    expect(csf.header.language).toBe(CsfLanguage.German);
  });

  it('decodes an inverted UTF-16 value', () => {
    const csf = CsfFile.parse(encode([{ name: 'Name:E1', values: [{ value: 'Conscript' }] }]));
    expect(csf.get('Name:E1')).toBe('Conscript');
    expect(csf.labelCount).toBe(1);
  });

  it('looks up labels case-insensitively', () => {
    const csf = CsfFile.parse(encode([{ name: 'GUI:Options', values: [{ value: 'Options' }] }]));
    expect(csf.get('gui:options')).toBe('Options');
    expect(csf.get('GUI:OPTIONS')).toBe('Options');
    expect(csf.getLabel('Gui:Options')?.name).toBe('GUI:Options');
    expect(csf.has('gUi:OpTiOnS')).toBe(true);
    expect(csf.has('missing')).toBe(false);
    expect(csf.get('missing')).toBeUndefined();
  });

  it('handles multi-value labels', () => {
    const csf = CsfFile.parse(
      encode([{ name: 'Multi', values: [{ value: 'first' }, { value: 'second' }, { value: 'third' }] }]),
    );
    const label = csf.getLabel('multi');
    expect(label?.values.map((v) => v.value)).toEqual(['first', 'second', 'third']);
    // get() returns the first value.
    expect(csf.get('Multi')).toBe('first');
    expect(csf.header.stringCount).toBe(3);
  });

  it('reads WRTS values with extra ASCII data', () => {
    const csf = CsfFile.parse(
      encode([
        { name: 'Speech:Ready', values: [{ value: 'Ready', extra: 'ready.wav' }] },
        { name: 'Plain', values: [{ value: 'plain' }] },
      ]),
    );
    const withExtra = csf.getLabel('speech:ready');
    expect(withExtra?.values[0]?.value).toBe('Ready');
    expect(withExtra?.values[0]?.extra).toBe('ready.wav');
    // A plain ' RTS' value must not synthesize an extra.
    expect(csf.getLabel('plain')?.values[0]?.extra).toBeUndefined();
  });

  it('handles empty strings and empty extra payloads', () => {
    const csf = CsfFile.parse(
      encode([
        { name: 'Empty', values: [{ value: '' }] },
        { name: 'EmptyW', values: [{ value: '', extra: '' }] },
      ]),
    );
    expect(csf.get('Empty')).toBe('');
    const emptyW = csf.getLabel('emptyw');
    expect(emptyW?.values[0]?.value).toBe('');
    expect(emptyW?.values[0]?.extra).toBe('');
  });

  it('preserves non-ASCII UTF-16 characters through inversion', () => {
    const text = 'Über café — ЯР 日本';
    const csf = CsfFile.parse(encode([{ name: 'Unicode', values: [{ value: text }] }]));
    expect(csf.get('Unicode')).toBe(text);
  });

  it('tolerates padding bytes before a label tag', () => {
    const good = encode([
      { name: 'A', values: [{ value: 'a' }] },
      { name: 'B', values: [{ value: 'b' }] },
    ]);
    // Insert two stray padding bytes right after the header (before ' LBL').
    const injected = new Uint8Array(good.length + 2);
    injected.set(good.subarray(0, 24), 0);
    injected.set([0, 0], 24);
    injected.set(good.subarray(24), 26);
    const csf = CsfFile.parse(injected);
    expect(csf.get('A')).toBe('a');
    expect(csf.get('B')).toBe('b');
  });

  it('throws on a missing FSC magic', () => {
    expect(() => CsfFile.parse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(RangeError);
  });

  it('is tolerant of truncation by default but strict when asked', () => {
    const full = encode([
      { name: 'A', values: [{ value: 'aa' }] },
      { name: 'B', values: [{ value: 'bb' }] },
    ]);
    const truncated = full.subarray(0, full.length - 6);
    // Tolerant (default): keeps whatever fully parsed, no throw.
    const tolerant = CsfFile.parse(truncated);
    expect(tolerant.labelCount).toBeLessThan(2);
    // Strict: throws.
    expect(() => CsfFile.parse(truncated, { tolerant: false })).toThrow(RangeError);
  });

  it('reports duplicate labels with last-write-wins for lookup', () => {
    const csf = CsfFile.parse(
      encode([
        { name: 'Dup', values: [{ value: 'old' }] },
        { name: 'dup', values: [{ value: 'new' }] },
      ]),
    );
    expect(csf.labelCount).toBe(2);
    expect(csf.get('DUP')).toBe('new');
  });
});
