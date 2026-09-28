/** Offline sprite inference; indexed originals remain authoritative for frame layout and shadows. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packShelvesPaged } from '../atlas.ts';
import type { SpriteEntry, SpriteFrame } from '../manifest.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { bleedTransparentRgb, downsampleLinearRgb, resizeBilinear, runBinary } from './upscale.ts';

const GUTTER = 16;

export interface SpriteHdOptions {
  /** R8 indices, or the map extractor's legacy RGBA (R = index). */
  atlas: PngImage;
  sprites: Record<string, SpriteEntry>;
  palettes: Record<string, PngImage>;
  /** Only frames on this source atlas page; absent page values mean zero. */
  page?: number;
  /** Debug: process only this many non-empty body frames on the page. */
  limitFrames?: number;
  bin?: string;
  model?: string;
  /** Normal input sheet edge (default 2048); oversized frames receive a dedicated padded sheet. */
  batchSize?: number;
  /** Injection point for offline inference fixtures; production uses the shared process runner. */
  run?: typeof runBinary;
}

export interface SpriteHdResult {
  image: PngImage;
  remap: PngImage;
  frames: number;
  batches: number;
  /** Total input pixels submitted to the executable, including borders. */
  inputPixels: number;
  elapsedMs: number;
  binaryMs: number;
}

export interface SpriteBatch {
  width: number;
  height: number;
  /** Content origins inside the sheet; each rectangle has its own transparent border. */
  placements: { index: number; x: number; y: number; width: number; height: number }[];
}

function checkImage(image: PngImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * image.channels
  )
    throw new RangeError('Invalid sprite image size or data length');
}

function checkAtlas(atlas: PngImage): void {
  checkImage(atlas);
  if (atlas.channels !== 1 && atlas.channels !== 4)
    throw new Error('Sprite atlas must contain R8 indices or legacy RGBA red-channel indices');
}

function checkPalette(palette: PngImage): void {
  checkImage(palette);
  if (palette.width !== 256 || palette.height !== 1 || palette.channels !== 3)
    throw new Error('Sprite palette must be a 256x1 RGB image');
}

function checkRect(frame: SpriteFrame, atlas: PngImage): void {
  const [x, y, width, height] = frame.rect;
  if (
    frame.rect.length !== 4 ||
    !frame.rect.every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width < 0 ||
    height < 0 ||
    x + width > atlas.width ||
    y + height > atlas.height
  )
    throw new RangeError(`Sprite frame rect ${frame.rect.join(',')} lies outside the source atlas`);
}

/** Resolve this entry's palette before inference; the neutral ramp retains house shade independently of hue. */
export function buildSpriteFrame(
  atlas: PngImage,
  frame: SpriteFrame,
  palette: PngImage,
  remappable: boolean,
): { rgba: PngImage; remap: PngImage } {
  checkAtlas(atlas);
  checkPalette(palette);
  checkRect(frame, atlas);
  const [x, y, width, height] = frame.rect;
  const rgba = new Uint8Array(width * height * 4);
  const remap = new Uint8Array(width * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const index = atlas.data[((y + py) * atlas.width + x + px) * atlas.channels]!;
      if (index === 0) continue;
      const i = py * width + px;
      const house = remappable && index >= 16 && index <= 31;
      const grey = Math.round(255 - (index - 16) * 15);
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = house ? grey : palette.data[index * 3 + c]!;
      rgba[i * 4 + 3] = 255;
      if (house) remap[i] = 255;
    }
  }
  return {
    rgba: { width, height, channels: 4, data: rgba },
    remap: { width, height, channels: 1, data: remap },
  };
}

/** Reuse the deterministic shelf packer with padded rectangles, so no two frames share a bleed region. */
export function packSpriteFrames(frames: readonly SpriteFrame[], maxSize = 2048, gutter = GUTTER): SpriteBatch[] {
  if (!Number.isSafeInteger(maxSize) || maxSize <= gutter * 2)
    throw new RangeError('Batch size must be an integer larger than twice the gutter');
  if (!Number.isSafeInteger(gutter) || gutter < GUTTER) throw new RangeError('Sprite gutters must be at least 16');
  const nonEmpty = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame.rect[2] > 0 && frame.rect[3] > 0);
  if (!nonEmpty.length) return [];
  const fits = (frame: SpriteFrame): boolean =>
    frame.rect[2] + gutter * 2 <= maxSize && frame.rect[3] + gutter * 2 <= maxSize;
  const regular = nonEmpty.filter(({ frame }) => fits(frame));
  const packed = regular.length
    ? packShelvesPaged(
        regular.map(({ frame }) => ({ w: frame.rect[2] + gutter * 2, h: frame.rect[3] + gutter * 2 })),
        0,
        maxSize,
        maxSize,
      )
    : { pages: [], rects: [] };
  const batches: SpriteBatch[] = packed.pages.map(() => ({ width: 0, height: 0, placements: [] }));
  packed.rects.forEach((rect, i) => {
    const { frame, index } = regular[i]!;
    const batch = batches[rect.page]!;
    batch.width = Math.max(batch.width, rect.x + rect.w);
    batch.height = Math.max(batch.height, rect.y + rect.h);
    batch.placements.push({
      index,
      x: rect.x + gutter,
      y: rect.y + gutter,
      width: frame.rect[2],
      height: frame.rect[3],
    });
  });
  // Preserve large source frames without splitting their context or changing their atlas UVs.
  for (const { frame, index } of nonEmpty.filter(({ frame }) => !fits(frame))) {
    const width = frame.rect[2];
    const height = frame.rect[3];
    batches.push({
      width: width + gutter * 2,
      height: height + gutter * 2,
      placements: [{ index, x: gutter, y: gutter, width, height }],
    });
  }
  return batches;
}

interface SelectedFrame {
  frame: SpriteFrame;
  palette: PngImage;
  remap: boolean;
}

function selectFrames(opts: SpriteHdOptions): { bodies: SelectedFrame[]; shadows: SpriteFrame[] } {
  const bodies: SelectedFrame[] = [];
  const shadows: SpriteFrame[] = [];
  const aliases = new Map<string, { palette: string; remap: boolean }>();
  const page = opts.page ?? 0;
  for (const [id, sprite] of Object.entries(opts.sprites)) {
    for (const frame of sprite.shadows ?? []) {
      if ((frame.page ?? 0) !== page) continue;
      checkRect(frame, opts.atlas);
      shadows.push(frame);
    }
    for (const frame of sprite.frames) {
      if ((frame.page ?? 0) !== page) continue;
      checkRect(frame, opts.atlas);
      if (!frame.rect[2] || !frame.rect[3]) continue;
      const palette = opts.palettes[sprite.palette];
      if (!palette) throw new Error(`Missing sprite palette ${sprite.palette} for ${id}`);
      checkPalette(palette);
      const key = frame.rect.join(',');
      const previous = aliases.get(key);
      if (previous) {
        if (previous.palette !== sprite.palette || previous.remap !== sprite.remap)
          throw new Error(`Conflicting palette or remap for shared sprite frame ${key}`);
        continue;
      }
      aliases.set(key, { palette: sprite.palette, remap: sprite.remap });
      bodies.push({ frame, palette, remap: sprite.remap });
    }
  }
  return { bodies: opts.limitFrames === undefined ? bodies : bodies.slice(0, opts.limitFrames), shadows };
}

function inferenceSheet(batch: SpriteBatch, frames: SelectedFrame[], atlas: PngImage): PngImage {
  const data = new Uint8Array(batch.width * batch.height * 3);
  for (const place of batch.placements) {
    const selected = frames[place.index]!;
    const crop = buildSpriteFrame(atlas, selected.frame, selected.palette, selected.remap).rgba;
    const width = crop.width + GUTTER * 2;
    const height = crop.height + GUTTER * 2;
    const padded = new Uint8Array(width * height * 4);
    for (let y = 0; y < crop.height; y++)
      padded.set(crop.data.subarray(y * crop.width * 4, (y + 1) * crop.width * 4), ((y + GUTTER) * width + GUTTER) * 4);
    // Bleed each padded frame independently, never allowing an adjacent frame to supply edge colours.
    const rgb = bleedTransparentRgb(padded, width, height);
    for (let y = 0; y < height; y++)
      data.set(
        rgb.subarray(y * width * 3, (y + 1) * width * 3),
        ((place.y - GUTTER + y) * batch.width + place.x - GUTTER) * 3,
      );
  }
  return { width: batch.width, height: batch.height, channels: 3, data };
}

function cutBack(
  batch: SpriteBatch,
  inferred: PngImage,
  frames: SelectedFrame[],
  opts: SpriteHdOptions,
  image: PngImage,
  mask: PngImage,
): void {
  for (const place of batch.placements) {
    const selected = frames[place.index]!;
    const crop = buildSpriteFrame(opts.atlas, selected.frame, selected.palette, selected.remap);
    const width = place.width * 2;
    const height = place.height * 2;
    // Cut the native 4x rectangle first: exact 2x2 boxes never sample its gutters, and no full-sheet 2x buffer is needed.
    const nativeWidth = width * 2;
    const nativeHeight = height * 2;
    const rgb = new Uint8Array(nativeWidth * nativeHeight * 3);
    for (let y = 0; y < nativeHeight; y++) {
      for (let x = 0; x < nativeWidth; x++) {
        const source = ((place.y * 4 + y) * inferred.width + place.x * 4 + x) * inferred.channels;
        const dest = (y * nativeWidth + x) * 3;
        for (let c = 0; c < 3; c++) rgb[dest + c] = inferred.data[source + c]!;
      }
    }
    const color = downsampleLinearRgb(rgb, nativeWidth, nativeHeight, width, height);
    const alpha = new Uint8Array(place.width * place.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = crop.rgba.data[i * 4 + 3]!;
    const resizedAlpha = resizeBilinear(
      { width: place.width, height: place.height, channels: 1, data: alpha },
      width,
      height,
    ).data;
    const resizedMask = resizeBilinear(crop.remap, width, height).data;
    const [atlasX, atlasY] = selected.frame.rect;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const dest = (atlasY * 2 + y) * image.width + atlasX * 2 + x;
        for (let c = 0; c < 3; c++) image.data[dest * 4 + c] = color[i * 3 + c]!;
        const a = Math.max(0, Math.min(1, (resizedAlpha[i]! / 255 - 0.35) / 0.3));
        image.data[dest * 4 + 3] = Math.round(a * a * (3 - 2 * a) * 255);
        mask.data[dest] = resizedMask[i]!;
      }
    }
  }
}

export async function upscaleSpriteAtlas(opts: SpriteHdOptions): Promise<SpriteHdResult> {
  const start = performance.now();
  checkAtlas(opts.atlas);
  const page = opts.page ?? 0;
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Sprite page must be a non-negative integer');
  if (opts.limitFrames !== undefined && (!Number.isSafeInteger(opts.limitFrames) || opts.limitFrames < 1))
    throw new RangeError('limitFrames must be a positive integer');
  const model = opts.model ?? 'realesrgan-x4plus';
  if (!/^realesrgan-x4plus(?:-anime)?$/.test(model))
    throw new Error(`Unsupported sprite model ${model}; use realesrgan-x4plus or realesrgan-x4plus-anime (native 4x)`);
  const { bodies, shadows } = selectFrames(opts);
  const batches = packSpriteFrames(
    bodies.map((body) => body.frame),
    opts.batchSize,
  );
  const width = opts.atlas.width * 2;
  const height = opts.atlas.height * 2;
  const image: PngImage = { width, height, channels: 4, data: new Uint8Array(width * height * 4) };
  const remap: PngImage = { width, height, channels: 1, data: new Uint8Array(width * height) };
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bin = resolve(opts.bin ?? join(repoRoot, 'gameres/tools/realesrgan/realesrgan-ncnn-vulkan'));
  let binaryMs = 0;
  const temp = mkdtempSync(join(tmpdir(), 'ra2-sprite-hd-'));
  try {
    for (const batch of batches) {
      const input = join(temp, 'input.png');
      const output = join(temp, 'output.png');
      // A successful no-output invocation must never reuse the previous batch's output.
      rmSync(output, { force: true });
      writeFileSync(input, encodePng(inferenceSheet(batch, bodies, opts.atlas)));
      const beforeRun = performance.now();
      await (opts.run ?? runBinary)(bin, [
        '-i',
        input,
        '-o',
        output,
        '-n',
        model,
        '-s',
        '4',
        '-m',
        join(dirname(bin), 'models'),
        '-t',
        '256',
      ]);
      binaryMs += performance.now() - beforeRun;
      if (!existsSync(output)) throw new Error('Real-ESRGAN exited successfully but did not write output.png');
      const inferred = decodePng(readFileSync(output));
      if (
        inferred.width !== batch.width * 4 ||
        inferred.height !== batch.height * 4 ||
        (inferred.channels !== 3 && inferred.channels !== 4)
      )
        throw new Error(
          `Real-ESRGAN returned ${inferred.width}x${inferred.height}/${inferred.channels} channels; expected ${batch.width * 4}x${batch.height * 4} RGB(A)`,
        );
      cutBack(batch, inferred, bodies, opts, image, remap);
    }
    // Shadows remain exclusively indexed, even if malformed input aliases a body and shadow rectangle.
    for (const shadow of shadows) {
      const [x, y, w, h] = shadow.rect;
      for (let row = y * 2; row < (y + h) * 2; row++) {
        const begin = row * width + x * 2;
        image.data.fill(0, begin * 4, (begin + w * 2) * 4);
        remap.data.fill(0, begin, begin + w * 2);
      }
    }
    return {
      image,
      remap,
      frames: bodies.length,
      batches: batches.length,
      inputPixels: batches.reduce((sum, batch) => sum + batch.width * batch.height, 0),
      elapsedMs: performance.now() - start,
      binaryMs,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
