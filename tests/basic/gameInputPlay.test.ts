import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installGameInput,
  type GameInputObservation,
  type GameInputOptions,
  type InstalledGameInput,
} from '../../src/ui/pages/game/gameInput';
import { installFullscreenKeyboardLock } from '../../src/ui/pages/game/keyboardLock';
import type { VmShell } from '../../src/adapter/runtime';

/** Play fixes of the input path: where Shift + click is repeated, ⌘ as the game's Ctrl on Apple keyboards, observers. */
let installed: InstalledGameInput | undefined;
afterEach(() => {
  installed?.cleanup();
  installed = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const WM = { keydown: 0x100, keyup: 0x101, ldown: 0x201, lup: 0x202, rdown: 0x204 };

function setup(options: GameInputOptions, platform: 'mac' | 'windows' = 'windows') {
  vi.useFakeTimers();
  const canvas = Object.assign(new EventTarget(), {
    style: { setProperty: vi.fn(), getPropertyValue: () => '', getPropertyPriority: () => '', removeProperty: vi.fn() },
    tabIndex: 0,
    parentElement: null,
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
    requestPointerLock: vi.fn().mockResolvedValue(undefined),
  });
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    activeElement: canvas,
    fullscreenElement: null,
    hidden: false,
    createElement: () => ({ remove: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } }),
    exitPointerLock: vi.fn(),
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' }, setTimeout, clearTimeout }));
  vi.stubGlobal(
    'navigator',
    platform === 'mac' ? { platform: 'MacIntel', userAgent: 'Macintosh' } : { platform: 'Win32', userAgent: 'Windows' },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const vm = { setCursorPosition: vi.fn(), postMessage: vi.fn(), setKeyState: vi.fn() };
  installed = installGameInput(
    canvas as unknown as HTMLCanvasElement,
    vm as unknown as VmShell,
    false,
    undefined,
    () => ({ width: 1280, height: 800 }),
    options,
  );
  const pointer = (type: string, fields: Record<string, number | boolean> = {}) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), {
        pointerType: 'mouse',
        isPrimary: true,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: 400,
        clientY: 300,
        movementX: 0,
        movementY: 0,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        ...fields,
      }),
    );
  const key = (type: 'keydown' | 'keyup', code: string, fields: Record<string, boolean | string> = {}) =>
    window.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), {
        code,
        key: code.startsWith('Digit') ? code.slice(5) : code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
        location: 0,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...fields,
      }),
    );
  const messages = (message: number) => vm.postMessage.mock.calls.filter((call) => call[0] === message);
  return { vm, pointer, key, messages };
}

const strip = (x: number, _y: number, frame: { width: number }) => x >= frame.width - 168;

describe('Shift + left click', () => {
  it('reaches the tactical view as one click that carries Shift', () => {
    const h = setup({ shiftClickRepeat: strip });
    h.pointer('pointerdown', { shiftKey: true });
    h.pointer('pointerup', { shiftKey: true });
    vi.advanceTimersByTime(1000);
    expect(h.messages(WM.ldown)).toHaveLength(1);
    expect(h.messages(WM.lup)).toHaveLength(1);
    // MK_SHIFT (4) and MK_LBUTTON (1) on the press.
    expect(h.messages(WM.ldown)[0]![1] & 0x0005).toBe(0x0005);
  });

  it('is still repeated ten times without Shift on the build bar', () => {
    const h = setup({ shiftClickRepeat: strip });
    h.pointer('pointerdown', { shiftKey: true, clientX: 1200 });
    vi.advanceTimersByTime(1000);
    h.pointer('pointerup', { shiftKey: true, clientX: 1200 });
    expect(h.messages(WM.ldown)).toHaveLength(10);
    expect(h.messages(WM.ldown).every((call) => (call[1] & 0x0004) === 0)).toBe(true);
  });

  it('keeps the old behaviour everywhere when the game names no region', () => {
    const h = setup({});
    h.pointer('pointerdown', { shiftKey: true });
    vi.advanceTimersByTime(1000);
    expect(h.messages(WM.ldown)).toHaveLength(10);
  });
});

describe('⌘ as the game Ctrl on Apple keyboards', () => {
  it('forwards ⌘ as Ctrl and releases keys pressed with it, because macOS sends no keyup for them', () => {
    const h = setup({ metaAsControl: true }, 'mac');
    h.key('keydown', 'MetaLeft', { metaKey: true });
    expect(h.messages(WM.keydown).map((call) => call[1])).toEqual([0x11]);
    expect(h.vm.setKeyState).toHaveBeenCalledWith(0x11, true);
    h.key('keydown', 'Digit1', { metaKey: true });
    expect(h.messages(WM.keydown).map((call) => call[1])).toEqual([0x11, 0x31]);
    expect(h.messages(WM.keyup)).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(h.messages(WM.keyup).map((call) => call[1])).toEqual([0x31]);
    // Pressed again while ⌘ is still down: a fresh press, not an auto-repeat.
    h.key('keydown', 'Digit1', { metaKey: true });
    expect(h.messages(WM.keydown)).toHaveLength(3);
    expect((h.messages(WM.keydown)[2]![2] >>> 30) & 1).toBe(0);
    vi.advanceTimersByTime(100);
    h.key('keyup', 'MetaLeft');
    expect(h.messages(WM.keyup).map((call) => call[1])).toEqual([0x31, 0x31, 0x11]);
    expect(h.vm.setKeyState).toHaveBeenLastCalledWith(0x11, false);
  });

  it('carries Ctrl on a ⌘ + click and leaves a real secondary click alone', () => {
    const h = setup({ metaAsControl: true }, 'mac');
    h.key('keydown', 'MetaLeft', { metaKey: true });
    h.pointer('pointerdown', { metaKey: true });
    // MK_CONTROL (8) with the left button.
    expect(h.messages(WM.ldown)[0]![1] & 0x0009).toBe(0x0009);
    h.pointer('pointerup', { metaKey: true });
    h.pointer('pointerdown', { metaKey: true, button: 2, buttons: 2 });
    expect(h.messages(WM.rdown)).toHaveLength(1);
  });

  it('synthesizes Ctrl for a ⌘ + click when ⌘ went down before the game had the keyboard', () => {
    const h = setup({ metaAsControl: true }, 'mac');
    h.pointer('pointerdown', { metaKey: true });
    expect(h.messages(WM.keydown).map((call) => call[1])).toEqual([0x11]);
    expect(h.messages(WM.ldown)[0]![1] & 0x0008).toBe(0x0008);
  });

  it('still restores Control + primary button, which macOS reports as a secondary click', () => {
    const h = setup({ metaAsControl: true }, 'mac');
    h.key('keydown', 'ControlLeft', { ctrlKey: true });
    h.pointer('pointerdown', { ctrlKey: true, button: 2, buttons: 2 });
    expect(h.messages(WM.ldown)).toHaveLength(1);
    expect(h.messages(WM.rdown)).toHaveLength(0);
  });

  it('does nothing on other platforms or when switched off', () => {
    for (const [options, platform] of [
      [{ metaAsControl: true }, 'windows'],
      [{ metaAsControl: false }, 'mac'],
    ] as const) {
      const h = setup(options, platform);
      h.key('keydown', 'MetaLeft', { metaKey: true });
      expect(h.messages(WM.keydown).map((call) => call[1])).toEqual([0x5b]);
      installed?.cleanup();
      installed = undefined;
    }
  });
});

describe('input observers', () => {
  it('report forwarded keys and buttons with the modifiers the game sees, and cannot break delivery', () => {
    const seen: GameInputObservation[] = [];
    const h = setup(
      {
        metaAsControl: true,
        observe: (observation) => {
          seen.push(observation);
          throw new Error('observer bug');
        },
      },
      'mac',
    );
    h.key('keydown', 'MetaLeft', { metaKey: true });
    h.key('keydown', 'Digit1', { metaKey: true });
    h.key('keydown', 'Digit1', { metaKey: true }); // held: not reported twice
    h.pointer('pointerdown', { metaKey: true, clientX: 500, clientY: 250 });
    h.pointer('pointerup', { metaKey: true, clientX: 520, clientY: 260 });
    expect(seen).toEqual([
      { type: 'keydown', code: 'Digit1', ctrl: true, alt: false, shift: false },
      { type: 'pointerdown', code: 'Mouse0', ctrl: true, alt: false, shift: false, x: 500, y: 250 },
      { type: 'pointerup', code: 'Mouse0', ctrl: true, alt: false, shift: false, x: 520, y: 260 },
    ]);
    expect(h.messages(WM.ldown)).toHaveLength(1);
  });
});

describe('fullscreen keyboard lock keys', () => {
  it('asks for every key when no list is given, and for the list otherwise', async () => {
    for (const [keys, expected] of [
      [null, []],
      [['Escape'], [['Escape']]],
    ] as const) {
      const canvas = {} as HTMLCanvasElement;
      const doc = Object.assign(new EventTarget(), { fullscreenElement: { contains: () => true } });
      vi.stubGlobal('document', doc);
      const keyboard = { lock: vi.fn().mockResolvedValue(undefined), unlock: vi.fn() };
      vi.stubGlobal('navigator', { keyboard });
      const stop = installFullscreenKeyboardLock(canvas, vi.fn(), keys);
      await Promise.resolve();
      expect(keyboard.lock.mock.calls[0]).toEqual(expected);
      stop();
    }
  });
});
