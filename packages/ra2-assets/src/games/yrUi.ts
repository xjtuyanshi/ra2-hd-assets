import { CsfFile, Palette, ShpFile } from 'ra2-formats';
import type { CameoDefinition, CameoSource } from '../node/ui.ts';
import type { GameInstall } from '../node/install.ts';

/** YR 1.001 file/registry policies. Cursor filenames are verified at 0x5BDF3A and 0x52C13D. */
export const YR_UI = Object.freeze({
  rules: 'rulesmd.ini',
  art: 'artmd.ini',
  strings: 'ra2md.csf',
  registries: ['BuildingTypes', 'VehicleTypes', 'InfantryTypes', 'AircraftTypes', 'SuperWeaponTypes'],
  cameoSize: { width: 60, height: 48 },
  cursorShape: 'mouse.sha',
  cursorPalette: 'mousepal.pal',
  // YR 1.001 0x534FA0 maps side 2 to side 1 before formatting archive number side+1.
  sidebarArchiveNumbers: [1, 2, 2],
  tabShapes: ['tab00.shp', 'tab01.shp', 'tab02.shp', 'tab03.shp'],
  sidebarPalette: 'sidebar.pal',
});

export function yrTabStrips(install: Pick<GameInstall, 'readArchive'>): {
  side: number;
  tab: number;
  file: string;
  mix: string;
  paletteMix: string;
  shape: ShpFile;
  palette: Palette;
}[] {
  return YR_UI.sidebarArchiveNumbers.flatMap((number, side) => {
    const stem = `sidec${String(number).padStart(2, '0')}`;
    const archives = [`${stem}md.mix`, `${stem}.mix`];
    const find = (file: string) => {
      for (const mix of archives) {
        const bytes = install.readArchive(mix, file);
        if (bytes !== undefined) return { mix, bytes };
      }
      throw new Error(`Missing ${file} in ${archives.join(' / ')}`);
    };
    const pal = find(YR_UI.sidebarPalette),
      palette = Palette.parse(pal.bytes);
    return YR_UI.tabShapes.map((file, tab) => {
      const art = find(file);
      return {
        side,
        tab,
        file: `side${side}_tab0${tab}.png`,
        mix: art.mix,
        paletteMix: pal.mix,
        shape: ShpFile.parse(art.bytes),
        palette,
      };
    });
  });
}

/** Retains the scratch extractor's metadata and its base/add-on cameo palette policy without private mount access. */
export function yrCameos(
  install: Pick<GameInstall, 'ini' | 'read' | 'readArchive' | 'has' | 'palette'>,
  policy: { rules: string; art: string; strings: string; registries: readonly string[] } = YR_UI,
): {
  definitions: CameoDefinition[];
  source: CameoSource;
} {
  const rules = install.ini(policy.rules),
    art = install.ini(policy.art);
  const bytes = install.read(policy.strings);
  if (!bytes) throw new Error(`Missing ${policy.strings}`);
  const strings = CsfFile.parse(bytes),
    definitions: CameoDefinition[] = [];
  for (const registry of policy.registries) {
    for (const id of rules.readRegistry(registry)) {
      const section = rules.getSection(id);
      if (!section) continue;
      const superweapon = registry === 'SuperWeaponTypes';
      const picture = superweapon ? null : art.getSection(section.getString('Image', id));
      const cameo = superweapon ? section.getString('SidebarImage', '') : picture?.getString('Cameo', '') || 'XXICON';
      if (!cameo) continue;
      const alt = picture?.getString('AltCameo', '') || undefined;
      const uiName = section.getString('UIName', ''),
        owner = section.getList('Owner');
      const techLevel = section.getInt('TechLevel', -1);
      definitions.push({
        id,
        kind: registry.replace('Types', ''),
        cameo,
        ...(alt ? { alt } : {}),
        name: uiName ? (strings.getLabel(uiName)?.values[0]?.value ?? '') : section.getString('Name', id),
        uiName,
        owner,
        techLevel,
        buildable: superweapon || (techLevel >= 0 && techLevel <= 10 && owner.length > 0),
      });
    }
  }
  return {
    definitions,
    source: {
      shape(name) {
        const file = `${name}.shp`,
          bytes = install.read(file);
        if (!bytes) return undefined;
        const pal =
          install.readArchive('cameomd.mix', file) && install.has('cameomd.pal') ? 'cameomd.pal' : 'cameo.pal';
        return { shape: ShpFile.parse(bytes), palette: install.palette(pal), pal };
      },
    },
  };
}
