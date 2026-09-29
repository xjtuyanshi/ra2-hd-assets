/**
 * Lit-window masks detected in original indexed building art (pure, browser-safe). HD night scenes light the windows
 * the artists painted; nothing is repainted, the mask only marks existing window panes.
 *
 * Heuristic (a port of the review prototype, tuned on the urban theater's buildings): a window is a small, compact,
 * upright patch of dark or glass-coloured pixels, fully inside the building's silhouette, with brighter wall above and
 * below it, repeated like facade windows are (hasSiblings). Roofs, shadows and large dark facades fail the size, shape,
 * framing or repetition tests. A pane is lit as a whole: its outline with any enclosed highlight pixels must fill at
 * least PANE_FILL of its bounding box, which is then lit entirely. Fragments that straddle mullions (L, F or E shapes)
 * fail that test, so night facades show regular filled panes instead of glyph-like dark-pixel patterns.
 *
 * Some civilian types paint their windows as larger or slanted dark areas (CAWASH05's window bands, CACHIG's tall
 * mullioned panes, CASTL01's parallelogram panes) that these tests reject, and their few detections are roof vents.
 * When the pane detector covers too little of a frame, detectBuildingWindows switches to a large-pane profile (wider
 * contrast box, larger and slanted panes, a minimum size that leaves rooftop vents and fans dark).
 */

/** Unit-palette indices the stock art uses for glass (blue-grey window ramps). */
export const GLASS_INDICES: readonly number[] = [89, 90, 91, 92, 93, 94, 95, 195, 196, 197, 198, 199];

/**
 * Probability that a detected window is lit. The renderer leaves 15 % of those dark by variant, so about 64 % of a
 * facade's panes glow (concept C lights most panes of every building).
 */
export const WINDOW_LIT_FRACTION = 0.75;
/** Facade share the pane detector must cover before its result is trusted over the large-pane profile. */
export const FALLBACK_COVERAGE = 0.1;

const ERODE = 5;
/** Share of its bounding box a pane (dark pixels plus the highlights they enclose) must fill. */
export const PANE_FILL = 0.6;

/** Tuning of one detection pass (see PANES and LARGE_PANES). */
interface PaneProfile {
  /** Side of the box the local mean luminance is taken over (odd). */
  box: number;
  /** A pixel is dark below this share of its local mean. */
  dark: number;
  minArea: number;
  maxArea: number;
  minSize: number;
  maxWidth: number;
  maxHeight: number;
  /** Lowest height / width of the bounding box. */
  aspect: number;
  fill: number;
  /** How much brighter the wall two pixels above and below must be. */
  framed: number;
  /** Size difference siblings may have. */
  tolerance: number;
  /** Lit panes light their whole bounding box (upright panes) or only their pixels and enclosed highlights. */
  wholeBox: boolean;
  /** roofBottom of the frame: candidates ending above it are on the roof and dropped. */
  roof?: Int16Array | null;
}

/** Small upright panes (the urban theater's usual windows). */
const PANES: PaneProfile = {
  box: 9,
  dark: 0.62,
  minArea: 3,
  maxArea: 90,
  minSize: 1,
  maxWidth: 12,
  maxHeight: 18,
  aspect: 0.75,
  fill: PANE_FILL,
  framed: 1.4,
  tolerance: 1,
  wholeBox: true,
};
/**
 * Large and slanted panes (CASTL01's parallelogram panes, CAWASH05's window bands, CACHIG's tall mullioned panes):
 * a wider mean box so a big pane does not darken its own reference, larger and flatter boxes, parallelogram fill, and
 * a minimum size that leaves roof vents and fans dark. Lit panes keep their own shape.
 */
const LARGE_PANES: PaneProfile = {
  box: 21,
  dark: 0.7,
  minArea: 12,
  maxArea: 360,
  minSize: 4,
  maxWidth: 26,
  maxHeight: 32,
  aspect: 0.4,
  fill: 0.4,
  framed: 1.25,
  tolerance: 3,
  wholeBox: false,
};

/**
 * Detect windows in one frame of indexed art (`indexed[y * w + x]`, 0 = transparent). `lum` holds the luminance
 * (0..255) of each palette index. Returns w * h * 2 bytes: R = 255 on lit window pixels, G = a per-window variant
 * 0..255 (shared by the window's pixels). Frames using palette indices >= 240 (rubble drawn with another palette)
 * are skipped. `rng` returns uniform numbers in [0, 1): the same sequence gives the same mask.
 */
export function detectWindows(
  indexed: Uint8Array,
  w: number,
  h: number,
  lum: Float32Array,
  rng: () => number,
): Uint8Array {
  return detectPanes(indexed, w, h, lum, rng, PANES).mask;
}

/** One detection pass with a profile: the mask plus the bounding-box area of every accepted pane, lit or not. */
function detectPanes(
  indexed: Uint8Array,
  w: number,
  h: number,
  lum: Float32Array,
  rng: () => number,
  profile: PaneProfile,
): { mask: Uint8Array; paneArea: number } {
  const out = new Uint8Array(w * h * 2);
  const n = w * h;
  let paneArea = 0;
  for (let i = 0; i < n; i++) if (indexed[i]! >= 240) return { mask: out, paneArea };
  const glass = new Uint8Array(256);
  for (const g of GLASS_INDICES) glass[g] = 1;

  const opaque = new Uint8Array(n);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = indexed[i]!;
    if (v > 0) {
      opaque[i] = 1;
      L[i] = lum[v]!;
    }
  }

  // Local mean luminance over opaque pixels only (9x9 box, clipped to the frame), via summed-area tables.
  const stride = w + 1;
  const sumL = new Float64Array(stride * (h + 1));
  const sumN = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowL = 0;
    let rowN = 0;
    for (let x = 0; x < w; x++) {
      rowL += L[y * w + x]!;
      rowN += opaque[y * w + x]!;
      sumL[(y + 1) * stride + x + 1] = sumL[y * stride + x + 1]! + rowL;
      sumN[(y + 1) * stride + x + 1] = sumN[y * stride + x + 1]! + rowN;
    }
  }
  const box = (table: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    table[y1 * stride + x1]! - table[y0 * stride + x1]! - table[y1 * stride + x0]! + table[y0 * stride + x0]!;
  const half = (profile.box - 1) / 2;
  const dark = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!opaque[i]) continue;
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w, x + half + 1);
      const mean = box(sumL, x0, y0, x1, y1) / Math.max(1, box(sumN, x0, y0, x1, y1));
      if ((L[i]! < profile.dark * mean || glass[indexed[i]!]) && L[i]! < 110) dark[i] = 1;
    }
  }

  // Opaque region eroded by 5x5, with everything outside the frame counting as transparent.
  const inner = new Uint8Array(n);
  const r = (ERODE - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !opaque[yy * w + xx]) {
            all = 0;
            break;
          }
        }
      }
      inner[y * w + x] = all;
    }
  }

  // 4-connected components of dark pixels, in scan order.
  const label = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const candidates: Candidate[] = [];
  for (let start = 0; start < n; start++) {
    if (!dark[start] || label[start] !== -1) continue;
    const pixels: number[] = [];
    label[start] = start;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const px = p % w;
      const py = (p - px) / w;
      const visit = (q: number) => {
        if (dark[q] && label[q] === -1) {
          label[q] = start;
          stack.push(q);
        }
      };
      if (px > 0) visit(p - 1);
      if (px < w - 1) visit(p + 1);
      if (py > 0) visit(p - w);
      if (py < h - 1) visit(p + w);
    }
    const box = windowBox(pixels, w, h, L, inner, profile);
    const roofAt = box && profile.roof ? profile.roof[Math.round(box.x + (box.w - 1) / 2)]! : -1;
    if (box && box.y + box.h - 1 > roofAt) candidates.push({ pixels, ...box });
  }
  for (const c of candidates) {
    if (!hasSiblings(c, candidates, profile.tolerance)) continue;
    paneArea += c.w * c.h;
    const lit = rng() < WINDOW_LIT_FRACTION;
    const variant = Math.min(255, Math.floor(rng() * 256));
    if (!lit) continue;
    if (!profile.wholeBox) {
      for (const p of paneFill(c.pixels, w, c.x, c.y, c.w, c.h)) {
        out[p * 2] = 255;
        out[p * 2 + 1] = variant;
      }
      continue;
    }
    // The whole pane: every opaque pixel of the bounding box.
    for (let y = c.y; y < c.y + c.h; y++) {
      for (let x = c.x; x < c.x + c.w; x++) {
        const p = y * w + x;
        if (!opaque[p]) continue;
        out[p * 2] = 255;
        out[p * 2 + 1] = variant;
      }
    }
  }
  return { mask: out, paneArea };
}

/**
 * Lit-window mask of one building frame: the pane detector (PANES), or the large-pane profile (LARGE_PANES) where the
 * pane detector covers less than FALLBACK_COVERAGE of the frame's facade (estimated as half its opaque pixels) and the
 * large-pane profile finds clearly more (1.5x the pane area). `mode` forces one profile (a damaged frame follows its
 * healthy frame's choice, so both light the same windows).
 */
export function detectBuildingWindows(
  indexed: Uint8Array,
  w: number,
  h: number,
  lum: Float32Array,
  rng: () => number,
  options: { mode?: 'panes' | 'large'; roof?: Int16Array | null } = {},
): { mask: Uint8Array; mode: 'panes' | 'large' } {
  let chosen = options.mode;
  const large = { ...LARGE_PANES, roof: options.roof ?? null };
  if (!chosen) {
    // Coverage counts every accepted pane, lit or not, so the probes run without consuming the random sequence.
    const panes = detectPanes(indexed, w, h, lum, () => 0, PANES).paneArea;
    let opaque = 0;
    for (let i = 0; i < w * h; i++) if (indexed[i]) opaque++;
    const probe = panes < FALLBACK_COVERAGE * 0.5 * opaque ? detectPanes(indexed, w, h, lum, () => 0, large) : null;
    chosen = probe && probe.paneArea > 1.5 * panes ? 'large' : 'panes';
  }
  const profile = chosen === 'large' ? large : PANES;
  return { mask: detectPanes(indexed, w, h, lum, rng, profile).mask, mode: chosen };
}

/**
 * Lowest roof pixel per frame column of a building on a w x h foundation, or -1 where unknown: the silhouette's top at
 * that column plus the depth of the building's roof diamond there. The diamond spans the silhouette's width (art is
 * often smaller than its foundation) with the foundation's proportions, so its depth at column X is
 * min(X - left, right - X, width * min(w, h) / (w + h)). A flat roof seen from the fixed camera spans that depth below
 * its far edge, so a window candidate ending above this line lies on the roof (vents, fans, AC units). Rooftop
 * structures and upper tiers raise the silhouette top, which only moves the line up (they are never taken for roof).
 */
export function roofBottom(
  indexed: Uint8Array,
  w: number,
  h: number,
  foundation: readonly [number, number],
): Int16Array {
  const out = new Int16Array(w).fill(-1);
  const top = new Int16Array(w).fill(-1);
  const run = new Int16Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!indexed[y * w + x]) continue;
      if (top[x]! < 0) top[x] = y;
      run[x]!++;
    }
  }
  let left = 0;
  while (left < w && run[left]! < 4) left++;
  let right = w - 1;
  while (right >= 0 && run[right]! < 4) right--;
  if (right - left < 8) return out;
  const [fw, fh] = foundation;
  const plateau = ((right - left) * Math.min(fw, fh)) / Math.max(1, fw + fh);
  for (let x = left; x <= right; x++) {
    if (top[x]! < 0) continue;
    out[x] = Math.round(top[x]! + Math.min(x - left, right - x, plateau));
  }
  return out;
}

/** Pixels of a component plus the holes it encloses (see filledArea). */
function paneFill(pixels: readonly number[], w: number, x0: number, y0: number, bw: number, bh: number): number[] {
  const inside = new Uint8Array(bw * bh);
  for (const p of pixels) {
    const x = p % w;
    const y = (p - x) / w;
    inside[(y - y0) * bw + (x - x0)] = 1;
  }
  const outside = floodOutside(inside, bw, bh);
  const out: number[] = [];
  for (let i = 0; i < inside.length; i++) if (!outside[i]) out.push((y0 + Math.floor(i / bw)) * w + x0 + (i % bw));
  return out;
}

/**
 * Lit panes of a frame mask grouped into columns: [centre x, lit panes, lowest lit pixel y] per column, frame-relative
 * and sorted by x. Panes are 4-connected lit regions; panes whose centres lie within 3 pixels share a column.
 * Renderers place wet-ground reflections under the columns (one per column, stronger with more panes).
 */
export function windowColumns(
  mask: Uint8Array,
  maskWidth: number,
  rect: readonly [number, number, number, number],
  channels = 2,
): [x: number, panes: number, bottom: number][] {
  const [rx, ry, rw, rh] = rect;
  const lit = (x: number, y: number) => mask[((ry + y) * maskWidth + rx + x) * channels]! > 0;
  const seen = new Uint8Array(rw * rh);
  const panes: { x: number; bottom: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < rw * rh; start++) {
    if (seen[start] || !lit(start % rw, Math.floor(start / rw))) continue;
    seen[start] = 1;
    stack.push(start);
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % rw;
      const y = (p - x) / rw;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const q = ny * rw + nx;
        if (!seen[q] && lit(nx, ny)) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    panes.push({ x: (minX + maxX) / 2, bottom: maxY });
  }
  panes.sort((a, b) => a.x - b.x);
  const columns: [number, number, number][] = [];
  for (const p of panes) {
    const last = columns[columns.length - 1];
    if (last && p.x - last[0] <= 3) {
      last[0] = (last[0] * last[1] + p.x) / (last[1] + 1);
      last[1]++;
      last[2] = Math.max(last[2], p.bottom);
    } else columns.push([p.x, 1, p.bottom]);
  }
  return columns.map(([x, count, bottom]) => [Math.round(x * 10) / 10, count, bottom]);
}

/**
 * Pixels of a component plus the holes it encloses, counted inside its bounding box: bounding-box pixels not in the
 * component and not reachable from the box border through non-component pixels are holes (a pane's highlight inside
 * its dark outline).
 */
function filledArea(pixels: readonly number[], w: number, x0: number, y0: number, bw: number, bh: number): number {
  const inside = new Uint8Array(bw * bh);
  for (const p of pixels) {
    const x = p % w;
    const y = (p - x) / w;
    inside[(y - y0) * bw + (x - x0)] = 1;
  }
  const outside = floodOutside(inside, bw, bh);
  let n = 0;
  for (let i = 0; i < inside.length; i++) if (!outside[i]) n++;
  return n;
}

/** Box pixels outside `inside` that are reachable from the box border through other outside pixels. */
function floodOutside(inside: Uint8Array, bw: number, bh: number): Uint8Array {
  const outside = new Uint8Array(bw * bh);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!inside[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < bw; x++) {
    seed(x);
    seed((bh - 1) * bw + x);
  }
  for (let y = 0; y < bh; y++) {
    seed(y * bw);
    seed(y * bw + bw - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % bw;
    const y = (i - x) / bw;
    if (x > 0) seed(i - 1);
    if (x < bw - 1) seed(i + 1);
    if (y > 0) seed(i - bw);
    if (y < bh - 1) seed(i + bw);
  }
  return outside;
}

interface Candidate {
  pixels: number[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Facades repeat their windows: a window has a same-sized neighbour straight above or below it (the next floor), or
 * two along one of the facade's 2:1 isometric diagonals (the same floor). Isolated dark specks (roof vents, rubble,
 * signs) have neither.
 */
function hasSiblings(c: Candidate, all: readonly Candidate[], tolerance = 1): boolean {
  let diagonal = 0;
  for (const o of all) {
    if (o === c || Math.abs(o.w - c.w) > tolerance || Math.abs(o.h - c.h) > tolerance + 1) continue;
    const dx = o.x - c.x;
    const dy = o.y - c.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) >= 3 && Math.abs(dy) <= 48) return true;
    if (Math.abs(dx) >= 3 && Math.abs(dx) <= 40 && Math.min(Math.abs(dy - dx / 2), Math.abs(dy + dx / 2)) <= 2)
      diagonal++;
  }
  return diagonal >= 2;
}

function windowBox(
  pixels: number[],
  w: number,
  h: number,
  L: Float32Array,
  inner: Uint8Array,
  profile: PaneProfile,
): { x: number; y: number; w: number; h: number } | null {
  const area = pixels.length;
  // PANES: up to two-pane windows (about 10 x 14 pixels with a dark mullion cross).
  if (area < profile.minArea || area > profile.maxArea) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sum = 0;
  for (const p of pixels) {
    const x = p % w;
    const y = (p - x) / w;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    sum += L[p]!;
    if (!inner[p]) return null;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // Upright or square-ish for PANES (isometric facades slant their windows into parallelograms); long horizontal
  // slits are ledge shadows.
  if (bw < profile.minSize || bh < profile.minSize) return null;
  if (bw > profile.maxWidth || bh > profile.maxHeight || bh < bw * profile.aspect) return null;
  if (filledArea(pixels, w, minX, minY, bw, bh) / (bw * bh) < profile.fill) return null;
  // Framed: the rows two pixels above and below (same columns) are clearly brighter than the window.
  const mean = sum / area;
  const top = Math.max(minY - 2, 0);
  const bottom = Math.min(maxY + 2, h - 1);
  let above = 0;
  let below = 0;
  for (const p of pixels) {
    const x = p % w;
    above += L[top * w + x]!;
    below += L[bottom * w + x]!;
  }
  const framed = profile.framed * mean;
  return above / area >= framed && below / area >= framed ? { x: minX, y: minY, w: bw, h: bh } : null;
}

/** Lit pixel count and centroid (frame-relative) of a mask region `rect` = [x, y, w, h] in a mask `maskWidth` wide. */
export function windowStats(
  mask: Uint8Array,
  maskWidth: number,
  rect: readonly [number, number, number, number],
  channels = 2,
): { lit: number; centroid: [number, number] } {
  const [rx, ry, rw, rh] = rect;
  let lit = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (mask[((ry + y) * maskWidth + rx + x) * channels]! > 0) {
        lit++;
        sx += x;
        sy += y;
      }
    }
  }
  return { lit, centroid: lit ? [sx / lit, sy / lit] : [rw / 2, rh / 2] };
}

/** Small deterministic PRNG (mulberry32) for reproducible masks. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string (FNV-1a). */
export function stringSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
