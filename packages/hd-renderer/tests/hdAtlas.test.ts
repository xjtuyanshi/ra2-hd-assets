import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace, type Texture } from 'three/webgpu';
import type { SpriteAtlasHdRef } from '../../ra2-assets/src/manifest';
import {
  HD_SUPERSAMPLE_ABOVE_SCALE,
  hdSupersampled,
  loadHdAtlas,
  type HdAtlasRef,
  type Ra2Cache,
} from '../src/ra2/cache';
import { LiveLibrary } from '../src/live/library';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ref: SpriteAtlasHdRef = { file: 'color.png', remap: 'paint.png', scale: 2, width: 8, height: 8 };

/**
 * Synthetic host for loadHdTexture: pages are fetched and decoded with createImageBitmap. Each decoded bitmap remembers
 * the URL it came from (`bitmapUrls`), in decode order.
 */
function stubPages(respond: (url: string) => Response = () => new Response('png')) {
  const fetched: string[] = [];
  const blobUrls = new Map<Blob, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      const response = respond(url);
      if (!response.ok || !url.endsWith('.png')) return response;
      const blob = new Blob([url]);
      blobUrls.set(blob, url);
      return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
    }),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (blob: Blob) => ({ width: 8, height: 8, close: vi.fn(), url: blobUrls.get(blob) })),
  );
  return fetched;
}

const pageUrl = (texture: Texture) => (texture.image as unknown as { url: string }).url;

describe('HD atlas house-paint saturation', () => {
  it.each([undefined, 1, 0.82, 0])(
    'loads saturation %s without changing texture interpretation',
    async (saturation) => {
      const fetched = stubPages();
      const page: HdAtlasRef = { ...ref, paintSaturation: saturation };
      const atlas = await loadHdAtlas('/synthetic', page);
      const { color, remap } = atlas;
      expect(atlas.paintSaturation).toBe(saturation ?? 1);
      expect(fetched).toEqual(['/synthetic/color.png', '/synthetic/paint.png']);
      expect(pageUrl(color)).toBe('/synthetic/color.png');
      expect(pageUrl(remap)).toBe('/synthetic/paint.png');
      expect(color.colorSpace).toBe(SRGBColorSpace);
      expect(remap.colorSpace).toBe(NoColorSpace);
      for (const texture of [color, remap]) {
        expect(texture.flipY).toBe(false);
        expect(texture.magFilter).toBe(LinearFilter);
        expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
        expect(texture.generateMipmaps).toBe(true);
        texture.dispose();
      }
    },
  );

  it('carries the page scale and lists pages above 2x as a supersampled look', async () => {
    stubPages();
    expect((await loadHdAtlas('/synthetic', ref)).scale).toBe(2);
    expect((await loadHdAtlas('/synthetic', { ...ref, scale: 4, width: 16, height: 16 })).scale).toBe(4);
    expect(hdSupersampled({ scale: 4 }, 2)).toBe(true);
    expect(hdSupersampled({ scale: 2 }, 4)).toBe(false);
    expect(hdSupersampled({}, 4)).toBe(true);
    expect(hdSupersampled(null, 4)).toBe(false);
    expect(HD_SUPERSAMPLE_ABOVE_SCALE).toBe(2);
    const pages: SpriteAtlasHdRef[] = [ref, { ...ref, file: 'gi@4x.png', remap: 'gi@4x-remap.png', scale: 4 }];
    stubPages((url) =>
      url.endsWith('/library.json')
        ? new Response(JSON.stringify({ palettes: {}, spriteAtlasesHd: [...pages, null] }))
        : new Response(null, { status: 404 }),
    );
    const library = (await LiveLibrary.load('/synthetic/', {} as Ra2Cache))!;
    expect(library.hdPageLooks()).toEqual([
      { paintSaturation: 1, materials: false, windows: false, supersample: false },
      { paintSaturation: 1, materials: false, windows: false, supersample: true },
    ]);
  });

  it('retains each live page grade across asynchronous loads and cached reads', async () => {
    const pages: SpriteAtlasHdRef[] = [
      { ...ref, paintSaturation: 0.82 },
      { ...ref, file: 'unchanged.png', remap: 'unchanged-paint.png' },
      { ...ref, file: 'grey.png', remap: 'grey-paint.png', paintSaturation: 0 },
    ];
    const fetched = stubPages((url) =>
      url.endsWith('/library.json')
        ? new Response(JSON.stringify({ palettes: {}, spriteAtlasesHd: pages }))
        : url.endsWith('.png')
          ? new Response('png')
          : new Response(null, { status: 404 }),
    );
    const library = (await LiveLibrary.load('/synthetic/', {} as Ra2Cache))!;
    for (const index of [0, 1, 2]) {
      expect(library.hdPage(index)).toBeNull();
      expect(library.hdPage(index)).toBeNull();
    }
    await vi.waitFor(() => expect(library.revision).toBe(3));
    for (const [index, page] of pages.entries()) {
      const atlas = library.hdPage(index)!;
      expect(pageUrl(atlas.color)).toBe(`/synthetic/${page.file}`);
      expect(pageUrl(atlas.remap)).toBe(`/synthetic/${page.remap}`);
      expect(atlas.paintSaturation).toBe(page.paintSaturation ?? 1);
      expect(library.hdPage(index)).toBe(atlas);
    }
    expect(library.hdPage(3)).toBeNull();
    expect(fetched.filter((url) => url.endsWith('.png'))).toHaveLength(6);
    for (const index of [0, 1, 2]) {
      const atlas = library.hdPage(index)!;
      atlas.color.dispose();
      atlas.remap.dispose();
    }
  });
});
