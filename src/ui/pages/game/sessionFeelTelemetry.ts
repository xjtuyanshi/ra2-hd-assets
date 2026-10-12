import type { SpeedRecord } from './speedTelemetry';
import type { HdStallActivity } from './hdStallMonitor';

export interface SessionFeelHost {
  screen: HTMLCanvasElement;
  backend: 'native' | 'v86';
  scene(): { hdShown: boolean; map: string | null } | null;
  activity(): HdStallActivity | null;
}

/** Draw submissions, not display scan-out: browsers do not expose physical presentation timestamps for canvas. */
export function startSessionFeelTelemetry(host: SessionFeelHost) {
  const endpoint = '/__perf/feel';
  const records: Record<string, unknown>[] = [];
  const intervals: number[] = [];
  const pointerDraw: number[] = [];
  const pointerPaintOpportunity: number[] = [];
  const tasks: { start: number; duration: number }[] = [];
  const stalls: {
    from: number;
    to: number;
    activity: HdStallActivity | null;
  }[] = [];
  let omittedStalls = 0;
  let distinctStates = 0;
  let lastState: number | null = null;
  let lastFrame = 0;
  let lastMode = '';
  let start = performance.now();
  let latestPointer: number | null = null;
  let paintedPointer: number | null = null;
  let pointerRaf = 0;
  let gone = false;
  let disposed = false;
  let posting = false;
  let lastSpeed: SpeedRecord | null = null;
  let nativeWork: Record<string, unknown> | null = null;
  const changes: Record<string, unknown>[] = [];
  const round = (n: number) => Math.round(n * 100) / 100;
  const summary = (samples: number[]) => {
    const sorted = samples.slice().sort((a, b) => a - b);
    const percentile = (p: number) => (sorted.length ? round(sorted[Math.ceil(sorted.length * p) - 1]) : null);
    return {
      count: sorted.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.length ? round(sorted[sorted.length - 1]) : null,
      over25: sorted.filter((x) => x > 25).length,
      over50: sorted.filter((x) => x > 50).length,
      over100: sorted.filter((x) => x > 100).length,
    };
  };
  const view = () => {
    const rect = host.screen.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      picture: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      screen: { width: screen.width, height: screen.height },
      visible: !document.hidden,
    };
  };
  const changed = () => {
    if (changes.length < 32) changes.push({ atMs: round(performance.now()), ...view() });
  };
  changed();
  window.addEventListener('resize', changed);
  document.addEventListener('fullscreenchange', changed);
  document.addEventListener('visibilitychange', changed);
  const observer =
    typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ? new PerformanceObserver((list) => takeTasks(list.getEntries()))
      : null;
  function takeTasks(entries: PerformanceEntryList) {
    for (const entry of entries) {
      if (tasks.length < 256) tasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }
  observer?.observe({ entryTypes: ['longtask'] });
  const pointerMoved = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') latestPointer = event.timeStamp;
  };
  host.screen.addEventListener('pointermove', pointerMoved, true);
  const flush = () => {
    if (disposed) return;
    observer && takeTasks(observer.takeRecords());
    const now = performance.now();
    const elapsed = now - start;
    if (elapsed <= 0) return;
    const windowTasks = tasks.filter((task) => task.start + task.duration >= start);
    const detail = stalls.map(({ from, to, activity }) => {
      const busy = observer
        ? tasks.reduce(
            (total, task) => total + Math.max(0, Math.min(to, task.start + task.duration) - Math.max(from, task.start)),
            0,
          )
        : null;
      return {
        fromMs: round(from),
        gapMs: round(to - from),
        mainThreadMs: busy === null ? null : round(busy),
        cause: document.hidden
          ? 'hidden'
          : busy !== null && busy >= (to - from) / 2
            ? 'main-thread-overlap'
            : 'unknown',
        activity,
      };
    });
    const scene = host.scene();
    const record = {
      kind: 'feel',
      time: new Date().toISOString(),
      backend: host.backend,
      measurement: 'canvas-draw-submission; pointer-paint-is-next-rAF-not-scanout',
      windowMs: round(elapsed),
      pageTimeOriginMs: performance.timeOrigin,
      fromMs: round(start),
      toMs: round(now),
      mode: lastMode,
      map: scene?.map ?? null,
      ...view(),
      frameIntervalsMs: summary(intervals),
      distinctStatesPerS: round((distinctStates * 1000) / elapsed),
      distinctStateBasis: lastMode === 'hd' ? 'drawn-logic-frame' : 'received-picture-version-not-proven-logic-state',
      pointerDrawMs: summary(pointerDraw),
      pointerNextPaintOpportunityMs: summary(pointerPaintOpportunity),
      longTasks: observer
        ? {
            count: windowTasks.length,
            totalMs: round(
              windowTasks.reduce(
                (sum, task) => sum + Math.min(now, task.start + task.duration) - Math.max(start, task.start),
                0,
              ),
            ),
            maxMs: round(Math.max(0, ...windowTasks.map((task) => task.duration))),
          }
        : null,
      logicFps: scene?.map ? (lastSpeed?.logicFps ?? null) : null,
      targetFps: scene?.map ? (lastSpeed?.targetFps ?? null) : null,
      native: nativeWork,
      nativeCounterBasis: 'cumulative-session; slow-operation-clock=epoch-ms',
      stalls: detail,
      omittedStalls,
      windowChanges: changes.splice(0),
      unexplained: [
        'GPU/compositor scheduling not directly observed',
        'activity counters overlap stalls; they do not prove causality',
      ],
    };
    records.push(record);
    if (records.length > 120) records.shift();
    intervals.length = pointerDraw.length = pointerPaintOpportunity.length = stalls.length = 0;
    distinctStates = omittedStalls = 0;
    // Keep a task crossing the reporting boundary for the next draw's gap.
    while (tasks.length && tasks[0].start + tasks[0].duration < now - 1000) tasks.shift();
    start = now;
    if (!gone && !posting) {
      posting = true;
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([record]),
        keepalive: true,
      })
        .then((response) => {
          if (response.status === 404 || response.status === 405) gone = true;
        })
        .catch(() => undefined)
        .finally(() => {
          posting = false;
        });
    }
  };
  const timer = window.setInterval(flush, 5000);
  window.addEventListener('pagehide', flush);
  return {
    records: () => records.slice(),
    flush,
    speed(record: SpeedRecord, native?: Readonly<Record<string, unknown>>) {
      lastSpeed = record;
      nativeWork = native
        ? Object.fromEntries(
            ['stateReadMs', 'stateReads', 'stateReadCpuMs', 'stateReadCpuMaxMs', 'readerOperations', 'decode'].map(
              (key) => [key, native[key] ?? null],
            ),
          )
        : null;
    },
    frame(mode: 'hd' | 'original', state: number) {
      if (disposed || (mode === 'original' && host.scene()?.hdShown)) return;
      if (mode === 'original' && lastMode === mode && lastState === state) return;
      if (lastMode && lastMode !== mode) flush();
      const now = performance.now();
      if (lastFrame && lastMode === mode) {
        const gap = now - lastFrame;
        intervals.push(gap);
        if (gap > 25) {
          if (stalls.length < 64)
            stalls.push({
              from: lastFrame,
              to: now,
              activity: host.activity(),
            });
          else omittedStalls++;
        }
      }
      if (lastState !== state || lastMode !== mode) distinctStates++;
      lastFrame = now;
      lastMode = mode;
      lastState = state;
    },
    pointerDrawn() {
      if (disposed || latestPointer === null || latestPointer === paintedPointer) return;
      paintedPointer = latestPointer;
      pointerDraw.push(Math.max(0, performance.now() - latestPointer));
      if (!pointerRaf)
        pointerRaf = requestAnimationFrame(() => {
          pointerRaf = 0;
          if (paintedPointer !== null) pointerPaintOpportunity.push(Math.max(0, performance.now() - paintedPointer));
        });
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      clearInterval(timer);
      cancelAnimationFrame(pointerRaf);
      observer?.disconnect();
      host.screen.removeEventListener('pointermove', pointerMoved, true);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('resize', changed);
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('visibilitychange', changed);
    },
  };
}
