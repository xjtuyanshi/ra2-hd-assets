/**
 * pnpm hd:materials -- [--game <install dir>] [--out <library dir>] [--terrain <map> ...] [--cache <dir>] [--sigma 2]
 *
 * Writes install-wide material data for the HD renderer into <out>/common/ (default
 * <repo>/gameres/hd-cache/_library/common): voxels-vpl.png + voxels-vpl.json, the engine's voxel lighting table.
 * `--terrain <map>` (repeatable) additionally writes the map's colour-matched HD terrain (<terrain file>-cm.png) and a
 * materials.json pointing at it into <cache>/<map>/ (default cache <repo>/gameres/hd-cache); `--terrain` alone skips
 * the voxel table. Only these new sidecar files are written; map manifests and library.json files are left untouched.
 * The output is derived game data and must never be committed.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { colourMatchMapTerrain, extractVoxelLighting } from '../node/materials.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    out: { type: 'string', default: join(repoRoot, 'gameres/hd-cache/_library') },
    terrain: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
    sigma: { type: 'string', default: '2' },
  },
});

const maps = (values.terrain ?? [])
  .flatMap((m) => m.split(','))
  .map((m) => m.trim())
  .filter(Boolean);
if (!maps.length) {
  const gameDir = resolve(values.game!);
  if (!existsSync(gameDir)) {
    console.error(`game directory ${gameDir} not found; pass --game <install dir>`);
    process.exit(2);
  }
  const t0 = Date.now();
  const result = extractVoxelLighting({ gameDir, outDir: join(resolve(values.out!), 'common') });
  const { header, fit } = result.file;
  console.log(
    `voxels.vpl: ${header.sectionCount} sections, remap ${header.remapStart}-${header.remapEnd}; ${fit.source}`,
  );
  console.log(`  -> ${result.png}\n  -> ${result.json} (${Date.now() - t0} ms)`);
}
for (const map of maps) {
  const t0 = Date.now();
  const mapDir = join(resolve(values.cache!), map.replace(/\.(yro|mmx|map|mpr|yrm)$/i, ''));
  const result = colourMatchMapTerrain({ mapDir, sigma: Number(values.sigma) });
  console.log(
    `${map}: ${result.width}x${result.height} -> ${result.file}\n  -> ${result.materials} (${Date.now() - t0} ms)`,
  );
}
