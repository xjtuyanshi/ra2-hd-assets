import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SpriteEntry } from '../src/manifest.ts';
import { decodePng, encodePng, type PngImage } from '../src/node/png.ts';
import { buildSpriteFrame, packSpriteFrames, upscaleSpriteAtlas } from '../src/node/spriteHd.ts';
import { fakeNearestRun, spriteEntry, spriteFrame, spritePalette } from './spriteHdFixtures.ts';

function pixel(image: PngImage, x: number, y: number): number[] {
  const start = (y * image.width + x) * image.channels;
  return Array.from(image.data.subarray(start, start + image.channels));
}

describe('sprite frame colour and remap construction', () => {
  it('uses the entry palette, index-zero alpha and the complete neutral house ramp', () => {
    const indices = Uint8Array.from([0, 15, ...Array.from({ length: 16 }, (_, i) => i + 16), 32]);
    const atlas: PngImage = { width: indices.length, height: 1, channels: 1, data: indices };
    const palette = spritePalette(17);
    const snapshot = atlas.data.slice();
    const frame = spriteFrame([0, 0, indices.length, 1]);
    const result = buildSpriteFrame(atlas, frame, palette, true);
    expect(result.rgba).toMatchObject({ width: indices.length, height: 1, channels: 4 });
    expect(result.remap).toMatchObject({ width: indices.length, height: 1, channels: 1 });
    expect(pixel(result.rgba, 0, 0)[3]).toBe(0);
    expect(pixel(result.rgba, 1, 0)).toEqual([...pixel(palette, 15, 0), 255]);
    expect(pixel(result.rgba, 18, 0)).toEqual([...pixel(palette, 32, 0), 255]);
    for (let i = 16; i <= 31; i++) {
      const grey = 255 - (i - 16) * 15;
      expect(pixel(result.rgba, i - 14, 0)).toEqual([grey, grey, grey, 255]);
    }
    expect(Array.from(result.remap.data)).toEqual([0, 0, ...Array<number>(16).fill(255), 0]);
    const normal = buildSpriteFrame(atlas, frame, palette, false);
    expect(normal.remap.data.every((value) => value === 0)).toBe(true);
    for (let x = 1; x < indices.length; x++)
      expect(pixel(normal.rgba, x, 0)).toEqual([...pixel(palette, indices[x]!, 0), 255]);
    expect(atlas.data).toEqual(snapshot);
  });

  it('crops legacy RGBA atlas red-channel indices and derives alpha from the index', () => {
    const atlas: PngImage = {
      width: 3,
      height: 2,
      channels: 4,
      data: Uint8Array.from([
        9, 99, 88, 255, 9, 99, 88, 255, 9, 99, 88, 255, 9, 99, 88, 255, 16, 90, 91, 0, 0, 90, 91, 255,
      ]),
    };
    const result = buildSpriteFrame(atlas, spriteFrame([1, 1, 2, 1]), spritePalette(), true);
    expect(pixel(result.rgba, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(result.rgba, 1, 0)[3]).toBe(0);
    expect(Array.from(result.remap.data)).toEqual([255, 0]);
  });

  it('rejects out-of-atlas crops and invalid palette layouts', () => {
    const atlas: PngImage = { width: 2, height: 2, channels: 1, data: new Uint8Array(4) };
    expect(() => buildSpriteFrame(atlas, spriteFrame([1, 1, 2, 1]), spritePalette(), false)).toThrow();
    expect(() =>
      buildSpriteFrame(
        atlas,
        spriteFrame([0, 0, 1, 1]),
        { width: 1, height: 1, channels: 3, data: new Uint8Array(3) },
        false,
      ),
    ).toThrow();
  });
});

describe('sprite inference sheet packing', () => {
  it('keeps every frame exactly once within bounded sheets and transparent gutters', () => {
    const frames = Array.from({ length: 9 }, (_, index) => spriteFrame([index, 0, 40 + (index % 2), 30]));
    const batches = packSpriteFrames(frames, 160, 16);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.length).toBeLessThan(frames.length);
    expect(
      batches.flatMap((batch) => batch.placements.map((placement) => placement.index)).sort((a, b) => a - b),
    ).toEqual(frames.map((_, index) => index));
    for (const batch of batches) {
      expect(batch.width).toBeLessThanOrEqual(160);
      expect(batch.height).toBeLessThanOrEqual(160);
      for (const placement of batch.placements) {
        expect([placement.width, placement.height]).toEqual(frames[placement.index]!.rect.slice(2));
        expect(placement.x).toBeGreaterThanOrEqual(16);
        expect(placement.y).toBeGreaterThanOrEqual(16);
        expect(placement.x + placement.width + 16).toBeLessThanOrEqual(batch.width);
        expect(placement.y + placement.height + 16).toBeLessThanOrEqual(batch.height);
      }
      for (let i = 0; i < batch.placements.length; i++) {
        for (const b of batch.placements.slice(i + 1)) {
          const a = batch.placements[i]!;
          expect(
            a.x + a.width + 16 <= b.x ||
              b.x + b.width + 16 <= a.x ||
              a.y + a.height + 16 <= b.y ||
              b.y + b.height + 16 <= a.y,
          ).toBe(true);
        }
      }
    }
    expect(packSpriteFrames([spriteFrame([0, 0, 129, 1])], 160, 16)).toEqual([
      { width: 161, height: 33, placements: [{ index: 0, x: 16, y: 16, width: 129, height: 1 }] },
    ]);
  });
});

describe('upscaleSpriteAtlas with synthetic 4x inference', () => {
  it.each([34, 64, 128])(
    'cuts %ipx batches into original doubled rects with exact RGB, distinct palettes and no shadows',
    async (batchSize) => {
      const atlas: PngImage = { width: 12, height: 8, channels: 1, data: new Uint8Array(96) };
      const body = spriteFrame([1, 1, 3, 2]);
      const second = spriteFrame([8, 2, 3, 3]);
      const shadow = spriteFrame([1, 5, 3, 2]);
      for (const [frame, index] of [
        [body, 40],
        [second, 70],
        [shadow, 1],
      ] as const) {
        const [x, y, width, height] = frame.rect;
        for (let dy = 0; dy < height; dy++) {
          for (let dx = 0; dx < width; dx++) atlas.data[(y + dy) * atlas.width + x + dx] = index + dx + dy;
        }
      }
      const sprites: Record<string, SpriteEntry> = {
        first: spriteEntry([body], { shadows: [shadow] }),
        second: spriteEntry([second], { palette: 'theater' }),
      };
      const palettes = { unit: spritePalette(), theater: spritePalette(39) };
      const run = vi.fn(fakeNearestRun);
      const result = await upscaleSpriteAtlas({ atlas, sprites, palettes, bin: 'synthetic-bin', run, batchSize });
      const batches = batchSize === 128 ? 1 : 2;
      expect(result).toMatchObject({ frames: 2, batches });
      expect(result.image).toMatchObject({ width: 24, height: 16, channels: 4 });
      expect(result.remap).toMatchObject({ width: 24, height: 16, channels: 1 });
      expect(result.remap.data.every((value) => value === 0)).toBe(true);
      expect(run).toHaveBeenCalledTimes(batches);
      expect(result.inputPixels).toBeGreaterThan(15);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(result.binaryMs);
      const occupied = new Set<number>();
      for (const [frame, palette] of [
        [body, palettes.unit],
        [second, palettes.theater],
      ] as const) {
        const [x, y, width, height] = frame.rect;
        for (let dy = 0; dy < height * 2; dy++) {
          for (let dx = 0; dx < width * 2; dx++) {
            const index = atlas.data[(y + Math.floor(dy / 2)) * atlas.width + x + Math.floor(dx / 2)]!;
            expect(pixel(result.image, x * 2 + dx, y * 2 + dy)).toEqual([...pixel(palette, index, 0), 255]);
            occupied.add((y * 2 + dy) * result.image.width + x * 2 + dx);
          }
        }
      }
      for (let index = 0; index < result.image.width * result.image.height; index++) {
        if (!occupied.has(index))
          expect(Array.from(result.image.data.subarray(index * 4, index * 4 + 4))).toEqual([0, 0, 0, 0]);
      }
    },
  );

  it('sharpens binary alpha slightly while preserving soft bilinear remap coverage', async () => {
    const result = await upscaleSpriteAtlas({
      atlas: { width: 2, height: 2, channels: 1, data: Uint8Array.of(0, 16, 16, 0) },
      sprites: { unit: spriteEntry([spriteFrame([0, 0, 2, 2])], { remap: true }) },
      palettes: { unit: spritePalette() },
      run: fakeNearestRun,
    });
    expect(Array.from(result.remap.data)).toEqual([
      0, 64, 191, 255, 64, 96, 159, 191, 191, 159, 96, 64, 255, 191, 64, 0,
    ]);
    expect(Array.from(result.image.data.filter((_, index) => index % 4 === 3))).toEqual([
      0, 0, 255, 255, 0, 6, 249, 255, 255, 249, 6, 0, 255, 255, 0, 0,
    ]);
  });

  it('selects the requested page before applying the frame limit', async () => {
    const run = vi.fn(fakeNearestRun);
    const result = await upscaleSpriteAtlas({
      atlas: { width: 3, height: 1, channels: 1, data: Uint8Array.of(40, 50, 60) },
      sprites: {
        unselected: spriteEntry([spriteFrame([0, 0, 1, 1])], { palette: 'unloaded' }),
        selected: spriteEntry([spriteFrame([1, 0, 1, 1], 1), spriteFrame([2, 0, 1, 1], 1)], {
          shadows: [spriteFrame([0, 0, 1, 1], 1)],
        }),
      },
      palettes: { unit: spritePalette() },
      page: 1,
      limitFrames: 1,
      run,
    });
    expect(result.frames).toBe(1);
    expect(pixel(result.image, 2, 0)[3]).toBe(255);
    expect(pixel(result.image, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(result.image, 4, 0)).toEqual([0, 0, 0, 0]);
  });

  it('returns a transparent page with no inference call when only shadows are present', async () => {
    const run = vi.fn(fakeNearestRun);
    const result = await upscaleSpriteAtlas({
      atlas: { width: 2, height: 1, channels: 1, data: Uint8Array.of(1, 1) },
      sprites: { shadow: spriteEntry([spriteFrame([0, 0, 0, 0])], { shadows: [spriteFrame([0, 0, 2, 1])] }) },
      palettes: {},
      run,
    });
    expect(result).toMatchObject({ frames: 0, batches: 0, inputPixels: 0 });
    expect(result.image.data.every((value) => value === 0)).toBe(true);
    expect(result.remap.data.every((value) => value === 0)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('bleeds the local frame colour into its transparent crop and gutter before inference', async () => {
    const inputs: PngImage[] = [];
    await upscaleSpriteAtlas({
      atlas: { width: 2, height: 1, channels: 1, data: Uint8Array.of(40, 0) },
      sprites: { unit: spriteEntry([spriteFrame([0, 0, 2, 1])]) },
      palettes: { unit: spritePalette() },
      run: async (bin, args) => {
        inputs.push(decodePng(readFileSync(args[args.indexOf('-i') + 1]!)));
        await fakeNearestRun(bin, args);
      },
    });
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.channels).toBe(3);
    expect(pixel(input, 16, 16)).toEqual(pixel(spritePalette(), 40, 0));
    expect(pixel(input, 17, 16)).toEqual(pixel(spritePalette(), 40, 0));
    expect(pixel(input, 15, 16)).toEqual(pixel(spritePalette(), 40, 0));
  });

  it('ignores alpha returned by the binary and restores source alpha instead', async () => {
    const result = await upscaleSpriteAtlas({
      atlas: { width: 1, height: 1, channels: 1, data: Uint8Array.of(40) },
      sprites: { unit: spriteEntry([spriteFrame([0, 0, 1, 1])]) },
      palettes: { unit: spritePalette() },
      run: async (bin, args) => {
        await fakeNearestRun(bin, args);
        const output = args[args.indexOf('-o') + 1]!;
        const rgb = decodePng(readFileSync(output));
        const rgba = new Uint8Array(rgb.width * rgb.height * 4);
        for (let index = 0; index < rgb.width * rgb.height; index++) {
          rgba.set(rgb.data.subarray(index * 3, index * 3 + 3), index * 4);
          rgba[index * 4 + 3] = 17;
        }
        writeFileSync(output, encodePng({ ...rgb, channels: 4, data: rgba }));
      },
    });
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) expect(pixel(result.image, x, y)).toEqual([...pixel(spritePalette(), 40, 0), 255]);
  });

  it('does not reuse a preceding batch output when the next invocation writes nothing, and cleans scratch files', async () => {
    let calls = 0;
    let scratch = '';
    await expect(
      upscaleSpriteAtlas({
        atlas: { width: 2, height: 1, channels: 1, data: Uint8Array.of(40, 50) },
        sprites: { unit: spriteEntry([spriteFrame([0, 0, 1, 1]), spriteFrame([1, 0, 1, 1])]) },
        palettes: { unit: spritePalette() },
        batchSize: 40,
        run: async (bin, args) => {
          scratch = dirname(args[args.indexOf('-i') + 1]!);
          if (++calls === 1) await fakeNearestRun(bin, args);
        },
      }),
    ).rejects.toThrow(/did not write/);
    expect(calls).toBe(2);
    expect(existsSync(scratch)).toBe(false);
  });

  it('deduplicates identical frame references without repeating inference work', async () => {
    const frame = spriteFrame([0, 0, 1, 1]);
    const result = await upscaleSpriteAtlas({
      atlas: { width: 1, height: 1, channels: 1, data: Uint8Array.of(16) },
      sprites: {
        first: spriteEntry([frame, frame], { remap: true }),
        alias: spriteEntry([frame], { remap: true }),
      },
      palettes: { unit: spritePalette() },
      run: fakeNearestRun,
    });
    expect(result).toMatchObject({ frames: 1, batches: 1 });
    expect(pixel(result.image, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(result.remap.data).toEqual(Uint8Array.of(255, 255, 255, 255));
  });

  it.each([{ palette: 'theater' }, { remap: true }])(
    'rejects ambiguous shared-rect settings %j before inference',
    async (conflict) => {
      const frame = spriteFrame([0, 0, 1, 1]);
      const run = vi.fn(fakeNearestRun);
      await expect(
        upscaleSpriteAtlas({
          atlas: { width: 1, height: 1, channels: 1, data: Uint8Array.of(16) },
          sprites: { first: spriteEntry([frame]), second: spriteEntry([frame], conflict) },
          palettes: { unit: spritePalette(), theater: spritePalette(40) },
          run,
        }),
      ).rejects.toThrow(/Conflicting palette or remap/);
      expect(run).not.toHaveBeenCalled();
    },
  );
});
