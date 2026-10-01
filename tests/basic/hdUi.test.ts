import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawPointer, drawSidebar, transparentRects } from '../../packages/hd-renderer/src/ui/sidebarView';
import { createUiAssets, type ChromeAssets, type UiAssets } from '../../packages/hd-renderer/src/ui/uiAssets';
import { startHdUi } from '../../src/ui/pages/game/hdUi';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import { hdSidebar } from '../helpers/hdSidebar';

const fallback: UiAssets = { cameo: () => null, chrome: () => null, cursor: () => null };
const chrome: ChromeAssets = {
  frame: { width: 800, height: 600 },
  pieces: [
    {
      file: 'sidebar.png',
      anchor: 'sidebar',
      rect: { x: 0, y: 0, width: 168, height: 600 },
      bitmap: { width: 336, height: 1200 } as ImageBitmap,
    },
    {
      file: 'bar.png',
      anchor: 'commandBar',
      rect: { x: 0, y: 0, width: 632, height: 32 },
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
  it('adds and removes exactly the native tooltip rectangle for fallback and chrome', () => {
    const s = hdSidebar(),
      rect = { x: 590, y: 250, width: 90, height: 28 };
    for (const assets of [fallback, withChrome]) {
      s.tooltip = null;
      const base = transparentRects(s, assets);
      s.tooltip = { rect, text: '原生\n$600' };
      expect(transparentRects(s, assets)).toEqual([...base, rect]);
      s.tooltip = null;
      expect(transparentRects(s, assets)).toEqual(base);
    }
  });
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
  it('outlines bold captions/credits and draws only the native tooltip text with its line breaks', () => {
    const s = hdSidebar();
    s.labels = { ready: '就緒', hold: '暫停' };
    s.tooltip = { rect: { x: 590, y: 300, width: 100, height: 40 }, text: '原生提示\r\n\n$600' };
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, fallback, { scale: 2, time: 100 });
    const labels = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(labels).toEqual(
      expect.arrayContaining([
        '發電廠',
        'GI',
        'Grizzly Tank',
        '就緒',
        '暫停',
        '3',
        '12',
        '12345',
        '原生提示',
        '',
        '$600',
      ]),
    );
    expect(calls.some((c) => c.name === 'fillRect' && c.style.fillStyle === 'rgba(8,10,14,0.62)')).toBe(true);
    const ready = calls.find((c) => c.name === 'fillText' && c.args[0] === '就緒')!;
    expect(ready.style).toMatchObject({ textBaseline: 'middle', fillStyle: '#fff6c8' });
    expect(String(ready.style.font)).toMatch(/^700 11px/);
    expect(ready.style.globalAlpha as number).toBeGreaterThanOrEqual(0.85);
    for (const label of ['就緒', '暫停', '12345']) {
      expect(calls.find((c) => c.name === 'strokeText' && c.args[0] === label)?.style).toMatchObject({
        strokeStyle: '#090b10',
        lineWidth: 2,
      });
    }
    expect(labels).not.toContain('$800');
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
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, withChrome, { scale: 1.25, time: 0 });
    expect(calls.filter((c) => c.name === 'drawImage').map((c) => c.args.slice(1))).toEqual([
      [632, 0, 168, 600],
      [0, 568, 632, 32],
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
  it('cover-fits art with rounded clipping and ellipsizes captions without inventing a hovered tooltip', () => {
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
    expect(calls.some((c) => c.name === 'fillText' && c.args[0] === '$800')).toBe(false);
    const imageCall = calls.findIndex((c) => c.name === 'drawImage' && c.args[0] === image);
    expect(calls[imageCall - 1]?.name).toBe('clip');
  });

  it('places three sidebar pieces and two command halves using offsets/sizes from live anchors at a different resolution', () => {
    const s = hdSidebar();
    s.layout.sidebar = { x: 984, y: 0, width: 168, height: 744 };
    s.layout.commandBar = { x: 0, y: 712, width: 984, height: 32 };
    const pieces = [0, 248, 496].map((y) => ({
      file: `s${y}.png`,
      anchor: 'sidebar' as const,
      rect: { x: 0, y, width: 168, height: 248 },
      bitmap: { width: 504, height: 744 } as ImageBitmap,
    }));
    const halves = [0, 492].map((x) => ({
      file: `b${x}.png`,
      anchor: 'commandBar' as const,
      rect: { x, y: 0, width: 492, height: 32 },
      bitmap: { width: 1476, height: 96 } as ImageBitmap,
    }));
    const { ctx, calls } = recording();
    drawSidebar(
      ctx,
      s,
      { ...fallback, chrome: () => ({ frame: s.frame, pieces: [...pieces, ...halves] }) },
      { scale: 3, time: 0 },
    );
    expect(calls.filter((c) => c.name === 'drawImage').map((c) => c.args.slice(1))).toEqual([
      [984, 0, 168, 248],
      [984, 248, 168, 248],
      [984, 496, 168, 248],
      [0, 712, 492, 32],
      [492, 712, 492, 32],
    ]);
    expect(calls.some((c) => c.style.fillStyle === '#1b1e24')).toBe(false);
  });
});

describe('HD software cursor', () => {
  it('clips the atlas frame to precisely the covered union, including a cursor whose hotspot is outside it', () => {
    const s = hdSidebar();
    s.pointer = { x: 660, y: 250, frame: 7, hotspot: { x: 2, y: 3 } };
    const image = { width: 100, height: 100 } as ImageBitmap;
    const cursor = vi.fn(() => ({ bitmap: image, rect: { x: 32, y: 16, width: 16, height: 16 } }));
    const { ctx, calls } = recording();
    const covered = transparentRects(s, fallback);
    drawPointer(ctx, s, { ...fallback, cursor }, covered);
    expect(cursor).toHaveBeenCalledWith(7);
    expect(calls.filter((c) => c.name === 'rect').map((c) => c.args)).toEqual(
      covered.map((r) => [r.x, r.y, r.width, r.height]),
    );
    const index = calls.findIndex((c) => c.name === 'drawImage');
    expect(calls[index - 1]?.name).toBe('clip');
    expect(calls[index]?.args).toEqual([image, 32, 16, 16, 16, 658, 247, 16, 16]);
    calls.length = 0;
    drawPointer(ctx, s, { ...fallback, cursor }, covered, { x: 500, y: 100 });
    expect(calls).toHaveLength(0);
    drawPointer(ctx, s, { ...fallback, cursor }, covered, { x: 770, y: 250 });
    expect(calls.find((c) => c.name === 'drawImage')?.args.slice(-4)).toEqual([768, 247, 16, 16]);
    expect(s.pointer.x).toBe(660);
  });
  it('uses a clipped vector arrow for missing art and respects hidden/unknown pointer state', () => {
    const s = hdSidebar(),
      { ctx, calls } = recording();
    s.pointer = { x: 670, y: 250, frame: 0, hotspot: { x: 20, y: 20 } };
    drawPointer(ctx, s, fallback, transparentRects(s, fallback));
    expect(calls.find((c) => c.name === 'translate')?.args).toEqual([670, 250]);
    expect(calls.some((c) => c.name === 'clip')).toBe(true);
    expect(calls.some((c) => c.name === 'drawImage')).toBe(false);
    calls.length = 0;
    s.pointer = null;
    drawPointer(ctx, s, fallback, transparentRects(s, fallback), { x: 670, y: 250 });
    expect(calls).toHaveLength(0);
  });
});

describe('optional HD UI art cache', () => {
  it.each([null, { x: 0, y: 0, width: 99, height: 1 }])(
    'keeps malformed cursor frames unavailable without retries: %j',
    async (frame) => {
      const close = vi.fn(),
        image = { width: 32, height: 16, close } as unknown as ImageBitmap;
      const fetcher = vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: 1, frames: [frame] }),
        blob: async () => new Blob(),
      }));
      vi.stubGlobal('fetch', fetcher);
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => image),
      );
      const assets = createUiAssets();
      expect(assets.cursor(0)).toBeNull();
      await settle();
      expect(assets.cursor(0)).toBeNull();
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(2);
      assets.dispose();
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it('loads one cursor sheet lazily, validates frame bounds and closes it on disposal', async () => {
    const close = vi.fn(),
      image = { width: 32, height: 16, close } as unknown as ImageBitmap;
    const fetcher = vi.fn(async (path: string) => ({
      ok: true,
      json: async () => ({
        version: 1,
        frames: [
          { x: 0, y: 0, width: 16, height: 16 },
          { x: 16, y: 0, width: 16, height: 16 },
        ],
      }),
      blob: async () => new Blob([path]),
    }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => image),
    );
    const assets = createUiAssets();
    expect(assets.cursor(1)).toBeNull();
    await settle();
    expect(assets.cursor(1)).toEqual({ bitmap: image, rect: { x: 16, y: 0, width: 16, height: 16 } });
    expect(assets.cursor(-1)).toBeNull();
    expect(assets.cursor(2)).toBeNull();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/hd-cache/_ui/cursor/cursor.json',
      '/hd-cache/_ui/cursor/cursor.png',
    ]);
    assets.dispose();
    assets.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(assets.cursor(0)).toBeNull();
  });
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
    s.tooltip = { rect: { x: 590, y: 280, width: 100, height: 30 }, text: 'Native\n$600' };
    ui.update(s);
    expect(setTransparentRects).toHaveBeenLastCalledWith(transparentRects(s, fallback));
    s.tooltip = null;
    ui.update(s);
    expect(setTransparentRects).toHaveBeenLastCalledWith(transparentRects(s, fallback));
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
