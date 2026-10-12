/** The explicit development launcher attaches only to its supplied Yuri's Revenge copy. */
export function nativeAutoStart(search: string, dev: boolean = import.meta.env.DEV): 'yr' | null {
  if (!dev) return null;
  const query = new URLSearchParams(search);
  return query.get('backend') === 'native' && query.get('native-autostart') === 'yr' ? 'yr' : null;
}

/** Native canvas presses carry absolute positions; explicit relative input remains available. */
export function desktopPointerLock(search: string, backend: string | undefined): boolean {
  const preference = new URLSearchParams(search).get('mouse-lock');
  return preference === null ? backend !== 'native' : preference !== '0';
}

/** Measure the real play area before the launcher chooses the original game's video mode. */
export async function prepareNativeViewport(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
  onFullscreenWait?: (waiting: boolean) => void,
  devicePixelsPerGamePixel = 3,
  requestedFrame: { width: number; height: number } | null = null,
  followIni = false,
): Promise<{ width: number; height: number } | null> {
  const query = new URLSearchParams(window.location.search);
  if (!nativeAutoStart(window.location.search) || query.get('native-viewport') !== '1') return null;
  const token = query.get('agent-token');
  if (!token) throw new Error('启动网址不完整。请重新打开启动器给出的完整网址。');
  const headers = { Authorization: `Bearer ${token}` };
  const endpoint = new URL('/__native/viewport', window.location.href);
  const requestSignal = () =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const pause = (milliseconds: number) =>
    new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const finish = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = window.setTimeout(finish, milliseconds);
      const abort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  if (query.get('native-fullscreen') === '1' && !document.fullscreenElement?.contains(canvas)) {
    signal?.throwIfAborted();
    onFullscreenWait?.(true);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          document.removeEventListener('fullscreenchange', changed);
          signal?.removeEventListener('abort', abort);
          window.clearTimeout(timer);
        };
        const changed = () => {
          if (!document.fullscreenElement?.contains(canvas)) return;
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('尚未进入全屏。请重新启动后点击页面控制栏中的“全屏”按钮。'));
        }, 110000);
        document.addEventListener('fullscreenchange', changed);
        signal?.addEventListener('abort', abort, { once: true });
        changed();
      });
    } finally {
      onFullscreenWait?.(false);
    }
  }
  type Status = { ready?: boolean; resolution?: { width?: number; height?: number } | null };
  const readStatus = async (): Promise<Status> => {
    const response = await fetch(endpoint, { headers, cache: 'no-store', signal: requestSignal() });
    if (!response.ok) throw new Error('无法连接本次启动器。请关闭页面并重新启动。');
    return response.json();
  };
  let status = await readStatus();
  if (!status.ready) {
    // Wait for initial layout, including the native launch's collapsed toolbar,
    // before reporting the stage. Do not substitute screen dimensions or round
    // odd heights to even numbers: either would leave a border or shrink the art.
    const measure = () => {
      const rect = canvas.closest('#stage')?.getBoundingClientRect();
      const fullscreen = document.fullscreenElement?.contains(canvas);
      return {
        width: fullscreen ? window.innerWidth : (rect?.width ?? window.innerWidth),
        height: fullscreen ? window.innerHeight : (rect?.height ?? window.innerHeight),
        dpr: window.devicePixelRatio || 1,
      };
    };
    let viewport = measure();
    let stableAt = performance.now();
    const layoutDeadline = stableAt + 3000;
    while (performance.now() - stableAt < 300 && performance.now() < layoutDeadline) {
      await pause(50);
      const next = measure();
      if (next.width !== viewport.width || next.height !== viewport.height || next.dpr !== viewport.dpr) {
        stableAt = performance.now();
        viewport = next;
      }
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...viewport,
        devicePixelsPerGamePixel,
        ...(requestedFrame ? { frameWidth: requestedFrame.width, frameHeight: requestedFrame.height } : {}),
        ...(followIni ? { followIni: true } : {}),
      }),
      signal: requestSignal(),
    });
    if (!response.ok) throw new Error('启动器无法读取页面大小。请关闭页面并重新启动。');
    status = await response.json();
  }
  const deadline = performance.now() + 90000;
  while (!status.ready) {
    if (performance.now() >= deadline) throw new Error('游戏没有完成启动。请查看启动器窗口中的提示后重新启动。');
    await pause(100);
    try {
      status = await readStatus();
    } catch {
      // A busy launcher may miss one poll while Wine starts. Cancellation and
      // the overall deadline still terminate this wait; a transient fetch does not.
      signal?.throwIfAborted();
      continue;
    }
    if (!status.ready) {
      let sessionState: string | undefined;
      try {
        const session = await fetch(new URL('/__native/session', window.location.href), {
          headers,
          cache: 'no-store',
          signal: requestSignal(),
        });
        if (session.ok) sessionState = (await session.json()).state;
      } catch {
        signal?.throwIfAborted();
      }
      if (sessionState === 'closed' || sessionState === 'failed')
        throw new Error('游戏启动已停止。请查看启动器窗口中的提示后重新启动。');
    }
  }
  const { width, height } = status.resolution ?? {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height)
    throw new Error('启动器没有返回有效的游戏画面尺寸。请重新启动。');
  return { width, height };
}
