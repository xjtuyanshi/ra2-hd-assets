import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IniFile, parseIni } from './iniFile.js';

describe('IniFile — Westwood dialect parsing', () => {
  it('parses sections and key=value pairs', () => {
    const ini = parseIni('[General]\nName=Vanguard\nBuild=42\n');
    const s = ini.getSection('General');
    expect(s).toBeDefined();
    expect(s!.getString('Name')).toBe('Vanguard');
    expect(s!.getInt('Build')).toBe(42);
  });

  it('is case-insensitive on section and key lookup while preserving original case', () => {
    const ini = parseIni('[MixedCase]\nHitPoints=100\n');
    expect(ini.hasSection('mixedcase')).toBe(true);
    expect(ini.hasSection('MIXEDCASE')).toBe(true);
    const s = ini.getSection('MIXEDcase')!;
    expect(s.name).toBe('MixedCase');
    expect(s.getInt('hitpoints')).toBe(100);
    expect(s.getInt('HITPOINTS')).toBe(100);
    // Original-case section name preserved in listing.
    expect(ini.sectionNames()).toEqual(['MixedCase']);
  });

  it('handles full-line and trailing semicolon comments', () => {
    const text = [
      '; a full-line comment',
      '[Debug]',
      'AllowTunnels=yes ; trailing comment stripped',
      ';DisabledKey=no',
      'Speed=44;-6',
    ].join('\n');
    const ini = parseIni(text);
    const s = ini.getSection('Debug')!;
    expect(s.getBool('AllowTunnels')).toBe(true);
    expect(s.has('DisabledKey')).toBe(false);
    // Trailing comment after value with no space is still stripped.
    expect(s.getString('Speed')).toBe('44');
    expect(s.getInt('Speed')).toBe(44);
  });

  it('trims surrounding whitespace on keys and values', () => {
    const ini = parseIni('[S]\n   Key   =   value with spaces   \n');
    const s = ini.getSection('S')!;
    expect(s.getString('Key')).toBe('value with spaces');
    expect(s.has('key')).toBe(true);
  });

  it('trims whitespace inside section header brackets', () => {
    const ini = parseIni('[  Spaced Name  ]\nk=v\n');
    expect(ini.hasSection('Spaced Name')).toBe(true);
    expect(ini.getSection('spaced name')!.name).toBe('Spaced Name');
  });

  describe('duplicate handling', () => {
    it('merges duplicate sections and lets last value win for a duplicate key', () => {
      const text = ['[Unit]', 'Speed=5', 'Armor=heavy', '[Unit]', 'Speed=9'].join('\n');
      const ini = parseIni(text);
      expect(ini.sectionCount).toBe(1);
      const s = ini.getSection('Unit')!;
      expect(s.getInt('Speed')).toBe(9); // last wins
      expect(s.getString('Armor')).toBe('heavy'); // preserved across merge
    });

    it('preserves every ordered raw entry for list-registry sections', () => {
      // Duplicate keys: last-wins map collapses them, but entries keep all.
      const text = ['[InfantryTypes]', '0=E1', '1=E2', '2=E1'].join('\n');
      const ini = parseIni(text);
      const s = ini.getSection('InfantryTypes')!;
      // Ordered raw entries keep the full list, including the repeated value.
      expect(s.entries.map((e) => e.value)).toEqual(['E1', 'E2', 'E1']);
      // readRegistry returns values in file order.
      expect(ini.readRegistry('InfantryTypes')).toEqual(['E1', 'E2', 'E1']);
    });

    it('keeps ordered entries even when duplicate keys collide in the map', () => {
      const text = ['[List]', '0=A', '0=B', '0=C'].join('\n');
      const ini = parseIni(text);
      const s = ini.getSection('List')!;
      // Last wins in the map.
      expect(s.getString('0')).toBe('C');
      expect(s.size).toBe(1);
      // But the ordered registry preserves all three lines.
      expect(ini.readRegistry('List')).toEqual(['A', 'B', 'C']);
    });
  });

  describe('typed accessors', () => {
    it('getBool understands yes/no/true/false/1/0/on/off case-insensitively', () => {
      const text = [
        '[B]',
        'a=Yes',
        'b=no',
        'c=TRUE',
        'd=False',
        'e=1',
        'f=0',
        'g=ON',
        'h=off',
        'i=maybe',
      ].join('\n');
      const s = parseIni(text).getSection('B')!;
      expect(s.getBool('a')).toBe(true);
      expect(s.getBool('b')).toBe(false);
      expect(s.getBool('c')).toBe(true);
      expect(s.getBool('d')).toBe(false);
      expect(s.getBool('e')).toBe(true);
      expect(s.getBool('f')).toBe(false);
      expect(s.getBool('g')).toBe(true);
      expect(s.getBool('h')).toBe(false);
      // Unrecognised -> fallback.
      expect(s.getBool('i', true)).toBe(true);
      expect(s.getBool('i', false)).toBe(false);
    });

    it('getInt parses leading signed integers and ignores trailing junk', () => {
      const text = ['[N]', 'a=42', 'b=-7', 'c=+3', 'd=100%', 'e=notanumber'].join('\n');
      const s = parseIni(text).getSection('N')!;
      expect(s.getInt('a')).toBe(42);
      expect(s.getInt('b')).toBe(-7);
      expect(s.getInt('c')).toBe(3);
      expect(s.getInt('d')).toBe(100);
      expect(s.getInt('e', 99)).toBe(99);
    });

    it('getNumberRaw returns the unparsed string', () => {
      const s = parseIni('[N]\nCost=1.5\n').getSection('N')!;
      expect(s.getNumberRaw('Cost')).toBe('1.5');
      expect(s.getInt('Cost')).toBe(1); // leading int only
    });

    it('getList splits on commas and trims, dropping empties', () => {
      const text = ['[L]', 'Prereq= a , b ,c,', 'Empty=', 'Single=x'].join('\n');
      const s = parseIni(text).getSection('L')!;
      expect(s.getList('Prereq')).toEqual(['a', 'b', 'c']);
      expect(s.getList('Empty', ['def'])).toEqual(['def']);
      expect(s.getList('Single')).toEqual(['x']);
    });
  });

  describe('defaults for missing section / key', () => {
    it('returns undefined for a missing section', () => {
      const ini = parseIni('[X]\nk=v\n');
      expect(ini.getSection('Nope')).toBeUndefined();
      expect(ini.hasSection('Nope')).toBe(false);
    });

    it('returns supplied defaults for a missing key', () => {
      const s = parseIni('[X]\nk=v\n').getSection('X')!;
      expect(s.getString('missing', 'fallback')).toBe('fallback');
      expect(s.getInt('missing', 7)).toBe(7);
      expect(s.getBool('missing', true)).toBe(true);
      expect(s.getList('missing', ['a'])).toEqual(['a']);
      expect(s.getNumberRaw('missing', '0')).toBe('0');
      expect(s.getString('missing')).toBe('');
    });

    it('readRegistry returns [] for a missing section', () => {
      expect(parseIni('[X]\nk=v\n').readRegistry('Nope')).toEqual([]);
    });
  });

  describe('line endings', () => {
    it('parses CRLF the same as LF', () => {
      const lf = parseIni('[S]\na=1\nb=2\n');
      const crlf = parseIni('[S]\r\na=1\r\nb=2\r\n');
      const slf = lf.getSection('S')!;
      const scrlf = crlf.getSection('S')!;
      expect(scrlf.getInt('a')).toBe(slf.getInt('a'));
      expect(scrlf.getInt('b')).toBe(2);
      // No stray CR left in values.
      expect(scrlf.getString('b')).toBe('2');
    });

    it('handles a lone final line with no trailing newline', () => {
      const s = parseIni('[S]\nlast=value').getSection('S')!;
      expect(s.getString('last')).toBe('value');
    });
  });

  describe('byte input', () => {
    it('decodes windows-1252 bytes (latin-1-ish high bytes)', () => {
      // 0xE9 = 'é', 0xB4 = acute accent '´', 0x96 = en dash '–' in cp1252.
      const bytes = new Uint8Array([
        0x5b, 0x53, 0x5d, 0x0a, // "[S]\n"
        0x6e, 0x3d, 0xe9, 0xb4, 0x96, 0x0a, // "n=" + é ´ – + \n
      ]);
      const s = parseIni(bytes).getSection('S')!;
      expect(s.getString('n')).toBe('é´–');
    });

    it('maps the full cp1252 C1 range explicitly (independent of the runtime ICU)', () => {
      // Node's TextDecoder('windows-1252') passes 0x80-0x9F through unmapped on
      // some ICU builds, so the decoder carries its own WHATWG table. Euro, curly
      // quotes, em dash, trademark and the undefined-but-passthrough 0x81 must
      // all decode identically on every runtime (OSS-audit F1: a fresh clone's
      // portable suite went RED purely from the host ICU version).
      const bytes = new Uint8Array([
        0x5b, 0x53, 0x5d, 0x0a, // "[S]\n"
        0x6e, 0x3d, 0x80, 0x91, 0x92, 0x97, 0x99, 0x81, 0x0a, // n= € ' ' — ™ \x81
      ]);
      const s = parseIni(bytes).getSection('S')!;
      expect(s.getString('n')).toBe('€‘’—™\u0081');
    });

    it('strips a leading UTF-8 BOM from byte input', () => {
      const bytes = new Uint8Array([
        0xef, 0xbb, 0xbf, // UTF-8 BOM
        0x5b, 0x53, 0x5d, 0x0a, // "[S]\n"
        0x6b, 0x3d, 0x31, // "k=1"
      ]);
      const ini = parseIni(bytes);
      expect(ini.hasSection('S')).toBe(true);
      expect(ini.getSection('S')!.getInt('k')).toBe(1);
    });

    it('strips a leading U+FEFF from string input', () => {
      const ini = parseIni('﻿[S]\nk=1\n');
      expect(ini.hasSection('S')).toBe(true);
    });
  });

  it('ignores keys that appear before the first section header', () => {
    const ini = parseIni('orphan=1\n[S]\nk=2\n');
    expect(ini.sectionCount).toBe(1);
    expect(ini.getSection('S')!.getInt('k')).toBe(2);
  });

  it('does not interpret Ares/Phobos += or inheritance in v1', () => {
    // '+=' is parsed as an ordinary key literally named '+'.
    const ini = parseIni('[Types]\n+=NewThing\n');
    const s = ini.getSection('Types')!;
    expect(s.has('+')).toBe(true);
    expect(s.getString('+')).toBe('NewThing');
    // 'Section:Base' inheritance syntax is treated as a literal section name.
    const inh = parseIni('[Child]:[Parent]\nk=v\n');
    // The ']' after 'Child' closes the bracket; name is 'Child'.
    expect(inh.hasSection('Child')).toBe(true);
    expect(inh.hasSection('Parent')).toBe(false);
  });
});

const RA2_DIR = process.env.RA2_DIR;

describe.skipIf(!RA2_DIR)('IniFile — integration against real FAData.ini', () => {
  it('parses FinalAlert2/FAData.ini into a plausible section set', () => {
    const path = join(RA2_DIR!, 'FinalAlert2', 'FAData.ini');
    const bytes = readFileSync(path);
    const ini = IniFile.parse(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));

    // A real Westwood-dialect data file has many sections.
    expect(ini.sectionCount).toBeGreaterThan(50);

    // Spot-check known sections exist despite the leading UTF-8 BOM.
    expect(ini.hasSection('Debug')).toBe(true);
    expect(ini.hasSection('Rename')).toBe(true);

    // Spot-check known keys / values.
    const debug = ini.getSection('Debug')!;
    expect(debug.getBool('AllowTunnels')).toBe(true);

    const rename = ini.getSection('Rename')!;
    expect(rename.getString('ENGINEER')).toBe('N_ENGINEER');

    // A trailing-comment value (`GTGCANY=44;-6`) must strip to just the number.
    const turrets = ini.getSection('BuildingVoxelTurretsRA2OLD')!;
    expect(turrets.getInt('GTGCANY')).toBe(44);
  });
});
