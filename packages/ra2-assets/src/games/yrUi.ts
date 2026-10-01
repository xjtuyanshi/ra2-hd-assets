import { CsfFile, ShpFile } from 'ra2-formats';
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
});

/** Retains the scratch extractor's metadata and its base/add-on cameo palette policy without private mount access. */
export function yrCameos(install: Pick<GameInstall, 'ini' | 'read' | 'readArchive' | 'has' | 'palette'>): {
  definitions: CameoDefinition[];
  source: CameoSource;
} {
  const rules = install.ini(YR_UI.rules),
    art = install.ini(YR_UI.art);
  const bytes = install.read(YR_UI.strings);
  if (!bytes) throw new Error(`Missing ${YR_UI.strings}`);
  const strings = CsfFile.parse(bytes),
    definitions: CameoDefinition[] = [];
  for (const registry of YR_UI.registries) {
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
