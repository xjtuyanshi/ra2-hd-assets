import { describe, expect, it, vi } from 'vitest';
import type { LibraryOverlay, LibraryType } from '../../packages/ra2-assets/src/library';
import { mapAtmosphere } from '../../packages/ra2-assets/src/lights';
import type { SpriteEntry, SpriteFrame } from '../../packages/ra2-assets/src/manifest';
import {
  buildOverlayInstances,
  OverlayInstanceCache,
  type LiveOverlayCells,
  type OverlayTerrain,
} from '../../packages/hd-renderer/src/live/overlays';
import { highBridgeLight } from '../../packages/hd-renderer/src/ra2/bridgeDepth';
import { LEVEL_HEIGHT } from '../../packages/hd-renderer/src/world';

const frame = (page: number, n: number): SpriteFrame => ({ rect: [n * 8, 0, 8, 8], offset: [-4, -4], page });
const sprite = (page: number, palette: string, remap = false): SpriteEntry => ({
  palette,
  remap,
  canvas: [60, 30],
  frames: Array.from({ length: 16 }, (_, n) => frame(page, n)),
});
const overlay = (id: string, patch: Partial<LibraryOverlay> = {}): LibraryOverlay => ({
  sprite: `overlay:${id}`,
  frames: 16,
  palette: 'theater',
  wall: false,
  tiberium: true,
  remap: false,
  flat: true,
  drawOffset: [0, 0],
  lighting: 'none',
  ...patch,
});
const library = () => ({
  types: {} as Record<string, LibraryType>,
  overlays: {
    TIB01: overlay('TIB01'),
    GEM01: overlay('GEM01'),
    GAWALL: overlay('GAWALL', {
      wall: true,
      tiberium: false,
      remap: true,
      flat: false,
      palette: 'unit',
      lighting: 'ambient',
    }),
    SROCK01: overlay('SROCK01', {
      tiberium: false,
      flat: false,
      palette: 'iso',
      drawOffset: [0, 15],
      lighting: 'full',
    }),
  },
  sprites: {
    'overlay:TIB01': sprite(0, 'theater'),
    'overlay:GEM01': sprite(1, 'theater'),
    'overlay:GAWALL': sprite(2, 'unit', true),
    'overlay:SROCK01': sprite(3, 'iso'),
  },
});
const terrain = (): OverlayTerrain => ({
  width: 8,
  height: 8,
  levels: new Uint8Array(64).fill(2),
  exists: new Uint8Array(64).fill(1),
});
const cells = (): LiveOverlayCells => ({
  originX: 1,
  originY: 2,
  width: 2,
  height: 2,
  index: new Int16Array([0, 1, 2, 3]),
  data: new Uint8Array([11, 5, 9, 0]),
  types: ['TIB01', 'GEM01', 'GAWALL', 'SROCK01'],
  revision: 1,
});
const palette = (key: string, remap: boolean): string => `lib:${key}${remap ? ':local-house' : ''}`;

function rubbleFixture(patch: Partial<LibraryOverlay> = {}) {
  const art = library();
  art.types['SOURCE'] = {
    kind: 'building',
    image: 'SOURCE',
    sprite: 'building:SOURCE',
    drawOffset: [0, -15],
    lighting: 'ambient',
    remap: true,
  };
  const body: SpriteEntry = {
    ...sprite(4, 'unit', true),
    frames: Array.from({ length: 4 }, (_, n) => frame(4, n)),
    shadows: Array.from({ length: 4 }, (_, n) => frame(9, n)),
  };
  const libraryWithRubble = {
    ...art,
    overlays: {
      ...art.overlays,
      DEBRIS: overlay('DEBRIS', {
        rubble: true,
        frames: 0,
        palette: 'iso',
        tiberium: false,
        lighting: 'full',
        ...patch,
      }),
    },
    sprites: { ...art.sprites, 'overlay:DEBRIS': sprite(8, 'iso'), 'building:SOURCE': body },
  };
  const state = cells();
  state.types = ['DEBRIS'];
  state.index.fill(0);
  state.data.fill(11); // Rubble selection ignores the overlay's data and frame count.
  state.rubble = [{ slot: 1, type: 'SOURCE' }];
  return { art: libraryWithRubble, state, body };
}

describe('live overlay instances', () => {
  it('exempts only ore and gems from the lunar map grade, including mixed atlas pages', () => {
    const art = library();
    // The class, not the page or palette, selects the grade exemption.
    for (const entry of Object.values(art.sprites)) for (const frame of entry.frames) frame.page = 0;
    art.sprites['overlay:TIB01'].shadows = [frame(9, 0)];
    const state = cells();
    state.data[0] = 0;
    const atmosphere = mapAtmosphere(
      { ambient: 0.65, ground: 0.05, level: 0.008, red: 1, green: 1, blue: 1.1 },
      3,
      undefined,
      'lunar',
    );
    const result = buildOverlayInstances(state, art, terrain(), palette, atmosphere);
    const bodies = result.pages.get(0)!;
    expect(bodies.map((instance) => Boolean(instance.gradeExempt))).toEqual([true, true, false, false]);
    expect(result.pages.get(9)![0]!.gradeExempt).toBeUndefined();
    const day = buildOverlayInstances(state, art, terrain(), palette);
    expect(day.pages.get(0)!.every((instance) => !instance.gradeExempt)).toBe(true);
    const { art: rubbleArt, state: rubbleState } = rubbleFixture({ tiberium: true });
    const rubble = buildOverlayInstances(rubbleState, rubbleArt, terrain(), palette, atmosphere);
    expect(Boolean(rubble.pages.get(4)![0]!.gradeExempt)).toBe(false);
    expect(rubble.pages.get(9)![0]!.gradeExempt).toBeUndefined();
  });
  it('uses exact native growth/connection frames, extracted draw points and local wall remap', () => {
    const art = library();
    const built = buildOverlayInstances(cells(), art, terrain(), palette);
    expect(built.missingTypes.size).toBe(0);
    const ore = built.pages.get(0)![0]!;
    const gems = built.pages.get(1)![0]!;
    const wall = built.pages.get(2)![0]!;
    const rock = built.pages.get(3)![0]!;
    expect(ore.frame).toBe(art.sprites['overlay:TIB01'].frames[11]);
    expect(gems.frame).toBe(art.sprites['overlay:GEM01'].frames[5]);
    expect(wall.frame).toBe(art.sprites['overlay:GAWALL'].frames[9]);
    expect(ore.palette).toBe('lib:theater');
    expect(gems.palette).toBe('lib:theater');
    expect(wall.palette).toBe('lib:unit:local-house');
    expect(rock.palette).toBe('lib:iso');
    expect(ore.anchor.toArray()).toEqual([1, 2 * LEVEL_HEIGHT, 2]);
    expect(wall.anchor.toArray()).toEqual([1, 2 * LEVEL_HEIGHT, 3]);
    expect(rock.anchor.toArray()).toEqual([2.5, 2 * LEVEL_HEIGHT, 3.5]);
    expect([ore.flat, ore.push, ore.lighting]).toEqual([true, 0, 'none']);
    expect([wall.flat, wall.lighting]).toEqual([false, 'ambient']);
    expect(wall.push).toBeGreaterThan(0);
    expect([ore.glint, gems.glint, wall.glint, rock.glint]).toEqual([1, 1, undefined, undefined]);
    expect([ore.unlit, gems.unlit, wall.unlit, rock.unlit]).toEqual([true, true, false, false]);
  });

  it('draws a bridge owner cell as the engine does: deck variant by position, second direction 15 px higher', () => {
    const base = library();
    const deck = (id: string, page: number) => ({
      overlay: overlay(id, {
        frames: 18,
        tiberium: false,
        flat: false,
        palette: 'iso',
        lighting: 'full',
        drawOffset: [0, -1],
        highBridge: true,
      }),
      sprite: { ...sprite(page, 'iso'), frames: Array.from({ length: 18 }, (_, n) => frame(page, n)) },
    });
    const first = deck('BRIDGE1', 5);
    const second = deck('BRIDGE2', 6);
    const art = {
      ...base,
      overlays: { ...base.overlays, BRIDGE1: first.overlay, BRIDGE2: second.overlay },
      sprites: { ...base.sprites, 'overlay:BRIDGE1': first.sprite, 'overlay:BRIDGE2': second.sprite },
    };
    const state: LiveOverlayCells = {
      originX: 0,
      originY: 4,
      width: 4,
      height: 2,
      index: new Int16Array([0, 0, 0, 0, 1, 1, 1, -1]),
      // Row y=4: three intact cells of the first direction and a damaged one. Row y=5: the second direction.
      data: new Uint8Array([0, 0, 0, 5, 9, 9, 14, 0]),
      types: ['BRIDGE1', 'BRIDGE2'],
      revision: 1,
    };
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect(built.missingTypes.size).toBe(0);
    const firstCells = built.pages.get(5)!;
    const secondCells = built.pages.get(6)!;
    // Engine table row for y & 3 = 0 is 0, 1, 2, 3 and for y & 3 = 1 is 3, 2, 1, 0.
    expect(firstCells.map((i) => first.sprite.frames.indexOf(i.frame))).toEqual([0, 1, 2, 5]);
    expect(secondCells.map((i) => second.sprite.frames.indexOf(i.frame))).toEqual([9 + 3, 9 + 2, 14]);
    // Draw points on the level-2 ground plane: (0, -1) px is 1/30 cell up both axes, (0, -16) px is 16/30.
    const up = (px: number) => px / 30;
    firstCells.forEach((instance, x) => {
      expect(instance.anchor.x).toBeCloseTo(x - up(1), 9);
      expect(instance.anchor.z).toBeCloseTo(4 - up(1), 9);
      expect(instance.anchor.y).toBeCloseTo(2 * LEVEL_HEIGHT, 9);
    });
    secondCells.forEach((instance, x) => {
      expect(instance.anchor.x).toBeCloseTo(x - up(16), 9);
      expect(instance.anchor.z).toBeCloseTo(5 - up(16), 9);
    });
    for (const instance of [...firstCells, ...secondCells]) {
      expect(instance.flat).toBe(false);
      expect(instance.deckHeight).toBeCloseTo(4 * LEVEL_HEIGHT, 9);
      // Without a map lighting the deck takes its cell's light unchanged.
      expect(instance.light).toBe(1);
    }
    // The engine lights a deck four levels above its owner cell (level 2 here): (0.73 + 6 x 0.035) / (0.73 + 2 x 0.035).
    const dusk = { ambient: 0.73, ground: 0, level: 0.035 };
    expect(highBridgeLight(dusk, 2)).toBeCloseTo(0.94 / 0.8, 12);
    expect(highBridgeLight({ ambient: 1, ground: 0.05, level: 0 }, 5)).toBe(1);
    expect(highBridgeLight({ ambient: 1.95, ground: 0, level: 0.05 }, 0)).toBeCloseTo(2 / 1.95, 12);
    expect(highBridgeLight({ ambient: 0, ground: 0.2, level: 0.01 }, 3)).toBe(1);
    const lit = buildOverlayInstances(state, art, terrain(), palette, {}, (level) => highBridgeLight(dusk, level));
    for (const instance of [...lit.pages.get(5)!, ...lit.pages.get(6)!]) expect(instance.light).toBeCloseTo(1.175, 12);
    // Only bridge owners: every other overlay keeps its cell's light.
    const others = buildOverlayInstances(cells(), library(), terrain(), palette, {}, () => 1.5);
    for (const list of others.pages.values()) for (const instance of list) expect(instance.light).toBeUndefined();
    // The instance cache rebuilds when the map's light changes (a trigger, a storm) and not otherwise.
    const cache = new OverlayInstanceCache(terrain());
    expect(cache.update(state, art, 'house', palette, {}, dusk)).toBe(true);
    expect(cache.instances.pages.get(5)![0]!.light).toBeCloseTo(1.175, 12);
    expect(cache.update(state, art, 'house', palette, {}, { ...dusk })).toBe(false);
    expect(cache.update(state, art, 'house', palette, {}, { ...dusk, ambient: 1 })).toBe(true);
    expect(cache.instances.pages.get(5)![0]!.light).toBeCloseTo(1.21 / 1.07, 12);
    // A variant the art lacks is reported, never replaced by another slab.
    const short = { ...art, overlays: { ...art.overlays, BRIDGE1: { ...first.overlay, frames: 2 } } };
    const clipped = buildOverlayInstances(state, short, terrain(), palette);
    expect(clipped.pages.get(5)!.map((i) => first.sprite.frames.indexOf(i.frame))).toEqual([0, 1]);
    expect([...clipped.missingTypes]).toEqual(['BRIDGE1']);
    // A library without the bridge-owner flag keeps drawing the cell's own frame at its own draw point.
    const legacy = {
      ...art,
      overlays: {
        ...art.overlays,
        BRIDGE2: { ...second.overlay, highBridge: undefined, drawOffset: [0, -60] as [number, number] },
      },
    };
    const old = buildOverlayInstances(state, legacy, terrain(), palette).pages.get(6)!;
    expect(old.map((i) => second.sprite.frames.indexOf(i.frame))).toEqual([9, 9, 14]);
    expect(old[0]!.anchor.z).toBeCloseTo(5 - up(60), 9);
  });

  it('classifies arbitrary ore/gem types by the type flag, preserving normal overlays and rubble', () => {
    const state = cells();
    state.types = ['CUSTOM_RESOURCE', 'DECORATION', 'GAWALL', 'SROCK01'];
    const base = library();
    const art = {
      ...base,
      overlays: {
        ...base.overlays,
        CUSTOM_RESOURCE: overlay('TIB01', { lighting: 'full' }),
        DECORATION: overlay('GEM01', { tiberium: false, lighting: 'none' }),
      },
    };
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect(built.pages.get(0)![0]!.unlit).toBe(true);
    expect(built.pages.get(1)![0]!.unlit).toBe(false);
    const rubble = rubbleFixture({ tiberium: true, lighting: 'none' });
    const rubbleBody = buildOverlayInstances(rubble.state, rubble.art, terrain(), palette).pages.get(4)![0]!;
    expect(rubbleBody.unlit).toBe(false);
  });

  it('does not clamp/wrap missing frames or retain depleted overlays', () => {
    const state = cells();
    state.index[0] = -1;
    state.data[1] = 255;
    state.types[2] = 'NEW-WALL';
    const built = buildOverlayInstances(state, library(), terrain(), palette);
    expect([...built.pages.keys()]).toEqual([3]);
    expect([...built.missingTypes]).toEqual(['GEM01', 'NEW-WALL']);
    expect(buildOverlayInstances(state, null, terrain(), palette).pages.size).toBe(0);
  });

  it('clips to existing map cells and tolerates truncated cell arrays', () => {
    const ground = terrain();
    ground.exists[2 * 8 + 1] = 0;
    const state = cells();
    state.data = state.data.subarray(0, 3);
    expect([...buildOverlayInstances(state, library(), ground, palette).pages.keys()]).toEqual([1, 2]);
    state.originX = 8;
    expect(buildOverlayInstances(state, library(), ground, palette).pages.size).toBe(0);
  });

  it('keeps a corresponding shadow on its own atlas page', () => {
    const art = library();
    const shadow = frame(9, 11);
    const shadows = Array.from({ length: 16 }, (_, n) => frame(9, n));
    shadows[11] = shadow;
    art.sprites['overlay:TIB01'].shadows = shadows;
    const built = buildOverlayInstances(cells(), art, terrain(), palette);
    expect(built.pages.get(9)![0]).toMatchObject({ frame: shadow, shadow: true, flat: true, push: 0 });
    expect(built.pages.get(9)![0]!.anchor).toBe(built.pages.get(0)![0]!.anchor);
    expect(built.pages.get(9)![0]!.glint).toBeUndefined();
  });

  it.each([true, undefined] as const)('never draws a rubble overlay Image with library rubble=%s', (rubble) => {
    const { art, state, body } = rubbleFixture({ rubble, frames: 16 });
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect([...built.pages.keys()]).toEqual([9, 4]);
    expect(built.pages.get(4)).toHaveLength(1); // Only the carrier, not every foundation cell.
    const debris = built.pages.get(4)![0]!;
    const shadow = built.pages.get(9)![0]!;
    expect(debris.frame).toBe(body.frames[3]);
    expect(shadow.frame).toBe(body.shadows![3]);
    expect(debris).toMatchObject({ palette: 'lib:iso', flat: true, push: 0, lighting: 'full', shadow: false });
    expect(shadow).toMatchObject({ palette: 'lib:iso', flat: true, push: 0, lighting: 'full', shadow: true });
    expect(debris.anchor.toArray()).toEqual([2, 2 * LEVEL_HEIGHT, 2]);
    expect(shadow.anchor).toBe(debris.anchor);
    expect(built.missingTypes.size).toBe(0);
  });

  it('allows sprite-free rubble metadata and keeps non-carrier cells empty', () => {
    const { art, state } = rubbleFixture();
    delete art.overlays.DEBRIS.sprite;
    expect(buildOverlayInstances(state, art, terrain(), palette).pages.get(4)).toHaveLength(1);
    state.rubble = [];
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect(built.pages.size).toBe(0);
    expect(built.missingTypes.size).toBe(0);
  });

  it.each([0, 1, 2, 3])('draws nothing with only %i building body frames, even when a shadow exists', (frames) => {
    const { art, state, body } = rubbleFixture();
    body.frames.length = frames;
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect(built.pages.size).toBe(0);
    expect(built.missingTypes.size).toBe(0);
  });

  it.each(['missing type', 'non-building type', 'no sprite ID', 'missing sprite'])(
    'reports the source building for %s without substituting overlay art',
    (kind) => {
      const { art, state } = rubbleFixture();
      if (kind === 'missing type') delete art.types['SOURCE'];
      if (kind === 'non-building type') art.types['SOURCE']!.kind = 'vehicle';
      if (kind === 'no sprite ID') delete art.types['SOURCE']!.sprite;
      if (kind === 'missing sprite') art.types['SOURCE']!.sprite = 'absent';
      const built = buildOverlayInstances(state, art, terrain(), palette);
      expect(built.pages.size).toBe(0);
      expect([...built.missingTypes]).toEqual(['rubble:SOURCE']);
    },
  );

  it('uses the overlay offset and lighting and disables remap even with remappable source art', () => {
    const { art, state } = rubbleFixture({ drawOffset: [0, 15], remap: true, lighting: 'ambient' });
    const built = buildOverlayInstances(state, art, terrain(), palette);
    expect(built.pages.get(4)![0]!.anchor.toArray()).toEqual([2.5, 2 * LEVEL_HEIGHT, 2.5]);
    for (const instance of [...built.pages.values()].flat())
      expect(instance).toMatchObject({ palette: 'lib:iso', lighting: 'ambient' });
  });
});

describe('overlay instance revision cache', () => {
  it('rebuilds the grade exemption when airless changes without changing the engine cells', () => {
    const cache = new OverlayInstanceCache(terrain());
    const state = cells();
    const art = library();
    expect(cache.update(state, art, '', palette, { airless: true })).toBe(true);
    expect(cache.instances.pages.get(0)![0]!.gradeExempt).toBe(true);
    expect(cache.update(state, art, '', palette, { airless: true })).toBe(false);
    expect(cache.update(state, art, '', palette, { airless: false })).toBe(true);
    expect(Boolean(cache.instances.pages.get(0)![0]!.gradeExempt)).toBe(false);
    expect(cache.update(state, art, '', palette)).toBe(false);
    expect(cache.update(state, art, '', palette, { airless: true })).toBe(true);
    expect(cache.instances.pages.get(0)![0]!.gradeExempt).toBe(true);
  });
  it('ignores structured clone identity and rebuilds only content, palette or source changes', () => {
    const cache = new OverlayInstanceCache(terrain());
    const state = cells();
    const art = library();
    const resolve = vi.fn(palette);
    expect(cache.update(state, art, 'red', resolve)).toBe(true);
    const original = cache.instances;
    resolve.mockClear();
    expect(cache.update(structuredClone(state), art, 'red', resolve)).toBe(false);
    expect(cache.instances).toBe(original);
    expect(resolve).not.toHaveBeenCalled();
    // Readers may reuse/mutate their original object and arrays; retain the old numeric revision separately.
    state.index[0] = -1;
    state.revision++;
    expect(cache.update(state, art, 'red', resolve)).toBe(true);
    expect(cache.instances.pages.has(0)).toBe(false);
    expect(cache.update(state, art, 'blue', resolve)).toBe(true);
    expect(cache.update(state, { ...art }, 'blue', resolve)).toBe(true);
    expect(cache.update(null, art, 'blue', resolve)).toBe(true);
    expect(cache.active).toBe(false);
    expect(cache.instances.pages.size).toBe(0);
    expect(cache.update(state, art, 'blue', resolve)).toBe(true);
    expect(cache.active).toBe(true);
  });

  it('keeps an empty live grid authoritative until the host explicitly falls back', () => {
    const cache = new OverlayInstanceCache(terrain());
    const state = cells();
    state.index.fill(-1);
    cache.update(state, library(), '', palette);
    expect(cache.active).toBe(true);
    expect(cache.instances.pages.size).toBe(0);
    cache.update(null, null, '', palette);
    expect(cache.active).toBe(false);
  });

  it('retains map-cache drawing until a legacy library gains an overlays section', () => {
    const cache = new OverlayInstanceCache(terrain());
    const art = library();
    const state = cells();
    cache.update(state, { sprites: art.sprites, types: {} }, '', palette);
    expect(cache.active).toBe(false);
    expect(cache.instances.pages.size).toBe(0);
    cache.update(state, art, '', palette);
    expect(cache.active).toBe(true);
    expect(cache.instances.pages.size).toBe(4);
    cache.update(state, null, '', palette);
    expect(cache.active).toBe(false);
  });

  it('includes rubble contents in the cache key and tolerates structured clones', () => {
    const { art, state } = rubbleFixture();
    const cache = new OverlayInstanceCache(terrain());
    expect(cache.update(state, art, '', palette)).toBe(true);
    const first = cache.instances;
    expect(cache.update(structuredClone(state), art, '', palette)).toBe(false);
    expect(cache.instances).toBe(first);
    state.rubble![0]!.type = 'UNKNOWN';
    expect(cache.update(state, art, '', palette)).toBe(true);
    expect([...cache.instances.missingTypes]).toEqual(['rubble:UNKNOWN']);
    state.rubble = [];
    state.revision++;
    expect(cache.update(state, art, '', palette)).toBe(true);
    expect(cache.instances.pages.size).toBe(0);
  });
});
