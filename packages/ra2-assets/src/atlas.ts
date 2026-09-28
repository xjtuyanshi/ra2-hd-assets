/**
 * Deterministic shelf packer for texture atlases (pure). Rectangles are sorted by height (then width, then input
 * order) and laid out left-to-right on shelves of a fixed atlas width; the atlas height is the used height rounded
 * up to a multiple of 4. `padding` transparent pixels separate neighbours so bilinear sampling never bleeds.
 */
export interface PackRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackResult {
  width: number;
  height: number;
  rects: PackRect[];
}

/** Pick a power-of-two atlas width that keeps the atlas roughly square (min 256, max 8192). */
export function chooseAtlasWidth(sizes: readonly { w: number; h: number }[], padding: number): number {
  let area = 0;
  let widest = 0;
  for (const s of sizes) {
    area += (s.w + padding) * (s.h + padding);
    widest = Math.max(widest, s.w + 2 * padding);
  }
  let width = 256;
  while (width < 8192 && (width * width < area * 1.15 || width < widest)) width *= 2;
  return width;
}

export function packShelves(sizes: readonly { w: number; h: number }[], padding = 1, width?: number): PackResult {
  const atlasWidth = width ?? chooseAtlasWidth(sizes, padding);
  const order = sizes.map((_, i) => i);
  order.sort((a, b) => sizes[b]!.h - sizes[a]!.h || sizes[b]!.w - sizes[a]!.w || a - b);
  const rects: PackRect[] = new Array(sizes.length);
  let x = padding;
  let y = padding;
  let shelfH = 0;
  for (const i of order) {
    const { w, h } = sizes[i]!;
    if (w + 2 * padding > atlasWidth) throw new RangeError(`rect ${w}x${h} wider than atlas ${atlasWidth}`);
    if (x + w + padding > atlasWidth) {
      x = padding;
      y += shelfH + padding;
      shelfH = 0;
    }
    rects[i] = { x, y, w, h };
    x += w + padding;
    shelfH = Math.max(shelfH, h);
  }
  const used = y + shelfH + padding;
  const height = Math.max(4, Math.ceil(used / 4) * 4);
  return { width: atlasWidth, height, rects };
}
