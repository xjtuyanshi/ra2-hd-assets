/**
 * pnpm --filter ra2-assets terrain-depth -- --game <install dir> --map <mapId> [--map ...] [--cache <dir>]
 *
 * Adds the engine tile-depth atlas (terrain-depth.png) to map caches extracted before extraction wrote it, from the
 * player's own install. The terrain composite must be rebuilt afterwards (terrain-map, or prepare-map).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeTerrainDepth } from '../node/terrainDepth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    map: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
  },
});
if (!values.map?.length) {
  console.error('usage: terrain-depth --game <install dir> --map <mapId> [--map ...] [--cache <dir>]');
  process.exit(2);
}
for (const id of values.map) {
  const mapId = id.replace(/\.(yro|mmx|map|mpr|yrm)$/i, '');
  const res = writeTerrainDepth({ gameDir: resolve(values.game!), cacheDir: join(resolve(values.cache!), mapId) });
  console.log(
    `${mapId}: ${res.tiles} tiles, ${res.noDepth} without z-data, ${res.repainted} atlas pixels repainted -> ${res.file}`,
  );
}
