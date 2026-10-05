import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace, type Texture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHdAtlas, loadHdTexture } from '../src/ra2/cache';

interface FakeBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

/** Synthetic host: every URL but `missing` answers with a blob; decoding yields a closeable 8 x 4 bitmap. */
function stubHost(missing: string[] = []) {
  const bitmaps: FakeBitmap[] = [];
  const fetchFile = vi.fn(async (url: string) =>
    missing.some((name) => url.endsWith(name)) ? new Response('not found', { status: 404 }) : new Response('png'),
  );
  const decode = vi.fn(async (_blob: Blob, _options?: ImageBitmapOptions) => {
    const bitmap: FakeBitmap = { width: 8, height: 4, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal('fetch', fetchFile);
  vi.stubGlobal('createImageBitmap', decode);
  return { bitmaps, fetchFile, decode };
}

/** What the renderer's initTexture does for a texture it uploads: it reports back through onUpdate. */
const rendererUpload = (texture: Texture) => texture.onUpdate?.(texture);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HD atlas pages are decoded off the main thread', () => {
  it('decodes straight-alpha, unconverted bitmaps and keeps the atlas sampling contract', async () => {
    const host = stubHost();
    const atlas = await loadHdAtlas('/hd-cache/_library/temperate', {
      file: 'sprites-3@2x.png',
      remap: 'sprites-3@2x-remap.png',
      scale: 2,
      width: 8,
      height: 4,
      paintSaturation: 0.8,
    });
    expect(host.fetchFile.mock.calls.map(([url]) => url)).toEqual([
      '/hd-cache/_library/temperate/sprites-3@2x.png',
      '/hd-cache/_library/temperate/sprites-3@2x-remap.png',
    ]);
    for (const [, options] of host.decode.mock.calls)
      expect(options).toEqual({ colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    expect(atlas.color.colorSpace).toBe(SRGBColorSpace);
    expect(atlas.remap.colorSpace).toBe(NoColorSpace);
    expect(atlas.paintSaturation).toBe(0.8);
    for (const texture of [atlas.color, atlas.remap]) {
      expect(texture.flipY).toBe(false);
      expect(texture.premultiplyAlpha).toBe(false);
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.generateMipmaps).toBe(true);
      // Marked for its first upload.
      expect(texture.version).toBe(1);
    }
  });

  it('without an eager upload the bitmap lives until the first upload, then only the size remains', async () => {
    const host = stubHost();
    const texture = await loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace);
    expect(texture.image).toBe(host.bitmaps[0]);
    expect(host.bitmaps[0]!.close).not.toHaveBeenCalled();
    rendererUpload(texture);
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(texture.image).toEqual({ width: 8, height: 4 });
    expect(texture.onUpdate).toBeNull();
    // Disposal after the upload does not close the bitmap a second time.
    texture.dispose();
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('a page disposed before it was ever drawn releases its bitmap', async () => {
    const host = stubHost();
    const texture = await loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace);
    texture.dispose();
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('an eager upload releases both bitmaps before the atlas is handed out', async () => {
    const host = stubHost();
    const upload = vi.fn(rendererUpload);
    const atlas = await loadHdAtlas('/hd-cache/_library/snow', {
      file: 'a@2x.png',
      remap: 'a@2x-remap.png',
      scale: 2,
      width: 8,
      height: 4,
    });
    expect(atlas.paintSaturation).toBe(1);
    const eager = await loadHdAtlas(
      '/hd-cache/_library/snow',
      { file: 'a@2x.png', remap: 'a@2x-remap.png', scale: 2, width: 8, height: 4 },
      upload,
    );
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([texture]) => texture)).toEqual([eager.color, eager.remap]);
    // Bitmaps 2 and 3 belong to the eager atlas.
    for (const bitmap of host.bitmaps.slice(2)) expect(bitmap.close).toHaveBeenCalledTimes(1);
    for (const texture of [eager.color, eager.remap]) expect(texture.image).toEqual({ width: 8, height: 4 });
    // The lazily uploaded atlas still owns its two.
    for (const bitmap of host.bitmaps.slice(0, 2)) expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('an upload that does not report back still releases the decoded page', async () => {
    const host = stubHost();
    const texture = await loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace, () => undefined);
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(texture.image).toEqual({ width: 8, height: 4 });
  });

  it('a failing upload disposes the texture and rejects', async () => {
    const host = stubHost();
    const failure = await loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace, () => {
      throw new Error('device lost');
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('device lost');
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('half a pair is no atlas: the page that loaded is freed and the load rejects', async () => {
    const host = stubHost(['a@2x-remap.png']);
    const failure = await loadHdAtlas('/hd-cache/_library/urban', {
      file: 'a@2x.png',
      remap: 'a@2x-remap.png',
      scale: 2,
      width: 8,
      height: 4,
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('a@2x-remap.png: HTTP 404');
    expect(host.bitmaps).toHaveLength(1);
    expect(host.bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });
});
