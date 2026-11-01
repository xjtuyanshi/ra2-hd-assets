/**
 * Fits smooth host-font glyphs to a source bitmap font's ink boxes and ink
 * weight. A source glyph supplies its ink rectangle and lit area in layout
 * units; the fitter picks the heaviest supplied face that is not heavier than
 * the source, then emboldens it with a round-joined stroke until the measured
 * device-resolution coverage matches the source area. Measurement renders the
 * exact drawing operation at the actual output scale, so the result does not
 * depend on assumed stem widths of whichever face the browser resolves.
 *
 * Game policy (faces per script, source measurements) is supplied by callers.
 */

/** A CSS font family list and weight; the size is chosen by the fitter. */
export interface GlyphFace {
  readonly weight: number;
  readonly family: string;
}

export interface CoverageGlyphTarget {
  /** One UTF-16 code unit or grapheme drawn with fillText/strokeText. */
  readonly text: string;
  /** Candidate faces from lightest to heaviest. */
  readonly faces: readonly GlyphFace[];
  /** Ink rectangle size in layout units. */
  readonly width: number;
  readonly height: number;
  /** Source ink area in square layout units, such as a bitmap's lit pixel count. */
  readonly ink: number;
  /** Largest stretch of one axis relative to the other; defaults to 1.5. */
  readonly maxAnisotropy?: number;
}

export interface CoverageGlyphFit {
  /** CSS font at the fitter's reference size. */
  readonly font: string;
  /** Layout units per reference pixel on each axis. */
  readonly scaleX: number;
  readonly scaleY: number;
  /** fillText origin in reference pixels, already inset for the stroke. */
  readonly originX: number;
  readonly originY: number;
  /** Embolden stroke width in reference pixels; zero draws fill only. */
  readonly stroke: number;
  /** Measured ink divided by the source ink at the fitted output scale. */
  readonly coverage: number;
}

/** The subset of a 2D context used for measuring and drawing fitted glyphs. */
export interface GlyphContext {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(
    text: string,
  ): Pick<
    TextMetrics,
    'actualBoundingBoxLeft' | 'actualBoundingBoxRight' | 'actualBoundingBoxAscent' | 'actualBoundingBoxDescent'
  >;
  getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
}

/** A reusable measuring surface; the fitter resizes it before every render. */
export interface GlyphSurface {
  resize(width: number, height: number): void;
  readonly context: GlyphContext;
}

export interface CoverageGlyphFitter {
  /**
   * Fit every target at the given device pixels per layout unit, within a
   * wall-clock budget (at least one glyph is measured per call). Returns false
   * while some targets remain unmeasured; fitted targets stay cached.
   */
  prepare(targets: Iterable<CoverageGlyphTarget>, deviceScale: number, budgetMs: number): boolean;
  /** A previously prepared fit, or null for unmeasured/unrenderable glyphs. */
  get(target: CoverageGlyphTarget, deviceScale: number): CoverageGlyphFit | null | undefined;
}

const REFERENCE_SIZE = 64;
/** Stop the stroke search within this coverage ratio. */
const COVERAGE_TOLERANCE = 0.02;
/** A designed face within this ratio is used as is, without synthetic stroke. */
const FACE_TOLERANCE = 0.08;
/**
 * Default largest axis stretch relative to the other axis. Thin source glyphs
 * (a one-stroke ideograph) have ink boxes one or two pixels high; stretching a
 * host glyph's thin bar to fill them would double its weight. Such glyphs keep
 * a bounded aspect and are centred in their box instead.
 */
const MAX_ANISOTROPY = 1.5;
const MAX_ITERATIONS = 6;
const PAD = 2;

function keyOf(target: CoverageGlyphTarget, deviceScale: number): string {
  const faces = target.faces.map(({ weight, family }) => `${weight} ${family}`).join('|');
  const shape = `${target.width}x${target.height}:${target.ink}/${target.maxAnisotropy ?? ''}`;
  return `${target.text}\u0000${faces}\u0000${shape}@${deviceScale.toFixed(3)}`;
}

/** Draw a fitted glyph whose ink box starts at (x, y) in layout units. */
export function drawFittedGlyph(
  ctx: Pick<
    GlyphContext,
    | 'save'
    | 'restore'
    | 'translate'
    | 'scale'
    | 'font'
    | 'textAlign'
    | 'textBaseline'
    | 'lineWidth'
    | 'lineJoin'
    | 'strokeStyle'
    | 'fillStyle'
    | 'fillText'
    | 'strokeText'
  >,
  fit: CoverageGlyphFit,
  text: string,
  x: number,
  y: number,
  squeezeX = 1,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(fit.scaleX * squeezeX, fit.scaleY);
  ctx.font = fit.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, fit.originX, fit.originY);
  if (fit.stroke > 0) {
    // The stroke is isotropic in reference space; the box fit already
    // accounts for its half-width on every side.
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineJoin = 'round';
    ctx.lineWidth = fit.stroke;
    ctx.strokeText(text, fit.originX, fit.originY);
  }
  ctx.restore();
}

function geometry(
  ctx: GlyphContext,
  target: CoverageGlyphTarget,
  face: GlyphFace,
  stroke: number,
): CoverageGlyphFit | null {
  const font = `${face.weight} ${REFERENCE_SIZE}px ${face.family}`;
  ctx.font = font;
  const m = ctx.measureText(target.text);
  const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (!(width > 0) || !(height > 0)) return null;
  let scaleX = target.width / (width + stroke);
  let scaleY = target.height / (height + stroke);
  const anisotropy = Math.max(1, target.maxAnisotropy ?? MAX_ANISOTROPY);
  scaleX = Math.min(scaleX, scaleY * anisotropy);
  scaleY = Math.min(scaleY, scaleX * anisotropy);
  return {
    font,
    scaleX,
    scaleY,
    // Centre a bounded-aspect glyph inside the axis it no longer fills.
    originX: m.actualBoundingBoxLeft + stroke / 2 + (target.width / scaleX - width - stroke) / 2,
    originY: m.actualBoundingBoxAscent + stroke / 2 + (target.height / scaleY - height - stroke) / 2,
    stroke,
    coverage: 0,
  };
}

/** Measured ink of one fitted glyph, in square layout units. */
function measure(surface: GlyphSurface, fit: CoverageGlyphFit, target: CoverageGlyphTarget, scale: number): number {
  const width = Math.ceil(target.width * scale) + 2 * PAD;
  const height = Math.ceil(target.height * scale) + 2 * PAD;
  surface.resize(width, height);
  const ctx = surface.context;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, scale, PAD, PAD);
  ctx.fillStyle = '#fff';
  drawFittedGlyph(ctx, fit, target.text, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  let alpha = 0;
  for (let i = 3; i < data.length; i += 4) alpha += data[i]!;
  return alpha / 255 / (scale * scale);
}

function fitOne(surface: GlyphSurface, target: CoverageGlyphTarget, scale: number): CoverageGlyphFit | null {
  if (!(target.width > 0 && target.height > 0 && target.ink > 0) || target.faces.length === 0) return null;
  const ctx = surface.context;
  let base: { fit: CoverageGlyphFit; ink: number; face: GlyphFace } | null = null;
  // Heaviest face first: a designed bold needs less synthetic emboldening.
  for (let index = target.faces.length - 1; index >= 0; index--) {
    const face = target.faces[index]!;
    const fit = geometry(ctx, target, face, 0);
    if (!fit) continue;
    const ink = measure(surface, fit, target, scale);
    base = { fit, ink, face };
    if (ink <= target.ink * (1 + FACE_TOLERANCE)) break;
  }
  if (!base) return null;
  // Too heavy even in the lightest face, or a designed weight close enough.
  if (base.ink >= target.ink * (1 - FACE_TOLERANCE)) return { ...base.fit, coverage: base.ink / target.ink };
  // Secant/regula-falsi search on the stroke width: coverage grows
  // monotonically with it. `low` stays below the target, `high` above it.
  const limit = REFERENCE_SIZE * 0.35;
  let low = { stroke: 0, ink: base.ink };
  let high: { stroke: number; ink: number } | null = null;
  let best = { fit: base.fit, ink: base.ink };
  let stroke = REFERENCE_SIZE * 0.04;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const fit = geometry(ctx, target, base.face, stroke);
    if (!fit) break;
    const ink = measure(surface, fit, target, scale);
    if (Math.abs(ink - target.ink) < Math.abs(best.ink - target.ink)) best = { fit, ink };
    if (Math.abs(ink / target.ink - 1) <= COVERAGE_TOLERANCE) break;
    if (ink < target.ink) {
      if (stroke >= limit) break;
      const slope = (ink - low.ink) / (stroke - low.stroke);
      const previous = low;
      low = { stroke, ink };
      if (!high) {
        // Extrapolate, growing by at least a quarter so slow starts converge.
        const estimate = slope > 0 ? stroke + (target.ink - ink) / slope : stroke * 2;
        stroke = Math.min(limit, Math.max(estimate, stroke * 1.25, previous.stroke + 1e-3));
        continue;
      }
    } else high = { stroke, ink };
    const estimate = low.stroke + ((target.ink - low.ink) * (high!.stroke - low.stroke)) / (high!.ink - low.ink);
    const span = high!.stroke - low.stroke;
    stroke = Math.min(Math.max(estimate, low.stroke + span * 0.05), high!.stroke - span * 0.05);
  }
  return { ...best.fit, coverage: best.ink / target.ink };
}

export function createCoverageGlyphFitter(
  surface: GlyphSurface,
  now: () => number = () => performance.now(),
): CoverageGlyphFitter {
  const fits = new Map<string, CoverageGlyphFit | null>();
  return {
    prepare(targets, deviceScale, budgetMs) {
      if (!(deviceScale > 0)) return false;
      const deadline = now() + budgetMs;
      let measured = false;
      for (const target of targets) {
        const key = keyOf(target, deviceScale);
        if (fits.has(key)) continue;
        // Always measure at least one glyph so repeated calls make progress.
        if (measured && now() > deadline) return false;
        fits.set(key, fitOne(surface, target, deviceScale));
        measured = true;
      }
      return true;
    },
    get(target, deviceScale) {
      return fits.get(keyOf(target, deviceScale));
    },
  };
}

/** A browser measuring surface; callers own the returned object's lifetime. */
export function createCanvasGlyphSurface(): GlyphSurface | null {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined'
        ? document.createElement('canvas')
        : null;
  if (!canvas) return null;
  const context = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as GlyphContext | null;
  if (!context) return null;
  return {
    context,
    resize(width, height) {
      // Resizing clears and resets state; only grow to avoid reallocations.
      if (canvas.width < width || canvas.height < height) {
        canvas.width = Math.max(canvas.width, width);
        canvas.height = Math.max(canvas.height, height);
      }
    },
  };
}
