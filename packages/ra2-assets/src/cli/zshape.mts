/** pnpm --filter ra2-assets zshape -- --game <player install> --out <staging dir> [--theater urban,snow] */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { THEATERS, type TheaterId } from '../theater.ts';
import { extractZShapeStaging } from '../node/zshape.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    game: { type: 'string' },
    out: { type: 'string' },
    theater: { type: 'string', multiple: true },
  },
});
const theaters = (values.theater ?? []).flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase());
if (!values.game || !values.out || theaters.some((theater) => !Object.hasOwn(THEATERS, theater))) {
  console.error(`usage: zshape --game <install> --out <staging> [--theater ${Object.keys(THEATERS).join(',')}]`);
  process.exit(2);
}
const patches = extractZShapeStaging({
  gameDir: resolve(values.game),
  outDir: resolve(values.out),
  theaters: theaters as TheaterId[],
});
for (const [theater, patch] of Object.entries(patches)) {
  const types = Object.values(patch.types);
  console.log(
    `${theater}: template ${patch.depthTemplate.width}x${patch.depthTemplate.height}; ` +
      `zShape ${types.filter((type) => type.zShape).length}, harvester ${types.filter((type) => type.harvester).length}, ` +
      `refinery ${types.filter((type) => type.refinery).length}, ` +
      `yDrawOffset ${Object.values(patch.layers).reduce((sum, layers) => sum + Object.keys(layers).length, 0)}`,
  );
}
console.log(`staging -> ${resolve(values.out)}`);
