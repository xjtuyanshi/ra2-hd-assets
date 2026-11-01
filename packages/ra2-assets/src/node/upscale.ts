/** Local whole-map upscaling with the player's separately installed Real-ESRGAN executable. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HdCacheManifest, TerrainMapRef } from '../manifest.ts';
import { fitTerrainScale, TERRAIN_MAX_SIDE, terrainMapNames } from '../terrainScale.ts';
import { decodePng, encodePng, type PngImage, type PngChannels } from './png.ts';

export interface UpscaleOptions {
  cacheDir: string;
  /**
   * Requested integer output pixels per engine pixel, 1..4 (default 2). When it exceeds `maxSide` on either axis,
   * the output is fitted at the largest fractional scale that fits (see terrainScale.ts).
   */
  scale?: number;
  /** Largest output side in pixels (default 16384, the renderer's texture limit). */
  maxSide?: number;
  /** Default realesrgan-x4plus. Anime video models use their requested native scale. */
  model?: string;
  /** Defaults to gameres/tools/realesrgan/realesrgan-ncnn-vulkan in this checkout. */
  bin?: string;
  /** Default <binary directory>/models. */
  modelsDir?: string;
  /** Inference tile size (default 256); 0 lets the executable select it. */
  tile?: number;
  /** Crop in scale-1 image pixels, measured from the image's top-left: x, y, width, height. */
  compare?: readonly [number, number, number, number];
}

export interface UpscaleResult extends TerrainMapRef {
  /** Absolute output paths. */
  file: string;
  waterMask: string;
  compare?: string;
}

function checkImage(data: Uint8Array, width: number, height: number, channels: PngChannels): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new RangeError(`invalid image size ${width}x${height}`);
  if (data.length !== width * height * channels) throw new RangeError('image data length does not match its size');
}

/**
 * Opaque RGB for inference: synchronous four-neighbour dilation, followed by the original opaque pixels' mean.
 * Generation marks ensure pixels filled during a pass cannot influence other pixels until the next pass.
 */
export function bleedTransparentRgb(rgba: Uint8Array, width: number, height: number, passes = 16): Uint8Array {
  checkImage(rgba, width, height, 4);
  if (!Number.isInteger(passes) || passes < 0 || passes > 16) throw new RangeError('bleed passes must be 0..16');
  const count = width * height;
  const rgb = new Uint8Array(count * 3);
  const filled = new Uint8Array(count);
  const mean = [0, 0, 0];
  let remaining = count;
  for (let i = 0; i < count; i++) {
    if (rgba[i * 4 + 3]! < 128) continue;
    filled[i] = 1;
    remaining--;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = rgba[i * 4 + c]!;
      mean[c]! += rgba[i * 4 + c]!;
    }
  }
  for (let c = 0; c < 3; c++) mean[c] = count === remaining ? 0 : Math.round(mean[c]! / (count - remaining));
  for (let pass = 1; pass <= passes && remaining > 0; pass++) {
    let added = 0;
    for (let i = 0; i < count; i++) {
      if (filled[i]) continue;
      const x = i % width;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const take = (j: number): void => {
        if (!filled[j] || filled[j]! > pass) return;
        r += rgb[j * 3]!;
        g += rgb[j * 3 + 1]!;
        b += rgb[j * 3 + 2]!;
        n++;
      };
      if (x > 0) take(i - 1);
      if (x + 1 < width) take(i + 1);
      if (i >= width) take(i - width);
      if (i + width < count) take(i + width);
      if (!n) continue;
      rgb[i * 3] = Math.round(r / n);
      rgb[i * 3 + 1] = Math.round(g / n);
      rgb[i * 3 + 2] = Math.round(b / n);
      filled[i] = pass + 1;
      added++;
    }
    remaining -= added;
    if (!added) break;
  }
  if (remaining) {
    for (let i = 0; i < count; i++) {
      if (filled[i]) continue;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = mean[c]!;
    }
  }
  return rgb;
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function linearToSrgb(value: number): number {
  const s = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, s)) * 255);
}

/** Exact area box filter in linear light, including fractional source coverage for a 4x -> 3x reduction. */
export function downsampleLinearRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  checkImage(rgb, width, height, 3);
  if (
    !Number.isInteger(outWidth) ||
    !Number.isInteger(outHeight) ||
    outWidth < 1 ||
    outHeight < 1 ||
    outWidth > width ||
    outHeight > height
  )
    throw new RangeError('box filter output must be positive integer dimensions no larger than its input');
  const out = new Uint8Array(outWidth * outHeight * 3);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  const area = stepX * stepY;
  for (let y = 0; y < outHeight; y++) {
    const top = y * stepY;
    const bottom = (y + 1) * stepY;
    for (let x = 0; x < outWidth; x++) {
      const left = x * stepX;
      const right = (x + 1) * stepX;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = Math.floor(top); sy < Math.min(height, Math.ceil(bottom)); sy++) {
        const wy = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.min(width, Math.ceil(right)); sx++) {
          const weight = wy * (Math.min(right, sx + 1) - Math.max(left, sx));
          const i = (sy * width + sx) * 3;
          r += SRGB_TO_LINEAR[rgb[i]!]! * weight;
          g += SRGB_TO_LINEAR[rgb[i + 1]!]! * weight;
          b += SRGB_TO_LINEAR[rgb[i + 2]!]! * weight;
        }
      }
      const i = (y * outWidth + x) * 3;
      out[i] = linearToSrgb(r / area);
      out[i + 1] = linearToSrgb(g / area);
      out[i + 2] = linearToSrgb(b / area);
    }
  }
  return out;
}

/**
 * Exact area resampling for any reduction factor: output pixel (x, y) is the mean of the source over
 * [x * step, (x + 1) * step) x [y * step, (y + 1) * step), with partially covered source pixels weighted by their
 * covered area. `step` is source pixels per output pixel (default: the input/output size ratio of each axis); an
 * output pixel reaching past the source's right or bottom edge averages only the part it covers. The first
 * `srgbChannels` channels are averaged in linear light (sRGB colour); the rest (alpha, masks) as plain values.
 * For integer factors the result equals downsampleLinearRgb's box filter byte for byte.
 */
export function resampleArea(
  image: PngImage,
  outWidth: number,
  outHeight: number,
  options: { step?: number; srgbChannels?: number } = {},
): PngImage {
  const { width, height, channels, data } = image;
  checkImage(data, width, height, channels);
  const srgbChannels = options.srgbChannels ?? Math.min(3, channels);
  if (!Number.isInteger(srgbChannels) || srgbChannels < 0 || srgbChannels > channels)
    throw new RangeError('srgbChannels must be an integer from 0 to the channel count');
  if (!Number.isInteger(outWidth) || !Number.isInteger(outHeight) || outWidth < 1 || outHeight < 1)
    throw new RangeError('area resampling output must have positive integer dimensions');
  const stepX = options.step ?? width / outWidth;
  const stepY = options.step ?? height / outHeight;
  if (!(stepX >= 1) || !(stepY >= 1) || !Number.isFinite(stepX) || !Number.isFinite(stepY))
    throw new RangeError('area resampling only reduces: step must be at least 1 source pixel per output pixel');
  // Every output pixel must cover some source: the last one starts inside the image.
  if ((outWidth - 1) * stepX >= width || (outHeight - 1) * stepY >= height)
    throw new RangeError(`area resampling output ${outWidth}x${outHeight} extends past the ${width}x${height} source`);
  const out = new Uint8Array(outWidth * outHeight * channels);
  const sum = new Float64Array(channels);
  // Horizontal spans and weights are the same for every row.
  const first = new Int32Array(outWidth);
  const count = new Int32Array(outWidth);
  const spanX = new Float64Array(outWidth);
  const weightsX: Float64Array[] = [];
  for (let x = 0; x < outWidth; x++) {
    const left = x * stepX;
    const right = (x + 1) * stepX;
    first[x] = Math.floor(left);
    count[x] = Math.min(width, Math.ceil(right)) - first[x]!;
    const weights = new Float64Array(count[x]!);
    for (let k = 0; k < count[x]!; k++) {
      const sx = first[x]! + k;
      weights[k] = Math.min(right, sx + 1) - Math.max(left, sx);
    }
    weightsX.push(weights);
    spanX[x] = Math.min(right, width) - left;
  }
  for (let y = 0; y < outHeight; y++) {
    const top = y * stepY;
    const bottom = (y + 1) * stepY;
    const spanY = Math.min(bottom, height) - top;
    const yEnd = Math.min(height, Math.ceil(bottom));
    for (let x = 0; x < outWidth; x++) {
      sum.fill(0);
      const weights = weightsX[x]!;
      const x0 = first[x]!;
      const n = count[x]!;
      for (let sy = Math.floor(top); sy < yEnd; sy++) {
        const wy = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let k = 0; k < n; k++) {
          const weight = wy * weights[k]!;
          const i = (sy * width + x0 + k) * channels;
          for (let c = 0; c < srgbChannels; c++) sum[c]! += SRGB_TO_LINEAR[data[i + c]!]! * weight;
          for (let c = srgbChannels; c < channels; c++) sum[c]! += data[i + c]! * weight;
        }
      }
      const area = spanY * spanX[x]!;
      const o = (y * outWidth + x) * channels;
      for (let c = 0; c < srgbChannels; c++) out[o + c] = linearToSrgb(sum[c]! / area);
      for (let c = srgbChannels; c < channels; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(sum[c]! / area)));
    }
  }
  return { width: outWidth, height: outHeight, channels, data: out };
}

/**
 * Pixel-centre bilinear interpolation with clamped edge samples, matching normalized linear texture sampling.
 * Output pixel centre x + 0.5 samples source position (x + 0.5) / scale; `scale` (output per source pixel) defaults
 * to the size ratio of each axis and must be given for a fitted composite, whose size is rounded up.
 */
export function resizeBilinear(image: PngImage, width: number, height: number, scale?: number): PngImage {
  checkImage(image.data, image.width, image.height, image.channels);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('bilinear output must have positive integer dimensions');
  if (scale !== undefined && !(scale > 0 && Number.isFinite(scale)))
    throw new RangeError('bilinear scale must be a positive number');
  const sourceX = (x: number): number =>
    scale === undefined ? ((x + 0.5) * image.width) / width - 0.5 : (x + 0.5) / scale - 0.5;
  const sourceY = (y: number): number =>
    scale === undefined ? ((y + 0.5) * image.height) / height - 0.5 : (y + 0.5) / scale - 0.5;
  const { data: source, channels } = image;
  const data = new Uint8Array(width * height * channels);
  const left = new Int32Array(width);
  const right = new Int32Array(width);
  const fraction = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(image.width - 1, sourceX(x)));
    left[x] = Math.floor(sx);
    right[x] = Math.min(image.width - 1, left[x]! + 1);
    fraction[x] = sx - left[x]!;
  }
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(image.height - 1, sourceY(y)));
    const top = Math.floor(sy);
    const bottom = Math.min(image.height - 1, top + 1);
    const fy = sy - top;
    for (let x = 0; x < width; x++) {
      const fx = fraction[x]!;
      for (let c = 0; c < channels; c++) {
        const a = source[(top * image.width + left[x]!) * channels + c]!;
        const b = source[(top * image.width + right[x]!) * channels + c]!;
        const d = source[(bottom * image.width + left[x]!) * channels + c]!;
        const e = source[(bottom * image.width + right[x]!) * channels + c]!;
        data[(y * width + x) * channels + c] = Math.round(
          (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy,
        );
      }
    }
  }
  return { width, height, channels, data };
}

/** Shared local Real-ESRGAN process runner; callers may inject a fake runner in synthetic tests. */
export async function runBinary(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-8192);
    });
    child.on('error', (error) => reject(new Error(`Cannot run Real-ESRGAN at ${bin}: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Real-ESRGAN failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${tail.trim()}`));
    });
  });
}

function comparison(original: PngImage, output: PngImage, scale: number, crop: readonly number[]): PngImage {
  const [x, y, w, h] = crop as readonly [number, number, number, number];
  // Integer scales are exact; a fitted scale shows the crop's whole output pixels starting at its first one.
  const sideWidth = Math.floor(w * scale);
  const width = sideWidth * 2;
  const height = Math.floor(h * scale);
  const outX = Math.floor(x * scale);
  const outY = Math.floor(y * scale);
  const data = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < sideWidth; px++) {
      const a = ((y + Math.floor(py / scale)) * original.width + x + Math.floor(px / scale)) * 4;
      const b = ((outY + py) * output.width + outX + px) * 4;
      data.set(original.data.subarray(a, a + 4), (py * width + px) * 4);
      data.set(output.data.subarray(b, b + 4), (py * width + sideWidth + px) * 4);
    }
  }
  return { width, height, channels: 4, data };
}

export async function upscaleTerrainMap(opts: UpscaleOptions): Promise<UpscaleResult> {
  const requested = opts.scale ?? 2;
  if (!Number.isInteger(requested) || requested < 1 || requested > 4)
    throw new RangeError('scale must be an integer from 1 to 4');
  const maxSide = opts.maxSide ?? TERRAIN_MAX_SIDE;
  if (!Number.isSafeInteger(maxSide) || maxSide < 1) throw new RangeError('maxSide must be a positive integer');
  const tile = opts.tile ?? 256;
  if (!Number.isInteger(tile) || tile < 0) throw new RangeError('tile size must be a non-negative integer');
  const model = opts.model ?? 'realesrgan-x4plus';
  const anime = /^realesr-animevideov3(?:-x[234])?$/.test(model);
  if (!anime && !/^realesrgan-x4plus(?:-anime)?$/.test(model))
    throw new Error(
      `Unsupported model ${model}; use realesrgan-x4plus, realesrgan-x4plus-anime or realesr-animevideov3`,
    );
  if (anime && requested === 1)
    throw new Error('realesr-animevideov3 has native models for scales 2, 3 and 4; use realesrgan-x4plus for scale 1');
  const modelScale = anime ? /-x([234])$/.exec(model)?.[1] : undefined;
  if (modelScale && Number(modelScale) !== requested)
    throw new Error(
      `Model ${model} requires scale ${modelScale}; use the unsuffixed realesr-animevideov3 to select scale ${requested}`,
    );
  const dir = resolve(opts.cacheDir);
  const originalFile = join(dir, 'terrain-map.png');
  const maskFile = join(dir, 'terrain-water.png');
  if (!existsSync(originalFile) || !existsSync(maskFile))
    throw new Error(`Missing scale-1 terrain composite in ${dir}; run terrain-map (renderTerrainMap) first`);
  const manifestFile = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as HdCacheManifest;
  const reference = manifest.terrainMap;
  if (!reference || !Number.isFinite(reference.originX) || !Number.isFinite(reference.originY))
    throw new Error('Missing terrainMap origin in manifest.json; run terrain-map with writeManifest enabled first');
  const original = decodePng(readFileSync(originalFile));
  const mask = decodePng(readFileSync(maskFile));
  if (original.channels !== 4) throw new Error('terrain-map.png must be RGBA; run terrain-map again');
  if (mask.channels !== 1 || mask.width !== original.width || mask.height !== original.height)
    throw new Error('terrain-water.png must be a grayscale mask matching terrain-map.png; run terrain-map again');
  if (opts.compare) {
    const [x, y, w, h] = opts.compare;
    if (
      opts.compare.length !== 4 ||
      !opts.compare.every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > original.width ||
      y + h > original.height
    )
      throw new RangeError('compare must be x,y,width,height integers inside the scale-1 image');
  }
  const fit = fitTerrainScale(original.width, original.height, requested, maxSide);
  const { scale, width, height } = fit;
  if (fit.fitted)
    console.warn(
      `Fitted ${original.width}x${original.height} at ${scale}x (${width}x${height}) instead of ${requested}x to stay within ${maxSide} px per side.`,
    );
  if (width > 8192 || height > 8192)
    console.warn(
      `Output ${width}x${height} exceeds the 8192 px WebGPU default; the renderer requests the adapter maximum (up to 16384).`,
    );
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bin = resolve(opts.bin ?? join(repoRoot, 'gameres/tools/realesrgan/realesrgan-ncnn-vulkan'));
  const nativeScale = anime ? requested : 4;
  const temp = mkdtempSync(join(tmpdir(), 'ra2-upscale-'));
  try {
    const input = join(temp, 'input.png');
    const output = join(temp, 'output.png');
    writeFileSync(
      input,
      encodePng({
        width: original.width,
        height: original.height,
        channels: 3,
        data: bleedTransparentRgb(original.data, original.width, original.height),
      }),
    );
    await runBinary(bin, [
      '-i',
      input,
      '-o',
      output,
      '-n',
      anime ? 'realesr-animevideov3' : model,
      '-s',
      String(nativeScale),
      '-m',
      resolve(opts.modelsDir ?? join(dirname(bin), 'models')),
      '-t',
      String(tile),
    ]);
    if (!existsSync(output)) throw new Error('Real-ESRGAN exited successfully but did not write output.png');
    const inferred = decodePng(readFileSync(output));
    if (
      inferred.width !== original.width * nativeScale ||
      inferred.height !== original.height * nativeScale ||
      (inferred.channels !== 3 && inferred.channels !== 4)
    )
      throw new Error(
        `Real-ESRGAN returned ${inferred.width}x${inferred.height}/${inferred.channels} channels; expected ${original.width * nativeScale}x${original.height * nativeScale} RGB(A)`,
      );
    let rgb = inferred.data;
    if (inferred.channels === 4) {
      rgb = new Uint8Array(inferred.width * inferred.height * 3);
      for (let i = 0; i < inferred.width * inferred.height; i++)
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = inferred.data[i * 4 + c]!;
    }
    // Integer scales keep the original box filter and bilinear sampling byte for byte; a fitted scale uses the
    // exact area filter and bilinear sampling at the manifest scale (its image size is rounded up).
    const exact = fit.fitted ? scale : undefined;
    if (fit.fitted)
      rgb = resampleArea({ width: inferred.width, height: inferred.height, channels: 3, data: rgb }, width, height, {
        step: nativeScale / scale,
      }).data;
    else if (nativeScale !== scale) rgb = downsampleLinearRgb(rgb, inferred.width, inferred.height, width, height);
    const alpha = new Uint8Array(original.width * original.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = original.data[i * 4 + 3]!;
    const resizedAlpha = resizeBilinear(
      { width: original.width, height: original.height, channels: 1, data: alpha },
      width,
      height,
      exact,
    ).data;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = rgb[i * 3 + c]!;
      rgba[i * 4 + 3] = resizedAlpha[i]!;
    }
    const terrain: PngImage = { width, height, channels: 4, data: rgba };
    const { file, waterMask } = terrainMapNames(fit, requested);
    writeFileSync(join(dir, file), encodePng(terrain));
    writeFileSync(join(dir, waterMask), encodePng(resizeBilinear(mask, width, height, exact)));
    let compare: string | undefined;
    if (opts.compare) {
      compare = join(dir, 'upscale-compare.png');
      writeFileSync(compare, encodePng(comparison(original, terrain, scale, opts.compare)));
    }
    manifest.terrainMap = {
      file,
      waterMask,
      scale,
      originX: reference.originX,
      originY: reference.originY,
      width,
      height,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    return {
      ...manifest.terrainMap,
      file: join(dir, file),
      waterMask: join(dir, waterMask),
      ...(compare ? { compare } : {}),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
