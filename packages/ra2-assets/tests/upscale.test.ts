/** Synthetic-only inference fixtures: no game resources, model weights or GPU are required. */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng, encodePng } from '../src/node/png.ts';
import { bleedTransparentRgb, downsampleLinearRgb, resizeBilinear, upscaleTerrainMap } from '../src/node/upscale.ts';

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
