/** A rectangle on whole device pixels: `left`/`top`/`width`/`height` in device pixels of the viewport. */
export interface DevicePixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** CSS position and size for an absolutely positioned element in the same positioned parent as the canvas. */
  style: { left: string; top: string; width: string; height: string };
}

/**
 * The game canvas's box in CSS pixels: `left`/`top` in the viewport (what whole device pixels are counted from) and the
 * origin of its positioned parent (what an absolutely positioned sibling's style is relative to). offsetLeft and
 * clientWidth round to whole CSS pixels, which is up to half a pixel off for a canvas fitted to device pixels.
 */
function canvasBox(canvas: HTMLCanvasElement): {
  left: number;
  top: number;
  width: number;
  height: number;
  parentLeft: number;
  parentTop: number;
} {
  const parent = canvas.offsetParent;
  if (typeof canvas.getBoundingClientRect !== 'function' || !parent) {
    return {
      left: canvas.offsetLeft,
      top: canvas.offsetTop,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      parentLeft: 0,
      parentTop: 0,
    };
  }
  const box = canvas.getBoundingClientRect();
  const outer = parent.getBoundingClientRect();
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    parentLeft: outer.left + parent.clientLeft,
    parentTop: outer.top + parent.clientTop,
  };
}

/**
 * Where a rectangle of the game frame (frame pixels; the whole frame by default) lies over the fitted game canvas,
 * with its edges rounded to whole device pixels. An overlay canvas laid out with `style` and given a drawing buffer of
 * `width` x `height` shows one buffer pixel per device pixel: the compositor does not resample it. A CSS box a fraction
 * of a device pixel larger than its buffer would be resampled, which softens the whole overlay.
 */
export function devicePixelBox(
  canvas: HTMLCanvasElement,
  frame: { width: number; height: number },
  devicePixelRatio: number,
  rect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, ...frame },
): DevicePixelBox {
  const box = canvasBox(canvas);
  const scaleX = box.width / frame.width;
  const scaleY = box.height / frame.height;
  const left = Math.round((box.left + rect.x * scaleX) * devicePixelRatio);
  const top = Math.round((box.top + rect.y * scaleY) * devicePixelRatio);
  const width = Math.max(1, Math.round((box.left + (rect.x + rect.width) * scaleX) * devicePixelRatio) - left);
  const height = Math.max(1, Math.round((box.top + (rect.y + rect.height) * scaleY) * devicePixelRatio) - top);
  return {
    left,
    top,
    width,
    height,
    style: {
      left: `${left / devicePixelRatio - box.parentLeft}px`,
      top: `${top / devicePixelRatio - box.parentTop}px`,
      width: `${width / devicePixelRatio}px`,
      height: `${height / devicePixelRatio}px`,
    },
  };
}
