import { DataTexture, LinearFilter, RGFormat, UnsignedByteType } from 'three/webgpu';
import { float, smoothstep } from 'three/tsl';
import type { VisibilityMask } from '../HdRenderer';
import type { ShaderNode } from '../tsl';

/** Per-cell state as the live reader reports it: 0 = shroud, 1 = fog, 2 = visible, 0xff = no cell. */
export interface ShroudCells {
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: Uint8Array;
}

const VISIBLE = 2;
const FOGGED = 1;
const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/**
 * The edge curve: lit = smoothstep(0.5 + EDGE_INSET - EDGE_SOFTNESS, 0.5 + EDGE_INSET + EDGE_SOFTNESS, corner field),
 * renormalised so a fully shrouded corner stays black (and, with these values, a fully revealed one fully lit). The
 * field rises by 1 across the first revealed cell, so this is a soft fade over that cell, darker near the shroud.
 * Fitted against 40 frozen same-moment original captures of two XMP29U2 skirmishes with the HD picture as it is drawn
 * (overlay pass after bloom and the renderer's display transform; the HD frame without the shroud layer composited
 * with each candidate): 0 / 0.45 leaves 0.31 % of the view black only in the original and 0.36 % black only in HD,
 * with a mean luma error of 12.8 levels across the edge band (the previous -0.1 / 0.6: 1.41 %, 0.22 % and 18.7). A
 * hard edge at the same spot scores similarly on black pixels but misses the original's soft falloff. The rest is
 * the engine's irregular edge pieces, which no smooth field reproduces.
 */
export const EDGE_INSET = 0;
export const EDGE_SOFTNESS = 0.45;
/** Fog darkens to half, like the engine's FOG.SHP. */
const FOG_DARKNESS = 0.5;

/**
 * Corner field of the shroud: corner (i, j) (between cells i - 1..i and j - 1..j) holds, per channel, whether ALL
 * four cells around it are mapped (R: not shrouded) and visible (G: not fogged). Missing cells count as shrouded.
 * Pure, for tests: returns (width + 1) x (height + 1) RG bytes (255 = yes).
 */
export function shroudCorners(
  width: number,
  height: number,
  state: (x: number, y: number) => number,
  out = new Uint8Array((width + 1) * (height + 1) * 2),
  flags = new Uint8Array((width + 2) * (height + 2)),
): Uint8Array {
  for (let y = -1; y <= height; y++)
    for (let x = -1; x <= width; x++) flags[(y + 1) * (width + 2) + x + 1] = cellFlags(state(x, y));
  cornersFromFlags(flags, width, height, out);
  return out;
}

/** Bit 0: mapped (visible or fogged), bit 1: visible. */
function cellFlags(state: number): number {
  return state === VISIBLE ? 3 : state === FOGGED ? 1 : 0;
}

/**
 * Corners from per-cell flags on a grid padded by one cell on every side ((width + 2) x (height + 2), cell (x, y) at
 * (x + 1, y + 1)): a corner keeps a flag only when all four cells around it have it. Integer work only.
 */
function cornersFromFlags(
  flags: Uint8Array,
  width: number,
  height: number,
  out: Uint8Array,
  x0 = 0,
  y0 = 0,
  x1 = width,
  y1 = height,
): void {
  const stride = width + 2;
  for (let j = y0; j <= y1; j++) {
    let top = j * stride + x0;
    let bottom = top + stride;
    let o = (j * (width + 1) + x0) * 2;
    for (let i = x0; i <= x1; i++, o += 2, top++, bottom++) {
      const all = flags[top]! & flags[top + 1]! & flags[bottom]! & flags[bottom + 1]!;
      out[o] = all & 1 ? 255 : 0;
      out[o + 1] = all & 2 ? 255 : 0;
    }
  }
}

/**
 * Opacity of the shroud layer for corner-field samples `m` (mapped) and `v` (visible) in 0..1: a sharpened edge
 * around EDGE_INSET, fog at half darkness. Mirrors the shader, for tests and offline fitting.
 */
export function shroudOpacity(m: number, v: number, inset = EDGE_INSET, k = EDGE_SOFTNESS): number {
  const step = (x: number) => {
    const c = 0.5 + inset;
    const t = Math.min(1, Math.max(0, (x - (c - k)) / (2 * k)));
    return t * t * (3 - 2 * t);
  };
  const s0 = step(0);
  const s = (x: number) => Math.max(0, (step(x) - s0) / (1 - s0));
  const shroud = 1 - s(m);
  const fog = FOG_DARKNESS * (1 - s(v));
  return 1 - (1 - shroud) * (1 - fog);
}

/**
 * Visibility (1 - shroudOpacity) of the filtered corner field in the shader: R = mapped, G = visible. Renormalised so a
 * fully shrouded corner (field 0) stays completely black. The renderer multiplies the scene's linear light by it before
 * tone mapping; on frozen live pairs of HEAD's post pass that matched the original's edge band within 0.12 mean
 * visibility (HD 0.03-0.06 lighter), while applying it as a display-space factor (visibility^2.2) made the band 0.16
 * too dark and tripled the pixels black only in HD.
 */
export function shroudVisibility(field: ShaderNode): ShaderNode {
  const c = 0.5 + EDGE_INSET;
  const lo = c - EDGE_SOFTNESS;
  const hi = c + EDGE_SOFTNESS;
  const t0 = Math.min(1, Math.max(0, -lo / (hi - lo)));
  const s0 = t0 * t0 * (3 - 2 * t0);
  const lit = (x: ShaderNode): ShaderNode =>
    smoothstep(lo, hi, x)
      .sub(s0)
      .div(1 - s0)
      .max(0);
  const fog: ShaderNode = float(FOG_DARKNESS).mul(float(1).sub(lit(field.g)));
  return lit(field.r).mul(float(1).sub(fog));
}

/**
 * The local player's shroud and fog, applied like the engine: a darkening layer on the flat Z = 0 plane (not following
 * the terrain) that covers terrain, objects and effects alike. On an elevated map a cell's shroud therefore lands on
 * the terrain one row "behind" it on screen, exactly as in the original. The edge comes from a per-corner field (a
 * corner is lit only when all four cells around it are), filtered linearly and sharpened, which puts the black
 * boundary where the engine's edge pieces put it (see EDGE_INSET).
 *
 * The layer is a visibility mask (`mask`) the HD renderer applies in its post pass (HdRenderer.setVisibility), after
 * the mist and before bloom: drawn inside the scene it would sit under the mist, whose light-field glow would then show
 * lit buildings and lamps through black shroud, and bloom would bleed out of it.
 */
export class ShroudLayer {
  /** RG corner field: texel (i, j) is corner (i, j) at world (i, j); R mapped, G visible (255 = yes). */
  readonly texture: DataTexture;
  /** The corner field as the renderer's post-pass visibility mask (see visibility()). */
  readonly mask: VisibilityMask;
  private readonly data: Uint8Array;
  private latest: ShroudCells | null = null;
  /** Per-cell flags on the padded grid (see cornersFromFlags), reused by every update. */
  private readonly flags: Uint8Array;
  /** Copy of the last applied cells, to skip unchanged updates. */
  private applied: ShroudCells | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    // Until the first update everything is visible (no shroud information yet).
    this.data = new Uint8Array((width + 1) * (height + 1) * 2).fill(255);
    this.flags = new Uint8Array((width + 2) * (height + 2));
    this.texture = new DataTexture(this.data, width + 1, height + 1, RGFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.needsUpdate = true;
    // Texel (i, j) is centred on world (i, j), so the texture spans world -0.5 .. width + 0.5 edge to edge.
    this.mask = {
      texture: this.texture,
      origin: [-0.5, -0.5],
      size: [width + 1, height + 1],
      shape: shroudVisibility,
    };
  }

  /** Apply the reader's cells (once per logic frame at most); an unchanged shroud costs one comparison. */
  update(shroud: ShroudCells): void {
    this.latest = shroud;
    let applied = this.applied;
    const { width, height, flags } = this;
    if (
      applied &&
      applied.originX === shroud.originX &&
      applied.originY === shroud.originY &&
      applied.width === shroud.width &&
      applied.height === shroud.height &&
      applied.cells.length === shroud.cells.length
    ) {
      // Usually only a few cells change. Update their flags and the containing corner rectangle in place.
      let x0 = width + 1,
        y0 = height + 1,
        x1 = -1,
        y1 = -1;
      for (let i = 0; i < shroud.cells.length; i++) {
        const state = shroud.cells[i]!;
        if (applied.cells[i] === state) continue;
        applied.cells[i] = state;
        const x = (i % shroud.width) + shroud.originX;
        const y = Math.floor(i / shroud.width) + shroud.originY;
        if (x < -1 || y < -1 || x > width || y > height) continue;
        const offset = (y + 1) * (width + 2) + x + 1;
        const next = cellFlags(state);
        if (flags[offset] === next) continue;
        flags[offset] = next;
        x0 = Math.min(x0, Math.max(0, x));
        y0 = Math.min(y0, Math.max(0, y));
        x1 = Math.max(x1, Math.min(width, x + 1));
        y1 = Math.max(y1, Math.min(height, y + 1));
      }
      if (x1 >= x0 && y1 >= y0) {
        cornersFromFlags(flags, width, height, this.data, x0, y0, x1, y1);
        this.texture.needsUpdate = true;
      }
      return;
    }
    if (!applied || applied.cells.length !== shroud.cells.length) {
      applied = { ...shroud, cells: new Uint8Array(shroud.cells.length) };
      this.applied = applied;
    }
    applied.originX = shroud.originX;
    applied.originY = shroud.originY;
    applied.width = shroud.width;
    applied.height = shroud.height;
    applied.cells.set(shroud.cells);
    const stride = width + 2;
    flags.fill(0);
    // Only cells inside the padded grid matter; everything else is shrouded.
    const x0 = Math.max(-1, shroud.originX);
    const y0 = Math.max(-1, shroud.originY);
    const x1 = Math.min(width, shroud.originX + shroud.width - 1);
    const y1 = Math.min(height, shroud.originY + shroud.height - 1);
    for (let y = y0; y <= y1; y++) {
      const row = (y - shroud.originY) * shroud.width - shroud.originX;
      const out = (y + 1) * stride + 1;
      for (let x = x0; x <= x1; x++) flags[out + x] = cellFlags(shroud.cells[row + x]!);
    }
    cornersFromFlags(flags, width, height, this.data);
    this.texture.needsUpdate = true;
  }

  /**
   * The engine's MapClass::IsLocationShrouded for a lepton location: the shroud is a flat Z = 0 layer, so an object at
   * height level L is tested against the flat cell it covers on screen, (X - L/2, Y - L/2); an odd level straddles two
   * cells and is hidden only when both are shrouded. Everything is visible before the first update.
   * This is a point query for effect/light policy, not techno draw eligibility. Native building/unit rendering
   * clips its art through the alpha-lighting buffer; rejecting a whole object here loses revealed roofs and edges.
   */
  isLocationShrouded(x: number, y: number, z: number): boolean {
    const shroud = this.latest;
    if (!shroud) return false;
    const level = Math.trunc(z / LEPTONS_PER_LEVEL);
    const cx = Math.trunc(x / LEPTONS_PER_CELL);
    const cy = Math.trunc(y / LEPTONS_PER_CELL);
    const mapped = (px: number, py: number) => {
      const state = cellState(shroud, px, py);
      return state === VISIBLE || state === FOGGED;
    };
    if (level & 1) {
      const shift = Math.trunc(level / 2) + 1;
      return !mapped(cx - shift, cy - shift) && !mapped(cx - shift + 1, cy - shift + 1);
    }
    const shift = Math.trunc(level / 2);
    return !mapped(cx - shift, cy - shift);
  }
}

function cellState(shroud: ShroudCells, x: number, y: number): number {
  const sx = x - shroud.originX;
  const sy = y - shroud.originY;
  if (sx < 0 || sy < 0 || sx >= shroud.width || sy >= shroud.height) return 0xff;
  return shroud.cells[sy * shroud.width + sx]!;
}
