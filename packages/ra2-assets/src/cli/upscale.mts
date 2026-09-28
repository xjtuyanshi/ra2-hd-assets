/** AI-upscale the scale-1 terrain composite; all game-derived outputs remain in the selected local cache. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { upscaleTerrainMap } from '../node/upscale.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    map: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
    scale: { type: 'string', default: '2' },
    model: { type: 'string', default: 'realesrgan-x4plus' },
    bin: { type: 'string' },
    tile: { type: 'string', default: '256' },
    compare: { type: 'string' },
  },
});
if (!values.map?.length) {
  console.error(
    'usage: upscale --map <mapId> [--map ...] [--scale 2] [--model realesrgan-x4plus] [--bin <path>] [--tile 256] [--cache <dir>] [--compare x,y,w,h]',
  );
  process.exit(2);
}
try {
  let compare: [number, number, number, number] | undefined;
  if (values.compare !== undefined) {
    const parts = values.compare.split(',');
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)))
      throw new Error('compare must be four non-negative integers: x,y,width,height');
    compare = parts.map(Number) as [number, number, number, number];
  }
  for (const id of values.map) {
    const mapId = id.replace(/\.(yro|mmx|map|mpr|yrm)$/i, '');
    const t0 = Date.now();
    const res = await upscaleTerrainMap({
      cacheDir: join(resolve(values.cache!), mapId),
      scale: Number(values.scale),
      model: values.model!,
      tile: Number(values.tile),
      ...(values.bin ? { bin: resolve(values.bin) } : {}),
      ...(compare ? { compare } : {}),
    });
    console.log(`${mapId}: ${res.width}x${res.height} (${res.scale}x) -> ${res.file} (${Date.now() - t0} ms)`);
    if (res.compare) console.log(`Comparison: ${res.compare}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
