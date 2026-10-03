import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearestFilter, NoColorSpace, RedFormat, UnsignedByteType } from 'three/webgpu';
import { LiveLibrary } from '../src/live/library';
import type { Ra2Cache } from '../src/ra2/cache';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const descriptor = { file: 'buildngz.bin', width: 2, height: 2 };

function resources(depthTemplate: unknown = descriptor, bytes = new Uint8Array([0, 127, 128, 255])) {
  const cache = {} as Ra2Cache;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/library.json')) return Response.json({ palettes: {}, spriteAtlasesHd: [], depthTemplate });
    if (url.endsWith('/buildngz.bin')) return new Response(bytes);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  return { cache, fetcher, load: () => LiveLibrary.load('/library/', cache) };
}

describe('shared native building depth template', () => {
  it('makes one byte-exact R8 texture available before the library load resolves', async () => {
    const r = resources();
    const library = (await r.load())!;
    const { texture, width, height } = r.cache.depthTemplate!;
    expect([width, height]).toEqual([2, 2]);
    expect(texture.image.data).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(texture.image.width).toBe(width);
    expect(texture.image.height).toBe(height);
    expect(texture.format).toBe(RedFormat);
    expect(texture.type).toBe(UnsignedByteType);
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.flipY).toBe(false);
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.unpackAlignment).toBe(1);
    expect(texture.version).toBeGreaterThan(0);
    expect(r.fetcher.mock.calls.filter(([url]) => url.endsWith('/buildngz.bin'))).toHaveLength(1);
    library.disposeDepthTemplate();
  });

  it('keeps an older library on the analytic path without requesting a template', async () => {
    const r = resources();
    r.fetcher.mockImplementation(async () => Response.json({ palettes: {}, spriteAtlasesHd: [] }));
    const library = (await r.load())!;
    expect(r.cache.depthTemplate).toBeUndefined();
    expect(r.fetcher.mock.calls.some(([url]) => url.endsWith('.bin'))).toBe(false);
    library.disposeDepthTemplate();
  });

  it.each([0, 3, 5])('rejects %i bytes for a declared 2x2 template', async (length) => {
    const r = resources(descriptor, new Uint8Array(length));
    await expect(r.load()).rejects.toThrow(`depthTemplate has ${length} bytes, expected 4`);
    expect(r.cache.depthTemplate).toBeUndefined();
  });

  it.each([
    null,
    { ...descriptor, file: '' },
    { ...descriptor, width: 0 },
    { ...descriptor, height: -1 },
    { ...descriptor, width: 1.5 },
    { ...descriptor, width: Number.MAX_SAFE_INTEGER },
  ])('rejects invalid descriptor %j before requesting bytes', async (ref) => {
    const r = resources(ref);
    await expect(r.load()).rejects.toThrow('invalid depthTemplate descriptor');
    expect(r.fetcher.mock.calls.some(([url]) => url.endsWith('.bin'))).toBe(false);
    expect(r.cache.depthTemplate).toBeUndefined();
  });

  it('reports a declared template fetch failure instead of silently using legacy depth', async () => {
    const r = resources();
    r.fetcher.mockImplementation(async (url) =>
      url.endsWith('/library.json')
        ? Response.json({ palettes: {}, spriteAtlasesHd: [], depthTemplate: descriptor })
        : new Response(null, { status: 404 }),
    );
    await expect(r.load()).rejects.toThrow('/library/buildngz.bin: HTTP 404');
    expect(r.cache.depthTemplate).toBeUndefined();
  });

  it('disposes the owned texture once and does not detach a replacement library', async () => {
    const r = resources();
    const first = (await r.load())!;
    const firstTemplate = r.cache.depthTemplate!;
    const disposedFirst = vi.fn();
    firstTemplate.texture.addEventListener('dispose', disposedFirst);
    const second = (await r.load())!;
    const secondTemplate = r.cache.depthTemplate!;
    const disposedSecond = vi.fn();
    secondTemplate.texture.addEventListener('dispose', disposedSecond);
    first.disposeDepthTemplate();
    first.disposeDepthTemplate();
    expect(disposedFirst).toHaveBeenCalledTimes(1);
    expect(disposedSecond).not.toHaveBeenCalled();
    expect(r.cache.depthTemplate).toBe(secondTemplate);
    second.disposeDepthTemplate();
    second.disposeDepthTemplate();
    expect(disposedSecond).toHaveBeenCalledTimes(1);
    expect(r.cache.depthTemplate).toBeUndefined();
  });
});
