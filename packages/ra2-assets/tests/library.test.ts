/** Type library: sequences, colour scheme order, paged atlases, art-name resolution and type records (synthetic data). */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Palette, ShpFile, parseIni, type IniFile } from 'ra2-formats';
import { animTimingArt, buildingLayerArt, parseInfantrySequences, sequenceFrame, facingFrame } from '../src/art.ts';
import { packShelves, packShelvesPaged } from '../src/atlas.ts';
import { coordDrawOffset } from '../src/iso.ts';
import { colorSchemeSlots } from '../src/remap.ts';
import { THEATERS } from '../src/theater.ts';
import { ArtSource, packSprites, type InstallView } from '../src/node/artSource.ts';
import {
  appendOverlayLibrary,
  appendSmudgeLibrary,
  collectOverlayLibrary,
  collectSmudgeLibrary,
  collectTypeLibrary,
  readLibrary,
} from '../src/node/library.ts';
import type { TypeLibrary } from '../src/library.ts';

describe('infantry sequences', () => {
  const entries = [
    { key: 'Ready', value: '0,1,1' },
    { key: 'Walk', value: '8,6,6' },
    { key: 'Idle1', value: '56,15,0,S' },
    { key: 'Cheer', value: '293,8,0,e' },
    { key: 'Idle2Sounds', value: '9 TrexDie' },
    { key: 'Prone', value: '86' },
    { key: 'Walk', value: '10,6,6' },
  ];

  it('parses every numeric entry, keeps direction letters and skips sound lists', () => {
    const s = parseInfantrySequences(entries);
    expect(Object.keys(s).sort()).toEqual(['Cheer', 'Idle1', 'Prone', 'Ready', 'Walk']);
    expect(s['Ready']).toEqual({ start: 0, count: 1, facingMultiplier: 1 });
    expect(s['Idle1']).toEqual({ start: 56, count: 15, facingMultiplier: 0, facing: 'S' });
    expect(s['Cheer']!.facing).toBe('E');
    expect(s['Prone']).toEqual({ start: 86, count: 1, facingMultiplier: 0 });
    // A repeated key keeps its last value, like the INI.
    expect(s['Walk']).toEqual({ start: 10, count: 6, facingMultiplier: 6 });
  });

  it('picks frame = start + facing index * multiplier + step % count', () => {
    const s = parseInfantrySequences(entries);
    // Facing 0 (north) is SHP direction 7 with facingFrame's convention.
    expect(sequenceFrame(s['Ready']!, 0, 5)).toBe(facingFrame(0, 8));
    expect(sequenceFrame(s['Walk']!, 64, 0)).toBe(10 + facingFrame(64, 8) * 6);
    expect(sequenceFrame(s['Walk']!, 64, 7)).toBe(10 + facingFrame(64, 8) * 6 + 1);
    // Facing-independent sequences ignore the facing.
    expect(sequenceFrame(s['Idle1']!, 0, 3)).toBe(59);
    expect(sequenceFrame(s['Idle1']!, 160, 3)).toBe(59);
    expect(sequenceFrame(s['Idle1']!, 0, -1)).toBe(70);
  });

  it('preserves the exact raw-facing sector boundaries for infantry art without changing legacy byte callers', () => {
    const ready = { start: 0, count: 1, facingMultiplier: 1 };
    const boundaries = [
      [3072, 7, 6],
      [11264, 6, 5],
      [19456, 5, 4],
      [27648, 4, 3],
      [35840, 3, 2],
      [44032, 2, 1],
      [52224, 1, 0],
      [60416, 0, 7],
    ];
    for (const [raw, before, after] of boundaries) {
      expect(sequenceFrame(ready, 0, 0, raw! - 1)).toBe(before);
      expect(sequenceFrame(ready, 0, 0, raw)).toBe(after);
      expect(sequenceFrame(ready, 0, 0, raw! + 1)).toBe(after);
    }
    expect(sequenceFrame(ready, 12, 0)).toBe(7);
    expect(sequenceFrame(ready, 12, 0, 12 * 256)).toBe(6);
    expect(sequenceFrame(ready, 0, 0, 65536)).toBe(7);
    expect(sequenceFrame(ready, 0, 0, -1)).toBe(7);
  });

  it('applies raw directions to sequence frames and leaves fixed Facing behavior to the supplied pose', () => {
    const walk = { start: 10, count: 6, facingMultiplier: 6, facing: 'E' };
    expect(sequenceFrame(walk, 0, 7, 3071)).toBe(53);
    expect(sequenceFrame(walk, 0, 7, 3072)).toBe(47);
    const idle = { start: 56, count: 15, facingMultiplier: 0, facing: 'S' };
    expect(sequenceFrame(idle, 0, 3, 3072)).toBe(59);
  });
});

describe('colour scheme order', () => {
  it('makes two consecutive schemes per [Colors] entry in file order', () => {
    const slots = colorSchemeSlots([
      { key: 'LightGold', value: '25,255,255' },
      { key: 'Gold', value: '43,239,255' },
      { key: 'Grey', value: '0,0,131' },
    ]);
    expect(slots.map((s) => `${s.name}/${s.copy}`)).toEqual([
      'LightGold/0',
      'LightGold/1',
      'Gold/0',
      'Gold/1',
      'Grey/0',
      'Grey/1',
    ]);
    expect(slots[3]!.hsv).toEqual([43, 239, 255]);
    // Houses use the odd copy: entry k -> 2k + 1.
    expect(slots.findIndex((s) => s.name === 'Grey' && s.copy === 1)).toBe(5);
  });

  it('keeps unparsable values in place and repeated keys at their first position', () => {
    const slots = colorSchemeSlots([
      { key: 'A', value: '1,2,3' },
      { key: 'Broken', value: 'x' },
      { key: 'a', value: '9,9,9' },
      { key: 'C', value: '4,5,6' },
    ]);
    expect(slots.map((s) => s.name)).toEqual(['A', 'A', 'Broken', 'Broken', 'C', 'C']);
    expect(slots[0]!.hsv).toEqual([9, 9, 9]);
    expect(slots[2]!.hsv).toEqual([0, 0, 0]);
  });
});

describe('paged atlas packing', () => {
  const apart = (p: { x: number; y: number; w: number; h: number }, q: typeof p): boolean =>
    p.x + p.w + 1 <= q.x || q.x + q.w + 1 <= p.x || p.y + p.h + 1 <= q.y || q.y + q.h + 1 <= p.y;

  it('equals packShelves when everything fits one page', () => {
    const sizes = Array.from({ length: 50 }, (_, i) => ({ w: 5 + (i % 7) * 3, h: 4 + (i % 5) * 2 }));
    const one = packShelves(sizes, 1);
    const paged = packShelvesPaged(sizes, 1, 4096, 4096);
    expect(paged.pages).toEqual([{ width: one.width, height: one.height }]);
    expect(paged.rects.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(one.rects);
  });

  it('splits over pages within the limit without overlaps', () => {
    const sizes = Array.from({ length: 300 }, (_, i) => ({ w: 10 + ((i * 37) % 50), h: 8 + ((i * 53) % 40) }));
    const res = packShelvesPaged(sizes, 1, 128, 128);
    expect(res.pages.length).toBeGreaterThan(1);
    for (const p of res.pages) {
      expect(p.width).toBe(128);
      expect(p.height).toBeLessThanOrEqual(128);
    }
    res.rects.forEach((r, i) => {
      expect([r.w, r.h]).toEqual([sizes[i]!.w, sizes[i]!.h]);
      expect(r.x + r.w).toBeLessThanOrEqual(127);
      expect(r.y + r.h).toBeLessThanOrEqual(res.pages[r.page]!.height - 1);
    });
    for (let a = 0; a < res.rects.length; a++)
      for (let b = a + 1; b < res.rects.length; b++)
        if (res.rects[a]!.page === res.rects[b]!.page) expect(apart(res.rects[a]!, res.rects[b]!)).toBe(true);
  });

  it('keeps groups together', () => {
    // 12 groups of 10 rects; each group fits well within one 128x128 page.
    const sizes = Array.from({ length: 120 }, (_, i) => ({ w: 20 + (i % 3) * 5, h: 12 + (i % 4) * 3 }));
    const groups = sizes.map((_, i) => Math.floor(i / 10));
    const res = packShelvesPaged(sizes, 1, 128, 128, groups);
    const pagesPerGroup = new Map<number, Set<number>>();
    res.rects.forEach((r, i) => {
      const s = pagesPerGroup.get(groups[i]!) ?? new Set<number>();
      s.add(r.page);
      pagesPerGroup.set(groups[i]!, s);
    });
    for (const s of pagesPerGroup.values()) expect(s.size).toBeLessThanOrEqual(2);
  });

  it('rejects a rect larger than a page', () => {
    expect(() => packShelvesPaged([{ w: 200, h: 10 }], 1, 128, 128)).toThrow(RangeError);
  });
});

describe('library draw offsets and layer art', () => {
  it('places buildings from the centre of their top-left cell, mobile objects at their coordinate', () => {
    expect(coordDrawOffset('building')).toEqual([0, -15]);
    expect(coordDrawOffset('vehicle')).toEqual([0, 0]);
    expect(coordDrawOffset('infantry')).toEqual([0, 0]);
    expect(coordDrawOffset('aircraft')).toEqual([0, 0]);
  });

  it('reads building layer companions and anim timing', () => {
    const ini = parseIni(
      '[B]\nActiveAnim=B_A\nActiveAnimDamaged=B_AD\nActiveAnimX=3\nActiveAnimZAdjust=-20\nActiveAnimYSort=100\n' +
        'ActiveAnimPowered=no\nIdleAnim=B_I\n[B_A]\nLoopStart=2\nLoopEnd=9\nRate=200\nShadow=yes\n',
    );
    const b = ini.getSection('B');
    expect(buildingLayerArt(b, 'ActiveAnim')).toEqual({
      key: 'ActiveAnim',
      anim: 'B_A',
      damaged: 'B_AD',
      offset: [3, 0],
      zAdjust: -20,
      ySort: 100,
      powered: false,
    });
    expect(buildingLayerArt(b, 'IdleAnim')).toEqual({ key: 'IdleAnim', anim: 'B_I' });
    expect(buildingLayerArt(b, 'SuperAnim')).toBeUndefined();
    expect(animTimingArt(ini.getSection('B_A'))).toEqual({ loopStart: 2, loopEnd: 9, rate: 200, shadow: true });
  });
});

// ---------------------------------------------------------------- synthetic install

/** A raw (uncompressed) SHP(TS) with solid-colour frames. */
function makeShp(canvas: [number, number], frames: { x: number; y: number; w: number; h: number; fill: number }[]) {
  const head = 8 + 24 * frames.length;
  const out = new Uint8Array(head + frames.reduce((n, f) => n + f.w * f.h, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(2, canvas[0], true);
  dv.setUint16(4, canvas[1], true);
  dv.setUint16(6, frames.length, true);
  let off = head;
  frames.forEach((f, i) => {
    const p = 8 + 24 * i;
    dv.setInt16(p, f.x, true);
    dv.setInt16(p + 2, f.y, true);
    dv.setInt16(p + 4, f.w, true);
    dv.setInt16(p + 6, f.h, true);
    dv.setInt32(p + 20, f.w * f.h ? off : 0, true);
    out.fill(f.fill, off, off + f.w * f.h);
    off += f.w * f.h;
  });
  return out;
}

/** Body frames with index 40 plus a matching shadow half (index 1). */
const bodyAndShadow = (n: number, w = 4, h = 3) =>
  makeShp(
    [20, 16],
    [
      ...Array.from({ length: n }, (_, i) => ({ x: 2 + i, y: 3, w, h, fill: 40 })),
      ...Array.from({ length: n }, (_, i) => ({ x: 5 + i, y: 6, w, h, fill: 1 })),
    ],
  );

function fakeInstall(files: Record<string, Uint8Array>, inis: Record<string, string>): InstallView {
  const parsed = new Map<string, IniFile>(Object.entries(inis).map(([k, v]) => [k.toLowerCase(), parseIni(v)]));
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i >> 2, i >> 2, i >> 2], i * 3);
  for (let i = 0; i < 16; i++) pal.set([63 - i * 4, 0, 0], (16 + i) * 3);
  const have = (n: string): boolean => n.toLowerCase() in files || n.toLowerCase().endsWith('.pal');
  return {
    has: have,
    ini: (n: string) => {
      const ini = parsed.get(n.toLowerCase());
      if (!ini) throw new Error(`${n} missing`);
      return ini;
    },
    shp: (n: string) => (files[n.toLowerCase()] ? ShpFile.parse(files[n.toLowerCase()]!) : undefined),
    palette: () => Palette.parse(pal),
    vxl: () => undefined,
    hva: () => undefined,
  } as unknown as InstallView;
}

const RULES = `
[BuildingTypes]
0=GAPOWR
1=GAYARD
2=CAFLAG
3=GHOST
[InfantryTypes]
0=E1
1=DNOA
[VehicleTypes]
0=DRON
1=HTNK
[AircraftTypes]
[Colors]
Gold=43,239,255
DarkRed=0,230,255
[AudioVisual]
ConditionYellow=50%
ConditionRed=25%
[GAPOWR]
Strength=750
[GAYARD]
Strength=1500
[CAFLAG]
InvisibleInGame=yes
[E1]
[DNOA]
[DRON]
[HTNK]
Turret=yes
`;

const ART = `
[GAPOWR]
Foundation=2x2
NewTheater=yes
ActiveAnim=GAPOWR_A
ActiveAnimDamaged=GAPOWR_AD
ActiveAnimYSort=10
BibShape=GAPOWRBB
Buildup=GAPOWRMK
[GAPOWR_A]
LoopStart=0
LoopEnd=2
[GAYARD]
Foundation=4x4
[CAFLAG]
NewTheater=no
Remapable=no
[E1]
Sequence=ConSequence
[DNOA]
Sequence=ConSequence
Remapable=no
[ConSequence]
Ready=0,1,1
Walk=8,6,6
Idle1=56,15,0,S
[DRON]
Voxel=no
WalkFrames=6
[HTNK]
Voxel=yes
`;

describe('art name resolution', () => {
  const inst = fakeInstall({}, { 'rulesmd.ini': RULES, 'artmd.ini': ART });
  const src = new ArtSource(inst, THEATERS.temperate, () => {});

  it('applies the theater letter to every prefix-pattern name, whatever NewTheater says', () => {
    expect(src.shpCandidates('GAPOWR', src.artOf('GAPOWR').sec)).toEqual(['gtpowr.shp', 'ggpowr.shp', 'gapowr.shp']);
    // No NewTheater key (the stock shipyards) and NewTheater=no (country flags) still get the substitution.
    expect(src.shpCandidates('GAYARD', src.artOf('GAYARD').sec)[1]).toBe('ggyard.shp');
    expect(src.shpCandidates('CAFLAG', src.artOf('CAFLAG').sec)[0]).toBe('ctflag.shp');
    expect(new ArtSource(inst, THEATERS.snow, () => {}).shpCandidates('CAFLAG', undefined)[0]).toBe('caflag.shp');
    expect(src.shpCandidates('E1', src.artOf('E1').sec)).toEqual(['e1.shp']);
  });

  it('follows rules Image= to the art section', () => {
    const i2 = fakeInstall(
      {},
      { 'rulesmd.ini': '[APOC]\nImage=MTNK\n', 'artmd.ini': '[MTNK]\nVoxel=yes\nImage=GTNK\n' },
    );
    const s2 = new ArtSource(i2, THEATERS.temperate, () => {});
    expect(s2.artOf('APOC')).toMatchObject({ image: 'GTNK', section: 'MTNK' });
    expect(s2.artOf('NOART')).toMatchObject({ image: 'NOART', section: 'NOART', sec: undefined });
  });
});

describe('type library records', () => {
  const files = {
    'gtpowr.shp': bodyAndShadow(3),
    'ggpowr_a.shp': bodyAndShadow(3, 2, 2),
    'ggpowr_ad.shp': bodyAndShadow(3, 2, 2),
    'ggpowrbb.shp': makeShp([20, 16], [{ x: 0, y: 8, w: 20, h: 8, fill: 50 }]),
    'gtpowrmk.shp': bodyAndShadow(5),
    'ggyard.shp': bodyAndShadow(2),
    'ctflag.shp': bodyAndShadow(2),
    'e1.shp': bodyAndShadow(120),
    'dnoa.shp': bodyAndShadow(120),
    'dron.shp': bodyAndShadow(48),
  };
  const lib = collectTypeLibrary(fakeInstall(files, { 'rulesmd.ini': RULES, 'artmd.ini': ART }), 'temperate');

  it('records buildings with all frames, layers, bib, buildup and foundation', () => {
    const t = lib.types['GAPOWR']!;
    expect(t).toMatchObject({
      kind: 'building',
      image: 'GAPOWR',
      sprite: 'building:GAPOWR',
      foundation: [2, 2],
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
    });
    expect(t.building).toEqual({
      bodyFrames: 3,
      layers: [
        {
          key: 'ActiveAnim',
          sprite: 'anim:GAPOWR_A',
          damagedSprite: 'anim:GAPOWR_AD',
          ySort: 10,
          anim: { loopStart: 0, loopEnd: 2 },
        },
      ],
      bib: 'bib:GAPOWRBB',
      buildup: 'anim:GAPOWRMK',
    });
    const body = lib.collector.sprites.get('building:GAPOWR')!;
    expect(body.entry.file).toBe('gtpowr.shp');
    expect(body.frames).toHaveLength(3);
    expect(body.shadows).toHaveLength(3);
    expect(body.entry.sourceFrames).toBeUndefined();
    expect(lib.collector.sprites.get('anim:GAPOWR_A')!.entry.loop).toEqual([0, 2]);
    expect(lib.collector.sprites.get('anim:GAPOWRMK')!.frames).toHaveLength(5);
  });

  it('resolves generic-letter art, honours Remapable=no and InvisibleInGame', () => {
    expect(lib.collector.sprites.get('building:GAYARD')!.entry.file).toBe('ggyard.shp');
    expect(lib.types['CAFLAG']).toMatchObject({ remap: false, invisible: true });
    expect(lib.types['DNOA']!.remap).toBe(false);
    expect(lib.types['E1']!.remap).toBe(true);
  });

  it('records infantry sequences and SHP vehicle frame layouts', () => {
    expect(lib.types['E1']!.infantry!.sequenceName).toBe('ConSequence');
    expect(lib.types['E1']!.infantry!.sequences['Idle1']).toEqual({
      start: 56,
      count: 15,
      facingMultiplier: 0,
      facing: 'S',
    });
    expect(lib.collector.sprites.get('infantry:E1')!.frames).toHaveLength(120);
    expect(lib.types['DRON']).toMatchObject({
      kind: 'vehicle',
      sprite: 'vehicle:DRON',
      drawOffset: [0, 0],
      shpUnit: { facings: 8, frames: { WalkFrames: 6 } },
    });
  });

  it('skips unresolvable types with a reason instead of failing', () => {
    expect(lib.types['GHOST']).toBeUndefined();
    expect(lib.types['HTNK']).toBeUndefined();
    expect(lib.warnings).toContain('building GHOST: skipped, no art file (ghost.shp), no art section GHOST');
    expect(lib.warnings.some((w) => w.startsWith('vehicle HTNK: skipped, voxel htnk.vxl did not load'))).toBe(true);
    expect(lib.counts['skipped:building']).toBe(1);
    expect(lib.counts['types:building']).toBe(3);
  });

  it('exposes the colour schemes in runtime order with the house index by name', () => {
    expect(lib.colorSchemes.map((c) => c.name)).toEqual(['Gold', 'Gold', 'DarkRed', 'DarkRed']);
    expect(lib.colorSchemesByName).toEqual({ Gold: 1, DarkRed: 3 });
    expect(lib.colorSchemes[3]!.remap).toHaveLength(16);
    expect(lib.conditionYellow).toBe(0.5);
    expect(lib.conditionRed).toBe(0.25);
  });

  it('packs the library sprites into indexed pages keeping per-frame page numbers', () => {
    const packed = packSprites(lib.collector.sprites, { format: 'indexed', maxPage: 64 });
    expect(packed.pages.length).toBeGreaterThan(1);
    for (const p of packed.pages) {
      expect(p.width).toBeLessThanOrEqual(64);
      expect(p.height).toBeLessThanOrEqual(64);
      expect(p.data.length).toBe(p.width * p.height);
    }
    const e1 = packed.entries['infantry:E1']!;
    const f = e1.frames[5]!;
    const page = packed.pages[f.page ?? 0]!;
    expect(page.data[f.rect[1] * page.width + f.rect[0]]).toBe(40);
    expect(e1.shadows).toHaveLength(120);
  });
});

describe('live cell-art library', () => {
  const rules = `
[OverlayTypes]
0=GAWALL
1=TIB01
2=GEM01
3=FENCE
4=ROCK
5=BRIDGE1
6=MISSING
7=TIB01
[GAWALL]
Wall=yes
[TIB01]
Tiberium=yes
[GEM01]
Tiberium=yes
[ROCK]
IsARock=yes
`;
  const inst = fakeInstall(
    {
      'gtwall.shp': bodyAndShadow(16),
      'tib01.tem': bodyAndShadow(12),
      'gem01.tem': bodyAndShadow(8),
      'fence.shp': bodyAndShadow(16),
      'rock.shp': bodyAndShadow(2),
      'bridge1.shp': bodyAndShadow(4),
    },
    { 'rulesmd.ini': rules, 'artmd.ini': '[TIB01]\nTheater=yes\n[GEM01]\nTheater=yes\n' },
  );
  const smudgeInst = fakeInstall(
    {
      'crater.tem': bodyAndShadow(3),
      'crater.sno': bodyAndShadow(2),
      'burn01.shp': bodyAndShadow(1),
    },
    {
      'rulesmd.ini':
        '[SmudgeTypes]\n0=CR1\n1=BURN01\n2=MISSING\n3=CR1\n[CR1]\nImage=CRATER_ART\n[BURN01]\nWidth=3\nHeight=2\n',
      'artmd.ini': '[CRATER_ART]\nImage=crater\nTheater=no\n',
    },
  );
  const temp: string[] = [];
  afterEach(() => {
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const makeCopy = () => {
    const root = mkdtempSync(join(tmpdir(), 'ra2-overlay-library-'));
    temp.push(root);
    const source = join(root, 'source', 'temperate');
    mkdirSync(join(source, 'palettes'), { recursive: true });
    const original = {
      version: 1,
      theater: 'temperate',
      palettes: { unit: 'palettes/unit.png' },
      paletteSources: { unit: 'unittem.pal' },
      spriteAtlases: [{ file: 'sprites-0.png', width: 8, height: 8 }],
      spriteAtlasesHd: [{ file: 'sprites-0@2x.png', remap: 'sprites-0@2x-remap.png', scale: 2, width: 16, height: 16 }],
      sprites: {
        'building:KEEP': {
          palette: 'unit',
          remap: true,
          canvas: [2, 2],
          file: 'keep.shp',
          frameCount: 1,
          frames: [{ rect: [1, 1, 2, 2], offset: [-1, -1] }],
        },
      },
      voxels: { KEEP: '../common/voxels/KEEP.json' },
      types: {
        KEEP: {
          kind: 'building',
          image: 'KEEP',
          sprite: 'building:KEEP',
          drawOffset: [0, -15],
          lighting: 'ambient',
          remap: true,
        },
      },
      colorSchemes: [],
      colorSchemesByName: {},
      conditionYellow: 0.5,
      conditionRed: 0.25,
      extractor: { tool: 'fixture', counts: { sprites: 1 }, warnings: ['keep'] },
      customMetadata: { preserve: true },
    };
    writeFileSync(join(source, 'library.json'), JSON.stringify(original));
    for (const file of ['sprites-0.png', 'sprites-0@2x.png', 'sprites-0@2x-remap.png', 'palettes/unit.png'])
      writeFileSync(join(source, file), `unchanged fixture ${file}`);
    const out = join(root, 'copy');
    cpSync(join(root, 'source'), out, { recursive: true });
    return { original, out, source, dir: join(out, 'temperate') };
  };

  it('collects every available overlay and its complete native frame range with shared palette/draw rules', () => {
    const collected = collectOverlayLibrary(inst, 'temperate');
    expect(Object.keys(collected.overlays)).toEqual(['GAWALL', 'TIB01', 'GEM01', 'FENCE', 'ROCK', 'BRIDGE1']);
    expect(collected.overlays['GAWALL']).toEqual({
      sprite: 'overlay:GAWALL',
      frames: 16,
      palette: 'unit',
      wall: true,
      tiberium: false,
      remap: true,
      flat: false,
      drawOffset: [0, 0],
      lighting: 'ambient',
    });
    expect(collected.overlays['TIB01']).toMatchObject({
      frames: 12,
      palette: 'theater',
      tiberium: true,
      remap: false,
      flat: true,
      lighting: 'none',
    });
    expect(collected.overlays['GEM01']).toMatchObject({ frames: 8, palette: 'theater', tiberium: true });
    expect(collected.overlays['FENCE']).toMatchObject({ palette: 'iso', wall: false, remap: false });
    expect(collected.overlays['ROCK']!.drawOffset).toEqual([0, 15]);
    expect(collected.overlays['BRIDGE1']).toMatchObject({ flat: false, drawOffset: [0, -60] });
    expect(collected.collector.sprites.get('overlay:GAWALL')!.shadows).toHaveLength(16);
    expect(collected.collector.sprites.get('overlay:TIB01')!.entry.file).toBe('tib01.tem');
    expect(collected.counts).toEqual({ 'listed:overlay': 7, 'types:overlay': 6, 'skipped:overlay': 1 });
    expect(collected.warnings).toEqual(['overlay:MISSING: no art file (missing.shp)']);
    expect(collectTypeLibrary(inst, 'temperate').overlays).toEqual(collected.overlays);
  });

  it('keeps rubble metadata without resolving its Image, while a normal rock still resolves to its SHP', () => {
    const rules = `[OverlayTypes]
0=RUBBLE_OVERLAY
1=SROCK01
[RUBBLE_OVERLAY]
Image=SROCK01
IsRubble=yes
DrawFlat=yes
[SROCK01]
IsARock=yes
`;
    const files = { 'srock01.shp': bodyAndShadow(2) };
    const inis = { 'rulesmd.ini': rules, 'artmd.ini': '' };
    const inst = fakeInstall(files, inis);
    const reads: string[] = [];
    const collected = collectOverlayLibrary(
      {
        ...inst,
        shp: (name) => {
          reads.push(name);
          return inst.shp(name);
        },
      },
      'temperate',
    );
    expect(collected.overlays['RUBBLE_OVERLAY']).toEqual({
      rubble: true,
      frames: 0,
      palette: 'iso',
      wall: false,
      tiberium: false,
      remap: false,
      flat: true,
      drawOffset: [0, 0],
      lighting: 'full',
    });
    expect(collected.collector.sprites.has('overlay:RUBBLE_OVERLAY')).toBe(false);
    expect([...collected.collector.sprites.keys()]).toEqual(['overlay:SROCK01']);
    expect(collected.collector.sprites.get('overlay:SROCK01')!.entry.file).toBe('srock01.shp');
    expect(reads).toEqual(['srock01.shp']);
    expect(collected.overlays['SROCK01']!.drawOffset).toEqual([0, 15]);
    expect(collected.warnings).toEqual([]);

    const rubbleOnly = fakeInstall(files, { ...inis, 'rulesmd.ini': rules.replace('1=SROCK01\n', '') });
    const isolated = collectOverlayLibrary(rubbleOnly, 'temperate');
    expect(isolated.collector.sprites.size).toBe(0);
    expect(isolated.collector.usedPalettes.has('iso')).toBe(true);
    expect(isolated.warnings).toEqual([]);
    const { out, dir } = makeCopy();
    appendOverlayLibrary(rubbleOnly, 'temperate', out);
    const saved = readLibrary(dir);
    expect(saved.overlays!['RUBBLE_OVERLAY']).not.toHaveProperty('sprite');
    expect(Object.keys(saved.sprites).filter((key) => key.startsWith('overlay:'))).toEqual([]);
    expect(Object.values(saved.sprites).some((entry) => entry.file?.includes('srock'))).toBe(false);
    expect(saved.palettes['iso']).toBe('palettes/iso.png');
  });

  it('appends only new pages to a temp copy and preserves original metadata, pages, palettes and HD references', () => {
    const { original, out, source, dir } = makeCopy();
    const result = appendOverlayLibrary(inst, 'temperate', out);
    const library = readLibrary(dir);
    for (const key of ['types', 'voxels', 'colorSchemes', 'colorSchemesByName', 'extractor'] as const)
      expect(library[key]).toEqual(original[key]);
    expect((library as TypeLibrary & { customMetadata: unknown }).customMetadata).toEqual(original.customMetadata);
    expect(library.sprites['building:KEEP']).toEqual(original.sprites['building:KEEP']);
    expect(library.spriteAtlases[0]).toEqual(original.spriteAtlases[0]);
    expect(library.spriteAtlasesHd).toEqual([...original.spriteAtlasesHd, null]);
    expect(library.spriteAtlases).toHaveLength(2);
    expect(library.spriteAtlases[1]!.file).toBe('sprites-overlays-0.png');
    for (const file of ['sprites-0.png', 'sprites-0@2x.png', 'sprites-0@2x-remap.png', 'palettes/unit.png'])
      expect(readFileSync(join(dir, file))).toEqual(readFileSync(join(source, file)));
    expect(readFileSync(join(source, 'library.json'), 'utf8')).toBe(JSON.stringify(original));
    for (const overlay of Object.values(library.overlays!)) {
      if (!overlay.sprite) continue;
      const sprite = library.sprites[overlay.sprite]!;
      expect([...sprite.frames, ...sprite.shadows!].every((frame) => frame.page === 1)).toBe(true);
    }
    expect(library.palettes).toEqual({
      unit: 'palettes/unit.png',
      iso: 'palettes/iso.png',
      theater: 'palettes/theater.png',
    });
    expect(result.library).toEqual(library);
    expect(library.overlayExtractor?.warnings).toContain('overlay:MISSING: no art file (missing.shp)');
    expect(readdirSync(dir).some((file) => file.endsWith('.tmp'))).toBe(false);
    const firstPage = readFileSync(join(dir, 'sprites-overlays-0.png'));
    const repeat = appendOverlayLibrary(inst, 'temperate', out).library;
    expect(repeat.spriteAtlases).toHaveLength(3);
    expect(repeat.sprites['overlay:GAWALL']!.frames[0]!.page).toBe(2);
    expect(readFileSync(join(dir, 'sprites-overlays-0.png'))).toEqual(firstPage);
    expect(repeat.spriteAtlasesHd).toEqual([...original.spriteAtlasesHd, null, null]);
  });

  it('does not read TechnoType files during an overlay-only append and rejects incompatible existing metadata', () => {
    const { out, dir, original } = makeCopy();
    const isolated = {
      ...inst,
      vxl: () => {
        throw new Error('unrelated voxel read');
      },
      hva: () => {
        throw new Error('unrelated HVA read');
      },
    };
    expect(() => appendOverlayLibrary(isolated, 'temperate', out)).not.toThrow();
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ ...original, theater: 'urban' }));
    const before = readFileSync(join(dir, 'library.json'));
    expect(() => appendOverlayLibrary(inst, 'temperate', out)).toThrow('temperate library');
    expect(readFileSync(join(dir, 'library.json'))).toEqual(before);
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ ...original, paletteSources: { unit: 'other.pal' } }));
    const conflict = readFileSync(join(dir, 'library.json'));
    expect(() => appendOverlayLibrary(inst, 'temperate', out)).toThrow('palette unit conflicts');
    expect(readFileSync(join(dir, 'library.json'))).toEqual(conflict);
  });

  it('collects smudges absent from the map with theater art, footprint dimensions and complete body/shadow frames', () => {
    const collected = collectSmudgeLibrary(smudgeInst, 'temperate');
    expect(Object.keys(collected.smudges)).toEqual(['CR1', 'BURN01']);
    expect(collected.smudges['CR1']).toEqual({
      sprite: 'smudge:CR1',
      frames: 3,
      width: 1,
      height: 1,
      palette: 'iso',
      remap: false,
      flat: true,
      drawOffset: [0, 0],
      lighting: 'full',
    });
    expect(collected.smudges['BURN01']).toMatchObject({ width: 3, height: 2, frames: 1 });
    const crater = collected.collector.sprites.get('smudge:CR1')!;
    expect(crater.entry).toMatchObject({ file: 'crater.tem', palette: 'iso', remap: false });
    expect(crater.entry.sourceFrames).toBeUndefined();
    expect(crater.frames).toHaveLength(3);
    expect(crater.shadows).toHaveLength(3);
    expect(collected.collector.sprites.get('smudge:BURN01')!.entry.file).toBe('burn01.shp');
    const snow = collectSmudgeLibrary(smudgeInst, 'snow');
    expect(snow.collector.sprites.get('smudge:CR1')!.entry.file).toBe('crater.sno');
    expect(snow.smudges['CR1']!.frames).toBe(2);
    expect(collected.counts).toEqual({ 'listed:smudge': 3, 'types:smudge': 2, 'skipped:smudge': 1 });
    expect(collected.warnings).toEqual(['smudge:MISSING: no art file (missing.tem, missing.shp)']);
    expect(collectTypeLibrary(smudgeInst, 'temperate').smudges).toEqual(collected.smudges);
  });

  it('appends smudges without changing old library records, overlay pages, palettes or HD references', () => {
    const { out, dir } = makeCopy();
    const original = appendOverlayLibrary(inst, 'temperate', out).library;
    const unchanged = [
      'library.json',
      'sprites-0.png',
      'sprites-0@2x.png',
      'sprites-0@2x-remap.png',
      'sprites-overlays-0.png',
      'palettes/unit.png',
      'palettes/iso.png',
      'palettes/theater.png',
    ];
    const before = Object.fromEntries(unchanged.map((file) => [file, readFileSync(join(dir, file))]));
    const library = appendSmudgeLibrary(smudgeInst, 'temperate', out).library;
    expect(readLibrary(dir)).toEqual(library);
    for (const key of [
      'types',
      'voxels',
      'colorSchemes',
      'colorSchemesByName',
      'extractor',
      'overlays',
      'overlayExtractor',
      'palettes',
      'paletteSources',
    ] as const)
      expect(library[key]).toEqual(original[key]);
    for (const [id, sprite] of Object.entries(original.sprites)) expect(library.sprites[id]).toEqual(sprite);
    expect(library.spriteAtlases.slice(0, 2)).toEqual(original.spriteAtlases);
    expect(library.spriteAtlases[2]!.file).toBe('sprites-smudges-0.png');
    expect(library.spriteAtlasesHd).toEqual([...original.spriteAtlasesHd!, null]);
    for (const file of unchanged.filter((file) => file !== 'library.json'))
      expect(readFileSync(join(dir, file))).toEqual(before[file]);
    for (const smudge of Object.values(library.smudges!)) {
      const sprite = library.sprites[smudge.sprite]!;
      expect([...sprite.frames, ...sprite.shadows!].every((frame) => frame.page === 2)).toBe(true);
    }
    expect(library.smudgeExtractor).toMatchObject({
      tool: 'ra2-assets library --only smudges',
      counts: { 'types:smudge': 2, sprites: 2, frames: 8, atlasPages: 1 },
      warnings: ['smudge:MISSING: no art file (missing.tem, missing.shp)'],
    });
    const firstPage = readFileSync(join(dir, 'sprites-smudges-0.png'));
    const repeat = appendSmudgeLibrary(smudgeInst, 'temperate', out).library;
    expect(repeat.spriteAtlases).toHaveLength(4);
    expect(repeat.sprites['smudge:CR1']!.frames[0]!.page).toBe(3);
    expect(readFileSync(join(dir, 'sprites-smudges-0.png'))).toEqual(firstPage);
    expect(repeat.spriteAtlasesHd).toEqual([...original.spriteAtlasesHd!, null, null]);
    expect(readdirSync(dir).some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('adds smudges to old libraries without unrelated reads and refuses incompatible metadata or palette sources', () => {
    const { out, dir, original } = makeCopy();
    const isolated = {
      ...smudgeInst,
      palette: (file: string) => {
        expect(file).toBe('isotem.pal');
        return smudgeInst.palette(file);
      },
      vxl: () => {
        throw new Error('unrelated voxel read');
      },
      hva: () => {
        throw new Error('unrelated HVA read');
      },
    };
    expect(() => appendSmudgeLibrary(isolated, 'temperate', out)).not.toThrow();
    expect(readLibrary(dir).palettes.iso).toBe('palettes/iso.png');
    for (const change of [
      { version: 2 },
      { theater: 'snow' },
      {
        palettes: { iso: 'palettes/iso.png' },
        paletteSources: { iso: 'other.pal' },
      },
    ]) {
      writeFileSync(join(dir, 'library.json'), JSON.stringify({ ...original, ...change }));
      const before = readFileSync(join(dir, 'library.json'));
      expect(() => appendSmudgeLibrary(smudgeInst, 'temperate', out)).toThrow(
        /temperate library|palette iso conflicts/,
      );
      expect(readFileSync(join(dir, 'library.json'))).toEqual(before);
    }
  });
});
