import type { Texture } from 'three/webgpu';

/**
 * What an atlas-page loader calls to put a decoded page on the GPU; a promise when the upload takes several frames.
 * With a `gate`, the loader decodes inside it (see PageGate), so pages that wait for their upload are bounded.
 * `background` answers, when the gate or the uploader chooses its next page, whether nothing on screen waits for this
 * one (a page loaded ahead of its first use): such a page lets every page that is waited for go first. The uploader
 * gets it as the second argument; the gate is asked before a texture exists, so an upload made for one page carries
 * the same answer as its `background` property.
 */
export type PageUpload = ((texture: Texture, background?: () => boolean) => void | Promise<void>) & {
  gate?: PageGate;
  background?: () => boolean;
};

/** Decoded pixels allowed to exist at once: two of the largest atlas pages (8192 x 8192), 512 MiB of RGBA. */
export const PAGE_GATE_PIXELS = 2 * 8192 * 8192;

/**
 * Bounds the decoded pages that exist at one time.
 *
 * A page is decoded when its file has arrived and released when its upload is through, and uploads are paced by
 * the frames of the view (PageUploader.step). Files arrive much faster than that: a match start asks for two dozen
 * 66-megapixel pages within a second, each 253 MiB once decoded, and while the frames are held up (shader builds,
 * the loading screen's own work) nothing drains. Measured on a six-player start: the tab reached 8 GiB. Through the
 * gate a loader holds its turn from before the decode until the page is on the GPU and its bitmap is closed, so
 * the decoded pages in existence never exceed `capacity` pixels (one page larger than that still runs, alone).
 * First come, first served among the pages that are waited for: a large page is never overtaken for ever by small
 * ones. A page loaded ahead of its use (`background`, asked each time a turn is given, so a page something starts to
 * wait for counts as waited for from then on, at the place it arrived) takes its turn only when no waited-for page
 * waits: an indexed page an object on screen is drawn from must not sit behind HD pages nothing shows yet.
 */
export class PageGate {
  private used = 0;
  private readonly waiting: { pixels: number; background?: () => boolean; start(): void }[] = [];

  constructor(readonly capacity = PAGE_GATE_PIXELS) {}

  /** Decoded pixels the running tasks account for, and the tasks still waiting. */
  get inFlight(): number {
    return this.used;
  }
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `task` (decode, upload, release) when `pixels` more decoded pixels fit and no task that goes before it
   * waits; resolves or rejects with it.
   */
  async run<T>(pixels: number, task: () => Promise<T>, background?: () => boolean): Promise<T> {
    const size = Number.isFinite(pixels) && pixels > 0 ? pixels : 0;
    // A waited-for page passes the pages loaded ahead that wait; nothing passes a waited-for page.
    const behind = background?.() ? this.waiting.length > 0 : this.waiting.some((entry) => !entry.background?.());
    if (behind || (this.used > 0 && this.used + size > this.capacity))
      // admit() accounts for the task before it wakes it.
      await new Promise<void>((start) => this.waiting.push({ pixels: size, background, start }));
    else this.used += size;
    try {
      return await task();
    } finally {
      this.used -= size;
      this.admit();
    }
  }

  private admit(): void {
    while (this.waiting.length) {
      // The oldest page that is waited for, else the oldest.
      let index = this.waiting.findIndex((entry) => !entry.background?.());
      if (index < 0) index = 0;
      const next = this.waiting[index]!;
      if (this.used > 0 && this.used + next.pixels > this.capacity) break;
      this.waiting.splice(index, 1);
      this.used += next.pixels;
      next.start();
    }
  }
}

/**
 * Pixel count of a PNG from its header (the IHDR chunk is always first), 0 when the bytes are not a PNG: what a
 * loader tells the gate before it decodes.
 */
export async function pngPixels(blob: Blob): Promise<number> {
  if (blob.size < 24) return 0;
  const head = new DataView(await blob.slice(0, 24).arrayBuffer());
  if (head.getUint32(0) !== 0x89504e47 || head.getUint32(4) !== 0x0d0a1a0a || head.getUint32(12) !== 0x49484452)
    return 0;
  return head.getUint32(16) * head.getUint32(20);
}

/** Decode `blob` and hand the bitmap to `use` inside the upload's gate (without a gate: at once, as before). */
export async function withDecodedPage<T>(
  blob: Blob,
  upload: PageUpload | undefined,
  use: (bitmap: ImageBitmap) => Promise<T>,
): Promise<T> {
  const decode = async () =>
    use(await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }));
  const gate = upload?.gate;
  return gate ? gate.run(await pngPixels(blob), decode, upload.background) : decode();
}

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
