import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeCore, NativeUnsupportedError } from '../../../src/adapter/native/core';
import type { NativeGamePolicyFactory } from '../../../src/adapter/native/core';
import type { NativeWebSocket } from '../../../src/adapter/native/connection';
import {
  NativeMessageType,
  NATIVE_MAX_MESSAGE,
  NATIVE_PAGE_SIZE,
  decodePacket,
  encodePacket,
  encodeU32,
} from '../../../src/adapter/native/protocol';
import type { NativePacket } from '../../../src/adapter/native/protocol';
import type { GameRenderState } from '../../../src/games/renderState';
import type { GameVmCallbacks } from '../../../src/app/session/runtimeEvents';
import type { GameFileProvider } from '../../../src/resources/contracts';

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const u32 = (bytes: Uint8Array, offset = 0) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

class FakeAgent implements NativeWebSocket {
  binaryType = '';
  readyState = 1;
  onopen: NativeWebSocket['onopen'] = null;
  onmessage: NativeWebSocket['onmessage'] = null;
  onerror: NativeWebSocket['onerror'] = null;
  onclose: NativeWebSocket['onclose'] = null;
  requests: NativePacket[] = [];
  closes = 0;
  mirrorOnHook = true;
  hookEnabled = false;
  threadId = 77;
  refuseInput = false;
  modal = false;
  initial = new Uint8Array(NATIVE_PAGE_SIZE);
  constructor() {
    this.initial[0] = 7;
  }
  send(bytes: Uint8Array): void {
    const request = decodePacket(bytes);
    this.requests.push(request);
    if (request.type === NativeMessageType.Ack) return;
    if (request.type === NativeMessageType.Hook) {
      this.hookEnabled = u32(request.payload) !== 0;
      this.emit(request.type, request.id);
      if (this.hookEnabled && this.mirrorOnHook)
        queueMicrotask(() => this.mirror(1, [{ address: 0x1000, bytes: this.initial }], 2));
    } else if (request.type === NativeMessageType.Diagnostics) {
      this.emit(
        request.type,
        request.id,
        json({ gameThreadId: this.threadId, frameHook: { site: 0x2000, original: [1, 2], patched: [3, 4] } }),
      );
    } else if (request.type === NativeMessageType.Input && this.refuseInput) {
      this.emit(NativeMessageType.Error, request.id, new TextEncoder().encode('input unsupported'));
    } else if (request.type === NativeMessageType.InputState) {
      this.emit(
        request.type,
        request.id,
        json({ modal: this.modal, x: 0, y: 0, lastMessage: 0, lastKeyMessage: 0, lastKeyVirtualKey: 0 }),
      );
    } else this.emit(request.type, request.id);
  }
  close(): void {
    this.closes++;
    this.readyState = 3;
  }
  emit(type: NativeMessageType, id: number, payload: Uint8Array = new Uint8Array()): void {
    this.onmessage?.({ data: encodePacket(type, id, payload) });
  }
  hello(verified = true): void {
    this.emit(
      NativeMessageType.Hello,
      0,
      json({
        protocol: 1,
        pid: 10,
        gameThreadId: 0,
        exe: { size: 1000, peTimestamp: 123, sha256: 'a'.repeat(64), verified },
        surface: { width: 0, height: 0, bpp: 0, format: 'RGB565' },
        limits: { messageBytes: NATIVE_MAX_MESSAGE, pages: 4096, rules: 256 },
      }),
    );
  }
  mirror(frame: number, pages: { address: number; bytes: Uint8Array }[], flags = 0): void {
    this.emit(
      NativeMessageType.Mirror,
      0,
      concat(
        encodeU32(frame, flags, pages.length, 0),
        ...pages.flatMap((page) => [encodeU32(page.address), page.bytes]),
      ),
    );
  }
  picture(frame: number, full = true): void {
    this.emit(
      NativeMessageType.Picture,
      0,
      full ? concat(encodeU32(frame, 2, 1, 1, 0, 2), new Uint8Array([2, 0x80])) : encodeU32(frame, 2, 1, 0),
    );
  }
  count(type: NativeMessageType): number {
    return this.requests.filter((request) => request.type === type).length;
  }
}

function state(frame: number): GameRenderState {
  return {
    frame,
    view: null,
    map: null,
    houses: [],
    localHouse: -1,
    objects: [],
    shroud: null,
    overlays: null,
    smudges: null,
    effects: null,
  };
}
const active: NativeCore[] = [];
function setup(callbacks: GameVmCallbacks = {}) {
  const agent = new FakeAgent();
  const scheduled: (() => void)[] = [];
  const renderFactory = vi.fn();
  const mode: { missing: boolean; additionalAddress: number | null } = { missing: false, additionalAddress: null };
  const policyFactory: NativeGamePolicyFactory = vi.fn((memory) => ({
    ranges: [{ address: 0x1000, length: 4 }],
    rules: [],
    additionalRanges: () => (mode.additionalAddress === null ? [] : [{ address: mode.additionalAddress, length: 1 }]),
    createRenderReader: () => {
      renderFactory();
      return () => {
        const frame = memory.read_memory(0x1000, 1)[0]!;
        if (mode.missing) {
          // Real optional readers often catch a missing-pointer exception. The outer
          // operation still has to discard this seemingly successful partial result.
          try {
            return state(memory.read_memory(0x9000, 1)[0]!);
          } catch {
            return state(999);
          }
        }
        return state(frame);
      };
    },
    createCommandReader: () => null,
    createFrameReader: () => () => ({ frame: memory.frame ?? 0, gameSpeed: 1, sessionSpeed: 1, requestedFps: 60 }),
    installPassthrough: () => null,
    setSpeed: () => null,
  }));
  const core = new NativeCore(
    callbacks,
    { url: 'ws://127.0.0.1:15450', token: 'a'.repeat(32), createWebSocket: () => agent, timeoutMs: 100 },
    policyFactory,
    (emit) => scheduled.push(emit),
  );
  active.push(core);
  return { agent, core, scheduled, policyFactory, renderFactory, mode };
}
async function started(callbacks: GameVmCallbacks = {}) {
  const test = setup(callbacks);
  const start = test.core.start();
  test.agent.hello();
  await start;
  return test;
}
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
afterEach(async () => {
  await Promise.all(active.splice(0).map((core) => core.stop().catch(() => undefined)));
  vi.useRealTimers();
});

describe('native core session and presenter lifecycle', () => {
  it('waits for a complete mirror and verified owner metadata before reporting running', async () => {
    const statuses = vi.fn();
    const { core, agent, policyFactory } = await started({ onStatus: statuses });
    expect(agent.hookEnabled).toBe(true);
    expect(agent.count(NativeMessageType.Credit)).toBe(1);
    expect(policyFactory).toHaveBeenCalledTimes(2);
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'running' });
    await core.start();
    expect(agent.count(NativeMessageType.Hook)).toBe(1);
    await core.stop();
    expect(agent.hookEnabled).toBe(false);
    expect(agent.closes).toBe(1);
    expect(core.memory.complete).toBe(false);
    await expect(core.start()).rejects.toThrow('cannot be restarted');
  });
  it('rejects unsupported identity and missing logic-owner discovery while removing hooks', async () => {
    const unsupported = setup();
    const unsupportedStart = unsupported.core.start();
    unsupported.agent.hello(false);
    await expect(unsupportedStart).rejects.toThrow('identity is unsupported');
    expect(unsupported.agent.hookEnabled).toBe(false);
    expect(unsupported.agent.closes).toBe(1);
    expect(unsupported.agent.count(NativeMessageType.Credit)).toBe(0);
    const absent = setup();
    absent.agent.threadId = 0;
    const discovery = absent.core.start();
    absent.agent.hello();
    await expect(discovery).rejects.toThrow('logic thread has not been observed');
    expect(absent.agent.hookEnabled).toBe(false);
    expect(absent.agent.closes).toBe(1);
  });
  it('stops an incomplete startup and rejects the waiting mirror without hanging', async () => {
    const { core, agent } = setup();
    agent.mirrorOnHook = false;
    const start = core.start();
    const rejected = expect(start).rejects.toThrow('stopped');
    agent.hello();
    await flush();
    expect(agent.hookEnabled).toBe(true);
    await core.stop();
    await rejected;
    expect(agent.hookEnabled).toBe(false);
    expect(agent.closes).toBe(1);
  });
  it('uses one picture credit until presenter recycling, preserving decoder state after consumer transfer', async () => {
    const frames = vi.fn();
    const { core, agent, scheduled } = await started({ onFrame: frames });
    core.requestNextFrame();
    core.requestNextFrame();
    expect(agent.count(NativeMessageType.Credit)).toBe(1);
    agent.picture(2);
    expect(frames).not.toHaveBeenCalled();
    scheduled.shift()!();
    const pixels = frames.mock.calls[0]![0].rgb565 as Uint16Array;
    expect([...pixels]).toEqual([0xf81f, 0xf81f]);
    structuredClone(pixels.buffer, { transfer: [pixels.buffer] });
    core.requestNextFrame();
    core.requestNextFrame();
    expect(agent.count(NativeMessageType.Credit)).toBe(2);
    agent.picture(3, false);
    scheduled.shift()!();
    expect([...frames.mock.calls[1]![0].rgb565]).toEqual([0xf81f, 0xf81f]);
  });
  it('suppresses a queued frame after stopping and reports emulator-only operations as unsupported', async () => {
    const frames = vi.fn();
    const { core, agent, scheduled } = await started({ onFrame: frames });
    expect(core.setGameClockRate(2)).toBe(0);
    expect(core.startMemRecord()).toBe(false);
    expect(core.stopMemRecord()).toBeNull();
    expect(() => core.setFileProvider({} as GameFileProvider)).toThrow(NativeUnsupportedError);
    await expect(core.flushFiles()).rejects.toThrow('persistence');
    agent.picture(2);
    await core.stop();
    scheduled.shift()!();
    expect(frames).not.toHaveBeenCalled();
  });
  it('returns the previous good render result when an optional reader swallows repeated typed misses', async () => {
    const { core, agent, mode, renderFactory } = await started();
    const good = await core.getRenderState();
    expect(good?.frame).toBe(7);
    mode.missing = true;
    const retry = core.getRenderState();
    for (let frame = 2; frame < 14; frame++) {
      await flush();
      agent.mirror(frame, [{ address: 0x1000, bytes: agent.initial }], frame === 2 ? 2 : 0);
    }
    expect(await retry).toBe(good);
    expect(renderFactory.mock.calls.length).toBeGreaterThan(1);
    expect(agent.count(NativeMessageType.Read)).toBe(0);
    expect(core.memory.misses).toBeGreaterThan(0);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
  });
  it('recreates a swallowed-miss reader only after a later complete mirror supplies the page', async () => {
    const { core, agent, mode, renderFactory } = await started();
    await core.getRenderState();
    mode.missing = true;
    const retry = core.getRenderState();
    await flush();
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    agent.mirror(
      2,
      [
        { address: 0x1000, bytes: agent.initial },
        { address: 0x9000, bytes: added },
      ],
      2,
    );
    await flush();
    agent.mirror(3, [], 0);
    expect((await retry)?.frame).toBe(42);
    expect(renderFactory.mock.calls.length).toBeGreaterThan(1);
    expect(agent.count(NativeMessageType.Read)).toBe(0);
  });
  it('rejects an in-progress reader on disconnect and ceases publishing stale state', async () => {
    const statuses = vi.fn();
    const { core, agent, mode } = await started({ onStatus: statuses });
    expect((await core.getRenderState())?.frame).toBe(7);
    mode.missing = true;
    const retry = core.getRenderState();
    const rejected = expect(retry).rejects.toThrow('closed');
    await flush();
    agent.onclose?.({});
    await rejected;
    expect(await core.getRenderState()).toBeNull();
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'error' });
    expect(agent.closes).toBe(1);
  });
  it('hides HD state while a native modal owns the surface', async () => {
    const { core, agent } = await started();
    expect((await core.getRenderState())?.frame).toBe(7);
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    agent.modal = false;
    expect((await core.getRenderState())?.frame).toBe(7);
  });
  it('refreshes newly requested policy scope even when an older cached page can satisfy the read', async () => {
    const { core, agent, mode } = await started();
    const old = new Uint8Array(NATIVE_PAGE_SIZE);
    old[0] = 9;
    agent.mirror(2, [{ address: 0x9000, bytes: old }]);
    mode.missing = true;
    mode.additionalAddress = 0x9000;
    let settled = false;
    const pending = core.getRenderState().then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(settled).toBe(false);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
    const fresh = new Uint8Array(NATIVE_PAGE_SIZE);
    fresh[0] = 42;
    agent.mirror(
      3,
      [
        { address: 0x1000, bytes: agent.initial },
        { address: 0x9000, bytes: fresh },
      ],
      2,
    );
    expect((await pending)?.frame).toBe(42);
    expect(core.memory.misses).toBe(0);
  });
  it('closes the attachment and removes hooks when the host refuses an input operation', async () => {
    const statuses = vi.fn();
    const { core, agent } = await started({ onStatus: statuses });
    agent.refuseInput = true;
    core.setKeyState(65, true);
    await flush();
    expect(agent.hookEnabled).toBe(false);
    expect(agent.closes).toBe(1);
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'error', detail: 'input unsupported' });
    expect(await core.getRenderState()).toBeNull();
  });
  it('retains the previous good reader result and an explicit diagnostic when the fresh mirror times out', async () => {
    const { core, agent, mode } = await started();
    const good = await core.getRenderState();
    vi.useFakeTimers();
    mode.missing = true;
    const pending = core.getRenderState();
    await flush();
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBe(good);
    const diagnostics = await core.getDiagnostics('sample');
    expect(diagnostics.native).toMatchObject({ lastReaderError: expect.stringContaining('No complete native mirror') });
    expect(agent.closes).toBe(0);
  });
  it('fails startup and removes the hook when its first complete mirror times out', async () => {
    vi.useFakeTimers();
    const { core, agent } = setup();
    agent.mirrorOnHook = false;
    const start = core.start();
    const rejected = expect(start).rejects.toThrow('No complete native mirror');
    agent.hello();
    await flush();
    expect(agent.hookEnabled).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(agent.hookEnabled).toBe(false);
    expect(agent.closes).toBe(1);
    expect(agent.count(NativeMessageType.Credit)).toBe(0);
  });
});
