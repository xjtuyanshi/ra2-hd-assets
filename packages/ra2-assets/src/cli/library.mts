/**
 * pnpm --filter ra2-assets library -- --game <install dir> [--theater temperate ...] [--out <dir>] [--preview]
 *
 * Extracts the per-theater type library (art for every building, vehicle, infantry and aircraft type) from the
 * player's own install into <out>/<theater>/ (default <repo>/gameres/hd-cache/_library, all six theaters), with voxel
 * models shared in <out>/common/. `--preview` also writes <out>/<theater>/library-preview.png (+ .json index), a
 * contact sheet for eyeballing the result. The output is derived game data and must never be committed.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { THEATERS, type TheaterId } from '../theater.ts';
import { ALL_THEATERS, extractLibrary } from '../node/library.ts';
import { renderLibraryPreview } from '../node/libraryPreview.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    theater: { type: 'string', multiple: true },
    out: { type: 'string', default: join(repoRoot, 'gameres/hd-cache/_library') },
    preview: { type: 'boolean', default: false },
  },
});
const theaters = (values.theater ?? []).flatMap((t) => t.split(',')).map((t) => t.trim().toLowerCase());
const unknown = theaters.filter((t) => !(t in THEATERS));
if (unknown.length) {
  console.error(`unknown theater(s) ${unknown.join(', ')}; expected ${ALL_THEATERS.join(', ')}`);
  process.exit(2);
}
const t0 = Date.now();
const results = extractLibrary({
  gameDir: resolve(values.game!),
  outDir: resolve(values.out!),
  theaters: theaters as TheaterId[],
});
for (const r of results) {
  const c = r.library.extractor.counts;
  console.log(
    `  ${r.theater}: buildings ${c['types:building'] ?? 0}/${c['listed:building'] ?? 0}, vehicles ${c['types:vehicle'] ?? 0}/${c['listed:vehicle'] ?? 0}, ` +
      `infantry ${c['types:infantry'] ?? 0}/${c['listed:infantry'] ?? 0}, aircraft ${c['types:aircraft'] ?? 0}/${c['listed:aircraft'] ?? 0} -> ${r.dir}`,
  );
  if (values.preview) {
    const p = renderLibraryPreview({ libraryDir: r.dir });
    console.log(`  preview ${p.width}x${p.height} -> ${p.file}`);
  }
}
console.log(`done in ${Date.now() - t0} ms`);
