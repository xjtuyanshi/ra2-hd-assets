import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three/webgpu';
import type { SpriteAtlasHdRef } from '../../ra2-assets/src/manifest';
import { loadHdAtlas, type HdAtlasRef, type Ra2Cache } from '../src/ra2/cache';
import { LiveLibrary } from '../src/live/library';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ref: SpriteAtlasHdRef = { file: 'color.png', remap: 'paint.png', scale: 2, width: 8, height: 8 };

describe('HD atlas house-paint saturation', () => {
  it.each([undefined, 1, 0.82, 0])(
    'loads saturation %s without changing texture interpretation',
    async (saturation) => {
      const color = new Texture();
      const remap = new Texture();
      const load = vi
        .spyOn(TextureLoader.prototype, 'loadAsync')
        .mockResolvedValueOnce(color)
        .mockResolvedValueOnce(remap);
      const page: HdAtlasRef = { ...ref, paintSaturation: saturation };
      const atlas = await loadHdAtlas('/synthetic', page);
      expect(atlas).toEqual({ color, remap, paintSaturation: saturation ?? 1 });
      expect(load.mock.calls.map(([url]) => url)).toEqual(['/synthetic/color.png', '/synthetic/paint.png']);
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

  it('retains each live page grade across asynchronous loads and cached reads', async () => {
    const pages: SpriteAtlasHdRef[] = [
      { ...ref, paintSaturation: 0.82 },
      { ...ref, file: 'unchanged.png', remap: 'unchanged-paint.png' },
      { ...ref, file: 'grey.png', remap: 'grey-paint.png', paintSaturation: 0 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/library.json')
          ? new Response(JSON.stringify({ palettes: {}, spriteAtlasesHd: pages }))
          : new Response(null, { status: 404 }),
      ),
    );
    const textures = new Map<string, Texture>();
    const load = vi.spyOn(TextureLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      const texture = new Texture();
      textures.set(url, texture);
      return texture;
    });
    const library = (await LiveLibrary.load('/synthetic/', {} as Ra2Cache))!;
    for (const index of [0, 1, 2]) {
      expect(library.hdPage(index)).toBeNull();
      expect(library.hdPage(index)).toBeNull();
    }
    await vi.waitFor(() => expect(library.revision).toBe(3));
    for (const [index, page] of pages.entries()) {
      const atlas = library.hdPage(index);
      expect(atlas).toEqual({
        color: textures.get(`/synthetic/${page.file}`),
        remap: textures.get(`/synthetic/${page.remap}`),
        paintSaturation: page.paintSaturation ?? 1,
      });
      expect(library.hdPage(index)).toBe(atlas);
    }
    expect(library.hdPage(3)).toBeNull();
    expect(load).toHaveBeenCalledTimes(6);
    for (const texture of textures.values()) texture.dispose();
  });
});
