import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng, encodePng } from '../src/node/png.ts';
import { upscaleSprites } from '../src/node/spriteHdCache.ts';
import { fakeNearestBinary, fakeNearestRun, spriteEntry, spriteFrame, spritePalette } from './spriteHdFixtures.ts';

const dirs: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra2-sprite-hd-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePalette(dir: string): void {
  mkdirSync(join(dir, 'palettes'), { recursive: true });
  writeFileSync(join(dir, 'palettes/unit.png'), encodePng(spritePalette()));
}

function mapFixture() {
  const cacheDir = temporary();
  const dir = join(cacheDir, 'synthetic-map');
  writePalette(dir);
  const atlas = { width: 4, height: 3, channels: 1 as const, data: new Uint8Array(12) };
  atlas.data.set([16, 40], 5);
  atlas.data.set([1, 1], 9);
  writeFileSync(join(dir, 'sprites.png'), encodePng(atlas));
  const manifest = {
    version: 1,
    name: 'Synthetic sprite map',
    terrainAtlas: { file: 'terrain.png', width: 32, height: 64 },
    terrainMap: { file: 'terrain-map@2x.png', scale: 2, originX: -32, originY: 19, width: 64, height: 128 },
    spriteAtlas: { file: 'sprites.png', width: 4, height: 3 },
    palettes: { unit: 'palettes/unit.png' },
    sprites: {
      'building:TEST': spriteEntry([spriteFrame([1, 1, 2, 1])], { remap: true, shadows: [spriteFrame([1, 2, 2, 1])] }),
    },
    unknownExtension: { preserved: true },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { cacheDir, dir, manifest };
}

function libraryFixture() {
  const cacheDir = temporary();
  const dir = join(cacheDir, '_library', 'temperate');
  writePalette(dir);
  const atlases = Array.from({ length: 3 }, (_, page) => {
    const file = `sprites-${page}.png`;
    writeFileSync(
      join(dir, file),
      encodePng({ width: 3, height: 2, channels: 1, data: Uint8Array.of(40, 0, 0, 0, 0, 1) }),
    );
    return { file, width: 3, height: 2 };
  });
  const previous = { file: 'sprites-0@2x.png', remap: 'sprites-0@2x-remap.png', scale: 2, width: 6, height: 4 };
  const library = {
    version: 1,
    theater: 'temperate',
    spriteAtlases: atlases,
    spriteAtlasesHd: [previous, null, null],
    sprites: {
      'building:TEST': spriteEntry(
        atlases.map((_, page) => spriteFrame([0, 0, 1, 1], page)),
        {
          shadows: atlases.map((_, page) => spriteFrame([2, 1, 1, 1], page)),
        },
      ),
    },
    palettes: { unit: 'palettes/unit.png' },
    types: { TEST: { sprite: 'building:TEST', atlasPages: [0, 1, 2] } },
    unknownExtension: { preserved: true },
  };
  writeFileSync(join(dir, 'library.json'), JSON.stringify(library));
  return { cacheDir, dir, library };
}

describe('sprite HD cache publication', () => {
  it('launches an injected executable at 4x and appends the map reference without altering source metadata or PNGs', async () => {
    const { cacheDir, dir, manifest } = mapFixture();
    const source = readFileSync(join(dir, 'sprites.png'));
    const sourcePalette = readFileSync(join(dir, 'palettes/unit.png'));
    const results = await upscaleSprites({ cacheDir, map: 'synthetic-map', bin: fakeNearestBinary(cacheDir) });
    const ref = { file: 'sprites@2x.png', remap: 'sprites@2x-remap.png', scale: 2, width: 8, height: 6 };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ page: 0, frames: 1, batches: 1, ref, published: true });
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toEqual({ ...manifest, spriteAtlasHd: ref });
    expect(readFileSync(join(dir, 'sprites.png'))).toEqual(source);
    expect(readFileSync(join(dir, 'palettes/unit.png'))).toEqual(sourcePalette);
    expect(decodePng(readFileSync(join(dir, ref.file)))).toMatchObject({ width: 8, height: 6, channels: 4 });
    const mask = decodePng(readFileSync(join(dir, ref.remap)));
    expect(mask).toMatchObject({ width: 8, height: 6, channels: 1 });
    expect(mask.data[2 * 8 + 2]).toBe(255);
    const args = JSON.parse(readFileSync(join(cacheDir, 'sprite-args.json'), 'utf8')) as string[];
    expect(args[args.indexOf('-s') + 1]).toBe('4');
    expect(args[args.indexOf('-n') + 1]).toBe('realesrgan-x4plus');
    expect(existsSync(dirname(args[args.indexOf('-i') + 1]!))).toBe(false);
  });

  it('updates only the selected library page and preserves page indices and all unrelated metadata', async () => {
    const { cacheDir, dir, library } = libraryFixture();
    const onPage = vi.fn();
    const results = await upscaleSprites({ cacheDir, library: 'temperate', pages: [2], run: fakeNearestRun, onPage });
    const ref = { file: 'sprites-2@2x.png', remap: 'sprites-2@2x-remap.png', scale: 2, width: 6, height: 4 };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ page: 2, frames: 1, ref, published: true });
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(results[0]);
    expect(JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8'))).toEqual({
      ...library,
      spriteAtlasesHd: [library.spriteAtlasesHd[0], null, ref],
    });
    expect(existsSync(join(dir, 'sprites-0@2x.png'))).toBe(false);
    expect(existsSync(join(dir, 'sprites-1@2x.png'))).toBe(false);
    expect(
      decodePng(readFileSync(join(dir, ref.file)))
        .data.filter((_, index) => index % 4 === 3)
        .filter(Boolean),
    ).toHaveLength(4);
  });

  it('creates null placeholders for unprocessed library pages when no HD references exist', async () => {
    const { cacheDir, dir, library } = libraryFixture();
    const { spriteAtlasesHd: _oldHd, ...source } = library;
    writeFileSync(join(dir, 'library.json'), JSON.stringify(source));
    await upscaleSprites({ cacheDir, library: 'temperate', pages: [1], run: fakeNearestRun });
    const updated = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as { spriteAtlasesHd: unknown[] };
    expect(updated.spriteAtlasesHd).toEqual([
      null,
      { file: 'sprites-1@2x.png', remap: 'sprites-1@2x-remap.png', scale: 2, width: 6, height: 4 },
      null,
    ]);
  });

  it('processes every library page by default and retains source PNGs', async () => {
    const { cacheDir, dir, library } = libraryFixture();
    const source = library.spriteAtlases.map(({ file }) => readFileSync(join(dir, file)));
    const run = vi.fn(fakeNearestRun);
    const results = await upscaleSprites({ cacheDir, library: 'temperate', run });
    expect(results.map(({ page }) => page)).toEqual([0, 1, 2]);
    expect(run).toHaveBeenCalledTimes(3);
    const updated = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as { spriteAtlasesHd: unknown[] };
    expect(updated.spriteAtlasesHd).toHaveLength(3);
    expect(updated.spriteAtlasesHd.every(Boolean)).toBe(true);
    for (const [index, { file }] of library.spriteAtlases.entries())
      expect(readFileSync(join(dir, file))).toEqual(source[index]);
  });

  it('leaves a page published at another scale to its own tool', async () => {
    const { cacheDir, dir, library } = libraryFixture();
    const redraw = { file: 'sprites-2@4x.png', remap: 'sprites-2@4x-remap.png', scale: 4, width: 12, height: 8 };
    const document = { ...library, spriteAtlasesHd: [library.spriteAtlasesHd[0], null, redraw] };
    writeFileSync(join(dir, 'library.json'), JSON.stringify(document));
    const run = vi.fn(fakeNearestRun);
    const results = await upscaleSprites({ cacheDir, library: 'temperate', run });
    expect(results.map(({ page }) => page)).toEqual([0, 1]);
    const updated = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as { spriteAtlasesHd: unknown[] };
    expect(updated.spriteAtlasesHd[2]).toEqual(redraw);
    await expect(upscaleSprites({ cacheDir, library: 'temperate', pages: [2], run })).rejects.toThrow(/4x HD page/);
    expect(existsSync(join(dir, 'sprites-2@2x.png'))).toBe(false);
  });

  it('keeps debug frame-limit output separate without publishing incomplete map or library references', async () => {
    const map = mapFixture();
    const library = libraryFixture();
    for (const fixture of [map, library]) {
      const isMap = fixture === map;
      const metadata = join(fixture.dir, isMap ? 'manifest.json' : 'library.json');
      const before = readFileSync(metadata);
      const results = await upscaleSprites({
        cacheDir: fixture.cacheDir,
        ...(isMap ? { map: 'synthetic-map' } : { library: 'temperate', pages: [1] }),
        limitFrames: 10,
        run: fakeNearestRun,
      });
      expect(results[0]).toMatchObject({ frames: 1, published: false });
      expect(readFileSync(metadata)).toEqual(before);
      const stem = isMap ? 'sprites' : 'sprites-1';
      expect(existsSync(join(fixture.dir, `${stem}@2x-debug.png`))).toBe(true);
      expect(existsSync(join(fixture.dir, `${stem}@2x-debug-remap.png`))).toBe(true);
      expect(existsSync(join(fixture.dir, `${stem}@2x.png`))).toBe(false);
    }
  });

  it('leaves map metadata and existing HD output unchanged when inference fails', async () => {
    const { cacheDir, dir } = mapFixture();
    const before = readFileSync(join(dir, 'manifest.json'));
    const previous = Uint8Array.of(1, 2, 3);
    writeFileSync(join(dir, 'sprites@2x.png'), previous);
    await expect(
      upscaleSprites({
        cacheDir,
        map: 'synthetic-map',
        run: async () => {
          throw new Error('synthetic inference failure');
        },
      }),
    ).rejects.toThrow(/synthetic inference failure/);
    expect(readFileSync(join(dir, 'manifest.json'))).toEqual(before);
    expect(readFileSync(join(dir, 'sprites@2x.png'))).toEqual(Buffer.from(previous));
    expect(existsSync(join(dir, 'sprites@2x-remap.png'))).toBe(false);
  });

  it('retains a completed library page but never publishes the page whose inference failed', async () => {
    const { cacheDir, dir, library } = libraryFixture();
    let calls = 0;
    await expect(
      upscaleSprites({
        cacheDir,
        library: 'temperate',
        pages: [0, 1],
        run: async (bin, args) => {
          if (++calls === 2) throw new Error('second page failed');
          await fakeNearestRun(bin, args);
        },
      }),
    ).rejects.toThrow(/second page failed/);
    const updated = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as typeof library;
    expect(updated.spriteAtlasesHd[0]).toEqual(library.spriteAtlasesHd[0]);
    expect(updated.spriteAtlasesHd[1]).toBeNull();
    expect(existsSync(join(dir, 'sprites-0@2x.png'))).toBe(true);
    expect(existsSync(join(dir, 'sprites-1@2x.png'))).toBe(false);
  });

  it('rejects invalid selectors and page selections before running inference', async () => {
    const { cacheDir } = libraryFixture();
    const run = vi.fn(fakeNearestRun);
    await expect(upscaleSprites({ cacheDir, run })).rejects.toThrow();
    await expect(upscaleSprites({ cacheDir, map: 'one', library: 'temperate', run })).rejects.toThrow();
    await expect(upscaleSprites({ cacheDir, map: 'one', pages: [0], run })).rejects.toThrow();
    await expect(upscaleSprites({ cacheDir, library: 'temperate', pages: [3], run })).rejects.toThrow();
    await expect(upscaleSprites({ cacheDir, library: 'temperate', pages: [-1], run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
