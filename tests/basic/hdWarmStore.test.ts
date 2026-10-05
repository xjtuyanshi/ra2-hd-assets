import { describe, expect, it } from 'vitest';
import type { LiveWarmType } from '../../packages/hd-renderer/src/live/liveView';
import {
  readShownLayout,
  readTopEffects,
  readWarmTypes,
  WARM_TYPES_LIMIT,
  warmTypeKey,
  writeShownLayout,
  writeTopEffects,
  writeWarmTypes,
  type HdWarmStorage,
} from '../../src/ui/pages/game/hdWarmStore';

function memory(): HdWarmStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const OPENING: LiveWarmType[] = [
  { kind: 'vehicle', type: 'SMCV', colorIndex: 21 },
  { kind: 'vehicle', type: 'HARV', imageType: 'HORV', colorIndex: 21 },
  { kind: 'infantry', type: 'E2', colorIndex: -1 },
  { kind: 'building', type: 'CAOILD', colorIndex: 5, civilian: true },
];

describe('HD warm lists', () => {
  it('returns what a match on the map stored, whatever the casing of the map name', () => {
    const storage = memory();
    writeWarmTypes(storage, 'XMP29U2', 'URBAN', OPENING);
    expect(readWarmTypes(storage, 'xmp29u2', 'urban')).toEqual(OPENING);
    expect([...storage.data.keys()].sort()).toEqual(['ra2-hd-warm:1:map:xmp29u2', 'ra2-hd-warm:1:theater:urban']);
  });

  it('offers the theater list, without civilian objects, to a map that was not played yet', () => {
    const storage = memory();
    writeWarmTypes(storage, 'xmp29u2', 'urban', OPENING);
    expect(readWarmTypes(storage, 'othermap', 'urban')).toEqual(OPENING.filter((type) => !type.civilian));
    expect(readWarmTypes(storage, 'othermap', 'snow')).toBeNull();
  });

  it('has no list without storage, and survives storage that throws', () => {
    expect(readWarmTypes(null, 'xmp29u2', 'urban')).toBeNull();
    writeWarmTypes(null, 'xmp29u2', 'urban', OPENING);
    const broken: HdWarmStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    expect(readWarmTypes(broken, 'xmp29u2', 'urban')).toBeNull();
    expect(() => writeWarmTypes(broken, 'xmp29u2', 'urban', OPENING)).not.toThrow();
  });

  it('does not store an empty list over an earlier one', () => {
    const storage = memory();
    writeWarmTypes(storage, 'xmp29u2', 'urban', OPENING);
    writeWarmTypes(storage, 'xmp29u2', 'urban', []);
    expect(readWarmTypes(storage, 'xmp29u2', 'urban')).toEqual(OPENING);
  });

  it('ignores stored text it did not write', () => {
    const storage = memory();
    for (const text of [
      'not json',
      '{"kind":"vehicle"}',
      '[["vehicle","SMCV","",21,0],"x"]',
      '[["ship","SMCV","",21,0]]',
      '[["vehicle","../../x","",21,0]]',
      '[["vehicle","SMCV","",2.5,0]]',
      '[["vehicle","SMCV","",-2,0]]',
      '[["vehicle","SMCV",7,21,0]]',
      '[]',
    ]) {
      storage.data.set('ra2-hd-warm:1:map:xmp29u2', text);
      expect(readWarmTypes(storage, 'xmp29u2', 'urban')).toBeNull();
    }
  });

  it('keeps each kind once and no more than the limit', () => {
    const storage = memory();
    const many = Array.from({ length: WARM_TYPES_LIMIT + 40 }, (_, index) => ({
      kind: 'vehicle' as const,
      type: `T${index}`,
      colorIndex: 1,
    }));
    writeWarmTypes(storage, 'big', 'urban', [...many.slice(0, 3), ...many]);
    const read = readWarmTypes(storage, 'big', 'urban')!;
    expect(read.length).toBeLessThanOrEqual(WARM_TYPES_LIMIT);
    expect(new Set(read.map(warmTypeKey)).size).toBe(read.length);
    expect(read[0]).toEqual(many[0]);
  });

  it('tells kinds apart by art, colours and whether a civilian house owns them', () => {
    expect(warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3 })).not.toBe(
      warmTypeKey({ kind: 'vehicle', type: 'HARV', imageType: 'HORV', colorIndex: 3 }),
    );
    expect(warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3 })).not.toBe(
      warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 4 }),
    );
    expect(warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3, civilian: true })).not.toBe(
      warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3 }),
    );
    expect(warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3, civilian: false })).toBe(
      warmTypeKey({ kind: 'vehicle', type: 'HARV', colorIndex: 3 }),
    );
  });

  it('remembers the layout the view was shown with and rejects anything that is not four sizes', () => {
    const storage = memory();
    expect(readShownLayout(storage)).toBeNull();
    writeShownLayout(storage, [3120, 2096, 1560, 1048]);
    expect(readShownLayout(storage)).toEqual([3120, 2096, 1560, 1048]);
    // The layout is not a warm list: lists are unaffected by it and it by them.
    writeWarmTypes(storage, 'xmp29u2', 'urban', OPENING);
    expect(readShownLayout(storage)).toEqual([3120, 2096, 1560, 1048]);
    for (const text of [
      'x',
      '[1,2,3]',
      '[1,2,3,4,5]',
      '[0,2,3,4]',
      '[1.5,2,3,4]',
      '[1,2,3,"4"]',
      '[1,2,3,99999]',
      '{}',
    ]) {
      storage.data.set('ra2-hd-warm:1:layout', text);
      expect(readShownLayout(storage)).toBeNull();
    }
    expect(readShownLayout(null)).toBeNull();
    expect(() => writeShownLayout(null, [1, 1, 1, 1])).not.toThrow();
  });

  it('remembers that a match showed top-layer art', () => {
    const storage = memory();
    expect(readTopEffects(storage)).toBe(false);
    writeTopEffects(storage);
    expect(readTopEffects(storage)).toBe(true);
    expect(readTopEffects(null)).toBe(false);
    expect(() => writeTopEffects(null)).not.toThrow();
  });
});
