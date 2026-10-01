/** Extract local interface art; all derived PNGs/JSON stay outside Git. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ShpFile } from 'ra2-formats';
import { YR_UI, yrCameos } from '../games/yrUi.ts';
import { GameInstall } from '../node/install.ts';
import { writeCameos, writeCursor } from '../node/ui.ts';

const usage = 'usage: ui <cameos|cursor> --game <install> --out <dir> [--shape <file>] [--palette <file>]';
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    allowPositionals: true,
    options: {
      game: { type: 'string' },
      out: { type: 'string' },
      shape: { type: 'string' },
      palette: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (
    values.help ||
    !values.game ||
    !values.out ||
    positionals.length !== 1 ||
    !['cameos', 'cursor'].includes(command ?? '')
  ) {
    console.log(usage);
    if (!values.help) process.exitCode = 2;
  } else {
    const install = GameInstall.open(resolve(values.game), 'temperate'),
      out = resolve(values.out);
    if (command === 'cameos') {
      const entries = writeCameos({ out, ...yrCameos(install), size: YR_UI.cameoSize });
      console.log(
        JSON.stringify({
          entries: entries.length,
          buildable: entries.filter((e) => e.buildable).length,
          missing: entries.filter((e) => !e.file).map((e) => e.id),
          out,
        }),
      );
    } else {
      const file = values.shape ?? YR_UI.cursorShape,
        palette = values.palette ?? YR_UI.cursorPalette;
      const bytes = install.read(file);
      if (!bytes) throw new Error(`Missing cursor shape ${file}`);
      console.log(
        JSON.stringify({
          ...writeCursor({ out, shape: ShpFile.parse(bytes), palette: install.palette(palette) }),
          file,
          palette,
          out,
        }),
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
