import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VmDiagnostics, VmUsage } from '../../src/adapter/vmDiagnostics';
import {
  SPEED_INTERVAL_MS,
  speedRecord,
  speedSample,
  startSpeedTelemetry,
  type SpeedEnvironment,
  type SpeedRecord,
  type SpeedScene,
} from '../../src/ui/pages/game/speedTelemetry';
import { installRuntimeToolbar, type RuntimeToolbarCallbacks } from '../../src/ui/pages/game/runtimeToolbar';
import { toolbarState } from '../../src/ui/pages/game/state/uiState';
import { createTranslator } from '../../src/ui/shared/i18n/translate';
import { startSessionFeelTelemetry } from '../../src/ui/pages/game/sessionFeelTelemetry';

afterEach(() => {
  vi.unstubAllGlobals();
});

const usage = (over: Partial<VmUsage> = {}): VmUsage => ({
  guestMs: 0,
  slices: 0,
  jitCompiled: 0,
  jitFreed: 0,
  hostCallMs: 0,
  guestWaitMs: 0,
  stateReadMs: 0,
  stateReads: 0,
  frames: 0,
  ...over,
});

/** A VM answer in a running skirmish at the slider's 5 (62.5 frames a second allowed). */
function diagnostics(at: number, frame: number, over: Partial<VmDiagnostics> = {}): VmDiagnostics {
  return {
    sampledAtMs: at,
    phase: 'running',
    hypercalls: 0,
    clockRate: 1,
    execution: null,
    game: {
      frame,
      gameSpeed: 1,
      sessionSpeed: 1,
      requestedFps: 60,
      targetFps: 62.5,
      sampledAtMs: at,
      intervalMs: null,
      logicFps: null,
      status: 'sample',
    },
    usage: usage(),
    ...over,
  };
}

const scene = (over: Partial<SpeedScene> = {}): SpeedScene => ({
  map: 'xmp26s6',
  objects: 412,
  localObjects: 61,
  hdShown: true,
  tier: 1,
  hdFrames: 0,
  ...over,
});

const context = (over: Partial<Parameters<typeof speedRecord>[2]> = {}) => ({
  wallClock: Date.UTC(2026, 9, 7, 7, 0, 0),
  visible: true,
  frameSize: { width: 1728, height: 1080 },
  scene: scene({ hdFrames: 300 }),
  ...over,
});

describe('one record per window of a running battle', () => {
  it('reports the rate reached against the rate allowed, what was presented and where the VM thread spent the window', () => {
    const before = speedSample(
      diagnostics(10_000, 6000, { hypercalls: 1000, usage: usage({ guestMs: 100, slices: 50, frames: 20 }) }),
      50_000,
      700,
      scene(),
    );
    const after = speedSample(
      diagnostics(15_000, 6209, {
        hypercalls: 31_000,
        usage: usage({
          guestMs: 4100,
          slices: 30_050,
          jitCompiled: 37,
          jitFreed: 899,
          hostCallMs: 400,
          guestWaitMs: 50,
          stateReadMs: 150,
          stateReads: 300,
          frames: 229,
        }),
      }),
      55_010,
      1000,
      scene({ hdFrames: 300 }),
    );
    // The bridge held its view to 40 frames a second at the end of the window.
    expect(speedRecord(before, after, context({ scene: scene({ hdFrames: 300, pace: 40 }) }))).toMatchObject({
      hdPace: 40,
    });
    expect(speedRecord(before, after, context())).toEqual({
      kind: 'speed',
      time: '2026-10-07T07:00:00.000Z',
      windowMs: 5000,
      logicFps: 41.8,
      targetFps: 62.5,
      uncapped: false,
      gameSpeed: 1,
      logicFrame: 6209,
      presentedFps: 59.9,
      hdFps: 59.9,
      hdShown: true,
      tier: 1,
      hdPace: null,
      objects: 412,
      localObjects: 61,
      resolution: '1728x1080',
      map: 'xmp26s6',
      visible: true,
      hypercallsPerS: 6000,
      vm: {
        guestPct: 80,
        hostCallPct: 8,
        guestWaitPct: 1,
        stateReadPct: 3,
        otherPct: 8,
        slicesPerS: 6000,
        stateReadsPerS: 60,
        framesPerS: 41.8,
        jitCompiled: 37,
        jitFreed: 899,
      },
    } satisfies SpeedRecord);
  });

  it('keeps unknown apart from unlimited, and a VM without usage or without a metered loop apart from zero', () => {
    const pair = (over: Partial<VmDiagnostics>, game: Partial<NonNullable<VmDiagnostics['game']>> = {}) => {
      const make = (at: number, frame: number) => {
        const base = diagnostics(at, frame, over);
        return speedSample({ ...base, game: { ...base.game!, ...game } }, at, 0, null);
      };
      return speedRecord(make(0, 100), make(5000, 400), context({ scene: null, frameSize: null }))!;
    };
    expect(pair({}, { targetFps: null })).toMatchObject({ logicFps: 60, targetFps: null, uncapped: true });
    const unknown = pair({}, { targetFps: undefined });
    expect(unknown).toMatchObject({ targetFps: null, uncapped: false });
    // No bridge: nothing is known about the match or the HD view, and nothing is made up.
    expect(unknown).toMatchObject({
      hdFps: null,
      hdShown: false,
      tier: null,
      hdPace: null,
      objects: null,
      localObjects: null,
      map: null,
      resolution: null,
    });
    expect(pair({ usage: null }).vm).toBeNull();
    expect(pair({ usage: usage({ guestMs: null, slices: null, jitCompiled: null, jitFreed: null }) }).vm).toMatchObject(
      {
        guestPct: null,
        otherPct: null,
        slicesPerS: null,
        hostCallPct: 0,
        jitCompiled: null,
        jitFreed: null,
      },
    );
  });

  it('records nothing across a menu, a loading scenario, a stopped VM or another match', () => {
    const running = speedSample(diagnostics(0, 500), 0, 0, null);
    const later = (over: Partial<VmDiagnostics>, frame = 800) =>
      speedSample(diagnostics(5000, frame, over), 5000, 0, null);
    const record = (a = running, b = later({})) => speedRecord(a, b, context());
    expect(record()).not.toBeNull();
    const menu = diagnostics(5000, 800);
    expect(record(running, later({ game: { ...menu.game!, status: 'inactive' } }))).toBeNull();
    expect(record(running, later({ game: null }))).toBeNull();
    expect(record(running, later({ phase: 'stopped' }))).toBeNull();
    // The counter starting over is another match; frame 0 is a scenario still loading.
    expect(record(running, later({}, 20))).toBeNull();
    expect(later({}, 0).frame).toBeNull();
    // A sample whose clock did not advance cannot give a rate.
    expect(record(running, speedSample(diagnostics(0, 800), 5000, 0, null))).toBeNull();
    // A stalled game in a running battle is a rate of zero, not silence.
    expect(record(running, later({}, 500))).toMatchObject({ logicFps: 0 });
  });
});

/** The telemetry with a hand-driven timer, clock and sink. */
function telemetry(
  answers: Array<VmDiagnostics | Error>,
  post: SpeedEnvironment['post'] = async () => true,
  endpoint?: string | null,
) {
  let run: () => void = () => undefined;
  const stopped = vi.fn();
  let at = 0;
  const publish = vi.fn();
  const observe = vi.fn();
  const posted: Array<{ url: string; records: SpeedRecord[] }> = [];
  const diagnosticsCall = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  const handle = startSpeedTelemetry({
    endpoint,
    diagnostics: diagnosticsCall,
    presentedFrames: () => Math.round(at * 0.06),
    frameSize: () => ({ width: 1728, height: 1080 }),
    scene: () => scene({ hdFrames: Math.round(at * 0.06) }),
    publish,
    observe,
    environment: {
      now: () => at,
      wallClock: () => 1_800_000_000_000 + at,
      visible: () => true,
      every(ms, tick) {
        expect(ms).toBe(SPEED_INTERVAL_MS);
        run = tick;
        return stopped;
      },
      post: (url, body) => {
        posted.push({ url, records: JSON.parse(body) as SpeedRecord[] });
        return post(url, body);
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    handle,
    publish,
    observe,
    posted,
    diagnosticsCall,
    stopped,
    settle,
    async tick(ms = SPEED_INTERVAL_MS) {
      at += ms;
      run();
      await settle();
    },
  };
}

describe('the telemetry loop', () => {
  it('shares native faults even when no complete logic sample can produce a speed record', async () => {
    const unavailable = diagnostics(5000, 301, { game: null, native: { mirrorFaultCount: 31 } });
    const t = telemetry([diagnostics(0, 1), unavailable]);
    await t.settle();
    await t.tick();
    expect(t.posted).toHaveLength(0);
    expect(t.observe).toHaveBeenLastCalledWith(null, unavailable);
    t.handle.dispose();
  });
  it('retains local records and toolbar rates without probing a server sink when endpoint is null', async () => {
    const t = telemetry([diagnostics(100, 1000), diagnostics(5100, 1210)], undefined, null);
    await t.settle();
    await t.tick();
    expect(t.handle.records()).toHaveLength(1);
    expect(t.publish).toHaveBeenLastCalledWith(42, 62.5);
    expect(t.posted).toHaveLength(0);
    t.handle.dispose();
  });
  it('asks with the usage action, posts one record a window to the speed route and tells the toolbar both rates', async () => {
    const t = telemetry([diagnostics(100, 1000), diagnostics(5100, 1210), diagnostics(10_100, 1522)]);
    await t.settle();
    // The first answer is only a baseline.
    expect(t.posted).toHaveLength(0);
    expect(t.publish).not.toHaveBeenCalled();
    await t.tick();
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.url).toBe('/__perf/speed');
    expect(t.posted[0]!.records).toHaveLength(1);
    expect(t.posted[0]!.records[0]).toMatchObject({ kind: 'speed', logicFps: 42, targetFps: 62.5, presentedFps: 60 });
    expect(t.publish).toHaveBeenLastCalledWith(42, 62.5);
    await t.tick();
    expect(t.posted[1]!.records[0]).toMatchObject({ logicFps: 62.4, logicFrame: 1522 });
    expect(t.handle.records().map((r) => r.logicFps)).toEqual([42, 62.4]);
    t.handle.dispose();
    expect(t.stopped).toHaveBeenCalledOnce();
    // The line goes with the session.
    expect(t.publish).toHaveBeenLastCalledWith(null, undefined);
  });

  it('clears the line when the battle ends and starts over from a fresh baseline', async () => {
    const menu = diagnostics(10_000, 1300);
    const t = telemetry([
      diagnostics(0, 1000),
      diagnostics(5000, 1300),
      { ...menu, game: { ...menu.game!, status: 'inactive' } },
      diagnostics(15_000, 40),
      diagnostics(20_000, 340),
    ]);
    await t.settle();
    await t.tick();
    expect(t.publish).toHaveBeenLastCalledWith(60, 62.5);
    await t.tick();
    expect(t.publish).toHaveBeenLastCalledWith(null, undefined);
    await t.tick(); // the next match's first sample: a baseline again
    expect(t.posted).toHaveLength(1);
    await t.tick();
    expect(t.posted).toHaveLength(2);
    expect(t.posted[1]!.records[0]).toMatchObject({ logicFps: 60, logicFrame: 340 });
    t.handle.dispose();
  });

  it('stops posting once the server has no such log, and keeps measuring for the toolbar', async () => {
    const t = telemetry(
      [diagnostics(0, 1), diagnostics(5000, 301), diagnostics(10_000, 601), diagnostics(15_000, 901)],
      async () => 'gone',
    );
    await t.settle();
    await t.tick();
    await t.tick();
    await t.tick();
    expect(t.posted).toHaveLength(1);
    expect(t.publish).toHaveBeenCalledTimes(3);
    expect(t.handle.records()).toHaveLength(3);
    t.handle.dispose();
  });

  it('survives a VM that fails to answer or a sink that throws, and never asks twice at once', async () => {
    let release: (value: VmDiagnostics) => void = () => undefined;
    const slow = new Promise<VmDiagnostics>((resolve) => (release = resolve));
    const t = telemetry([diagnostics(0, 1), new Error('worker gone'), diagnostics(10_000, 301)], async () => {
      throw new Error('offline');
    });
    await t.settle();
    await t.tick();
    // The failed answer dropped the baseline: the next one is a baseline again, not a 10-second window.
    await t.tick();
    expect(t.posted).toHaveLength(0);
    t.diagnosticsCall.mockImplementationOnce(() => slow);
    await t.tick();
    await t.tick();
    expect(t.diagnosticsCall).toHaveBeenCalledTimes(4);
    release(diagnostics(20_000, 901));
    await t.settle();
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.records[0]).toMatchObject({ logicFps: 60 });
    t.handle.dispose();
    // An answer that arrives after the session ended is dropped.
    const late = telemetry([diagnostics(0, 1)]);
    late.handle.dispose();
    await late.settle();
    expect(late.publish).not.toHaveBeenCalled();
  });
});

describe('toolbar line for the game speed', () => {
  function toolbar() {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const callbacks = { onClockRate: vi.fn(), onPerformance: vi.fn() } as unknown as RuntimeToolbarCallbacks;
    const bar = installRuntimeToolbar(callbacks, {} as HTMLCanvasElement, 'WebGL2', 'test renderer');
    const published = vi.fn();
    const unsubscribe = toolbarState.subscribe(published);
    const line = () => toolbarState.getSnapshot()?.model.gameSpeed;
    return { bar, published, line, end: () => (unsubscribe(), bar.destroy()) };
  }

  it('has a wording for a limited, an unlimited and an unknown target in both languages', () => {
    const zh = createTranslator('zh-CN'),
      en = createTranslator('en');
    expect(zh('游戏速度 实际 {0} / 应有 {1}', '41.8', '62.5')).toBe('游戏速度 实际 41.8 / 应有 62.5');
    expect(en('游戏速度 实际 {0} / 应有 {1}', '41.8', '62.5')).toBe('Game speed: 41.8 of 62.5 frames/s');
    expect(en('游戏速度 实际 {0} / 不限速', '88.0')).toBe('Game speed: 88.0 frames/s (no limit)');
    expect(en('游戏速度 实际 {0}', '30.0')).toBe('Game speed: 30.0 frames/s');
  });

  it('shows actual against allowed, is empty outside a battle, and tells the view only when the line changes', () => {
    const t = toolbar();
    const words = (key: Parameters<ReturnType<typeof createTranslator>>[0], ...args: string[]) =>
      [createTranslator('zh-CN'), createTranslator('en')].map((translate) => translate(key, ...args));
    expect(t.line()).toBe('');
    t.published.mockClear();
    t.bar.setGameSpeed(null);
    expect(t.published).not.toHaveBeenCalled();
    t.bar.setGameSpeed(41.84, 62.5);
    expect(words('游戏速度 实际 {0} / 应有 {1}', '41.8', '62.5')).toContain(t.line());
    t.bar.setGameSpeed(41.81, 62.5);
    expect(t.published).toHaveBeenCalledTimes(1);
    t.bar.setGameSpeed(88, null);
    expect(words('游戏速度 实际 {0} / 不限速', '88.0')).toContain(t.line());
    t.bar.setGameSpeed(30, undefined);
    expect(words('游戏速度 实际 {0}', '30.0')).toContain(t.line());
    t.bar.setGameSpeed(null);
    expect(t.line()).toBe('');
    t.end();
  });
});

describe('development-only wiring', () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('mounts the speed route on the stall log handler, in the development server only', () => {
    const config = source('../../vite.config.ts');
    const mounts = [...config.matchAll(/'\/__perf\/speed'/g)];
    expect(mounts).toHaveLength(1);
    const dev = config.indexOf('configureServer(server) {');
    const preview = config.indexOf('configurePreviewServer(server) {');
    expect(mounts[0]!.index).toBeGreaterThan(dev);
    expect(mounts[0]!.index).toBeLessThan(preview);
    expect(config.slice(mounts[0]!.index, preview)).toContain('createStallLogHandler(process.env.RA2_PERF_LOG ?');
  });

  it('is loaded by the page only behind import.meta.env.DEV, and only the module itself names the route', () => {
    const page = source('../../src/ui/pages/game/page.ts');
    const imports = [...page.matchAll(/import\(\s*'\.\/speedTelemetry'\s*\)/g)];
    expect(imports).toHaveLength(1);
    const guard = page.lastIndexOf('if (import.meta.env.DEV) {', imports[0]!.index);
    expect(guard).toBeGreaterThan(-1);
    expect(page.slice(guard, imports[0]!.index)).not.toContain('}');
    expect(page).not.toMatch(/import \{[^}]*\} from '\.\/speedTelemetry'/);
    for (const file of ['page.ts', 'runtimeToolbar.ts', 'hdBridge.ts'])
      expect(source(`../../src/ui/pages/game/${file}`), file).not.toContain('__perf');
    expect(source('../../src/ui/pages/game/speedTelemetry.ts')).toContain("'/__perf/speed'");
  });
});

describe('session feel fault persistence', () => {
  it('posts compact recovery and agent fault counters through the existing feel sink', () => {
    let at = 0;
    vi.stubGlobal('performance', { now: () => at, timeOrigin: 1_800_000_000_000 });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval: () => 1 }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }));
    vi.stubGlobal('screen', { width: 1728, height: 1117 });
    vi.stubGlobal('innerWidth', 1728);
    vi.stubGlobal('innerHeight', 1117);
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('PerformanceObserver', undefined);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const post = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', post);
    const screen = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1728, height: 1117 }),
    }) as unknown as HTMLCanvasElement;
    const telemetry = startSessionFeelTelemetry({
      screen,
      backend: 'native',
      scene: () => scene(),
      activity: () => null,
    });
    const fault = { address: 0x9000, rule: 12, stage: 2, readError: 998 };
    const mirrorRecovery = {
      count: 4,
      omitted: 2,
      events: [{ sequence: 3, retiredPageCount: 1, retiredRangeCount: 1, faultOwners: ['render'], fault }],
    };
    const expected = {
      mirrorRecovery,
      mirrorFaultCount: 12,
      mirrorFaultEvents: 9,
      recentMirrorFaultsOmitted: 1,
      lastMirrorFault: fault,
      recentMirrorFaults: [{ ...fault, occurrences: 4 }],
    };
    const record = speedRecord(
      speedSample(diagnostics(0, 1), 0, 0, null),
      speedSample(diagnostics(5000, 301), 5000, 300, null),
      context(),
    )!;
    telemetry.speed(record);
    telemetry.speed(null, { ...expected, unrelated: 'not a telemetry field' });
    at = 5000;
    telemetry.flush();
    expect(post).toHaveBeenCalledOnce();
    const call = post.mock.calls[0] as unknown as [string, { body: string }];
    expect(call[0]).toBe('/__perf/feel');
    const sent = JSON.parse(call[1].body)[0];
    expect(sent.native).toMatchObject(expected);
    expect(sent.logicFps).toBeNull();
    expect(sent.native).not.toHaveProperty('unrelated');
    expect(sent.native.mirrorRecovery.events[0]).not.toHaveProperty('learned');
    telemetry.dispose();
  });
});
