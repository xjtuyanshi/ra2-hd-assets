import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeCursor } from '../../../src/ui/pages/game/nativeCursor';
import { currentCanvasRect } from '../../../src/ui/pages/game/gameInput';
import type { VmFrame } from '../../../src/vm86/win32';

const active: { destroy(): void }[] = [];
afterEach(() => {
  for (const cursor of active.splice(0)) cursor.destroy();
  vi.unstubAllGlobals();
});
function setup(scale = 1) {
  let box = { left: 10, top: 20, width: 1600, height: 900 };
  const values = new Map([['cursor', 'crosshair']]),
    priorities = new Map([['cursor', 'important']]);
  const screen = Object.assign(new EventTarget(), {
    style: {
      getPropertyValue: (name: string) => values.get(name) ?? '',
      getPropertyPriority: (name: string) => priorities.get(name) ?? '',
      setProperty: (name: string, value: string, priority: string) => {
        values.set(name, value);
        priorities.set(name, priority);
      },
      removeProperty: (name: string) => values.delete(name),
    },
    parentElement: { appendChild: vi.fn() },
    getBoundingClientRect: vi.fn(() => box),
  });
  const ctx = {
    imageSmoothingEnabled: true,
    drawImage: vi.fn(),
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: vi.fn(),
  };
  const overlay = { style: {} as Record<string, string>, width: 0, height: 0, getContext: () => ctx, remove: vi.fn() };
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    hidden: false,
    createElement: () => overlay,
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', new EventTarget());
  let resize: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const bitmap = { width: 110 * scale, height: 43 * scale, close: vi.fn() };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('.json')
        ? {
            ok: true,
            json: async () => ({
              version: 1,
              scale,
              frames: [
                { x: 0, y: 0, width: 55 * scale, height: 43 * scale },
                { x: 55 * scale, y: 0, width: 55 * scale, height: 43 * scale },
              ],
            }),
          }
        : { ok: true, blob: async () => new Blob() },
    ),
  );
  const pointer = (type: string, x = 500, y = 320) =>
    screen.dispatchEvent(Object.assign(new Event(type), { pointerType: 'mouse', clientX: x, clientY: y }));
  const frame: VmFrame = {
    width: 800,
    height: 600,
    pixels: new Uint8Array(),
    palette: new Uint8Array(),
    pointer: { frame: 1, x: 0, y: 0, hotspotX: 27, hotspotY: 21 },
  };
  return {
    screen,
    ctx,
    overlay,
    doc,
    bitmap,
    values,
    priorities,
    pointer,
    frame,
    disconnect,
    resize: (next: typeof box) => {
      box = next;
      resize();
    },
  };
}

describe('native page cursor presentation ownership', () => {
  it('retains a startup lock position through the first frame and a resized page without another move', async () => {
    const f = setup();
    f.doc.pointerLockElement = f.screen;
    const cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
    active.push(cursor);
    cursor.position(400, 300, true);
    cursor.update(f.frame);
    expect(f.overlay.style.display).toBe('block');
    expect(f.overlay.style.transform).toBe('translate(756px, 438.5px)');
    f.resize({ left: 0, top: 0, width: 2000, height: 1500 });
    expect(f.overlay.style.transform).toBe('translate(932.5px, 697.5px)');
    f.pointer('pointerleave');
    expect(f.overlay.style.display).toBe('block');
  });

  it.each([1, 2])(
    'places a %sx atlas at its unchanged hotspot and logical size, including the clipped edge',
    async (scale) => {
      const f = setup(scale),
        cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
      active.push(cursor);
      expect(f.values.get('cursor')).toBe('none');
      cursor.update(f.frame);
      f.pointer('pointermove');
      expect(f.overlay.style.transform).toBe('translate(446px, 288.5px)');
      expect(f.overlay.style.width).toBe('110px');
      expect(f.overlay.style.height).toBe('64.5px');
      expect([f.overlay.width, f.overlay.height]).toEqual([55 * scale, 43 * scale]);
      f.pointer('pointerdown', 10, 20);
      expect(f.overlay.style.transform).toBe('translate(-44px, -11.5px)');
      expect(f.overlay.style.clipPath).toBe('inset(31.5px 0px 0px 54px)');
      expect(f.ctx.drawImage).toHaveBeenCalledOnce();
    },
  );

  it('uses the actual hardware cursor RGBA and hotspot instead of a stock arrow', async () => {
    const f = setup(),
      cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
    active.push(cursor);
    const rgba = Uint8Array.from([4, 9, 2, 255, 0, 0, 0, 0]);
    cursor.update({
      ...f.frame,
      pointer: null,
      cursor: { handle: 123, width: 2, height: 1, hotspotX: 1, hotspotY: 0, x: 0, y: 0, rgba },
    });
    f.pointer('pointermove');
    expect([...f.ctx.putImageData.mock.calls[0]![0].data]).toEqual([...rgba]);
    expect(f.overlay.style.transform).toBe('translate(498px, 320px)');
    expect(f.ctx.drawImage).not.toHaveBeenCalled();
  });

  it('updates the exact hotspot after observed resizing without reading layout on each pointer event', async () => {
    const f = setup(),
      cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
    active.push(cursor);
    cursor.update(f.frame);
    f.pointer('pointermove', 464, 320);
    expect(f.overlay.style.transform).toBe('translate(410px, 288.5px)');
    f.resize({ left: 10, top: 20, width: 800, height: 600 });
    f.pointer('pointermove', 464, 320);
    expect(f.overlay.style.transform).toBe('translate(437px, 299px)');
    expect(f.overlay.style.width).toBe('55px');
    expect(f.overlay.style.height).toBe('43px');
    for (let index = 0; index < 256; index++) f.pointer('pointermove', 464 + index, 320);
    expect(f.screen.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });

  it('isolates cached geometry between canvases', () => {
    const f = setup(),
      second = {
        getBoundingClientRect: vi.fn(() => ({ left: 123, top: 456, width: 800, height: 600 })),
      } as unknown as HTMLCanvasElement;
    expect(currentCanvasRect(f.screen as unknown as HTMLCanvasElement).width).toBe(1600);
    expect(currentCanvasRect(second)).toEqual({ left: 123, top: 456, width: 800, height: 600 });
    expect(currentCanvasRect(f.screen as unknown as HTMLCanvasElement).left).toBe(10);
    expect(f.screen.getBoundingClientRect).toHaveBeenCalledOnce();
  });

  it('uses the local locked coordinates and hides stale art on unlock, cancellation and hidden tabs', async () => {
    const f = setup(),
      cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
    active.push(cursor);
    cursor.update(f.frame);
    f.doc.pointerLockElement = f.screen;
    cursor.position(100, 200, true);
    expect(f.overlay.style.transform).toBe('translate(156px, 288.5px)');
    f.pointer('pointermove', 900, 800);
    expect(f.overlay.style.transform).toBe('translate(156px, 288.5px)');
    f.pointer('pointercancel');
    expect(f.overlay.style.display).toBe('block');
    f.doc.pointerLockElement = null;
    f.doc.dispatchEvent(new Event('pointerlockchange'));
    expect(f.overlay.style.display).toBe('none');
    f.pointer('pointermove');
    f.pointer('pointercancel');
    expect(f.overlay.style.display).toBe('none');
    f.pointer('pointermove');
    f.doc.hidden = true;
    f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(f.overlay.style.display).toBe('none');
  });

  it('returns CSS ownership and releases art and listeners after destruction', async () => {
    const f = setup(),
      cursor = (await createNativeCursor(f.screen as unknown as HTMLCanvasElement))!;
    cursor.update(f.frame);
    f.pointer('pointermove');
    cursor.destroy();
    expect(f.values.get('cursor')).toBe('crosshair');
    expect(f.priorities.get('cursor')).toBe('important');
    expect(f.bitmap.close).toHaveBeenCalledOnce();
    expect(f.overlay.remove).toHaveBeenCalledOnce();
    expect(f.disconnect).toHaveBeenCalledOnce();
    f.pointer('pointermove');
    expect(f.values.get('cursor')).toBe('crosshair');
  });
});
