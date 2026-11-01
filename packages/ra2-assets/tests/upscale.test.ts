/** Synthetic-only inference fixtures: no game resources, model weights or GPU are required. */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng, encodePng } from '../src/node/png.ts';
import {
  bleedTransparentRgb,
  downsampleLinearRgb,
  resampleArea,
  resizeBilinear,
  upscaleTerrainMap,
} from '../src/node/upscale.ts';
import { fitTerrainImage, planTerrainFit } from '../src/node/terrainFit.ts';
import { fitTerrainScale, scaledTerrainSize, terrainMapNames } from '../src/terrainScale.ts';

const dirs: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra2-upscale-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = temporary();
  writeFileSync(
    join(dir, 'terrain-map.png'),
    encodePng({
      width: 2,
      height: 1,
      channels: 4,
      data: Uint8Array.of(220, 40, 20, 255, 0, 0, 255, 0),
    }),
  );
  writeFileSync(
    join(dir, 'terrain-water.png'),
    encodePng({ width: 2, height: 1, channels: 1, data: Uint8Array.of(0, 255) }),
  );
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      name: 'Synthetic',
      unknownExtension: { preserved: true },
      terrainMap: {
        file: 'terrain-map.png',
        waterMask: 'terrain-water.png',
        scale: 1,
        originX: -32,
        originY: 19,
        width: 2,
        height: 1,
      },
    }),
  );
  return dir;
}

/** The executable uses Node's native TS loading for the same dependency-free PNG codec. */
function fakeBinary(dir: string, mode: 'ok' | 'fail' | 'missing' | 'size' | 'rgba' = 'ok'): string {
  const bin = join(dir, 'fake-realesrgan.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from ${JSON.stringify(new URL('../src/node/png.ts', import.meta.url).href)};
const args = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));
const input = decodePng(readFileSync(get('-i')));
if (input.channels !== 3) throw new Error('inference input must be opaque RGB');
process.stderr.write('fake inference progress: 100%\\n');
if (${JSON.stringify(mode)} === 'fail') process.exit(7);
if (${JSON.stringify(mode)} === 'missing') process.exit(0);
const scale = ${JSON.stringify(mode)} === 'size' ? 1 : Number(get('-s'));
const width = input.width * scale;
const height = input.height * scale;
const channels = ${JSON.stringify(mode)} === 'rgba' ? 4 : 3;
const data = new Uint8Array(width * height * channels);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const src = (Math.floor(y / scale) * input.width + Math.floor(x / scale)) * 3;
    const dst = (y * width + x) * channels;
    data.set(input.data.subarray(src, src + 3), dst);
    if (channels === 4) data[dst + 3] = 17;
  }
}
writeFileSync(get('-o'), encodePng({ width, height, channels, data }));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function invocation(dir: string): string[] {
  return JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
}

function expectCleaned(dir: string): void {
  const args = invocation(dir);
  expect(existsSync(dirname(args[args.indexOf('-i') + 1]!))).toBe(false);
}

describe('bleedTransparentRgb', () => {
  it('dilates synchronously, then fills distant pixels with the opaque mean', () => {
    const rgba = new Uint8Array(6 * 4);
    rgba.set([255, 0, 0, 255], 0);
    rgba.set([0, 0, 255, 255], 20);
    const snapshot = rgba.slice();
    expect(Array.from(bleedTransparentRgb(rgba, 6, 1, 1))).toEqual([
      255, 0, 0, 255, 0, 0, 128, 0, 128, 128, 0, 128, 0, 0, 255, 0, 0, 255,
    ]);
    expect(rgba).toEqual(snapshot);
  });

  it('uses the alpha 128 threshold and averages filled four-neighbours', () => {
    const rgba = Uint8Array.of(240, 20, 40, 128, 0, 255, 0, 127, 20, 40, 240, 255);
    expect(Array.from(bleedTransparentRgb(rgba, 3, 1))).toEqual([240, 20, 40, 130, 30, 140, 20, 40, 240]);
  });

  it('fills an entirely transparent image deterministically and limits dilation to 16 passes', () => {
    expect(bleedTransparentRgb(new Uint8Array(16), 2, 2)).toEqual(new Uint8Array(12));
    const rgba = new Uint8Array(40 * 4);
    rgba.set([255, 0, 0, 255], 0);
    rgba.set([0, 0, 255, 255], 39 * 4);
    const rgb = bleedTransparentRgb(rgba, 40, 1);
    expect(Array.from(rgb.subarray(16 * 3, 18 * 3))).toEqual([255, 0, 0, 128, 0, 128]);
    expect(() => bleedTransparentRgb(rgba, 40, 1, 17)).toThrow(/0\.\.16/);
  });
});

describe('linear-light box downsampling', () => {
  it('averages 2x2 blocks in linear light, not encoded sRGB', () => {
    const rgb = Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0);
    expect(Array.from(downsampleLinearRgb(rgb, 2, 2, 1, 1))).toEqual([188, 188, 188]);
  });

  it('weights fractional source coverage exactly for 4x -> 3x', () => {
    const rgb = Uint8Array.of(0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255);
    expect(Array.from(downsampleLinearRgb(rgb, 4, 1, 3, 1))).toEqual([137, 137, 137, 188, 188, 188, 225, 225, 225]);
    expect(downsampleLinearRgb(rgb, 4, 1, 4, 1)).toEqual(rgb);
  });
});

describe('bilinear resize', () => {
  it('maps pixel centres, clamps edges and rounds channel values', () => {
    const result = resizeBilinear({ width: 2, height: 1, channels: 1, data: Uint8Array.of(0, 255) }, 4, 2);
    expect(Array.from(result.data)).toEqual([0, 64, 191, 255, 0, 64, 191, 255]);
    expect(result).toMatchObject({ width: 4, height: 2, channels: 1 });
  });

  it('interpolates both dimensions and every channel', () => {
    const image = {
      width: 2,
      height: 2,
      channels: 3 as const,
      data: Uint8Array.of(0, 40, 80, 100, 140, 180, 100, 140, 180, 200, 240, 220),
    };
    expect(Array.from(resizeBilinear(image, 1, 1).data)).toEqual([100, 140, 165]);
    expect(resizeBilinear(image, 2, 2).data).toEqual(image.data);
  });
});

describe('terrain scale fitting', () => {
  it('keeps a requested integer scale that fits, unchanged', () => {
    expect(fitTerrainScale(8192, 5000, 2)).toEqual({ scale: 2, width: 16384, height: 10000, fitted: false });
    expect(fitTerrainScale(100, 100, 4)).toEqual({ scale: 4, width: 400, height: 400, fitted: false });
    expect(terrainMapNames(fitTerrainScale(100, 100, 2), 2)).toEqual({
      file: 'terrain-map@2x.png',
      waterMask: 'terrain-water@2x.png',
    });
  });

  it('fits a too-wide map at the largest multiple of 1/256 instead of dropping to a smaller integer', () => {
    // A 9300 x 2505 composite (2x would be 18600 px wide) under a 16384 px limit.
    const fit = fitTerrainScale(9300, 2505, 2);
    expect(fit).toEqual({ scale: 451 / 256, width: 16384, height: 4414, fitted: true });
    expect(fit.width).toBe(Math.ceil(9300 * fit.scale));
    expect(9300 * ((fit.scale * 256 + 1) / 256)).toBeGreaterThan(16384);
    expect(terrainMapNames(fit, 2)).toEqual({
      file: 'terrain-map@2x-fit.png',
      waterMask: 'terrain-water@2x-fit.png',
    });
    // Tall maps fit on their height; every fitted side stays within the limit.
    const tall = fitTerrainScale(1000, 9000, 4, 16384);
    expect(tall.scale).toBe(466 / 256);
    expect(Math.max(tall.width, tall.height)).toBeLessThanOrEqual(16384);
    // A fit that lands on an integer is that integer scale, named as before.
    expect(fitTerrainScale(5461, 10, 4)).toEqual({ scale: 3, width: 16383, height: 30, fitted: false });
    expect(fitTerrainScale(5000, 1000, 4)).toMatchObject({ scale: 838 / 256, width: 16368, fitted: true });
  });

  it('honours other limits and rejects what cannot fit even at scale 1', () => {
    expect(fitTerrainScale(2, 1, 2, 3)).toEqual({ scale: 1.5, width: 3, height: 2, fitted: true });
    expect(() => fitTerrainScale(16385, 1, 2)).toThrow(/even at scale 1/);
    expect(() => fitTerrainScale(0, 1, 2)).toThrow(/dimensions/);
    expect(() => fitTerrainScale(10, 10, 1.5)).toThrow(/integer/);
    expect(scaledTerrainSize(9300, 2505, 451 / 256)).toEqual([16384, 4414]);
  });
});

describe('exact area resampling', () => {
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const random = (length: number, seed = 1) => {
    let state = seed;
    return Uint8Array.from({ length }, () => ((state = (state * 1103515245 + 12345) >>> 0) >>> 16) & 255);
  };

  it('equals the integer box filter byte for byte at integer factors', () => {
    for (const factor of [1, 2, 4]) {
      const rgb = random(12 * factor * 8 * factor * 3, factor);
      const image = { width: 12 * factor, height: 8 * factor, channels: 3 as const, data: rgb };
      expect(resampleArea(image, 12, 8).data).toEqual(downsampleLinearRgb(rgb, 12 * factor, 8 * factor, 12, 8));
      expect(resampleArea(image, 12, 8, { step: factor }).data).toEqual(
        downsampleLinearRgb(rgb, 12 * factor, 8 * factor, 12, 8),
      );
    }
  });

  it('keeps a constant image constant, including partly covered last pixels', () => {
    const data = new Uint8Array(37 * 11 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([200, 31, 97, 180], i);
    // 4x -> 1.76171875x: a step of 2.27 source pixels, and a last column/row past the source's edge.
    const step = 4 / (451 / 256);
    const [width, height] = [Math.ceil(37 / step), Math.ceil(11 / step)];
    expect(width * step).toBeGreaterThan(37);
    const out = resampleArea({ width: 37, height: 11, channels: 4, data }, width, height, { step });
    for (let i = 0; i < out.data.length; i += 4)
      expect(Array.from(out.data.subarray(i, i + 4))).toEqual([200, 31, 97, 180]);
  });

  it('preserves linear-light energy and plain-value means at fractional factors', () => {
    const [width, height] = [45, 27];
    const data = random(width * height * 4, 7);
    // 45 x 27 -> 20 x 12 (step 2.25): every output pixel covers whole and partial source pixels, nothing left over.
    const out = resampleArea({ width, height, channels: 4, data }, 20, 12);
    const area = 2.25 * 2.25;
    for (let c = 0; c < 4; c++) {
      const value = c < 3 ? (v: number) => toLinear(v) : (v: number) => v;
      let source = 0;
      for (let i = 0; i < width * height; i++) source += value(data[i * 4 + c]!);
      let fitted = 0;
      let rounding = 0;
      for (let i = 0; i < 20 * 12; i++) {
        const v = out.data[i * 4 + c]!;
        fitted += value(v);
        // Only the final 8-bit rounding differs: at most half a code value per output pixel.
        rounding += Math.max(value(Math.min(255, v + 0.5)) - value(v), value(v) - value(Math.max(0, v - 0.5)));
      }
      expect(Math.abs(fitted * area - source)).toBeLessThanOrEqual(rounding * area);
    }
    // Linear light, not encoded values: a checker with 4 of 9 pixels white averages to 178, not 113.
    const checker = Uint8Array.from({ length: 9 }, (_, i) => (i % 2 ? 255 : 0));
    expect(resampleArea({ width: 3, height: 3, channels: 1, data: checker }, 1, 1, { srgbChannels: 1 }).data[0]).toBe(
      178,
    );
    expect(resampleArea({ width: 3, height: 3, channels: 1, data: checker }, 1, 1, { srgbChannels: 0 }).data[0]).toBe(
      113,
    );
  });

  it('weights fractional coverage exactly', () => {
    // Plain values 0, 90, 180 resampled by 1.5: [0, 1.5) -> (0 + 45) / 1.5 = 30, [1.5, 3) -> (45 + 180) / 1.5 = 150.
    const image = { width: 3, height: 1, channels: 1 as const, data: Uint8Array.of(0, 90, 180) };
    expect(Array.from(resampleArea(image, 2, 1, { srgbChannels: 0 }).data)).toEqual([30, 150]);
    expect(() => resampleArea(image, 4, 1)).toThrow(/only reduces/);
    expect(() => resampleArea(image, 3, 1, { step: 1.5 })).toThrow(/extends past/);
  });

  it('samples bilinear at an explicit scale identically to the size ratio for integer scales', () => {
    const image = { width: 5, height: 3, channels: 1 as const, data: random(15, 3) };
    expect(resizeBilinear(image, 10, 6, 2)).toEqual(resizeBilinear(image, 10, 6));
    // Rounded-up fitted size: pixel centres follow the manifest scale, not the size ratio.
    const ramp = { width: 2, height: 1, channels: 1 as const, data: Uint8Array.of(0, 255) };
    expect(Array.from(resizeBilinear(ramp, 3, 2, 1.5).data)).toEqual([0, 128, 255, 0, 128, 255]);
  });
});

describe('upscaleTerrainMap with a fake executable', () => {
  it('runs native 4x, restores bilinear alpha/mask, preserves metadata/base files and writes the comparison', async () => {
    const dir = fixture();
    const base = readFileSync(join(dir, 'terrain-map.png'));
    const baseMask = readFileSync(join(dir, 'terrain-water.png'));
    const result = await upscaleTerrainMap({ cacheDir: dir, bin: fakeBinary(dir, 'rgba'), compare: [0, 0, 2, 1] });
    expect(result).toMatchObject({ width: 4, height: 2, scale: 2, originX: -32, originY: 19 });
    const args = invocation(dir);
    expect(args[args.indexOf('-s') + 1]).toBe('4');
    expect(args[args.indexOf('-n') + 1]).toBe('realesrgan-x4plus');
    expect(args[args.indexOf('-t') + 1]).toBe('256');
    expect(args[args.indexOf('-m') + 1]).toBe(join(dir, 'models'));
    const image = decodePng(readFileSync(result.file));
    expect(image.channels).toBe(4);
    expect(Array.from(image.data.subarray(0, 16))).toEqual([
      220, 40, 20, 255, 220, 40, 20, 191, 220, 40, 20, 64, 220, 40, 20, 0,
    ]);
    expect(Array.from(decodePng(readFileSync(result.waterMask)).data)).toEqual([0, 64, 191, 255, 0, 64, 191, 255]);
    const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
    expect(manifestText).toContain('\n  "version"');
    expect(JSON.parse(manifestText)).toEqual({
      version: 1,
      name: 'Synthetic',
      unknownExtension: { preserved: true },
      terrainMap: {
        file: 'terrain-map@2x.png',
        waterMask: 'terrain-water@2x.png',
        scale: 2,
        originX: -32,
        originY: 19,
        width: 4,
        height: 2,
      },
    });
    expect(readFileSync(join(dir, 'terrain-map.png'))).toEqual(base);
    expect(readFileSync(join(dir, 'terrain-water.png'))).toEqual(baseMask);
    const compare = decodePng(readFileSync(result.compare!));
    expect(compare).toMatchObject({ width: 8, height: 2, channels: 4 });
    expect(compare.data.subarray(0, 4)).toEqual(image.data.subarray(0, 4));
    expect(Array.from(compare.data.subarray(8, 12))).toEqual([0, 0, 255, 0]);
    expect(compare.data.subarray(16, 32)).toEqual(image.data.subarray(0, 16));
    expectCleaned(dir);
  });

  it('fits a request beyond maxSide at a fractional scale with exact registration', async () => {
    const dir = fixture();
    const result = await upscaleTerrainMap({ cacheDir: dir, bin: fakeBinary(dir), maxSide: 3, compare: [0, 0, 2, 1] });
    // 2x would be 4 px wide; 1.5x is the largest multiple of 1/256 within 3 px. Height: ceil(1 * 1.5) = 2.
    expect(result).toMatchObject({ scale: 1.5, width: 3, height: 2, originX: -32, originY: 19 });
    expect(result.file).toBe(join(dir, 'terrain-map@2x-fit.png'));
    expect(result.waterMask).toBe(join(dir, 'terrain-water@2x-fit.png'));
    const image = decodePng(readFileSync(result.file));
    // Pixel centres 0.5, 1.5, 2.5 sample original x = 1/3, 1, 5/3 (minus 0.5): alpha 255, 128, 0 (bilinear, clamped).
    expect(Array.from(image.data)).toEqual([
      220, 40, 20, 255, 220, 40, 20, 128, 220, 40, 20, 0, 220, 40, 20, 255, 220, 40, 20, 128, 220, 40, 20, 0,
    ]);
    expect(Array.from(decodePng(readFileSync(result.waterMask)).data)).toEqual([0, 128, 255, 0, 128, 255]);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).terrainMap).toEqual({
      file: 'terrain-map@2x-fit.png',
      waterMask: 'terrain-water@2x-fit.png',
      scale: 1.5,
      originX: -32,
      originY: 19,
      width: 3,
      height: 2,
    });
    expect(decodePng(readFileSync(result.compare!))).toMatchObject({ width: 6, height: 1 });
    expectCleaned(dir);
  });

  it('always reads scale-1 sources on reruns and supports requested scales 1..4', async () => {
    const dir = fixture();
    const bin = fakeBinary(dir);
    for (const scale of [4, 3, 1, 2]) {
      const result = await upscaleTerrainMap({ cacheDir: dir, bin, scale });
      expect(result).toMatchObject({ width: 2 * scale, height: scale, scale, originX: -32, originY: 19 });
      expect(decodePng(readFileSync(result.file))).toMatchObject({ width: 2 * scale, height: scale });
      expectCleaned(dir);
    }
  });

  it('passes the requested native anime-video scale and models directory', async () => {
    const dir = fixture();
    const result = await upscaleTerrainMap({
      cacheDir: dir,
      bin: fakeBinary(dir),
      model: 'realesr-animevideov3-x3',
      scale: 3,
      modelsDir: join(dir, 'custom-models'),
      tile: 0,
    });
    expect(result).toMatchObject({ width: 6, height: 3 });
    const args = invocation(dir);
    expect(args[args.indexOf('-s') + 1]).toBe('3');
    expect(args[args.indexOf('-n') + 1]).toBe('realesr-animevideov3');
    expect(args[args.indexOf('-m') + 1]).toBe(join(dir, 'custom-models'));
    expect(args[args.indexOf('-t') + 1]).toBe('0');
    expectCleaned(dir);
  });

  for (const [mode, error] of [
    ['fail', /exit 7/],
    ['missing', /did not write/],
    ['size', /expected 8x4/],
  ] as const) {
    it(`cleans temporary files and leaves the manifest unchanged on ${mode} output`, async () => {
      const dir = fixture();
      const manifest = readFileSync(join(dir, 'manifest.json'));
      await expect(upscaleTerrainMap({ cacheDir: dir, bin: fakeBinary(dir, mode) })).rejects.toThrow(error);
      expect(readFileSync(join(dir, 'manifest.json'))).toEqual(manifest);
      expect(existsSync(join(dir, 'terrain-map@2x.png'))).toBe(false);
      expectCleaned(dir);
    });
  }

  it('reports launch failures and missing scale-1 sources clearly', async () => {
    const dir = fixture();
    const tempRoot = temporary();
    vi.stubEnv(process.platform === 'win32' ? 'TEMP' : 'TMPDIR', tempRoot);
    try {
      await expect(upscaleTerrainMap({ cacheDir: dir, bin: join(dir, 'does-not-exist') })).rejects.toThrow(
        /Cannot run Real-ESRGAN/,
      );
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(upscaleTerrainMap({ cacheDir: temporary() })).rejects.toThrow(/run terrain-map/);
  });

  it('rejects missing anime-video scale 1 and mismatched model suffixes before inference', async () => {
    const dir = fixture();
    const bin = fakeBinary(dir);
    await expect(upscaleTerrainMap({ cacheDir: dir, bin, model: 'realesr-animevideov3', scale: 1 })).rejects.toThrow(
      /use realesrgan-x4plus for scale 1/,
    );
    await expect(upscaleTerrainMap({ cacheDir: dir, bin, model: 'realesr-animevideov3-x4', scale: 2 })).rejects.toThrow(
      /requires scale 4/,
    );
    expect(existsSync(join(dir, 'args.json'))).toBe(false);
  });

  it('rejects invalid scale, tile, crop and mask dimensions before launching inference', async () => {
    const dir = fixture();
    const bin = fakeBinary(dir);
    for (const scale of [0, 5, 1.5, NaN])
      await expect(upscaleTerrainMap({ cacheDir: dir, bin, scale })).rejects.toThrow(/integer from 1 to 4/);
    await expect(upscaleTerrainMap({ cacheDir: dir, bin, tile: -1 })).rejects.toThrow(/tile size/);
    await expect(upscaleTerrainMap({ cacheDir: dir, bin, compare: [1, 0, 2, 1] })).rejects.toThrow(
      /inside the scale-1 image/,
    );
    writeFileSync(
      join(dir, 'terrain-water.png'),
      encodePng({ width: 1, height: 1, channels: 1, data: Uint8Array.of(0) }),
    );
    await expect(upscaleTerrainMap({ cacheDir: dir, bin })).rejects.toThrow(/matching terrain-map/);
    expect(existsSync(join(dir, 'args.json'))).toBe(false);
  });
});

describe('fitting an existing integer-scale composite', () => {
  /** A 6 x 2 scale-1 composite with a soft alpha edge and some water; its 2x would be 12 px wide. */
  function wideFixture(): string {
    const dir = temporary();
    const data = new Uint8Array(6 * 2 * 4);
    for (let i = 0; i < 12; i++)
      data.set([20 * i, 100, 255 - 20 * i, i % 6 === 5 ? 0 : i % 6 === 4 ? 128 : 255], i * 4);
    writeFileSync(join(dir, 'terrain-map.png'), encodePng({ width: 6, height: 2, channels: 4, data }));
    writeFileSync(
      join(dir, 'terrain-water.png'),
      encodePng({ width: 6, height: 2, channels: 1, data: Uint8Array.of(0, 0, 255, 255, 0, 0, 0, 255, 255, 0, 0, 0) }),
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        terrainMap: {
          file: 'terrain-map.png',
          waterMask: 'terrain-water.png',
          scale: 1,
          originX: 5,
          originY: -7,
          width: 6,
          height: 2,
        },
      }),
    );
    return dir;
  }

  /** A 2x stand-in for a re-detail: nearest 2x of the original with every colour darkened, alpha set to 77. */
  function writeDouble(dir: string, name: string): string {
    const base = decodePng(readFileSync(join(dir, 'terrain-map.png')));
    const data = new Uint8Array(12 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 12; x++) {
        const i = ((y >> 1) * 6 + (x >> 1)) * 4;
        data.set([base.data[i]! >> 1, base.data[i + 1]! >> 1, base.data[i + 2]! >> 1, 77], (y * 12 + x) * 4);
      }
    const file = join(dir, name);
    writeFileSync(file, encodePng({ width: 12, height: 4, channels: 4, data }));
    return file;
  }

  it('lands on the upscaler fit of the same map, with byte-identical alpha and water mask', async () => {
    const dir = wideFixture();
    const upscaled = await upscaleTerrainMap({ cacheDir: dir, bin: fakeBinary(dir), maxSide: 9 });
    expect(upscaled).toMatchObject({ scale: 1.5, width: 9, height: 3 });
    const input = writeDouble(dir, 'terrain-map@2x-rd.png');
    const manifest = readFileSync(join(dir, 'manifest.json'));
    const fitted = fitTerrainImage({ mapDir: dir, input, maxSide: 9 });
    expect(fitted).toEqual({
      file: join(dir, 'terrain-map@2x-rd-fit.png'),
      scale: 1.5,
      originX: 5,
      originY: -7,
      width: 9,
      height: 3,
      sourceScale: 2,
    });
    // Without --write-manifest nothing else changes.
    expect(readFileSync(join(dir, 'manifest.json'))).toEqual(manifest);
    const image = decodePng(readFileSync(fitted.file));
    const reference = decodePng(readFileSync(upscaled.file));
    for (let i = 0; i < 9 * 3; i++) expect(image.data[i * 4 + 3]).toBe(reference.data[i * 4 + 3]);
    // Colour: the exact area filter from 2x (step 4/3). Output (0, 0) covers 2x pixels [0, 4/3) of the first original
    // pixel only, so it keeps that pixel's halved colour.
    expect(Array.from(image.data.subarray(0, 3))).toEqual([0, 50, 127]);
    const input2 = decodePng(readFileSync(input));
    expect(Array.from(image.data.subarray(0, 3 * 4)).filter((_, i) => i % 4 !== 3)).toEqual(
      Array.from(resampleArea({ ...input2, data: input2.data }, 9, 3, { step: 4 / 3 }).data.subarray(0, 3 * 4)).filter(
        (_, i) => i % 4 !== 3,
      ),
    );
    // The input's own alpha on request: an area average of 77 is 77.
    const own = fitTerrainImage({ mapDir: dir, input, maxSide: 9, alpha: 'input', output: join(dir, 'own.png') });
    const ownImage = decodePng(readFileSync(own.file));
    for (let i = 0; i < 9 * 3; i++) expect(ownImage.data[i * 4 + 3]).toBe(77);

    const installed = fitTerrainImage({ mapDir: dir, input, maxSide: 9, writeManifest: true });
    expect(installed.waterMask).toBe(join(dir, 'terrain-water@2x-fit.png'));
    expect(readFileSync(installed.waterMask!)).toEqual(readFileSync(upscaled.waterMask));
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).terrainMap).toEqual({
      file: 'terrain-map@2x-rd-fit.png',
      waterMask: 'terrain-water@2x-fit.png',
      scale: 1.5,
      originX: 5,
      originY: -7,
      width: 9,
      height: 3,
    });
  });

  it('fits an HD water mask with the plain-value area filter', () => {
    const dir = wideFixture();
    const input = writeDouble(dir, 'terrain-map@2x-rd.png');
    const mask = new Uint8Array(12 * 4).fill(0);
    mask.fill(255, 0, 6);
    writeFileSync(join(dir, 'terrain-water@2x-l5.png'), encodePng({ width: 12, height: 4, channels: 1, data: mask }));
    const result = fitTerrainImage({ mapDir: dir, input, mask: join(dir, 'terrain-water@2x-l5.png'), maxSide: 9 });
    expect(result.waterMask).toBe(join(dir, 'terrain-water@2x-l5-fit.png'));
    const fitted = decodePng(readFileSync(result.waterMask!));
    expect(fitted).toMatchObject({ width: 9, height: 3, channels: 1 });
    // Row 0 covers 2x rows [0, 4/3): 3/4 of it lies in the painted first row for the first 6 px ([0, 6) -> 4.5 px).
    expect(Array.from(fitted.data.subarray(0, 9))).toEqual([191, 191, 191, 191, 96, 0, 0, 0, 0]);
  });

  it('refuses sizes it cannot place and outputs it must not write', () => {
    const dir = wideFixture();
    const input = writeDouble(dir, 'terrain-map@2x-rd.png');
    expect(() => planTerrainFit(6, 2, 12, 5)).toThrow(/integer multiple/);
    expect(() => planTerrainFit(6, 2, 9, 3)).toThrow(/integer multiple/);
    expect(() => planTerrainFit(6, 2, 12, 4, 16384)).toThrow(/already fits/);
    expect(planTerrainFit(9300, 2505, 18600, 5010)).toEqual({ sourceScale: 2, fit: fitTerrainScale(9300, 2505, 2) });
    expect(() => fitTerrainImage({ mapDir: dir, input })).toThrow(/already fits/);
    expect(() =>
      fitTerrainImage({ mapDir: dir, input, maxSide: 9, writeManifest: true, output: join(temporary(), 'x.png') }),
    ).toThrow(/must be inside/);
    expect(() => fitTerrainImage({ mapDir: dir, input, maxSide: 9, output: input })).toThrow(/overwrite an input/);
    expect(existsSync(join(dir, 'terrain-map@2x-rd-fit.png'))).toBe(false);
  });
});
