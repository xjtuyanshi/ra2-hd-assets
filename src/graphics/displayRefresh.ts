export interface DisplayRefreshSnapshot {
  /** Startup rAF cadence, not a physical display-mode or scan-out measurement. */
  refreshHz: number | null;
  refreshMs: number | null;
  measuredAtMs: number | null;
  samples: number;
  callbacks: number;
  visibleMs: number;
  focusedMs: number;
}

/**
 * Measure before gameplay can slow the page, then retain that reference: a later missed refresh must not be
 * mistaken for a slower display. The page owns this observer and disposes it with its animation-frame lifecycle.
 */
export function startDisplayRefresh(measured?: (sample: DisplayRefreshSnapshot) => void) {
  const intervals: number[] = [];
  let refreshMs: number | null = null;
  let measuredAtMs: number | null = null;
  let callbacks = 0;
  let visibleMs = 0;
  let focusedMs = 0;
  let visible = !document.hidden;
  let focused = document.hasFocus();
  let accountedAt = performance.now();
  let lastFrame: number | null = null;
  let raf = 0;
  let disposed = false;
  const account = () => {
    const now = performance.now();
    const elapsed = Math.max(0, now - accountedAt);
    if (visible) visibleMs += elapsed;
    if (visible && focused) focusedMs += elapsed;
    accountedAt = now;
  };
  const snapshot = (): DisplayRefreshSnapshot => {
    if (!disposed) account();
    return {
      refreshHz: refreshMs === null ? null : 1000 / refreshMs,
      refreshMs,
      measuredAtMs,
      samples: intervals.length,
      callbacks,
      visibleMs,
      focusedMs,
    };
  };
  const stateChanged = () => {
    account();
    visible = !document.hidden;
    focused = document.hasFocus();
    lastFrame = null;
    if (refreshMs === null) intervals.length = 0;
  };
  const frame = (at: number) => {
    if (disposed) return;
    account();
    if (visible) callbacks++;
    if (refreshMs === null && visible && focused) {
      const interval = lastFrame === null ? 0 : at - lastFrame;
      if (interval > 1 && interval < 100) {
        intervals.push(interval);
        if (intervals.length > 64) intervals.shift();
        if (intervals.length === 64) {
          const sorted = intervals.slice().sort((a, b) => a - b);
          // Loading and lost callbacks must not establish the startup reference.
          if (sorted[57]! / sorted[6]! < 1.15) {
            refreshMs = (sorted[31]! + sorted[32]!) / 2;
            measuredAtMs = performance.now();
            measured?.(snapshot());
          }
        }
      }
    }
    lastFrame = visible && focused ? at : null;
    if (!disposed) raf = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', stateChanged);
  window.addEventListener('focus', stateChanged);
  window.addEventListener('blur', stateChanged);
  raf = requestAnimationFrame(frame);
  return {
    snapshot,
    dispose() {
      if (disposed) return;
      account();
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', stateChanged);
      window.removeEventListener('focus', stateChanged);
      window.removeEventListener('blur', stateChanged);
    },
  };
}
