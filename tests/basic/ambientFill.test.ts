import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FILL_FADE_IN_MS,
  AMBIENT_FILL_FADE_OUT_MS,
  ambientFillClipPath,
  ambientFillLayout,
  ambientFillPresentation,
  ambientFillVisibility,
  drawAmbientFill,
  mirrorTiles,
  type AmbientFillSignals,
  type AmbientFillVisibility,
} from '../../src/graphics/ambientFill';
import { SUPPORTED_GAMES } from '../../src/games/catalog';

const shell = { width: 800, height: 600 };
const match = { width: 1644, height: 1032 };
const menu = (overrides: Partial<AmbientFillSignals> = {}): AmbientFillSignals => ({
  shellSurface: shell,
  matchSurface: match,
  frame: { width: 800, height: 600 },
  battleActive: false,
  ...overrides,
});

describe('ambient fill activation', () => {
  it('shows only while the shell surface is presented', () => {
    expect(ambientFillVisibility(menu())).toBe('shown');
    // The switch into the match's video mode fades the last fill out (no new samples).
    expect(ambientFillVisibility(menu({ frame: { ...match } }))).toBe('fading');
  });

  it('never shows during a running match, whatever the picture size', () => {
    const matchSignals: Partial<AmbientFillSignals>[] = [
      { battleActive: true },
      { battleActive: true, frame: { ...match } },
      { frame: { width: 800, height: 600, matchPicture: true } },
      { frame: { ...match, matchPicture: true } },
    ];
    for (const signals of matchSignals) expect(ambientFillVisibility(menu(signals))).toBe('hidden');
  });

  it('stays off when the match cannot be told apart from the shell or nothing is known', () => {
    expect(ambientFillVisibility(menu({ matchSurface: { width: 800, height: 600 } }))).toBe('hidden');
    expect(ambientFillVisibility(menu({ matchSurface: null }))).toBe('hidden');
    expect(ambientFillVisibility(menu({ shellSurface: null }))).toBe('hidden');
    expect(ambientFillVisibility(menu({ frame: null }))).toBe('hidden');
    expect(ambientFillVisibility(menu({ released: true }))).toBe('hidden');
  });

  it('removes a hidden fill at once, fades the departure and fades in only after a sample', () => {
    expect(ambientFillPresentation('hidden', true, false)).toEqual({ display: false, opacity: 0, transitionMs: 0 });
    expect(ambientFillPresentation('fading', true, false)).toEqual({
      display: true,
      opacity: 0,
      transitionMs: AMBIENT_FILL_FADE_OUT_MS,
    });
    expect(ambientFillPresentation('shown', false, false)).toEqual({ display: true, opacity: 0, transitionMs: 0 });
    expect(ambientFillPresentation('shown', true, false)).toEqual({
      display: true,
      opacity: 1,
      transitionMs: AMBIENT_FILL_FADE_IN_MS,
    });
    // Reduced motion: the same states without transitions.
    for (const visibility of ['shown', 'fading', 'hidden'] as AmbientFillVisibility[])
      expect(ambientFillPresentation(visibility, true, true).transitionMs).toBe(0);
  });

  it('a menu → match → menu sequence never leaves the fill visible beside the battlefield', () => {
    const sequence: [AmbientFillSignals, AmbientFillVisibility][] = [
      [menu(), 'shown'],
      [menu({ frame: { ...match } }), 'fading'], // loading in the match's video mode
      [menu({ frame: { ...match, matchPicture: true }, battleActive: true }), 'hidden'],
      [menu({ frame: { ...match }, battleActive: true }), 'hidden'],
      [menu({ frame: { ...shell } }), 'shown'], // back to the score screen / menus
    ];
    for (const [signals, expected] of sequence) {
      const visibility = ambientFillVisibility(signals);
      expect(visibility).toBe(expected);
      if (signals.battleActive || signals.frame?.matchPicture)
        expect(ambientFillPresentation(visibility, true, false).display).toBe(false);
    }
  });

  it('YR declares its fixed 800x600 shell; the native host uses the same surface', () => {
    const yr = SUPPORTED_GAMES.find((game) => game.id === 'yr')!;
    expect(yr.shellSurface).toEqual({ width: 800, height: 600 });
  });
});

describe('ambient fill geometry', () => {
  it("fills both side bars on the owner's 1.594:1 screen and maps the picture to the sample height", () => {
    // 4112x2580 device pixels at DPR 2: a 4:3 picture at full height leaves ~336 device pixels per side.
    const stage = { width: 2056, height: 1290 };
    const content = { x: 168, y: 0, width: 1720, height: 1290 };
    const layout = ambientFillLayout(stage, content, { sampleHeight: 144 })!;
    expect(layout.bars).toEqual([
      { x: 0, y: 0, width: 168, height: 1290 },
      { x: 1888, y: 0, width: 168, height: 1290 },
    ]);
    expect(layout.sides).toEqual({ left: true, right: true, top: false, bottom: false });
    expect(layout.buffer).toEqual({ width: 230, height: 144 });
    expect(layout.bufferContent.height).toBeCloseTo(144);
    expect(layout.bufferContent.x).toBeCloseTo(18.75, 2);
  });

  it('covers 16:9, ultra-wide and DPR 1.5 stages and stays small', () => {
    for (const [width, height, dpr] of [
      [1920, 1080, 1],
      [2560, 1440, 1.5],
      [3440, 1440, 1],
      [5120, 1440, 2],
    ]) {
      const stage = { width: width / dpr, height: height / dpr };
      const contentWidth = (stage.height * 4) / 3;
      const layout = ambientFillLayout(
        stage,
        { x: (stage.width - contentWidth) / 2, y: 0, width: contentWidth, height: stage.height },
        { sampleHeight: 144 },
      )!;
      expect(layout.bars).toHaveLength(2);
      expect(layout.buffer.height).toBe(144);
      expect(layout.buffer.width).toBeLessThanOrEqual(1024);
      // Mirrored tiles always cover the whole buffer.
      const tiles = mirrorTiles(layout.bufferContent.x, layout.bufferContent.width, layout.buffer.width);
      expect(tiles[0]!.offset).toBeLessThanOrEqual(0);
      const last = tiles[tiles.length - 1]!;
      expect(last.offset + layout.bufferContent.width).toBeGreaterThanOrEqual(layout.buffer.width);
    }
  });

  it('has nothing to fill when the picture fills the stage (a display-matched match)', () => {
    expect(
      ambientFillLayout(
        { width: 2056, height: 1290 },
        { x: 0, y: 0, width: 2056, height: 1290 },
        { sampleHeight: 144 },
      ),
    ).toBeNull();
    // Sub-pixel slivers after rounding do not count as bars.
    expect(
      ambientFillLayout({ width: 1000, height: 600 }, { x: 0.5, y: 0, width: 999, height: 600 }, { sampleHeight: 144 }),
    ).toBeNull();
    expect(
      ambientFillLayout({ width: 0, height: 600 }, { x: 0, y: 0, width: 1, height: 1 }, { sampleHeight: 144 }),
    ).toBe(null);
  });

  it('fills top and bottom bars of a portrait stage', () => {
    const layout = ambientFillLayout(
      { width: 600, height: 900 },
      { x: 0, y: 225, width: 600, height: 450 },
      { sampleHeight: 144 },
    )!;
    expect(layout.sides).toEqual({ left: false, right: false, top: true, bottom: true });
    expect(layout.bars).toEqual([
      { x: 0, y: 0, width: 600, height: 225 },
      { x: 0, y: 675, width: 600, height: 225 },
    ]);
  });

  it('mirrors every other tile outward from the picture', () => {
    expect(mirrorTiles(20, 100, 140)).toEqual([
      { offset: -80, flipped: true },
      { offset: 20, flipped: false },
      { offset: 120, flipped: true },
    ]);
    expect(mirrorTiles(20, 100, 120)).toEqual([
      { offset: -80, flipped: true },
      { offset: 20, flipped: false },
    ]);
    expect(mirrorTiles(10, 20, 80)).toEqual([
      { offset: -10, flipped: true },
      { offset: 10, flipped: false },
      { offset: 30, flipped: true },
      { offset: 50, flipped: false },
      { offset: 70, flipped: true },
    ]);
    expect(mirrorTiles(0, 0, 100)).toEqual([]);
  });

  it('clips the picture rect out of the fill element', () => {
    const layout = ambientFillLayout(
      { width: 1000, height: 600 },
      { x: 100, y: 0, width: 800, height: 600 },
      { sampleHeight: 144 },
    )!;
    expect(ambientFillClipPath(layout)).toBe(
      'polygon(evenodd, 0px 0px, 1000px 0px, 1000px 600px, 0px 600px, 0px 0px, ' +
        '100px 0px, 900px 0px, 900px 600px, 100px 600px, 100px 0px)',
    );
  });

  it('draws mirrored tiles, one blurred copy and darkening ramps only on sides with bars', () => {
    const layout = ambientFillLayout(
      { width: 1000, height: 600 },
      { x: 100, y: 0, width: 800, height: 600 },
      { sampleHeight: 144 },
    )!;
    const calls: string[] = [];
    const recorder = (name: string) => {
      const context = {
        filter: 'none',
        fillStyle: '' as unknown,
        imageSmoothingEnabled: false,
        canvas: { name } as unknown as CanvasImageSource,
        clearRect: () => calls.push(`${name}.clear`),
        drawImage: (...args: unknown[]) => calls.push(`${name}.draw(${args.length}) filter=${context.filter}`),
        save: () => undefined,
        restore: () => undefined,
        translate: () => undefined,
        scale: (x: number, y: number) => calls.push(`${name}.scale(${x},${y})`),
        beginPath: () => undefined,
        rect: () => undefined,
        clip: () => undefined,
        setTransform: () => undefined,
        fillRect: (x: number, y: number, w: number, h: number) => calls.push(`${name}.fillRect(${x},${y},${w},${h})`),
        createLinearGradient: () => ({ addColorStop: () => undefined }),
      };
      return context;
    };
    const target = recorder('target');
    const mosaic = recorder('mosaic');
    drawAmbientFill(target as never, mosaic as never, {} as CanvasImageSource, layout, 3);
    // 240x144 buffer, picture 192 wide at x 24: one mirrored tile per side plus the picture itself.
    expect(calls.filter((call) => call.startsWith('mosaic.draw'))).toHaveLength(3);
    expect(calls.filter((call) => call.startsWith('mosaic.scale(-1,1)'))).toHaveLength(2);
    expect(calls).toContain('target.draw(3) filter=blur(3px)');
    expect(target.filter).toBe('none');
    expect(calls.filter((call) => call.startsWith('target.fillRect'))).toEqual([
      'target.fillRect(0,0,24,144)',
      'target.fillRect(216,0,24,144)',
    ]);
  });
});
