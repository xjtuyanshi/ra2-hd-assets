import type { Texture } from 'three/webgpu';

/**
 * What an atlas-page loader calls to put a decoded page on the GPU; a promise when the upload takes several frames.
 * `background` answers, when the uploader chooses its next page, whether nothing on screen waits for this one (a page
 * loaded ahead of its first use): such a page lets every page that is waited for go first.
 */
export type PageUpload = (texture: Texture, background?: () => boolean) => void | Promise<void>;

/** The part of the renderer the uploader uses (three's Renderer, or a stand-in in tests). */
export interface PageUploadHost {
  initTexture(texture: Texture): void;
  backend: unknown;
}

/** WebGPU backend internals of three r186 this module reads; every one is checked before use. */
interface GpuBackend {
  device?: {
    queue?: {
      copyExternalImageToTexture?(
        source: { source: unknown; origin: { x: number; y: number }; flipY: boolean },
        destination: {
          texture: unknown;
          mipLevel: number;
          origin: { x: number; y: number; z: number };
          premultipliedAlpha: boolean;
        },
        size: { width: number; height: number },
      ): void;
    };
  };
  get?(texture: Texture): { texture?: unknown } | undefined;
  generateMipmaps?(texture: Texture): void;
}

interface Job {
  texture: Texture;
  image: unknown;
  gpu: unknown;
  width: number;
  height: number;
  /** Rows already copied. */
  row: number;
  background?: () => boolean;
  resolve(): void;
  reject(error: Error): void;
}

/** Pages up to this many pixels are uploaded in one call (2048 x 2048: about a millisecond). */
export const WHOLE_UPLOAD_PIXELS = 4 << 20;

/**
 * Uploads decoded atlas pages in strips, a bounded number of pixels per frame.
 *
 * One `copyExternalImageToTexture` of an 8192 x 8096 page hands 253 MiB to the GPU process in a single call: 30 to 80
 * ms inside the call and as much again before the thread is free (measured on match starts: frames of 100 to 330 ms
 * for every page, a dozen or more pages per start, and again whenever a match first shows a type from a new page).
 * Nothing about a page needs it whole at once: the texture is allocated empty (three's `Source.dataReady = false`
 * path: sized, with its mip chain, no data), rows are copied with the same call and the same flags three uses for the
 * whole image, and the mipmaps are generated when the last row is in. A page is handed to its sprite layer only after
 * that (the loader's promise), so no frame ever samples a partly filled page.
 *
 * Pages do not go in the order they were decoded. The page whose rows are going in is finished; the next one is a
 * page that is waited for before one loaded ahead of its use (`background`), and the smallest of those (the oldest
 * among equals): a 17 M pixel indexed page that an object on screen can already be drawn from must not queue behind
 * the 67 M pixel HD pages that happened to be decoded before it.
 *
 * `step` is called once per rendered frame by the view that owns the uploader: no timer of its own. Where the
 * backend is not three's WebGPU backend as read here (the WebGL2 fallback, tests, a later three), a page is uploaded
 * whole by `initTexture`, as before.
 */
export class PageUploader {
  private readonly jobs: Job[] = [];
  private disposed = false;

  constructor(
    private readonly renderer: PageUploadHost,
    private readonly wholePixels = WHOLE_UPLOAD_PIXELS,
  ) {}

  /** Pages whose rows are still being copied. */
  get pending(): number {
    return this.jobs.length;
  }

  /**
   * Upload `texture`'s image. Synchronous for small pages and unsupported backends (the texture's onUpdate has run,
   * as after `initTexture`); otherwise a promise that settles when the last strip and the mipmaps are in (onUpdate
   * runs then) or the uploader is disposed (rejected).
   */
  upload(texture: Texture, background?: () => boolean): void | Promise<void> {
    if (this.disposed) throw new Error('page uploader disposed');
    const image = texture.image as { width?: number; height?: number } | null | undefined;
    const backend = this.backend();
    const width = image?.width ?? 0;
    const height = image?.height ?? 0;
    const source = texture.source as { dataReady?: boolean } | undefined;
    if (
      !backend ||
      !source ||
      texture.flipY ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width * height <= this.wholePixels
    ) {
      this.renderer.initTexture(texture);
      return;
    }
    // Allocate only: three sizes the texture and its mip chain from the image and skips the copy.
    const onUpdate = texture.onUpdate;
    texture.onUpdate = null;
    source.dataReady = false;
    try {
      this.renderer.initTexture(texture);
    } finally {
      source.dataReady = true;
      texture.onUpdate = onUpdate;
    }
    const gpu = backend.get!(texture)?.texture;
    if (!gpu) {
      // Not allocated the way this module expects: let three upload it whole.
      texture.needsUpdate = true;
      this.renderer.initTexture(texture);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ texture, image, gpu, width, height, row: 0, resolve, reject, background });
    });
  }

  /**
   * Copy up to `pixels` pixels of the waiting pages (see the class comment for their order); at least one row when
   * anything waits. Call once per frame.
   */
  step(pixels: number): void {
    const backend = this.backend();
    let budget = pixels;
    while (this.jobs.length && budget > 0) {
      const index = this.next();
      const job = this.jobs[index]!;
      const rows = Math.min(job.height - job.row, Math.max(1, Math.floor(budget / job.width)));
      try {
        if (!backend) throw new Error('GPU backend lost');
        backend.device!.queue!.copyExternalImageToTexture!(
          { source: job.image, origin: { x: 0, y: job.row }, flipY: false },
          {
            texture: job.gpu,
            mipLevel: 0,
            origin: { x: 0, y: job.row, z: 0 },
            premultipliedAlpha: job.texture.premultiplyAlpha,
          },
          { width: job.width, height: rows },
        );
        job.row += rows;
        budget -= rows * job.width;
        if (job.row < job.height) continue;
        if (job.texture.generateMipmaps) backend.generateMipmaps!(job.texture);
      } catch (error) {
        this.jobs.splice(index, 1);
        job.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.jobs.splice(index, 1);
      // What initTexture does after an upload: the loader releases the decoded page here.
      job.texture.onUpdate?.(job.texture);
      job.resolve();
    }
  }

  /** Index of the page to copy rows of now: the one already begun, else waited-for before ahead, smallest first. */
  private next(): number {
    let best = 0;
    let bestBackground = true;
    let bestPixels = Infinity;
    for (let i = 0; i < this.jobs.length; i++) {
      const job = this.jobs[i]!;
      if (job.row > 0) return i;
      const background = job.background?.() ?? false;
      const pixels = job.width * job.height;
      if (background === bestBackground ? pixels < bestPixels : !background) {
        best = i;
        bestBackground = background;
        bestPixels = pixels;
      }
    }
    return best;
  }

  /** Reject what is still waiting (its loader releases the decoded page); later uploads throw. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('page uploader disposed');
    for (const job of this.jobs.splice(0)) job.reject(error);
  }

  private backend(): GpuBackend | null {
    const backend = this.renderer.backend as GpuBackend | null | undefined;
    return backend &&
      typeof backend.device?.queue?.copyExternalImageToTexture === 'function' &&
      typeof backend.get === 'function' &&
      typeof backend.generateMipmaps === 'function'
      ? backend
      : null;
  }
}
