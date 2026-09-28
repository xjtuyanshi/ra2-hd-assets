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

export interface PagedPackResult {
  pages: { width: number; height: number }[];
  rects: (PackRect & { page: number })[];
}

/**
 * Shelf packing split over pages of at most `maxWidth` x `maxHeight`. Without `groups`, when everything fits one page
 * of the width chooseAtlasWidth picks, the result is exactly packShelves' (page 0). Otherwise rects are laid out in
 * order of (group, height descending, width descending, index) on shelves that continue on a new page whenever the
 * next rect would cross `maxHeight`; pages are `maxWidth` wide (or chooseAtlasWidth's width when one page suffices)
 * and each page's height is its used height rounded up to a multiple of 4. `groups` (one number per rect) keeps
 * related rects together — e.g. all frames of one sprite on as few pages as possible — at some cost in density.
 */
export function packShelvesPaged(
  sizes: readonly { w: number; h: number }[],
  padding: number,
  maxWidth: number,
  maxHeight: number,
  groups?: readonly number[],
): PagedPackResult {
  for (const s of sizes) {
    if (s.w + 2 * padding > maxWidth || s.h + 2 * padding > maxHeight) {
      throw new RangeError(`rect ${s.w}x${s.h} does not fit a ${maxWidth}x${maxHeight} page`);
    }
  }
  const width = Math.min(maxWidth, chooseAtlasWidth(sizes, padding));
  if (!groups) {
    const single = packShelves(sizes, padding, width);
    if (single.height <= maxHeight) {
      return {
        pages: [{ width: single.width, height: single.height }],
        rects: single.rects.map((r) => ({ ...r, page: 0 })),
      };
    }
    return shelvesOverPages(sizes, padding, maxWidth, maxHeight, groups);
  }
  const narrow = shelvesOverPages(sizes, padding, width, maxHeight, groups);
  return narrow.pages.length === 1 ? narrow : shelvesOverPages(sizes, padding, maxWidth, maxHeight, groups);
}

function shelvesOverPages(
  sizes: readonly { w: number; h: number }[],
  padding: number,
  pageWidth: number,
  maxHeight: number,
  groups: readonly number[] | undefined,
): PagedPackResult {
  const order = sizes.map((_, i) => i);
  const g = (i: number): number => groups?.[i] ?? 0;
  order.sort((a, b) => g(a) - g(b) || sizes[b]!.h - sizes[a]!.h || sizes[b]!.w - sizes[a]!.w || a - b);
  const rects: (PackRect & { page: number })[] = new Array(sizes.length);
  const pages: { width: number; height: number }[] = [];
  let page = 0;
  let x = padding;
  let y = padding;
  let shelfH = 0;
  /** Lowest used pixel row (exclusive) of the current page. */
  let bottom = 0;
  const closePage = (): void => {
    pages.push({ width: pageWidth, height: Math.min(maxHeight, Math.max(4, Math.ceil((bottom + padding) / 4) * 4)) });
    bottom = 0;
  };
  for (const i of order) {
    const { w, h } = sizes[i]!;
    if (x + w + padding > pageWidth) {
      x = padding;
      y += shelfH + padding;
      shelfH = 0;
    }
    if (y + Math.max(shelfH, h) + padding > maxHeight) {
      closePage();
      page++;
      x = padding;
      y = padding;
      shelfH = 0;
    }
    rects[i] = { x, y, w, h, page };
    x += w + padding;
    shelfH = Math.max(shelfH, h);
    bottom = Math.max(bottom, y + h);
  }
  closePage();
  return { pages, rects };
}
