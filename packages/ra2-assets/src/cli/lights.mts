/**
 * pnpm hd:lights -- --map <mapId> [--map ...] [--game <install>] [--cache <dir>] [--windows] [--library <theater>]
 *                   [--preview]
 *
 * Writes map light sidecars next to existing HD caches (see ../node/lights.ts): lights.json always, windows.png/.json
 * with --windows, lights-preview.png and windows-preview.png with --preview. --library <theater> writes the type
 * library's per-page window masks. Never rewrites manifest.json or library.json. The output is derived game data and
 * must never be committed.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { THEATERS, type TheaterId } from '../theater.ts';
import { writeLibraryWindows, writeMapLights } from '../node/lights.ts';

const usage =
  'usage: lights --map <mapId> [--map ...] [--game <dir>] [--cache <dir>] [--windows] [--library <theater>] [--preview]';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      map: { type: 'string', multiple: true },
      game: { type: 'string', default: join(repoRoot, 'game/ra2') },
      cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
      windows: { type: 'boolean', default: false },
      library: { type: 'string', multiple: true },
      preview: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || (!values.map?.length && !values.library?.length)) {
    console.log(usage);
    if (!values.help) process.exitCode = 2;
  } else {
    const cacheDir = resolve(values.cache!);
    for (const id of values.map ?? []) {
      const t0 = Date.now();
      const res = writeMapLights({
        gameDir: resolve(values.game!),
        cacheDir,
        mapId: id.replace(/\.(yro|mmx|map|mpr|yrm)$/i, ''),
        windows: values.windows,
        preview: values.preview,
      });
      for (const w of res.sidecar.extractor.warnings) console.log(`  warning: ${w}`);
      console.log(`  wrote ${res.written.join(', ')} (${Date.now() - t0} ms)`);
    }
    for (const theater of values.library ?? []) {
      const t = theater.toLowerCase();
      if (!(t in THEATERS)) throw new Error(`unknown theater ${theater}`);
      writeLibraryWindows({ cacheDir, theater: t as TheaterId });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
