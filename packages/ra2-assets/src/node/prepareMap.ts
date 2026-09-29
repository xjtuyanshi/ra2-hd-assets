/** Incremental, local-only orchestration. Image work remains owned by the existing asset steps. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HD_CACHE_VERSION, type HdCacheManifest, type SpriteAtlasHdRef } from '../manifest.ts';
import { TYPE_LIBRARY_VERSION, type TypeLibrary } from '../library.ts';
import { THEATERS, type TheaterId } from '../theater.ts';
import { terrainLayout } from './terrain.ts';
import { defaultPrepareRunners } from './prepareMapRunners.ts';

export const PREPARE_STEPS = [
  'extract',
  'terrain',
  'upscale',
  'sprites',
  'library',
  'library-sprites',
  'remat',
] as const;
export type PrepareStep = (typeof PREPARE_STEPS)[number];
export interface PrepareMapOptions {
  map: string;
  repoRoot?: string;
  gameDir?: string;
  cacheDir?: string;
  bin?: string;
  scale?: number;
  steps?: readonly PrepareStep[];
  force?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}
export interface PrepareContext {
  repoRoot: string;
  map: string;
  mapId: string;
  gameDir: string;
  cacheDir: string;
  mapDir: string;
  bin: string;
  scale: number;
  force: boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
}
export interface PlannedStep {
  step: PrepareStep;
  action: 'run' | 'skip';
  reason: string;
  scale?: number;
  pages?: number[];
  theater?: TheaterId;
  input?: string;
}
export type PrepareStepRunner = (context: PrepareContext, plan: PlannedStep) => void | Promise<void>;
export type PrepareRunners = Record<PrepareStep, PrepareStepRunner>;
interface Receipt {
  signature: string;
  input?: string;
  output?: string;
}
export interface PrepareLog {
  version: 1;
  mapId: string;
  startedAt: string;
  finishedAt?: string;
  versions: Record<string, string | number>;
  steps: (PlannedStep & { status: 'done' | 'skipped' | 'failed'; elapsedMs: number; error?: string })[];
  /** Last successful/skipped input signatures survive partial runs and failures. */
  state: Record<string, Receipt>;
}
type Manifest = HdCacheManifest & Record<string, unknown>;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveMapId(map: string): string {
  const id = basename(map).replace(/\.(yro|mmx|map|mpr|yrm)$/i, '');
  if (!id.trim() || id === '.' || id === '..' || /[\\/\0]/.test(id)) throw new Error('map must be a file or map id');
  return id;
}
function context(options: PrepareMapOptions): PrepareContext {
  const repoRoot = resolve(options.repoRoot ?? join(packageRoot, '../..'));
  const cacheDir = resolve(options.cacheDir ?? join(repoRoot, 'gameres/hd-cache'));
  const mapId = resolveMapId(options.map);
  const scale = options.scale ?? 2;
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw new RangeError('scale must be an integer from 1 to 4');
  return {
    repoRoot,
    map: options.map,
    mapId,
    cacheDir,
    mapDir: join(cacheDir, mapId),
    gameDir: resolve(options.gameDir ?? join(repoRoot, 'game/ra2')),
    bin: resolve(options.bin ?? join(repoRoot, 'gameres/tools/realesrgan/realesrgan-ncnn-vulkan')),
    scale,
    force: options.force ?? false,
    log: options.log ?? console.log,
    warn: options.warn ?? console.warn,
  };
}
function selection(options: PrepareMapOptions): PrepareStep[] {
  const steps = options.steps ?? PREPARE_STEPS.filter((step) => step !== 'remat');
  if (!steps.length || steps.some((step) => !PREPARE_STEPS.includes(step)) || new Set(steps).size !== steps.length)
    throw new Error(`steps must be distinct names from ${PREPARE_STEPS.join(',')}`);
  return PREPARE_STEPS.filter((step) => steps.includes(step));
}
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function writeJson(file: string, value: unknown): void {
  // Keep a complete previous document if the process stops during serialization/write.
  const temporary = `${file}.prepare-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}
function modified(file: string): number | undefined {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0 ? stat.mtimeMs : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function fresh(outputs: string[], inputs: string[]): boolean {
  const sourceTimes = inputs.map(modified);
  const outputTimes = outputs.map(modified);
  return (
    outputs.length > 0 &&
    [...sourceTimes, ...outputTimes].every((time) => time !== undefined) &&
    Math.min(...(outputTimes as number[])) >= Math.max(0, ...(sourceTimes as number[]))
  );
}
function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function compatible(state: Record<string, Receipt>, key: string, value: unknown): boolean {
  return !state[key] || state[key].signature === signature(value);
}
function terrainInputs(m: Manifest): unknown {
  return { grid: m.grid, cells: m.cells, tiles: m.tiles, terrainAtlas: m.terrainAtlas };
}
function spriteInputs(m: Manifest | TypeLibrary, page?: number): unknown {
  return {
    atlas: 'spriteAtlases' in m ? (m as TypeLibrary).spriteAtlases[page!] : m.spriteAtlas,
    sprites:
      page === undefined
        ? m.sprites
        : Object.fromEntries(
            Object.entries(m.sprites).filter(([, sprite]) =>
              [...sprite.frames, ...(sprite.shadows ?? [])].some((frame) => (frame.page ?? 0) === page),
            ),
          ),
    palettes: m.palettes,
  };
}
function hdFresh(
  dir: string,
  source: { file: string; width: number; height: number },
  ref: SpriteAtlasHdRef | null | undefined,
  palettes: Record<string, string>,
): boolean {
  return (
    !!ref &&
    ref.scale === 2 &&
    ref.width === source.width * 2 &&
    ref.height === source.height * 2 &&
    fresh(
      [join(dir, ref.file), join(dir, ref.remap)],
      [source.file, ...Object.values(palettes)].map((file) => join(dir, file)),
    )
  );
}

/** This pipeline reuses x4plus, whose supported output scales are 1..4. */
export function chooseScale(width: number, height: number, requestedScale: number): number {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new RangeError('Invalid terrain dimensions');
  if (!Number.isInteger(requestedScale) || requestedScale < 1 || requestedScale > 4)
    throw new RangeError('scale must be an integer from 1 to 4');
  const scale = Math.min(requestedScale, Math.floor(16384 / Math.max(width, height)));
  if (scale < 1) throw new RangeError(`Terrain ${width}x${height} exceeds 16384 px even at scale 1`);
  return scale;
}
function baseSize(ctx: PrepareContext, m: Manifest, rebuilding: boolean): [number, number] {
  const file = join(ctx.mapDir, 'terrain-map.png');
  if (!rebuilding && modified(file) !== undefined) {
    // Read only IHDR; planning must not inflate a whole map-sized image.
    const fd = openSync(file, 'r');
    try {
      const header = Buffer.alloc(24);
      if (
        readSync(fd, header, 0, 24, 0) !== 24 ||
        header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        header.toString('ascii', 12, 16) !== 'IHDR'
      )
        throw new Error(`Invalid terrain PNG: ${file}`);
      return [header.readUInt32BE(16), header.readUInt32BE(20)];
    } finally {
      closeSync(fd);
    }
  }
  const bounds = terrainLayout(m);
  return [Math.ceil(bounds.maxX) - Math.floor(bounds.minX), Math.ceil(bounds.maxY) - Math.floor(bounds.minY)];
}
function rematInput(m: Manifest, state: Record<string, Receipt>): string | undefined {
  const file = m.terrainMap?.file;
  if (!file) return undefined;
  const previous = state.remat;
  if (previous?.output === file && previous.input) return previous.input;
  // Python uses numbered successors on repeat runs. Also recognize standalone remat outputs without a log.
  return file.replace(/-remat(?:-\d+)?\.png$/i, '.png');
}
function rematSignature(m: Manifest, input: string | undefined): unknown {
  return {
    theater: m.theater,
    input,
    terrain: { ...m.terrainMap, file: input },
    strength: 0.55,
    control: 0.7,
    guidance: 5.5,
    steps: 28,
  };
}
function planStep(
  ctx: PrepareContext,
  step: PrepareStep,
  state: Record<string, Receipt>,
  changed: Set<PrepareStep>,
): PlannedStep {
  const m = readJson<Manifest>(join(ctx.mapDir, 'manifest.json'));
  const result: PlannedStep = { step, action: 'run', reason: 'missing or outdated outputs' };
  const skip = (reason: string): PlannedStep => ({ ...result, action: 'skip', reason });
  if (step === 'extract')
    return existsSync(ctx.mapDir) && !ctx.force
      ? skip(`map cache ${m ? 'exists' : 'is incomplete'}; use --force to re-extract`)
      : {
          ...result,
          reason: ctx.force ? 'forced extraction; preserve existing extensions' : 'extract map and referenced art',
        };
  if (!m) return { ...result, reason: 'requires extraction; theater, dimensions and pages resolved afterwards' };
  if (!Object.hasOwn(THEATERS, m.theater)) throw new Error(`Unknown map theater: ${m.theater}`);
  result.theater = m.theater;
  const invalidated = !!state[`pending:${step}`];
  const extracted = changed.has('extract');
  const terrainChanged = extracted || changed.has('terrain');
  const mapFile = (file: string): string => join(ctx.mapDir, file);
  const base = [mapFile('terrain-map.png'), mapFile('terrain-water.png')];
  if (step === 'terrain') {
    if (
      !ctx.force &&
      !invalidated &&
      !extracted &&
      m.terrainMap &&
      fresh(base, [mapFile(m.terrainAtlas.file)]) &&
      compatible(state, step, terrainInputs(m))
    )
      return skip('scale-1 terrain and mask are current');
  } else if (step === 'upscale') {
    const [width, height] = baseSize(ctx, m, terrainChanged);
    result.scale = chooseScale(width, height, ctx.scale);
    const ref = m.terrainMap;
    const waterMask = `terrain-water@${result.scale}x.png`;
    const output = `terrain-map@${result.scale}x.png`;
    // A later remat reference at the same scale is valid; do not reset it to the ESRGAN source on every run.
    if (
      !ctx.force &&
      !invalidated &&
      !terrainChanged &&
      ref?.scale === result.scale &&
      ref.width === width * result.scale &&
      ref.height === height * result.scale &&
      ref.waterMask === waterMask &&
      fresh([mapFile(output), mapFile(waterMask), mapFile(ref.file)], base) &&
      compatible(state, 'terrain', terrainInputs(m))
    )
      return skip('upscaled terrain and mask are current');
    result.reason = `upscale terrain ${width}x${height} at ${result.scale}x (${width * result.scale}x${height * result.scale})`;
  } else if (step === 'sprites') {
    if (
      !ctx.force &&
      !invalidated &&
      !extracted &&
      hdFresh(ctx.mapDir, m.spriteAtlas, m.spriteAtlasHd, m.palettes) &&
      compatible(state, step, spriteInputs(m))
    )
      return skip('map sprite colours and remap mask are current');
  } else if (step === 'library' || step === 'library-sprites') {
    const dir = join(ctx.cacheDir, '_library', m.theater);
    const library = readJson<TypeLibrary>(join(dir, 'library.json'));
    if (step === 'library')
      return library
        ? skip('theater library already exists (shared across maps)')
        : { ...result, reason: `extract ${m.theater} type library` };
    if (!library) return { ...result, reason: 'requires library extraction; page indices resolved afterwards' };
    result.pages = library.spriteAtlases.flatMap((source, page) =>
      !changed.has('library') &&
      hdFresh(dir, source, library.spriteAtlasesHd?.[page], library.palettes) &&
      compatible(state, `library-sprites:${m.theater}:${page}`, spriteInputs(library, page))
        ? []
        : [page],
    );
    if (!result.pages.length) return skip('all library sprite pages are current');
    result.reason = `upscale ${m.theater} library pages ${result.pages.join(',')}`;
  } else {
    result.input = rematInput(m, state);
    const ref = m.terrainMap;
    if (
      !ctx.force &&
      !invalidated &&
      !terrainChanged &&
      !changed.has('upscale') &&
      ref?.waterMask &&
      result.input &&
      ref.file !== result.input &&
      fresh([mapFile(ref.file)], [mapFile(result.input), mapFile(ref.waterMask)]) &&
      compatible(state, step, rematSignature(m, result.input))
    )
      return skip('rematerialized terrain is current');
    result.reason = `rematerialize ${result.input ?? 'terrain after preceding steps'} with local diffusion (resume enabled)`;
  }
  return result;
}

/** Read-only preview; steps whose inputs will be produced earlier are resolved again at execution time. */
export function planPrepareMap(options: PrepareMapOptions): PlannedStep[] {
  const ctx = context(options);
  const state = readJson<PrepareLog>(join(ctx.mapDir, 'prepare.json'))?.state ?? {};
  const changed = new Set<PrepareStep>();
  return selection(options).map((step) => {
    const plan = planStep(ctx, step, state, changed);
    if (plan.action === 'run') changed.add(step);
    return plan;
  });
}

// Fields owned by extraction must never be resurrected from an old map. Everything else is an extension.
const extractionKeys = new Set([
  'version',
  'name',
  'source',
  'theater',
  'grid',
  'localSize',
  'mapSize',
  'visibleRect',
  'cells',
  'tiles',
  'terrainAtlas',
  'spriteAtlas',
  'palettes',
  'sprites',
  'voxels',
  'objects',
  'waypoints',
  'houses',
  'paletteSources',
  'lighting',
  'extractor',
]);
function referencesExist(dir: string, value: unknown, key = ''): boolean {
  if (
    typeof value === 'string' &&
    (/^(file|files|path|paths|waterMask|remap)$/i.test(key) || /\.(png|json|bin|webp|jpe?g|ktx2?)$/i.test(value))
  ) {
    const path = resolve(dir, value);
    const child = relative(dir, path);
    return (
      !isAbsolute(value) &&
      child !== '..' &&
      !child.startsWith(`..${sep}`) &&
      existsSync(path) &&
      statSync(path).isFile()
    );
  }
  if (Array.isArray(value)) return value.every((item) => referencesExist(dir, item, key));
  if (value && typeof value === 'object')
    return Object.entries(value).every(([name, item]) => referencesExist(dir, item, name));
  return true;
}
function restoreExtensions(ctx: PrepareContext, old: Manifest | undefined): void {
  if (!old) return;
  const file = join(ctx.mapDir, 'manifest.json');
  const current = readJson<Manifest>(file);
  if (!current) return;
  for (const [key, value] of Object.entries(old)) {
    if (!extractionKeys.has(key) && !Object.hasOwn(current, key) && referencesExist(ctx.mapDir, value))
      current[key] = value;
  }
  writeJson(file, current);
}
function recordState(ctx: PrepareContext, plan: PlannedStep, state: Record<string, Receipt>): void {
  const m = readJson<Manifest>(join(ctx.mapDir, 'manifest.json'));
  if (!m) return;
  if (plan.step === 'terrain') state.terrain = { signature: signature(terrainInputs(m)) };
  if (plan.step === 'sprites') state.sprites = { signature: signature(spriteInputs(m)) };
  if (plan.step === 'library-sprites') {
    const library = readJson<TypeLibrary>(join(ctx.cacheDir, '_library', m.theater, 'library.json'));
    library?.spriteAtlases.forEach((source, page) => {
      if (hdFresh(join(ctx.cacheDir, '_library', m.theater), source, library.spriteAtlasesHd?.[page], library.palettes))
        state[`library-sprites:${m.theater}:${page}`] = { signature: signature(spriteInputs(library, page)) };
    });
  }
  if (plan.step === 'remat' && plan.input && m.terrainMap)
    state.remat = {
      signature: signature(rematSignature(m, plan.input)),
      input: plan.input,
      output: m.terrainMap.file,
    };
}

const dependents: Partial<Record<PrepareStep, PrepareStep[]>> = {
  extract: ['terrain', 'upscale', 'sprites', 'remat'],
  terrain: ['upscale', 'remat'],
  upscale: ['remat'],
};

function checkPrerequisites(ctx: PrepareContext, plan: PlannedStep, state: Record<string, Receipt>): void {
  if (plan.step !== 'upscale' && plan.step !== 'remat') return;
  const unforced = { ...ctx, force: false };
  if (planStep(unforced, 'terrain', state, new Set()).action !== 'skip')
    throw new Error(`${plan.step} requires current scale-1 terrain; include terrain in --steps`);
  if (plan.step === 'remat') {
    const m = readJson<Manifest>(join(ctx.mapDir, 'manifest.json'))!;
    // Explicit terrain,remat is valid at scale 1; an HD input also needs a current upscale step.
    // Check the source pair, not the active remat output, which this run may be repairing.
    const ref = m.terrainMap;
    if (
      ref?.waterMask !== 'terrain-water.png' &&
      (state['pending:upscale'] ||
        !plan.input ||
        !ref?.waterMask ||
        !fresh(
          [join(ctx.mapDir, plan.input), join(ctx.mapDir, ref.waterMask)],
          [join(ctx.mapDir, 'terrain-map.png'), join(ctx.mapDir, 'terrain-water.png')],
        ))
    )
      throw new Error('remat requires current upscaled terrain; include upscale in --steps');
  }
}

export async function prepareMap(
  options: PrepareMapOptions,
  runners: Partial<PrepareRunners> = {},
): Promise<PrepareLog> {
  const ctx = context(options);
  const steps = selection(options);
  const logFile = join(ctx.mapDir, 'prepare.json');
  const prior = readJson<PrepareLog>(logFile);
  const report: PrepareLog = {
    version: 1,
    mapId: ctx.mapId,
    startedAt: new Date().toISOString(),
    versions: {
      prepare: 1,
      node: process.versions.node,
      package: readJson<{ version: string }>(join(packageRoot, 'package.json'))!.version,
      manifest: HD_CACHE_VERSION,
      library: TYPE_LIBRARY_VERSION,
    },
    steps: [],
    state: { ...prior?.state },
  };
  ctx.log(`${ctx.mapId}: ${options.dryRun ? 'dry-run plan' : 'prepare'} -> ${ctx.mapDir}`);
  if (options.dryRun) {
    for (const plan of planPrepareMap(options)) ctx.log(`[${plan.step}] ${plan.action}: ${plan.reason}`);
    return report;
  }
  const changed = new Set<PrepareStep>();
  const persist = (): void => {
    mkdirSync(ctx.mapDir, { recursive: true });
    writeJson(logFile, report);
  };
  for (const step of steps) {
    const started = performance.now();
    let plan: PlannedStep = { step, action: 'run', reason: 'plan step' };
    try {
      plan = planStep(ctx, step, report.state, changed);
      ctx.log(`[${step}] ${plan.action}: ${plan.reason}`);
      if (plan.action === 'run') {
        if (step !== 'extract' && !readJson<Manifest>(join(ctx.mapDir, 'manifest.json')))
          throw new Error(`${step} requires manifest.json; select extract or provide a complete map cache`);
        if (step === 'library-sprites' && !plan.pages)
          throw new Error('library-sprites requires library.json; select library first');
        if (step === 'remat' && !plan.input) throw new Error('remat requires terrainMap; select terrain/upscale first');
        checkPrerequisites(ctx, plan, report.state);
        if (step === 'upscale' && plan.scale) {
          const m = readJson<Manifest>(join(ctx.mapDir, 'manifest.json'))!;
          const [width, height] = baseSize(ctx, m, false);
          if (plan.scale < ctx.scale)
            ctx.warn(`Reduced scale from ${ctx.scale} to ${plan.scale} to stay within 16384 px per side.`);
          if (Math.max(width, height) * plan.scale > 8192)
            ctx.warn(
              `Output ${width * plan.scale}x${height * plan.scale} exceeds the 8192 px WebGPU default; the renderer requests the adapter maximum (up to 16384).`,
            );
        }
        report.state[`pending:${step}`] = { signature: 'incomplete' };
        for (const dependent of dependents[step] ?? [])
          report.state[`pending:${dependent}`] = { signature: 'upstream changed' };
        persist();
        const old = step === 'extract' ? readJson<Manifest>(join(ctx.mapDir, 'manifest.json')) : undefined;
        try {
          await (runners[step] ?? defaultPrepareRunners[step])(ctx, plan);
        } finally {
          if (step === 'extract') restoreExtensions(ctx, old);
        }
        changed.add(step);
      }
      if (plan.action === 'run' || step === 'library' || step === 'library-sprites')
        delete report.state[`pending:${step}`];
      recordState(ctx, plan, report.state);
      const elapsedMs = Math.round(performance.now() - started);
      report.steps.push({ ...plan, status: plan.action === 'run' ? 'done' : 'skipped', elapsedMs });
      ctx.log(`[${step}] ${plan.action === 'run' ? 'done' : 'skipped'} (${elapsedMs} ms)`);
      persist();
    } catch (error) {
      // Invalidate the failed receipt so a partial output cannot be accepted on the next attempt.
      report.state[`pending:${step}`] = { signature: 'failed' };
      report.steps.push({
        ...plan,
        status: 'failed',
        elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      report.finishedAt = new Date().toISOString();
      persist();
      throw error;
    }
  }
  report.finishedAt = new Date().toISOString();
  persist();
  return report;
}
