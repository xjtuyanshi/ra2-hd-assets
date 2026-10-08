/** A detached byte copy of an actual submitted canvas texture, without another render. */
export interface WebGpuCapturedFrame<T> {
  metadata: T;
  width: number;
  height: number;
  format: string;
  /** Top-to-bottom RGBA bytes, without alpha or colour adjustments. */
  pixels: Uint8Array;
}

export interface WebGpuFrameSource<T> {
  backend: unknown;
  /** The caller fixes its metadata in the same task as the completed draw. */
  metadata: T;
}

interface ReadbackBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface CaptureTexture {
  width: number;
  height: number;
  depthOrArrayLayers: number;
  sampleCount: number;
  format: string;
  usage: number;
}

interface CaptureDevice {
  createBuffer(descriptor: { label: string; size: number; usage: number }): ReadbackBuffer;
  createCommandEncoder(descriptor: { label: string }): {
    copyTextureToBuffer(
      source: { texture: CaptureTexture },
      destination: { buffer: ReadbackBuffer; bytesPerRow: number; rowsPerImage: number },
      size: { width: number; height: number; depthOrArrayLayers: number },
    ): void;
    finish(): unknown;
  };
  queue: { submit(commands: unknown[]): void };
  pushErrorScope(filter: 'validation'): void;
  popErrorScope(): Promise<{ message: string } | null>;
}

interface CaptureBackend {
  isWebGPUBackend?: boolean;
  context?: { getCurrentTexture(): CaptureTexture };
  device?: CaptureDevice;
}

interface Pending<T> {
  resolve(frame: WebGpuCapturedFrame<T>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  buffer: ReadbackBuffer | null;
  reading: boolean;
  released: boolean;
}

// WebGPU's immutable flag values; the narrow interfaces avoid importing renderer/browser globals.
const TEXTURE_COPY_SRC = 1;
const BUFFER_MAP_READ = 1;
const BUFFER_COPY_DST = 8;
const MAP_READ = 1;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 10_000_000;
const MAX_BUFFER_BYTES = 48 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb']);

/**
 * One requested completed draw and one owned readback buffer at a time. The caller invokes draw synchronously
 * after its normal render submitted its work. The source callback is never run without a pending request, and
 * must expose that draw's actual canvas backend; null means no presented draw yet. Copy submission happens before
 * draw returns, while the canvas current texture is still valid. Mapping is asynchronous and never redraws it.
 */
export function createWebGpuFrameCapture<T, Draw>(source: (draw: Draw) => WebGpuFrameSource<T> | null) {
  let pending: Pending<T> | null = null;
  let disposed = false;
  const release = (job: Pending<T>) => {
    if (job.released) return;
    job.released = true;
    clearTimeout(job.timer);
    if (job.buffer) {
      try {
        job.buffer.unmap();
      } catch {
        // A cancelled mapping may already have been invalidated by device loss.
      }
      job.buffer.destroy();
      job.buffer = null;
    }
  };
  const fail = (job: Pending<T>, error: unknown) => {
    if (pending !== job) return;
    pending = null;
    release(job);
    job.reject(error instanceof Error ? error : new Error(String(error)));
  };
  const mapped = async (
    job: Pending<T>,
    metadata: T,
    texture: CaptureTexture,
    bytesPerRow: number,
    validation: Promise<{ message: string } | null>,
  ) => {
    try {
      const buffer = job.buffer!;
      const [, error] = await Promise.all([buffer.mapAsync(MAP_READ), validation]);
      if (error) throw new Error(`WebGPU frame capture validation failed: ${error.message}`);
      if (pending !== job || disposed) return;
      const input = new Uint8Array(buffer.getMappedRange());
      const rowBytes = texture.width * 4;
      if (input.byteLength < bytesPerRow * (texture.height - 1) + rowBytes)
        throw new Error('WebGPU frame capture mapped an incomplete buffer');
      const pixels = new Uint8Array(rowBytes * texture.height);
      const bgra = texture.format.startsWith('bgra');
      for (let y = 0; y < texture.height; y++) {
        const row = input.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes);
        const offset = y * rowBytes;
        pixels.set(row, offset);
        if (bgra) {
          for (let x = 0; x < rowBytes; x += 4) {
            pixels[offset + x] = row[x + 2]!;
            pixels[offset + x + 2] = row[x]!;
          }
        }
      }
      pending = null;
      release(job);
      job.resolve({ metadata, width: texture.width, height: texture.height, format: texture.format, pixels });
    } catch (error) {
      fail(job, error);
    }
  };
  return {
    request(timeoutMs = TIMEOUT_MS): Promise<WebGpuCapturedFrame<T>> {
      if (disposed) return Promise.reject(new Error('WebGPU frame capture is disposed'));
      if (pending) return Promise.reject(new Error('A WebGPU frame capture is already pending'));
      if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > TIMEOUT_MS)
        return Promise.reject(new RangeError('WebGPU frame capture timeout must be between 50 and 10000 ms'));
      return new Promise((resolve, reject) => {
        const job: Pending<T> = {
          resolve,
          reject,
          timer: setTimeout(() => fail(job, new Error('WebGPU frame capture timed out')), timeoutMs),
          buffer: null,
          reading: false,
          released: false,
        };
        pending = job;
      });
    },
    draw(draw: Draw): void {
      const job = pending;
      if (!job || job.reading || disposed) return;
      let scopedDevice: CaptureDevice | null = null;
      try {
        const frame = source(draw);
        if (!frame) return;
        const backend = frame.backend as CaptureBackend | null;
        const device = backend?.device;
        if (
          !backend?.isWebGPUBackend ||
          typeof backend.context?.getCurrentTexture !== 'function' ||
          !device ||
          typeof device.createBuffer !== 'function' ||
          typeof device.createCommandEncoder !== 'function' ||
          typeof device.queue?.submit !== 'function' ||
          typeof device.pushErrorScope !== 'function' ||
          typeof device.popErrorScope !== 'function'
        )
          throw new Error('Actual canvas WebGPU readback is unavailable');
        const texture = backend.context.getCurrentTexture();
        if (
          !Number.isInteger(texture.width) ||
          !Number.isInteger(texture.height) ||
          texture.width < 1 ||
          texture.height < 1 ||
          texture.width > MAX_DIMENSION ||
          texture.height > MAX_DIMENSION ||
          texture.width * texture.height > MAX_PIXELS ||
          texture.depthOrArrayLayers !== 1 ||
          texture.sampleCount !== 1
        )
          throw new Error('Canvas texture exceeds the bounded WebGPU capture dimensions');
        if (!FORMATS.has(texture.format)) throw new Error(`Unsupported canvas capture format: ${texture.format}`);
        if (!(texture.usage & TEXTURE_COPY_SRC)) throw new Error('Actual canvas texture has no COPY_SRC usage');
        const bytesPerRow = Math.ceil((texture.width * 4) / 256) * 256;
        const size = bytesPerRow * texture.height;
        if (size > MAX_BUFFER_BYTES) throw new Error('Canvas texture exceeds the WebGPU capture byte budget');
        job.reading = true;
        device.pushErrorScope('validation');
        scopedDevice = device;
        job.buffer = device.createBuffer({
          label: 'HD next-draw readback',
          size,
          usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
        });
        const encoder = device.createCommandEncoder({ label: 'HD next-draw copy' });
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: job.buffer, bytesPerRow, rowsPerImage: texture.height },
          { width: texture.width, height: texture.height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish()]);
        const validation = device.popErrorScope();
        scopedDevice = null;
        void mapped(job, frame.metadata, texture, bytesPerRow, validation);
      } catch (error) {
        if (scopedDevice) void scopedDevice.popErrorScope().catch(() => undefined);
        fail(job, error);
      }
    },
    cancel(reason = 'WebGPU frame capture cancelled'): void {
      if (pending) fail(pending, new Error(reason));
    },
    dispose(): void {
      disposed = true;
      if (pending) fail(pending, new Error('WebGPU frame capture disposed'));
    },
  };
}
