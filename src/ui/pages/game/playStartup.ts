export interface PlayViewport {
  width: number;
  height: number;
  dpr: number;
}

export function measurePlayViewport(canvas: HTMLCanvasElement): PlayViewport {
  const rect = canvas.closest('#stage')?.getBoundingClientRect();
  const fullscreen = document.fullscreenElement?.contains(canvas);
  return {
    width: fullscreen ? window.innerWidth : (rect?.width ?? window.innerWidth),
    height: fullscreen ? window.innerHeight : (rect?.height ?? window.innerHeight),
    dpr: window.devicePixelRatio || 1,
  };
}

/** Keep the layout measurement in the trusted Start handler, after any requested fullscreen transition. */
export function waitForStartViewport(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
  onStartWait: (start: ((fullscreen?: boolean) => void) | null) => void,
  options: {
    fullscreen?: boolean;
    onFullscreenWait?: (waiting: boolean) => void;
    beforeMeasure?: () => void;
  } = {},
): Promise<PlayViewport> {
  return new Promise((resolve, reject) => {
    let started = false;
    const abort = () => {
      started = true;
      onStartWait(null);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    onStartWait((fullscreen = options.fullscreen ?? false) => {
      if (started) return;
      started = true;
      onStartWait(null);
      canvas.focus();
      const finish = () => {
        signal?.throwIfAborted();
        options.beforeMeasure?.();
        resolve(measurePlayViewport(canvas));
      };
      const begin = async () => {
        if (fullscreen) {
          options.onFullscreenWait?.(true);
          const target = canvas.parentElement ?? canvas;
          if (!document.fullscreenElement?.contains(canvas)) await target.requestFullscreen();
          // macOS resolves requestFullscreen before its animated window size has settled.
          // Keep the launch handshake behind actual stable dimensions, including browser zoom.
          const deadline = performance.now() + 5000;
          let last = '',
            stableSince = performance.now();
          while (true) {
            signal?.throwIfAborted();
            await new Promise<void>((next) => requestAnimationFrame(() => next()));
            const now = performance.now();
            const size = JSON.stringify(measurePlayViewport(canvas));
            if (size !== last) {
              last = size;
              stableSince = now;
            }
            if (now - stableSince >= 300) break;
            if (now >= deadline) throw new Error('全屏尺寸尚未稳定，请重新打开页面后再试。');
          }
          if (!document.fullscreenElement?.contains(canvas))
            throw new Error('全屏已退出，请重新打开页面后选择启动方式。');
        }
        finish();
      };
      void begin()
        .catch(reject)
        .finally(() => {
          signal?.removeEventListener('abort', abort);
          options.onFullscreenWait?.(false);
        });
    });
  });
}

/** Only the owner's explicit HD web launcher adds this gate; ordinary imports and training keep their flow. */
export async function prepareWebPlayViewport(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
  onStartWait: (start: ((fullscreen?: boolean) => void) | null) => void,
  dev = import.meta.env.DEV,
): Promise<PlayViewport | null> {
  const query = new URLSearchParams(window.location.search);
  if (
    !dev ||
    query.get('play-start') !== '1' ||
    query.get('hd') !== '1' ||
    query.get('backend') === 'native' ||
    query.has('train')
  )
    return null;
  return waitForStartViewport(canvas, signal, onStartWait, {
    beforeMeasure: () => {
      // Explicit menu restarts reuse this page without another gate. A new launcher URL supplies a fresh gate.
      const url = new URL(window.location.href);
      url.searchParams.delete('play-start');
      window.history.replaceState(window.history.state, '', url);
    },
  });
}
