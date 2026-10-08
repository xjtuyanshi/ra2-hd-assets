import { describe, expect, it, vi } from 'vitest';
import { createNativeCursorFrames } from '../../../src/ui/pages/game/nativeCursorFrames';
import type { VmFrame } from '../../../src/vm86/win32';

function fixture(initialValue = '', initialPriority = '') {
  let value = initialValue,
    priority = initialPriority,
    released = false;
  const style = {
    getPropertyValue: () => value,
    getPropertyPriority: () => priority,
    setProperty: vi.fn((_name: string, next: string, nextPriority = '') => {
      value = next;
      priority = nextPriority;
    }),
    removeProperty: vi.fn(() => {
      value = '';
      priority = '';
    }),
  };
  let pageCursor: { update(frame: VmFrame): void } | null = null;
  const presentCursor = vi.fn();
  const controller = createNativeCursorFrames({
    screen: { style } as unknown as HTMLCanvasElement,
    pageCursor: () => pageCursor,
    presentCursor,
    isReleased: () => released,
  });
  const frame: VmFrame = {
    width: 800,
    height: 600,
    pixels: new Uint8Array(),
    palette: new Uint8Array(),
    pointer: null,
    cursor: {
      handle: 123,
      width: 1,
      height: 1,
      hotspotX: 0,
      hotspotY: 0,
      x: 40,
      y: 50,
      rgba: Uint8Array.from([3, 5, 7, 255]),
    },
  };
  return {
    style,
    controller,
    presentCursor,
    frame,
    cursorStyle: () => ({ value, priority }),
    pageCursor: (next: typeof pageCursor) => (pageCursor = next),
    release: () => (released = true),
  };
}

describe('native cursor frame session ownership', () => {
  it.each([
    ['', ''],
    ['crosshair', 'important'],
  ])('restores the previous fallback CSS value and priority (%s, %s)', (value, priority) => {
    const f = fixture(value, priority);
    f.controller.onFrame(f.frame);
    expect(f.cursorStyle()).toEqual({ value: 'none', priority: 'important' });
    expect(f.presentCursor).toHaveBeenLastCalledWith(40, 50, true);
    expect(f.frame.cursor?.handle).toBe(123);
    f.controller.onFrame({ ...f.frame, cursor: undefined });
    expect(f.presentCursor).toHaveBeenLastCalledWith(0, 0, false);
    f.controller.dispose();
    expect(f.cursorStyle()).toEqual({ value, priority });
    const writes = f.style.setProperty.mock.calls.length;
    f.controller.dispose();
    f.controller.onFrame(f.frame);
    expect(f.style.setProperty).toHaveBeenCalledTimes(writes);
  });

  it('does not reacquire CSS from a late frame between overlay release and VM destruction', () => {
    const f = fixture('crosshair');
    const update = vi.fn();
    f.pageCursor({ update });
    f.controller.onFrame(f.frame);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0]).not.toBe(f.frame);
    expect(update.mock.calls[0]![0].cursor?.rgba).toEqual(Uint8Array.from([3, 5, 7, 255]));
    expect(f.frame.cursor).toBeUndefined();
    f.release();
    f.pageCursor(null);
    f.controller.onFrame(f.frame);
    expect(f.style.setProperty).not.toHaveBeenCalled();
    expect(f.presentCursor).not.toHaveBeenCalled();
    expect(f.cursorStyle()).toEqual({ value: 'crosshair', priority: '' });
    f.controller.dispose();
    expect(f.style.removeProperty).not.toHaveBeenCalled();
  });

  it('leaves legacy/emulator frames and unowned CSS untouched', () => {
    const f = fixture('default');
    const { pointer: _pointer, ...legacy } = f.frame;
    f.controller.onFrame(legacy);
    f.controller.dispose();
    expect(f.style.setProperty).not.toHaveBeenCalled();
    expect(f.style.removeProperty).not.toHaveBeenCalled();
    expect(f.presentCursor).not.toHaveBeenCalled();
    expect(legacy.cursor?.handle).toBe(123);
  });
});
