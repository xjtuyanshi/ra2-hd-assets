export interface CanvasFitInput {
  stageWidth: number;
  stageHeight: number;
  frameWidth: number;
  frameHeight: number;
  devicePixelRatio: number;
  /**
   * Show every frame pixel as a whole number of device pixels whenever the stage has room for at least two: the scale
   * is rounded down to an integer and the rest of the stage stays empty. Used with a display-matched frame size (see
   * displayMatchedFrameSize), where one frame pixel must cover exactly the device pixels its art was made for. A stage
   * with room for less than two (a window made smaller after the frame size was chosen) is still filled: half the
   * size would be a worse picture than a resampled one.
   */
  integerScale?: boolean;
  /** Fill the available area even when a negotiated art scale would leave margins. */
  fillStage?: boolean;
  /** Requested device scale for a negotiated frame, including fractional HD view choices. */
  preferredScale?: number;
}

export interface CanvasFitResult {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  /** Device pixels per frame pixel of the CSS box. */
  scale: number;
  /** Device pixels per frame pixel that would fill the stage (`scale` is smaller when it was rounded down). */
  fillScale: number;
}

const MIN_BACKING_SCALE = 0.25;
const MAX_BACKING_SCALE = 2;
/**
 * A fit this close above a whole scale uses the whole scale: at most a 1 % border, and the compositor shows the
 * backing store pixel for pixel instead of resampling the whole frame by a fraction of a pixel.
 */
const INTEGER_SNAP = 0.01;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Calculate an equal-aspect canvas size for a stage.
 *
 * CSS dimensions are returned in CSS pixels. Backing dimensions preserve the
 * existing integer supersampling policy so layout scale and render resolution
 * can be changed independently without distorting the VM frame.
 */
export function calculateCanvasFit(input: CanvasFitInput): CanvasFitResult | null {
  if (
    !isPositiveFinite(input.stageWidth) ||
    !isPositiveFinite(input.stageHeight) ||
    !isPositiveFinite(input.frameWidth) ||
    !isPositiveFinite(input.frameHeight) ||
    !isPositiveFinite(input.devicePixelRatio)
  ) {
    return null;
  }

  // Match the integral display raster, including fractional CSS dimensions at browser zoom. Flooring first can
  // lose a whole even-sized game column; fitting against the unrounded CSS extent can then resample a 2x frame.
  const exactScale = Math.min(
    Math.round(input.stageWidth * input.devicePixelRatio) / input.frameWidth,
    Math.round(input.stageHeight * input.devicePixelRatio) / input.frameHeight,
  );
  // CSS must use the exact fit scale. The backing store may stay at the
  // minimum render scale, but flooring the CSS scale would crop tiny stages.
  const whole = Math.floor(exactScale + 1e-9);
  const preferredScale = isPositiveFinite(input.preferredScale ?? Number.NaN) ? input.preferredScale : undefined;
  const cssScale = input.fillStage
    ? exactScale
    : preferredScale !== undefined
      ? Math.min(preferredScale, exactScale)
      : (input.integerScale && whole >= 2) || (whole >= 1 && exactScale - whole <= whole * INTEGER_SNAP)
        ? whole
        : exactScale;
  const backingScale =
    preferredScale !== undefined
      ? cssScale
      : cssScale >= 1
        ? Math.min(MAX_BACKING_SCALE, Math.ceil(cssScale))
        : Math.max(MIN_BACKING_SCALE, cssScale);

  return {
    cssWidth: Math.round(input.frameWidth * cssScale) / input.devicePixelRatio,
    cssHeight: Math.round(input.frameHeight * cssScale) / input.devicePixelRatio,
    backingWidth: Math.max(1, Math.round(input.frameWidth * backingScale)),
    backingHeight: Math.max(1, Math.round(input.frameHeight * backingScale)),
    scale: cssScale,
    fillScale: exactScale,
  };
}

export interface FrameSizeLimits {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface DisplayMatchInput {
  stageWidth: number;
  stageHeight: number;
  devicePixelRatio: number;
  /** Device pixels one frame pixel should cover (e.g. 2 or 2.5 for art made at twice the frame's scale). */
  devicePixelsPerFramePixel: number;
  limits: FrameSizeLimits;
}

/**
 * The largest frame size that fills a stage with every frame pixel at the requested `devicePixelsPerFramePixel` device scale
 * (even numbers, within `limits`). A stage too small for that scale uses a smaller half-step scale; one too small
 * for scale 1 gets the minimum size, and one larger than the maximum gets the maximum (the canvas fit then leaves a
 * border instead of stretching). Null for unusable input.
 */
export function displayMatchedFrameSize(input: DisplayMatchInput): { width: number; height: number } | null {
  const { limits } = input;
  if (
    !isPositiveFinite(input.stageWidth) ||
    !isPositiveFinite(input.stageHeight) ||
    !isPositiveFinite(input.devicePixelRatio) ||
    !Number.isFinite(input.devicePixelsPerFramePixel) ||
    input.devicePixelsPerFramePixel < 1
  ) {
    return null;
  }
  const deviceWidth = Math.round(input.stageWidth * input.devicePixelRatio);
  const deviceHeight = Math.round(input.stageHeight * input.devicePixelRatio);
  for (let scale = input.devicePixelsPerFramePixel; scale >= 1; scale = Math.max(0, scale - 0.5)) {
    const width = Math.min(limits.maxWidth, Math.floor(deviceWidth / scale)) & ~1;
    const height = Math.min(limits.maxHeight, Math.floor(deviceHeight / scale)) & ~1;
    if (width >= limits.minWidth && height >= limits.minHeight) return { width, height };
  }
  return { width: limits.minWidth, height: limits.minHeight };
}
