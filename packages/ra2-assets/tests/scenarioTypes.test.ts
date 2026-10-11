/** Scenario types: scenario-defined and scenario-redefined types bound to stock library art (synthetic data). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Palette, ShpFile, parseIni, type IniFile } from 'ra2-formats';
import {
  SCENARIO_TYPES_FILE,
  scenarioLibraryType,
  scenarioTypeTable,
  validateScenarioTypes,
  type LibraryType,
  type ScenarioTypesSidecar,
} from '../src/library.ts';
import { THEATERS } from '../src/theater.ts';
import { unitVoxelParts, type InstallView } from '../src/node/artSource.ts';
import type { VoxelModel } from '../src/manifest.ts';
import { extractMap } from '../src/node/extract.ts';
import { GameInstall } from '../src/node/install.ts';
import { collectTypeLibrary } from '../src/node/library.ts';
import { collectScenarioTypes, scenarioTypesSidecar, writeScenarioTypes } from '../src/node/scenarioTypes.ts';

/** A raw SHP(TS): `frames` body frames of palette index 40 and as many shadow frames. */
function shp(frames: number, w = 4, h = 3): Uint8Array {
  const count = frames * 2;
  const head = 8 + 24 * count;
  const out = new Uint8Array(head + count * w * h);
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 20, true);
  dv.setUint16(4, 16, true);
  dv.setUint16(6, count, true);
  for (let i = 0; i < count; i++) {
    const p = 8 + 24 * i;
    dv.setInt16(p, 2, true);
    dv.setInt16(p + 2, 3, true);
    dv.setInt16(p + 4, w, true);
    dv.setInt16(p + 6, h, true);
    dv.setInt32(p + 20, head + i * w * h, true);
    out.fill(i < frames ? 40 : 1, head + i * w * h, head + (i + 1) * w * h);
  }
  return out;
}

/** The fields buildVoxelModel reads of a one-section VXL whose single voxel has colour `colour`. */
const vxl = (name: string, colour: number) => ({
  sections: [
    {
      name,
      index: 0,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      scale: 1,
      normalsMode: 4,
      cx: 1,
      cy: 1,
      cz: 1,
      minBounds: [0, 0, 0],
      maxBounds: [1, 1, 1],
      voxels: [{ x: 0, y: 0, z: 0, color: colour, normal: 0 }],
    },
  ],
});

const RULES = `
[BuildingTypes]
0=GAPOWR
1=GTGCAN
2=CAFLAG
[InfantryTypes]
0=E1
1=DNOA
[VehicleTypes]
0=HTNK
1=HARV
2=HORV
[AircraftTypes]
[Colors]
Gold=43,239,255
[GAPOWR]
Strength=750
[GTGCAN]
Turret=yes
TurretAnim=GTGCANTUR
TurretAnimIsVoxel=true
TurretAnimX=3
TurretAnimY=28
TurretAnimZAdjust=-60
[CAFLAG]
InvisibleInGame=yes
[E1]
[DNOA]
[HTNK]
Turret=yes
[HARV]
Harvester=yes
UnloadingClass=HORV
[HORV]
`;

const ART = `
[GAPOWR]
Foundation=2x2
ActiveAnim=GAPOWR_A
[GAPOWR_A]
LoopStart=0
LoopEnd=2
[GTGCAN]
Foundation=2x2
[CAFLAG]
Remapable=no
[ORPHAN]
Foundation=1x1
[E1]
Sequence=Seq
[DNOA]
Sequence=Seq
Remapable=no
[Seq]
Ready=0,1,1
[HTNK]
Voxel=yes
[HARV]
Voxel=yes
[HORV]
Voxel=yes
`;

const SHPS: Record<string, Uint8Array> = {
  'ggpowr.shp': shp(3),
  'ggpowr_a.shp': shp(3, 2, 2),
  'gggcan.shp': shp(3),
  'cgflag.shp': shp(2),
  'orphan.shp': shp(2),
  'e1.shp': shp(8),
  'dnoa.shp': shp(8, 5, 5),
};
const VXLS: Record<string, ReturnType<typeof vxl>> = {
  'gtgcantur.vxl': vxl('tur', 20),
  'gtgcanbarl.vxl': vxl('barl', 21),
  'htnk.vxl': vxl('body', 30),
  'htnktur.vxl': vxl('tur', 31),
  'harv.vxl': vxl('body', 32),
  'horv.vxl': vxl('body', 33),
};

function install(extraIni: Record<string, string> = {}): InstallView & Pick<GameInstall, 'read'> {
  const inis = new Map<string, IniFile>(
    Object.entries({ 'rulesmd.ini': RULES, 'artmd.ini': ART, ...extraIni }).map(([k, v]) => [k, parseIni(v)]),
  );
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i >> 2, i >> 2, i >> 2], i * 3);
  return {
    has: (n: string) => n.toLowerCase() in SHPS || n.toLowerCase() in VXLS || n.toLowerCase().endsWith('.pal'),
    read: (n: string) => SHPS[n.toLowerCase()],
    ini: (n: string) => {
      const ini = inis.get(n.toLowerCase());
      if (!ini) throw new Error(`${n} missing`);
      return ini;
    },
    shp: (n: string) => (SHPS[n.toLowerCase()] ? ShpFile.parse(SHPS[n.toLowerCase()]!) : undefined),
    palette: () => Palette.parse(pal),
    vxl: (n: string) => VXLS[n.toLowerCase()],
    hva: () => undefined,
  } as unknown as InstallView & Pick<GameInstall, 'read'>;
}

const SCENARIO = `
[BuildingTypes]
0=GTGCANA
1=GAPOWRA
2=LONER
3=GHOST
[InfantryTypes]
0=DNOAA
[VehicleTypes]
0=HTNKX
1=HARVB
[GTGCANA]
Image=GTGCAN
Capturable=yes
Turret=yes
TurretAnim=GTGCANTUR
TurretAnimIsVoxel=true
TurretAnimX=5
TurretAnimY=28
TurretAnimZAdjust=-60
[GAPOWRA]
Image=GAPOWR
Refinery=yes
[LONER]
Image=ORPHAN
[GHOST]
Image=NOFILE
[DNOAA]
Image=DNOA
Strength=3500
[HTNKX]
Image=HTNK
Turret=no
[HARVB]
Image=HARV
Harvester=yes
UnloadingClass=HORV
[GAPOWR]
Strength=5000
[CAFLAG]
InvisibleInGame=no
[E1]
Image=DNOA
[HARV]
Harvester=no
UnloadingClass=
`;

describe('scenario types', () => {
  const found = collectScenarioTypes(install(), 'temperate', parseIni(SCENARIO));

  it('binds a scenario-defined clone to the stock type that has its art, with the scenario turret placement', () => {
    expect(found.types['GTGCANA']).toEqual({
      kind: 'building',
      art: 'GTGCAN',
      turret: true,
      turretVoxel: { voxel: 'GTGCAN:turret', offset: [5, 28], zAdjust: -60 },
    });
    expect(found.types['GAPOWRA']).toEqual({ kind: 'building', art: 'GAPOWR', refinery: true });
    expect(found.types['DNOAA']).toEqual({ kind: 'infantry', art: 'DNOA' });
    expect(found.types['HARVB']).toEqual({ kind: 'vehicle', art: 'HARV', harvester: true, unloadingVoxel: 'HORV' });
  });

  it('lists a stock type only when the scenario changes what the extractor derives from rules', () => {
    // Strength alone leaves the record as it is.
    expect(found.types['GAPOWR']).toBeUndefined();
    expect(found.types['GTGCAN']).toBeUndefined();
    // A lamp-post style dummy made visible, a harvester stripped of its traits, a soldier given other art.
    expect(found.types['CAFLAG']).toEqual({ kind: 'building', art: 'CAFLAG' });
    expect(found.types['HARV']).toEqual({ kind: 'vehicle', art: 'HARV' });
    expect(found.types['E1']).toEqual({ kind: 'infantry', art: 'DNOA' });
  });

  it('leaves a type to the renderer fallback, with the reason, when no stock type has identical art', () => {
    // Art exists in the install but belongs to no stock type, so the theatre library holds no page for it.
    expect(found.types['LONER']).toBeUndefined();
    expect(found.warnings).toContain(
      'building LONER: no stock type has its art (art section ORPHAN), so the theatre library cannot draw it',
    );
    // Same art section as HTNK but without the turret parts: HTNK's model would add a turret the clone lacks.
    expect(found.types['HTNKX']).toBeUndefined();
    expect(found.warnings.some((w) => w.startsWith('vehicle HTNKX: no stock type has its art'))).toBe(true);
    // No art file at all: the engine draws nothing either, and nothing is reported.
    expect(found.types['GHOST']).toBeUndefined();
    expect(found.warnings.some((w) => w.includes('GHOST'))).toBe(false);
    expect(found.warnings).toHaveLength(2);
  });

  it('reports a stock picture the scenario removes and a turret model no stock type has', () => {
    const odd = collectScenarioTypes(
      install(),
      'temperate',
      parseIni(
        '[BuildingTypes]\n0=GUNLESS\n[GUNLESS]\nImage=GTGCAN\nTurret=yes\nTurretAnim=HTNKTUR\nTurretAnimIsVoxel=yes\n' +
          '[GAPOWR]\nImage=NOFILE\n',
      ),
    );
    expect(odd.types['GUNLESS']).toEqual({ kind: 'building', art: 'GTGCAN', turret: true });
    expect(odd.warnings).toEqual([
      "building GAPOWR: the scenario's rules leave it without art: no art file (nofile.shp)",
      'building GUNLESS: turret model HTNKTUR belongs to no stock type; the turret is not drawn',
    ]);
  });

  it('writes nothing for a scenario without rules of its own', () => {
    expect(collectScenarioTypes(install(), 'temperate', parseIni('[Map]\nTheater=TEMPERATE\n'))).toEqual({
      types: {},
      warnings: [],
    });
    expect(scenarioTypesSidecar(install(), 'temperate', parseIni('[Basic]\nName=x\n'), 'x.map')).toBeUndefined();
  });

  it('gives the library records the extractor would write for those types', () => {
    const stock = collectTypeLibrary(install(), 'temperate').types;
    const table = scenarioTypeTable(stock, found.types);
    // The clone has the stock art and its own turret offset; the stock type keeps its own.
    expect(table['GTGCANA']).toEqual({
      ...stock['GTGCAN'],
      building: {
        ...stock['GTGCAN']!.building,
        turretVoxel: { voxel: 'GTGCAN:turret', offset: [5, 28], zAdjust: -60 },
      },
    });
    expect(table['GTGCAN']).toBe(stock['GTGCAN']);
    expect(stock['CAFLAG']!.invisible).toBe(true);
    expect(table['CAFLAG']!.invisible).toBeUndefined();
    expect(table['CAFLAG']!.sprite).toBe(stock['CAFLAG']!.sprite);
    expect(table['E1']).toMatchObject({ sprite: 'infantry:DNOA', remap: false });
    expect(stock['HARV']).toMatchObject({ harvester: true, unloadingVoxel: 'HORV' });
    expect(table['HARV']!.harvester).toBeUndefined();
    expect(table['HARV']!.unloadingVoxel).toBeUndefined();
    expect(table['HARV']!.voxel).toBe('HARV');
  });
});

describe('unit image stems', () => {
  // Stock YR: art [BFRT] says Image=SREF, the install ships bfrt.vxl and the game draws the Battle Fortress.
  const fortress = install({
    'rulesmd.ini': '[VehicleTypes]\n0=SREF\n1=BFRT\n2=ALIAS\n[SREF]\nTurret=yes\n[BFRT]\n[ALIAS]\nImage=SREF\n',
    'artmd.ini': '[SREF]\nVoxel=yes\n[BFRT]\nVoxel=yes\nImage=SREF\nRemapable=no\n',
  });
  const models = {
    ...VXLS,
    'bfrt.vxl': vxl('fortress', 50),
    'sref.vxl': vxl('prism', 51),
    'sreftur.vxl': vxl('tur', 52),
  };
  Object.assign(fortress, {
    has: (n: string) => n.toLowerCase() in models || n.toLowerCase().endsWith('.pal'),
    vxl: (n: string) => (models as Record<string, unknown>)[n.toLowerCase()],
  });

  it('builds a voxel unit from the rules image, not from a left-over Image= of its art section', () => {
    const lib = collectTypeLibrary(fortress, 'temperate');
    expect(lib.voxelModels.get('BFRT')!.file).toBe('bfrt.vxl');
    expect(lib.voxelModels.get('BFRT')!.parts[0]!.sections[0]!.name).toBe('fortress');
    // The art section still supplies everything else.
    expect(lib.types['BFRT']).toMatchObject({ kind: 'vehicle', image: 'BFRT', voxel: 'BFRT', remap: false });
    expect(lib.voxelModels.get('SREF')!.parts.map((p) => p.role)).toEqual(['body', 'turret']);
    // A rules Image= does select the art section and the files.
    expect(lib.types['ALIAS']).toMatchObject({ image: 'SREF', voxel: 'ALIAS' });
    expect(lib.voxelModels.get('ALIAS')!.file).toBe('sref.vxl');
    // Nothing was skipped: the only warnings are the fixture's missing HVA files and its empty [Colors].
    expect(lib.warnings.filter((w) => !/\.hva missing|no colour schemes/.test(w))).toEqual([]);
  });
});

describe('numbered voxel turrets', () => {
  const models = {
    'mode.vxl': vxl('body', 50),
    'modetur.vxl': vxl('default', 51),
    'modetur1.vxl': vxl('gun', 52),
    'modetur2.vxl': vxl('repair', 53),
    'modebarl2.vxl': vxl('repair-barrel', 54),
    'modetur3.vxl': vxl('tech', 55),
    // An install can carry unused historical modes beyond TurretCount.
    'modetur4.vxl': vxl('unused', 56),
  };
  function source(count: string | number = 4, missing?: keyof typeof models): InstallView {
    const inst = install({
      'rulesmd.ini': `[VehicleTypes]\n0=SWAP\n1=STATIC\n2=NO_TURRET\n[SWAP]\nImage=MODE\nTurret=yes\nTurretCount=${count}\n[STATIC]\nImage=MODE\nTurret=yes\n[NO_TURRET]\nImage=MODE\nTurretCount=4\n`,
      'artmd.ini': '[MODE]\nVoxel=yes\nImage=WRONG\nTurretOffset=32\n',
      [THEATERS.temperate.controlIni]: '[General]\nClearTile=0\n',
    });
    return Object.assign(inst, {
      has: (n: string) => n.toLowerCase() !== missing && (n.toLowerCase() in models || n.endsWith('.pal')),
      vxl: (n: string) =>
        n.toLowerCase() === missing ? undefined : (models as Record<string, unknown>)[n.toLowerCase()],
    }) as InstallView;
  }
  const names = (model: VoxelModel) => model.parts.flatMap((p) => p.sections.map((s) => s.name));

  it.each([NaN, Infinity, -Infinity, 4.5, -1, 19, 1e12, '', '4.5', '4garbage', '1e300', '0x4'])(
    'rejects invalid TurretCount %s before allocating alternate specs',
    (count) => {
      const warnings: string[] = [];
      const parts = unitVoxelParts('MODE', true, count, (m) => warnings.push(m));
      expect(parts.map((p) => p.stem)).toEqual(['mode', 'modetur', 'modebarl']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`invalid TurretCount=${String(count)}`);
    },
  );

  it.each([undefined, 0, 1, 18, '18', ' 4 '])('accepts bounded TurretCount %s without warnings', (count) => {
    const warnings: string[] = [];
    const parts = unitVoxelParts('MODE', true, count, (m) => warnings.push(m));
    expect(parts.length).toBe(3 + Math.max(0, Number(count ?? 0) - 1) * 2);
    expect(warnings).toEqual([]);
  });

  it('preserves malformed raw INI counts instead of truncating them during library extraction', () => {
    const lib = collectTypeLibrary(source('4.5'), 'temperate');
    expect(lib.voxelModels.get('SWAP')!.turretVariants).toBeUndefined();
    expect(lib.warnings.some((w) => w.includes('invalid TurretCount=4.5'))).toBe(true);
  });

  it('keeps the default model stable and extracts only rule-declared alternatives from the rules image', () => {
    const lib = collectTypeLibrary(source(), 'temperate');
    const model = lib.voxelModels.get('SWAP')!;
    expect(names(model)).toEqual(['body', 'default']);
    expect(model).toMatchObject({ file: 'mode.vxl', turretOffset: 32 });
    expect(Object.keys(model.turretVariants!)).toEqual(['1', '2', '3']);
    expect(model.turretVariants!['2']!.map((p) => p.role)).toEqual(['turret', 'barrel']);
    expect(model.turretVariants!['2']!.flatMap((p) => p.sections.map((s) => s.name))).toEqual([
      'repair',
      'repair-barrel',
    ]);
    expect(names(lib.voxelModels.get('STATIC')!)).toEqual(['body', 'default']);
    expect(lib.voxelModels.get('STATIC')!.turretVariants).toBeUndefined();
    expect(names(lib.voxelModels.get('NO_TURRET')!)).toEqual(['body']);
    expect(lib.voxelModels.get('NO_TURRET')!.turretVariants).toBeUndefined();
  });

  it('reports a missing declared turret without copying the default into that mode', () => {
    const lib = collectTypeLibrary(source(4, 'modetur3.vxl'), 'temperate');
    expect(Object.keys(lib.voxelModels.get('SWAP')!.turretVariants!)).toEqual(['1', '2']);
    expect(lib.warnings).toContain('voxel SWAP: modetur3.vxl missing');
    expect(names(lib.voxelModels.get('SWAP')!)).toEqual(['body', 'default']);
  });

  it.each(['missing', 'unreadable', 'empty'] as const)(
    'does not publish an orphan barrel when its required turret is %s',
    (failure) => {
      const inst = source(4, failure === 'missing' ? 'modetur2.vxl' : undefined);
      if (failure !== 'missing') {
        const read = inst.vxl.bind(inst);
        inst.vxl = (name) => {
          if (name === 'modetur2.vxl') {
            if (failure === 'unreadable') throw new Error('invalid voxel');
            return { ...read(name)!, sections: [], sectionCount: 0 };
          }
          return read(name);
        };
      }
      const lib = collectTypeLibrary(inst, 'temperate');
      const model = lib.voxelModels.get('SWAP')!;
      expect(Object.keys(model.turretVariants!)).toEqual(['1', '3']);
      expect(names(model)).toEqual(['body', 'default']);
      expect(lib.warnings.some((w) => w.startsWith('voxel SWAP: modetur2.vxl '))).toBe(true);
    },
  );

  it.each([
    { count: '2', variants: ['1'], invalid: false },
    { count: '4.5', variants: [], invalid: true },
    { count: '999999999999999999999999999999999999999999', variants: [], invalid: true },
  ])('honours raw scenario TurretCount=$count in map extraction', ({ count, variants, invalid }) => {
    const root = mkdtempSync(join(tmpdir(), 'ra2-turret-source-'));
    const opened = Object.assign(source(), {
      report: { mounted: [], missing: [], unreadable: [] },
      tmp: () => undefined,
    });
    const spy = vi.spyOn(GameInstall, 'open').mockReturnValue(opened as unknown as GameInstall);
    try {
      const map = join(root, 'source.map');
      writeFileSync(map, `[Map]\nTheater=TEMPERATE\n[SWAP]\nTurretCount=${count}\n`);
      const result = extractMap({
        gameDir: root,
        map,
        outDir: join(root, 'out'),
        defaultVoxels: ['SWAP'],
        log: () => {},
      });
      const model = JSON.parse(readFileSync(join(result.dir, result.manifest.voxels['SWAP']!), 'utf8')) as VoxelModel;
      expect(names(model)).toEqual(['body', 'default']);
      expect(Object.keys(model.turretVariants ?? {})).toEqual(variants);
      expect(result.manifest.extractor!.warnings.some((w) => w.includes(`invalid TurretCount=${count}`))).toBe(invalid);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scenario type records', () => {
  const stock: LibraryType = {
    kind: 'building',
    image: 'GTGCAN',
    sprite: 'building:GTGCAN',
    turret: true,
    invisible: true,
    refinery: true,
    foundation: [2, 2],
    drawOffset: [0, -15],
    lighting: 'ambient',
    remap: true,
    atlasPages: [9],
    building: {
      bodyFrames: 3,
      layers: [],
      buildup: 'anim:GTGCANMK',
      height: 3,
      turretVoxel: { voxel: 'GTGCAN:turret', offset: [3, 28], zAdjust: -60 },
    },
  };

  it('never inherits a rules-derived trait from the stock type', () => {
    expect(scenarioLibraryType(stock, { kind: 'building', art: 'GTGCAN' })).toEqual({
      kind: 'building',
      image: 'GTGCAN',
      sprite: 'building:GTGCAN',
      foundation: [2, 2],
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
      atlasPages: [9],
      building: { bodyFrames: 3, layers: [], buildup: 'anim:GTGCANMK', height: 3 },
    });
    const unit: LibraryType = {
      kind: 'vehicle',
      image: 'HARV',
      voxel: 'HARV',
      drawOffset: [0, 0],
      lighting: 'ambient',
      remap: true,
      harvester: true,
      unloadingVoxel: 'HORV',
      deployingAnim: 'anim:X',
    };
    expect(scenarioLibraryType(unit, { kind: 'vehicle', art: 'HARV', turret: true, deployingAnim: 'anim:Y' })).toEqual({
      kind: 'vehicle',
      image: 'HARV',
      voxel: 'HARV',
      drawOffset: [0, 0],
      lighting: 'ambient',
      remap: true,
      turret: true,
      deployingAnim: 'anim:Y',
    });
  });

  it('skips, and reports, an entry whose stock type the library lacks or lists as another kind', () => {
    const warnings: string[] = [];
    const table = scenarioTypeTable(
      { GTGCAN: stock },
      {
        A: { kind: 'building', art: 'GTGCAN' },
        B: { kind: 'building', art: 'MISSING' },
        GTGCAN: { kind: 'vehicle', art: 'GTGCAN' },
      },
      (m) => warnings.push(m),
    );
    expect(Object.keys(table).sort()).toEqual(['A', 'GTGCAN']);
    expect(table['GTGCAN']).toBe(stock);
    expect(warnings).toEqual([
      'scenario type B: the library has no building MISSING to draw it with',
      'scenario type GTGCAN: the library has no vehicle GTGCAN to draw it with',
    ]);
  });

  it('validates the sidecar shape', () => {
    const good: ScenarioTypesSidecar = {
      version: 1,
      theater: 'snow',
      source: 'x.map',
      types: { A: { kind: 'building', art: 'B', turretVoxel: { voxel: 'B:turret', offset: [1, 2], zAdjust: -3 } } },
      warnings: [],
    };
    expect(validateScenarioTypes(good)).toBe(good);
    expect(() => validateScenarioTypes(null)).toThrow('not an object');
    expect(() => validateScenarioTypes({ ...good, version: 2 })).toThrow('unsupported version 2');
    expect(() => validateScenarioTypes({ ...good, types: [] })).toThrow('types is not a map');
    expect(() => validateScenarioTypes({ ...good, types: { A: { kind: 'tree', art: 'B' } } })).toThrow('types.A.kind');
    expect(() => validateScenarioTypes({ ...good, types: { A: { kind: 'building' } } })).toThrow('types.A.art');
    expect(() =>
      validateScenarioTypes({ ...good, types: { A: { kind: 'building', art: 'B', turretVoxel: { voxel: 'v' } } } }),
    ).toThrow('types.A.turretVoxel');
  });
});

describe('scenario type sidecar files', () => {
  const temp: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ra2-scenario-types-'));
    temp.push(dir);
    return dir;
  };
  const sidecar: ScenarioTypesSidecar = {
    version: 1,
    theater: 'temperate',
    source: 'x.map',
    types: { A: { kind: 'building', art: 'B' } },
    warnings: [],
  };

  it('replaces a linked file of a cache farm instead of writing through it, and removes a stale file', () => {
    const root = scratch();
    const base = join(root, 'base');
    const farm = join(root, 'farm');
    mkdirSync(base);
    mkdirSync(farm);
    writeFileSync(join(base, SCENARIO_TYPES_FILE), 'base bytes');
    symlinkSync(join(base, SCENARIO_TYPES_FILE), join(farm, SCENARIO_TYPES_FILE));
    writeScenarioTypes(farm, sidecar);
    expect(lstatSync(join(farm, SCENARIO_TYPES_FILE)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(farm, SCENARIO_TYPES_FILE), 'utf8'))).toEqual(sidecar);
    expect(readFileSync(join(base, SCENARIO_TYPES_FILE), 'utf8')).toBe('base bytes');
    writeScenarioTypes(farm, undefined);
    expect(existsSync(join(farm, SCENARIO_TYPES_FILE))).toBe(false);
    expect(readFileSync(join(base, SCENARIO_TYPES_FILE), 'utf8')).toBe('base bytes');
  });

  it('refuses a map directory that is itself a link into another cache', () => {
    const root = scratch();
    mkdirSync(join(root, 'base'));
    symlinkSync(join(root, 'base'), join(root, 'linked'));
    expect(() => writeScenarioTypes(join(root, 'linked'), sidecar)).toThrow('is a symbolic link into another cache');
    expect(existsSync(join(root, 'base', SCENARIO_TYPES_FILE))).toBe(false);
    // The map extraction has just written the whole directory itself: its own destination is followed.
    writeScenarioTypes(join(root, 'linked'), sidecar, true);
    expect(JSON.parse(readFileSync(join(root, 'base', SCENARIO_TYPES_FILE), 'utf8'))).toEqual(sidecar);
  });

  it('is written by the map extraction, and removed again when the scenario no longer needs it', () => {
    const root = scratch();
    const opened = Object.assign(install({ [THEATERS.temperate.controlIni]: '[General]\nClearTile=0\n' }), {
      report: { mounted: [], missing: [], unreadable: [] },
      tmp: () => undefined,
    });
    vi.spyOn(GameInstall, 'open').mockReturnValue(opened as unknown as GameInstall);
    const map = join(root, 'source.map');
    const extract = () =>
      extractMap({ gameDir: root, map, outDir: join(root, 'out'), defaultVoxels: [], log: () => {} });
    writeFileSync(map, '[Map]\nTheater=TEMPERATE\n[BuildingTypes]\n0=GAPOWRA\n[GAPOWRA]\nImage=GAPOWR\n');
    const first = extract();
    const file = join(first.dir, SCENARIO_TYPES_FILE);
    const expected = {
      version: 1,
      theater: 'temperate',
      source: 'source.map',
      types: { GAPOWRA: { kind: 'building', art: 'GAPOWR' } },
      warnings: [],
    };
    expect(first.scenarioTypes).toEqual(expected);
    expect(validateScenarioTypes(JSON.parse(readFileSync(file, 'utf8')))).toEqual(expected);
    writeFileSync(map, '[Map]\nTheater=TEMPERATE\n');
    expect(extract().scenarioTypes).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});
