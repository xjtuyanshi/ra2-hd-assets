/** Production adapters for the incremental map preparation planner. */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { extractMap } from './extract.ts';
import { extractLibrary } from './library.ts';
import type { PlannedStep, PrepareContext, PrepareRunners } from './prepareMap.ts';
import { upscaleSprites, type SpriteHdPageResult } from './spriteHdCache.ts';
import { renderTerrainMap } from './terrainMap.ts';
import { upscaleTerrainMap } from './upscale.ts';

const MAP_EXTENSION = /\.(map|mpr|yrm|yro|mmx)$/i;
// Keep synchronized with NEGATIVE_PROMPT in python/rematerialize.py; urban theaters use Python's default.
const REMAT_NEGATIVE_PROMPT =
  'blurry, painting, cartoon, text, watermark, people, buildings, vehicles, trees, ' +
  'perspective, lens distortion, oversaturated';
const NATURAL_TERRAIN_NEGATIVE = 'cracked earth, dried mud cracks, cobblestones, paving stones, tiles, bricks';

function stem(file: string): string {
  return basename(file, extname(file));
}

function findLooseFile(file: string, gameDir: string): string | undefined {
  for (const path of [resolve(file), resolve(gameDir, file)]) {
    if (existsSync(path) && statSync(path).isFile()) return path;
    const dir = dirname(path);
    if (!existsSync(dir)) continue;
    const match = readdirSync(dir).find((entry) => entry.toLowerCase() === basename(path).toLowerCase());
    if (match && statSync(join(dir, match)).isFile()) return join(dir, match);
  }
  return undefined;
}

/** Bare cache ids reuse the recorded source, then loose map stems, then the game's archived .map name. */
export function resolveMapInput(context: PrepareContext): string {
  if (MAP_EXTENSION.test(context.map)) return findLooseFile(context.map, context.gameDir) ?? context.map;

  const manifestFile = join(context.mapDir, 'manifest.json');
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { source?: unknown };
    if (
      typeof manifest.source === 'string' &&
      MAP_EXTENSION.test(manifest.source) &&
      stem(manifest.source).toLowerCase() === context.mapId.toLowerCase()
    ) {
      return findLooseFile(manifest.source, context.gameDir) ?? manifest.source;
    }
  }

  for (const dir of new Set([dirname(resolve(context.map)), context.gameDir])) {
    if (!existsSync(dir)) continue;
    const matches = readdirSync(dir).filter(
      (entry) =>
        MAP_EXTENSION.test(entry) &&
        stem(entry).toLowerCase() === context.mapId.toLowerCase() &&
        statSync(join(dir, entry)).isFile(),
    );
    if (matches.length > 1)
      throw new Error(`Ambiguous map id ${context.mapId}: ${matches.join(', ')} in ${dir}; use an explicit map file`);
    if (matches.length === 1) return join(dir, matches[0]!);
  }
  return `${context.mapId}.map`;
}

/** Exposed separately so command routing and parameters can be tested without starting Python. */
export function buildRematCommand(context: PrepareContext, plan: PlannedStep): { bin: string; args: string[] } {
  if (!plan.theater) throw new Error('remat requires the map theater');
  if (!plan.input) throw new Error('remat requires an explicit terrain input');
  const diffusion = join(context.repoRoot, 'gameres/tools/diffusion');
  const args = [
    '-B',
    join(context.repoRoot, 'packages/ra2-assets/python/rematerialize.py'),
    '--cache',
    context.cacheDir,
    '--map',
    context.mapId,
    '--models',
    join(diffusion, 'models'),
    '--input',
    plan.input,
    '--strength',
    '0.55',
    '--control',
    '0.7',
    '--guidance',
    '5.5',
    '--steps',
    '28',
    '--resume',
  ];
  if (plan.theater !== 'urban' && plan.theater !== 'newurban')
    args.push('--negative-prompt', `${REMAT_NEGATIVE_PROMPT}, ${NATURAL_TERRAIN_NEGATIVE}`);
  return { bin: join(diffusion, '.venv/bin/python'), args };
}

function logSpritePage(context: PrepareContext, result: SpriteHdPageResult): void {
  context.log(
    `  page ${result.page}: ${result.frames} frames, ${result.batches} batches, ` +
      `${(result.inputPixels / 1e6).toFixed(2)} input MP, ${(result.elapsedMs / 1000).toFixed(2)} s ` +
      `(binary ${(result.binaryMs / 1000).toFixed(2)} s) -> ${result.ref.file}, ${result.ref.remap}`,
  );
}

export const defaultPrepareRunners: PrepareRunners = {
  extract(context) {
    const map = resolveMapInput(context);
    context.log(`  source ${map}`);
    // loadMap derives its output id from the actual filename. Preserve the caller's cache directory spelling.
    const stage = stem(map) !== context.mapId;
    mkdirSync(context.cacheDir, { recursive: true });
    const outDir = stage ? mkdtempSync(join(context.cacheDir, '.prepare-extract-')) : context.cacheDir;
    try {
      const result = extractMap({ gameDir: context.gameDir, map, outDir, log: context.log });
      if (stage) cpSync(result.dir, context.mapDir, { recursive: true });
      context.log(`  ${result.manifest.grid.width}x${result.manifest.grid.height} cells -> ${context.mapDir}`);
    } finally {
      if (stage) rmSync(outDir, { recursive: true, force: true });
    }
  },
  terrain(context) {
    const result = renderTerrainMap({ cacheDir: context.mapDir });
    context.log(`  ${result.width}x${result.height} -> ${result.file}, ${result.waterMask}`);
  },
  async upscale(context, plan) {
    if (plan.scale === undefined) throw new Error('upscale requires a planned scale');
    // The upscaler fits the requested scale exactly as the planner did (terrainScale.ts).
    const result = await upscaleTerrainMap({ cacheDir: context.mapDir, scale: context.scale, bin: context.bin });
    if (result.scale !== plan.scale)
      throw new Error(`upscale produced scale ${result.scale}, but the plan expected ${plan.scale}`);
    context.log(`  ${result.width}x${result.height} (${result.scale}x) -> ${result.file}`);
  },
  async sprites(context) {
    await upscaleSprites({
      cacheDir: context.cacheDir,
      map: context.mapId,
      bin: context.bin,
      onPage: (result) => logSpritePage(context, result),
    });
  },
  library(context, plan) {
    if (!plan.theater) throw new Error('library requires the map theater');
    extractLibrary({
      gameDir: context.gameDir,
      outDir: join(context.cacheDir, '_library'),
      theaters: [plan.theater],
      log: context.log,
    });
  },
  async 'library-sprites'(context, plan) {
    if (!plan.theater) throw new Error('library-sprites requires the map theater');
    await upscaleSprites({
      cacheDir: context.cacheDir,
      library: plan.theater,
      ...(plan.pages !== undefined ? { pages: plan.pages } : {}),
      bin: context.bin,
      onPage: (result) => logSpritePage(context, result),
    });
  },
  async remat(context, plan) {
    const { bin, args } = buildRematCommand(context, plan);
    context.log(`  ${bin} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(bin, args, { stdio: 'inherit', shell: false });
      child.once('error', (error) => reject(new Error(`Cannot run rematerialization at ${bin}: ${error.message}`)));
      child.once('close', (code, signal) => {
        if (code === 0) resolveRun();
        else reject(new Error(`Rematerialization failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
      });
    });
  },
};
