import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawSidebar, transparentRects } from '../../packages/hd-renderer/src/ui/sidebarView';
import { createUiAssets, type ChromeAssets, type UiAssets } from '../../packages/hd-renderer/src/ui/uiAssets';
import { startHdUi } from '../../src/ui/pages/game/hdUi';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import { hdSidebar } from '../helpers/hdSidebar';

const fallback: UiAssets = { cameo: () => null, chrome: () => null };
const chrome: ChromeAssets = {
  frame: { width: 800, height: 600 },
  pieces: [
    {
      file: 'sidebar.png',
      anchor: 'sidebar',
      rect: { x: 632, y: 0, width: 168, height: 600 },
      bitmap: { width: 336, height: 1200 } as ImageBitmap,
    },
    {
      file: 'bar.png',
      anchor: 'commandBar',
      rect: { x: 0, y: 568, width: 632, height: 32 },
      bitmap: { width: 632, height: 32 } as ImageBitmap,
    },
  ],
};
const withChrome: UiAssets = { ...fallback, chrome: () => chrome };

function recording() {
  const calls: { name: string; args: unknown[]; style: Record<string, unknown> }[] = [];
  const state: Record<string, unknown> = {};
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy(state, {
    get(target, name: string) {
      if (name in target) return target[name];
      return (...args: unknown[]) => {
        calls.push({ name, args, style: { ...state } });
        if (name === 'save') stack.push({ ...state });
        if (name === 'restore') {
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, stack.pop());
        }
        if (name === 'measureText')
          return { width: String(args[0]).length * parseFloat(String(state.font).split(' ')[1]!) * 0.55 };
        if (name === 'createLinearGradient') {
          const stops: unknown[] = [];
          return { stops, addColorStop: (...stop: unknown[]) => stops.push(stop) };
        }
      };
    },
    set(target, name: string, value) {
      target[name] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HD sidebar covered regions', () => {
  it('fallback covers only strip, power, credits and tabs', () => {
    const s = hdSidebar();
    expect(transparentRects(s, fallback)).toEqual([
      s.layout.strip,
      { x: 639, y: 230, width: 12, height: 300 },
      s.layout.credits,
      ...s.layout.tabs,
    ]);
  });
  it('chrome decomposes the column around active radar and also covers the command bar', () => {
    const s = hdSidebar();
    expect(transparentRects(s, withChrome)).toEqual([
      { x: 632, y: 0, width: 168, height: 20 },
      { x: 632, y: 150, width: 168, height: 450 },
      { x: 632, y: 20, width: 12, height: 130 },
      { x: 788, y: 20, width: 12, height: 130 },
      s.layout.commandBar,
    ]);
    s.radarActive = false;
    expect(transparentRects(s, withChrome)).toEqual([s.layout.sidebar, s.layout.commandBar]);
  });
  it('handles clipped, absent and full-column radar apertures without zero-sized holes', () => {
    const s = hdSidebar();
    s.layout.commandBar = null;
    s.layout.radar = { x: 600, y: -20, width: 100, height: 60 };
    expect(transparentRects(s, withChrome)).toEqual([
      { x: 632, y: 40, width: 168, height: 560 },
      { x: 700, y: 0, width: 100, height: 40 },
    ]);
    s.layout.radar = { ...s.layout.sidebar };
    expect(transparentRects(s, withChrome)).toEqual([]);
    s.layout.radar.x = 900;
    expect(transparentRects(s, withChrome)).toEqual([s.layout.sidebar]);
  });
});

describe('HD sidebar drawing', () => {
  it('draws captions, localized state labels, queue digits, credits and hovered tooltip', () => {
    const s = hdSidebar();
    s.labels = { ready: '就緒', hold: '暫停' };
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, fallback, { scale: 2, time: 100 });
    const labels = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(labels).toEqual(
      expect.arrayContaining(['發電廠', 'GI', 'Grizzly Tank', '就緒', '暫停', '3', '12', '12345', '$800']),
    );
    expect(calls.some((c) => c.name === 'fillRect' && c.style.fillStyle === 'rgba(8,10,14,0.62)')).toBe(true);
    const ready = calls.find((c) => c.name === 'fillText' && c.args[0] === '就緒')!;
    expect(ready.style).toMatchObject({ shadowBlur: 12, shadowColor: '#e0402f', textBaseline: 'middle' });
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === '12345')?.args.slice(1)).toEqual([716, 156]);
    expect(calls.filter((c) => c.name === 'clip').length).toBeGreaterThan(2);
  });
  it('only draws clock sectors for non-null progress, with the remaining clockwise arc', () => {
    const s = hdSidebar();
    s.cameos = [s.cameos[0]!];
    s.cameos[0]!.hovered = false;
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, withChrome, { scale: 1, time: 0 });
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(1);
    const arc = calls.find((c) => c.name === 'arc')!;
    expect(arc.args[3]).toBeCloseTo(-Math.PI / 2 + 0.4 * Math.PI * 2);
    expect(arc.args[4]).toBeCloseTo(Math.PI * 1.5);
    s.cameos[0]!.progress = null;
    calls.length = 0;
    drawSidebar(ctx, s, withChrome, { scale: 1, time: 0 });
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(0);
  });
  it('uses bottom-up slot counts for power band heights and low-power alpha', () => {
    const s = hdSidebar();
    s.power.low = true;
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, fallback, { scale: 1, time: 0 });
    const bands = calls.filter(
      (c) => c.name === 'fillRect' && typeof c.style.fillStyle === 'object' && c.args[0] === 640,
    );
    expect(bands.map((c) => c.args.slice(1))).toEqual([
      [430, 10, 100],
      [405, 10, 25],
      [330, 10, 75],
    ]);
    expect(bands[0]?.style.globalAlpha).toBeCloseTo(0.8);
  });
  it('chrome paints images at the anchors, clips radar, and replaces fallback tab plates', () => {
    const s = hdSidebar();
    s.layout.commandBar!.width = 500;
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, withChrome, { scale: 1.25, time: 0 });
    expect(calls.filter((c) => c.name === 'drawImage').map((c) => c.args.slice(1))).toEqual([
      [632, 0, 168, 600],
      [0, 568, 500, 32],
    ]);
    expect(calls.some((c) => c.style.fillStyle === '#1b1e24')).toBe(false);
    expect(
      calls
        .filter((c) => c.name === 'rect')
        .slice(0, 4)
        .map((c) => c.args),
    ).toEqual([
      [632, 0, 168, 20],
      [632, 150.4, 168, 449.6],
      [632, 20, 12, 130.4],
      [788, 20, 12, 130.4],
    ]);
  });
  it('cover-fits art, ellipsizes long captions and puts the tooltip above the final row', () => {
    const s = hdSidebar();
    const c = s.cameos[0]!;
    s.cameos = [c];
    c.y = 550;
    c.name = 'Extremely long building display name that will not fit';
    const image = { width: 200, height: 100 } as ImageBitmap;
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, { ...withChrome, cameo: () => image }, { scale: 1, time: 0 });
    expect(calls.find((c) => c.name === 'drawImage' && c.args[0] === image)?.args).toEqual([
      image,
      37.5,
      0,
      125,
      100,
      662,
      550,
      60,
      48,
    ]);
    expect(calls.some((c) => c.name === 'fillText' && String(c.args[0]).endsWith('…'))).toBe(true);
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === '$800')?.args[2]).toBe(541);
  });
});

describe('optional HD UI art cache', () => {
  it('remembers missing manifests and files; resolves byId and falls back from HD to original', async () => {
    const close = vi.fn();
    const image = { width: 120, height: 96, close };
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith('index.json'))
        return {
          ok: true,
          json: async () => ({
            version: 1,
            byId: { GAPOWR: 'resolved' },
            images: { resolved: { hd: 'hd.png', orig: 'orig.png' } },
          }),
        };
      return {
        ok: path.endsWith('orig.png'),
        status: path.endsWith('orig.png') ? 200 : 404,
        blob: async () => new Blob(),
      };
    });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => image),
    );
    const assets = createUiAssets();
    assets.cameo('GAPOWR', 'ignored');
    assets.chrome(1);
    await settle();
    assets.cameo('GAPOWR', 'ignored');
    await settle();
    assets.cameo('GAPOWR', 'ignored');
    await settle();
    expect(assets.cameo('GAPOWR', null)).toBe(image);
    for (let i = 0; i < 5; i++) {
      assets.chrome(1);
      assets.cameo('GAPOWR', null);
    }
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/hd-cache/_ui/cameos/index.json',
      '/hd-cache/_ui/chrome/1/chrome.json',
      '/hd-cache/_ui/cameos/hd.png',
      '/hd-cache/_ui/cameos/orig.png',
    ]);
    assets.dispose();
    assets.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('keeps native chrome until all pieces load and closes bitmaps arriving after disposal', async () => {
    let resolve!: (image: ImageBitmap) => void;
    const close = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({ frame: chrome.frame, pieces: [{ ...chrome.pieces[0], bitmap: undefined }] }),
        blob: async () => new Blob([path]),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise<ImageBitmap>((done) => {
            resolve = done;
          }),
      ),
    );
    const assets = createUiAssets();
    expect(assets.chrome(1)).toBeNull();
    await settle();
    expect(assets.chrome(1)).toBeNull();
    assets.dispose();
    resolve({ close } as unknown as ImageBitmap);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(assets.chrome(1)).toBeNull();
  });
});

describe('HD UI controller', () => {
  it('tracks the screen box/DPR, changes holes only on region changes and cancels/removes on disable/dispose', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    const { ctx, calls } = recording();
    const remove = vi.fn();
    const canvas = { style: {} as Record<string, string>, width: 0, height: 0, getContext: () => ctx, remove };
    const scheduled = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduled.set(++id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => scheduled.delete(id));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const insert = vi.fn();
    const setTransparentRects = vi.fn();
    const invalidate = vi.fn();
    const host = {
      screen: {
        offsetLeft: 17,
        offsetTop: 9,
        clientWidth: 1000,
        clientHeight: 750,
        parentElement: { insertBefore: insert },
      } as unknown as HTMLCanvasElement,
      frameRenderer: { setTransparentRects } as unknown as VmFrameRenderer,
      invalidate,
      frameSize: () => ({ width: 800, height: 600 }),
    };
    const ui = startHdUi(host);
    const s = hdSidebar();
    ui.update(s);
    expect(insert).toHaveBeenCalledWith(canvas, host.screen);
    const first = scheduled.get(1)!;
    scheduled.delete(1);
    first(100);
    expect(canvas.style).toMatchObject({
      display: 'block',
      left: '17px',
      top: '9px',
      width: '1000px',
      height: '750px',
      pointerEvents: 'none',
      zIndex: '0',
    });
    expect([canvas.width, canvas.height]).toEqual([2000, 1500]);
    expect(calls.some((c) => c.name === 'scale' && c.args[0] === 2.5)).toBe(true);
    ui.update({ ...s, credits: 5 });
    expect(setTransparentRects).toHaveBeenCalledTimes(1);
    ui.setEnabled(false);
    expect(canvas.style.display).toBe('none');
    expect(setTransparentRects).toHaveBeenLastCalledWith([]);
    expect(scheduled.size).toBe(0);
    ui.setEnabled(true);
    expect(scheduled.size).toBe(1);
    ui.update(null);
    expect(scheduled.size).toBe(0);
    ui.update(s);
    ui.dispose();
    ui.dispose();
    expect(setTransparentRects).toHaveBeenLastCalledWith([]);
    expect(remove).toHaveBeenCalledOnce();
    expect(scheduled.size).toBe(0);
    const n = invalidate.mock.calls.length;
    ui.update(s);
    ui.setEnabled(true);
    expect(invalidate).toHaveBeenCalledTimes(n);
  });
});
