import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Palette, ShpFile, parseIni, idFromName } from 'ra2-formats';
import { buildCursorAtlas, rasterizeUiFrame, rasterizeUiStrip } from '../src/ui.ts';
import { writeCameos, writeCursor, writeUiStrip } from '../src/node/ui.ts';
import { decodePng } from '../src/node/png.ts';
import { yrCameos, yrTabStrips } from '../src/games/yrUi.ts';
import { GameInstall } from '../src/node/install.ts';

function mix(files: Record<string, Uint8Array>): Uint8Array {
  const entries = Object.entries(files);
  const size = entries.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  const data = new Uint8Array(10 + entries.length * 12 + size),
    view = new DataView(data.buffer);
  view.setUint16(4, entries.length, true);
  view.setUint32(6, size, true);
  let offset = 0;
  entries.forEach(([name, bytes], i) => {
    const index = 10 + i * 12;
    view.setUint32(index, idFromName(name) >>> 0, true);
    view.setUint32(index + 4, offset, true);
    view.setUint32(index + 8, bytes.length, true);
    data.set(bytes, 10 + entries.length * 12 + offset);
    offset += bytes.length;
  });
  return data;
}

/** Two coloured cropped frames and one empty placeholder, with no original game files. */
function art() {
  const bytes = new Uint8Array(8 + 3 * 24 + 8),
    view = new DataView(bytes.buffer);
  [0, 60, 48, 3].forEach((v, i) => view.setUint16(i * 2, v, true));
  for (let i = 0; i < 2; i++) {
    const at = 8 + i * 24;
    [i + 1, 2, 2, 2].forEach((v, j) => view.setInt16(at + j * 2, v, true));
    view.setInt32(at + 8, 1, true);
    view.setInt32(at + 20, 80 + i * 4, true);
  }
  bytes.set([1, 0, 2, 1, 2, 1, 0, 2], 80);
  const rgb = new Uint8Array(768);
  rgb.set([63, 0, 0], 3);
  rgb.set([0, 63, 0], 6);
  return { bytes, shape: ShpFile.parse(bytes), palette: Palette.parse(rgb) };
}

function strings() {
  const tag = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const int = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const label = 'Name:UNIT',
    value = '合成單位';
  return new Uint8Array([
    ...tag(' FSC'),
    ...int(3),
    ...int(1),
    ...int(1),
    ...int(0),
    ...int(9),
    ...tag(' LBL'),
    ...int(1),
    ...int(label.length),
    ...tag(label),
    ...tag(' RTS'),
    ...int(value.length),
    ...[...value].flatMap((c) => {
      const n = c.charCodeAt(0) ^ 0xffff;
      return [n & 255, n >>> 8];
    }),
  ]);
}

describe('UI art extraction', () => {
  it('extracts tabs from nested side archives with MD per-file priority and Yuri reusing Soviet art', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-tabs-'));
    try {
      const { bytes, shape, palette } = art();
      const mdArt = bytes.slice();
      mdArt[80] = 2;
      const pal = new Uint8Array(768);
      pal.set([63, 0, 0], 3);
      pal.set([0, 63, 0], 6);
      const mdPal = pal.slice();
      mdPal.set([0, 0, 63], 3);
      const base = { 'sidebar.pal': pal, ...Object.fromEntries([0, 1, 2, 3].map((tab) => [`tab0${tab}.shp`, bytes])) };
      writeFileSync(join(root, 'ra2.mix'), mix({ 'sidec01.mix': mix(base), 'sidec02.mix': mix(base) }));
      writeFileSync(
        join(root, 'ra2md.mix'),
        mix({
          'sidec01md.mix': mix({ 'tab00.shp': mdArt }),
          'sidec02md.mix': mix({ 'sidebar.pal': mdPal }),
        }),
      );
      const install = GameInstall.open(root, 'temperate');
      const before = install.read('tab00.shp');
      const strips = yrTabStrips(install);
      expect(strips).toHaveLength(12);
      expect(install.read('tab00.shp')).toEqual(before);
      expect(strips.filter((s) => s.side === 0).map((s) => s.mix)).toEqual([
        'sidec01md.mix',
        'sidec01.mix',
        'sidec01.mix',
        'sidec01.mix',
      ]);
      expect(
        strips.filter((s) => s.side > 0).every((s) => s.mix === 'sidec02.mix' && s.paletteMix === 'sidec02md.mix'),
      ).toBe(true);
      expect(
        rasterizeUiStrip(strips[0]!.shape, strips[0]!.palette).data.slice((2 * 180 + 1) * 4, (2 * 180 + 2) * 4),
      ).toEqual(new Uint8Array([0, 255, 0, 255]));
      const out = join(root, 'strips');
      const printed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('../src/cli/ui.mts', import.meta.url)),
            'tabs',
            '--game',
            root,
            '--out',
            out,
          ],
          { encoding: 'utf8' },
        ),
      );
      expect(printed.strips).toBe(12);
      const index = JSON.parse(readFileSync(join(out, 'tabs.json'), 'utf8'));
      expect(index['0'][0]).toEqual({
        tab: 0,
        file: 'side0_tab00.png',
        mix: 'sidec01md.mix',
        paletteMix: 'sidec01.mix',
        frameSize: { width: 60, height: 48 },
        frameCount: 3,
      });
      const expected = rasterizeUiStrip(shape, palette);
      expect(decodePng(readFileSync(join(out, 'side0_tab01.png')))).toEqual(expected);
      const soviet = decodePng(readFileSync(join(out, 'side1_tab00.png')));
      expect(soviet).toEqual(decodePng(readFileSync(join(out, 'side2_tab00.png'))));
      expect([...soviet.data.slice((2 * 180 + 1) * 4, (2 * 180 + 2) * 4)]).toEqual([0, 0, 255, 255]);
      expect([...expected.data.slice((2 * 180 + 2) * 4, (2 * 180 + 3) * 4)]).toEqual([0, 0, 0, 0]);
      expect([...expected.data.slice(120 * 4, 124 * 4)]).toEqual(new Array(16).fill(0));
      expect(writeUiStrip({ out, file: 'custom.png', shape, palette })).toEqual({
        file: 'custom.png',
        frameSize: { width: 60, height: 48 },
        frameCount: 3,
      });
      expect(() => writeUiStrip({ out, file: '../escape.png', shape, palette })).toThrow(
        'Invalid UI strip output name',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not fall through a present but empty MD tab or borrow an unrelated global palette', () => {
    const { bytes } = art();
    expect(() => yrTabStrips({ readArchive: () => undefined })).toThrow('Missing sidebar.pal');
    expect(() =>
      yrTabStrips({
        readArchive: (archive, file) =>
          file === 'sidebar.pal' ? new Uint8Array(768) : archive.endsWith('md.mix') ? new Uint8Array() : bytes,
      }),
    ).toThrow();
  });
  it.each([true, false])(
    'retains YR registries/CSF/alternates and archive palette precedence with add-on palette present=%s',
    (addOnPalette) => {
      const { bytes, palette } = art();
      const rules = parseIni(
        '[VehicleTypes]\n1=BASE\n2=ADD\n[BASE]\nImage=BASEART\nUIName=Name:UNIT\nOwner=A,B\nTechLevel=2\n[ADD]\nOwner=A\nTechLevel=-1\n[SuperWeaponTypes]\n1=SW\n[SW]\nSidebarImage=SWICON\nName=Super\n',
      );
      const iniArt = parseIni('[BASEART]\nCameo=BASEICON\nAltCameo=ALTICON\n[ADD]\nCameo=ADDICON\n');
      const { definitions, source } = yrCameos({
        ini: (name) => (name === 'rulesmd.ini' ? rules : iniArt),
        read: (name) => (name === 'ra2md.csf' ? strings() : bytes),
        readArchive: (archive, name) =>
          archive === 'cameomd.mix' && ['addicon.shp', 'alticon.shp'].includes(name) ? bytes : undefined,
        has: (name) => name === 'cameomd.pal' && addOnPalette,
        palette: () => palette,
      });
      expect(definitions).toEqual([
        {
          id: 'BASE',
          kind: 'Vehicle',
          cameo: 'BASEICON',
          alt: 'ALTICON',
          name: '合成單位',
          uiName: 'Name:UNIT',
          owner: ['A', 'B'],
          techLevel: 2,
          buildable: true,
        },
        {
          id: 'ADD',
          kind: 'Vehicle',
          cameo: 'ADDICON',
          name: 'ADD',
          uiName: '',
          owner: ['A'],
          techLevel: -1,
          buildable: false,
        },
        {
          id: 'SW',
          kind: 'SuperWeapon',
          cameo: 'SWICON',
          name: 'Super',
          uiName: '',
          owner: [],
          techLevel: -1,
          buildable: true,
        },
      ]);
      expect(source.shape('baseicon')?.pal).toBe('cameo.pal');
      expect(source.shape('addicon')?.pal).toBe(addOnPalette ? 'cameomd.pal' : 'cameo.pal');
      expect(source.shape('alticon')?.pal).toBe(addOnPalette ? 'cameomd.pal' : 'cameo.pal');
      expect(source.shape('swicon')?.pal).toBe('cameo.pal');
    },
  );
  it('keeps SHP padding, palette colours and index-zero transparency for every cursor frame', () => {
    const { shape, palette } = art();
    const { image, index } = buildCursorAtlas(shape, palette);
    expect(index).toEqual({
      version: 1,
      frames: [
        { x: 0, y: 0, width: 60, height: 48 },
        { x: 60, y: 0, width: 60, height: 48 },
        { x: 0, y: 48, width: 60, height: 48 },
      ],
    });
    const pixel = (x: number, y: number) => [
      ...image.data.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4),
    ];
    expect(pixel(1, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 2)).toEqual([0, 0, 0, 0]);
    expect(pixel(1, 3)).toEqual([0, 255, 0, 255]);
    expect(pixel(62, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(1, 50)).toEqual([0, 0, 0, 0]);
    expect(rasterizeUiFrame(shape, palette, 0).data.length).toBe(60 * 48 * 4);
  });

  it('writes metadata/alternates and the atlas with caller-selected palettes, and round-trips RGBA PNGs', () => {
    const out = mkdtempSync(join(tmpdir(), 'ui-assets-'));
    try {
      const { shape, palette } = art();
      const source = {
        shape: (name: string) => (name === 'absent' ? undefined : { shape, palette, pal: `${name}.pal` }),
      };
      const definition = {
        id: 'TYPE',
        kind: 'Vehicle',
        cameo: 'TEST',
        alt: 'ALT',
        name: '合成圖片',
        uiName: 'Name:TYPE',
        owner: ['Owner'],
        techLevel: 1,
        buildable: true,
      };
      const entries = writeCameos({
        out,
        source,
        definitions: [definition, { ...definition, id: 'MISSING', cameo: 'absent' }],
        size: { width: 60, height: 48 },
      });
      expect(entries[0]).toEqual({
        ...definition,
        cameo: 'test',
        alt: 'alt',
        pal: 'test.pal',
        file: 'orig/test.png',
        w: 60,
        h: 48,
      });
      expect(entries[1]).toMatchObject({ pal: 'missing', file: '', w: 0, h: 0 });
      expect(JSON.parse(readFileSync(join(out, 'cameos.json'), 'utf8'))).toEqual(entries);
      for (const file of ['test', 'alt']) {
        const png = decodePng(readFileSync(join(out, 'orig', `${file}.png`)));
        expect(png).toEqual(rasterizeUiFrame(shape, palette, 0));
      }
      const types = [{ startFrame: 0, frameCount: 2 }];
      expect(writeCursor({ out: join(out, 'cursor'), shape, palette, types })).toEqual({
        frames: 3,
        width: 120,
        height: 96,
      });
      expect(JSON.parse(readFileSync(join(out, 'cursor/cursor.json'), 'utf8')).types).toEqual(types);
      expect(decodePng(readFileSync(join(out, 'cursor/cursor.png')))).toEqual(buildCursorAtlas(shape, palette).image);
      expect(() => writeCameos({ out, source, definitions: [{ ...definition, cameo: '../escape' }] })).toThrow(
        'Invalid cameo output name',
      );
      const clipped = writeCameos({ out, source, definitions: [definition], size: { width: 2, height: 3 } });
      expect(clipped[0]).toMatchObject({ w: 2, h: 3 });
      const slot = decodePng(readFileSync(join(out, 'orig/test.png')));
      expect([...slot.data.slice(20, 24)]).toEqual([255, 0, 0, 255]);
      const padded = rasterizeUiFrame(shape, palette, 0, { width: 64, height: 48 });
      expect(padded.data.length).toBe(64 * 48 * 4);
      expect([...padded.data.slice(60 * 4, 64 * 4)]).toEqual(new Array(16).fill(0));
      expect(() => rasterizeUiFrame(shape, palette, 0, { width: 0, height: 1 })).toThrow('Invalid UI shape bounds');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
