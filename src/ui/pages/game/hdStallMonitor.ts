import {
  LongTaskLog,
  StallBatcher,
  StallRecorder,
  type StallEntry,
  type StallSendResult,
} from '../../../utils/stallRecorder';

/**
 * Built-in stall recorder of the HD page (development only: the bridge imports this module behind
 * `import.meta.env.DEV`).
 *
 * The bridge's frame loop reports every animation frame; a frame more than 150 ms after the one before it is recorded
 * with what the page knew at that moment: when, how long, whether the tab was on screen, the match and its logic
 * rate, what the HD view was loading and what its last frame had started to build, and how much of the gap the
 * page's own main thread was busy (long tasks). A stall with no long task under it was not caused by the page's
 * thread: the frame was not delivered (GPU process, compositor, another process). An ordinary frame costs one
 * subtraction here.
 *
 * Two sinks. The development server appends the records to the file its operator named (`POST /__perf/stalls`,
 * src/server/perfStallLog.ts), in batches at most every five seconds; a server without that log answers 404 and is
 * not asked again. And the host is told how many stalls the current match has had and how long the longest was, for
 * one line in the toolbar.
 */

/** What the HD view reports about its last frame (LiveView.activity of packages/hd-renderer). */
export interface HdStallActivity {
  pageUploads: number;
  voxelMeshes: number;
  loadingArt: number;
  shaders: number | null;
  pipelines: number | null;
  newKinds: string[];
  logicFps: number;
}

/** The match the bridge is in when a frame comes late. */
export interface HdStallMatch {
  /** Map key, null outside a battle. */
  map: string | null;
  /** Newest logic frame. */
  frame: number;
  /** The HD view is what the player sees (not the original picture). */
  shown: boolean;
}

/** `main-thread`: long tasks cover at least half the gap. `not-delivered`: they do not. `hidden`: the tab was. */
export type HdStallCause = 'main-thread' | 'not-delivered' | 'hidden' | 'unknown';

export interface HdStallContext extends HdStallMatch {
  /** The tab is visible now, and was hidden at some time during the gap. */
  visible: boolean;
  hiddenInGap: boolean;
  /** ms of the gap under main-thread long tasks; null where the browser does not report them. */
  mainThreadMs: number | null;
  cause: HdStallCause;
  /** Null while no HD view exists. */
  activity: HdStallActivity | null;
}

export interface HdStallMonitorHost {
  match(): HdStallMatch;
  activity(): HdStallActivity | null;
  /** Stalls of the current match (while it runs, tab visible) and the longest of them in ms; (0, 0) for a new match. */
  publish?(count: number, longestMs: number): void;
  /** Where batches go; default '/__perf/stalls'. */
  endpoint?: string;
  /** Browser pieces, replaceable in tests. */
  environment?: Partial<HdStallEnvironment>;
}

export interface HdStallEnvironment {
  now(): number;
  visible(): boolean;
  /** Calls back when the tab becomes hidden or visible, and when the page is going away; returns the unsubscriber. */
  onVisibility(listener: (visible: boolean) => void): () => void;
  /** Reports main-thread long tasks; `flush` delivers the ones observed but not yet reported. Null: unsupported. */
  longTasks(report: (start: number, duration: number) => void): { flush(): void; stop(): void } | null;
  post(url: string, body: string): Promise<StallSendResult>;
  /** Last hand-over while the page goes away (sendBeacon). */
  beacon(url: string, body: string): boolean;
}

export interface HdStallMonitor {
  /** An animation frame of the bridge's loop, with its clock (performance.now). */
  frame(now: number): void;
  /** Another match begins: its count starts at 0. */
  newMatch(): void;
  /** The recorded stalls still held, oldest first (console: `__hdBridge.stalls`). */
  entries(): StallEntry<HdStallContext>[];
  dispose(): void;
}

const browserEnvironment: HdStallEnvironment = {
  now: () => performance.now(),
  visible: () => document.visibilityState === 'visible',
  onVisibility(listener) {
    const change = () => listener(document.visibilityState === 'visible');
    const leave = () => listener(false);
    document.addEventListener('visibilitychange', change);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', change);
      window.removeEventListener('pagehide', leave);
    };
  },
  longTasks(report) {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask'))
      return null;
    const take = (entries: PerformanceEntryList) => {
      for (const entry of entries) report(entry.startTime, entry.duration);
    };
    const observer = new PerformanceObserver((list) => take(list.getEntries()));
    observer.observe({ entryTypes: ['longtask'] });
    return { flush: () => take(observer.takeRecords()), stop: () => observer.disconnect() };
  },
  async post(url, body) {
    // keepalive: the request outlives the page; nothing waits for it, and a failure is only an answer.
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    // No such route (not the development server) or no log configured there: nothing to post to.
    if (response.status === 404 || response.status === 405) return 'gone';
    return response.ok;
  },
  beacon: (url, body) =>
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })),
};

/** One record as the log gets it: flat, rounded, without the loop's internal clock. */
export function stallLogRecord(entry: StallEntry<HdStallContext>): Record<string, unknown> {
  const { context } = entry;
  return {
    seq: entry.seq,
    time: new Date(entry.at).toISOString(),
    gapMs: Math.round(entry.gapMs),
    cause: context.cause,
    mainThreadMs: context.mainThreadMs === null ? null : Math.round(context.mainThreadMs),
    visible: context.visible,
    hiddenInGap: context.hiddenInGap,
    map: context.map,
    logicFrame: context.frame,
    hdShown: context.shown,
    ...(context.activity
      ? {
          logicFps: context.activity.logicFps,
          pageUploads: context.activity.pageUploads,
          voxelMeshes: context.activity.voxelMeshes,
          loadingArt: context.activity.loadingArt,
          shaders: context.activity.shaders,
          pipelines: context.activity.pipelines,
          newKinds: context.activity.newKinds,
        }
      : { logicFps: null }),
  };
}

export function startHdStallMonitor(host: HdStallMonitorHost): HdStallMonitor {
  const environment: HdStallEnvironment = { ...browserEnvironment, ...host.environment };
  const endpoint = host.endpoint ?? '/__perf/stalls';
  const tasks = new LongTaskLog();
  const observer = environment.longTasks((start, duration) => tasks.add(start, duration));
  /** When the tab was last hidden, on the loop's clock; a gap that contains it is not a stall of the page. */
  let hiddenAt = -Infinity;
  let matchCount = 0;
  let matchLongest = 0;
  const cause = (context: Pick<HdStallContext, 'hiddenInGap' | 'mainThreadMs'>, gap: number): HdStallCause =>
    context.hiddenInGap
      ? 'hidden'
      : context.mainThreadMs === null
        ? 'unknown'
        : context.mainThreadMs >= gap / 2
          ? 'main-thread'
          : 'not-delivered';
  const recorder = new StallRecorder<HdStallContext>({
    describe(from, to) {
      // Long tasks that ended inside the gap may not have been reported yet.
      observer?.flush();
      const visible = environment.visible();
      const hiddenInGap = !visible || hiddenAt >= from;
      const mainThreadMs = observer ? tasks.overlap(from, to) : null;
      return {
        ...host.match(),
        visible,
        hiddenInGap,
        mainThreadMs,
        cause: cause({ hiddenInGap, mainThreadMs }, to - from),
        activity: host.activity(),
      };
    },
    onStall(entry) {
      const { context } = entry;
      // The toolbar counts what a player would call a stutter: the match runs and the tab was on screen.
      if (context.map !== null && context.frame >= 1 && !context.hiddenInGap) {
        matchCount++;
        matchLongest = Math.max(matchLongest, entry.gapMs);
        host.publish?.(matchCount, matchLongest);
      }
      batcher.notify();
    },
  });
  /** A long task is reported after it ends, sometimes after the frame that suffered it: look again before sending. */
  const settle = (entry: StallEntry<HdStallContext>) => {
    if (!observer) return entry;
    observer.flush();
    const { context } = entry;
    context.mainThreadMs = Math.max(context.mainThreadMs ?? 0, tasks.overlap(entry.from, entry.to));
    context.cause = cause(context, entry.gapMs);
    return entry;
  };
  const body = (entries: StallEntry<HdStallContext>[]) => JSON.stringify(entries.map((e) => stallLogRecord(settle(e))));
  const batcher = new StallBatcher(recorder, {
    send: (entries) => environment.post(endpoint, body(entries)),
    now: environment.now,
  });
  const unsubscribe = environment.onVisibility((visible) => {
    // Frames stop while the tab is hidden. The first one back is still recorded, marked as a gap the tab was
    // hidden in (cause 'hidden'), so the log shows it for what it is; the match's count leaves it out.
    if (visible) return;
    hiddenAt = environment.now();
    const rest = batcher.takeRest();
    if (rest.length) environment.beacon(endpoint, body(rest));
  });
  return {
    frame: (now) => recorder.frame(now),
    newMatch() {
      matchCount = matchLongest = 0;
      host.publish?.(0, 0);
    },
    entries: () => recorder.entries(),
    dispose() {
      unsubscribe();
      observer?.stop();
      batcher.dispose();
    },
  };
}
