import { LinearMipmapLinearFilter, NearestFilter, RedFormat, SRGBColorSpace, Texture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadIndexedPage } from '../src/live/library';
import { PageUploader, WHOLE_UPLOAD_PIXELS } from '../src/pageUpload';
import { loadHdTexture } from '../src/ra2/cache';

interface Copy {
  source: unknown;
  sourceY: number;
  flipY: boolean;
  texture: unknown;
  mipLevel: number;
  y: number;
  premultipliedAlpha: boolean;
  width: number;
  height: number;
}

/** A renderer whose backend looks like three's WebGPU backend: allocation, row copies and mipmaps are recorded. */
function gpuHost() {
  const copies: Copy[] = [];
  const allocated = new Map<Texture, { rows: number; dataReady: boolean; onUpdate: unknown }>();
  const mipmaps: Texture[] = [];
  const uploadedWhole: Texture[] = [];
  let allocate = true;
  const renderer = {
    initTexture: vi.fn((texture: Texture) => {
      const dataReady = (texture.source as unknown as { dataReady: boolean }).dataReady;
      if (dataReady) {
        // three copies the whole image, generates mipmaps and reports back.
        uploadedWhole.push(texture);
        texture.onUpdate?.(texture);
        return;
      }
      if (allocate) allocated.set(texture, { rows: 0, dataReady, onUpdate: texture.onUpdate });
    }),
    backend: {
      device: {
        queue: {
          copyExternalImageToTexture: vi.fn(
            (
              source: { source: unknown; origin: { x: number; y: number }; flipY: boolean },
              destination: {
                texture: unknown;
                mipLevel: number;
                origin: { x: number; y: number; z: number };
                premultipliedAlpha: boolean;
              },
              size: { width: number; height: number },
            ) => {
              copies.push({
                source: source.source,
                sourceY: source.origin.y,
                flipY: source.flipY,
                texture: destination.texture,
                mipLevel: destination.mipLevel,
                y: destination.origin.y,
                premultipliedAlpha: destination.premultipliedAlpha,
                width: size.width,
                height: size.height,
              });
            },
          ),
        },
      },
      get: vi.fn((texture: Texture) => (allocated.has(texture) ? { texture: { gpuOf: texture } } : {})),
      generateMipmaps: vi.fn((texture: Texture) => void mipmaps.push(texture)),
    },
  };
  return {
    renderer,
    copies,
    allocated,
    mipmaps,
    uploadedWhole,
    refuseAllocation() {
      allocate = false;
    },
  };
}

function page(width: number, height: number): { texture: Texture; image: object; updated: ReturnType<typeof vi.fn> } {
  const image = { width, height };
  const texture = new Texture(image as unknown as HTMLImageElement);
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.generateMipmaps = true;
  const updated = vi.fn();
  texture.onUpdate = updated;
  texture.needsUpdate = true;
  return { texture, image, updated };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('atlas pages uploaded in strips', () => {
  it('allocates the texture empty, copies rows within each frame budget and finishes with mipmaps', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const { texture, image, updated } = page(8, 10);
    const done = uploader.upload(texture) as Promise<void>;
    expect(done).toBeInstanceOf(Promise);
    // Allocation only: three saw no data to copy, and the loader was not told the upload is over.
    expect(host.allocated.get(texture)).toMatchObject({ dataReady: false, onUpdate: null });
    expect((texture.source as unknown as { dataReady: boolean }).dataReady).toBe(true);
    expect(texture.onUpdate).toBe(updated);
    expect(updated).not.toHaveBeenCalled();
    expect(host.copies).toHaveLength(0);
    expect(uploader.pending).toBe(1);
    // 24 pixels per frame = three rows of eight.
    uploader.step(24);
    uploader.step(24);
    uploader.step(24);
    expect(host.copies.map((copy) => [copy.y, copy.height])).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
    ]);
    expect(host.mipmaps).toHaveLength(0);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    uploader.step(24);
    expect(host.copies.at(-1)).toMatchObject({ y: 9, sourceY: 9, height: 1, width: 8 });
    // Every row once, from the same rows of the image, with the flags three uses for a whole upload.
    expect(host.copies.reduce((rows, copy) => rows + copy.height, 0)).toBe(10);
    for (const copy of host.copies)
      expect(copy).toMatchObject({
        source: image,
        sourceY: copy.y,
        flipY: false,
        mipLevel: 0,
        premultipliedAlpha: false,
        texture: { gpuOf: texture },
      });
    expect(host.mipmaps).toEqual([texture]);
    expect(updated).toHaveBeenCalledWith(texture);
    await done;
    expect(uploader.pending).toBe(0);
    // Nothing waits: a step copies nothing.
    uploader.step(24);
    expect(host.copies).toHaveLength(4);
  });

  it('copies at least one row per frame and several pages in the order they arrived', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const first = page(8, 3);
    const second = page(8, 3);
    second.texture.generateMipmaps = false;
    const done = [uploader.upload(first.texture), uploader.upload(second.texture)] as Promise<void>[];
    uploader.step(1);
    expect(host.copies).toHaveLength(1);
    expect(host.copies[0]).toMatchObject({ y: 0, height: 1, texture: { gpuOf: first.texture } });
    // One budget can finish a page and start the next.
    uploader.step(32);
    expect(
      host.copies.map((copy) => [(copy.texture as { gpuOf: Texture }).gpuOf === first.texture, copy.y, copy.height]),
    ).toEqual([
      [true, 0, 1],
      [true, 1, 2],
      [false, 0, 2],
    ]);
    await done[0];
    uploader.step(32);
    await done[1];
    // No mipmaps for a page that has none (indexed pages).
    expect(host.mipmaps).toEqual([first.texture]);
    expect(second.updated).toHaveBeenCalledTimes(1);
  });

  it('takes a page that is waited for before one loaded ahead, and the smaller of two first', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const hd = page(8, 8);
    const ahead = page(8, 3);
    const indexed = page(8, 4);
    let promoted = false;
    const done = [
      uploader.upload(hd.texture),
      // Nothing waits for this one yet (asked again every time the next page is chosen).
      uploader.upload(ahead.texture, () => !promoted),
      uploader.upload(indexed.texture),
    ] as Promise<void>[];
    const order = () => host.copies.map((copy) => (copy.texture as { gpuOf: Texture }).gpuOf);
    // The indexed page an object can already be drawn from does not queue behind the larger HD page before it.
    uploader.step(8 * 4);
    expect(order()).toEqual([indexed.texture]);
    await done[2];
    // A page whose rows are going in is finished before another is begun, whatever arrives or changes meanwhile.
    uploader.step(8 * 2);
    expect(order().slice(1)).toEqual([hd.texture]);
    const late = page(8, 3);
    done.push(uploader.upload(late.texture) as Promise<void>);
    uploader.step(8 * 6);
    expect(order().slice(1)).toEqual([hd.texture, hd.texture]);
    await done[0];
    // Now the page that is waited for; the page loaded ahead, as small and older, stays last.
    uploader.step(8 * 3);
    expect(order().at(-1)).toBe(late.texture);
    await done[3];
    expect(uploader.pending).toBe(1);
    uploader.step(8 * 3);
    expect(order().at(-1)).toBe(ahead.texture);
    await done[1];
    expect(uploader.pending).toBe(0);
  });

  it('moves a page loaded ahead in front of larger ones the moment something waits for it', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const large = page(8, 8);
    const ahead = page(8, 4);
    let wanted = false;
    const done = [uploader.upload(large.texture), uploader.upload(ahead.texture, () => !wanted)] as Promise<void>[];
    wanted = true;
    uploader.step(8 * 4);
    expect(host.copies.map((copy) => (copy.texture as { gpuOf: Texture }).gpuOf)).toEqual([ahead.texture]);
    await done[1];
    uploader.step(8 * 8);
    await done[0];
  });

  it('uploads small pages, flipped pages and unsupported backends whole, at once', () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 64);
    const small = page(8, 8);
    expect(uploader.upload(small.texture)).toBeUndefined();
    expect(host.uploadedWhole).toEqual([small.texture]);
    expect(small.updated).toHaveBeenCalledTimes(1);
    const flipped = page(16, 16);
    flipped.texture.flipY = true;
    expect(uploader.upload(flipped.texture)).toBeUndefined();
    expect(host.uploadedWhole).toEqual([small.texture, flipped.texture]);
    // The WebGL2 fallback (or a three whose backend differs): no device queue to copy rows with.
    const plain = { initTexture: vi.fn((texture: Texture) => texture.onUpdate?.(texture)), backend: {} };
    const large = page(4096, 4096);
    expect(new PageUploader(plain).upload(large.texture)).toBeUndefined();
    expect(plain.initTexture).toHaveBeenCalledWith(large.texture);
    expect(large.updated).toHaveBeenCalledTimes(1);
    expect(host.copies).toHaveLength(0);
    expect(4096 * 4096).toBeGreaterThan(WHOLE_UPLOAD_PIXELS);
  });

  it('falls back to a whole upload when the texture was not allocated as expected', () => {
    const host = gpuHost();
    host.refuseAllocation();
    const uploader = new PageUploader(host.renderer, 16);
    const { texture, updated } = page(8, 8);
    const version = texture.version;
    expect(uploader.upload(texture)).toBeUndefined();
    expect(texture.version).toBeGreaterThan(version);
    expect(host.uploadedWhole).toEqual([texture]);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(uploader.pending).toBe(0);
  });

  it('rejects a page whose copy fails and goes on with the next one', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const broken = page(8, 4);
    const fine = page(8, 4);
    const failed = uploader.upload(broken.texture) as Promise<void>;
    const done = uploader.upload(fine.texture) as Promise<void>;
    host.renderer.backend.device.queue.copyExternalImageToTexture.mockImplementationOnce(() => {
      throw new Error('bitmap closed');
    });
    uploader.step(64);
    await expect(failed).rejects.toThrow('bitmap closed');
    await done;
    expect(broken.updated).not.toHaveBeenCalled();
    expect(fine.updated).toHaveBeenCalledTimes(1);
  });

  it('rejects what waits when disposed and refuses later uploads', async () => {
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const waiting = uploader.upload(page(8, 8).texture) as Promise<void>;
    uploader.dispose();
    await expect(waiting).rejects.toThrow('disposed');
    expect(uploader.pending).toBe(0);
    expect(() => uploader.upload(page(8, 8).texture)).toThrow('disposed');
    uploader.dispose();
  });
});

describe('page loaders wait for an upload that takes several frames', () => {
  function stubHost() {
    const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('png')),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        const bitmap = { width: 8, height: 8, close: vi.fn() };
        bitmaps.push(bitmap);
        return bitmap;
      }),
    );
    return bitmaps;
  }

  it('hands an HD page out only after its last strip, and releases the bitmap then', async () => {
    const bitmaps = stubHost();
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    let texture: Texture | null = null;
    const loading = loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace, (page) => uploader.upload(page)).then(
      (loaded) => (texture = loaded),
    );
    await vi.waitFor(() => expect(uploader.pending).toBe(1));
    uploader.step(32);
    await Promise.resolve();
    expect(texture).toBeNull();
    expect(bitmaps[0]!.close).not.toHaveBeenCalled();
    uploader.step(32);
    await loading;
    expect(texture!.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture!.image).toEqual({ width: 8, height: 8 });
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(host.mipmaps).toEqual([texture]);
  });

  it('does the same for an indexed page, which has no mipmaps', async () => {
    const bitmaps = stubHost();
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const loading = loadIndexedPage('/hd-cache/_library/urban/sprites-0.png', (page) => uploader.upload(page));
    await vi.waitFor(() => expect(uploader.pending).toBe(1));
    expect(bitmaps[0]!.close).not.toHaveBeenCalled();
    uploader.step(64);
    const texture = await loading;
    expect(texture.format).toBe(RedFormat);
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.image).toEqual({ width: 8, height: 8 });
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(host.mipmaps).toHaveLength(0);
  });

  it('releases the bitmap of a page whose upload was abandoned', async () => {
    const bitmaps = stubHost();
    const host = gpuHost();
    const uploader = new PageUploader(host.renderer, 16);
    const loading = loadHdTexture('/hd-cache/X/sprites@2x.png', SRGBColorSpace, (page) => uploader.upload(page));
    await vi.waitFor(() => expect(uploader.pending).toBe(1));
    uploader.dispose();
    await expect(loading).rejects.toThrow('disposed');
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });
});
