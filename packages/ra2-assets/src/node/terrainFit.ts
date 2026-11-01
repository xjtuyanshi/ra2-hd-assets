/**
 * Fit an already produced integer-scale terrain composite (e.g. a 2x re-detail of a map too wide for 2x) down to the
 * fractional scale the upscaler would choose for the same map (terrainScale.ts), so it can replace that composite.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HdCacheManifest, TerrainMapRef } from '../manifest.ts';
import { fitTerrainScale, TERRAIN_MAX_SIDE, terrainMapNames, type TerrainFit } from '../terrainScale.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { resampleArea, resizeBilinear } from './upscale.ts';

export interface FitTerrainOptions {
  /** Map cache directory with manifest.json (terrainMap origin) and the scale-1 terrain-map.png/terrain-water.png. */
  mapDir: string;
  /** RGB(A) composite at an integer multiple k >= 2 of terrain-map.png's size on both axes. */
  input: string;
  /** Optional greyscale water mask at the input's size; fitted with the same area filter. */
  mask?: string;
  /** Default <mapDir>/<input stem>-fit.png. */
  output?: string;
  /** Default <mapDir>/<mask stem>-fit.png, or terrain-water@<k>x-fit.png when derived from terrain-water.png. */
  outputMask?: string;
  /** Largest output side (default 16384). */
  maxSide?: number;
  /**
   * 'source' (default): alpha from terrain-map.png with the upscaler's bilinear rule, so the result's alpha is
   * byte-identical to the upscaler's fitted composite of the same map; 'input': area average of the input's alpha.
   */
  alpha?: 'source' | 'input';
  /**
   * Point manifest.terrainMap at the fitted pair. Without `mask` the water mask is made from terrain-water.png with
   * the upscaler's bilinear rule. Outputs must then lie inside mapDir.
   */
  writeManifest?: boolean;
}

export interface FitTerrainResult extends Omit<TerrainMapRef, 'waterMask'> {
  /** Absolute output paths. */
  file: string;
  waterMask?: string;
  /** Integer scale of the input. */
  sourceScale: number;
}

function stemOf(file: string): string {
  return basename(file, extname(file));
}

function insideDir(dir: string, file: string): string {
  const child = relative(dir, file);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
    throw new Error(`${file} must be inside ${dir} to be referenced from manifest.json`);
  return child.split(sep).join('/');
}

function writeAtomic(file: string, bytes: Uint8Array | string): void {
  const temporary = `${file}.fit-${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, file);
}

/** The integer scale of `input` relative to the scale-1 size, and the fitted target. */
export function planTerrainFit(
  baseWidth: number,
  baseHeight: number,
  inputWidth: number,
  inputHeight: number,
  maxSide: number = TERRAIN_MAX_SIDE,
): { sourceScale: number; fit: TerrainFit } {
  const sourceScale = inputWidth / baseWidth;
  if (!Number.isInteger(sourceScale) || sourceScale < 1 || inputHeight !== baseHeight * sourceScale)
    throw new Error(
      `input ${inputWidth}x${inputHeight} is not an integer multiple of the scale-1 composite ${baseWidth}x${baseHeight}`,
    );
  const fit = fitTerrainScale(baseWidth, baseHeight, sourceScale, maxSide);
  if (fit.scale === sourceScale)
    throw new Error(`input ${inputWidth}x${inputHeight} already fits ${maxSide} px per side; use it as it is`);
  return { sourceScale, fit };
}

export function fitTerrainImage(opts: FitTerrainOptions): FitTerrainResult {
  const dir = resolve(opts.mapDir);
  const maxSide = opts.maxSide ?? TERRAIN_MAX_SIDE;
  const alphaMode = opts.alpha ?? 'source';
  if (alphaMode !== 'source' && alphaMode !== 'input') throw new Error("alpha must be 'source' or 'input'");
  const manifestFile = join(dir, 'manifest.json');
  const baseFile = join(dir, 'terrain-map.png');
  if (!existsSync(manifestFile) || !existsSync(baseFile))
    throw new Error(`Missing manifest.json or scale-1 terrain-map.png in ${dir}; run terrain-map first`);
  const manifestText = readFileSync(manifestFile, 'utf8');
  const manifest = JSON.parse(manifestText) as HdCacheManifest;
  const reference = manifest.terrainMap;
  if (!reference || !Number.isFinite(reference.originX) || !Number.isFinite(reference.originY))
    throw new Error('Missing terrainMap origin in manifest.json; run terrain-map with writeManifest enabled first');
  const base = decodePng(readFileSync(baseFile));
  if (base.channels !== 4) throw new Error('terrain-map.png must be RGBA; run terrain-map again');
  const input = decodePng(readFileSync(resolve(opts.input)));
  if (input.channels === 1) throw new Error(`${opts.input} must be an RGB or RGBA terrain composite`);
  const { sourceScale, fit } = planTerrainFit(base.width, base.height, input.width, input.height, maxSide);
  const { scale, width, height } = fit;
  const step = sourceScale / scale;

  let mask: PngImage | undefined;
  if (opts.mask) {
    const hd = decodePng(readFileSync(resolve(opts.mask)));
    if (hd.channels !== 1 || hd.width !== input.width || hd.height !== input.height)
      throw new Error(`${opts.mask} must be a greyscale mask of the input's size ${input.width}x${input.height}`);
    mask = resampleArea(hd, width, height, { step, srgbChannels: 0 });
  } else if (opts.writeManifest) {
    const maskFile = join(dir, 'terrain-water.png');
    if (!existsSync(maskFile)) throw new Error(`Missing scale-1 terrain-water.png in ${dir}; pass --mask`);
    const source = decodePng(readFileSync(maskFile));
    if (source.channels !== 1 || source.width !== base.width || source.height !== base.height)
      throw new Error('terrain-water.png must be a grayscale mask matching terrain-map.png; run terrain-map again');
    mask = resizeBilinear(source, width, height, scale);
  }

  const colour = resampleArea(input, width, height, { step, srgbChannels: 3 });
  const rgba = new Uint8Array(width * height * 4);
  let alpha: Uint8Array | undefined;
  if (alphaMode === 'source' || input.channels === 3) {
    const plain = new Uint8Array(base.width * base.height);
    for (let i = 0; i < plain.length; i++) plain[i] = base.data[i * 4 + 3]!;
    alpha = resizeBilinear(
      { width: base.width, height: base.height, channels: 1, data: plain },
      width,
      height,
      scale,
    ).data;
  }
  for (let i = 0; i < width * height; i++) {
    const o = i * colour.channels;
    rgba[i * 4] = colour.data[o]!;
    rgba[i * 4 + 1] = colour.data[o + 1]!;
    rgba[i * 4 + 2] = colour.data[o + 2]!;
    rgba[i * 4 + 3] = alpha ? alpha[i]! : colour.data[o + 3]!;
  }

  const output = resolve(opts.output ?? join(dir, `${stemOf(opts.input)}-fit.png`));
  const outputMask = mask
    ? resolve(
        opts.outputMask ??
          join(dir, opts.mask ? `${stemOf(opts.mask)}-fit.png` : terrainMapNames(fit, sourceScale).waterMask),
      )
    : undefined;
  if (outputMask === output) throw new Error('terrain and mask outputs must differ');
  for (const file of [output, outputMask])
    if (file && (file === resolve(opts.input) || (opts.mask && file === resolve(opts.mask)) || file === baseFile))
      throw new Error(`refusing to overwrite an input: ${file}`);
  const relativeFile = opts.writeManifest ? insideDir(dir, output) : undefined;
  const relativeMask = opts.writeManifest && outputMask ? insideDir(dir, outputMask) : undefined;
  if (!existsSync(dirname(output))) throw new Error(`Output directory does not exist: ${dirname(output)}`);
  writeAtomic(output, encodePng({ width, height, channels: 4, data: rgba }));
  if (outputMask && mask) writeAtomic(outputMask, encodePng(mask));
  if (opts.writeManifest) {
    // Refuse to overwrite edits made while the images were being processed.
    if (readFileSync(manifestFile, 'utf8') !== manifestText)
      throw new Error('manifest.json changed during processing; refusing to overwrite it');
    manifest.terrainMap = {
      file: relativeFile!,
      waterMask: relativeMask!,
      scale,
      originX: reference.originX,
      originY: reference.originY,
      width,
      height,
    };
    writeAtomic(manifestFile, JSON.stringify(manifest, null, 2));
  }
  return {
    file: output,
    ...(outputMask ? { waterMask: outputMask } : {}),
    scale,
    originX: reference.originX,
    originY: reference.originY,
    width,
    height,
    sourceScale,
  };
}
