/** Synthetic orchestration fixtures: no game resources, model weights, Python or GPU are used. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HdCacheManifest, SpriteAtlasHdRef, TerrainMapRef } from '../src/manifest.ts';
import { encodePng } from '../src/node/png.ts';
import {
  chooseScale,
  planPrepareMap,
  prepareMap,
  resolveMapId,
  type PrepareContext,
  type PrepareLog,
  type PrepareRunners,
  type PrepareStep,
} from '../src/node/prepareMap.ts';
import { buildRematCommand } from '../src/node/prepareMapRunners.ts';

const directories: string[] = [];
const steps: PrepareStep[] = ['extract', 'terrain', 'upscale', 'sprites', 'library', 'library-sprites'];
const sourceTime = new Date('2020-01-01T00:00:00Z');
const outputTime = new Date('2020-01-02T00:00:00Z');

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporary() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ra2-prepare-map-'));
  directories.push(repoRoot);
  return {
    repoRoot,
    cacheDir: join(repoRoot, 'cache'),
    gameDir: join(repoRoot, 'install'),
    map: 'Synthetic.MAP',
    log: vi.fn(),
    warn: vi.fn(),
  };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function png(file: string, width = 4, height = 2, time = sourceTime): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng({ width, height, channels: 4, data: new Uint8Array(width * height * 4) }));
  utimesSync(file, time, time);
}

function sourceManifest(): HdCacheManifest {
  return {
    version: 1,
    name: 'Synthetic map',
    source: 'Synthetic.MAP',
    theater: 'temperate',
    grid: { width: 1, height: 1 },
    cells: {
      exists: Buffer.from([1]).toString('base64'),
      height: Buffer.from([0]).toString('base64'),
      tile: Buffer.from([0, 0]).toString('base64'),
    },
    tiles: [
      { file: 'synthetic.tem', subTile: 0, height: 0, rampType: 0, terrainType: 0, rect: [0, 0, 4, 2], anchor: [0, 0] },
    ],
    terrainAtlas: { file: 'terrain.png', width: 4, height: 2 },
    spriteAtlas: { file: 'sprites.png', width: 4, height: 2 },
    palettes: { unit: 'palettes/unit.png' },
    sprites: {
      'tree:SYNTHETIC': {
        palette: 'unit',
        remap: false,
        canvas: [4, 2],
        frames: [{ rect: [0, 0, 4, 2], offset: [0, 0] }],
      },
    },
    voxels: {},
    objects: [],
    waypoints: [],
  };
}

function writeSources(mapDir: string): void {
  png(join(mapDir, 'terrain.png'));
  png(join(mapDir, 'sprites.png'));
  png(join(mapDir, 'palettes/unit.png'), 256, 1);
  writeJson(join(mapDir, 'manifest.json'), sourceManifest());
}

function writeTerrain(mapDir: string, scale: number): TerrainMapRef {
  const suffix = scale === 1 ? '' : `@${scale}x`;
  const ref: TerrainMapRef = {
    file: `terrain-map${suffix}.png`,
    waterMask: `terrain-water${suffix}.png`,
    scale,
    originX: 0,
    originY: 0,
    width: 4 * scale,
    height: 2 * scale,
  };
  png(join(mapDir, ref.file), ref.width, ref.height, outputTime);
  png(join(mapDir, ref.waterMask!), ref.width, ref.height, outputTime);
  const file = join(mapDir, 'manifest.json');
  writeJson(file, { ...readJson<HdCacheManifest>(file), terrainMap: ref });
  return ref;
}

function writeSpriteHd(dir: string, stem = 'sprites'): SpriteAtlasHdRef {
  const ref: SpriteAtlasHdRef = {
    file: `${stem}@2x.png`,
    remap: `${stem}@2x-remap.png`,
    scale: 2,
    width: 8,
    height: 4,
  };
  png(join(dir, ref.file), ref.width, ref.height, outputTime);
  png(join(dir, ref.remap), ref.width, ref.height, outputTime);
  return ref;
}

/** A dedicated 4x redraw page (python/sprite_hd_pages.py) over a 4x2 indexed library page. */
function write4x(dir: string, page: number): SpriteAtlasHdRef {
  const ref: SpriteAtlasHdRef = {
    file: `sprites-${page}@4x.png`,
    remap: `sprites-${page}@4x-remap.png`,
    scale: 4,
    width: 16,
    height: 8,
  };
  png(join(dir, ref.file), ref.width, ref.height, sourceTime);
  png(join(dir, ref.remap), ref.width, ref.height, sourceTime);
  return ref;
}

interface SyntheticLibrary {
  version: number;
  theater: string;
  spriteAtlases: { file: string; width: number; height: number }[];
  spriteAtlasesHd: (SpriteAtlasHdRef | null)[];
  palettes: Record<string, string>;
  sprites: HdCacheManifest['sprites'];
}

function writeLibrary(cacheDir: string, pages = 3): string {
  const dir = join(cacheDir, '_library', 'temperate');
  const spriteAtlases = Array.from({ length: pages }, (_, page) => {
    const file = `sprites-${page}.png`;
    png(join(dir, file));
    return { file, width: 4, height: 2 };
  });
  png(join(dir, 'palettes/unit.png'), 256, 1);
  writeJson(join(dir, 'library.json'), {
    version: 1,
    theater: 'temperate',
    spriteAtlases,
    spriteAtlasesHd: spriteAtlases.map(() => null),
    palettes: { unit: 'palettes/unit.png' },
    sprites: sourceManifest().sprites,
  } satisfies SyntheticLibrary);
  return dir;
}

function fixture() {
  const options = temporary();
  const mapDir = join(options.cacheDir, 'Synthetic');
  writeSources(mapDir);
  writeTerrain(mapDir, 1);
  writeTerrain(mapDir, 2);
  const manifestFile = join(mapDir, 'manifest.json');
  writeJson(manifestFile, { ...readJson<HdCacheManifest>(manifestFile), spriteAtlasHd: writeSpriteHd(mapDir) });
  return { options, mapDir, manifestFile };
}

function fakeRunners(calls: PrepareStep[]): PrepareRunners {
  const record = (step: PrepareStep, fn: (context: PrepareContext) => void): PrepareRunners[PrepareStep] => {
    return (context) => {
      calls.push(step);
      fn(context);
    };
  };
  return {
    extract: record('extract', ({ mapDir }) => writeSources(mapDir)),
    terrain: record('terrain', ({ mapDir }) => void writeTerrain(mapDir, 1)),
    upscale: (context, plan) => {
      calls.push('upscale');
      writeTerrain(context.mapDir, plan.scale ?? context.scale);
    },
    sprites: record('sprites', ({ mapDir }) => {
      const file = join(mapDir, 'manifest.json');
      writeJson(file, { ...readJson<HdCacheManifest>(file), spriteAtlasHd: writeSpriteHd(mapDir) });
    }),
    library: record('library', ({ cacheDir }) => void writeLibrary(cacheDir)),
    'library-sprites': (context, plan) => {
      calls.push('library-sprites');
      const dir = join(context.cacheDir, '_library', plan.theater ?? 'temperate');
      const file = join(dir, 'library.json');
      const library = readJson<SyntheticLibrary>(file);
      for (const page of plan.pages ?? []) library.spriteAtlasesHd[page] = writeSpriteHd(dir, `sprites-${page}`);
      writeJson(file, library);
    },
    remat: record('remat', () => undefined),
  };
}

describe('prepare-map planning', () => {
  it.each([
    ['XMP29U2.MAP', 'XMP29U2'],
    ['RiverRam.yro', 'RiverRam'],
    ['/synthetic/maps/Some Map.mpr', 'Some Map'],
    ['RiverRam', 'RiverRam'],
  ])('resolves the map stem of %s', (input, expected) => {
    expect(resolveMapId(input)).toBe(expected);
  });

  it('defaults to all six non-remat steps and defers unavailable metadata without writing during dry run', async () => {
    const options = temporary();
    const calls: PrepareStep[] = [];
    const plan = planPrepareMap(options);
    expect(plan.map(({ step }) => step)).toEqual(steps);
    expect(plan.every(({ action }) => action === 'run')).toBe(true);
    await prepareMap({ ...options, dryRun: true }, fakeRunners(calls));
    expect(calls).toEqual([]);
    expect(existsSync(options.cacheDir)).toBe(false);
    expect(options.log).toHaveBeenCalled();
  });

  it('selects only explicit steps in dependency order, with remat opt-in', () => {
    const { options } = fixture();
    expect(
      planPrepareMap({ ...options, steps: ['remat', 'sprites', 'upscale', 'terrain'] }).map(({ step }) => step),
    ).toEqual(['terrain', 'upscale', 'sprites', 'remat']);
    expect(planPrepareMap({ ...options, steps: ['sprites'] }).map(({ step }) => step)).toEqual(['sprites']);
  });

  it('does not re-extract an existing cache even when the original map is newer', () => {
    const { options, mapDir } = fixture();
    const map = join(options.gameDir, 'Synthetic.MAP');
    mkdirSync(options.gameDir, { recursive: true });
    writeFileSync(map, '[Map]\nTheater=TEMPERATE\n');
    expect(planPrepareMap({ ...options, map, steps: ['extract'] })[0]).toMatchObject({
      step: 'extract',
      action: 'skip',
    });
    rmSync(join(mapDir, 'manifest.json'));
    expect(planPrepareMap({ ...options, steps: ['extract'] })[0]).toMatchObject({ step: 'extract', action: 'skip' });
  });

  it('checks terrain and sprite output masks, source mtimes and the requested terrain scale', () => {
    const { options, mapDir } = fixture();
    const selected: PrepareStep[] = ['terrain', 'upscale', 'sprites'];
    expect(planPrepareMap({ ...options, steps: selected }).map(({ action }) => action)).toEqual([
      'skip',
      'skip',
      'skip',
    ]);
    rmSync(join(mapDir, 'terrain-water@2x.png'));
    rmSync(join(mapDir, 'sprites@2x-remap.png'));
    expect(planPrepareMap({ ...options, steps: selected }).map(({ action }) => action)).toEqual(['skip', 'run', 'run']);
    writeTerrain(mapDir, 2);
    writeSpriteHd(mapDir);
    const newer = new Date('2020-01-03T00:00:00Z');
    utimesSync(join(mapDir, 'terrain.png'), newer, newer);
    utimesSync(join(mapDir, 'palettes/unit.png'), newer, newer);
    expect(planPrepareMap({ ...options, steps: selected }).map(({ action }) => action)).toEqual(['run', 'run', 'run']);
    expect(planPrepareMap({ ...options, steps: ['upscale'], scale: 3 })[0]).toMatchObject({ action: 'run', scale: 3 });
  });

  it('preserves existing libraries under force and selects only incomplete or stale sprite pages', () => {
    const { options } = fixture();
    const dir = writeLibrary(options.cacheDir, 4);
    const file = join(dir, 'library.json');
    const library = readJson<SyntheticLibrary>(file);
    library.spriteAtlasesHd = [
      writeSpriteHd(dir, 'sprites-0'),
      null,
      writeSpriteHd(dir, 'sprites-2'),
      writeSpriteHd(dir, 'sprites-3'),
    ];
    writeJson(file, library);
    rmSync(join(dir, library.spriteAtlasesHd[2]!.remap));
    const newer = new Date('2020-01-03T00:00:00Z');
    utimesSync(join(dir, 'sprites-3.png'), newer, newer);
    const plan = planPrepareMap({ ...options, steps: ['library', 'library-sprites'], force: true });
    expect(plan[0]).toMatchObject({ step: 'library', action: 'skip' });
    expect(plan[1]).toMatchObject({ step: 'library-sprites', action: 'run', pages: [1, 2, 3] });
  });

  it('never schedules a library page published at another scale, even when it looks stale by 2x rules', () => {
    const { options } = fixture();
    const dir = writeLibrary(options.cacheDir, 4);
    const file = join(dir, 'library.json');
    const library = readJson<SyntheticLibrary>(file);
    library.spriteAtlasesHd = [writeSpriteHd(dir, 'sprites-0'), null, writeSpriteHd(dir, 'sprites-2'), write4x(dir, 3)];
    writeJson(file, library);
    // The 4x page is older than its source atlas: by the 2x freshness rules it would be rebuilt (and hd:sprites
    // refuses that), so the planner must leave it to its packer.
    const newer = new Date('2020-01-03T00:00:00Z');
    utimesSync(join(dir, 'sprites-3.png'), newer, newer);
    const plan = planPrepareMap({ ...options, steps: ['library-sprites'] });
    expect(plan[0]).toMatchObject({ step: 'library-sprites', action: 'run', pages: [1] });
  });

  it('rejects a missing unselected dependency without launching a runner', async () => {
    const options = temporary();
    const runner = vi.fn();
    await expect(prepareMap({ ...options, steps: ['sprites'] }, { sprites: runner })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('prepare-map execution', () => {
  it('runs the whole default pipeline, records timings and versions, then skips every completed step', async () => {
    const options = temporary();
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    const first = await prepareMap(options, runners);
    expect(calls).toEqual(steps);
    expect(first.steps.map(({ status }) => status)).toEqual(steps.map(() => 'done'));
    expect(first.steps.every(({ elapsedMs }) => elapsedMs >= 0 && Number.isFinite(elapsedMs))).toBe(true);
    expect(Object.keys(first.versions).length).toBeGreaterThan(0);
    const logFile = join(options.cacheDir, 'Synthetic', 'prepare.json');
    expect(readJson<PrepareLog>(logFile)).toMatchObject({ versions: first.versions, steps: first.steps });
    calls.length = 0;
    const second = await prepareMap(options, runners);
    expect(calls).toEqual([]);
    expect(second.steps.map(({ status }) => status)).toEqual(steps.map(() => 'skipped'));
  });

  it('reruns terrain and upscale after terrain metadata changes without invalidating unrelated sprite outputs', async () => {
    const options = temporary();
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    await prepareMap(options, runners);
    const file = join(options.cacheDir, 'Synthetic', 'manifest.json');
    const manifest = readJson<HdCacheManifest>(file);
    manifest.tiles[0]!.terrainType = 9;
    writeJson(file, manifest);
    calls.length = 0;
    await prepareMap(options, runners);
    expect(calls).toEqual(['terrain', 'upscale']);
    calls.length = 0;
    await prepareMap(options, runners);
    expect(calls).toEqual([]);
  });

  it('warns when the chosen terrain output exceeds the WebGPU default texture limit', async () => {
    const { options, mapDir } = fixture();
    png(join(mapDir, 'terrain-map.png'), 5000, 2);
    png(join(mapDir, 'terrain-water.png'), 5000, 2);
    const runner = vi.fn();
    await prepareMap({ ...options, steps: ['upscale'] }, { upscale: runner });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[1]).toMatchObject({ scale: 2 });
    expect(options.warn.mock.calls.map(([message]) => message).join('\n')).toMatch(/8192/);
  });

  it('fits a terrain too wide for the requested scale at a fractional scale and skips it once current', async () => {
    const { options, mapDir } = fixture();
    png(join(mapDir, 'terrain-map.png'), 9300, 2);
    png(join(mapDir, 'terrain-water.png'), 9300, 2);
    const scale = 451 / 256;
    expect(planPrepareMap({ ...options, steps: ['upscale'] })[0]).toMatchObject({
      action: 'run',
      scale,
      reason: `upscale terrain 9300x2 at ${scale}x (16384x4), fitted from 2x to 16384 px per side`,
    });
    const runner = vi.fn<PrepareRunners['upscale']>((context) => {
      const ref: TerrainMapRef = {
        file: 'terrain-map@2x-fit.png',
        waterMask: 'terrain-water@2x-fit.png',
        scale,
        originX: 0,
        originY: 0,
        width: 16384,
        height: 4,
      };
      png(join(context.mapDir, ref.file), 1, 1, outputTime);
      png(join(context.mapDir, ref.waterMask!), 1, 1, outputTime);
      const file = join(context.mapDir, 'manifest.json');
      writeJson(file, { ...readJson<HdCacheManifest>(file), terrainMap: ref });
    });
    await prepareMap({ ...options, steps: ['upscale'] }, { upscale: runner });
    expect(runner.mock.calls[0]?.[1]).toMatchObject({ scale });
    expect(options.warn.mock.calls.map(([message]) => message).join('\n')).toContain(
      `Reduced scale from 2 to ${scale} (16384x4) to stay within 16384 px per side.`,
    );
    expect(planPrepareMap({ ...options, steps: ['upscale'] })[0]).toMatchObject({
      action: 'skip',
      reason: 'upscaled terrain and mask are current',
    });
  });

  it('merges valid HD references and unknown fields back after extraction, keeping freshly extracted fields authoritative', async () => {
    const { options, mapDir, manifestFile } = fixture();
    const previous = readJson<HdCacheManifest>(manifestFile);
    png(join(mapDir, 'future.png'));
    const extras = {
      futureSettings: { enabled: true, label: 'preserve this setting' },
      futureImage: { file: 'future.png', version: 7 },
      missingImage: { file: 'absent.png' },
    };
    writeJson(manifestFile, { ...previous, ...extras, name: 'old name', objects: [{ stale: true }] });
    await prepareMap(
      { ...options, force: true, steps: ['extract'] },
      { extract: ({ mapDir: dir }) => writeSources(dir) },
    );
    const result = readJson<Record<string, unknown>>(manifestFile);
    expect(result).toMatchObject({
      name: sourceManifest().name,
      objects: [],
      terrainMap: previous.terrainMap,
      spriteAtlasHd: previous.spriteAtlasHd,
      futureSettings: extras.futureSettings,
      futureImage: extras.futureImage,
    });
    expect(result).not.toHaveProperty('missingImage');
  });

  it('drops incomplete old HD references when a re-extraction cannot preserve every referenced file', async () => {
    const { options, mapDir, manifestFile } = fixture();
    rmSync(join(mapDir, 'terrain-water@2x.png'));
    rmSync(join(mapDir, 'sprites@2x-remap.png'));
    await prepareMap(
      { ...options, force: true, steps: ['extract'] },
      { extract: ({ mapDir: dir }) => writeSources(dir) },
    );
    const result = readJson<Record<string, unknown>>(manifestFile);
    expect(result).not.toHaveProperty('terrainMap');
    expect(result).not.toHaveProperty('spriteAtlasHd');
  });

  it('exposes preserved extensions to dependent steps and reruns selected map steps after re-extraction', async () => {
    const { options, manifestFile } = fixture();
    writeJson(manifestFile, { ...readJson<HdCacheManifest>(manifestFile), customSetting: { keep: 1 } });
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    const terrain = runners.terrain;
    runners.terrain = (context, plan) => {
      expect(readJson<Record<string, unknown>>(manifestFile).customSetting).toEqual({ keep: 1 });
      expect(readJson<HdCacheManifest>(manifestFile).spriteAtlasHd).toBeDefined();
      return terrain(context, plan);
    };
    await prepareMap({ ...options, force: true, steps: ['extract', 'terrain', 'upscale', 'sprites'] }, runners);
    expect(calls).toEqual(['extract', 'terrain', 'upscale', 'sprites']);
  });

  it('refuses stale omitted terrain after extract-only runs and recovers when terrain and upscale are selected', async () => {
    const { options } = fixture();
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    await prepareMap({ ...options, force: true, steps: ['extract'] }, runners);
    calls.length = 0;
    await expect(prepareMap({ ...options, steps: ['upscale'] }, runners)).rejects.toThrow(/include terrain/);
    await expect(prepareMap({ ...options, steps: ['remat'] }, runners)).rejects.toThrow(/include terrain/);
    expect(calls).toEqual([]);
    await prepareMap({ ...options, steps: ['terrain', 'upscale'] }, runners);
    expect(calls).toEqual(['terrain', 'upscale']);
    expect(planPrepareMap({ ...options, steps: ['terrain', 'upscale'] }).map(({ action }) => action)).toEqual([
      'skip',
      'skip',
    ]);
    calls.length = 0;
    await prepareMap({ ...options, steps: ['remat'] }, runners);
    expect(calls).toEqual(['remat']);
  });

  it('keeps a failed extraction cache protected until force is explicitly supplied', async () => {
    const options = temporary();
    await expect(
      prepareMap(
        { ...options, steps: ['extract'] },
        {
          extract: () => {
            throw new Error('synthetic extraction failure');
          },
        },
      ),
    ).rejects.toThrow('synthetic extraction failure');
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    const retry = await prepareMap({ ...options, steps: ['extract'] }, runners);
    expect(calls).toEqual([]);
    expect(retry.steps[0]).toMatchObject({ step: 'extract', status: 'skipped' });
    expect(retry.steps[0]?.reason).toMatch(/incomplete.*force/i);
    await prepareMap({ ...options, force: true, steps: ['extract'] }, runners);
    expect(calls).toEqual(['extract']);
    expect(existsSync(join(options.cacheDir, 'Synthetic', 'manifest.json'))).toBe(true);
  });

  it('retains individually published library sprite pages after a later page fails and resumes only missing pages', async () => {
    const { options } = fixture();
    const dir = writeLibrary(options.cacheDir);
    const file = join(dir, 'library.json');
    await expect(
      prepareMap(
        { ...options, steps: ['library-sprites'] },
        {
          'library-sprites': (_context, plan) => {
            expect(plan.pages).toEqual([0, 1, 2]);
            const library = readJson<SyntheticLibrary>(file);
            library.spriteAtlasesHd[0] = writeSpriteHd(dir, 'sprites-0');
            writeJson(file, library);
            throw new Error('synthetic second page failure');
          },
        },
      ),
    ).rejects.toThrow('synthetic second page failure');
    const first = readJson<SyntheticLibrary>(file).spriteAtlasesHd[0];
    const firstOutput = readFileSync(join(dir, first!.file));
    expect(planPrepareMap({ ...options, steps: ['library-sprites'] })[0]).toMatchObject({
      action: 'run',
      pages: [1, 2],
    });
    const calls: PrepareStep[] = [];
    const runners = fakeRunners(calls);
    const resume = runners['library-sprites'];
    runners['library-sprites'] = (context, plan) => {
      expect(plan.pages).toEqual([1, 2]);
      return resume(context, plan);
    };
    await prepareMap({ ...options, steps: ['library-sprites'] }, runners);
    expect(calls).toEqual(['library-sprites']);
    expect(readJson<SyntheticLibrary>(file).spriteAtlasesHd[0]).toEqual(first);
    expect(readFileSync(join(dir, first!.file))).toEqual(firstOutput);
    expect(planPrepareMap({ ...options, steps: ['library-sprites'] })[0]).toMatchObject({ action: 'skip' });
  });

  it('prepares a fresh map on a library holding a 4x page without touching that page (real runners)', async () => {
    // Regression: the 2x-only freshness check marked the 4x page stale, so the real library-sprites runner asked
    // upscaleSprites for it explicitly and preparing any new map failed with "holds a 4x HD page".
    const { options } = fixture();
    const dir = writeLibrary(options.cacheDir, 3);
    const file = join(dir, 'library.json');
    const library = readJson<SyntheticLibrary>(file);
    library.spriteAtlasesHd = [writeSpriteHd(dir, 'sprites-0'), writeSpriteHd(dir, 'sprites-1'), write4x(dir, 2)];
    writeJson(file, library);
    const before = readFileSync(file, 'utf8');
    const log = await prepareMap({ ...options, steps: ['library-sprites'] });
    expect(log.steps[0]).toMatchObject({ step: 'library-sprites', status: 'skipped' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('records failed steps and retries them rather than publishing a successful log', async () => {
    const { options, mapDir } = fixture();
    rmSync(join(mapDir, 'terrain-map@2x.png'));
    const error = new Error('synthetic inference failure');
    await expect(
      prepareMap(
        { ...options, steps: ['upscale'] },
        {
          upscale: ({ mapDir: dir }) => {
            writeTerrain(dir, 2);
            throw error;
          },
        },
      ),
    ).rejects.toThrow('synthetic inference failure');
    const failed = readJson<PrepareLog>(join(mapDir, 'prepare.json'));
    expect(failed.steps).toHaveLength(1);
    expect(failed.steps[0]).toMatchObject({ step: 'upscale', status: 'failed', error: 'synthetic inference failure' });
    const calls: PrepareStep[] = [];
    const retry = await prepareMap({ ...options, steps: ['upscale'] }, fakeRunners(calls));
    expect(calls).toEqual(['upscale']);
    expect(retry.steps[0]).toMatchObject({ step: 'upscale', status: 'done' });
  });

  it('keeps rematerialization anchored to the original upscale input across skips and forced repeats', async () => {
    const { options, mapDir, manifestFile } = fixture();
    const inputs: (string | undefined)[] = [];
    const remat: PrepareRunners['remat'] = (_context, plan) => {
      inputs.push(plan.input);
      const manifest = readJson<HdCacheManifest>(manifestFile);
      const file = inputs.length === 1 ? 'terrain-map@2x-remat.png' : 'terrain-map@2x-remat-2.png';
      png(join(mapDir, file), 8, 4, outputTime);
      writeJson(manifestFile, { ...manifest, terrainMap: { ...manifest.terrainMap, file } });
    };
    await prepareMap({ ...options, steps: ['remat'] }, { remat });
    expect(inputs).toEqual(['terrain-map@2x.png']);
    const second = await prepareMap({ ...options, steps: ['upscale', 'remat'] }, { remat });
    expect(second.steps.map(({ status }) => status)).toEqual(['skipped', 'skipped']);
    await prepareMap({ ...options, steps: ['remat'], force: true }, { remat });
    expect(inputs).toEqual(['terrain-map@2x.png', 'terrain-map@2x.png']);
    expect(readJson<HdCacheManifest>(manifestFile).terrainMap?.file).toBe('terrain-map@2x-remat-2.png');
    expect(planPrepareMap({ ...options, steps: ['upscale', 'remat'] }).map(({ action }) => action)).toEqual([
      'skip',
      'skip',
    ]);
  });
});

describe('local rematerialization command', () => {
  function command(theater: HdCacheManifest['theater']) {
    const options = temporary();
    const context: PrepareContext = {
      ...options,
      mapId: 'Synthetic',
      mapDir: join(options.cacheDir, 'Synthetic'),
      bin: join(options.repoRoot, 'custom-realesrgan'),
      scale: 2,
      force: false,
    };
    return {
      options,
      ...buildRematCommand(context, {
        step: 'remat',
        action: 'run',
        reason: 'synthetic test',
        theater,
        input: 'terrain-map@2x.png',
      }),
    };
  }

  it('uses only the repository venv and requested model parameters with resume enabled', () => {
    const { options, bin, args } = command('temperate');
    expect(bin).toBe(join(options.repoRoot, 'gameres/tools/diffusion/.venv/bin/python'));
    expect(args).toContain(join(options.repoRoot, 'packages/ra2-assets/python/rematerialize.py'));
    for (const [flag, value] of [
      ['--cache', options.cacheDir],
      ['--map', 'Synthetic'],
      ['--input', 'terrain-map@2x.png'],
      ['--models', join(options.repoRoot, 'gameres/tools/diffusion/models')],
      ['--strength', '0.55'],
      ['--control', '0.7'],
      ['--guidance', '5.5'],
      ['--steps', '28'],
    ]) {
      expect(args[args.indexOf(flag!) + 1]).toBe(value);
    }
    expect(args).toContain('--resume');
    expect(existsSync(join(options.repoRoot, 'gameres'))).toBe(false);
  });

  it.each(['urban', 'newurban'] as const)('keeps the default negative prompt for %s', (theater) => {
    expect(command(theater).args).not.toContain('--negative-prompt');
  });

  it.each(['temperate', 'snow', 'desert', 'lunar'] as const)('extends the negative prompt for %s', (theater) => {
    const { args } = command(theater);
    const negative = args[args.indexOf('--negative-prompt') + 1];
    expect(negative).toContain('blurry');
    expect(negative).toContain('cracked earth, dried mud cracks, cobblestones, paving stones, tiles, bricks');
  });

  it('keeps the natural-theater prefix synchronized with the Python default negative prompt', () => {
    const python = readFileSync(new URL('../python/rematerialize.py', import.meta.url), 'utf8');
    const literals = python.match(/^NEGATIVE_PROMPT = \(([\s\S]*?)^\)/m)?.[1]?.match(/"(?:\\.|[^"\\])*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    const defaultNegative = literals.map((literal) => JSON.parse(literal) as string).join('');
    const { args } = command('temperate');
    expect(args[args.indexOf('--negative-prompt') + 1]).toBe(
      `${defaultNegative}, cracked earth, dried mud cracks, cobblestones, paving stones, tiles, bricks`,
    );
  });
});

describe('terrain scale selection', () => {
  it.each([
    [4096, 4096, 4, 4],
    [5000, 1000, 4, 838 / 256],
    [5461, 1000, 4, 3],
    [8192, 5000, 2, 2],
    [8193, 1000, 2, 511 / 256],
    [9300, 2505, 2, 451 / 256],
    [1000, 16384, 4, 1],
    [100, 100, 2, 2],
  ])(
    'chooses the requested scale or the largest fitting one for %ix%i requested at %ix',
    (width, height, requested, expected) => {
      expect(chooseScale(width, height, requested)).toBe(expected);
    },
  );

  it.each([
    [16385, 1, 2],
    [1, 16385, 2],
    [0, 10, 2],
    [10, 10, 0],
    [10, 10, 1.5],
    [10, 10, Number.NaN],
  ])('rejects dimensions or scales without a valid integer output: %s, %s, %s', (width, height, scale) => {
    expect(() => chooseScale(width, height, scale)).toThrow();
  });
});
