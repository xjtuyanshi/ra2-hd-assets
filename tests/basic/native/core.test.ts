import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeCore, NativeUnsupportedError } from '../../../src/adapter/native/core';
import type { NativeCoreOptions, NativeGamePolicyFactory } from '../../../src/adapter/native/core';
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
import { createYrNativeHouseTailDiscovery, prepareYrHiddenPresentation } from '../../../src/games/yr/nativeHost';
import { YR_STATE_GLOBALS as YG, YR_STATE_OFFSETS as YO } from '../../../src/games/yr/stateReader';
import { createGuestMemory, writeU32 } from '../../helpers/guestMemory';
import type { GuestMemory, VmFrame } from '../../../src/vm86/win32';
import type { MenuSnapshot } from '../../../src/vm86/menuSnapshot';

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
  hidden = false;
  threadId = 77;
  mirrorFault: { reason: number; stage: number; rule: number; value: number; limit: number; address?: number } | null =
    null;
  refuseInput = false;
  holdInput = false;
  pendingInput: NativePacket[] = [];
  modal = false;
  menuVisible: boolean | undefined;
  menuSnapshot: MenuSnapshot | null = null;
  menuIdentity = false;
  moviePlaying: boolean | null | undefined;
  initial = new Uint8Array(NATIVE_PAGE_SIZE);
  revisionSupport = false;
  mirrorWindow: 1 | 2 | undefined;
  mirrorFaultSnapshot: boolean | undefined;
  subscriptionRevision = 0;
  surface = { width: 0, height: 0, bpp: 0, format: 'RGB565' };
  cursorSnapshot = false;
  drawJournal = false;
  cursorPayload: Uint8Array = new Uint8Array(28);
  cursorError: string | null = null;
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
    } else if (request.type === NativeMessageType.Subscribe && this.revisionSupport) {
      this.subscriptionRevision++;
      this.emit(request.type, request.id, encodeU32(this.subscriptionRevision));
    } else if (request.type === NativeMessageType.Diagnostics) {
      if (request.payload.length) {
        if (this.mirrorFaultSnapshot && request.payload.length === 4 && u32(request.payload) === 1)
          this.emit(request.type, request.id, json({ lastMirrorFault: this.mirrorFault }));
        else
          this.emit(NativeMessageType.Error, request.id, new TextEncoder().encode('unsupported diagnostics payload'));
        return;
      }
      this.emit(
        request.type,
        request.id,
        json({
          gameThreadId: this.threadId,
          frameHook: { site: 0x2000, original: [1, 2], patched: [3, 4] },
          lastMirrorFault: this.mirrorFault,
        }),
      );
    } else if (request.type === NativeMessageType.Input) {
      if (this.holdInput) this.pendingInput.push(request);
      else if (this.refuseInput)
        this.emit(NativeMessageType.Error, request.id, new TextEncoder().encode('input unsupported'));
      else this.emit(request.type, request.id);
    } else if (request.type === NativeMessageType.InputState) {
      if (request.payload.length === 4 && u32(request.payload) === 3) {
        this.emit(request.type, request.id, json(this.menuSnapshot));
        return;
      }
      if (this.cursorSnapshot && request.payload.length === 4 && u32(request.payload) === 2) {
        if (this.cursorError)
          this.emit(NativeMessageType.Error, request.id, new TextEncoder().encode(this.cursorError));
        else this.emit(request.type, request.id, this.cursorPayload);
        return;
      }
      this.emit(
        request.type,
        request.id,
        // Legacy agents ignore request flags and still return full metadata.
        json({
          modal: this.modal,
          menuVisible: this.menuVisible,
          menuHwnd: this.menuSnapshot?.dialogHwnd,
          moviePlaying: this.moviePlaying,
          x: 0,
          y: 0,
          lastMessage: 0,
          lastKeyMessage: 0,
          lastKeyVirtualKey: 0,
          controls: [{ id: 12, class: 'ListBox', list: { count: 2, selection: 0, topIndex: 0, itemHeight: 19 } }],
        }),
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
  hello(verified = true, pageRemovals?: boolean, maxBudgetUs?: number, subscribeRevision = pageRemovals): void {
    this.revisionSupport = subscribeRevision === true && pageRemovals === true;
    this.emit(
      NativeMessageType.Hello,
      0,
      json({
        protocol: 1,
        pid: 10,
        gameThreadId: 0,
        hidden: this.hidden,
        exe: { size: 1000, peTimestamp: 123, sha256: 'a'.repeat(64), verified },
        surface: this.surface,
        limits: {
          messageBytes: NATIVE_MAX_MESSAGE,
          pages: 4096,
          rules: 256,
          pageRemovals,
          maxBudgetUs,
          subscribeRevision,
          mirrorWindow: this.mirrorWindow,
          mirrorFaultSnapshot: this.mirrorFaultSnapshot,
          ...(this.cursorSnapshot ? { cursorSnapshot: true } : {}),
          menuSnapshot: true,
          ...(this.drawJournal ? { drawJournal: true } : {}),
          menuIdentity: this.menuIdentity,
        },
      }),
    );
  }
  mirror(
    frame: number,
    pages: { address: number; bytes: Uint8Array }[],
    flags = 0,
    revision = this.subscriptionRevision,
  ): void {
    const includeRevision = this.revisionSupport && !(flags & 5);
    this.emit(
      NativeMessageType.Mirror,
      0,
      concat(
        encodeU32(frame, flags | (includeRevision ? 16 : 0), pages.length, 0),
        ...pages.flatMap((page) => [encodeU32(page.address), page.bytes]),
        ...(includeRevision ? [encodeU32(revision)] : []),
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
function setup(callbacks: GameVmCallbacks = {}, options: Partial<NativeCoreOptions> = {}) {
  const agent = new FakeAgent();
  const scheduled: (() => void)[] = [];
  const renderFactory = vi.fn();
  const mode: {
    missing: boolean;
    additionalAddress: number | null;
    map: GameRenderState['map'];
    targetFps?: number;
  } = { missing: false, additionalAddress: null, map: null };
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
        return { ...state(frame), map: mode.map };
      };
    },
    createCommandReader: () => null,
    createFrameReader: () => () => ({
      frame: memory.frame ?? 0,
      gameSpeed: 1,
      sessionSpeed: 1,
      requestedFps: 60,
      targetFps: mode.targetFps,
    }),
    installPassthrough: () => null,
    setSpeed: () => null,
  }));
  const core = new NativeCore(
    callbacks,
    { url: 'ws://127.0.0.1:15450', token: 'a'.repeat(32), createWebSocket: () => agent, timeoutMs: 100, ...options },
    policyFactory,
    (emit) => scheduled.push(emit),
  );
  active.push(core);
  return { agent, core, scheduled, policyFactory, renderFactory, mode };
}
async function started(callbacks: GameVmCallbacks = {}, mirrorFaultSnapshot?: boolean) {
  const test = setup(callbacks);
  test.agent.mirrorFaultSnapshot = mirrorFaultSnapshot;
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native core session and presenter lifecycle', () => {
  it('separates mirror publications, complete states and repeated handoffs in cadence diagnostics', async () => {
    const { core, agent } = await started();
    await core.getRenderState();
    await core.getRenderState();
    agent.mirror(2, [], 1);
    expect(await core.getRenderState()).toBeNull();
    const next = agent.initial.slice();
    next[0] = 8;
    agent.mirror(3, [{ address: 0x1000, bytes: next }]);
    expect((await core.getRenderState())?.frame).toBe(8);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      cadence: {
        mirrors: 3,
        completeMirrors: 2,
        distinctMirrors: 2,
        truncatedMirrors: 1,
        invalidMirrors: 0,
        renderRequests: 4,
        renderAttempts: 2,
        renderCached: 1,
        renderCompletions: 2,
        distinctRenderCompletions: 2,
        renderHandoffs: 3,
        distinctRenderHandoffs: 2,
        recent: [
          expect.objectContaining({ stage: 'mirror', frame: 1 }),
          expect.objectContaining({ stage: 'built', frame: 7 }),
          expect.objectContaining({ stage: 'handoff', frame: 7 }),
          expect.objectContaining({ stage: 'mirror', frame: 3 }),
          expect.objectContaining({ stage: 'built', frame: 8 }),
          expect.objectContaining({ stage: 'handoff', frame: 8 }),
        ],
      },
      decode: { mirrors: 3, messages: { mirrorReceived: 3, acknowledgementsSent: 3 } },
    });
  });

  it('reuses only the exact complete publication while checking fresh modal state and same-frame changes', async () => {
    const { core, agent } = await started();
    const first = await core.getRenderState();
    const inputReads = agent.count(NativeMessageType.InputState);
    expect(await core.getRenderState()).toBe(first);
    expect(agent.count(NativeMessageType.InputState)).toBe(inputReads + 1);
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    agent.modal = false;
    expect(await core.getRenderState()).toBe(first);
    const changed = agent.initial.slice();
    changed[0] = 9;
    agent.mirror(1, [{ address: 0x1000, bytes: changed }]);
    expect((await core.getRenderState())?.frame).toBe(9);
    agent.mirror(1, [], 1);
    expect(await core.getRenderState()).toBeNull();
    agent.mirror(1, [{ address: 0x1000, bytes: agent.initial }]);
    expect((await core.getRenderState())?.frame).toBe(7);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      cadence: { renderCached: 2, renderAttempts: 3, renderCompletions: 3, renderHandoffs: 5 },
    });
  });

  it('shares a pending battlefield publication wait and confirms input after a same-frame change wakes it', async () => {
    vi.useFakeTimers();
    const { core, agent, mode } = await started();
    mode.map = { fileName: 'test.map' };
    await core.getRenderState();
    const inputReads = agent.count(NativeMessageType.InputState);
    const first = core.getRenderState();
    const second = core.getRenderState();
    await flush();
    expect(agent.count(NativeMessageType.InputState)).toBe(inputReads);
    const changed = agent.initial.slice();
    changed[0] = 9;
    agent.mirror(1, [{ address: 0x1000, bytes: changed }]);
    expect((await first)?.frame).toBe(9);
    expect((await second)?.frame).toBe(9);
    expect(agent.count(NativeMessageType.InputState)).toBeGreaterThan(inputReads);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      cadence: { renderPublicationWaits: 1, renderPublicationWakes: 1, renderPublicationTimeouts: 0 },
    });
  });

  it.each([undefined, 100, 10])(
    'bounds duplicate-state waiting using target %s and then checks fresh modal ownership',
    async (targetFps) => {
      vi.useFakeTimers();
      const { core, agent, mode } = await started();
      mode.map = { fileName: 'test.map' };
      mode.targetFps = targetFps;
      await core.getRenderState();
      await core.getGamePerformance();
      let finished = false;
      const pending = core.getRenderState().then((value) => {
        finished = true;
        return value;
      });
      const duration = Math.min(1000 / (targetFps ?? 60), 1000 / 60);
      await vi.advanceTimersByTimeAsync(duration / 2);
      expect(finished).toBe(false);
      agent.modal = true;
      await vi.advanceTimersByTimeAsync(Math.ceil(duration));
      expect(await pending).toBeNull();
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        cadence: { renderPublicationWaits: 1, renderPublicationWakes: 0, renderPublicationTimeouts: 1 },
      });
    },
  );

  it('interrupts publication waiting for real menu input without waiting for a mirror or deadline', async () => {
    vi.useFakeTimers();
    const { core, agent, mode } = await started();
    mode.map = { fileName: 'test.map' };
    await core.getRenderState();
    const inputReads = agent.count(NativeMessageType.InputState);
    const pending = core.getRenderState();
    await flush();
    core.setCursorPosition(10, 20);
    await flush();
    expect(agent.count(NativeMessageType.InputState)).toBe(inputReads);
    agent.modal = true;
    core.postMessage(0x100, 27);
    expect(await pending).toBeNull();
    expect(agent.count(NativeMessageType.InputState)).toBe(inputReads + 1);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      cadence: { renderPublicationWaits: 1, renderPublicationInterrupts: 1, renderPublicationTimeouts: 0 },
    });
  });

  it.each([1, 4])(
    'ends a duplicate-state wait on incomplete mirror flags %s without releasing stale state',
    async (flags) => {
      vi.useFakeTimers();
      const { core, agent, mode } = await started();
      mode.map = { fileName: 'test.map' };
      await core.getRenderState();
      const pending = core.getRenderState();
      await flush();
      agent.mirror(2, [], flags);
      expect(await pending).toBeNull();
      await flush();
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        renderHealth: { unreadableSinceEpochMs: flags === 4 ? expect.any(Number) : null },
      });
      agent.mirror(3, [{ address: 0x1000, bytes: agent.initial }], 2);
      await flush();
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        cadence: { renderPublicationWaits: 1, renderPublicationInterrupts: 1, renderPublicationTimeouts: 0 },
        renderHealth: { unreadableSinceEpochMs: flags === 4 ? expect.any(Number) : null },
      });
      expect((await core.getRenderState())?.frame).toBe(7);
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        renderHealth: { unreadableSinceEpochMs: null },
      });
    },
  );

  it.each([undefined, false, true])(
    'keeps budget truncation transient with fault snapshots %s',
    async (mirrorFaultSnapshot) => {
      vi.useFakeTimers();
      const { core, agent } = await started({}, mirrorFaultSnapshot);
      expect((await core.getRenderState())?.frame).toBe(7);
      agent.mirrorFault = { reason: 1, stage: 2, rule: 0, value: 1000, limit: 4000 };
      agent.mirror(2, [], 1);
      for (let index = 0; index < 3; index++) {
        await vi.advanceTimersByTimeAsync(600);
        expect(await core.getRenderState()).toBeNull();
      }
      expect(agent.count(NativeMessageType.Subscribe)).toBe(1);
      const recoveryDiagnostic = agent.requests
        .filter((request) => request.type === NativeMessageType.Diagnostics)
        .at(-1)!;
      expect([...recoveryDiagnostic.payload]).toEqual(mirrorFaultSnapshot ? [...encodeU32(1)] : []);
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        frameHook: { site: 0x2000, original: [1, 2], patched: [3, 4] },
        lastMirrorFault: agent.mirrorFault,
        renderHealth: { unreadableSinceEpochMs: null },
        mirrorRecovery: { count: 0 },
      });
      expect(
        agent.requests.filter((request) => request.type === NativeMessageType.Diagnostics).at(-1)!.payload,
      ).toHaveLength(0);
      agent.mirror(3, [{ address: 0x1000, bytes: agent.initial }]);
      expect((await core.getRenderState())?.frame).toBe(7);
    },
  );

  it.each(['stop', 'disconnect'])(
    'settles publication waiting immediately during %s without another input request',
    async (ending) => {
      vi.useFakeTimers();
      const { core, agent, mode } = await started();
      mode.map = { fileName: 'test.map' };
      await core.getRenderState();
      const inputReads = agent.count(NativeMessageType.InputState);
      const pending = core.getRenderState();
      await flush();
      if (ending === 'stop') await core.stop();
      else agent.onclose?.({});
      expect(await pending).toBeNull();
      expect(agent.count(NativeMessageType.InputState)).toBe(inputReads);
    },
  );

  it.each([false, true])(
    'bounds hidden presentation patches to hidden=%s and restores them on stop',
    async (hidden) => {
      const { core, agent, policyFactory } = setup();
      agent.hidden = hidden;
      const factory = vi.mocked(policyFactory).getMockImplementation()!;
      const prepare = vi.fn((memory: GuestMemory) => {
        memory.write_memory(Uint8Array.of(9), 0x1000);
        return true;
      });
      vi.mocked(policyFactory).mockImplementation((...args) => ({
        ...factory(...args),
        prepareHiddenPresentation: prepare,
      }));
      const pending = core.start();
      agent.hello();
      await pending;
      expect(prepare).toHaveBeenCalledTimes(hidden ? 1 : 0);
      expect(agent.count(NativeMessageType.Batch)).toBe(hidden ? 1 : 0);
      await core.stop();
      const batches = agent.requests.filter((request) => request.type === NativeMessageType.Batch);
      expect(batches).toHaveLength(hidden ? 2 : 0);
      if (hidden) {
        expect([...batches[0]!.payload.slice(12)]).toEqual([7, 9]);
        expect([...batches[1]!.payload.slice(12)]).toEqual([9, 7]);
      }
    },
  );

  it('rejects an unrecognized YR static painter without changing its executable bytes', () => {
    const memory = createGuestMemory();
    const address = 0x615a73;
    const original = Uint8Array.from([0x8a, 0x86, 0xa8, 0, 0, 0, 0x84, 0xc0, 0x0f, 0x84, 0xce, 0, 0, 0]);
    memory.write_memory(original, address);
    memory.bytes[address] ^= 1;
    const mismatched = memory.read_memory(address, original.length).slice();
    expect(prepareYrHiddenPresentation(memory)).toBe(false);
    expect(memory.read_memory(address, original.length)).toEqual(mismatched);
    memory.write_memory(original, address);
    expect(prepareYrHiddenPresentation(memory)).toBe(true);
    expect(memory.read_memory(address, 8)).toEqual(original.slice(0, 8));
    expect(memory.read_memory(address + 8, 6)).toEqual(new Uint8Array(6).fill(0x90));
    expect(prepareYrHiddenPresentation(memory)).toBe(true);
  });

  it('primes genuine cursor metadata before the first fallback picture without suppressing the game cursor', async () => {
    const frames = vi.fn();
    const { core, agent, policyFactory, scheduled } = setup({ onFrame: frames }, { pageCursor: false });
    agent.surface = { width: 2, height: 1, bpp: 16, format: 'RGB565' };
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    const pointer = { frame: 93, x: 1, y: 0, hotspotX: 16, hotspotY: 32 };
    const readPointer = vi.fn(async () => pointer);
    const drawing = vi.fn(() => true);
    vi.mocked(policyFactory).mockImplementation((...args) => ({
      ...factory(...args),
      readPointer,
      setPointerDrawing: drawing,
    }));
    const pending = core.start();
    agent.hello();
    await pending;
    expect(readPointer).toHaveBeenCalledOnce();
    expect(drawing).not.toHaveBeenCalled();
    expect(agent.count(NativeMessageType.Batch)).toBe(0);
    agent.picture(1);
    scheduled.shift()!();
    expect(frames.mock.calls[0]![0].pointer).toEqual(pointer);
    await flush();
    expect(readPointer).toHaveBeenCalledTimes(2);
  });
  it('keeps validated cursor art during uncertain reads and clears software on an authoritative mode exit', async () => {
    const frames = vi.fn();
    const { core, agent, policyFactory, scheduled } = setup({ onFrame: frames }, { pageCursor: false });
    agent.surface = { width: 2, height: 1, bpp: 16, format: 'RGB565' };
    agent.cursorSnapshot = true;
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    const pointer = { frame: 25, x: 1, y: 0, hotspotX: 0, hotspotY: 0 };
    const readPointer = vi.fn(async (): Promise<VmFrame['pointer']> => pointer);
    vi.mocked(policyFactory).mockImplementation((...args) => ({ ...factory(...args), readPointer }));
    const pending = core.start();
    agent.hello();
    await pending;
    const present = async (frame: number) => {
      agent.picture(frame, frame === 1);
      scheduled.shift()!();
      await flush();
      return frames.mock.calls.at(-1)![0] as VmFrame;
    };
    readPointer.mockResolvedValueOnce(undefined);
    await present(1);
    expect((await present(2)).pointer).toEqual(pointer);
    readPointer.mockRejectedValueOnce(new Error('Temporary presentation READ failure'));
    await present(3);
    expect((await present(4)).pointer).toEqual(pointer);
    expect(
      agent.requests.filter(
        (request) =>
          request.type === NativeMessageType.InputState && request.payload.length === 4 && u32(request.payload) === 2,
      ),
    ).toHaveLength(0);
    readPointer.mockResolvedValue(null);
    const rgba = Uint8Array.from([4, 9, 2, 255]);
    agent.cursorPayload = concat(encodeU32(123, 1, 1, 0, 0, 1, 0), rgba);
    await present(5);
    const hardware = await present(6);
    expect(hardware.pointer).toBeNull();
    expect(hardware.cursor?.rgba).toEqual(rgba);
    // A malformed hardware sample preserves hardware only; it cannot revive
    // the previous battlefield software cursor after a confirmed mode exit.
    agent.cursorPayload = new Uint8Array(4);
    const retainedHardware = await present(7);
    expect(retainedHardware.pointer).toBeNull();
    expect(retainedHardware.cursor?.handle).toBe(123);
    agent.cursorPayload = new Uint8Array(28);
    await present(8);
    const hidden = await present(9);
    expect(hidden.pointer).toBeNull();
    expect(hidden.cursor).toBeUndefined();
  });
  it('retains hardware art on correlated capture errors without failing input, then clears confirmed hidden art', async () => {
    const frames = vi.fn(),
      statuses = vi.fn();
    const { core, agent, policyFactory, scheduled } = setup(
      { onFrame: frames, onStatus: statuses },
      { pageCursor: false },
    );
    agent.surface = { width: 2, height: 1, bpp: 16, format: 'RGB565' };
    agent.cursorSnapshot = true;
    const rgba = Uint8Array.from([17, 29, 43, 255]);
    agent.cursorPayload = concat(encodeU32(321, 1, 1, 0, 0, 1, 0), rgba);
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    vi.mocked(policyFactory).mockImplementation((...args) => ({ ...factory(...args), readPointer: async () => null }));
    const pending = core.start();
    agent.hello();
    await pending;
    const present = async (frame: number) => {
      agent.picture(frame, frame === 1);
      scheduled.shift()!();
      await flush();
      return frames.mock.calls.at(-1)![0] as VmFrame;
    };
    expect((await present(1)).cursor?.handle).toBe(321);
    for (const error of ['native cursor capture unavailable', 'native cursor selection changed during capture']) {
      agent.cursorError = error;
      await present(2);
      const retained = await present(3);
      expect(retained.pointer).toBeNull();
      expect(retained.cursor?.handle).toBe(321);
      expect(retained.cursor?.rgba).toEqual(rgba);
      expect(agent.readyState).toBe(1);
      expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'running' });
      const inputs = agent.count(NativeMessageType.Input);
      core.postMessage(0x0201, 1, 1);
      await flush();
      expect(agent.count(NativeMessageType.Input)).toBe(inputs + 1);
    }
    agent.cursorError = null;
    agent.cursorPayload = new Uint8Array(28);
    await present(4);
    const hidden = await present(5);
    expect(hidden.pointer).toBeNull();
    expect(hidden.cursor).toBeUndefined();
  });
  it('coalesces 30000 pointer updates with one input in flight and preserves every event and position barrier', async () => {
    const statuses = vi.fn();
    const { core, agent } = await started({ onStatus: statuses });
    agent.holdInput = true;
    core.setCursorPosition(1, 2);
    const move = (x: number, y: number) => {
      core.setCursorPosition(x, y);
      core.postMessage(0x0200, 0, (y << 16) | x);
    };
    for (let index = 0; index < 30000; index++) move(index % 1200, index % 600);
    core.setKeyState(1, true);
    core.postMessage(0x0201, 1, (599 << 16) | 1199);
    core.setKeyState(1, false);
    core.postMessage(0x0202, 0, (599 << 16) | 1199);
    for (let index = 0; index < 1000; index++) move(index % 300, index % 200);
    core.setKeyState(65, true);
    core.postMessage(0x0100, 65, 1);
    core.setKeyState(65, false);
    core.postMessage(0x0101, 65, 0xc0000001);
    core.postMessage(0x020a, 120 << 16, (199 << 16) | 99);
    expect(agent.pendingInput).toHaveLength(1);
    expect(agent.count(NativeMessageType.Input)).toBe(1);
    const operations: number[][] = [];
    while (agent.pendingInput.length) {
      expect(agent.pendingInput).toHaveLength(1);
      const packet = agent.pendingInput.shift()!;
      operations.push([u32(packet.payload), u32(packet.payload, 4), u32(packet.payload, 8), u32(packet.payload, 12)]);
      agent.emit(packet.type, packet.id);
      await flush();
    }
    expect(operations).toEqual([
      [3, 1, 2, 0],
      [1, 0x0200, 0, (599 << 16) | 1199],
      [2, 1, 1, 0],
      [1, 0x0201, 1, (599 << 16) | 1199],
      [2, 1, 0, 0],
      [1, 0x0202, 0, (599 << 16) | 1199],
      [1, 0x0200, 0, (199 << 16) | 99],
      [2, 65, 1, 0],
      [1, 0x0100, 65, 1],
      [2, 65, 0, 0],
      [1, 0x0101, 65, 0xc0000001],
      [1, 0x020a, 120 << 16, (199 << 16) | 99],
    ]);
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
    expect(agent.closes).toBe(0);
  });
  it('reads menus throughout outstanding and queued position-only input, while keeping click and key barriers', async () => {
    const { core, agent } = setup();
    agent.modal = true;
    agent.menuSnapshot = {
      width: 800,
      height: 600,
      dialogHwnd: 1,
      complete: true,
      moviePlaying: false,
      pointer: { x: 20, y: 30 },
      controls: [],
    };
    const start = core.start();
    agent.hello();
    await start;
    agent.holdInput = true;
    core.setCursorPosition(20, 30);
    for (let index = 0; index < 250; index++) {
      core.setCursorPosition(index, 30);
      core.postMessage(0x0200, 0, (30 << 16) | index);
    }
    expect(await core.getMenuSnapshot()).toEqual(agent.menuSnapshot);
    core.postMessage(0x0201, 1, (30 << 16) | 249);
    expect(await core.getMenuSnapshot()).toBeNull();
    while (agent.pendingInput.length) {
      const packet = agent.pendingInput.shift()!;
      agent.emit(packet.type, packet.id);
      await flush();
    }
    expect(await core.getMenuSnapshot()).toEqual(agent.menuSnapshot);
    core.setKeyState(13, true);
    expect(await core.getMenuSnapshot()).toBeNull();
  });
  it('retains picture-captured strings instead of substituting a later game-memory read', async () => {
    const { core, agent, policyFactory } = setup();
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    const readMenuTexts = vi.fn(async () => new Map<number, string>());
    vi.mocked(policyFactory).mockImplementation((...args) => ({ ...factory(...args), readMenuTexts }));
    agent.modal = true;
    agent.menuSnapshot = {
      generation: 41,
      width: 800,
      height: 600,
      dialogHwnd: 1,
      complete: true,
      moviePlaying: false,
      pointer: { x: 20, y: 30 },
      controls: [],
    };
    const start = core.start();
    agent.hello();
    await start;
    expect(await core.getMenuSnapshot()).toEqual(agent.menuSnapshot);
    expect(readMenuTexts).not.toHaveBeenCalled();
  });
  it('discards a snapshot when a dialog-changing input arrives and is ACKed during its text read', async () => {
    const { core, agent, policyFactory } = setup();
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    let completeTexts!: (texts: Map<number, string>) => void;
    vi.mocked(policyFactory).mockImplementation((...args) => ({
      ...factory(...args),
      readMenuTexts: () =>
        new Promise<Map<number, string>>((resolve) => {
          completeTexts = resolve;
        }),
    }));
    agent.modal = true;
    agent.menuSnapshot = {
      width: 800,
      height: 600,
      dialogHwnd: 1,
      complete: true,
      moviePlaying: false,
      pointer: { x: 20, y: 30 },
      controls: [],
    };
    const start = core.start();
    agent.hello();
    await start;
    const snapshot = core.getMenuSnapshot();
    await flush();
    core.postMessage(0x0202, 0, (30 << 16) | 20);
    await flush();
    completeTexts(new Map());
    expect(await snapshot).toBeNull();
  });
  it('subscribes every discovered house-tail page and waits for its complete applied revision before reading it', async () => {
    const { core, agent, policyFactory } = setup(),
      factory = vi.mocked(policyFactory).getMockImplementation()!,
      source = createGuestMemory(),
      house = 0xd00000;
    let tailsEnabled = false;
    writeU32(source, YG.frame, 20);
    writeU32(source, YG.houses + 4, 0xc00000);
    writeU32(source, YG.houses + 16, 1);
    writeU32(source, 0xc00000, house);
    writeU32(source, house + YO.houseColorScheme, 42);
    vi.mocked(policyFactory).mockImplementation((...args) => {
      const policy = factory(...args),
        memory = args[0],
        discover = createYrNativeHouseTailDiscovery(() => memory.accessor());
      return {
        ...policy,
        ranges: [
          ...policy.ranges,
          { address: 0xa80000, length: 4096 },
          { address: 0xa8e000, length: 4096 },
          { address: 0xc00000, length: 4096 },
        ],
        additionalRanges: () => (tailsEnabled ? discover() : []),
        createRenderReader: () => () => state(tailsEnabled ? memory.accessor().i32(house + YO.houseColorScheme) : 7),
      };
    });
    agent.mirrorOnHook = false;
    const start = core.start();
    agent.hello(true, true);
    await flush();
    agent.mirror(
      20,
      [0x1000, 0xa80000, 0xa8e000, 0xc00000].map((address) => ({ address, bytes: source.read_memory(address, 4096) })),
      2,
      1,
    );
    await start;
    expect((await core.getRenderState())?.frame).toBe(7);
    tailsEnabled = true;
    agent.mirror(20, [], 0, 1);
    let settled = false;
    const pending = core.getRenderState().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(agent.subscriptionRevision).toBe(2);
    expect(core.getMirrorFootprint().ranges.additional).toEqual([{ address: 0xd15000, length: 8192 }]);
    const subscription = agent.requests.filter((request) => request.type === NativeMessageType.Subscribe).at(-1)!;
    const subscribed = Array.from({ length: u32(subscription.payload, 0) }, (_, index) => ({
      address: u32(subscription.payload, 20 + index * 8),
      length: u32(subscription.payload, 24 + index * 8),
    }));
    expect(subscribed).toContainEqual({ address: 0xd15000, length: 8192 });
    agent.mirror(21, [{ address: 0xd15000, bytes: source.read_memory(0xd15000, 4096) }], 0, 1);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(22, [], 1);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(
      23,
      [0xd15000, 0xd16000].map((address) => ({ address, bytes: source.read_memory(address, 4096) })),
      0,
      2,
    );
    expect((await pending)?.frame).toBe(42);
    expect(core.memory.misses).toBe(0);
  });
  it('retires incomplete reader and map page scopes when the game returns to the menu', async () => {
    const { core, agent, policyFactory, mode } = setup(),
      factory = vi.mocked(policyFactory).getMockImplementation()!;
    vi.mocked(policyFactory).mockImplementation((...args) => ({
      ...factory(...args),
      menuSurface: { width: 2, height: 1 },
    }));
    const start = core.start();
    agent.hello();
    await start;
    agent.emit(NativeMessageType.Picture, 0, concat(encodeU32(1, 3, 1, 1, 0, 2), new Uint8Array([3, 0x80])));
    agent.mirror(2, [], 0);
    mode.additionalAddress = 0x2000;
    const first = core.getRenderState();
    await flush();
    agent.mirror(
      3,
      [
        { address: 0x1000, bytes: agent.initial },
        { address: 0x2000, bytes: agent.initial },
      ],
      2,
    );
    expect((await first)?.frame).toBe(7);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const incomplete = core.getRenderState();
    await flush();
    expect(core.getMirrorFootprint().ranges.learned).toEqual([{ address: 0x9000, length: 4096 }]);
    expect(core.getMirrorFootprint().ranges.additional).toEqual([{ address: 0x2000, length: 4096 }]);
    agent.picture(4);
    expect(core.getMirrorFootprint().ranges.learned).toEqual([]);
    expect(core.getMirrorFootprint().ranges.additional).toEqual([]);
    agent.mirror(4, [{ address: 0x1000, bytes: agent.initial }], 2);
    expect(await incomplete).toBeNull();
    await flush();
    const subscription = agent.requests.filter((request) => request.type === NativeMessageType.Subscribe).at(-1)!;
    expect(u32(subscription.payload)).toBe(1);
    expect(u32(subscription.payload, 20)).toBe(0x1000);
  });
  it.each([undefined, false, true].flatMap((capability) => [2, 7].map((reason) => [capability, reason] as const)))(
    'retires learned scopes for a real capacity fault (snapshot %s, reason %s)',
    async (mirrorFaultSnapshot, reason) => {
      const { core, agent, mode } = await started({}, mirrorFaultSnapshot);
      await core.getRenderState();
      mode.missing = true;
      agent.mirror(core.memory.frame ?? 1, []);
      const read = core.getRenderState();
      await flush();
      const pages = [0x1000, 0x9000].map((address) => ({ address, bytes: agent.initial }));
      agent.mirror(2, pages, 2);
      await flush();
      agent.mirror(3, [], 0);
      expect((await read)?.frame).toBe(7);
      expect(core.getMirrorFootprint().pageCounts.learned).toBe(1);
      const diagnosticsBeforeFault = agent.count(NativeMessageType.Diagnostics);
      agent.mirrorFault = { reason, stage: 1, rule: 15, value: 4096, limit: 4096 };
      agent.mirror(4, [], 1);
      await flush();
      const recoveryDiagnostics = agent.requests
        .filter((request) => request.type === NativeMessageType.Diagnostics)
        .slice(diagnosticsBeforeFault);
      expect([...recoveryDiagnostics[0].payload]).toEqual(mirrorFaultSnapshot ? [...encodeU32(1)] : []);
      // A confirmed fault still records the complete recovery diagnostic.
      expect(recoveryDiagnostics.at(-1)!.payload).toHaveLength(0);
      expect(core.getMirrorFootprint().ranges.learned).toEqual([]);
      expect(core.getMirrorFootprint().ranges.subscribed).toEqual([{ address: 0x1000, length: 4096 }]);
      mode.missing = false;
      agent.mirror(5, [{ address: 0x1000, bytes: agent.initial }], 2);
      await flush();
      expect((await core.getRenderState())?.frame).toBe(7);
      expect(agent.closes).toBe(0);
    },
  );
  it('rejects unknown policy discovery without replacing the prior reader result or subscription scope', async () => {
    const { core, agent, policyFactory } = setup(),
      factory = vi.mocked(policyFactory).getMockImplementation()!;
    let unknown = false;
    vi.mocked(policyFactory).mockImplementation((...args) => {
      const policy = factory(...args);
      return {
        ...policy,
        additionalRanges: () => {
          if (unknown) throw new RangeError('Invalid native pointer-table descriptor');
          return policy.additionalRanges?.() ?? [];
        },
      };
    });
    const start = core.start();
    agent.hello();
    await start;
    expect((await core.getRenderState())?.frame).toBe(7);
    const footprint = core.getMirrorFootprint(),
      subscriptions = agent.count(NativeMessageType.Subscribe);
    unknown = true;
    agent.mirror(core.memory.frame ?? 1, []);
    await expect(core.getRenderState()).rejects.toThrow('descriptor');
    expect(core.getMirrorFootprint().ranges).toEqual(footprint.ranges);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(subscriptions);
    agent.mirror(2, [], 1);
    expect(await core.getRenderState()).toBeNull();
    unknown = false;
    agent.mirror(3, [], 0);
    expect((await core.getRenderState())?.frame).toBe(7);
  });
  it('reports a detached copy of the actual subscribed rules rather than a later policy mutation', async () => {
    const { core, agent, policyFactory } = setup(),
      factory = vi.mocked(policyFactory).getMockImplementation()!,
      rule = { kind: 1 as const, source: 0x1000, bytes: 4096, maxCount: 1, stride: 0 };
    vi.mocked(policyFactory).mockImplementation((...args) => ({ ...factory(...args), rules: [rule] }));
    const start = core.start();
    agent.hello();
    await start;
    rule.source = 0x9000;
    const requests = agent.requests.length,
      footprint = core.getMirrorFootprint();
    expect(footprint.rules).toEqual([{ kind: 1, source: 0x1000, bytes: 4096, maxCount: 1, stride: 0 }]);
    footprint.rules[0]!.bytes = 0;
    expect(core.getMirrorFootprint().rules[0]!.bytes).toBe(4096);
    expect(agent.requests).toHaveLength(requests);
  });
  it('audits subscription owners without reading the guest or reporting incomplete demand as current', async () => {
    const { core, agent, mode } = await started();
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const pending = core.getRenderState();
    await flush();
    agent.mirror(
      2,
      [
        { address: 0x1000, bytes: agent.initial },
        { address: 0x9000, bytes: agent.initial },
        { address: 0x2000, bytes: agent.initial },
      ],
      2,
    );
    await flush();
    expect((await pending)?.frame).toBe(7);
    const fresh = new Uint8Array(NATIVE_PAGE_SIZE);
    fresh[0] = 42;
    agent.mirror(3, [{ address: 0x9000, bytes: fresh }]);
    expect((await core.getRenderState())?.frame).toBe(42);
    const requests = agent.requests.length,
      reads = core.memory.operationRanges,
      footprint = core.getMirrorFootprint();
    expect(footprint.pageLimit).toBe(4096);
    expect(footprint.pageCounts).toEqual({
      fixed: 1,
      additional: 0,
      learned: 1,
      baseUnion: 1,
      requestedSeedUnion: 2,
      subscribed: 2,
      lastPublishedMirror: 3,
      knownPublishedOutsideSubscribed: 1,
    });
    expect(footprint.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'render',
          accessedPages: 2,
          learnedPages: 1,
          exclusiveLearnedOutsideBase: 1,
          readerCached: true,
        }),
      ]),
    );
    footprint.ranges.subscribed[0]!.address = 0;
    footprint.mirror.ranges.length = 0;
    footprint.owners[0]!.learnedPages = 999;
    expect(core.getMirrorFootprint().pageCounts).toEqual({
      fixed: 1,
      additional: 0,
      learned: 1,
      baseUnion: 1,
      requestedSeedUnion: 2,
      subscribed: 2,
      lastPublishedMirror: 3,
      knownPublishedOutsideSubscribed: 1,
    });
    expect(core.memory.operationRanges).toEqual(reads);
    expect(agent.requests).toHaveLength(requests);
    agent.mirror(4, [], 1);
    expect(core.getMirrorFootprint().mirror).toMatchObject({
      complete: false,
      lastPublishedFrame: 3,
      lastFlags: 1,
      currentFollowDemand: 'unknown',
    });
    expect(core.getMirrorFootprint().pageCounts.lastPublishedMirror).toBe(3);
    expect(core.getMirrorFootprint().pageCounts.learned).toBe(1);
  });
  it('negotiates page-removal deltas only when hello advertises support', async () => {
    for (const supported of [undefined, false, true]) {
      const { core, agent } = setup();
      const start = core.start();
      agent.hello(true, supported);
      await start;
      const subscription = agent.requests.find((request) => request.type === NativeMessageType.Subscribe)!;
      expect(u32(subscription.payload, 16)).toBe(supported ? 0x80000000 : 0);
      expect(u32(subscription.payload, 12)).toBe(4000);
    }
  });
  it('requests a second mirror credit only with its explicit revision-capable host capability', async () => {
    for (const [mirrorWindow, revisioned, expected] of [
      [undefined, true, 0x80000000],
      [1, true, 0x80000000],
      [2, false, 0],
      [2, true, 0xc0000000],
    ] as const) {
      const { core, agent } = setup();
      agent.mirrorWindow = mirrorWindow;
      const start = core.start();
      agent.hello(true, revisioned);
      await start;
      const subscription = agent.requests.find((request) => request.type === NativeMessageType.Subscribe)!;
      expect(u32(subscription.payload, 16)).toBe(expected);
      expect(u32(subscription.payload, 8)).toBe(4096);
      expect(u32(subscription.payload, 12)).toBe(4000);
    }
  });
  it('uses the larger bootstrap budget only when advertised by the agent', async () => {
    for (const [advertised, expected] of [
      [8000, 8000],
      [20000, 12000],
    ]) {
      const { core, agent } = setup();
      const start = core.start();
      agent.hello(true, true, advertised);
      await start;
      const subscription = agent.requests.find((request) => request.type === NativeMessageType.Subscribe)!;
      expect(u32(subscription.payload, 12)).toBe(expected);
    }
  });
  it('waits for the applied subscription revision rather than an older in-flight delta or a reset', async () => {
    const { core, agent, mode } = setup();
    const start = core.start();
    agent.hello(true, true);
    await start;
    expect((await core.getRenderState())?.frame).toBe(7);
    const old = new Uint8Array(NATIVE_PAGE_SIZE);
    old[0] = 9;
    agent.mirror(2, [{ address: 0x9000, bytes: old }]);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    mode.additionalAddress = 0x9000;
    let settled = false;
    const pending = core.getRenderState().then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(agent.subscriptionRevision).toBe(2);
    agent.mirror(3, [], 0, 1);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(4, [], 1);
    await flush();
    expect(settled).toBe(false);
    const fresh = new Uint8Array(NATIVE_PAGE_SIZE);
    fresh[0] = 42;
    agent.mirror(5, [{ address: 0x9000, bytes: fresh }], 0, 2);
    expect((await pending)?.frame).toBe(42);
    expect(core.memory.misses).toBe(0);
  });
  it('keeps reset-based subscriptions when revision negotiation is unavailable', async () => {
    const { core, agent } = setup();
    const start = core.start();
    agent.hello(true, true, undefined, false);
    await start;
    const subscription = agent.requests.find((request) => request.type === NativeMessageType.Subscribe)!;
    expect(u32(subscription.payload, 16)).toBe(0);
  });
  it('keeps unrequested native draw observation disabled even when the host supports it', async () => {
    const { core, agent } = setup();
    agent.drawJournal = true;
    const start = core.start();
    agent.hello();
    await start;
    expect(agent.requests.find((request) => request.type === NativeMessageType.Credit)?.payload).toEqual(encodeU32(1));
  });
  it.each([false, true])(
    'forwards an atomic journal and native fallback with menu identity %s',
    async (menuIdentity) => {
      const frames = vi.fn();
      const { core, agent, scheduled } = setup({ onFrame: frames }, { drawJournal: true });
      agent.drawJournal = true;
      agent.menuIdentity = menuIdentity;
      const start = core.start();
      agent.hello();
      await start;
      expect(agent.requests.find((request) => request.type === NativeMessageType.Credit)?.payload).toEqual(
        encodeU32(menuIdentity ? 0x80000001 : 1, 1),
      );
      const commands = json([
        { kind: 'rect', x: 0, y: 0, width: 1, height: 1, colour: 0x7e0, clip: { x: 0, y: 0, width: 2, height: 1 } },
      ]);
      agent.emit(
        NativeMessageType.Picture,
        0,
        concat(
          encodeU32(80, 2, 1, 1, 0, 2),
          new Uint8Array([2, 0x80]),
          ...(menuIdentity ? [encodeU32(0x314e454d, 9)] : []),
          encodeU32(0x314a564f, 32 + commands.length + 4, 2, 7, 2, 1, 1, commands.length),
          commands,
          new Uint8Array([0, 0, 1, 0]),
        ),
      );
      scheduled.shift()!();
      const frame = frames.mock.calls[0]![0] as VmFrame;
      expect(frame).toMatchObject({ matchGeneration: 2, drawGeneration: 7 });
      expect(frame.menuGeneration).toBe(menuIdentity ? 9 : undefined);
      expect([...frame.rgb565!]).toEqual([0xf81f, 0xf81f]);
      expect([...frame.overlayJournal!.cleanRgb565]).toEqual([0, 1]);
      agent.picture(81, false);
      scheduled.shift()!();
      expect(frames.mock.calls[1]![0].overlayJournal).toBeUndefined();
      expect(frames.mock.calls[1]![0].menuGeneration).toBeUndefined();
    },
  );
  it('attaches pictures and protocol input at a menu, then prepares readers only from a real battle mirror', async () => {
    const statuses = vi.fn(),
      frames = vi.fn();
    const { core, agent, policyFactory, renderFactory, scheduled } = setup({ onStatus: statuses, onFrame: frames });
    agent.modal = true;
    agent.threadId = 0;
    agent.mirrorOnHook = false;
    const start = core.start();
    agent.hello();
    await start;
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'running' });
    expect(core.memory.complete).toBe(false);
    expect(policyFactory).toHaveBeenCalledTimes(1);
    expect(renderFactory).not.toHaveBeenCalled();
    expect(agent.count(NativeMessageType.Diagnostics)).toBe(0);
    expect(agent.count(NativeMessageType.Credit)).toBe(1);
    agent.picture(0);
    scheduled.shift()!();
    expect(frames).toHaveBeenCalledOnce();
    core.setCursorPosition(10, 20);
    core.postMessage(0x201, 1, 0x0014000a);
    await flush();
    expect(agent.count(NativeMessageType.Input)).toBe(2);
    expect(await core.getRenderState()).toBeNull();
    expect(await core.getCommandState()).toBeNull();
    expect(await core.getGamePerformance()).toBeNull();
    expect(await core.setGameSpeedFlag(1)).toBeNull();
    expect(await core.setTacticalPassthrough(1)).toBe(false);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      mirrorComplete: false,
      awaitingLogicMirror: true,
      lastReaderError: null,
    });
    agent.modal = false;
    expect(await core.getRenderState()).toBeNull();
    expect(renderFactory).not.toHaveBeenCalled();
    agent.threadId = 77;
    agent.mirror(100, [{ address: 0x1000, bytes: agent.initial }], 2);
    expect((await core.getRenderState())?.frame).toBe(7);
    expect(policyFactory).toHaveBeenLastCalledWith(
      core.memory,
      {
        gameThreadId: 77,
        verifiedNativeHook: { site: 0x2000, original: [1, 2], patched: [3, 4] },
      },
      'a'.repeat(64),
    );
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      mirrorComplete: true,
      awaitingLogicMirror: false,
    });
    expect(agent.count(NativeMessageType.Read)).toBe(0);
    expect(agent.closes).toBe(0);
  });
  it('publishes only preparation hints before a battle mirror without unblocking battle readers', async () => {
    const { core, agent, policyFactory, renderFactory } = setup();
    agent.modal = true;
    agent.threadId = 0;
    agent.mirrorOnHook = false;
    const hint = { map: { fileName: 'EARLY.MAP' }, theater: null, houses: null, localHouse: null };
    const readRenderPreparation = vi.fn(async () => hint);
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    vi.mocked(policyFactory).mockImplementation((...args) => ({ ...factory(...args), readRenderPreparation }));
    const start = core.start();
    agent.hello();
    await start;
    expect(await core.getRenderPreparation()).toBe(hint);
    expect(readRenderPreparation).toHaveBeenCalledOnce();
    expect(core.memory.complete).toBe(false);
    expect(await core.getRenderState()).toBeNull();
    expect(renderFactory).not.toHaveBeenCalled();
    await core.stop();
    expect(await core.getRenderPreparation()).toBeNull();
  });
  it('rejects unverified logic-owner metadata after menu warm-up instead of publishing a reader result', async () => {
    const { core, agent, renderFactory } = setup();
    agent.modal = true;
    agent.threadId = 0;
    agent.mirrorOnHook = false;
    const start = core.start();
    agent.hello();
    await start;
    agent.modal = false;
    agent.mirror(100, [{ address: 0x1000, bytes: agent.initial }], 2);
    await expect(core.getRenderState()).rejects.toThrow('logic thread has not been observed');
    expect(renderFactory).not.toHaveBeenCalled();
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    const diagnostics = core.getDiagnostics('sample');
    await expect(diagnostics).rejects.toThrow('logic thread has not been observed');
    expect(renderFactory).not.toHaveBeenCalled();
    expect(agent.count(NativeMessageType.Read)).toBe(0);
  });
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
  it('negotiates menu identity independently of requested and supported draw capture', async () => {
    for (const menuIdentity of [false, true])
      for (const drawSupported of [false, true])
        for (const drawRequested of [false, true]) {
          const { core, agent } = setup({}, { drawJournal: drawRequested });
          agent.menuIdentity = menuIdentity;
          agent.drawJournal = drawSupported;
          const start = core.start();
          agent.hello();
          await start;
          core.requestNextFrame();
          const credit = agent.requests.find((request) => request.type === NativeMessageType.Credit)!;
          const count = menuIdentity ? 0x80000001 : 1;
          expect(credit.payload).toEqual(drawSupported && drawRequested ? encodeU32(count, 1) : encodeU32(count));
          await core.stop();
        }
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
  it('withholds the previous render result when an optional reader swallows repeated typed misses', async () => {
    const { core, agent, mode, renderFactory } = await started();
    const good = await core.getRenderState();
    expect(good?.frame).toBe(7);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const retry = core.getRenderState();
    for (let frame = 2; frame < 14; frame++) {
      await flush();
      agent.mirror(frame, [{ address: 0x1000, bytes: agent.initial }], frame === 2 ? 2 : 0);
    }
    expect(await retry).toBeNull();
    expect(renderFactory.mock.calls.length).toBeGreaterThan(1);
    expect(agent.count(NativeMessageType.Read)).toBe(0);
    expect(core.memory.misses).toBeGreaterThan(0);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
  });
  it.each([1, 2])(
    'retries a strict miss from the admitted publication at frame %i without another mirror',
    async (frame) => {
      const { core, agent, mode, renderFactory } = setup();
      const start = core.start();
      agent.hello(true, true);
      await start;
      await core.getRenderState();
      mode.missing = true;
      agent.mirror(1, []);
      let settled = false;
      const pending = core.getRenderState().then((result) => {
        settled = true;
        return result;
      });
      await flush();
      expect(agent.subscriptionRevision).toBe(2);
      const added = new Uint8Array(NATIVE_PAGE_SIZE);
      added[0] = 42;
      agent.mirror(frame, [{ address: 0x9000, bytes: added }], 0, 2);
      await flush();
      expect(settled).toBe(true);
      expect((await pending)?.frame).toBe(42);
      expect(renderFactory.mock.calls.length).toBeGreaterThan(1);
      expect(agent.count(NativeMessageType.Read)).toBe(0);
    },
  );
  it('keeps waiting when a strict-miss subscription is unchanged and no newer complete image exists', async () => {
    const { core, agent, mode } = setup();
    const start = core.start();
    agent.hello(true, true);
    await start;
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(1, []);
    const first = core.getRenderState();
    await flush();
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    agent.mirror(2, [{ address: 0x9000, bytes: added }], 0, 2);
    await first;
    // The reset removes the page while the requested subscription membership stays the same.
    agent.mirror(3, [{ address: 0x1000, bytes: agent.initial }], 2, 2);
    let settled = false;
    const pending = core.getRenderState().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(agent.subscriptionRevision).toBe(2);
    expect(settled).toBe(false);
    agent.mirror(4, [{ address: 0x9000, bytes: added }], 0, 2);
    expect((await pending)?.frame).toBe(42);
  });
  it('does not retry a strict miss from an old revision or incomplete admission image', async () => {
    const { core, agent, mode } = setup();
    const start = core.start();
    agent.hello(true, true);
    await start;
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(1, []);
    let settled = false;
    const pending = core.getRenderState().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    agent.mirror(2, [{ address: 0x9000, bytes: added }], 0, 1);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(3, [], 1);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(4, [{ address: 0x9000, bytes: added }], 0, 2);
    await flush();
    expect(settled).toBe(true);
    expect((await pending)?.frame).toBe(42);
  });
  it('cancels a strict-miss retry when admission arrives in a new reader epoch', async () => {
    const { core, agent, mode } = setup();
    const start = core.start();
    agent.hello(true, true);
    await start;
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(1, []);
    const pending = core.getRenderState();
    await flush();
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    // A game-frame rollback invalidates reader ownership before the admission continuation runs.
    agent.mirror(0, [{ address: 0x9000, bytes: added }], 0, 2);
    expect(await pending).toBeNull();
  });
  it('rejects a strict-miss retry when disconnect follows complete image application', async () => {
    let disconnectOnFrame = false;
    const { core, agent, mode } = setup({
      onLogicFrame: () => {
        if (disconnectOnFrame) agent.onclose?.({});
      },
    });
    const start = core.start();
    agent.hello(true, true);
    await start;
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(1, []);
    const pending = core.getRenderState();
    const rejected = expect(pending).rejects.toThrow('closed');
    await flush();
    disconnectOnFrame = true;
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    agent.mirror(2, [{ address: 0x9000, bytes: added }], 0, 2);
    await rejected;
    expect(await core.getRenderState()).toBeNull();
  });
  it('recreates a swallowed-miss reader only after a later complete mirror supplies the page', async () => {
    const { core, agent, mode, renderFactory } = await started();
    await core.getRenderState();
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    let settled = false;
    const retry = core.getRenderState().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    const added = new Uint8Array(NATIVE_PAGE_SIZE);
    added[0] = 42;
    // A complete legacy delta is not the subscription's required reset barrier.
    agent.mirror(2, [{ address: 0x9000, bytes: added }], 0);
    await flush();
    expect(settled).toBe(false);
    agent.mirror(
      3,
      [
        { address: 0x1000, bytes: agent.initial },
        { address: 0x9000, bytes: added },
      ],
      2,
    );
    await flush();
    expect(settled).toBe(true);
    expect((await retry)?.frame).toBe(42);
    expect(renderFactory.mock.calls.length).toBeGreaterThan(1);
    expect(agent.count(NativeMessageType.Read)).toBe(0);
  });
  it('rejects an in-progress reader on disconnect and ceases publishing stale state', async () => {
    const statuses = vi.fn();
    const { core, agent, mode } = await started({ onStatus: statuses });
    expect((await core.getRenderState())?.frame).toBe(7);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const retry = core.getRenderState();
    const rejected = expect(retry).rejects.toThrow('closed');
    await flush();
    agent.onclose?.({});
    await rejected;
    expect(await core.getRenderState()).toBeNull();
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'error' });
    expect(agent.closes).toBe(1);
  });
  it('reports normal exit from the already established authenticated response without another request', async () => {
    for (const closingInput of [false, true]) {
      const statuses = vi.fn();
      const fetchStatus = vi.fn().mockResolvedValue(
        Response.json(
          { state: 'closed' },
          {
            headers: { 'X-Native-Session-Wait': 'terminal' },
          },
        ),
      );
      vi.stubGlobal('fetch', fetchStatus);
      const { core, agent } = setup(
        { onStatus: statuses },
        { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
      );
      const start = core.start();
      await flush();
      agent.hello();
      await start;
      if (closingInput) {
        agent.readyState = 2;
        core.setCursorPosition(12, 34);
      } else agent.onclose?.({});
      await flush();
      expect(fetchStatus).toHaveBeenCalledExactlyOnceWith(
        new URL('http://127.0.0.1:15451/__native/session?wait=terminal'),
        expect.objectContaining({ headers: { Authorization: `Bearer ${'a'.repeat(32)}` }, redirect: 'error' }),
      );
      expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'exited', detail: '游戏已关闭' });
      expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
      expect(await core.getRenderState()).toBeNull();
    }
  });
  it('opens native transport only after terminal response headers and waits for its body without a deadline', async () => {
    let establish!: (response: Response) => void;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetchStatus = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          establish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchStatus);
    const statuses = vi.fn();
    const { core, agent } = setup(
      { onStatus: statuses },
      { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
    );
    const start = core.start();
    await flush();
    expect(agent.onmessage).toBeNull();
    establish(
      new Response(
        new ReadableStream({
          start(controller) {
            body = controller;
          },
        }),
        {
          headers: { 'X-Native-Session-Wait': 'terminal' },
        },
      ),
    );
    await flush();
    agent.hello();
    await start;
    agent.onclose?.({});
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: 'running',
      notice: '游戏连接已中断，正在确认游戏是否已关闭。',
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60000);
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
    body.enqueue(new TextEncoder().encode(JSON.stringify({ state: 'closed' })));
    body.close();
    vi.useRealTimers();
    await flush();
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'exited' });
    expect(fetchStatus).toHaveBeenCalledOnce();
  });
  it('does not overwrite confirmed closure with a startup error when reopening before hello', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { state: 'closed' },
          {
            headers: { 'X-Native-Session-Wait': 'terminal' },
          },
        ),
      ),
    );
    const statuses = vi.fn();
    const { core, agent } = setup(
      { onStatus: statuses },
      { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
    );
    const start = core.start();
    await flush();
    agent.onerror?.({});
    await start;
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'exited' });
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
  });
  it('keeps a failed terminal body as a transport error and aborts the observer on explicit stop', async () => {
    for (const state of ['failed', 'invalid']) {
      let signal!: AbortSignal;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url, options) => {
          signal = options.signal;
          return Promise.resolve(Response.json({ state }, { headers: { 'X-Native-Session-Wait': 'terminal' } }));
        }),
      );
      const statuses = vi.fn();
      const { core, agent } = setup(
        { onStatus: statuses },
        { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
      );
      const start = core.start();
      await flush();
      agent.hello();
      await start;
      agent.onerror?.({});
      await flush();
      expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'error', detail: 'Native WebSocket error' });
      expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('exited');
      expect(signal.aborted).toBe(true);
    }
  });
  it('does not revive a pending transport failure after explicit cancellation, including before hello', async () => {
    for (const beforeHello of [false, true]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url, options) =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  options.signal.addEventListener('abort', () => controller.error(new Error('cancelled')));
                },
              }),
              { headers: { 'X-Native-Session-Wait': 'terminal' } },
            ),
          ),
        ),
      );
      const statuses = vi.fn();
      const { core, agent } = setup(
        { onStatus: statuses },
        { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
      );
      const start = core.start();
      await flush();
      if (!beforeHello) {
        agent.hello();
        await start;
      }
      const cancelledStart = beforeHello ? expect(start).rejects.toThrow('closed') : Promise.resolve();
      agent.onclose?.({});
      await core.stop().catch(() => undefined);
      await cancelledStart;
      await flush();
      expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
      expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'stopped' });
    }
  });
  it('lets confirmed closure win when a frozen hello timeout runs before socket close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { state: 'closed' },
          {
            headers: { 'X-Native-Session-Wait': 'terminal' },
          },
        ),
      ),
    );
    vi.useFakeTimers();
    const statuses = vi.fn();
    const { core } = setup({ onStatus: statuses }, { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' });
    const start = core.start();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await start;
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'exited' });
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
  });
  it('does not open native transport when the terminal observer cannot be established', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    const { core, agent } = setup({}, { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' });
    await expect(core.start()).rejects.toThrow('关闭通知');
    expect(agent.onmessage).toBeNull();
  });
  it('hides HD state while a native modal owns the surface', async () => {
    const { core, agent } = await started();
    expect((await core.getRenderState())?.frame).toBe(7);
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    agent.modal = false;
    expect((await core.getRenderState())?.frame).toBe(7);
    // A disabled transition dialog owns painting before it accepts input.
    agent.menuVisible = true;
    expect(await core.getRenderState()).toBeNull();
    agent.menuVisible = false;
    expect((await core.getRenderState())?.frame).toBe(7);
  });
  it('requires a new battle mirror after menu return even when the next counter is larger', async () => {
    const { core, agent, policyFactory, mode } = setup();
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    vi.mocked(policyFactory).mockImplementation((...args) => ({
      ...factory(...args),
      menuSurface: { width: 2, height: 1 },
      createCommandReader: () => () => ({
        frame: args[0].frame!,
        localHouse: 0,
        view: null,
        objects: [],
        lastEvent: null,
        sidebar: null,
      }),
    }));
    const start = core.start();
    agent.hello();
    await start;
    const picture = (width: number) =>
      agent.emit(NativeMessageType.Picture, 0, concat(encodeU32(1, width, 1, 1, 0, 2), new Uint8Array([width, 0x80])));
    picture(3);
    agent.mirror(2, [], 0);
    expect((await core.getRenderState())?.frame).toBe(7);
    expect((await core.getCommandState())?.frame).toBe(2);
    // An in-game modal retains the current match and resumes immediately.
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    agent.modal = false;
    expect((await core.getRenderState())?.frame).toBe(7);
    picture(2);
    expect(await core.getRenderState()).toBeNull();
    expect(await core.getCommandState()).toBeNull();
    // A final publication received while the menu owns the surface cannot authorize a later match.
    agent.mirror(3, [], 0);
    picture(3);
    expect(await core.getRenderState()).toBeNull();
    expect(await core.getCommandState()).toBeNull();
    const next = agent.initial.slice();
    next[0] = 9;
    agent.mirror(100, [{ address: 0x1000, bytes: next }]);
    expect((await core.getRenderState())?.frame).toBe(9);
    expect((await core.getCommandState())?.frame).toBe(100);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const oldRead = core.getRenderState();
    await flush();
    picture(2);
    mode.missing = false;
    agent.mirror(101, [], 0);
    expect(await oldRead).toBeNull();
    expect(await core.getRenderState()).toBeNull();
  });
  it('attaches during a real-film signal without a logic mirror and forwards only playback transitions', async () => {
    const playback = vi.fn();
    const { core, agent } = setup({ onMoviePlayback: playback });
    agent.moviePlaying = true;
    agent.mirrorOnHook = false;
    const start = core.start();
    agent.hello();
    await start;
    expect(await core.getRenderState()).toBeNull();
    expect(await core.getCommandState()).toBeNull();
    expect(playback.mock.calls).toEqual([[true]]);
    // A menu's animated background is also Bink, but its dialog owns Escape.
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    expect(playback.mock.calls).toEqual([[true], [false]]);
    agent.modal = false;
    await core.getCommandState();
    expect(playback.mock.calls).toEqual([[true], [false], [true]]);
    agent.moviePlaying = false;
    agent.mirror(1, [{ address: 0x1000, bytes: agent.initial }], 2);
    expect((await core.getRenderState())?.frame).toBe(7);
    await core.getCommandState();
    expect(playback.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
  it('requests lightweight modal checks for frequent readers and accepts legacy full-metadata replies', async () => {
    const { core, agent } = await started();
    const startup = agent.requests.filter((request) => request.type === NativeMessageType.InputState);
    expect(startup).toHaveLength(1);
    expect(startup[0]!.payload).toEqual(new Uint8Array());
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    expect(await core.getCommandState()).toBeNull();
    const frequent = agent.requests.filter((request) => request.type === NativeMessageType.InputState).slice(1);
    expect(frequent.map((request) => request.payload)).toEqual([encodeU32(1), encodeU32(1)]);
    agent.modal = false;
    expect((await core.getRenderState())?.frame).toBe(7);
  });
  it('refreshes newly requested policy scope even when an older cached page can satisfy the read', async () => {
    const { core, agent, mode } = await started();
    const old = new Uint8Array(NATIVE_PAGE_SIZE);
    old[0] = 9;
    agent.mirror(2, [{ address: 0x9000, bytes: old }]);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
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
  it('withholds the previous reader result and reports why when the fresh mirror times out', async () => {
    const { core, agent, mode } = await started();
    const good = await core.getRenderState();
    expect(good?.frame).toBe(7);
    vi.useFakeTimers();
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const pending = core.getRenderState();
    await flush();
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
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
  it('resumes after an invalid-mirror recovery wait expires while retaining the transport exit handshake', async () => {
    let terminal!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              terminal = controller;
            },
          }),
          { headers: { 'X-Native-Session-Wait': 'terminal' } },
        ),
      ),
    );
    const statuses = vi.fn();
    const { core, agent } = setup(
      { onStatus: statuses },
      { sessionStatusUrl: 'http://127.0.0.1:15451/__native/session' },
    );
    const start = core.start();
    await flush();
    agent.hello(true, true);
    await start;
    expect((await core.getRenderState())?.frame).toBe(7);
    vi.useFakeTimers();
    agent.mirror(2, [], 4);
    await flush();
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      lastReaderError: expect.stringContaining('No complete native mirror'),
    });
    const fresh = agent.initial.slice();
    fresh[0] = 42;
    agent.mirror(3, [{ address: 0x1000, bytes: fresh }], 2);
    expect((await core.getRenderState())?.frame).toBe(42);
    const inputs = agent.count(NativeMessageType.Input);
    core.setKeyState(65, true);
    await flush();
    expect(agent.count(NativeMessageType.Input)).toBe(inputs + 1);
    expect(agent.closes).toBe(0);
    agent.onclose?.({});
    await flush();
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'running' });
    terminal.enqueue(json({ state: 'closed' }));
    terminal.close();
    await flush();
    expect(statuses.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'exited', detail: '游戏已关闭' });
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
  });
  it('retires a poisoned learned range, preserves live input/pictures, and accepts the replacement delta', async () => {
    vi.useFakeTimers();
    const statuses = vi.fn(),
      frames = vi.fn();
    const { core, agent, mode, scheduled } = setup({ onStatus: statuses, onFrame: frames });
    const start = core.start();
    agent.hello(true, true);
    await start;
    expect((await core.getRenderState())?.frame).toBe(7);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const read = core.getRenderState();
    await flush();
    expect(core.getMirrorFootprint().ranges.learned).toEqual([{ address: 0x9000, length: 4096 }]);
    agent.mirrorFault = { reason: 3, stage: 2, rule: 12, value: 4096, limit: 4096, address: 0x9000 };
    agent.mirror(2, [], 4);
    await flush();
    expect(await read).toBeNull();
    expect(core.getMirrorFootprint().ranges.learned).toEqual([]);
    expect(await core.getRenderState()).toBeNull();
    core.postMessage(0x100, 27);
    agent.picture(2);
    scheduled.shift()!();
    await flush();
    expect(agent.count(NativeMessageType.Input)).toBe(1);
    expect(frames).toHaveBeenCalledOnce();
    mode.missing = false;
    // Revision-capable hosts retain the accepted base pages and send only changed/removed pages.
    agent.mirror(3, [], 0);
    await flush();
    expect((await core.getRenderState())?.frame).toBe(7);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({
      mirrorRecovery: {
        count: 1,
        rebuilding: false,
        events: [
          expect.objectContaining({
            reason: 'invalid-range',
            fault: agent.mirrorFault,
            learnedOwners: [{ name: 'render', ranges: [{ address: 0x9000, length: 4096 }] }],
            resumedAtEpochMs: expect.any(Number),
          }),
        ],
      },
    });
    const usage = (await core.getDiagnostics('usage')).native?.mirrorRecovery as {
      count: number;
      omitted: number;
      events: Record<string, unknown>[];
    };
    expect(usage).toMatchObject({
      count: 1,
      omitted: 0,
      events: [
        {
          reason: 'invalid-range',
          retiredPageCount: 1,
          retiredRangeCount: 1,
          faultOwners: ['render'],
          fault: agent.mirrorFault,
        },
      ],
    });
    expect(usage.events[0]).not.toHaveProperty('learned');
    expect(usage.events[0]).not.toHaveProperty('learnedOwners');
    expect(agent.closes).toBe(0);
    expect(statuses.mock.calls.map(([status]) => status.phase)).not.toContain('error');
  });
  it('rebuilds again after more than three invalid ranges without terminating the native game', async () => {
    vi.useFakeTimers();
    const { core, agent } = await started();
    for (let index = 0; index < 5; index++) {
      agent.mirror(index * 2 + 2, [], 4);
      await flush();
      agent.mirror(index * 2 + 3, [{ address: 0x1000, bytes: agent.initial }], 2);
      await flush();
      core.setKeyState(65, !!(index % 2));
      await vi.advanceTimersByTimeAsync(1001);
    }
    expect(agent.count(NativeMessageType.Subscribe)).toBe(6);
    expect(agent.count(NativeMessageType.Input)).toBe(5);
    expect(agent.closes).toBe(0);
    expect((await core.getDiagnostics('sample')).native).toMatchObject({ mirrorRecovery: { count: 5 } });
  });
  it('expires an unchanged complete state within a second while a real modal pauses the watchdog', async () => {
    vi.useFakeTimers();
    const { core, agent } = await started();
    expect((await core.getRenderState())?.frame).toBe(7);
    agent.modal = true;
    expect(await core.getRenderState()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(1);
    agent.modal = false;
    expect((await core.getRenderState())?.frame).toBe(7);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await core.getRenderState()).toBeNull();
    await flush();
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
    agent.mirror(2, [{ address: 0x1000, bytes: agent.initial }], 2);
    await flush();
    expect((await core.getRenderState())?.frame).toBe(7);
  });
  it('refreshes modal ownership before rebuilding a stalled battle and during an existing recovery', async () => {
    vi.useFakeTimers();
    const { core, agent } = await started();
    expect((await core.getRenderState())?.frame).toBe(7);
    await vi.advanceTimersByTimeAsync(500);
    expect((await core.getRenderState())?.frame).toBe(7);
    const inputReads = agent.count(NativeMessageType.InputState);
    // The game reaches a score dialog while the hidden page receives no new picture or render poll.
    agent.modal = true;
    await vi.advanceTimersByTimeAsync(501);
    expect(agent.count(NativeMessageType.InputState)).toBeGreaterThan(inputReads);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(1);
    expect((await core.getDiagnostics('usage')).native).toMatchObject({ mirrorRecovery: { count: 0 } });

    // A genuine invalid range still starts recovery, but must not block newer modal observations.
    agent.mirror(2, [], 4);
    await flush();
    const recoveryInputReads = agent.count(NativeMessageType.InputState);
    expect(await core.getRenderState()).toBeNull();
    expect(agent.count(NativeMessageType.InputState)).toBe(recoveryInputReads + 1);
    agent.modal = false;
    agent.mirror(3, [{ address: 0x1000, bytes: agent.initial }], 2);
    await flush();
    expect((await core.getRenderState())?.frame).toBe(7);
    expect(agent.count(NativeMessageType.Subscribe)).toBe(2);
  });
  it('restores original drawing while an HD reader is waiting for an unavailable mirror', async () => {
    const { core, agent, mode, policyFactory } = setup({}, { renderPassthrough: true });
    const factory = vi.mocked(policyFactory).getMockImplementation()!;
    const setFlags = vi.fn((_memory: GuestMemory, _flags: number) => true);
    vi.mocked(policyFactory).mockImplementation((...args) => ({
      ...factory(...args),
      installPassthrough: () => ({
        supported: 7,
        keyRgb565: 0xf81f,
        configAddress: 0x1000,
        set: setFlags,
        read: () => ({ flags: 0, applied: 0, counters: {} }),
      }),
    }));
    const start = core.start();
    agent.hello();
    await start;
    expect(await core.setTacticalPassthrough(7)).toBe(true);
    mode.missing = true;
    agent.mirror(core.memory.frame ?? 1, []);
    const read = core.getRenderState();
    await flush();
    agent.mirror(2, [], 1);
    expect(core.memory.complete).toBe(false);
    expect(await core.setTacticalPassthrough(0)).toBe(true);
    expect(setFlags.mock.calls.at(-1)?.[1]).toBe(0);
    agent.mirror(3, [], 4);
    await flush();
    expect(await read).toBeNull();
    agent.mirror(4, [{ address: 0x1000, bytes: agent.initial }], 2);
    await flush();
  });
  describe('battlefield repaint after attaching', () => {
    function withControl(options: Partial<NativeCoreOptions>) {
      const test = setup({}, options);
      const factory = vi.mocked(test.policyFactory).getMockImplementation()!;
      const setFlags = vi.fn((_memory: GuestMemory, _flags: number) => true);
      const repaintCalls = vi.fn((_memory: GuestMemory) => true);
      const install = vi.fn(() => ({
        supported: 7,
        keyRgb565: 0xf81f,
        configAddress: 0x1000,
        set: setFlags,
        repaint: repaintCalls,
        read: () => ({ flags: 0, applied: 0, counters: {} }),
      }));
      vi.mocked(test.policyFactory).mockImplementation((...args) => ({
        ...factory(...args),
        installPassthrough: install,
      }));
      return { ...test, setFlags, repaint: repaintCalls, install };
    }
    const battle = { name: 'test' } as unknown as GameRenderState['map'];

    it('asks a running match once per connection to repaint what a previous client may have left stale', async () => {
      const { core, agent, mode, setFlags, repaint, install } = withControl({ renderPassthrough: true });
      mode.map = battle;
      const start = core.start();
      agent.hello();
      await start;
      await flush();
      // Attached to a complete image: requested at once, before the first HD state read.
      expect(install).toHaveBeenCalledOnce();
      expect(repaint).toHaveBeenCalledOnce();
      // No category is switched on and the original picture keeps every pixel the game draws.
      expect(setFlags).not.toHaveBeenCalled();
      expect((await core.getDiagnostics('sample')).native).toMatchObject({
        battlefieldRepaint: { state: 'done', requestedAtEpochMs: expect.any(Number) },
      });
      expect((await core.getRenderState())?.map).toBe(battle);
      const next = agent.initial.slice();
      next[0] = 8;
      agent.mirror(2, [{ address: 0x1000, bytes: next }]);
      await core.getRenderState();
      await flush();
      expect(repaint).toHaveBeenCalledOnce();
      // The installed gates serve the HD view's later requests without a second installation.
      expect(await core.setTacticalPassthrough(7)).toBe(true);
      expect(install).toHaveBeenCalledOnce();
      expect(setFlags.mock.calls.at(-1)?.[1]).toBe(7);
    });

    it('waits for a complete image when attached at a menu, then asks at the first battlefield', async () => {
      const { core, agent, mode, repaint, install } = withControl({ renderPassthrough: true });
      agent.modal = true;
      agent.threadId = 0;
      agent.mirrorOnHook = false;
      const start = core.start();
      agent.hello();
      await start;
      await flush();
      expect(core.memory.complete).toBe(false);
      expect(install).not.toHaveBeenCalled();
      agent.modal = false;
      agent.threadId = 77;
      mode.map = battle;
      agent.mirror(100, [{ address: 0x1000, bytes: agent.initial }], 2);
      expect((await core.getRenderState())?.map).toBe(battle);
      await flush();
      expect(install).toHaveBeenCalledOnce();
      expect(repaint).toHaveBeenCalledOnce();
    });

    it('leaves the game untouched without passthrough support and does not retry an executable it cannot patch', async () => {
      const plain = withControl({});
      plain.mode.map = battle;
      const start = plain.core.start();
      plain.agent.hello();
      await start;
      await plain.core.getRenderState();
      await flush();
      expect(plain.install).not.toHaveBeenCalled();

      const unpatched = withControl({ renderPassthrough: true });
      unpatched.install.mockReturnValue(null as never);
      unpatched.mode.map = battle;
      const second = unpatched.core.start();
      unpatched.agent.hello();
      await second;
      await unpatched.core.getRenderState();
      await flush();
      const next = unpatched.agent.initial.slice();
      next[0] = 8;
      unpatched.agent.mirror(2, [{ address: 0x1000, bytes: next }]);
      await unpatched.core.getRenderState();
      await flush();
      expect(unpatched.install).toHaveBeenCalledOnce();
      expect(unpatched.repaint).not.toHaveBeenCalled();
    });
  });
});
