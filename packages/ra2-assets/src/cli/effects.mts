/**
 * pnpm hd:effects [--game <install dir>] [--theater temperate ...] [--out <dir>] [--table <file.ts>]
 *
 * Extracts the effect art sidecar (original art of every anim, projectile, debris voxel, particle, overlay and smudge;
 * see src/effects.ts) from the player's own install into <out> (default <repo>/gameres/hd-cache/_library/common/effects),
 * with theater variants for every theater given (default all six). `--table` also writes the HD garnish table the live
 * renderer imports (packages/hd-renderer/src/live/effectTable.ts): ids and numbers only, no art. The sidecar is derived
 * game data and must never be committed; no other hd:* tool writes into its directory.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { THEATERS, type TheaterId } from '../theater.ts';
import { ALL_EFFECT_THEATERS, extractEffects, renderEffectTable } from '../node/effectsLibrary.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    game: { type: 'string', default: join(repoRoot, 'game/ra2') },
    theater: { type: 'string', multiple: true },
    out: { type: 'string', default: join(repoRoot, 'gameres/hd-cache/_library/common/effects') },
    table: { type: 'string' },
  },
});
const theaters = (values.theater ?? []).flatMap((t) => t.split(',')).map((t) => t.trim().toLowerCase());
const unknown = theaters.filter((t) => !(t in THEATERS));
if (unknown.length) {
  console.error(`unknown theater(s) ${unknown.join(', ')}; expected ${ALL_EFFECT_THEATERS.join(', ')}`);
  process.exit(2);
}
const result = extractEffects({
  gameDir: resolve(values.game!),
  outDir: resolve(values.out!),
  theaters: theaters as TheaterId[],
});
if (values.table) {
  // pnpm runs package scripts in the package directory; resolve against where the command was typed.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.table);
  writeFileSync(file, renderEffectTable(result.table, result.rulesTable));
  console.log(`table: ${Object.keys(result.table).length} rows -> ${file}`);
}
console.log(`-> ${result.dir}`);
