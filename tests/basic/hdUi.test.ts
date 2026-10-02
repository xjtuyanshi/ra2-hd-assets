import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDITS_BOTTOM,
  CREDITS_TOP,
  clockWashOf,
  drawPointer,
  drawSidebar,
  transparentRects,
} from '../../packages/hd-renderer/src/ui/sidebarView';
import {
  createUiAssets,
  layoutChromeAnchor,
  type ChromeAssets,
  type UiAssets,
} from '../../packages/hd-renderer/src/ui/uiAssets';
import { startHdUi } from '../../src/ui/pages/game/hdUi';
import type { VmFrameRenderer } from '../../src/ui/pages/game/vmFrameRenderer';
import { hdSidebar } from '../helpers/hdSidebar';

const fallback: UiAssets = { cameo: () => null, caption: () => null, chrome: () => null, cursor: () => null };
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
const tabBitmap = { width: 336, height: 400 } as ImageBitmap;
const tabArt: NonNullable<ChromeAssets['tabs']> = {
  file: 'tabs.png',
  scale: 4,
  bitmap: tabBitmap,
  frames: Array.from({ length: 4 }, (_, tab) =>
    (['normal', 'active', 'pressed'] as const).map((state, column) => ({
      tab,
      state,
      rect: { x: column * 112, y: tab * 100, width: 112, height: 100 },
    })),
  ).flat(),
};
const withTabs: UiAssets = { ...fallback, chrome: () => ({ ...chrome, tabs: tabArt }) };

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

function mockCompositionCanvas() {
  const canvases: Canvas[] = [];
  class Canvas {
    readonly recording = recording();
    bitmap: ImageBitmap | null = null;
    constructor(
      public width: number,
      public height: number,
    ) {
      canvases.push(this);
    }
    getContext() {
      return this.recording.ctx;
    }
    transferToImageBitmap() {
      return (this.bitmap = { width: this.width, height: this.height, close: vi.fn() } as unknown as ImageBitmap);
    }
  }
  vi.stubGlobal('OffscreenCanvas', Canvas);
  return canvases;
}

const sidebarPieces = () =>
  [0, 248, 496].map((y) => ({
    file: `s${y}.png`,
    anchor: 'sidebar' as const,
    rect: { x: 0, y, width: 168, height: 248 },
    bitmap: { width: 504, height: 744 } as ImageBitmap,
  }));
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chrome anchor composition layout', () => {
  it('places three 3x pieces on integer art rows in a single sidebar bitmap', () => {
    expect(layoutChromeAnchor(sidebarPieces())).toEqual({
      rect: { x: 0, y: 0, width: 168, height: 744 },
      width: 504,
      height: 2232,
      placements: [0, 744, 1488].map((y) => ({ x: 0, y, width: 504, height: 744 })),
    });
  });
  it('keeps nonzero anchor offsets while making bitmap placements relative to their union', () => {
    const pieces = sidebarPieces().map((piece) => ({ ...piece, rect: { ...piece.rect, x: 2, y: piece.rect.y - 4 } }));
    expect(layoutChromeAnchor(pieces)).toMatchObject({
      rect: { x: 2, y: -4, width: 168, height: 744 },
      placements: [0, 744, 1488].map((y) => ({ x: 0, y, width: 504, height: 744 })),
    });
  });
  it.each(['scale', 'height', 'offset', 'size'])('rejects incompatible %s instead of resampling pieces', (failure) => {
    const pieces = sidebarPieces();
    if (failure === 'scale') pieces[1]!.bitmap = { width: 336, height: 496 } as ImageBitmap;
    if (failure === 'height') pieces[1]!.bitmap = { width: 504, height: 743 } as ImageBitmap;
    if (failure === 'offset') pieces[1]!.rect.y += 0.1;
    if (failure === 'size') pieces[1]!.rect.width = 0;
    expect(layoutChromeAnchor(pieces)).toBeNull();
    expect(layoutChromeAnchor([])).toBeNull();
  });
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
      // The radar hole is padded by one frame pixel for the native outline row.
      { x: 632, y: 0, width: 168, height: 19 },
      { x: 632, y: 151, width: 168, height: 449 },
      { x: 632, y: 19, width: 11, height: 132 },
      { x: 789, y: 19, width: 11, height: 132 },
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
      { x: 632, y: 41, width: 168, height: 559 },
      { x: 701, y: 0, width: 99, height: 41 },
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
    expect(ready.style).toMatchObject({ textBaseline: 'middle', fillStyle: '#ffd84a' });
    expect(String(ready.style.font)).toMatch(/^700 13px/);
    expect(ready.style.globalAlpha as number).toBeGreaterThanOrEqual(0.85);
    for (const label of ['就緒', '暫停', '12345']) {
      expect(calls.find((c) => c.name === 'strokeText' && c.args[0] === label)?.style).toMatchObject({
        strokeStyle: '#090b10',
        lineWidth: label === '12345' ? 2 : 1.25,
      });
    }
    expect(labels).not.toContain('$800');
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === '12345')?.args.slice(1)).toEqual([716, 159.5]);
    expect(calls.filter((c) => c.name === 'clip').length).toBeGreaterThan(2);
  });
  it('uses the native credits colour and heavier ink at the lowered, horizontally centred anchor', () => {
    const s = hdSidebar();
    const { ctx, calls } = recording();
    const scale = 2.018;
    drawSidebar(ctx, s, withChrome, { scale, time: 0 });
    expect([CREDITS_TOP, CREDITS_BOTTOM]).toEqual(['rgb(255,255,0)', 'rgb(228,228,6)']);
    const x = Math.round(s.layout.creditsAnchor.x * scale) / scale;
    const y = Math.round((s.layout.creditsAnchor.y + 3.5) * scale) / scale;
    const strokes = calls.filter((call) => call.name === 'strokeText' && call.args[0] === '12345');
    expect(strokes.map((call) => call.style.lineWidth)).toEqual([2, 0.6]);
    expect(strokes[0]!.style.strokeStyle).toBe('#090b10');
    const ink = strokes[1]!.style.strokeStyle as unknown as { stops: unknown[][] };
    expect(ink.stops).toEqual([
      [0, CREDITS_TOP],
      [1, CREDITS_BOTTOM],
    ]);
    expect(strokes.every((call) => call.args[1] === x && call.args[2] === y)).toBe(true);
    const fill = calls.find((call) => call.name === 'fillText' && call.args[0] === '12345')!;
    expect(fill.args).toEqual(['12345', x, y]);
    expect(fill.style).toMatchObject({ fillStyle: ink, textAlign: 'center', textBaseline: 'top' });
    expect(String(fill.style.font)).toMatch(/^900 12px/);
    expect(calls.indexOf(strokes[1]!)).toBeLessThan(calls.indexOf(fill));
  });
  it.each([true, false])(
    'prefers index captions with cameo art available=%s and preserves the native tooltip',
    (art) => {
      const s = hdSidebar();
      s.cameos = [s.cameos[0]!];
      s.cameos[0]!.name = '苏联矿石精炼厂';
      s.tooltip = { rect: { x: 590, y: 300, width: 100, height: 40 }, text: '苏联矿石精炼厂\n$600' };
      const caption = vi.fn(() => '矿石精炼厂');
      const { ctx, calls } = recording();
      drawSidebar(
        ctx,
        s,
        {
          ...fallback,
          caption,
          cameo: () => (art ? ({ width: 120, height: 96 } as ImageBitmap) : null),
        },
        { scale: 1, time: 0 },
      );
      expect(caption).toHaveBeenCalledWith(s.cameos[0]!.id, s.cameos[0]!.image);
      const labels = calls.filter((call) => call.name === 'fillText');
      expect(labels.filter((call) => call.args[0] === '矿石精炼厂')).toHaveLength(art ? 1 : 2);
      expect(labels.filter((call) => call.args[0] === '苏联矿石精炼厂')).toHaveLength(1);
      expect(labels.find((call) => call.args[0] === '苏联矿石精炼厂')?.style.textAlign).toBe('left');
    },
  );
  it.each([true, false])('falls back to the native name when captions are absent, art available=%s', (art) => {
    const s = hdSidebar();
    s.cameos = [s.cameos[0]!];
    const { ctx, calls } = recording();
    drawSidebar(
      ctx,
      s,
      { ...fallback, cameo: () => (art ? ({ width: 120, height: 96 } as ImageBitmap) : null) },
      { scale: 1, time: 0 },
    );
    expect(calls.filter((call) => call.name === 'fillText' && call.args[0] === s.cameos[0]!.name)).toHaveLength(
      art ? 1 : 2,
    );
  });
  it('centres fitted yellow Ready/Hold captions on text-sized dark boxes and keeps queued Hold left aligned', () => {
    const s = hdSidebar();
    s.labels = { ready: 'Ready', hold: 'Hold' };
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, withChrome, { scale: 4, time: 625 });
    for (const [label, c, left] of [
      ['Ready', s.cameos[1]!, false],
      ['Hold', s.cameos[2]!, true],
    ] as const) {
      const width = label.length * 13 * 0.55 + 6;
      const x = left ? c.x + 3 : c.x + (60 - width) / 2;
      const snap = (value: number) => Math.round(value * 4) / 4;
      const boxIndex = calls.findIndex(
        (call) => call.name === 'roundRect' && call.args[0] === snap(x) && call.args[1] === c.y + 10.5,
      );
      expect(calls[boxIndex]?.args).toEqual([snap(x), c.y + 10.5, snap(x + width) - snap(x), 19, 2]);
      expect(calls[boxIndex + 1]?.style.fillStyle).toBe('rgba(0,0,0,0.6)');
      const fill = calls.find((call) => call.name === 'fillText' && call.args[0] === label)!;
      expect(fill.args).toEqual([label, snap(x + width / 2), c.y + 20, 54]);
      expect(fill.style).toMatchObject({ fillStyle: '#ffd84a', textBaseline: 'middle', globalAlpha: 0.85 });
      const stroke = calls[calls.indexOf(fill) - 1]!;
      expect(stroke.name).toBe('strokeText');
      expect(stroke.style).toMatchObject({ lineWidth: 1.25, strokeStyle: '#090b10' });
    }
    s.labels.ready = 'Translation far too long to fit';
    s.labels.hold = 'Long Hold';
    s.cameos[2]!.queued = 0;
    calls.length = 0;
    drawSidebar(ctx, s, withChrome, { scale: 1, time: 0 });
    const ready = calls.find((call) => call.name === 'fillText' && call.args[0] === s.labels.ready)!;
    expect(String(ready.style.font)).toMatch(/^700 10px/);
    expect(ready.args.slice(1)).toEqual([756, 250, 54]);
    const hold = calls.find((call) => call.name === 'fillText' && call.args[0] === s.labels.hold)!;
    expect(parseFloat(String(hold.style.font).split(' ')[1]!)).toBeLessThan(13);
    expect(parseFloat(String(hold.style.font).split(' ')[1]!)).toBeGreaterThanOrEqual(10);
    expect(hold.args.slice(1)).toEqual([692, 300, 54]);
  });
  it.each([0, 499, 500, 999, 1000])(
    'selects tab atlas frames at time %i without drawing disabled tabs or state overlays',
    (time) => {
      const s = hdSidebar();
      s.cameos = [];
      s.activeTab = 3;
      // Even a selected, flashing empty tab must retain the chrome's blank disabled button.
      s.tabs[2]!.flashing = true;
      const { ctx, calls } = recording();
      drawSidebar(ctx, s, withTabs, { scale: 1, time });
      const expected = [
        [0, 'normal'],
        [1, time < 500 || time >= 1000 ? 'active' : 'normal'],
        [3, 'active'],
      ] as const;
      expect(
        calls.filter((call) => call.name === 'drawImage' && call.args[0] === tabBitmap).map((call) => call.args),
      ).toEqual(
        expected.map(([tab, state]) => {
          const source = tabArt.frames.find((frame) => frame.tab === tab && frame.state === state)!.rect;
          const target = s.layout.tabs[tab]!;
          return [
            tabBitmap,
            source.x,
            source.y,
            source.width,
            source.height,
            target.x,
            target.y,
            target.width,
            target.height,
          ];
        }),
      );
      expect(calls.some((call) => call.style.shadowBlur || (call.name === 'fillRect' && call.args[1] === 197))).toBe(
        false,
      );
      s.activeTab = 1;
      calls.length = 0;
      drawSidebar(ctx, s, withTabs, { scale: 1, time: 500 });
      expect(
        calls.find((call) => call.name === 'drawImage' && call.args[0] === tabBitmap && call.args[2] === 100)?.args[1],
      ).toBe(0);
    },
  );
  it('retains existing tab pulse/glow/disabled shading when chrome has no tab atlas', () => {
    const s = hdSidebar();
    s.cameos = [];
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, withChrome, { scale: 1, time: 0 });
    expect(
      calls.some(
        (call) =>
          call.name === 'fillRect' &&
          call.args[0] === s.layout.tabs[2]!.x &&
          call.style.fillStyle === 'rgba(0,0,0,0.6)',
      ),
    ).toBe(true);
    expect(calls.some((call) => call.style.shadowBlur === 4)).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.name === 'fillRect' && call.args[0] === s.layout.tabs[1]!.x && call.style.fillStyle === '#e0402f',
      ),
    ).toBe(true);
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
    // The wash colour follows the side's sidebar palette (Allied blue, Soviet and Yuri yellow).
    const washOf = () =>
      calls.slice(calls.findIndex((c) => c.name === 'arc')).find((c) => c.name === 'fill')?.style.fillStyle;
    expect(washOf()).toBe(clockWashOf(s.side));
    for (const [side, wash] of [
      [0, 'rgba(64,173,238,0.5)'],
      [1, 'rgba(243,224,111,0.5)'],
      [2, 'rgba(243,224,111,0.5)'],
    ] as const) {
      s.side = side;
      calls.length = 0;
      drawSidebar(ctx, s, withChrome, { scale: 1, time: 0 });
      expect(washOf()).toBe(wash);
    }
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
        .map((c) => c.args.map((v) => Math.round(Number(v) * 1000) / 1000)),
    ).toEqual([
      [632, 0, 168, 19.2],
      [632, 151.2, 168, 448.8],
      [632, 19.2, 11.2, 132],
      [788.8, 19.2, 11.2, 132],
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
  it('owns and releases the detached canvas when OffscreenCanvas is unavailable', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const { ctx, calls } = recording();
    const canvas = { width: 0, height: 0, getContext: () => ctx };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal('document', { createElement });
    const pieces = sidebarPieces();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({ frame: chrome.frame, pieces }),
        blob: async () => new Blob([path]),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 504, height: 744, close: vi.fn() })),
    );
    const assets = createUiAssets();
    assets.chrome(1);
    await settle();
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');
    expect(assets.chrome(1)?.composites?.sidebar?.bitmap).toBe(canvas);
    expect(canvas).toMatchObject({ width: 504, height: 2232 });
    expect(calls.filter((call) => call.name === 'drawImage').map((call) => call.args.slice(1))).toEqual(
      [0, 744, 1488].map((y) => [0, y, 504, 744]),
    );
    assets.dispose();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
  it('composes each anchor once and draws one snapped destination per anchor at fractional device scale', async () => {
    const canvases = mockCompositionCanvas();
    const s = hdSidebar();
    s.cameos = [];
    s.layout.sidebar = { x: 984, y: 0, width: 168, height: 744 };
    s.layout.commandBar = { x: 0, y: 712, width: 984, height: 32 };
    const pieces = [
      ...sidebarPieces(),
      ...[0, 492].map((x) => ({
        file: `b${x}.png`,
        anchor: 'commandBar' as const,
        rect: { x, y: 0, width: 492, height: 32 },
        bitmap: { width: 1476, height: 96 } as ImageBitmap,
      })),
    ];
    const images = pieces.map((piece) => ({ ...piece.bitmap, close: vi.fn() }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({ frame: s.frame, pieces }),
        blob: async () => new Blob([path]),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        const path = await blob.text();
        return images[pieces.findIndex((piece) => path.endsWith(`/${piece.file}`))];
      }),
    );
    const assets = createUiAssets();
    expect(assets.chrome(1)).toBeNull();
    await settle();
    expect(canvases).toHaveLength(2);
    expect(canvases[0]!.bitmap).toMatchObject({ width: 504, height: 2232 });
    expect(canvases[0]!.recording.calls.filter((call) => call.name === 'drawImage').map((call) => call.args)).toEqual(
      [0, 744, 1488].map((y, i) => [images[i], 0, y, 504, 744]),
    );
    expect(canvases[1]!.bitmap).toMatchObject({ width: 2952, height: 96 });
    expect(canvases[1]!.recording.calls.filter((call) => call.name === 'drawImage').map((call) => call.args)).toEqual(
      [0, 1476].map((x, i) => [images[i + 3], x, 0, 1476, 96]),
    );
    const { ctx, calls } = recording();
    const scale = 2.018;
    const snap = (value: number) => Math.round(value * scale) / scale;
    drawSidebar(ctx, s, assets, { scale, time: 0 });
    expect(calls.filter((call) => call.name === 'drawImage').map((call) => call.args)).toEqual(
      [s.layout.sidebar, s.layout.commandBar!].map((r, i) => [
        canvases[i]!.bitmap,
        snap(r.x),
        snap(r.y),
        snap(r.x + r.width) - snap(r.x),
        snap(r.y + r.height) - snap(r.y),
      ]),
    );
    drawSidebar(ctx, s, assets, { scale, time: 10 });
    expect(canvases).toHaveLength(2);
    assets.dispose();
    assets.dispose();
    for (const image of [...images, ...canvases.map((canvas) => canvas.bitmap!)])
      expect(image.close).toHaveBeenCalledOnce();
  });
  it('retains per-piece drawing when an anchor mixes art scales', async () => {
    const canvases = mockCompositionCanvas();
    const pieces = sidebarPieces();
    pieces[1]!.bitmap = { width: 336, height: 496 } as ImageBitmap;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({ frame: chrome.frame, pieces }),
        blob: async () => new Blob([path]),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        const path = await blob.text();
        return { ...pieces.find((piece) => path.endsWith(`/${piece.file}`))!.bitmap, close: vi.fn() };
      }),
    );
    const assets = createUiAssets();
    assets.chrome(1);
    await settle();
    expect(assets.chrome(1)?.composites).toEqual({});
    expect(canvases).toHaveLength(0);
    const s = hdSidebar();
    s.cameos = [];
    s.layout.commandBar = null;
    const { ctx, calls } = recording();
    drawSidebar(ctx, s, assets, { scale: 1, time: 0 });
    expect(calls.filter((call) => call.name === 'drawImage').map((call) => call.args.slice(1))).toEqual(
      [0, 248, 496].map((y) => [632, y, 168, 248]),
    );
    assets.dispose();
  });
  it('resolves captions through the same byId and image fallback without loading art', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        byId: { BUILDING: 'resolved', NO_CAPTION: 'unknown' },
        images: {
          resolved: { hd: 'hd.png', caption: '矿石精炼厂' },
          supplied: { orig: 'orig.png', caption: '攻击潜艇' },
          unknown: { hd: 'unknown.png' },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const assets = createUiAssets();
    expect(assets.caption('BUILDING', 'supplied')).toBeNull();
    await settle();
    expect(assets.caption('BUILDING', 'supplied')).toBe('矿石精炼厂');
    expect(assets.caption('BUILDING', null)).toBe('矿石精炼厂');
    expect(assets.caption('UNMAPPED', 'supplied')).toBe('攻击潜艇');
    expect(assets.caption('NO_CAPTION', 'supplied')).toBeNull();
    expect(assets.caption('UNMAPPED', null)).toBeNull();
    expect(assets.caption('UNMAPPED', 'missing')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    assets.dispose();
    expect(assets.caption('BUILDING', null)).toBeNull();
  });
  it.each(['absent', '404', 'decode', 'bounds', 'incomplete', 'duplicate', 'state'])(
    'keeps complete chrome when optional tabs are broken: %s',
    async (failure) => {
      const close = vi.fn();
      const image = { width: 336, height: 400, close } as unknown as ImageBitmap;
      const frames = tabArt.frames.map((frame) => ({ ...frame, rect: { ...frame.rect } }));
      if (failure === 'bounds') frames[0]!.rect.width = 999;
      if (failure === 'incomplete') frames.splice(0, 1);
      if (failure === 'duplicate') frames.push(frames[0]!);
      if (failure === 'state') (frames[0] as { state: string }).state = 'disabled';
      const fetcher = vi.fn(async (path: string) => ({
        ok: !(failure === '404' && path.endsWith('tabs.png')),
        json: async () => ({
          frame: chrome.frame,
          pieces: [{ ...chrome.pieces[0], bitmap: undefined }],
          ...(failure === 'absent' ? {} : { tabs: { file: 'tabs.png', scale: 4, frames } }),
        }),
        blob: async () => new Blob([path]),
      }));
      vi.stubGlobal('fetch', fetcher);
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async (blob: Blob) => {
          if (failure === 'decode' && (await blob.text()).endsWith('tabs.png')) throw new Error('Broken atlas');
          return image;
        }),
      );
      const assets = createUiAssets();
      assets.chrome(1);
      await settle();
      const loaded = assets.chrome(1)!;
      expect(loaded.pieces).toHaveLength(1);
      expect(loaded.tabs).toBeUndefined();
      const requests = fetcher.mock.calls.length;
      assets.chrome(1);
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(requests);
      assets.dispose();
    },
  );
  it('publishes chrome while tabs are still loading and owns the atlas through disposal', async () => {
    const pieceClose = vi.fn(),
      tabClose = vi.fn();
    let resolve!: (image: ImageBitmap) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({ frame: chrome.frame, pieces: [{ ...chrome.pieces[0], bitmap: undefined }], tabs: tabArt }),
        blob: async () => new Blob([path]),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) =>
        (await blob.text()).endsWith('tabs.png')
          ? new Promise<ImageBitmap>((done) => {
              resolve = done;
            })
          : ({ close: pieceClose } as unknown as ImageBitmap),
      ),
    );
    const assets = createUiAssets();
    assets.chrome(0);
    await settle();
    expect(assets.chrome(0)?.pieces).toHaveLength(1);
    expect(assets.chrome(0)?.tabs).toBeUndefined();
    const image = { ...tabBitmap, close: tabClose } as unknown as ImageBitmap;
    resolve(image);
    await settle();
    expect(assets.chrome(0)?.tabs).toEqual({ ...tabArt, bitmap: image });
    assets.dispose();
    expect(pieceClose).toHaveBeenCalledOnce();
    expect(tabClose).toHaveBeenCalledOnce();
    expect(assets.chrome(0)).toBeNull();
  });
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
