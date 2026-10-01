import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from 'three/webgpu';
import type { TypeLibrary } from '../../ra2-assets/src/library';
import { LiveLibrary } from '../src/live/library';
import type { Ra2Cache } from '../src/ra2/cache';
import { loadSpriteMaterials, validateLibrarySpriteMaterials } from '../src/ra2/spriteMaterials';

const page = {
  file: 'sprites-0@2x-normals.png',
  atlas: 'sprites-0@2x.png',
  width: 64,
  height: 80,
  scale: 2,
  materialWidth: 32,
  materialHeight: 40,
  frames: 2,
};
const sidecar = () => ({ version: 1, pages: { '0': { ...page } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function resources(normals: unknown = sidecar()) {
  const library = {
    palettes: {},
    spriteAtlasesHd: [{ file: page.atlas, remap: 'remap.png', width: page.width, height: page.height, scale: 2 }],
  } as TypeLibrary;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/library.json')) return Response.json(library);
    if (url.endsWith('/normals.json')) return Response.json(normals);
    if (url.endsWith('/windows.json')) return new Response(null, { status: 404 });
    return new Response(new Blob(['synthetic material PNG']));
  });
  const bitmap = { width: 32, height: 40, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('createImageBitmap', decode);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { library, fetcher, decode, bitmap, warn, load: () => LiveLibrary.load('/library/', {} as Ra2Cache) };
}

describe('library material sidecar', () => {
  it('accepts independent material dimensions and 4x HD pages', () => {
    const json = sidecar();
    json.pages['0'].scale = 4;
    json.pages['0'].width = 128;
    expect(validateLibrarySpriteMaterials(json)).toEqual(json);
  });

  it.each([
    null,
    { version: 2, pages: {} },
    { version: 1, pages: [] },
    { version: 1 },
    { version: 1, pages: { '-1': page } },
    { version: 1, pages: { '0': null } },
    ...[
      { file: '../escape.png' },
      { atlas: '/absolute.png' },
      { width: 0 },
      { height: '80' },
      { materialWidth: 0 },
      { materialHeight: 1.5 },
      { scale: 0 },
      { frames: -1 },
    ].map((change) => ({ version: 1, pages: { '0': { ...page, ...change } } })),
  ])('rejects invalid metadata %j', (value) => {
    expect(() => validateLibrarySpriteMaterials(value)).toThrow();
  });

  it.each([{ width: 128 }, { height: 160 }, { file: 'other.png' }, { scale: 4 }])(
    'ignores a stale page once while retaining compatible pages (%j)',
    async (change) => {
      const json = { version: 1, pages: { '0': page, '1': { ...page, file: 'sprites-1@2x-normals.png' } } };
      const r = resources(json);
      r.library.spriteAtlasesHd!.push({ ...r.library.spriteAtlasesHd![0]! });
      Object.assign(r.library.spriteAtlasesHd![0]!, change);
      const library = (await r.load())!;
      for (let i = 0; i < 3; i++) {
        expect(library.hasMaterialsPage(0)).toBe(false);
        expect(library.materialsPage(0)).toBeNull();
      }
      expect(library.hasMaterialsPage(1)).toBe(true);
      expect(r.warn).toHaveBeenCalledTimes(1);
      expect(r.warn.mock.calls[0]![0]).toContain('page 0');
      expect(r.decode).not.toHaveBeenCalled();
    },
  );

  it('treats missing and invalid optional sidecars as no materials', async () => {
    const r = resources();
    r.fetcher.mockImplementation(async (url) =>
      url.endsWith('/library.json') ? Response.json(r.library) : new Response(null, { status: 404 }),
    );
    expect((await r.load())!.hasMaterialsPage(0)).toBe(false);
    expect(r.warn).not.toHaveBeenCalled();
    r.fetcher.mockImplementation(async (url) =>
      url.endsWith('/library.json') ? Response.json(r.library) : Response.json({ version: 99 }),
    );
    expect((await r.load())!.hasMaterialsPage(0)).toBe(false);
    expect(r.warn).toHaveBeenCalledTimes(1);
  });
});

describe('lazy library material textures', () => {
  it('loads once on demand with data-safe settings and publishes one revision', async () => {
    const r = resources();
    const library = (await r.load())!;
    expect(library.hasMaterialsPage(0)).toBe(true);
    expect(library.hasMaterialsPage(1)).toBe(false);
    expect(r.decode).not.toHaveBeenCalled();
    expect(r.fetcher.mock.calls.some(([url]) => url.endsWith('.png'))).toBe(false);
    expect(library.materialsPage(0)).toBeNull();
    expect(library.materialsPage(0)).toBeNull();
    await vi.waitFor(() => expect(library.revision).toBe(1));
    const atlas = library.materialsPage(0)!;
    expect(library.materialsPage(0)).toBe(atlas);
    expect(r.fetcher.mock.calls.filter(([url]) => url.endsWith('.png'))).toHaveLength(1);
    expect(r.decode).toHaveBeenCalledWith(expect.any(Blob), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    expect(atlas.texture.image).toBe(r.bitmap);
    expect(atlas.texture.colorSpace).toBe(NoColorSpace);
    expect(atlas.texture.premultiplyAlpha).toBe(false);
    expect(atlas.texture.flipY).toBe(false);
    expect(atlas.texture.magFilter).toBe(LinearFilter);
    expect(atlas.texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(atlas.texture.generateMipmaps).toBe(true);
    const disposed = vi.fn();
    atlas.texture.addEventListener('dispose', disposed);
    library.disposeMaterials();
    library.disposeMaterials();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(r.bitmap.close).toHaveBeenCalledTimes(1);
    expect(library.materialsPage(0)).toBeNull();
  });

  it.each(['fetch', 'decode'])('settles a %s failure once without retrying', async (stage) => {
    const r = resources();
    const library = (await r.load())!;
    if (stage === 'fetch') r.fetcher.mockResolvedValue(new Response(null, { status: 500 }));
    else r.decode.mockRejectedValue(new Error('invalid PNG'));
    library.materialsPage(0);
    await vi.waitFor(() => expect(library.revision).toBe(1));
    expect(library.hasMaterialsPage(0)).toBe(false);
    expect(library.materialsPage(0)).toBeNull();
    expect(library.materialsPage(0)).toBeNull();
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.fetcher.mock.calls.filter(([url]) => url.endsWith('.png'))).toHaveLength(1);
  });

  it('releases a late bitmap after the live view disposes', async () => {
    const r = resources();
    let complete!: (bitmap: typeof r.bitmap) => void;
    r.decode.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const library = (await r.load())!;
    library.materialsPage(0);
    await vi.waitFor(() => expect(r.decode).toHaveBeenCalledTimes(1));
    library.disposeMaterials();
    complete(r.bitmap);
    await vi.waitFor(() => expect(r.bitmap.close).toHaveBeenCalledTimes(1));
    expect(library.revision).toBe(0);
    expect(library.hasMaterialsPage(0)).toBe(false);
  });

  it('keeps the map loader on the same data texture path', async () => {
    const r = resources({ version: 1, ...page });
    const atlas = await loadSpriteMaterials('/map/', { width: 64, height: 80 });
    expect(atlas!.texture.image).toBe(r.bitmap);
    expect(atlas!.texture.colorSpace).toBe(NoColorSpace);
    expect(r.decode).toHaveBeenCalledWith(expect.any(Blob), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    expect(await loadSpriteMaterials('/map/', { width: 32, height: 40 })).toBeNull();
    expect(r.decode).toHaveBeenCalledTimes(1);
    atlas!.texture.dispose();
  });
});
