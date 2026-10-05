/**
 * pnpm --filter ra2-assets scenario-types -- [--game <install dir>] [--cache <cache root>] [--out <dir>]
 *                                            [--map <map dir>[=<map file>]]...
 *
 * Writes <map dir>/scenario-types.json for map caches that already exist (new extractions write it themselves): the
 * types the scenario's own rules define or redefine, bound to the theatre library's art (src/node/scenarioTypes.ts).
 * Without --map every directory of the cache root that holds a manifest.json is visited. The scenario is read from
 * the player's install by the manifest's source name, then by the directory's name as a .yro/.mmx package or archived
 * .map, then through the .pkt index of the loose packages; `--map EB2=EB2.mmx` names it explicitly. A scenario whose
 * theatre or size differs from the manifest is refused.
 *
 * With --out the files go to <out>/<map dir>/ instead of the cache, for installing into a copy-on-write cache farm
 * with python/cache_farm.py; a map directory that is a symbolic link is never written into. Exit status 1 when a
 * scenario could not be read or a file could not be written.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MixFile, parseIni } from 'ra2-formats';
import type { HdCacheManifest } from '../manifest.ts';
import { SCENARIO_TYPES_FILE } from '../library.ts';
import { theaterFromMap, type TheaterId } from '../theater.ts';
import { GameInstall, loadMap, type LoadedMap } from '../node/install.ts';
import { scenarioTypesSidecar, writeScenarioTypes } from '../node/scenarioTypes.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
    out: { type: 'string' },
    map: { type: 'string', multiple: true },
  },
});
const game = resolve(values.game!);
const cache = resolve(values.cache!);
const out = values.out ? resolve(values.out) : undefined;
const named = new Map<string, string | undefined>(
  (values.map ?? []).map((m) => {
    const at = m.indexOf('=');
    return at < 0 ? [m, undefined] : [m.slice(0, at), m.slice(at + 1)];
  }),
);
const dirs = named.size
  ? [...named.keys()]
  : readdirSync(cache)
      .filter((d) => !d.startsWith('.') && !d.startsWith('_') && existsSync(join(cache, d, 'manifest.json')))
      .sort((a, b) => a.localeCompare(b));

/** Loose map packages name their scenario in a .pkt index, not in the file name (amazon.mmx holds AMAZON01). */
let packaged: Map<string, string> | undefined;
function packageOf(id: string): string | undefined {
  if (!packaged) {
    packaged = new Map();
    for (const file of existsSync(game) ? readdirSync(game) : []) {
      if (!/\.(yro|mmx)$/i.test(file)) continue;
      try {
        const mix = MixFile.parse(new Uint8Array(readFileSync(join(game, file))));
        const pkt = mix.read(`${basename(file, extname(file)).toLowerCase()}.pkt`);
        if (!pkt) continue;
        for (const name of parseIni(pkt).readRegistry('MultiMaps')) packaged.set(name.trim().toLowerCase(), file);
      } catch {
        // Not a readable package: it cannot name a scenario.
      }
    }
  }
  return packaged.get(id.toLowerCase());
}

const installs = new Map<TheaterId, GameInstall>();
let written = 0;
let empty = 0;
let failed = 0;
for (const dir of dirs) {
  let manifest: HdCacheManifest;
  try {
    manifest = JSON.parse(readFileSync(join(cache, dir, 'manifest.json'), 'utf8')) as HdCacheManifest;
  } catch (error) {
    console.error(`${dir}: manifest.json unreadable (${(error as Error).message})`);
    failed++;
    continue;
  }
  const stem = basename(manifest.source, extname(manifest.source));
  const candidates = named.get(dir)
    ? [named.get(dir)!]
    : [
        ...new Set(
          [
            manifest.source,
            `${stem}.yro`,
            `${stem}.mmx`,
            `${dir}.yro`,
            `${dir}.mmx`,
            `${dir}.map`,
            packageOf(stem),
          ].filter((c): c is string => !!c),
        ),
      ];
  let loaded: LoadedMap | undefined;
  let source = '';
  let why = '';
  for (const candidate of candidates) {
    try {
      const attempt = loadMap(game, candidate);
      const size = attempt.map.size;
      // A cache made from an unpacked copy names a file the install does not have; never bind another scenario to it.
      if (theaterFromMap(attempt.map.theater) !== manifest.theater)
        why = `${candidate} is a ${attempt.map.theater} map`;
      else if (manifest.mapSize && (size?.width !== manifest.mapSize.width || size?.height !== manifest.mapSize.height))
        why = `${candidate} has another size`;
      else {
        loaded = attempt;
        source = candidate;
        break;
      }
    } catch (error) {
      why ||= (error as Error).message;
    }
  }
  if (!loaded) {
    console.error(`${dir}: scenario not found in ${game} (${why}); name it with --map ${dir}=<map file>`);
    failed++;
    continue;
  }
  const theater = manifest.theater;
  let inst = installs.get(theater);
  if (!inst) installs.set(theater, (inst = GameInstall.open(game, theater)));
  const sidecar = scenarioTypesSidecar(inst, theater, loaded.map.ini, manifest.source);
  const target = out ? join(out, dir) : join(cache, dir);
  try {
    if (!out && lstatSync(target).isSymbolicLink()) {
      if (!sidecar) {
        empty++;
        continue;
      }
      throw new Error(`${target} is a symbolic link into another cache; use --out and install the file`);
    }
    if (sidecar || !out) writeScenarioTypes(target, sidecar);
  } catch (error) {
    console.error(`${dir}: ${(error as Error).message}`);
    failed++;
    continue;
  }
  if (!sidecar) {
    empty++;
    continue;
  }
  written++;
  const ids = Object.entries(sidecar.types).map(([id, t]) => (t.art === id ? id : `${id}=${t.art}`));
  console.log(`${dir} (${source}): ${ids.length} types -> ${join(target, SCENARIO_TYPES_FILE)}\n  ${ids.join(' ')}`);
  for (const w of sidecar.warnings) console.log(`  warning: ${w}`);
}
console.log(`${dirs.length} map caches: ${written} with scenario types, ${empty} without, ${failed} failed`);
if (failed) process.exitCode = 1;
