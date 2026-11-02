/**
 * Ambient fill: the empty stage area beside a fixed-size picture (for example a 4:3 game shell on a wider screen)
 * shows a soft continuation of the picture's own edges instead of black bars. The outer strips of the presented
 * picture are mirrored outward, blurred at low resolution and darkened toward the screen edge, like a television's
 * ambient mode.
 *
 * This module is the generic mechanism: the activation policy, the geometry and the low-resolution drawing. It knows
 * nothing about a specific game; the page injects which picture size is the game's fixed front end (its "shell
 * surface") and which size its match uses. The fill is presentation only. It never changes the game canvas rect,
 * pointer mapping or hit testing, and it never draws inside the picture's rect.
 */

export interface FillSize {
  width: number;
  height: number;
}

export interface FillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `shown`: the fill follows the presented picture. `fading`: the picture left the shell surface for another video
 * mode and nothing yet shows a running match; the last fill fades out without new samples. `hidden`: removed at once.
 */
export type AmbientFillVisibility = 'shown' | 'fading' | 'hidden';

export interface AmbientFillSignals {
  /** The game's fixed-size front-end surface; null when the game declares none (the fill then never shows). */
  shellSurface: FillSize | null;
  /**
   * The video mode this session's match uses; null when unknown. A match surface equal to the shell surface cannot be
   * told apart from the front end by its size, so the fill stays off for the whole session.
   */
  matchSurface: FillSize | null;
  /** The picture currently presented, or null before the first one. */
  frame: (FillSize & { matchPicture?: boolean }) | null;
  /** Any evidence of a running match from other readers (battle state, battle-only picture data). */
  battleActive: boolean;
  /** The session is gone (released, exited) or the page has no usable presentation. */
  released?: boolean;
}

function sameSize(a: FillSize, b: FillSize): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * Decide whether the fill may show. Every sign of a running match hides it at once, without a fade: the fill must
 * never sit beside, over or under a running match. Only a departure from the shell surface that is not (yet) a
 * match, such as the switch into the match's video mode, fades.
 */
export function ambientFillVisibility(signals: AmbientFillSignals): AmbientFillVisibility {
  const { shellSurface, matchSurface, frame } = signals;
  if (signals.released || !shellSurface || !matchSurface || !frame) return 'hidden';
  if (signals.battleActive || frame.matchPicture) return 'hidden';
  if (sameSize(matchSurface, shellSurface)) return 'hidden';
  return sameSize(frame, shellSurface) ? 'shown' : 'fading';
}

/** The presentation state the page applies for a visibility. */
export interface AmbientFillPresentation {
  /** Whether the element takes part in layout and compositing at all. */
  display: boolean;
  opacity: number;
  /** CSS opacity transition in milliseconds (0: change at once). */
  transitionMs: number;
}

export const AMBIENT_FILL_FADE_IN_MS = 400;
export const AMBIENT_FILL_FADE_OUT_MS = 250;

/**
 * Map a visibility to element state. `ready` is false until the first sample of the current shown period exists; the
 * element then stays transparent so a stale or empty fill never fades in. Reduced motion changes opacity at once.
 */
export function ambientFillPresentation(
  visibility: AmbientFillVisibility,
  ready: boolean,
  reducedMotion: boolean,
): AmbientFillPresentation {
  if (visibility === 'hidden') return { display: false, opacity: 0, transitionMs: 0 };
  if (visibility === 'fading')
    return { display: true, opacity: 0, transitionMs: reducedMotion ? 0 : AMBIENT_FILL_FADE_OUT_MS };
  return { display: true, opacity: ready ? 1 : 0, transitionMs: reducedMotion || !ready ? 0 : AMBIENT_FILL_FADE_IN_MS };
}

export interface AmbientFillLayout {
  /** Stage size in CSS pixels; the fill element covers the stage. */
  stage: FillSize;
  /** The picture's rect in stage CSS pixels: the hole the fill never draws into. */
  content: FillRect;
  /** The empty areas around the picture, in stage CSS pixels (only those at least `minBar` wide). */
  bars: FillRect[];
  /** Which sides of the picture have a bar. */
  sides: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  /** Low-resolution drawing buffer covering the stage. */
  buffer: FillSize;
  /** Where the picture lies in buffer pixels. */
  bufferContent: FillRect;
}

export interface AmbientFillLayoutOptions {
  /** Buffer pixels the picture's height maps to: the blur resolution. */
  sampleHeight: number;
  /** Bars narrower than this many CSS pixels do not count (sub-pixel slivers after rounding). */
  minBar?: number;
  /** Upper bound of each buffer dimension. */
  maxBuffer?: number;
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The fill geometry for a picture inside a stage, or null when no bar is wide enough to show anything (the picture
 * fills the stage, as a display-matched match picture does).
 */
export function ambientFillLayout(
  stage: FillSize,
  content: FillRect,
  options: AmbientFillLayoutOptions,
): AmbientFillLayout | null {
  if (!positive(stage.width) || !positive(stage.height) || !positive(content.width) || !positive(content.height))
    return null;
  if (!positive(options.sampleHeight)) return null;
  const minBar = options.minBar ?? 2;
  const maxBuffer = options.maxBuffer ?? 1024;
  const left = Math.max(0, content.x);
  const top = Math.max(0, content.y);
  const right = Math.min(stage.width, content.x + content.width);
  const bottom = Math.min(stage.height, content.y + content.height);
  if (right <= left || bottom <= top) return null;
  const sides = {
    left: left >= minBar,
    right: stage.width - right >= minBar,
    top: top >= minBar,
    bottom: stage.height - bottom >= minBar,
  };
  const bars: FillRect[] = [];
  if (sides.left) bars.push({ x: 0, y: 0, width: left, height: stage.height });
  if (sides.right) bars.push({ x: right, y: 0, width: stage.width - right, height: stage.height });
  if (sides.top) bars.push({ x: left, y: 0, width: right - left, height: top });
  if (sides.bottom) bars.push({ x: left, y: bottom, width: right - left, height: stage.height - bottom });
  if (!bars.length) return null;
  const scale = Math.min(options.sampleHeight / content.height, maxBuffer / stage.width, maxBuffer / stage.height);
  const buffer = {
    // Floating-point products just above a whole number must not add a buffer row or column.
    width: Math.max(1, Math.ceil(stage.width * scale - 1e-6)),
    height: Math.max(1, Math.ceil(stage.height * scale - 1e-6)),
  };
  return {
    stage: { width: stage.width, height: stage.height },
    content: { x: content.x, y: content.y, width: content.width, height: content.height },
    bars,
    sides,
    buffer,
    bufferContent: {
      x: content.x * scale,
      y: content.y * scale,
      width: content.width * scale,
      height: content.height * scale,
    },
  };
}

export interface MirrorTile {
  /** Tile start along the axis. */
  offset: number;
  /** Mirrored about its own centre (every other tile), so each tile edge continues its neighbour's. */
  flipped: boolean;
}

/**
 * Tiles of length `size` starting at `start` (index 0, the picture itself) and repeating outward with alternating
 * mirroring until `[0, extent)` is covered. One mirror covers ordinary wide screens; super-wide stages need more.
 */
export function mirrorTiles(start: number, size: number, extent: number): MirrorTile[] {
  if (!positive(size) || !positive(extent) || !Number.isFinite(start)) return [];
  const first = Math.floor(-start / size);
  const last = Math.ceil((extent - start) / size) - 1;
  const tiles: MirrorTile[] = [];
  for (let index = first; index <= last; index++)
    tiles.push({ offset: start + index * size, flipped: Math.abs(index) % 2 === 1 });
  return tiles;
}

/**
 * The CSS clip path that keeps the fill out of the picture's rect: the stage with the content rect cut out
 * (even-odd rule). Coordinates are CSS pixels of the fill element.
 */
export function ambientFillClipPath(layout: AmbientFillLayout): string {
  const { width, height } = layout.stage;
  const { x, y, width: w, height: h } = layout.content;
  const px = (value: number) => `${Math.round(value * 1000) / 1000}px`;
  return (
    `polygon(evenodd, 0px 0px, ${px(width)} 0px, ${px(width)} ${px(height)}, 0px ${px(height)}, 0px 0px, ` +
    `${px(x)} ${px(y)}, ${px(x + w)} ${px(y)}, ${px(x + w)} ${px(y + h)}, ${px(x)} ${px(y + h)}, ${px(x)} ${px(y)})`
  );
}

/** Darkening of the fill: the share of black at the picture's edge and at the screen edge. */
export interface AmbientFillShade {
  inner: number;
  outer: number;
}

/** Matches the approved mock-up: 55 % brightness beside the picture, 12 % at the screen edge. */
export const AMBIENT_FILL_SHADE: AmbientFillShade = { inner: 0.45, outer: 0.88 };

type Fill2D = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'drawImage'
  | 'save'
  | 'restore'
  | 'translate'
  | 'scale'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'fillRect'
  | 'createLinearGradient'
  | 'setTransform'
> & {
  filter?: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality?: ImageSmoothingQuality;
};

/**
 * Draw the fill into a low-resolution buffer. `mosaic` receives the mirrored tiles of `sample` (the presented
 * picture, already reduced); `target` (the visible buffer, same size as `layout.buffer`) receives the blurred,
 * darkened result. `blurRadius` is in buffer pixels; a context without canvas filters keeps only the softening of the
 * low resolution and its bilinear enlargement.
 */
export function drawAmbientFill(
  target: Fill2D,
  mosaic: Fill2D & { canvas: CanvasImageSource },
  sample: CanvasImageSource,
  layout: AmbientFillLayout,
  blurRadius: number,
  shade: AmbientFillShade = AMBIENT_FILL_SHADE,
): void {
  const { buffer, bufferContent: c } = layout;
  mosaic.setTransform(1, 0, 0, 1, 0, 0);
  mosaic.clearRect(0, 0, buffer.width, buffer.height);
  mosaic.imageSmoothingEnabled = true;
  for (const column of mirrorTiles(c.x, c.width, buffer.width))
    for (const row of mirrorTiles(c.y, c.height, buffer.height)) {
      mosaic.save();
      mosaic.translate(column.offset + (column.flipped ? c.width : 0), row.offset + (row.flipped ? c.height : 0));
      mosaic.scale(column.flipped ? -1 : 1, row.flipped ? -1 : 1);
      mosaic.drawImage(sample, 0, 0, c.width, c.height);
      mosaic.restore();
    }
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.clearRect(0, 0, buffer.width, buffer.height);
  target.imageSmoothingEnabled = true;
  const filtered = typeof target.filter === 'string' && blurRadius > 0;
  if (filtered) target.filter = `blur(${Math.round(blurRadius * 100) / 100}px)`;
  target.drawImage(mosaic.canvas, 0, 0);
  if (filtered) target.filter = 'none';
  // Darken toward each screen edge. The picture's rect is clipped out by the element, so the ramps only need to
  // cover the bars; corners (a picture narrower and shorter than the stage) multiply both ramps.
  const ramp = (x0: number, y0: number, x1: number, y1: number, rect: FillRect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const gradient = target.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, `rgba(0,0,0,${shade.inner})`);
    gradient.addColorStop(1, `rgba(0,0,0,${shade.outer})`);
    target.fillStyle = gradient;
    target.fillRect(rect.x, rect.y, rect.width, rect.height);
  };
  const right = c.x + c.width;
  const bottom = c.y + c.height;
  const { sides } = layout;
  if (sides.left) ramp(c.x, 0, 0, 0, { x: 0, y: 0, width: Math.ceil(c.x), height: buffer.height });
  if (sides.right)
    ramp(right, 0, buffer.width, 0, {
      x: Math.floor(right),
      y: 0,
      width: buffer.width - Math.floor(right),
      height: buffer.height,
    });
  if (sides.top) ramp(0, c.y, 0, 0, { x: 0, y: 0, width: buffer.width, height: Math.ceil(c.y) });
  if (sides.bottom)
    ramp(0, bottom, 0, buffer.height, {
      x: 0,
      y: Math.floor(bottom),
      width: buffer.width,
      height: buffer.height - Math.floor(bottom),
    });
}
