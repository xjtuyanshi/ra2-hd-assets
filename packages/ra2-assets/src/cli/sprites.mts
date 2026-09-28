/** Offline 2x RGBA sprite atlases and house-remap masks from an existing indexed cache. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { upscaleSprites } from '../node/spriteHdCache.ts';

const usage =
  'usage: sprites (--map <id> | --library <theater>) [--cache <dir>] [--bin <path>] [--model realesrgan-x4plus] [--pages 0,3] [--limit-frames N]';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      map: { type: 'string' },
      library: { type: 'string' },
      cache: { type: 'string', default: join(repoRoot, 'gameres/hd-cache') },
      bin: { type: 'string' },
      model: { type: 'string', default: 'realesrgan-x4plus' },
      pages: { type: 'string' },
      'limit-frames': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if ((values.map !== undefined) === (values.library !== undefined)) throw new Error(usage);
    let pages: number[] | undefined;
    if (values.pages !== undefined) {
      const parts = values.pages.split(',');
      if (parts.some((part) => !/^\d+$/.test(part))) throw new Error('--pages must be comma-separated page indices');
      pages = parts.map(Number);
    }
    let limitFrames: number | undefined;
    if (values['limit-frames'] !== undefined) {
      if (!/^\d+$/.test(values['limit-frames'])) throw new Error('--limit-frames must be a positive integer');
      limitFrames = Number(values['limit-frames']);
      console.warn('Debug mode: partial @2x-debug atlases only; manifest/library HD references remain unchanged.');
    }
    const started = performance.now();
    const results = await upscaleSprites({
      cacheDir: resolve(values.cache!),
      ...(values.map !== undefined ? { map: values.map } : {}),
      ...(values.library !== undefined ? { library: values.library } : {}),
      ...(pages !== undefined ? { pages } : {}),
      ...(limitFrames !== undefined ? { limitFrames } : {}),
      ...(values.bin !== undefined ? { bin: resolve(values.bin) } : {}),
      model: values.model!,
      onPage: (result) => {
        console.log(
          `${values.map ?? values.library} page ${result.page}: ${result.frames} frames, ${result.batches} batches, ` +
            `${(result.inputPixels / 1e6).toFixed(2)} input MP, ${(result.elapsedMs / 1000).toFixed(2)} s ` +
            `(binary ${(result.binaryMs / 1000).toFixed(2)} s) -> ${result.ref.file}, ${result.ref.remap}`,
        );
      },
    });
    console.log(`${results.length} page(s) finished in ${((performance.now() - started) / 1000).toFixed(2)} s`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
