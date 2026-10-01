import { describe, expect, it } from 'vitest';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import { shpUnitBlocks, shpUnitFrame, shpVehicleDirection } from '../src/live/shpUnits';
import type { SpriteInstance } from '../src/ra2/sprites';
import type { LibraryShpUnit } from '../../ra2-assets/src/library';
import { advanceShpReview, shpUnitReview } from '../sandbox/shpUnitReview';
import fixtures from './fixtures/shpUnitLayouts.json';

const drone: LibraryShpUnit = { facings: 8, frames: { WalkFrames: 6, FiringFrames: 4 } };

describe('SHP vehicle sheet/review frame contract', () => {
  for (const fixture of fixtures) {
    it(`matches the shared Python layout fixture: ${fixture.name}`, () => {
      expect(shpUnitBlocks(fixture.unit as LibraryShpUnit)).toEqual(fixture.blocks);
    });
  }

  it('lays out eight facings in a screen row in the same order as the prepared sheets', () => {
    const row = shpUnitReview(new URLSearchParams('stypes=DRON&seq=Walk&step=5'), 60, 62, 104, 5000);
    expect(row).toHaveLength(8);
    expect(new Set(row.map((o) => o.x + o.y)).size).toBe(1);
    expect(row.every((o) => o.z === 104 && o.owner === 0 && o.type === 'DRON')).toBe(true);
    row.forEach((object, i) => {
      expect(shpVehicleDirection(object.facingRaw / 256, 8)).toBe(i);
      expect(shpUnitFrame(drone, object.facingRaw / 256, 'walk', object.shpUnitPose!.step)).toBe(i * 6 + 5);
      if (i) expect(object.x - object.y).toBeGreaterThan(row[i - 1]!.x - row[i - 1]!.y);
    });
  });

  it('starts at the requested step, advances after warm-up, and wraps within each facing', () => {
    const row = shpUnitReview(new URLSearchParams('seq=Fire&step=3'), 0, 0, 0, 1);
    expect(advanceShpReview(row, 500, 0)).toBe(row);
    expect(advanceShpReview(row, -120, 2)[0]!.shpUnitPose!.step).toBe(3);
    const next = advanceShpReview(row, 2, 2);
    expect(next[0]!.shpUnitPose!.step).toBe(4);
    expect(row[0]!.shpUnitPose!.step).toBe(3);
    expect(shpUnitFrame(drone, next[0]!.facingRaw / 256, 'fire', next[0]!.shpUnitPose!.step)).toBe(56);
    expect(() => shpUnitReview(new URLSearchParams('seq=typo'), 0, 0, 0, 1)).toThrow();
    expect(() => advanceShpReview(row, 0, NaN)).toThrow();
  });

  it('renders the explicit review frame and its matching shadow; ordinary pose selection still follows events', () => {
    const frames = Array.from({ length: 88 }, (_, i) => ({ rect: [i, 0, 2, 2], offset: [0, 0], page: 0 }));
    const shadows = frames.map((f) => ({ ...f, rect: [f.rect[0], 2, 2, 2] }));
    const cards: SpriteInstance[] = [];
    const pool = new SpritePool();
    const view = Object.assign(Object.create(LiveView.prototype), {
      library: { library: { sprites: { 'vehicle:DRON': { frames, shadows, palette: 'unit', remap: false } } } },
      cache: { paletteRow: new Map() },
      spritePool: pool,
      shpPose: { state: 'stand', step: 0 },
      libraryPalette: (palette: string) => palette,
      queue: (_batch: unknown, sprite: SpriteInstance) => cards.push(sprite),
    }) as { libraryShpUnitSprites: (...args: unknown[]) => void };
    const object = shpUnitReview(new URLSearchParams('seq=Fire&step=1'), 0, 0, 0, 1)[3]!;
    const visual = {
      libraryType: { sprite: 'vehicle:DRON', shpUnit: drone, drawOffset: [0, 0], remap: false },
      lastMoveFrame: undefined as number | undefined,
      firedFrame: undefined as number | undefined,
    };
    const draw = (o: LiveObject) => {
      pool.begin();
      cards.length = 0;
      view.libraryShpUnitSprites(
        o,
        { x: o.x, y: o.y, z: o.z, facing: (o.facingRaw / 65536) * Math.PI * 2 },
        visual,
        new Map(),
        100,
      );
      expect(cards).toHaveLength(2);
      expect(cards[0]!.shadow).toBe(true);
      expect(cards[0]!.frame.rect[0]).toBe(cards[1]!.frame.rect[0]);
      return cards[1]!.frame.rect[0];
    };
    expect(draw(object)).toBe(69);
    const normal = { ...object, shpUnitPose: undefined };
    expect(draw(normal)).toBe(51);
    visual.lastMoveFrame = 100;
    expect(draw(normal)).toBe(22);
    visual.firedFrame = 98;
    expect(draw(normal)).toBe(70);
    expect(draw(object)).toBe(69);
  });
});
