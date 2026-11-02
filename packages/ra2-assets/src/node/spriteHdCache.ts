/** Offline sprite-HD orchestration for an existing map cache or per-theater type library. */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TypeLibrary } from '../library.ts';
import type { AtlasRef, HdCacheManifest, SpriteAtlasHdRef, SpriteEntry } from '../manifest.ts';
import { THEATERS } from '../theater.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { upscaleSpriteAtlas, type SpriteHdOptions } from './spriteHd.ts';

export interface SpriteHdCacheOptions {
  /** Cache root containing <map>/manifest.json and _library/<theater>/library.json. */
  cacheDir: string;
  /** Exactly one of map and library is required. */
  map?: string;
  library?: string;
  /** Library page indices; absent means every page. */
  pages?: number[];
  /** Debug only: limit body frames per page, write separate debug PNGs, and never update references. */
  limitFrames?: number;
  bin?: string;
  model?: string;
  /** Injectable Real-ESRGAN runner for synthetic tests. */
  run?: SpriteHdOptions['run'];
  onPage?: (result: SpriteHdPageResult) => void;
}

export interface SpriteHdPageResult {
  page: number;
  /** Paths are relative to this page's manifest.json or library.json. */
  ref: SpriteAtlasHdRef;
  frames: number;
  batches: number;
  inputPixels: number;
  /** Wall time including source decode, inference, output encoding and reference update. */
  elapsedMs: number;
  binaryMs: number;
  /** False for --limit-frames: debug files never replace renderer-visible HD references. */
  published: boolean;
}

function selector(value: string, name: string): string {
  if (!value.trim() || value === '.' || value === '..' || /[\\/\0]/.test(value))
    throw new Error(`${name} must be a single cache directory name`);
  return value;
}

/** Atlas/palette references belong to their cache directory, unlike shared library voxel references. */
function cacheFile(dir: string, file: string): string {
  if (!file || isAbsolute(file) || file.includes('\\') || file.includes('\0'))
    throw new Error(`Invalid cache image path: ${file}`);
  const path = resolve(dir, file);
  const child = relative(dir, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error(`Cache image path escapes its directory: ${file}`);
  return path;
}

function readPalettes(dir: string, references: Record<string, string>): Record<string, PngImage> {
  const palettes: Record<string, PngImage> = Object.create(null) as Record<string, PngImage>;
  for (const [key, file] of Object.entries(references)) palettes[key] = decodePng(readFileSync(cacheFile(dir, file)));
  return palettes;
}

function outputRef(atlas: AtlasRef, debug: boolean): SpriteAtlasHdRef {
  if (!/\.png$/i.test(atlas.file)) throw new Error(`Sprite atlas must be a PNG: ${atlas.file}`);
  const stem = atlas.file.slice(0, -4);
  const suffix = debug ? '@2x-debug' : '@2x';
  return {
    file: `${stem}${suffix}.png`,
    remap: `${stem}${suffix}-remap.png`,
    scale: 2,
    width: atlas.width * 2,
    height: atlas.height * 2,
  };
}

/** Stage both encodes before replacing outputs, so inference/encoding failure retains existing files. */
function writeImages(dir: string, ref: SpriteAtlasHdRef, image: PngImage, remap: PngImage): void {
  const output = cacheFile(dir, ref.file);
  const mask = cacheFile(dir, ref.remap);
  const temp = mkdtempSync(join(dirname(output), '.sprite-hd-'));
  try {
    const colorTemp = join(temp, 'color.png');
    const maskTemp = join(temp, 'remap.png');
    writeFileSync(colorTemp, encodePng(image));
    writeFileSync(maskTemp, encodePng(remap));
    renameSync(colorTemp, output);
    renameSync(maskTemp, mask);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeDocument(file: string, document: HdCacheManifest | TypeLibrary): void {
  const temp = mkdtempSync(join(dirname(file), '.sprite-hd-manifest-'));
  try {
    const staged = join(temp, 'manifest.json');
    writeFileSync(staged, JSON.stringify(document, null, 2));
    renameSync(staged, file);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Process sequentially to bound memory to one source/output atlas page and one inference batch. */
export async function upscaleSprites(options: SpriteHdCacheOptions): Promise<SpriteHdPageResult[]> {
  if ((options.map !== undefined) === (options.library !== undefined))
    throw new Error('Specify exactly one of map or library');
  if (options.pages !== undefined && options.library === undefined)
    throw new Error('pages is only supported with library');
  if (options.limitFrames !== undefined && (!Number.isSafeInteger(options.limitFrames) || options.limitFrames < 1))
    throw new RangeError('limitFrames must be a positive integer');
  if (
    options.pages !== undefined &&
    (!options.pages.length ||
      options.pages.some((page) => !Number.isSafeInteger(page) || page < 0) ||
      new Set(options.pages).size !== options.pages.length)
  )
    throw new RangeError('pages must be distinct non-negative integers');

  const root = resolve(options.cacheDir);
  let dir: string;
  let documentFile: string;
  let document: HdCacheManifest | TypeLibrary;
  let atlases: AtlasRef[];
  let sprites: Record<string, SpriteEntry>;
  let library: TypeLibrary | undefined;
  let manifest: HdCacheManifest | undefined;
  if (options.library !== undefined) {
    const theater = selector(options.library, 'library');
    if (!Object.hasOwn(THEATERS, theater)) throw new Error(`Unknown library theater: ${theater}`);
    dir = join(root, '_library', theater);
    documentFile = join(dir, 'library.json');
    library = JSON.parse(readFileSync(documentFile, 'utf8')) as TypeLibrary;
    document = library;
    atlases = library.spriteAtlases;
    sprites = library.sprites;
    if (library.spriteAtlasesHd && library.spriteAtlasesHd.length !== atlases.length)
      throw new Error('spriteAtlasesHd must contain exactly one entry per indexed atlas page');
  } else {
    dir = join(root, selector(options.map!, 'map'));
    documentFile = join(dir, 'manifest.json');
    manifest = JSON.parse(readFileSync(documentFile, 'utf8')) as HdCacheManifest;
    document = manifest;
    atlases = [manifest.spriteAtlas];
    sprites = manifest.sprites;
  }
  const pages = options.pages ?? atlases.map((_, page) => page);
  if (pages.some((page) => page >= atlases.length))
    throw new RangeError(`pages must be within the ${atlases.length} indexed atlas pages`);
  const palettes = readPalettes(dir, document.palettes);
  const debug = options.limitFrames !== undefined;
  const results: SpriteHdPageResult[] = [];
  for (const page of pages) {
    // A page published at another scale (a dedicated redraw page, python/sprite_hd_pages.py) is not this tool's 2x
    // output: an explicit request for it is an error, and a whole-library run leaves it alone.
    const existing = library?.spriteAtlasesHd?.[page];
    if (existing && existing.scale !== 2) {
      if (options.pages !== undefined)
        throw new Error(`Library page ${page} holds a ${existing.scale}x HD page; hd:sprites writes 2x and keeps it`);
      continue;
    }
    const started = performance.now();
    const source = atlases[page]!;
    const ref = outputRef(source, debug);
    const atlas = decodePng(readFileSync(cacheFile(dir, source.file)));
    if (atlas.width !== source.width || atlas.height !== source.height)
      throw new Error(`Sprite atlas ${source.file} dimensions disagree with its manifest`);
    const result = await upscaleSpriteAtlas({
      atlas,
      sprites,
      palettes,
      page,
      ...(options.limitFrames !== undefined ? { limitFrames: options.limitFrames } : {}),
      ...(options.bin !== undefined ? { bin: options.bin } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.run !== undefined ? { run: options.run } : {}),
    });
    writeImages(dir, ref, result.image, result.remap);
    if (!debug) {
      if (library) {
        library.spriteAtlasesHd ??= atlases.map(() => null);
        library.spriteAtlasesHd[page] = ref;
      } else {
        manifest!.spriteAtlasHd = ref;
      }
      writeDocument(documentFile, document);
    }
    const report: SpriteHdPageResult = {
      page,
      ref,
      frames: result.frames,
      batches: result.batches,
      inputPixels: result.inputPixels,
      elapsedMs: performance.now() - started,
      binaryMs: result.binaryMs,
      published: !debug,
    };
    results.push(report);
    options.onPage?.(report);
  }
  return results;
}
