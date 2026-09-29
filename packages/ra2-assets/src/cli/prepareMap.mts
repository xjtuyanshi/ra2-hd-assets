/** Prepare one map's complete offline HD cache using the existing extraction and inference steps. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PREPARE_STEPS, prepareMap, type PrepareStep } from '../node/prepareMap.ts';

const usage = `usage: prepare-map --map <file or id> [--game <dir>] [--cache <dir>] [--bin <path>]
  [--steps extract,terrain,upscale,sprites,library,library-sprites,remat] [--scale 2] [--force] [--dry-run]

Defaults: all steps except remat; existing extraction and current outputs are reused.
--scale accepts an integer from 1 to 4; terrain scale is reduced to fit 16384 px per side.
--force rebuilds selected map steps; current shared library assets are reused.
--dry-run only prints the plan and never writes files.
remat is opt-in; include it in --steps to use the separately installed local Python environment.
No executables, models, or game resources are downloaded.`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    strict: true,
    allowPositionals: false,
    options: {
      map: { type: 'string' },
      game: { type: 'string' },
      cache: { type: 'string' },
      bin: { type: 'string' },
      steps: { type: 'string' },
      scale: { type: 'string', default: '2' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (!values.map?.trim()) throw new Error('--map is required; use --help for usage');
    if (!/^[1-4]$/.test(values.scale!)) throw new Error('--scale must be an integer from 1 to 4');
    let steps: PrepareStep[] | undefined;
    if (values.steps !== undefined) {
      const selected = values.steps.split(',').map((step) => step.trim());
      if (selected.some((step) => !PREPARE_STEPS.includes(step as PrepareStep)))
        throw new Error(`--steps must contain only ${PREPARE_STEPS.join(',')}`);
      if (new Set(selected).size !== selected.length) throw new Error('--steps must not contain duplicate steps');
      steps = selected as PrepareStep[];
    }
    // pnpm --filter changes cwd to this package; relative user paths belong to its original invocation directory.
    if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
    await prepareMap({
      repoRoot,
      map: values.map,
      scale: Number(values.scale),
      force: values.force,
      dryRun: values['dry-run'],
      ...(values.game !== undefined ? { gameDir: resolve(values.game) } : {}),
      ...(values.cache !== undefined ? { cacheDir: resolve(values.cache) } : {}),
      ...(values.bin !== undefined ? { bin: resolve(values.bin) } : {}),
      ...(steps !== undefined ? { steps } : {}),
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
