/** Read-only SHP probe/export for the farm installer; uses the extractor's mount, decode and shadow policy. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GameInstall } from '../node/install.ts';
import { b64, decodeShp, shpShadowFrame } from '../node/artSource.ts';
import { splitShadowHalf } from '../art.ts';
import type { TypeLibrary } from '../library.ts';
import { THEATERS, type TheaterId } from '../theater.ts';

const { values } = parseArgs({
  options: { game: { type: 'string' }, library: { type: 'string' }, out: { type: 'string' } },
});
if (!values.game || !values.library || !values.out) throw new Error('Required: --game DIR --library DIR --out DIR');
const library = JSON.parse(readFileSync(join(values.library, 'library.json'), 'utf8')) as TypeLibrary;
const theater = library.theater as TheaterId;
if (!(theater in THEATERS)) throw new Error(`Unknown theater: ${theater}`);
const install = GameInstall.open(values.game, theater);
const sprites: Record<string, unknown> = {};
const audit: Record<string, unknown> = {};
for (const [id, entry] of Object.entries(library.sprites)) {
  if (!id.startsWith('infantry:')) continue;
  if (!entry.file) throw new Error(`${id}: missing source file`);
  const shp = install.shp(entry.file);
  if (!shp) throw new Error(`${id}: unreadable ${entry.file}`);
  // Unlike the permissive legacy decoder, refuse malformed frames in an installer.
  for (let i = 0; i < shp.count; i++) shp.frame(i);
  const decoded = decodeShp(shp);
  const split = splitShadowHalf(decoded);
  const indices = entry.sourceFrames ?? entry.frames.map((_, i) => i);
  if (indices.length !== entry.frames.length || entry.frameCount !== shp.count)
    throw new Error(`${id}: library/source frame count differs`);
  const frames = indices.map((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= split.body) throw new Error(`${id}: invalid body index ${i}`);
    const f = shpShadowFrame(decoded[i]!, split.hasShadows ? decoded[split.body + i] : undefined, 12);
    return {
      w: f.cx,
      h: f.cy,
      offset: [f.x - Math.floor(shp.cx / 2), f.y - Math.floor(shp.cy / 2)],
      pixels: b64(f.pixels),
    };
  });
  // Body/source metadata is a publication guard, not a replacement for the live library's other fields.
  sprites[id] = {
    file: entry.file,
    frameCount: entry.frameCount,
    sourceFrames: entry.sourceFrames,
    frames: entry.frames,
    shadows: frames,
  };
  const summarize = (start: number, end: number) => {
    const counts = new Map<number, number>();
    const nonempty: number[] = [];
    for (let i = start; i < end; i++) {
      const f = decoded[i]!;
      if (f.pixels.some((v) => v !== 0)) nonempty.push(i);
      for (const v of f.pixels) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return {
      nonemptyFrames: nonempty.length,
      firstFrame: nonempty[0],
      lastFrame: nonempty.at(-1),
      index1: counts.get(1) ?? 0,
      index12: counts.get(12) ?? 0,
    };
  };
  audit[id] = {
    file: entry.file,
    canvas: [shp.cx, shp.cy],
    total: shp.count,
    body: summarize(0, split.body),
    baked: summarize(split.body, shp.count),
    recovered: frames.filter((f) => f.w && f.h).length,
  };
}
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'frames.json'), JSON.stringify({ theater, sprites }));
writeFileSync(join(values.out, 'source-audit.json'), JSON.stringify(audit, null, 2));
for (const id of ['GI', 'INIT', 'SLAV', 'BRUTE', 'DOG'])
  console.log(`${theater} ${id}: ${JSON.stringify(audit[`infantry:${id}`])}`);
