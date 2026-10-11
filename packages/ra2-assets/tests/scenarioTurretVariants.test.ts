/** Scenario voxel donors must preserve requested art while permitting unused stock turret variants. */
import { describe, expect, it } from 'vitest';
import { Palette, parseIni, type IniFile } from 'ra2-formats';
import type { InstallView } from '../src/node/artSource.ts';
import { collectScenarioTypes } from '../src/node/scenarioTypes.ts';

const vxl = (name: string, color: number) => ({
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
      voxels: [{ x: 0, y: 0, z: 0, color, normal: 0 }],
    },
  ],
});

function install(changedOnSecondRead?: string, changedTurretOffset = false): InstallView {
  const inis = new Map<string, IniFile>([
    ['rulesmd.ini', parseIni('[VehicleTypes]\n0=FV\n[FV]\nTurret=yes\nTurretCount=4\n')],
    ['artmd.ini', parseIni('[FV]\nVoxel=yes\n')],
  ]);
  const files: Record<string, ReturnType<typeof vxl>> = {
    'fv.vxl': vxl('body', 30),
    'fvtur.vxl': vxl('turret', 31),
    'fvtur1.vxl': vxl('turret1', 32),
    'fvtur2.vxl': vxl('repair', 33),
    'fvtur3.vxl': vxl('turret3', 34),
    'fvtur4.vxl': vxl('extra', 35),
  };
  const reads = new Map<string, number>();
  let artReads = 0;
  return {
    has: (name: string) => name.toLowerCase() in files || name.toLowerCase().endsWith('.pal'),
    ini: (name: string) => {
      if (name.toLowerCase() === 'artmd.ini' && ++artReads > 1 && changedTurretOffset)
        return parseIni('[FV]\nVoxel=yes\nTurretOffset=5\n');
      const ini = inis.get(name.toLowerCase());
      if (!ini) throw new Error(`${name} missing`);
      return ini;
    },
    shp: () => undefined,
    palette: () => Palette.parse(new Uint8Array(768)),
    vxl: (name: string) => {
      const key = name.toLowerCase();
      const read = (reads.get(key) ?? 0) + 1;
      reads.set(key, read);
      // Build two valid but different pictures under the same art section, as a strict mismatch fixture.
      return key === changedOnSecondRead && read > 1 ? vxl(files[key]!.sections[0]!.name, 60) : files[key];
    },
    hva: () => undefined,
  } as unknown as InstallView;
}

function custom(turretCount: number, turret = true): IniFile {
  return parseIni(
    `[VehicleTypes]\n999=FVTEST\n[FVTEST]\nImage=FV\nTurret=${turret ? 'yes' : 'no'}\nTurretCount=${turretCount}\n`,
  );
}

describe('scenario turret-variant donors', () => {
  it.each([0, 1, 2, 3, 4])('binds a custom IFV with TurretCount=%i to its stock art', (count) => {
    const result = collectScenarioTypes(install(), 'temperate', custom(count));
    expect(result.types.FVTEST).toEqual({ kind: 'vehicle', art: 'FV', turret: true });
    expect(result.warnings).toEqual([]);
  });

  it('records a stock IFV with fewer variants instead of treating its complete model as unchanged', () => {
    const result = collectScenarioTypes(install(), 'temperate', parseIni('[FV]\nTurretCount=2\n'));
    expect(result.types.FV).toEqual({ kind: 'vehicle', art: 'FV', turret: true });
    expect(result.warnings).toEqual([]);
  });

  it('leaves an unchanged stock IFV out of the sidecar', () => {
    const result = collectScenarioTypes(install(), 'temperate', parseIni('[FV]\nTurretCount=4\n'));
    expect(result.types).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('rejects a requested turret variant absent from the stock donor', () => {
    const result = collectScenarioTypes(install(), 'temperate', custom(5));
    expect(result.types.FVTEST).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining('no stock type has its art')]);
  });

  it.each(['fv.vxl', 'fvtur.vxl', 'fvtur1.vxl', 'fvtur2.vxl'])(
    'rejects different requested %s art even when the donor has extra variants',
    (file) => {
      const result = collectScenarioTypes(install(file), 'temperate', custom(3));
      expect(result.types.FVTEST).toBeUndefined();
      expect(result.warnings).toEqual([expect.stringContaining('no stock type has its art')]);
    },
  );

  it('rejects different default parts when the scenario removes the default turret', () => {
    const result = collectScenarioTypes(install(), 'temperate', custom(0, false));
    expect(result.types.FVTEST).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining('no stock type has its art')]);
  });

  it('rejects different model metadata even when every requested part matches', () => {
    const result = collectScenarioTypes(install(undefined, true), 'temperate', custom(2));
    expect(result.types.FVTEST).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining('no stock type has its art')]);
  });
});
