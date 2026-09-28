/** Shared synthetic inference fixtures. No game files, GPU, or model weights are used. */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpriteEntry, SpriteFrame } from '../src/manifest.ts';
import { decodePng, encodePng, type PngImage } from '../src/node/png.ts';

export function spritePalette(seed = 0): PngImage {
  const data = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) data.set([(i + seed) % 256, (i * 37 + seed) % 256, (i * 73 + seed) % 256], i * 3);
  return { width: 256, height: 1, channels: 3, data };
}

export function spriteFrame(rect: SpriteFrame['rect'], page?: number): SpriteFrame {
  return { rect, offset: [-3, 7], ...(page === undefined ? {} : { page }) };
}

export function spriteEntry(frames: SpriteFrame[], extra: Partial<SpriteEntry> = {}): SpriteEntry {
  return { palette: 'unit', remap: false, canvas: [64, 64], frames, ...extra };
}

export function nearestRgb(input: PngImage, scale = 4): PngImage {
  if (input.channels !== 3) throw new Error('Inference input must be opaque RGB');
  const width = input.width * scale;
  const height = input.height * scale;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (Math.floor(y / scale) * input.width + Math.floor(x / scale)) * 3;
      data.set(input.data.subarray(src, src + 3), (y * width + x) * 3);
    }
  }
  return { width, height, channels: 3, data };
}

export async function fakeNearestRun(_bin: string, args: string[]): Promise<void> {
  const input = args[args.indexOf('-i') + 1]!;
  const output = args[args.indexOf('-o') + 1]!;
  if (args[args.indexOf('-s') + 1] !== '4') throw new Error('Expected native 4x inference');
  writeFileSync(output, encodePng(nearestRgb(decodePng(readFileSync(input)))));
}

/** Exercises the real spawn wrapper, while replacing inference with deterministic nearest-neighbour 4x. */
export function fakeNearestBinary(dir: string): string {
  const bin = join(dir, 'fake-sprite-realesrgan.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from ${JSON.stringify(new URL('../src/node/png.ts', import.meta.url).href)};
import { nearestRgb } from ${JSON.stringify(new URL('./spriteHdFixtures.ts', import.meta.url).href)};
const args = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
writeFileSync(${JSON.stringify(join(dir, 'sprite-args.json'))}, JSON.stringify(args));
if (get('-s') !== '4') throw new Error('Expected native 4x inference');
const input = decodePng(readFileSync(get('-i')));
writeFileSync(get('-o'), encodePng(nearestRgb(input)));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
