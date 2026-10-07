import { describe, expect, it } from 'vitest';
import { cliffMirrorZone, MIRROR_RISE_PER_CELL } from '../src/ra2/terrain';
import { CLIFF_MIRROR_TAPS, cliffSoftCoverage } from '../src/ra2/waterLook';
import { LEVEL_HEIGHT } from '../src/world';

const SUB = 2;
const NONE = 50;

/** Height grid of `w` x `h` cells (SUB points per cell): water at level 0 with ground raised where `raised` says. */
function grid(w: number, h: number, raised: (x: number, y: number) => number) {
  const gw = w * SUB + 1;
  const gh = h * SUB + 1;
  const data = new Float32Array(gw * gh);
  for (let z = 0; z < gh; z++)
    for (let x = 0; x < gw; x++)
      data[z * gw + x] =
        raised(Math.min(w - 1, Math.floor(x / SUB)), Math.min(h - 1, Math.floor(z / SUB))) * LEVEL_HEIGHT;
  const zone = cliffMirrorZone(data, gw, gh, SUB);
  return {
    data,
    gw,
    gh,
    zone,
    at: (cx: number, cy: number) => zone[Math.round(cy * SUB) * gw + Math.round(cx * SUB)]!,
  };
}

describe('where the water mirrors a cliff (cliffMirrorZone)', () => {
  it('follows the camera: a cliff of n levels mirrors n / 2 cells towards the viewer, and nowhere behind it', () => {
    // The mirrored ray rises sqrt(2/3) per cell, a level is 0.408: two levels of height per cell travelled.
    expect(MIRROR_RISE_PER_CELL / LEVEL_HEIGHT).toBeCloseTo(2, 2);
    // A plateau four levels high in the far corner (small x and y are away from the camera).
    const g = grid(24, 24, (x, y) => (x < 10 && y < 10 ? 4 : 0));
    // On the diagonal towards the camera: fully in the zone out to the image's end (2 cells) and the spread around it.
    expect(g.at(10.5, 10.5)).toBe(1);
    expect(g.at(11.5, 11.5)).toBe(1);
    expect(g.at(12, 12)).toBe(1);
    expect(g.at(12.5, 12.5)).toBeGreaterThan(0.9);
    // Gone a couple of cells past the image.
    expect(g.at(15, 15)).toBe(0);
    expect(g.at(20, 20)).toBe(0);
    // Water beside the plateau but not in front of it mirrors nothing of it beyond the spread.
    expect(g.at(20, 2)).toBe(0);
    expect(g.at(2, 20)).toBe(0);
  });

  it('reaches twice as far for a cliff twice as high', () => {
    const low = grid(30, 30, (x, y) => (x < 10 && y < 10 ? 2 : 0));
    const high = grid(30, 30, (x, y) => (x < 10 && y < 10 ? 8 : 0));
    const reach = (g: ReturnType<typeof grid>) => {
      let d = 0;
      while (d < 18 && g.at(10 + d, 10 + d) > 0.5) d += 0.5;
      return d;
    };
    expect(reach(low)).toBeGreaterThanOrEqual(1);
    expect(reach(low)).toBeLessThanOrEqual(2.5);
    expect(reach(high)).toBeGreaterThanOrEqual(4);
    expect(reach(high)).toBeLessThanOrEqual(5.5);
    expect(reach(high) - reach(low)).toBeCloseTo(3, 0);
  });

  it('ignores slopes and shore steps, missing cells and flat water', () => {
    expect(Math.max(...grid(16, 16, () => 0).zone)).toBe(0);
    // Half a level of bank all around: not a cliff.
    expect(Math.max(...grid(16, 16, (x, y) => (x < 6 && y < 6 ? 0.5 : 0)).zone)).toBe(0);
    const holes = grid(16, 16, (x, y) => (x < 6 && y < 6 ? 4 : 0));
    const withHoles = holes.data.slice();
    for (let i = 0; i < withHoles.length; i++) if (withHoles[i]! > 0) withHoles[i] = NONE;
    expect(Math.max(...cliffMirrorZone(withHoles, holes.gw, holes.gh, SUB))).toBe(0);
  });

  it('ends smoothly: no step larger than the smoothing box allows', () => {
    const g = grid(24, 24, (x, y) => (x + y < 16 ? 4 : 0));
    let largest = 0;
    for (let z = 0; z < g.gh; z++)
      for (let x = 1; x < g.gw; x++)
        largest = Math.max(largest, Math.abs(g.zone[z * g.gw + x]! - g.zone[z * g.gw + x - 1]!));
    expect(largest).toBeLessThanOrEqual(0.67);
    expect(largest).toBeGreaterThan(0);
  });
});

describe('softening the mirrored cliff edge (cliffSoftMirror)', () => {
  /** The staircase: mirrored cliff present above a zig-zag with one tooth per cell diamond, `depth` diamonds deep. */
  const stair =
    (depth: number) =>
    (y: number) =>
    (x: number): number => {
      const phase = x - Math.floor(x);
      const edge = depth * (1 - Math.abs(2 * phase - 1));
      return y < edge ? 1 : 0;
    };

  it('spans exactly one cell diamond with equal taps around the plain lookup', () => {
    expect(CLIFF_MIRROR_TAPS).toContain(0);
    const step = CLIFF_MIRROR_TAPS[1] - CLIFF_MIRROR_TAPS[0];
    for (let i = 1; i < CLIFF_MIRROR_TAPS.length; i++)
      expect(CLIFF_MIRROR_TAPS[i]! - CLIFF_MIRROR_TAPS[i - 1]!).toBeCloseTo(step);
    expect(step * CLIFF_MIRROR_TAPS.length).toBeCloseTo(1);
    expect(CLIFF_MIRROR_TAPS.reduce((sum, tap) => sum + tap, 0)).toBeCloseTo(0);
  });

  it('is the plain lookup outside the zone', () => {
    const row = stair(0.25)(0.1);
    for (const x of [0.05, 0.3, 0.5, 0.71, 0.95]) expect(cliffSoftCoverage(row, x, 0)).toBe(row(x));
  });

  it('turns the staircase into a band that hardly depends on where along the cliff it is read', () => {
    const depth = 0.25;
    for (const y of [0.03, 0.08, 0.125, 0.17, 0.22]) {
      const row = stair(depth)(y);
      const plain = Array.from({ length: 40 }, (_, i) => row(i / 40));
      const soft = Array.from({ length: 40 }, (_, i) => cliffSoftCoverage(row, i / 40, 1));
      // Plain: either inside a tooth or outside it. Soft: the share of the tooth at this depth, all along the cliff.
      expect(Math.max(...plain) - Math.min(...plain)).toBe(1);
      expect(Math.max(...soft) - Math.min(...soft)).toBeLessThanOrEqual(1 / CLIFF_MIRROR_TAPS.length + 1e-9);
      const share = 1 - y / depth;
      for (const value of soft)
        expect(Math.abs(value - share)).toBeLessThanOrEqual(1 / CLIFF_MIRROR_TAPS.length + 1e-9);
    }
    // Deeper into the water the band thins out monotonically: a soft edge, not teeth.
    const mean = (y: number) => {
      const row = stair(depth)(y);
      return Array.from({ length: 40 }, (_, i) => cliffSoftCoverage(row, i / 40, 1)).reduce((a, b) => a + b, 0) / 40;
    };
    const profile = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map(mean);
    for (let i = 1; i < profile.length; i++) expect(profile[i]!).toBeLessThanOrEqual(profile[i - 1]!);
    expect(profile[0]).toBeCloseTo(1, 1);
    expect(profile.at(-1)).toBe(0);
  });
});
