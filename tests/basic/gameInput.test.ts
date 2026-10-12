import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installGameInput,
  setSessionShortcutKey,
  type GameInputOptions,
  type InstalledGameInput,
} from '../../src/ui/pages/game/gameInput';
import type { VmShell } from '../../src/adapter/runtime';

let installed: InstalledGameInput | undefined;
afterEach(() => {
  installed?.cleanup();
  installed = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(search = '', locked = true, options: GameInputOptions = {}) {
  const hints: {
    textContent?: string;
    remove: ReturnType<typeof vi.fn>;
    classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  }[] = [];
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    tabIndex: 0,
    parentElement: null,
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    requestPointerLock: vi.fn().mockResolvedValue(undefined),
  });
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: locked ? canvas : null,
    activeElement: canvas,
    fullscreenElement: null,
    hidden: false,
    createElement: () => {
      const hint = { remove: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } };
      hints.push(hint);
      return hint;
    },
    exitPointerLock: vi.fn(),
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search }, setTimeout }));
  vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const vm = { setCursorPosition: vi.fn(), postMessage: vi.fn(), setKeyState: vi.fn() };
  const present = vi.fn();
  installed = installGameInput(
    canvas as unknown as HTMLCanvasElement,
    vm as unknown as VmShell,
    true,
    present,
    undefined,
    options,
  );
  const pointer = (type: string, fields: Record<string, number> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: 400,
      clientY: 300,
      movementX: 0,
      movementY: 0,
      ctrlKey: false,
      shiftKey: false,
      ...fields,
    });
    canvas.dispatchEvent(event);
  };
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { canvas, doc, vm, present, pointer, frames, flush, hints };
}

describe('桌面鼠标跟手性', () => {
  it('explains escape once for the page, across relocking and reinstalling game input', () => {
    const h = setup('', false);
    expect(h.hints[0]!.classList.add).not.toHaveBeenCalled();
    h.doc.pointerLockElement = h.canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(h.hints[0]!.textContent).toContain('Esc');
    expect(h.hints[0]!.classList.add).toHaveBeenCalledOnce();
    h.doc.pointerLockElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    h.doc.pointerLockElement = h.canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(h.hints[0]!.classList.add).toHaveBeenCalledOnce();
    installed!.cleanup();
    installed = installGameInput(h.canvas as unknown as HTMLCanvasElement, h.vm as unknown as VmShell);
    expect(h.hints[1]!.classList.add).not.toHaveBeenCalled();
  });

  it('waits for fullscreen keyboard-lock permission before explaining the actual escape gesture', async () => {
    const h = setup('', false);
    let grant!: () => void;
    const keyboard = { lock: vi.fn(() => new Promise<void>((resolve) => (grant = resolve))), unlock: vi.fn() };
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows', keyboard });
    installed!.cleanup();
    Object.assign(h.doc, { fullscreenElement: { contains: () => true }, pointerLockElement: h.canvas });
    installed = installGameInput(h.canvas as unknown as HTMLCanvasElement, h.vm as unknown as VmShell);
    expect(h.hints[1]!.classList.add).not.toHaveBeenCalled();
    grant();
    await Promise.resolve();
    expect(h.hints[1]!.textContent).toContain('Esc');
    expect(h.hints[1]!.classList.add).toHaveBeenCalledOnce();
  });

  it('keeps page cursor CSS ownership when web absolute input is installed after a warm frame', () => {
    const h = setup('', false);
    installed!.cleanup();
    const setProperty = vi.fn();
    Object.assign(h.canvas.style, {
      getPropertyValue: () => 'none',
      getPropertyPriority: () => 'important',
      setProperty,
    });
    installed = installGameInput(
      h.canvas as unknown as HTMLCanvasElement,
      h.vm as unknown as VmShell,
      false,
      h.present,
      () => ({ width: 800, height: 600 }),
      { pageOwnsCursor: true },
    );
    expect(setProperty).not.toHaveBeenCalled();
    h.pointer('pointerdown', { clientX: 27, clientY: 21 });
    expect(installed.pointerPosition()).toEqual({ x: 27, y: 21 });
    installed.cleanup();
    expect(setProperty).not.toHaveBeenCalled();
  });
  it('publishes detached read-only local coordinates before a coalesced guest move, with absolute/locked and resize support', () => {
    const h = setup('', false);
    expect(installed!.pointerPosition()).toBeNull();
    h.pointer('pointermove', { clientX: 120, clientY: 140 });
    expect(installed!.pointerPosition()).toEqual({ x: 120, y: 140 });
    const position = installed!.pointerPosition() as { x: number; y: number };
    position.x = 1;
    expect(installed!.pointerPosition()?.x).toBe(120);
    h.doc.pointerLockElement = h.canvas;
    h.pointer('pointermove', { movementX: 9, movementY: 11 });
    expect(installed!.pointerPosition()).toEqual({ x: 129, y: 151 });
    expect(h.vm.setCursorPosition).toHaveBeenLastCalledWith(120, 140);
    const events = h.vm.postMessage.mock.calls.length;
    installed!.pointerPosition();
    expect(h.vm.postMessage).toHaveBeenCalledTimes(events);
    installed!.adaptResolution(1600, 1200);
    expect(installed!.pointerPosition()).toEqual({ x: 258, y: 302 });
    installed!.cleanup();
    expect(installed!.pointerPosition()).toBeNull();
  });
  it.each(['blur-first', 'unlock-first', 'unlock-only'])('失焦/隐藏/解锁不伪造 Esc：%s', (order) => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    const blur = () => {
      window.dispatchEvent(new Event('blur'));
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    };
    if (order === 'blur-first') blur();
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    if (order === 'unlock-first') blur();
    vi.advanceTimersByTime(1000);
    expect(vm.postMessage).not.toHaveBeenCalled();
    expect(vm.setKeyState).not.toHaveBeenCalled();
  });

  it('真实 Esc 只转发一组 DOWN/UP，随后解锁不补发', () => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    for (const type of ['keydown', 'keyup']) {
      window.dispatchEvent(
        Object.assign(new Event(type, { cancelable: true }), {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          altKey: false,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
        }),
      );
    }
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    vi.advanceTimersByTime(1000);
    expect(
      vm.postMessage.mock.calls
        .filter(([message]) => message === 0x100 || message === 0x101)
        .map(([message, key]) => [message, key]),
    ).toEqual([
      [0x100, 27],
      [0x101, 27],
    ]);
  });
  it('a key reserved for a session shortcut stays with the page and returns to the game when released', () => {
    const { vm } = setup();
    const press = () => {
      for (const type of ['keydown', 'keyup']) {
        window.dispatchEvent(
          Object.assign(new Event(type, { cancelable: true }), {
            key: '\\',
            code: 'Backslash',
            keyCode: 220,
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
            repeat: false,
            isComposing: false,
          }),
        );
      }
    };
    const keyMessages = () =>
      vm.postMessage.mock.calls
        .filter(([message]) => message === 0x100 || message === 0x101)
        .map(([m, key]) => [m, key]);
    try {
      setSessionShortcutKey('\\', true);
      press();
      expect(keyMessages()).toEqual([]);
      setSessionShortcutKey('\\', false);
      press();
      expect(keyMessages()).toEqual([
        [0x100, 220],
        [0x101, 220],
      ]);
    } finally {
      setSessionShortcutKey('\\', false);
    }
  });

  it('首个移动立即到达 VM，同帧后续位移合并且不丢距离', () => {
    const { vm, present, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 3, movementY: 2 });
    expect(present).toHaveBeenLastCalledWith(403, 302, true);
    expect(vm.postMessage).toHaveBeenCalledExactlyOnceWith(0x200, 0, (302 << 16) | 403);
    pointer('pointermove', { movementX: 4, movementY: -1 });
    expect(present).toHaveBeenLastCalledWith(407, 301, true);
    expect(frames.size).toBe(1);
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    flush();
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(407, 301);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (301 << 16) | 407);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
    expect(present.mock.calls).toEqual([
      [400, 300, true], // Adopt the lock already acquired by the startup gesture.
      [403, 302, true],
      [407, 301, true],
    ]); // The flush neither presents twice nor rolls back the cursor.
  });

  it('单次移动不在帧尾重复投递，下一帧的首个移动仍立即发送', () => {
    const { vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 1 });
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointermove', { movementX: 1 });
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (300 << 16) | 402);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
  });

  it('千次高频移动只发送首尾两次，点击前冲刷尾部', () => {
    const { vm, pointer, flush } = setup();
    for (let i = 0; i < 1000; i++) pointer('pointermove', { movementX: i % 2 ? -1 : 1 });
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointerdown', { buttons: 1 });
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x200, 0x201]);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x201, 1, (300 << 16) | 400);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('点击前先冲刷移动消息，保留 MOVE/DOWN/UP 的顺序', () => {
    const { vm, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x201, 0x202]);
    expect(vm.postMessage.mock.calls.every(([, , point]) => point === ((300 << 16) | 410))).toBe(true);
    expect(frames.size).toBe(0);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('键盘按下和释放先冲刷最新移动，不让键盘事件越过尚未执行的鼠标帧', () => {
    const { vm, pointer, frames, flush } = setup();
    const key = (type: string) =>
      window.dispatchEvent(
        Object.assign(new Event(type, { cancelable: true }), {
          code: 'KeyA',
          key: 'a',
          location: 0,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        }),
      );
    pointer('pointermove', { movementX: 1 });
    pointer('pointermove', { movementX: 2 });
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    key('keydown');
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x200, 0x100, 0x102]);
    expect(vm.postMessage.mock.calls[1]).toEqual([0x200, 0, (300 << 16) | 403]);
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(403, 300);
    pointer('pointermove', { movementX: 3 });
    pointer('pointermove', { movementX: 4 });
    key('keyup');
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([
      0x200, 0x200, 0x100, 0x102, 0x200, 0x200, 0x101,
    ]);
    expect(vm.postMessage.mock.calls[5]).toEqual([0x200, 0, (300 << 16) | 410]);
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(410, 300);
    expect(frames.size).toBe(0);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(7);
  });

  it('失焦后取消尚未投递的移动', () => {
    const { canvas, vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    vm.postMessage.mockClear();
    pointer('pointermove', { movementX: 10 });
    canvas.dispatchEvent(new Event('blur'));
    flush();
    expect(vm.postMessage).not.toHaveBeenCalled();
  });

  it('keeps a locked drag held at all four edges and through capture loss', () => {
    const { canvas, vm, present, pointer, flush } = setup();
    pointer('pointerdown', { buttons: 1 });
    for (const [movementX, movementY, x, y] of [
      [-2000, 0, 0, 300],
      [2000, 0, 799, 300],
      [0, -2000, 799, 0],
      [0, 2000, 799, 599],
    ]) {
      pointer('pointermove', { movementX: movementX!, movementY: movementY!, buttons: 1 });
      flush();
      expect(present).toHaveBeenLastCalledWith(x, y, true);
      expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 1, (y! << 16) | x!);
      canvas.dispatchEvent(new Event('lostpointercapture'));
      expect(vm.postMessage.mock.calls.filter(([message]) => message === 0x202)).toHaveLength(0);
    }
    pointer('pointerup');
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x202, 0, (599 << 16) | 799);
  });

  it('a confirmed menu releases the held button before releasing confinement', () => {
    const { doc, vm, pointer, flush } = setup();
    pointer('pointerdown', { buttons: 1 });
    pointer('pointermove', { movementX: 10, buttons: 1 });
    installed!.releasePointerLock();
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x202, 0, (300 << 16) | 410);
    expect(doc.exitPointerLock).toHaveBeenCalledOnce();
    const count = vm.postMessage.mock.calls.length;
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(count);
  });

  it('keeps menu presses absolute, then acquires confinement after a complete battle click', () => {
    let inBattle = false;
    const { canvas, vm, pointer } = setup('', false, { canLockPointer: () => inBattle });
    pointer('pointerdown', { clientX: 55, clientY: 66, buttons: 1 });
    pointer('pointerup', { clientX: 55, clientY: 66 });
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x202, 0, (66 << 16) | 55);
    inBattle = true;
    pointer('pointerdown', { buttons: 1 });
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    pointer('pointerup');
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
  });

  it('locks after a web menu click but immediately on a battle drag after Esc', async () => {
    let inBattle = false;
    const { canvas, doc, vm, pointer } = setup('', false, { lockPointerOnDown: () => inBattle });
    pointer('pointerdown', { buttons: 1 });
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    pointer('pointerup');
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
    await Promise.resolve();
    doc.pointerLockElement = canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    doc.pointerLockElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    inBattle = true;
    pointer('pointerdown', { buttons: 1 });
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(2);
    inBattle = false;
    pointer('pointercancel', { buttons: 1 });
    expect(vm.postMessage.mock.calls.filter(([message]) => message === 0x202)).toHaveLength(1);
    window.dispatchEvent(
      Object.assign(new Event('mouseup'), { button: 0, buttons: 0, ctrlKey: false, shiftKey: false }),
    );
    expect(vm.postMessage.mock.calls.filter(([message]) => message === 0x202)).toHaveLength(2);
  });

  it('does not leave a late granted lock behind after the input owner was destroyed', async () => {
    const { canvas, doc, pointer } = setup('', false);
    let grant!: () => void;
    canvas.requestPointerLock.mockImplementation(() => new Promise<void>((resolve) => (grant = resolve)));
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    installed!.cleanup();
    doc.pointerLockElement = canvas;
    grant();
    await Promise.resolve();
    expect(doc.exitPointerLock).toHaveBeenCalledOnce();
  });

  it('confines the first native battle drag on DOWN and preserves its UP through the lock transition', async () => {
    const { canvas, doc, vm, pointer, flush } = setup('', false, {
      canLockPointer: () => true,
      lockPointerOnDown: () => true,
    });
    let grant!: () => void;
    canvas.requestPointerLock.mockImplementation(() => new Promise<void>((resolve) => (grant = resolve)));
    pointer('pointerdown', { buttons: 1 });
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
    expect(canvas.setPointerCapture).not.toHaveBeenCalled();
    canvas.dispatchEvent(new Event('lostpointercapture'));
    pointer('pointercancel', { buttons: 1 });
    expect(vm.postMessage.mock.calls.filter(([message]) => message === 0x202)).toHaveLength(0);
    doc.pointerLockElement = canvas;
    grant();
    await Promise.resolve();
    pointer('pointermove', { movementX: -2000, buttons: 1 });
    flush();
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 1, 300 << 16);
    const mouseUp = () =>
      window.dispatchEvent(
        Object.assign(new Event('mouseup'), {
          button: 0,
          buttons: 0,
          movementX: 0,
          movementY: 0,
          ctrlKey: false,
          shiftKey: false,
        }),
      );
    mouseUp();
    pointer('pointerup');
    mouseUp();
    expect(vm.postMessage.mock.calls.filter(([message]) => message === 0x202)).toEqual([[0x202, 0, 300 << 16]]);
  });

  it.each(['', '?raw-mouse=0', '?raw-mouse=1'])('Windows 锁定沿用系统调整，原始计数须显式开启：%s', (search) => {
    const { canvas, pointer } = setup(search, false);
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(canvas.requestPointerLock).toHaveBeenCalledExactlyOnceWith(
      search === '?raw-mouse=1' ? { unadjustedMovement: true } : undefined,
    );
  });
});
