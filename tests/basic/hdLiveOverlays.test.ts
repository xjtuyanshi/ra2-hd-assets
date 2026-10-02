import { describe, expect, it, vi } from 'vitest';
import type { LibraryOverlay, LibraryType } from '../../packages/ra2-assets/src/library';
import type { SpriteEntry, SpriteFrame } from '../../packages/ra2-assets/src/manifest';
import {
  buildOverlayInstances,
  OverlayInstanceCache,
  type LiveOverlayCells,
  type OverlayTerrain,
} from '../../packages/hd-renderer/src/live/overlays';
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
