/** Maximum temporary RGBA pixels read at once, independent of atlas height. */
export const INDEXED_CHUNK_PIXELS = 256 * 1024;

/** Copy only the palette index (red channel), without applying colour transforms. */
export function copyIndices(rgba: Uint8ClampedArray, out: Uint8Array, offset: number): void {
  for (let i = 0, n = rgba.length / 4; i < n; i++) out[offset + i] = rgba[i * 4]!;
}

/**
 * Portable fallback for hosts without an eager GPU upload. Read bounded strips and yield between them so a large
 * atlas never monopolizes the main thread. The live renderer uses the bitmap-to-R8 upload instead.
 */
export async function indexedBitmapPixels(bitmap: ImageBitmap): Promise<Uint8Array> {
  const { width, height } = bitmap;
  const rows = Math.max(1, Math.floor(INDEXED_CHUNK_PIXELS / width));
  const canvas = new OffscreenCanvas(width, Math.min(rows, height));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Indexed atlas requires an OffscreenCanvas 2D context');
  const indices = new Uint8Array(width * height);
  try {
    for (let y = 0; y < height; y += rows) {
      const count = Math.min(rows, height - y);
      context.clearRect(0, 0, width, count);
      context.drawImage(bitmap, 0, y, width, count, 0, 0, width, count);
      copyIndices(context.getImageData(0, 0, width, count).data, indices, y * width);
      if (y + count < height) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return indices;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
