import { describe, expect, it } from 'vitest';
import {
  CellGlints,
  GLINT_MAX_ELAPSED_MS,
  GLINT_PHASE_END,
  GLINT_PHASE_PEAK,
  YR_ORE_GLINT,
  YR_WATER_GLINT,
  glintColour,
  glintRandom,
  rgb565Display,
} from '../src/ra2/cellGlints';
import { GLINT_DOT, glintPull } from '../src/live/glintLayer';
import { tiberiumCells } from '../src/live/overlays';
import { staticTiberiumCells } from '../src/live/liveView';
import { CARD_CLEARANCE, GROUND_DEPTH, VERTICAL_DEPTH } from '../src/ra2/cardDepth';

describe('engine glint table (gamemd.exe 1.001, 0x8367C8)', () => {
  it('holds the decoded rows', () => {
    // Kind 0 then kind 1, 10 ints each: end RGB, start RGB, random bits, delay mask, rate max, rate min.
    const row = (k: typeof YR_ORE_GLINT) => [...k.end, ...k.start, k.randomBits, k.delayMask, k.rateMax, k.rateMin];
    expect([...row(YR_WATER_GLINT), ...row(YR_ORE_GLINT)]).toEqual([
      158, 158, 224, 40, 40, 80, 5, 4095, 12, 3, 255, 255, 240, 176, 144, 0, 0, 4095, 30, 15,
    ]);
  });
});

describe('glintColour (0x631E50)', () => {
  const { start, end } = YR_ORE_GLINT;
  it('is start at 0 and 0x2000 and end at 0x1000', () => {
    expect(glintColour(start, end, 0)).toEqual([176, 144, 0]);
    expect(glintColour(start, end, GLINT_PHASE_PEAK)).toEqual([255, 255, 240]);
    expect(glintColour(start, end, GLINT_PHASE_END)).toEqual([176, 144, 0]);
    expect(glintColour(start, end, GLINT_PHASE_END + 500)).toEqual([176, 144, 0]);
  });
  it('is the integer triangle lerp', () => {
    // phase 0x800: t = 0x800, (176 * 0x800 + 255 * 0x800) >> 12 = 215.
    expect(glintColour(start, end, 0x800)).toEqual([215, 199, 120]);
    // Symmetric about the peak.
    expect(glintColour(start, end, 0x1000 + 0x300)).toEqual(glintColour(start, end, 0x1000 - 0x300));
  });
  it('shows what the RGB565 surface holds', () => {
    expect(rgb565Display([255, 255, 240])).toEqual([255, 255, 247]);
    expect(rgb565Display([176, 144, 0])).toEqual([181, 146, 0]);
  });
});

describe('CellGlints (0x6D7840 per cell)', () => {
  it('restarts with engine ranges and only after phase 0x2000', () => {
    const glints = new CellGlints(1);
    const seen = { dx: new Set<number>(), dy: new Set<number>(), rate: new Set<number>(), delayMax: 0 };
    for (let i = 0; i < 20000; i++) {
      glints.restart(0);
      const s = glints.state(0);
      expect(s.phase).toBe(0);
      seen.dx.add(s.dx);
      seen.dy.add(s.dy);
      seen.rate.add(s.rate);
      expect(s.delay).toBeGreaterThanOrEqual(0);
      seen.delayMax = Math.max(seen.delayMax, s.delay);
    }
    expect(Math.min(...seen.dx)).toBe(-31);
    expect(Math.max(...seen.dx)).toBe(32);
    expect(Math.min(...seen.dy)).toBe(-15);
    expect(Math.max(...seen.dy)).toBe(16);
    expect(Math.min(...seen.rate)).toBe(15);
    expect(Math.max(...seen.rate)).toBe(30);
    expect(seen.delayMax).toBeLessThanOrEqual(4095);
    expect(seen.delayMax).toBeGreaterThan(4000);
  });

  it('counts the delay down, then ramps by rate x elapsed and holds the offset for the whole cycle', () => {
    const glints = new CellGlints(1, YR_ORE_GLINT, glintRandom(7));
    const visits: { dx: number; dy: number; rgb: number[] }[] = [];
    const visit = (_: number, dx: number, dy: number, r: number, g: number, b: number) =>
      visits.push({ dx, dy, rgb: [r, g, b] });
    // Created on first use; find a cycle with a delay to count down.
    glints.step([0], 0, () => {});
    while (glints.state(0).delay < 2) {
      glints.restart(0);
    }
    const first = glints.state(0);
    glints.step([0], first.delay - 1, visit);
    expect(visits.length).toBe(0);
    expect(glints.state(0).delay).toBe(1);
    // The pass that ends the delay already advances the phase by its whole elapsed time.
    glints.step([0], 10, visit);
    expect(visits.length).toBe(1);
    expect(glints.state(0).phase).toBe(first.rate * 10);
    while (glints.state(0).phase < GLINT_PHASE_END) glints.step([0], 10, visit);
    expect(visits.length).toBe(Math.ceil(GLINT_PHASE_END / (first.rate * 10)));
    for (const v of visits) expect([v.dx, v.dy]).toEqual([first.dx, first.dy]);
    expect(visits.at(-1)!.rgb).toEqual([181, 146, 0]);
    // The next pass restarts it: phase 0, a new delay.
    glints.step([0], 0, () => {});
    expect(glints.state(0).phase).toBe(0);
  });

  it('clamps the elapsed time like the engine and carries fractions of a millisecond', () => {
    const glints = new CellGlints(1);
    expect(glints.elapsed(1000)).toBe(0);
    expect(glints.elapsed(1016.5)).toBe(16);
    expect(glints.elapsed(1033)).toBe(17);
    expect(glints.elapsed(1033.25)).toBe(0);
    expect(glints.elapsed(1034)).toBe(1);
    expect(glints.elapsed(1020)).toBe(0);
    expect(glints.elapsed(9000)).toBe(GLINT_MAX_ELAPSED_MS);
  });

  it('shows about 0.41 glints per ore cell per second, at random spots', () => {
    const cells = 200;
    const glints = new CellGlints(cells, YR_ORE_GLINT, glintRandom(12345));
    const list = Int32Array.from({ length: cells }, (_, i) => i);
    const shownLast = new Uint8Array(cells);
    let onsets = 0;
    let peak = 0;
    const seconds = 500;
    const dt = 1;
    const shownNow = new Uint8Array(cells);
    for (let t = 0; t < seconds * 1000; t += dt) {
      shownNow.fill(0);
      glints.step(list, t === 0 ? 0 : dt, (cell, _dx, _dy, r) => {
        shownNow[cell] = 1;
        peak = Math.max(peak, r);
      });
      for (let c = 0; c < cells; c++) if (shownNow[c] && !shownLast[c]) onsets++;
      shownLast.set(shownNow);
    }
    const rate = onsets / cells / seconds;
    // E[delay] 2047.5 ms + E[0x2000 / rate] (rate 15..30) 386 ms -> 0.411 per second.
    expect(rate).toBeGreaterThan(0.41 * 0.95);
    expect(rate).toBeLessThan(0.41 * 1.05);
    expect(peak).toBe(255);
  });

  it('leaves skipped cells untouched and resumes them later', () => {
    const glints = new CellGlints(2);
    glints.step([0, 1], 0, () => {});
    const before = glints.state(1);
    glints.step(
      [0, 1],
      50,
      () => {},
      (cell) => cell === 1,
    );
    expect(glints.state(1)).toEqual(before);
  });
});

describe('glint placement', () => {
  it('pulls the dot in front of an upright card of its own cell at the same row', () => {
    for (const dy of [-15, -5, 0, 5, 16]) {
      const card = Math.max(dy * GROUND_DEPTH, -dy * VERTICAL_DEPTH) + CARD_CLEARANCE;
      expect(glintPull(dy)).toBeGreaterThan(card);
      // ...but well behind anything one cell nearer (30 ground rows).
      expect(glintPull(dy)).toBeLessThan(card + 30 * GROUND_DEPTH);
    }
  });
  it('keeps the dot area near one engine pixel', () => {
    // Area of 1 - smoothstep(core, edge, r) integrated over the plane.
    let area = 0;
    const n = 400;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = ((i + 0.5) / n - 0.5) * 2;
        const y = ((j + 0.5) / n - 0.5) * 2;
        const r = Math.hypot(x, y);
        const t = Math.min(1, Math.max(0, (r - GLINT_DOT.core) / (GLINT_DOT.edge - GLINT_DOT.core)));
        area += (1 - t * t * (3 - 2 * t)) * (4 / (n * n));
      }
    expect(area).toBeGreaterThan(0.9);
    expect(area).toBeLessThan(1.25);
  });
});

describe('glint cells', () => {
  const terrain = { width: 4, height: 3, exists: new Uint8Array(12).fill(1) };
  it('takes live tiberium overlays only', () => {
    const library = {
      overlays: {
        GEM01: { tiberium: true },
        TIB01: { tiberium: true },
        GAWALL: {},
        RUBBLE: { tiberium: true, rubble: true },
      },
    } as never;
    const cells = {
      originX: 1,
      originY: 0,
      width: 2,
      height: 2,
      index: Int16Array.from([0, 2, -1, 1]),
      data: new Uint8Array(4),
      types: ['GEM01', 'TIB01', 'GAWALL'],
      revision: 1,
    };
    // Slots 0 (1,0) GEM01 and 3 (2,1) TIB01; slot 1 is a wall.
    expect([...tiberiumCells(cells, library, terrain)]).toEqual([1, 6]);
    expect([...tiberiumCells({ ...cells, rubble: [{ slot: 3, type: 'X' }] }, library, terrain)]).toEqual([1]);
    expect(tiberiumCells(cells, null, terrain).length).toBe(0);
  });
  it('takes the static map ore (self-lit overlays)', () => {
    const objects = [
      { kind: 'overlay', lighting: 'none', x: 3, y: 2 },
      { kind: 'overlay', lighting: 'none', x: 3, y: 2 },
      { kind: 'overlay', lighting: 'ambient', x: 0, y: 0 },
      { kind: 'smudge', lighting: 'none', x: 1, y: 1 },
      { kind: 'overlay', lighting: 'none', x: 9, y: 0 },
    ] as never;
    expect([...staticTiberiumCells(objects, terrain)]).toEqual([11]);
  });
});
