import { describe, expect, it } from 'vitest';
import {
  createCoverageGlyphFitter,
  drawFittedGlyph,
  type CoverageGlyphTarget,
  type GlyphContext,
  type GlyphSurface,
} from '../../src/graphics/text/coverageGlyphFit';

/**
 * A synthetic rasterizer: each face weight fills a fixed fraction of its
 * glyph box, and a stroke adds half its width along the box perimeter. It is
 * enough to exercise face choice, stroke search, aspect bounds and budgets
 * without a browser canvas.
 */
function syntheticSurface(density: Record<number, number>, boxes: Record<string, [number, number]> = {}) {
  let transform = { a: 1, d: 1 };
  const stack: (typeof transform)[] = [];
  let ink = 0;
  let renders = 0;
  const box = (text: string) => boxes[text] ?? [40, 50];
  const weight = (font: string) => Number(font.split(' ')[0]);
  const context = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: () => stack.push({ ...transform }),
    restore: () => (transform = stack.pop()!),
    translate: () => {},
    scale: (x: number, y: number) => (transform = { a: transform.a * x, d: transform.d * y }),
    setTransform: (a: number, _b: number, _c: number, d: number) => (transform = { a, d }),
    clearRect: () => (ink = 0),
    fillText(text: string) {
      const [width, height] = box(text);
      ink += density[weight(this.font)]! * width * height * transform.a * transform.d;
    },
    strokeText(text: string) {
      const [width, height] = box(text);
      const mean = Math.sqrt(transform.a * transform.d);
      ink += this.lineWidth * mean * (width + height) * mean;
    },
    measureText(text: string) {
      const [width, height] = box(text);
      return {
        actualBoundingBoxLeft: 2,
        actualBoundingBoxRight: width - 2,
        actualBoundingBoxAscent: height - 5,
        actualBoundingBoxDescent: 5,
      };
    },
    getImageData(_x: number, _y: number, width: number, height: number) {
      renders++;
      const data = new Uint8ClampedArray(width * height * 4);
      let alpha = Math.round(ink * 255);
      for (let i = 3; i < data.length && alpha > 0; i += 4) {
        data[i] = Math.min(255, alpha);
        alpha -= data[i]!;
      }
      return { data };
    },
  } satisfies GlyphContext;
  const surface: GlyphSurface = { context, resize: () => {} };
  return { surface, renders: () => renders };
}

const faces = [400, 700, 900].map((weight) => ({ weight, family: 'Test' }));
const target = (ink: number, extra: Partial<CoverageGlyphTarget> = {}): CoverageGlyphTarget => ({
  text: 'A',
  faces,
  width: 10,
  height: 12,
  ink,
  ...extra,
});

describe('coverage-fitted glyphs', () => {
  // Fill-only ink at 10x12 is 120 * density square layout units.
  const density = { 400: 0.2, 700: 0.35, 900: 0.6 };

  it('uses the heaviest designed face whose ink is within tolerance of the source', () => {
    const { surface } = syntheticSurface(density);
    const fitter = createCoverageGlyphFitter(surface);
    expect(fitter.prepare([target(42)], 4, 1e9)).toBe(true);
    const fit = fitter.get(target(42), 4)!;
    expect(fit.font).toBe('700 64px Test');
    expect(fit.stroke).toBe(0);
    expect(fit.coverage).toBeCloseTo(1, 5);
    // The fitted box is the source ink box on both axes.
    expect(fit.scaleX * 40).toBeCloseTo(10);
    expect(fit.scaleY * 50).toBeCloseTo(12);
  });

  it('emboldens the heaviest lighter face until measured ink matches within two percent', () => {
    const { surface } = syntheticSurface(density);
    const fitter = createCoverageGlyphFitter(surface);
    fitter.prepare([target(30)], 4, 1e9);
    const fit = fitter.get(target(30), 4)!;
    expect(fit.font).toBe('400 64px Test');
    expect(fit.stroke).toBeGreaterThan(0);
    expect(Math.abs(fit.coverage - 1)).toBeLessThanOrEqual(0.02);
    // The stroke's half-width stays inside the source ink box.
    expect(fit.scaleX * (40 + fit.stroke)).toBeCloseTo(10);
    expect(fit.originX).toBeCloseTo(2 + fit.stroke / 2);
  });

  it('keeps the lightest face unstroked and reports excess when every face is heavier', () => {
    const { surface } = syntheticSurface(density);
    const fitter = createCoverageGlyphFitter(surface);
    fitter.prepare([target(10)], 4, 1e9);
    expect(fitter.get(target(10), 4)).toMatchObject({ font: '400 64px Test', stroke: 0, coverage: 2.4 });
  });

  it('bounds the stretch of thin glyphs and centres them in their source box', () => {
    const { surface } = syntheticSurface({ 400: 1 }, { 一: [56, 4] });
    const fitter = createCoverageGlyphFitter(surface);
    const thin = { text: '一', faces: [{ weight: 400, family: 'Test' }], width: 14, height: 2, ink: 15 };
    fitter.prepare([thin], 4, 1e9);
    const fit = fitter.get(thin, 4)!;
    expect(fit.scaleX).toBeCloseTo(0.25);
    expect(fit.scaleY).toBeCloseTo(0.375);
    expect(fit.originY).toBeCloseTo(-1 + (2 / 0.375 - 4) / 2);
    const relaxed = { ...thin, maxAnisotropy: 4 };
    fitter.prepare([relaxed], 4, 1e9);
    expect(fitter.get(relaxed, 4)!.scaleY).toBeCloseTo(0.5);
  });

  it('measures within a budget, caches per output scale and rejects unrenderable targets', () => {
    const { surface, renders } = syntheticSurface(density);
    let clock = 0;
    const fitter = createCoverageGlyphFitter(surface, () => (clock += 5));
    const targets = [target(42), target(42, { text: 'B' }), target(30, { text: 'C' })];
    expect(fitter.prepare(targets, 4, 1)).toBe(false);
    expect(fitter.get(targets[2]!, 4)).toBeUndefined();
    while (!fitter.prepare(targets, 4, 1));
    const measured = renders();
    expect(fitter.prepare(targets, 4, 1)).toBe(true);
    expect(renders()).toBe(measured);
    expect(fitter.get(targets[0]!, 2)).toBeUndefined();
    fitter.prepare([target(0)], 4, 1e9);
    expect(fitter.get(target(0), 4)).toBeNull();
    expect(createCoverageGlyphFitter(surface).prepare(targets, 0, 1e9)).toBe(false);
  });

  it('draws the stroke in the fill colour with round joins inside a restored state', () => {
    const calls: unknown[][] = [];
    const ctx = {
      fillStyle: '#ffff00',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: 'miter' as CanvasLineJoin,
      font: '',
      textAlign: 'start' as CanvasTextAlign,
      textBaseline: 'top' as CanvasTextBaseline,
      save: () => calls.push(['save']),
      restore: () => calls.push(['restore']),
      translate: (...args: number[]) => calls.push(['translate', ...args]),
      scale: (...args: number[]) => calls.push(['scale', ...args]),
      fillText: (...args: unknown[]) => calls.push(['fillText', ...args]),
      strokeText(...args: unknown[]) {
        calls.push(['strokeText', ...args, this.strokeStyle, this.lineJoin, this.lineWidth]);
      },
    };
    const fit = {
      font: '400 64px Test',
      scaleX: 0.25,
      scaleY: 0.3,
      originX: 3,
      originY: 40,
      stroke: 2,
      coverage: 1,
    };
    drawFittedGlyph(ctx, fit, 'A', 5, 6, 0.5);
    expect(calls).toEqual([
      ['save'],
      ['translate', 5, 6],
      ['scale', 0.125, 0.3],
      ['fillText', 'A', 3, 40],
      ['strokeText', 'A', 3, 40, '#ffff00', 'round', 2],
      ['restore'],
    ]);
    expect(ctx.textBaseline).toBe('alphabetic');
  });
});
