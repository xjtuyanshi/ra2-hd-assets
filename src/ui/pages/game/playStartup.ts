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
  onStartWait: (start: (() => void) | null) => void,
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
    onStartWait(() => {
      if (started) return;
      started = true;
      signal?.removeEventListener('abort', abort);
      onStartWait(null);
      canvas.focus();
      const finish = () => {
        try {
          options.beforeMeasure?.();
          resolve(measurePlayViewport(canvas));
        } catch (error) {
          reject(error);
        }
      };
      if (options.fullscreen && !document.fullscreenElement?.contains(canvas)) {
        options.onFullscreenWait?.(true);
        const target = canvas.parentElement ?? canvas;
        void target
          .requestFullscreen()
          .then(finish, finish)
          .finally(() => options.onFullscreenWait?.(false));
      } else finish();
    });
  });
}

/** Only the owner's explicit HD web launcher adds this gate; ordinary imports and training keep their flow. */
export async function prepareWebPlayViewport(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
  onStartWait: (start: (() => void) | null) => void,
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
      // Internal menu resize reloads can continue automatically. A new launcher URL always supplies a fresh gate.
      const url = new URL(window.location.href);
      url.searchParams.delete('play-start');
      window.history.replaceState(window.history.state, '', url);
    },
  });
}
