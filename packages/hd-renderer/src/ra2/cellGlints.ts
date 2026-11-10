/**
 * The engine's field-wide ore/gem glints: YR 1.001 TacticalClass 0x6D7840, the last step of the tactical draw, which
 * the HD mode skips on the native surface (src/games/yr/tacticalPassthrough.ts, gate `terrain:ore-glints`). Not
 * palette cycling and not the TWNK1 anims (those are separate, fixed-cell anims the HD picture already draws).
 *
 * What the engine does, decoded from the player's gamemd.exe (evidence: docs/remaster/research/yr-ore-glints.md):
 *  - every frame, for each cell in view that has tiberium (ore or gems; kind 1) or water land type (kind 0), it keeps
 *    one glint object (CellClass+0xFC, created on first use with 0x631E30, which restarts it at once);
 *  - a glint whose phase reached 0x2000 restarts (0x631D40): one rand() gives the pixel offset from the centre of the
 *    cell's 60x30 screen rect, x = (r & 63) - 31, y = ((r >> 5) & 31) - 15 (the two fields share bit 5); the end
 *    colour is the table's, minus `randomBits` random bits per channel (water only); then rate = rand() %
 *    (rateMax - rateMin + 1) + rateMin phase units per millisecond, delay = rand() & delayMask milliseconds, phase 0;
 *  - elapsed is the timeGetTime() delta since the previous pass, clamped to 1000 ms; delay -= elapsed, nothing is
 *    drawn while it is above 0 (0x631EE0, which then holds it at 0);
 *  - then (only when the pixel is inside the view) phase = min(0x2000, phase + rate * elapsed) and the colour is the
 *    integer triangle lerp start -> end -> start over phase 0..0x1000..0x2000 (0x631E50);
 *  - ONE pixel is written straight into the 16-bit frame surface (0x6D7BB4): RGB565, no palette, no map lighting, no
 *    Z test, after everything else. So it keeps full brightness at night.
 *
 * Deliberate differences, all statistical no-ops or HD-only: the generator is our own (never the guest's CRT rand()),
 * every listed cell advances whether or not it is in view (the engine freezes cells out of view; the stationary
 * glint rate is the same), the engine's low-frame-rate skip (0x55AF60 detail threshold) is not mirrored, and the
 * rect centre ignores the extra image height of tiles that have one (0x47FF80 raises such a rect; ore lies on
 * clear tiles). Four further cell conditions (CellClass+0x12C bit 0x10, 0x487950, +0xE4, +0x140 bit 0x1000) are not
 * identified by name; the HD layer approximates them with the shroud.
 */

export type GlintRgb = readonly [number, number, number];

/** One row of the engine's glint table at 0x8367C8 (10 ints per kind, in this order). */
export interface GlintKind {
  end: GlintRgb;
  start: GlintRgb;
  /** Random bits subtracted per channel from `end` at each restart (0 = none). */
  randomBits: number;
  delayMask: number;
  rateMax: number;
  rateMin: number;
}

/** Kind 0: water cells (LandType 2). Read from gamemd.exe 1.001 at 0x8367C8. Not drawn by HD (see waterLook.ts). */
export const YR_WATER_GLINT: GlintKind = {
  end: [158, 158, 224],
  start: [40, 40, 80],
  randomBits: 5,
  delayMask: 4095,
  rateMax: 12,
  rateMin: 3,
};
/** Kind 1: cells with tiberium (ore and gems). Read from gamemd.exe 1.001 at 0x8367F0. */
export const YR_ORE_GLINT: GlintKind = {
  end: [255, 255, 240],
  start: [176, 144, 0],
  randomBits: 0,
  delayMask: 4095,
  rateMax: 30,
  rateMin: 15,
};

export const GLINT_PHASE_PEAK = 0x1000;
export const GLINT_PHASE_END = 0x2000;
/** The engine clamps the per-pass elapsed time to this many milliseconds (0x6D78AB). */
export const GLINT_MAX_ELAPSED_MS = 1000;

/** A 15-bit generator like the CRT's rand() (0..32767), but our own: xorshift32 with a fixed seed. */
export function glintRandom(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 17;
  };
}

/** Engine colour at `phase` (0x631E50): integer lerp start -> end -> start; the phase is clamped to 0..0x2000. */
export function glintColour(
  start: GlintRgb,
  end: GlintRgb,
  phase: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const p = Math.max(0, Math.min(GLINT_PHASE_END, Math.trunc(phase)));
  let t = p & 0xfff;
  if (p & 0x1000) t = 0x1000 - t;
  for (let i = 0; i < 3; i++) out[i] = (start[i]! * (0x1000 - t) + end[i]! * t) >> 12;
  return out;
}

/**
 * The 8-bit colour the player saw: the engine writes RGB565 (each channel truncated), and the display expands it by
 * bit replication.
 */
export function rgb565Display(rgb: GlintRgb, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const r = Math.max(0, Math.min(255, rgb[0] | 0)) >> 3;
  const g = Math.max(0, Math.min(255, rgb[1] | 0)) >> 2;
  const b = Math.max(0, Math.min(255, rgb[2] | 0)) >> 3;
  out[0] = (r << 3) | (r >> 2);
  out[1] = (g << 2) | (g >> 4);
  out[2] = (b << 3) | (b >> 2);
  return out;
}

/** Called for every glint drawn this pass: the cell, its pixel offset from the cell centre and its 8-bit colour. */
export type GlintVisit = (cell: number, dx: number, dy: number, r: number, g: number, b: number) => void;

/**
 * Glint state of every cell of a map (index y * width + x), advanced like the engine's pass. The `cells` given to
 * step() are the cells that carry a glint this pass; a cell that drops out keeps its state, as CellClass+0xFC does.
 */
export class CellGlints {
  private readonly made: Uint8Array;
  private readonly phase: Int32Array;
  private readonly delay: Int32Array;
  private readonly rate: Int32Array;
  private readonly offset: Int8Array;
  private readonly end: Uint8Array;
  private readonly endRgb: [number, number, number] = [0, 0, 0];
  private readonly rgb: [number, number, number] = [0, 0, 0];
  private readonly shown: [number, number, number] = [0, 0, 0];
  private lastMs: number | null = null;
  private carryMs = 0;

  constructor(
    readonly cellCount: number,
    readonly kind: GlintKind = YR_ORE_GLINT,
    private readonly random: () => number = glintRandom(),
  ) {
    this.made = new Uint8Array(cellCount);
    this.phase = new Int32Array(cellCount);
    this.delay = new Int32Array(cellCount);
    this.rate = new Int32Array(cellCount);
    this.offset = new Int8Array(cellCount * 2);
    this.end = new Uint8Array(cellCount * 3);
  }

  /** Whole milliseconds since the previous call (fractions carry over), clamped like the engine; 0 the first time. */
  elapsed(nowMs: number): number {
    if (this.lastMs === null || !Number.isFinite(nowMs) || nowMs < this.lastMs) {
      this.lastMs = Number.isFinite(nowMs) ? nowMs : null;
      this.carryMs = 0;
      return 0;
    }
    const total = this.carryMs + (nowMs - this.lastMs);
    this.lastMs = nowMs;
    const whole = Math.floor(total);
    this.carryMs = total - whole;
    return Math.min(GLINT_MAX_ELAPSED_MS, whole);
  }

  /** 0x631D40 for one cell. */
  restart(cell: number): void {
    const { kind, random } = this;
    const r = random();
    this.offset[cell * 2] = (r & 63) - 31;
    this.offset[cell * 2 + 1] = ((r >> 5) & 31) - 15;
    if (kind.randomBits > 0) {
      const mask = (1 << kind.randomBits) - 1;
      let bits = random();
      for (let i = 0; i < 3; i++) {
        this.end[cell * 3 + i] = Math.max(0, kind.end[i]! - (bits & mask));
        bits >>>= kind.randomBits;
      }
    } else for (let i = 0; i < 3; i++) this.end[cell * 3 + i] = kind.end[i]!;
    this.phase[cell] = 0;
    this.rate[cell] = (random() % (kind.rateMax - kind.rateMin + 1)) + kind.rateMin;
    this.delay[cell] = random() & kind.delayMask;
    this.made[cell] = 1;
  }

  /**
   * One engine pass over `cells` with `elapsedMs` (see elapsed()): restart finished glints, count delays down, advance
   * and visit the glints that show. `skip` leaves a cell untouched this pass (the engine's cell conditions). Returns
   * the number of glints visited.
   */
  step(cells: ArrayLike<number>, elapsedMs: number, visit: GlintVisit, skip?: (cell: number) => boolean): number {
    const elapsed = Math.max(0, Math.min(GLINT_MAX_ELAPSED_MS, Math.trunc(elapsedMs)));
    const { kind, rgb, shown, endRgb } = this;
    let drawn = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (!(cell >= 0 && cell < this.cellCount) || skip?.(cell)) continue;
      if (!this.made[cell] || this.phase[cell]! >= GLINT_PHASE_END) this.restart(cell);
      const delay = this.delay[cell]! - elapsed;
      if (delay > 0) {
        this.delay[cell] = delay;
        continue;
      }
      // The pass that ends the delay also advances the phase by the whole elapsed time, as the engine does.
      this.delay[cell] = 0;
      const phase = Math.min(GLINT_PHASE_END, this.phase[cell]! + this.rate[cell]! * elapsed);
      this.phase[cell] = phase;
      endRgb[0] = this.end[cell * 3]!;
      endRgb[1] = this.end[cell * 3 + 1]!;
      endRgb[2] = this.end[cell * 3 + 2]!;
      rgb565Display(glintColour(kind.start, endRgb, phase, rgb), shown);
      visit(cell, this.offset[cell * 2]!, this.offset[cell * 2 + 1]!, shown[0], shown[1], shown[2]);
      drawn++;
    }
    return drawn;
  }

  /** The state of one cell (tests and diagnostics). */
  state(cell: number): { made: boolean; phase: number; delay: number; rate: number; dx: number; dy: number } {
    return {
      made: this.made[cell] === 1,
      phase: this.phase[cell]!,
      delay: this.delay[cell]!,
      rate: this.rate[cell]!,
      dx: this.offset[cell * 2]!,
      dy: this.offset[cell * 2 + 1]!,
    };
  }
}
