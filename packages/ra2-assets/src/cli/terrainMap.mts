/** Composite unlit terrain and its open-water mask into each selected cache. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderTerrainMap } from '../node/terrainMap.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    map: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
  },
});
if (!values.map?.length) {
  console.error('usage: terrain-map --map <mapId> [--map ...] [--cache <dir>]');
  process.exit(2);
}
for (const id of values.map) {
  const mapId = id.replace(/\.(yro|mmx|map|mpr|yrm)$/i, '');
  const t0 = Date.now();
  const res = renderTerrainMap({ cacheDir: join(resolve(values.cache!), mapId) });
  console.log(
    `${mapId}: ${res.width}x${res.height}, origin (${res.originX}, ${res.originY}) -> ${res.file}, ${res.waterMask} (${Date.now() - t0} ms)`,
  );
}
