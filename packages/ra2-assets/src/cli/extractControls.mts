/** Original interface frame references from player-owned archives, for offline redraw jobs. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Palette, ShpFile } from 'ra2-formats';
import { GameInstall } from '../node/install.ts';
import { writeUiStrip } from '../node/ui.ts';
import { YR_UI } from '../games/yrUi.ts';

const { values } = parseArgs({ options: { game: { type: 'string' }, out: { type: 'string' } } });
if (!values.game || !values.out) throw new Error('usage: extractControls --game INSTALL --out OUT');
const install = GameInstall.open(resolve(values.game), 'temperate'),
  out = resolve(values.out);
const shapes: [string, string][] = [
  ['repair', 'repair.shp'],
  ['sell', 'sell.shp'],
  ['options', 'optbtn.shp'],
  ['diplomacy', 'diplobtn.shp'],
  ['scrollUp', 'r-up.shp'],
  ['scrollDown', 'r-dn.shp'],
  ['commandExpand', 'bttnbkgd.shp'],
  ['commandCollapse', 'bttnbkgd.shp'],
  ['radar', 'radar.shp'],
  ['radarYuri', 'radary.shp'],
  ...Array.from({ length: 25 }, (_, i): [string, string] => [`command${i}`, `button${String(i).padStart(2, '0')}.shp`]),
];
const sides = YR_UI.sidebarArchiveNumbers.map((number, side) => {
  const stem = `sidec${String(number).padStart(2, '0')}`;
  const archives = [`${stem}md.mix`, `${stem}.mix`];
  const find = (file: string) => {
    for (const mix of archives) {
      const bytes = install.readArchive(mix, file);
      if (bytes !== undefined) return { bytes, mix };
    }
    return null;
  };
  const pal = find(YR_UI.sidebarPalette);
  if (!pal) throw new Error(`Missing side ${side} palette`);
  const palette = Palette.parse(pal.bytes),
    directory = join(out, String(side));
  mkdirSync(directory, { recursive: true });
  return {
    side,
    archives,
    paletteMix: pal.mix,
    shapes: shapes.map(([id, file]) => {
      const native = find(file);
      if (!native) return { id, file, missing: true };
      return {
        id,
        source: file,
        mix: native.mix,
        ...writeUiStrip({ out: directory, file: `${id}.png`, shape: ShpFile.parse(native.bytes), palette }),
      };
    }),
  };
});
writeFileSync(join(out, 'controls-original.json'), JSON.stringify({ sides }, null, 2));
console.log(
  JSON.stringify(
    sides.map(({ side, shapes }) => ({
      side,
      extracted: shapes.filter((s) => !('missing' in s)).length,
      missing: shapes.filter((s) => 'missing' in s).map((s) => s.id),
    })),
  ),
);
