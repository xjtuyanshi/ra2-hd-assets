import type { MenuControlSnapshot } from '../../../vm86/menuSnapshot';

type Rect = MenuControlSnapshot['rect'];

/**
 * Source-shaped YR set-up slider (`sliderSkin: "vector-v1"`), drawn as fills and
 * gradients at output resolution. Every colour is the original game's own pixel
 * value (RGB565 expanded) from the skirmish set-up picture: the page and the
 * original picture then pass through the same display conversion, so values
 * read off a screenshot would be converted twice. The result is accepted only by
 * device-resolution tone review against the original (docs/remaster/HD_MENUS.md).
 *
 * Geometry is the game's: the bevel sits two pixels outside the control, the
 * groove/plate divider follows the groove's right edge and the thumb is the
 * native thumb rectangle, whose picture is the same at every position, under
 * the pointer and while dragged. Nothing here receives input.
 */
const FRAME_LIGHT = '#a5bec6';
const FRAME_DARK = '#6b7984';
/** Where a light and a dark bevel line cross, the source has this mixed pixel. */
const FRAME_CROSSING = '#849ea5';
/**
 * The groove is the background seen through a translucent shade. Its strength
 * is pooled over the three set-up grooves against the calibrated HD background,
 * whose local brightness itself differs from the original by up to ~12%.
 */
const GROOVE_SHADE = 'rgba(8,6,20,0.133)';
/**
 * The value plate is a red darkened toward its rim. The source's quantized
 * bands fit (RMS 3.0 of 88 red levels, near the 5-bit quantization; three
 * plates, digits excluded) a factor of the anisotropic distance `d` from an
 * inner rectangle inset `left`/`right`/`top`/`bottom` source pixels, vertical
 * distances divided by `vertical`; `profile` is the factor at d = 0, 1, 2 ...
 */
const PLATE = [88, 0, 0] as const;
export const MENU_SLIDER_PLATE = {
  left: 7,
  right: 7,
  top: 9,
  bottom: 10,
  vertical: 1.6,
  profile: [1, 1, 0.923, 0.825, 0.619, 0.462, 0.363, 0.289, 0.268, 0.268],
} as const;
/** Mean of the source's 1-pixel red thumb border. */
const THUMB_BORDER = '#b40000';
/** Ten interior columns per band (rows from the top), from the thumb's lit cylinder. */
const THUMB_BANDS: { rows: number; columns: string[] }[] = [
  {
    rows: 1,
    columns: [
      '#080c08',
      '#212021',
      '#292829',
      '#313431',
      '#424542',
      '#313439',
      '#212829',
      '#212021',
      '#101410',
      '#080808',
    ],
  },
  {
    rows: 1,
    columns: [
      '#212829',
      '#7b7d84',
      '#c6cbce',
      '#efebef',
      '#f7f7f7',
      '#e7e7e7',
      '#bdc3c6',
      '#848a8c',
      '#313439',
      '#101418',
    ],
  },
  {
    rows: 1,
    columns: [
      '#181818',
      '#5a5d63',
      '#94969c',
      '#c6cbce',
      '#e7e3e7',
      '#bdbec6',
      '#8c8e94',
      '#52595a',
      '#293031',
      '#081418',
    ],
  },
  {
    rows: 15,
    columns: [
      '#101818',
      '#52595a',
      '#84868c',
      '#adaeb5',
      '#c6cbce',
      '#adaeb5',
      '#84868c',
      '#52595a',
      '#293031',
      '#081010',
    ],
  },
  {
    rows: 1,
    columns: [
      '#292c31',
      '#6b6d73',
      '#b5b2b5',
      '#e7e7e7',
      '#efeff7',
      '#e7e7e7',
      '#c6cbce',
      '#7b7d84',
      '#393c42',
      '#081010',
    ],
  },
  {
    rows: 1,
    columns: [
      '#081010',
      '#212829',
      '#313439',
      '#394142',
      '#52555a',
      '#393c42',
      '#313031',
      '#212429',
      '#080c10',
      '#000400',
    ],
  },
];

export interface MenuSliderParts {
  groove: Rect;
  thumb: Rect;
  /** The value plate right of the groove, inside the bevel. */
  plate: Rect;
}

/**
 * Only the observed geometry is redrawn: a 22-pixel control with a 12x22 thumb
 * inside a groove that leaves a plate to its right. Anything else keeps the
 * complete original control.
 */
export function menuSliderParts(control: MenuControlSnapshot): MenuSliderParts | null {
  const r = control.rect;
  const groove = control.slider?.groove;
  const thumb = control.slider?.thumb;
  if (!groove || !thumb || !control.enabled) return null;
  const divider = groove.x + groove.width;
  const plate = { x: divider + 2, y: r.y, width: r.x + r.width - divider - 2, height: r.height };
  if (
    r.height !== 22 ||
    groove.x !== r.x ||
    groove.y !== r.y ||
    groove.height !== r.height ||
    thumb.width !== 12 ||
    thumb.height !== r.height ||
    thumb.y !== r.y ||
    thumb.x < groove.x ||
    thumb.x + thumb.width > divider ||
    plate.width < 16
  )
    return null;
  return { groove, thumb, plate };
}

function drawFrame(ctx: CanvasRenderingContext2D, r: Rect, divider: number): void {
  const { x, y, width: w, height: h } = r;
  // Two offset outlines: light from (x-2, y-2) to (x+w, y+h), dark one pixel down-right.
  ctx.fillStyle = FRAME_DARK;
  ctx.fillRect(x - 1, y - 1, w + 1, 1);
  ctx.fillRect(x - 1, y - 1, 1, h + 1);
  ctx.fillRect(x - 1, y + h + 1, w + 3, 1);
  ctx.fillRect(x + w + 1, y - 1, 1, h + 3);
  ctx.fillRect(divider + 1, y - 1, 1, h + 1);
  ctx.fillStyle = FRAME_LIGHT;
  ctx.fillRect(x - 2, y - 2, w + 3, 1);
  ctx.fillRect(x - 2, y + h, w + 3, 1);
  ctx.fillRect(x - 2, y - 2, 1, h + 3);
  ctx.fillRect(x + w, y - 2, 1, h + 3);
  ctx.fillRect(divider, y - 2, 1, h + 3);
  ctx.fillStyle = FRAME_CROSSING;
  for (const [cx, cy] of [
    [x + w + 1, y - 2],
    [x + w, y - 1],
    [x - 2, y + h + 1],
    [x - 1, y + h],
    [divider + 1, y + h],
  ] as const)
    ctx.fillRect(cx, cy, 1, 1);
}

/** Plate rim factor at plate-local source coordinates (u, v), 1 on the flat interior. */
export function menuSliderPlateFactor(u: number, v: number, width: number, height: number): number {
  const m = MENU_SLIDER_PLATE;
  const dx = Math.max(m.left - u, 0, u - (width - m.right));
  const dy = Math.max(m.top - v, 0, v - (height - m.bottom)) / m.vertical;
  const d = Math.min(Math.hypot(dx, dy), m.profile.length - 1);
  const i = Math.min(Math.floor(d), m.profile.length - 2);
  return m.profile[i]! + (m.profile[i + 1]! - m.profile[i]!) * (d - i);
}

/**
 * Evaluate the plate once per device pixel of its covered box (with fractional
 * edge coverage), so the rim is continuous at any output scale.
 */
export function menuSliderPlatePixels(
  plate: Rect,
  scaleX: number,
  scaleY: number,
  originX = 0,
  originY = 0,
): { x: number; y: number; width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const left = originX + plate.x * scaleX;
  const top = originY + plate.y * scaleY;
  const right = left + plate.width * scaleX;
  const bottom = top + plate.height * scaleY;
  const x = Math.floor(left);
  const y = Math.floor(top);
  const width = Math.ceil(right) - x;
  const height = Math.ceil(bottom) - y;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const coverY = Math.min(y + row + 1, bottom) - Math.max(y + row, top);
    const v = (y + row + 0.5 - top) / scaleY;
    for (let column = 0; column < width; column++) {
      const coverX = Math.min(x + column + 1, right) - Math.max(x + column, left);
      const factor = menuSliderPlateFactor((x + column + 0.5 - left) / scaleX, v, plate.width, plate.height);
      const offset = (row * width + column) * 4;
      data[offset] = PLATE[0] * factor;
      data[offset + 1] = PLATE[1] * factor;
      data[offset + 2] = PLATE[2] * factor;
      data[offset + 3] = 255 * Math.max(0, Math.min(1, coverX)) * Math.max(0, Math.min(1, coverY));
    }
  }
  return { x, y, width, height, data };
}

type PlateSurface = { x: number; y: number; image: CanvasImageSource };
const plateSurfaces = new Map<string, PlateSurface>();

/** A cached device-resolution plate, or null when this page cannot build one. */
function plateSurface(ctx: CanvasRenderingContext2D, plate: Rect): PlateSurface | null {
  const transform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  if (!transform || transform.b || transform.c || !(transform.a > 0) || !(transform.d > 0)) return null;
  if (typeof OffscreenCanvas !== 'function' || typeof ImageData !== 'function') return null;
  const key = [plate.x, plate.y, plate.width, plate.height, transform.a, transform.d, transform.e, transform.f].join();
  const cached = plateSurfaces.get(key);
  if (cached) return cached;
  const pixels = menuSliderPlatePixels(plate, transform.a, transform.d, transform.e, transform.f);
  const surface = new OffscreenCanvas(pixels.width, pixels.height);
  const context = surface.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
  // Three plates per screen; a resize or another screen replaces the set.
  if (plateSurfaces.size >= 12) plateSurfaces.clear();
  const result = { x: pixels.x, y: pixels.y, image: surface };
  plateSurfaces.set(key, result);
  return result;
}

function drawThumb(ctx: CanvasRenderingContext2D, t: Rect): void {
  ctx.fillStyle = THUMB_BORDER;
  ctx.fillRect(t.x, t.y, t.width, t.height);
  const inner = { x: t.x + 1, y: t.y + 1, width: t.width - 2 };
  let row = inner.y;
  for (const band of THUMB_BANDS) {
    // Column colours sit at pixel centres, so the cylinder is continuous at device scale.
    const gradient = ctx.createLinearGradient(inner.x, 0, inner.x + inner.width, 0);
    band.columns.forEach((color, index) => gradient.addColorStop((index + 0.5) / inner.width, color));
    ctx.fillStyle = gradient;
    ctx.fillRect(inner.x, row, inner.width, band.rows);
    row += band.rows;
  }
}

/**
 * Draw the whole slider except its value text, which the caller fits into
 * `plate`. Returns false, having drawn nothing, when the plate cannot be built.
 */
export function drawMenuSlider(
  ctx: CanvasRenderingContext2D,
  control: MenuControlSnapshot,
  parts: MenuSliderParts,
): boolean {
  const plate = plateSurface(ctx, parts.plate);
  if (!plate) return false;
  const r = control.rect;
  const divider = parts.groove.x + parts.groove.width;
  ctx.fillStyle = GROOVE_SHADE;
  ctx.fillRect(r.x, r.y, divider - r.x, r.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(plate.image, plate.x, plate.y);
  ctx.restore();
  drawFrame(ctx, r, divider);
  drawThumb(ctx, parts.thumb);
  return true;
}
