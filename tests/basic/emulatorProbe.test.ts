import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEmulatorProbe } from '../../src/platform/browser/emulatorProbe';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('measures actual waits and CPU work while preserving ticks, requested delays and method ownership', () => {
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  const engine = {
    tick_counter: 0,
    yield: vi.fn((_delay: number, _tick: number) => {}),
    yield_callback(tick: number) {
      if (this.tick_counter === tick) this.cpu.main_loop();
    },
    cpu: {
      main_loop() {
        at += 2;
        return 17;
      },
    },
  };
  const methods = { yield: engine.yield, callback: engine.yield_callback, loop: engine.cpu.main_loop };
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'message-channel');
  expect(engine.yield).toBe(methods.yield);
  probe.start();
  engine.yield(0, ++engine.tick_counter);
  at = 5;
  engine.yield_callback(1);
  engine.yield(10, ++engine.tick_counter);
  at = 20;
  engine.yield_callback(1); // Superseded notification must not count as a wait or execute the CPU.
  engine.yield_callback(2);
  expect(probe.sample()).toMatchObject({
    supported: true,
    scheduler: 'message-channel',
    staleCallbacks: 1,
    immediateWaits: { count: 1, totalMs: 5 },
    delayedWaitOvershoot: { count: 1, totalMs: 3 },
    cpuSlices: { count: 2, totalMs: 4 },
    jitDisabled: null,
  });
  expect(methods.yield.mock.calls).toEqual([
    [0, 1],
    [10, 2],
  ]);
  probe.stop();
  expect(engine.yield).toBe(methods.yield);
  expect(engine.yield_callback).toBe(methods.callback);
  expect(engine.cpu.main_loop).toBe(methods.loop);
  at = 100;
  expect(probe.sample().elapsedMs).toBe(22);
  probe.start();
  expect(probe.sample().cpuSlices.count).toBe(0);
  probe.detach();
  expect(engine.cpu.main_loop).toBe(methods.loop);
});

it('reports unsupported interfaces and reads JIT configuration without modifying it', () => {
  const probe = new BrowserEmulatorProbe();
  probe.attach({}, 'upstream-other');
  probe.start();
  expect(probe.sample()).toMatchObject({ supported: false, jitDisabled: null, cpuSlices: { count: 0, meanMs: null } });
  probe.stop();
  const getConfig = vi.fn(() => 0);
  probe.attach(
    {
      tick_counter: 0,
      yield() {},
      yield_callback() {},
      cpu: {
        main_loop() {
          return 0;
        },
        wm: { exports: { get_jit_config: getConfig, jit_get_cache_size: () => 100 } },
      },
    },
    'upstream-worker',
  );
  probe.start();
  expect(probe.sample()).toMatchObject({ supported: true, jitDisabled: false, jitCacheSize: 100 });
  expect(getConfig).toHaveBeenCalledWith(0);
  probe.detach();
});

it('restores uninstrumented methods if the capture client disappears', () => {
  vi.useFakeTimers();
  const engine = {
    tick_counter: 0,
    yield() {},
    yield_callback() {},
    cpu: {
      main_loop() {
        return 0;
      },
    },
  };
  const original = engine.cpu.main_loop;
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'upstream-worker');
  probe.start();
  expect(engine.cpu.main_loop).not.toBe(original);
  vi.advanceTimersByTime(30_000);
  expect(engine.cpu.main_loop).toBe(original);
  expect(probe.sample().active).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  probe.detach();
});

it('meters CPU-loop time only once asked, below a capture, and gives the loop back on detach', () => {
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  const engine = {
    tick_counter: 0,
    yield: (_delay: number, _tick: number) => {},
    yield_callback(_tick: number) {},
    cpu: {
      main_loop() {
        at += 3;
        return 0;
      },
    },
  };
  const loop = engine.cpu.main_loop;
  const probe = new BrowserEmulatorProbe();
  expect(probe.usage()).toBeNull(); // nothing attached yet
  probe.attach(engine, 'message-channel');
  expect(engine.cpu.main_loop).toBe(loop); // attaching alone wraps nothing
  engine.cpu.main_loop();
  expect(probe.usage()).toEqual({ guestMs: 0, slices: 0, jitCompiled: null, jitFreed: null });
  expect(engine.cpu.main_loop).not.toBe(loop);
  expect(engine.cpu.main_loop()).toBe(0);
  engine.cpu.main_loop();
  expect(probe.usage()).toMatchObject({ guestMs: 6, slices: 2 });
  // A capture wraps the metered loop and restores it: the accounting goes on through and after the capture.
  const metered = engine.cpu.main_loop;
  probe.start();
  engine.cpu.main_loop();
  expect(probe.sample().cpuSlices).toMatchObject({ count: 1, totalMs: 3 });
  probe.stop();
  expect(engine.cpu.main_loop).toBe(metered);
  engine.cpu.main_loop();
  expect(probe.usage()).toMatchObject({ guestMs: 12, slices: 4 });
  probe.detach();
  expect(engine.cpu.main_loop).toBe(loop);
  expect(probe.usage()).toBeNull();
});

it('starts the accounting after a running capture instead of under its restore', () => {
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  const engine = {
    tick_counter: 0,
    yield: (_delay: number, _tick: number) => {},
    yield_callback(_tick: number) {},
    cpu: {
      main_loop() {
        at += 2;
        return 0;
      },
    },
  };
  const loop = engine.cpu.main_loop;
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'message-channel');
  probe.start();
  expect(probe.usage()).toBeNull();
  engine.cpu.main_loop();
  probe.stop();
  expect(probe.usage()).toEqual({ guestMs: 0, slices: 0, jitCompiled: null, jitFreed: null });
  engine.cpu.main_loop();
  expect(probe.usage()).toMatchObject({ guestMs: 2, slices: 1 });
  // Detached in the middle of a capture: both layers come off.
  probe.start();
  probe.detach();
  expect(engine.cpu.main_loop).toBe(loop);
});

it('counts the modules the JIT compiles and gives up while metering, through the methods the emulator calls', () => {
  vi.spyOn(performance, 'now').mockImplementation(() => 0);
  const seen: unknown[][] = [];
  const cpu = {
    main_loop: () => 0,
    codegen_finalize(...args: unknown[]) {
      seen.push(['compile', this === cpu, ...args]);
    },
    jit_clear_func(index: number) {
      seen.push(['free', this === cpu, index]);
    },
  };
  const original = { finalize: cpu.codegen_finalize, free: cpu.jit_clear_func };
  const engine = { tick_counter: 0, yield: () => {}, yield_callback: () => {}, cpu };
  const probe = new BrowserEmulatorProbe();
  probe.attach(engine, 'message-channel');
  cpu.codegen_finalize(1, 2, 3, 4, 5); // before anybody asked: not counted, not wrapped
  expect(probe.usage()).toMatchObject({ jitCompiled: 0, jitFreed: 0 });
  cpu.codegen_finalize(7, 0x401000, 0, 64, 128);
  cpu.jit_clear_func(7);
  cpu.jit_clear_func(8);
  expect(probe.usage()).toMatchObject({ jitCompiled: 1, jitFreed: 2 });
  // Arguments and receiver reach the emulator's own methods unchanged.
  expect(seen.slice(1)).toEqual([
    ['compile', true, 7, 0x401000, 0, 64, 128],
    ['free', true, 7],
    ['free', true, 8],
  ]);
  probe.detach();
  expect(cpu.codegen_finalize).toBe(original.finalize);
  expect(cpu.jit_clear_func).toBe(original.free);
});
