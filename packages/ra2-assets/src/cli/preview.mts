/**
 * pnpm --filter ra2-assets preview -- --map RiverRam [--cache <dir>] [--out <file>] [--models] [--foundations] [--unlit] [--full]
 *
 * Composites <cache>/<mapId>/ into preview.png the way the original engine draws the map (verification tool),
 * cropped to the playable area unless --full is given.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderPreview } from '../node/preview.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    map: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
    out: { type: 'string' },
    models: { type: 'boolean', default: false },
    foundations: { type: 'boolean', default: false },
    unlit: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
  },
});
if (!values.map?.length) {
  console.error(
    'usage: preview --map <mapId> [--map ...] [--cache <dir>] [--out <file>] [--models] [--foundations] [--unlit] [--full]',
  );
  process.exit(2);
}
for (const id of values.map) {
  const mapId = id.replace(/\.(yro|mmx|map|mpr|yrm)$/i, '');
  const t0 = Date.now();
  const res = renderPreview({
    cacheDir: join(resolve(values.cache!), mapId),
    ...(values.out && values.map.length === 1 ? { out: resolve(values.out) } : {}),
    modelStrip: values.models!,
    foundations: values.foundations!,
    lighting: !values.unlit,
    full: values.full!,
  });
  console.log(
    `${mapId}: ${res.width}x${res.height} -> ${res.file} (${Date.now() - t0} ms) drawn ${JSON.stringify(res.drawn)}`,
  );
}
