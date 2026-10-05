import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodePng, encodePng, type PngImage } from '../src/node/png.ts';
import { blendPatch, patchUpscaledTerrain, patchWeights, planTerrainPatches } from '../src/node/terrainPatch.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function flat(width: number, height: number, colour: readonly number[]): PngImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(colour, i * 4);
  return { width, height, channels: 4, data };
}

function paint(image: PngImage, x0: number, y0: number, w: number, h: number, colour: readonly number[]): PngImage {
  const out = { ...image, data: new Uint8Array(image.data) };
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.data.set(colour, (y * image.width + x) * 4);
  return out;
}

const GROUND = [200, 180, 120, 255];
const CLIFF = [60, 40, 30, 255];
const GEOMETRY = { grow: 1, feather: 2, context: 3 };

describe('terrain patch plan', () => {
  it('finds nothing in identical composites and refuses different sizes', () => {
    const a = flat(40, 30, GROUND);
    expect(planTerrainPatches(a, flat(40, 30, GROUND))).toMatchObject({ changed: 0, regions: [] });
    expect(() => planTerrainPatches(a, flat(41, 30, GROUND))).toThrow(/differ in size/);
  });

  it('pads each changed site, clamps to the image and merges sites whose padded rectangles touch', () => {
    const before = flat(200, 100, GROUND);
    // A site at the left edge, and two sites 8 px apart (padded by 6 each, so they overlap) far to the right.
    let after = paint(before, 0, 40, 4, 5, CLIFF);
    after = paint(after, 150, 20, 3, 3, CLIFF);
    after = paint(after, 161, 22, 2, 2, [...CLIFF.slice(0, 3), 254]);
    const plan = planTerrainPatches(before, after, GEOMETRY);
    expect(plan.changed).toBe(20 + 9 + 4);
    expect(plan.regions).toEqual([
      { x: 144, y: 14, width: 25, height: 16, changed: 13 },
      { x: 0, y: 34, width: 10, height: 17, changed: 20 },
    ]);
    expect(plan.mask.reduce((n, v) => n + v, 0)).toBe(33);
  });
});

describe('terrain patch blending', () => {
  it('weights fully inside the grown site and fades to zero before the region border', () => {
    const before = flat(60, 40, GROUND);
    const plan = planTerrainPatches(before, paint(before, 30, 20, 1, 1, CLIFF), GEOMETRY);
    const [region] = plan.regions;
    expect(region).toEqual({ x: 24, y: 14, width: 13, height: 13, changed: 1 });
    const scale = 2;
    const weights = patchWeights(plan, region!, scale, GEOMETRY);
    const at = (x: number, y: number): number =>
      weights[(y - region!.y * scale) * region!.width * scale + x - region!.x * scale]!;
    // The changed pixel covers output pixels 60..61; with grow 1 the bilinear full-weight core is 59..62.
    expect([at(60, 40), at(61, 41), at(59, 40), at(62, 41)]).toEqual([1, 1, 1, 1]);
    // Three scale-1 pixels out (grow + feather) the weight has reached zero.
    expect([at(53, 40), at(68, 40), at(60, 33), at(60, 48)]).toEqual([0, 0, 0, 0]);
    for (let x = 60; x < 68; x++) expect(at(x + 1, 40)).toBeLessThanOrEqual(at(x, 40));
    expect(at(64, 40)).toBeGreaterThan(0);
    expect(at(64, 40)).toBeLessThan(1);
    // The whole border ring of the region is zero, so nothing outside it can show a seam.
    const W = region!.width * scale;
    for (let i = 0; i < W; i++)
      expect([weights[i], weights[(W - 1) * W + i], weights[i * W], weights[i * W + W - 1]]).toEqual([0, 0, 0, 0]);
  });

  it('replaces by weight and, on request, shifts the patch to the tone of the unchanged surroundings', () => {
    const region = { x: 1, y: 0, width: 3, height: 1, changed: 1 };
    const patch = Uint8Array.from([100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const alpha = Uint8Array.from([255, 255, 255]);
    const weights = Float32Array.from([0, 1, 0.5]);
    const plain = flat(5, 1, [140, 120, 100, 255]);
    blendPatch(plain, region, 1, patch, alpha, weights, false);
    expect(Array.from(plain.data)).toEqual([
      140, 120, 100, 255, /**/ 140, 120, 100, 255, /**/ 100, 100, 100, 255, /**/ 120, 110, 100, 255, /**/ 140, 120, 100,
      255,
    ]);
    // Tone: the only weight-0 pixel says the target is (40, 20, 0) brighter than the patch there.
    const toned = flat(5, 1, [140, 120, 100, 255]);
    blendPatch(toned, region, 1, patch, alpha, weights, true);
    expect(Array.from(toned.data.subarray(8, 16))).toEqual([140, 120, 100, 255, 140, 120, 100, 255]);
  });
});

describe('terrain patch tone curve', () => {
  it('carries patch luma to the target luma of the same rank in the unchanged surroundings', () => {
    // 40 px row: the patch is a ramp 60..99; the target renders the same terrain darker and with more contrast
    // (2v - 100). The first 32 pixels are unchanged surroundings, the last 8 are replaced (weight 1).
    const n = 40;
    const region = { x: 0, y: 0, width: n, height: 8, changed: 8 };
    const patch = new Uint8Array(n * 8 * 3);
    const target = flat(n, 8, [0, 0, 0, 255]);
    const weights = new Float32Array(n * 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < n; x++) {
        const v = 60 + ((x * 7) % 32);
        patch.fill(v, (y * n + x) * 3, (y * n + x) * 3 + 3);
        target.data.fill(2 * v - 100, (y * n + x) * 4, (y * n + x) * 4 + 3);
        if (x >= 32) weights[y * n + x] = 1;
      }
    }
    // The replaced pixels hold values that also occur in the surroundings; a mean shift alone would leave them wrong.
    const expected = Array.from({ length: 8 }, (_, k) => 2 * (60 + (((32 + k) * 7) % 32)) - 100);
    for (let x = 32; x < n; x++) target.data.fill(255, x * 4, x * 4 + 3);
    blendPatch(target, region, 1, patch, new Uint8Array(n * 8).fill(255), weights, true);
    expect(Array.from({ length: 8 }, (_, k) => target.data[(32 + k) * 4])).toEqual(expected);
    // Untouched surroundings.
    expect(target.data[0]).toBe(2 * 60 - 100);
  });
});

describe('patchUpscaledTerrain', () => {
  /** Stands in for Real-ESRGAN: every input pixel becomes a 4x4 block. */
  const nearest4x = async (_bin: string, args: string[]): Promise<void> => {
    const input = args[args.indexOf('-i') + 1]!;
    const output = args[args.indexOf('-o') + 1]!;
    for (const name of readdirSync(input)) {
      const image = decodePng(readFileSync(join(input, name)));
      const data = new Uint8Array(image.width * 4 * image.height * 4 * 3);
      for (let y = 0; y < image.height * 4; y++)
        for (let x = 0; x < image.width * 4; x++)
          for (let c = 0; c < 3; c++)
            data[(y * image.width * 4 + x) * 3 + c] = image.data[((y >> 2) * image.width + (x >> 2)) * 3 + c]!;
      writeFileSync(
        join(output, name),
        encodePng({ width: image.width * 4, height: image.height * 4, channels: 3, data }),
      );
    }
  };

  function files(): { dir: string; before: string; after: string; upscaled: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ra2-terrain-patch-test-'));
    directories.push(dir);
    const before = flat(80, 60, GROUND);
    // The defect: a wedge of cliff on the ground. The corrected composite has plain ground there.
    const broken = paint(before, 40, 30, 6, 6, CLIFF);
    writeFileSync(join(dir, 'before.png'), encodePng(broken));
    writeFileSync(join(dir, 'after.png'), encodePng(before));
    // The existing 2x image: the broken composite doubled, with a recognisable untouched texture everywhere.
    const up = flat(160, 120, GROUND);
    for (let i = 0; i < 160 * 120; i++) up.data[i * 4 + 2] = 100 + (i % 7);
    writeFileSync(join(dir, 'up.png'), encodePng(paint(up, 80, 60, 12, 12, CLIFF)));
    return { dir, before: join(dir, 'before.png'), after: join(dir, 'after.png'), upscaled: join(dir, 'up.png') };
  }

  it('repairs only the changed site of an upscaled image and leaves the rest byte-identical', async () => {
    const f = files();
    const out = join(f.dir, 'layer', 'up.png');
    const result = await patchUpscaledTerrain({
      before: f.before,
      after: f.after,
      targets: [{ file: f.upscaled, out }],
      run: nearest4x,
      bin: '/nonexistent/realesrgan',
      ...GEOMETRY,
    });
    expect(result).toMatchObject({ changed: 36, regions: 1, scale: 2, written: [out] });
    expect(result.inferred).toBe(18 * 18);
    const source = decodePng(readFileSync(f.upscaled));
    const fixed = decodePng(readFileSync(out));
    const pixel = (image: PngImage, x: number, y: number): number[] =>
      Array.from(image.data.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
    // The wedge is gone: the site now holds the corrected composite's ground.
    expect(pixel(source, 85, 65)).toEqual(CLIFF);
    expect(pixel(fixed, 85, 65)).toEqual(GROUND);
    expect(pixel(fixed, 80, 60)).toEqual(GROUND);
    // Outside grow + feather (3 px at scale 1 -> 6 output px around the 12 px site) every byte is the source's.
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 160; x++) {
        if (x >= 74 && x < 98 && y >= 54 && y < 78) continue;
        if (source.data[(y * 160 + x) * 4 + 2] !== fixed.data[(y * 160 + x) * 4 + 2])
          throw new Error(`pixel ${x},${y} changed`);
      }
    }
    expect(readFileSync(f.upscaled).equals(encodePng(source))).toBe(true);
  });

  it('writes nothing when the composites are identical', async () => {
    const f = files();
    const out = join(f.dir, 'same.png');
    const result = await patchUpscaledTerrain({
      before: f.after,
      after: f.after,
      targets: [{ file: f.upscaled, out }],
      run: async () => {
        throw new Error('inference must not run');
      },
    });
    expect(result).toEqual({ changed: 0, regions: 0, inferred: 0, scale: 0, written: [] });
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a target that is not an upscale of the composite', async () => {
    const f = files();
    writeFileSync(join(f.dir, 'odd.png'), encodePng(flat(100, 120, GROUND)));
    await expect(
      patchUpscaledTerrain({
        before: f.before,
        after: f.after,
        targets: [{ file: join(f.dir, 'odd.png'), out: join(f.dir, 'x.png') }],
        run: nearest4x,
      }),
    ).rejects.toThrow(/integer 1\.\.4x upscale/);
  });
});
