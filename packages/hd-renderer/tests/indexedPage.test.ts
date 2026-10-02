import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, RedFormat, NoColorSpace, NearestFilter } from 'three/webgpu';
import { loadIndexedPage } from '../src/live/library';
import { copyIndices, INDEXED_CHUNK_PIXELS } from '../src/live/indexedPixels';

afterEach(() => vi.unstubAllGlobals());

function bitmapFixture(width = 16, height = 4) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob() })),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  return bitmap;
}

describe('indexed atlas upload', () => {
  it('uploads R8 once without a canvas repack and releases the decoded bitmap', async () => {
    const bitmap = bitmapFixture();
    const canvas = vi.fn();
    vi.stubGlobal('OffscreenCanvas', canvas);
    const upload = vi.fn((texture) => {
      expect(texture.image).toBe(bitmap);
      expect(texture.format).toBe(RedFormat);
      expect(texture.colorSpace).toBe(NoColorSpace);
      expect(texture.minFilter).toBe(NearestFilter);
      expect(texture.generateMipmaps).toBe(false);
    });
    const texture = await loadIndexedPage('/atlas.png', upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(canvas).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(texture.image).toEqual({ width: 16, height: 4 });
  });

  it('releases the bitmap if the eager upload throws', async () => {
    const bitmap = bitmapFixture();
    await expect(
      loadIndexedPage('/atlas.png', () => {
        throw new Error('upload failed');
      }),
    ).rejects.toThrow('upload failed');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('bounds fallback RGBA reads, yields between strips and releases CPU data on upload', async () => {
    const width = 1024;
    const height = INDEXED_CHUNK_PIXELS / width + 1;
    const bitmap = bitmapFixture(width, height);
    const reads: number[] = [];
    let sourceY = 0;
    class Canvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          clearRect() {},
          drawImage(_bitmap: unknown, _x: number, y: number) {
            sourceY = y;
          },
          getImageData(_x: number, _y: number, w: number, h: number) {
            reads.push(w * h);
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < w * h; i++) data[i * 4] = (sourceY * w + i) % 251;
            return { data };
          },
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', Canvas);
    const texture = (await loadIndexedPage('/atlas.png')) as DataTexture;
    expect(reads).toEqual([INDEXED_CHUNK_PIXELS, width]);
    expect(texture.image.data!.byteLength).toBe(width * height);
    expect(texture.image.data![width * height - 1]).toBe((width * height - 1) % 251);
    expect(bitmap.close).toHaveBeenCalledOnce();
    texture.onUpdate!(texture);
    expect(texture.image.data).toBeNull();
    expect(texture.onUpdate).toBeNull();
  });

  it('copies the red byte exactly, including zero and high palette indices', () => {
    const out = new Uint8Array(5).fill(7);
    copyIndices(new Uint8ClampedArray([0, 99, 99, 255, 255, 0, 0, 255, 128, 1, 2, 3]), out, 1);
    expect(out).toEqual(new Uint8Array([7, 0, 255, 128, 7]));
  });
});
