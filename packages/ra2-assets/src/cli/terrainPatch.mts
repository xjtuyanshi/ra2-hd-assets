/**
 * pnpm --filter ra2-assets terrain-patch -- --before <old terrain-map.png> --after <new terrain-map.png>
 *     --target <upscaled.png>=<out.png> [--redraw <redrawn.png>=<out.png>] [--bin <path>] [--tile 256]
 *
 * Repairs upscaled terrain images after the scale-1 composite changed in a few places: only the changed sites are
 * upscaled again (same steps as `upscale`) and feathered into each image. `--redraw` targets are terrain images that
 * were redrawn after the plain upscale; their patches are tone-matched to the surroundings.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { patchUpscaledTerrain } from '../node/terrainPatch.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    target: { type: 'string', multiple: true },
    redraw: { type: 'string', multiple: true },
    model: { type: 'string', default: 'realesrgan-x4plus' },
    bin: { type: 'string' },
    tile: { type: 'string', default: '256' },
    grow: { type: 'string' },
    feather: { type: 'string' },
    context: { type: 'string' },
  },
});
const pairs = (list: string[] | undefined, matchTone: boolean) =>
  (list ?? []).map((entry) => {
    const [file, out] = entry.split('=');
    if (!file) throw new Error(`invalid target "${entry}"; use <file>=<out>`);
    return { file: resolve(file), out: resolve(out || file), matchTone };
  });
try {
  const targets = [...pairs(values.target, false), ...pairs(values.redraw, true)];
  if (!values.before || !values.after || !targets.length) {
    console.error(
      'usage: terrain-patch --before <old 1x png> --after <new 1x png> --target <file>=<out> [--redraw <file>=<out>] [--bin <path>] [--tile 256] [--grow 3] [--feather 5] [--context 20]',
    );
    process.exit(2);
  }
  const t0 = Date.now();
  const result = await patchUpscaledTerrain({
    before: resolve(values.before),
    after: resolve(values.after),
    targets,
    model: values.model!,
    tile: Number(values.tile),
    ...(values.bin ? { bin: resolve(values.bin) } : {}),
    ...(values.grow ? { grow: Number(values.grow) } : {}),
    ...(values.feather ? { feather: Number(values.feather) } : {}),
    ...(values.context ? { context: Number(values.context) } : {}),
    log: (message) => console.log(`  ${message}`),
  });
  console.log(
    `${result.changed} changed px, ${result.regions} regions, ${result.inferred} px inferred, ${result.written.length} files (${Date.now() - t0} ms)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
