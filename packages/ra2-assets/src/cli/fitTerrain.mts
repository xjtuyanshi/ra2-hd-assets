/** Fit an integer-scale terrain composite that exceeds the texture limit down to the map's fitted fractional scale. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fitTerrainImage } from '../node/terrainFit.ts';

const usage = `usage: fit-terrain --dir <map cache dir> --input <terrain.png> [--mask <water.png>] [--output <png>]
  [--output-mask <png>] [--max-side 16384] [--alpha source|input] [--write-manifest]

--input is an RGB(A) composite at an integer multiple (2x, ...) of the map's scale-1 terrain-map.png, too large for
--max-side; it is reduced with the exact linear-light area filter to the scale the upscaler chooses for this map.
Alpha comes from terrain-map.png by default (identical to the upscaler's fitted composite); --alpha input averages the
input's own alpha. --mask fits a water mask of the input's size the same way. The output defaults to
<dir>/<input stem>-fit.png. Nothing is written outside the given outputs; --write-manifest also points
manifest.terrainMap at the fitted pair (the mask is made from terrain-water.png when --mask is absent).
The fitted terrainMap reference is printed as JSON.`;

try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    strict: true,
    allowPositionals: false,
    options: {
      dir: { type: 'string' },
      input: { type: 'string' },
      mask: { type: 'string' },
      output: { type: 'string' },
      'output-mask': { type: 'string' },
      'max-side': { type: 'string', default: '16384' },
      alpha: { type: 'string', default: 'source' },
      'write-manifest': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (!values.dir || !values.input) throw new Error('--dir and --input are required; use --help for usage');
    if (!/^[1-9]\d*$/.test(values['max-side']!)) throw new Error('--max-side must be a positive integer');
    if (values.alpha !== 'source' && values.alpha !== 'input') throw new Error('--alpha must be source or input');
    // pnpm --filter changes cwd to this package; relative user paths belong to its original invocation directory.
    if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
    const t0 = Date.now();
    const result = fitTerrainImage({
      mapDir: resolve(values.dir),
      input: resolve(values.input),
      maxSide: Number(values['max-side']),
      alpha: values.alpha as 'source' | 'input',
      writeManifest: values['write-manifest'],
      ...(values.mask !== undefined ? { mask: resolve(values.mask) } : {}),
      ...(values.output !== undefined ? { output: resolve(values.output) } : {}),
      ...(values['output-mask'] !== undefined ? { outputMask: resolve(values['output-mask']) } : {}),
    });
    console.error(
      `${result.sourceScale}x -> ${result.scale}x: ${result.width}x${result.height} -> ${result.file} (${Date.now() - t0} ms)`,
    );
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
