import type { VmDiagnostics, VmUsage } from '../../../adapter/vmDiagnostics';

/**
 * Game-speed telemetry of the play page (development only: the page imports this module behind
 * `import.meta.env.DEV`).
 *
 * "It feels slow" cannot be judged from the picture: the HD view keeps presenting 60 frames a second while the game
 * in the emulator falls behind the rate its speed setting asks for. Every five seconds this asks the VM for its
 * cumulative counters (one request on the guest's thread: `getDiagnostics('usage')`), turns the difference from the
 * previous answer into one record (the logic rate reached and the rate the setting allows, the frames presented, the
 * HD view's quality tier, how many objects the match has, the game resolution and map, and where the emulator's
 * thread spent the window) and hands it to two sinks: the development server appends it to the file its operator
 * named (`POST /__perf/speed`, the stall recorder's route handler and file, see src/server/perfStallLog.ts), and the
 * host gets the two rates for one toolbar line. Outside a running battle nothing is recorded.
 */

/** What the HD bridge knows about the match right now; null without a bridge or outside a battle. */
export interface SpeedScene {
  /** Map key (lower-cased file name without its extension). */
  map: string | null;
  objects: number;
  /** Objects of the local player. */
  localObjects: number;
  /** The HD view is what the player sees. */
  hdShown: boolean;
  /** Quality tier of the shown view (0 = everything); null while the original picture is on screen. */
  tier: number | null;
  /** HD frames drawn while shown, cumulative. */
  hdFrames: number;
  /**
   * Frame rate the shown HD view is held to (the bridge's frame pacer lowers it while the game is behind its speed
   * setting); null or absent when nothing holds it.
   */
  pace?: number | null;
}

export interface SpeedTelemetryHost {
  /** The VM's counters with the usage accounting switched on (`VmShell.getDiagnostics('usage')`). */
  diagnostics(): Promise<VmDiagnostics>;
  /** Game frames the page has presented, cumulative. */
  presentedFrames(): number;
  /** Game resolution, or null before the first frame. */
  frameSize(): { width: number; height: number } | null;
  scene(): SpeedScene | null;
  /**
   * The logic rate of the last window and the rate the speed setting allows (null: no limit; undefined: unknown);
   * `actual` null clears the line (no battle running).
   */
  publish?(actual: number | null, target: number | null | undefined): void;
  /** Share the already sampled counters with session diagnostics; never add a second VM request. */
  observe?(record: SpeedRecord | null, diagnostics: VmDiagnostics): void;
  /** Where records go; default '/__perf/speed'. Null keeps records and toolbar updates local. */
  endpoint?: string | null;
  /** Window length; default SPEED_INTERVAL_MS. */
  intervalMs?: number;
  environment?: Partial<SpeedEnvironment>;
}

export interface SpeedEnvironment {
  now(): number;
  wallClock(): number;
  visible(): boolean;
  every(ms: number, run: () => void): () => void;
  /** True: stored. 'gone': no such route or no log configured, do not ask again. False: try the next record. */
  post(url: string, body: string): Promise<boolean | 'gone'>;
}

export const SPEED_INTERVAL_MS = 5000;

const browserEnvironment: SpeedEnvironment = {
  now: () => performance.now(),
  wallClock: () => Date.now(),
  visible: () => document.visibilityState === 'visible',
  every(ms, run) {
    const timer = window.setInterval(run, ms);
    return () => window.clearInterval(timer);
  },
  async post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (response.status === 404 || response.status === 405) return 'gone';
    return response.ok;
  },
};

/** One answer of the VM with the page's own counters at the moment it arrived. */
export interface SpeedSample {
  /** VM thread clock (VmDiagnostics.sampledAtMs) and the page's clock. */
  vmAtMs: number;
  pageAtMs: number;
  /** Logic frame counter; null while no battle runs (menus, loading, a stopped VM). */
  frame: number | null;
  gameSpeed: number | null;
  targetFps: number | null | undefined;
  hypercalls: number;
  usage: VmUsage | null;
  presented: number;
  hdFrames: number | null;
}

export function speedSample(
  diagnostics: VmDiagnostics,
  pageAtMs: number,
  presented: number,
  scene: SpeedScene | null,
): SpeedSample {
  const game = diagnostics.game;
  // Frame 0 is the scenario still loading: a battle runs once the counter has moved.
  const running = diagnostics.phase === 'running' && !!game && game.status !== 'inactive' && game.frame > 0;
  return {
    vmAtMs: diagnostics.sampledAtMs,
    pageAtMs,
    frame: running ? game.frame : null,
    gameSpeed: running ? game.gameSpeed : null,
    targetFps: running ? game.targetFps : undefined,
    hypercalls: diagnostics.hypercalls,
    usage: diagnostics.usage ?? null,
    presented,
    hdFrames: scene ? scene.hdFrames : null,
  };
}

/** Share of the VM thread's window, in percent with one decimal. */
export interface SpeedVmShares {
  guestPct: number | null;
  hostCallPct: number;
  guestWaitPct: number;
  stateReadPct: number;
  /** What the parts above leave: scheduler turnaround, frame snapshots, messages, garbage collection. */
  otherPct: number | null;
  slicesPerS: number | null;
  stateReadsPerS: number;
  framesPerS: number;
  /**
   * Modules of guest code the emulator compiled and gave up in the window (null when unknown). Hundreds given up
   * at once: its compiled cache was thrown away and the game runs interpreted until the code is hot again.
   */
  jitCompiled: number | null;
  jitFreed: number | null;
}

export interface SpeedRecord {
  kind: 'speed';
  time: string;
  windowMs: number;
  /** Logic frames a second the game reached in the window. */
  logicFps: number;
  /** What the speed setting allows; null with `uncapped` true when the limiter is off, null alone when unknown. */
  targetFps: number | null;
  uncapped: boolean;
  gameSpeed: number | null;
  logicFrame: number;
  /** Game frames the page presented a second, and HD frames a second (null without an HD view). */
  presentedFps: number;
  hdFps: number | null;
  hdShown: boolean;
  tier: number | null;
  /** Frame rate the HD view was held to at the end of the window; null when nothing held it. */
  hdPace: number | null;
  objects: number | null;
  localObjects: number | null;
  resolution: string | null;
  map: string | null;
  visible: boolean;
  hypercallsPerS: number;
  vm: SpeedVmShares | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The record of the window between two samples, or null when they do not span a stretch of one running battle: a
 * sample outside a battle, the logic frame starting over (another match), or clocks that did not advance.
 */
export function speedRecord(
  previous: SpeedSample,
  current: SpeedSample,
  context: {
    wallClock: number;
    visible: boolean;
    frameSize: { width: number; height: number } | null;
    scene: SpeedScene | null;
  },
): SpeedRecord | null {
  const vmMs = current.vmAtMs - previous.vmAtMs;
  const pageMs = current.pageAtMs - previous.pageAtMs;
  if (previous.frame === null || current.frame === null || current.frame < previous.frame) return null;
  if (!(vmMs > 0) || !(pageMs > 0)) return null;
  const perSecond = (delta: number, ms: number) => round1((delta * 1000) / ms);
  const { scene, frameSize } = context;
  let vm: SpeedVmShares | null = null;
  const a = previous.usage,
    b = current.usage;
  if (a && b) {
    const share = (delta: number) => round1(Math.min(100, Math.max(0, (delta * 100) / vmMs)));
    const guest = a.guestMs !== null && b.guestMs !== null ? b.guestMs - a.guestMs : null;
    const host = b.hostCallMs - a.hostCallMs;
    const wait = b.guestWaitMs - a.guestWaitMs;
    const read = b.stateReadMs - a.stateReadMs;
    vm = {
      guestPct: guest === null ? null : share(guest),
      hostCallPct: share(host),
      guestWaitPct: share(wait),
      stateReadPct: share(read),
      otherPct: guest === null ? null : share(vmMs - guest - host - wait - read),
      slicesPerS: a.slices !== null && b.slices !== null ? perSecond(b.slices - a.slices, vmMs) : null,
      stateReadsPerS: perSecond(b.stateReads - a.stateReads, vmMs),
      framesPerS: perSecond(b.frames - a.frames, vmMs),
      jitCompiled: a.jitCompiled !== null && b.jitCompiled !== null ? b.jitCompiled - a.jitCompiled : null,
      jitFreed: a.jitFreed !== null && b.jitFreed !== null ? b.jitFreed - a.jitFreed : null,
    };
  }
  return {
    kind: 'speed',
    time: new Date(context.wallClock).toISOString(),
    windowMs: Math.round(vmMs),
    logicFps: perSecond(current.frame - previous.frame, vmMs),
    targetFps: typeof current.targetFps === 'number' ? round1(current.targetFps) : null,
    uncapped: current.targetFps === null,
    gameSpeed: current.gameSpeed,
    logicFrame: current.frame,
    presentedFps: perSecond(current.presented - previous.presented, pageMs),
    hdFps:
      current.hdFrames !== null && previous.hdFrames !== null && current.hdFrames >= previous.hdFrames
        ? perSecond(current.hdFrames - previous.hdFrames, pageMs)
        : null,
    hdShown: scene?.hdShown ?? false,
    tier: scene?.tier ?? null,
    hdPace: scene?.pace ?? null,
    objects: scene?.map ? scene.objects : null,
    localObjects: scene?.map ? scene.localObjects : null,
    resolution: frameSize ? `${frameSize.width}x${frameSize.height}` : null,
    map: scene?.map ?? null,
    visible: context.visible,
    hypercallsPerS: perSecond(current.hypercalls - previous.hypercalls, vmMs),
    vm,
  };
}

export interface SpeedTelemetry {
  /** The last records, oldest first (console: `__speedTelemetry.records`). */
  records(): SpeedRecord[];
  dispose(): void;
}

/** Records kept for the console. */
const SPEED_HISTORY = 240;

export function startSpeedTelemetry(host: SpeedTelemetryHost): SpeedTelemetry {
  const environment: SpeedEnvironment = { ...browserEnvironment, ...host.environment };
  const endpoint = host.endpoint === undefined ? '/__perf/speed' : host.endpoint;
  const history: SpeedRecord[] = [];
  let previous: SpeedSample | null = null;
  let asking = false;
  let disposed = false;
  let sinkGone = false;
  let shown = false;
  const clear = () => {
    if (!shown) return;
    shown = false;
    host.publish?.(null, undefined);
  };
  const tick = () => {
    // One request at a time: a VM that answers late (a frozen tab, a stopped guest) is not asked again meanwhile.
    if (asking || disposed) return;
    asking = true;
    host
      .diagnostics()
      .then((diagnostics) => {
        if (disposed) return;
        const scene = host.scene();
        const current = speedSample(diagnostics, environment.now(), host.presentedFrames(), scene);
        const record = previous
          ? speedRecord(previous, current, {
              wallClock: environment.wallClock(),
              visible: environment.visible(),
              frameSize: host.frameSize(),
              scene,
            })
          : null;
        previous = current;
        // Incomplete native mirrors have no logic-rate record, but their failure counters still need a log.
        host.observe?.(record, diagnostics);
        if (!record) {
          if (current.frame === null) clear();
          return;
        }
        history.push(record);
        if (history.length > SPEED_HISTORY) history.shift();
        shown = true;
        host.publish?.(record.logicFps, current.targetFps);
        if (sinkGone || endpoint === null) return;
        void environment.post(endpoint, JSON.stringify([record])).then(
          (result) => {
            if (result === 'gone') sinkGone = true;
          },
          () => undefined,
        );
      })
      .catch(() => {
        // The VM is gone or does not answer: the next window starts from a fresh sample.
        previous = null;
        if (!disposed) clear();
      })
      .finally(() => {
        asking = false;
      });
  };
  const stopTimer = environment.every(host.intervalMs ?? SPEED_INTERVAL_MS, tick);
  tick();
  return {
    records: () => [...history],
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      clear();
    },
  };
}
