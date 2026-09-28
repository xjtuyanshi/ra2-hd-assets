/**
 * pnpm --filter ra2-assets extract -- --game <install dir> --map <RiverRam.yro> [--out <dir>] [--voxels MTNK,HTNK]
 *
 * Extracts one map's HD cache from the player's own install into <out>/<mapId>/ (default: <repo>/gameres/hd-cache).
 * The output is derived game data: it lives in the gitignored gameres/ directory and must never be committed.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_VOXELS, extractMap } from '../node/extract.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    map: { type: 'string', multiple: true },
    out: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
    voxels: { type: 'string' },
  },
});
if (!values.map?.length) {
  console.error('usage: extract --game <install dir> --map <map file> [--map ...] [--out <dir>] [--voxels A,B]');
  process.exit(2);
}
for (const map of values.map) {
  const t0 = Date.now();
  const res = extractMap({
    gameDir: resolve(values.game!),
    map,
    outDir: resolve(values.out!),
    defaultVoxels: values.voxels
      ? values.voxels
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : DEFAULT_VOXELS,
  });
  const m = res.manifest;
  console.log(
    `${res.mapId}: ${m.grid.width}x${m.grid.height} cells, ${m.tiles.length} tiles, terrain atlas ${m.terrainAtlas.width}x${m.terrainAtlas.height}, ` +
      `sprite atlas ${m.spriteAtlas.width}x${m.spriteAtlas.height}, ${Object.keys(m.sprites).length} sprites, ${m.objects.length} objects, ` +
      `${Object.keys(m.voxels).length} voxels -> ${res.dir} (${Date.now() - t0} ms)`,
  );
  console.log(`  counts ${JSON.stringify(m.extractor?.counts)}`);
}
