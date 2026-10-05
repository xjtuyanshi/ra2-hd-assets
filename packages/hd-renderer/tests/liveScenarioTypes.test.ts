import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import type { LibraryType, ScenarioTypesSidecar } from '../../ra2-assets/src/library';
import { LiveLibrary } from '../src/live/library';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { buildOverlayInstances } from '../src/live/overlays';
import type { Ra2Cache } from '../src/ra2/cache';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cannon: LibraryType = {
  kind: 'building',
  image: 'GTGCAN',
  sprite: 'building:GTGCAN',
  turret: true,
  foundation: [2, 2],
  drawOffset: [0, -15],
  lighting: 'ambient',
  remap: true,
  building: {
    bodyFrames: 3,
    layers: [],
    buildup: 'anim:GTGCANMK',
    turretVoxel: { voxel: 'GTGCAN:turret', offset: [3, 28], zAdjust: -60 },
  },
};
const lamp: LibraryType = {
  kind: 'building',
  image: 'GALITE',
  sprite: 'building:GALITE',
  foundation: [1, 1],
  drawOffset: [0, -15],
  lighting: 'ambient',
  remap: true,
  invisible: true,
  building: { bodyFrames: 2, layers: [] },
};
const scenario: ScenarioTypesSidecar = {
  version: 1,
  theater: 'snow',
  source: 'DeepFrze.yro',
  types: {
    // A scenario-defined clone and a stock dummy the scenario makes visible.
    GTGCANA: {
      kind: 'building',
      art: 'GTGCAN',
      turret: true,
      turretVoxel: { voxel: 'GTGCAN:turret', offset: [3, 28], zAdjust: -60 },
    },
    INGRNLMP: { kind: 'building', art: 'INGRNLMP' },
  },
  warnings: [],
};

async function load(scenarioTypes: ScenarioTypesSidecar | null | undefined, theater = 'snow') {
  const cache = { scenarioTypes } as Ra2Cache;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/library.json')
        ? Response.json({
            theater,
            palettes: {},
            spriteAtlasesHd: [],
            types: { GTGCAN: cannon, INGRNLMP: lamp },
            // Frame 3 is the rubble picture of a destroyed building.
            sprites: {
              'building:GTGCAN': {
                palette: 'unit',
                frames: Array.from({ length: 4 }, () => ({ rect: [0, 0, 4, 4], offset: [-2, -2], page: 4 })),
              },
            },
            overlays: { RUBBLE: { rubble: true } },
          })
        : new Response(null, { status: 404 }),
    ),
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  return (await LiveLibrary.load('/library/', cache))!;
}

/** The live view's own art choice (buildVisual), with GPU construction left out. */
function visualOf(library: LiveLibrary, type: string) {
  const state = {
    library,
    cache: {
      voxels: new Map(),
      // What the map extractor kept of a placed building: one body frame.
      manifest: { sprites: { [`building:${type}`]: { frames: [{}] } } },
      paletteRow: new Map<string, number>(),
    },
    housePaletteKeys: new Map<number, string>(),
    libraryPaletteKeys: new Map<string, string>(),
    warnedTypes: new Set<string>(),
    options: {},
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    buildVisual(
      object: LiveObject,
      paletteKey: string,
      firstFrame: number,
    ): { mode: string; libraryType?: LibraryType; root: Group };
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'building',
    type,
    owner: -1,
    x: 256,
    y: 512,
    z: 0,
    facingRaw: 0,
    health: 1,
    isSelected: false,
  };
  return view.buildVisual(object, '', 0);
}

describe('live diagnostics', () => {
  it('names the building types drawn from the map cache frame for want of a library record', () => {
    const view = Object.assign(Object.create(LiveView.prototype), {
      visuals: new Map([
        [1, { mode: 'map-sprite', type: 'GTGCANA' }],
        [2, { mode: 'map-sprite', type: 'GTGCANA' }],
        [3, { mode: 'library-sprite', type: 'GTGCAN' }],
        [4, { mode: 'map-sprite', type: 'CAPOWR01' }],
      ]),
      warnedTypes: new Set<string>(),
      effectStats: { drawn: 0, missing: 0 },
      volumetricBlasts: { stats: () => ({ count: 0 }) },
      effectDriver: { unknownTypes: new Set<string>(), logicFps: 0 },
      overlayInstances: { active: false },
      smudgeInstances: { active: false, instances: { missingTypes: new Set<string>() } },
      // The diagnostics also count voxel units drawn from a stand-in mesh: none in this fixture.
      voxelUnits: { standInUnits: 0 },
      cellsFromEngine: false,
    }) as LiveView;
    const found = view.diagnostics();
    expect(found.mapCacheTypes).toEqual(['CAPOWR01', 'GTGCANA']);
    expect(found.standInVoxels).toBe(0);
    // The fallback is not a placeholder: before this list existed a match with such buildings reported nothing.
    expect(found.placeholders).toBe(0);
    expect(found.missingTypes).toEqual([]);
  });
});

describe('scenario types in the live library', () => {
  it('draws a scenario-defined building as a library building with its turret, not as the map cache frame', async () => {
    const stock = await load(null);
    expect(stock.type('GTGCANA')).toBeUndefined();
    expect(visualOf(stock, 'GTGCANA')).toMatchObject({ mode: 'map-sprite' });

    const library = await load(scenario);
    const visual = visualOf(library, 'GTGCANA');
    expect(visual.mode).toBe('library-sprite');
    expect(visual.libraryType).toEqual(cannon);
    expect(visual.libraryType).not.toBe(cannon);
    expect(library.type('GTGCAN')).toEqual(cannon);
  });

  it('takes rules-derived traits from the scenario: a dummy made visible is drawn', async () => {
    expect((await load(null)).type('INGRNLMP')!.invisible).toBe(true);
    const type = (await load(scenario)).type('INGRNLMP')!;
    expect(type.invisible).toBeUndefined();
    expect(type.sprite).toBe('building:GALITE');
  });

  it('serves the cell layers the same table: rubble of a scenario building finds its art', async () => {
    const cells = {
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
      index: new Int16Array([0]),
      data: new Uint8Array([0]),
      types: ['RUBBLE'],
      rubble: [{ slot: 0, type: 'GTGCANA' }],
      revision: 1,
    };
    const terrain = { width: 1, height: 1, levels: new Uint8Array(1), exists: new Uint8Array([1]) };
    const palette = () => 'unit';
    const missing = buildOverlayInstances(cells, (await load(null)).library, terrain, palette);
    expect([...missing.missingTypes]).toEqual(['rubble:GTGCANA']);
    const found = buildOverlayInstances(cells, (await load(scenario)).library, terrain, palette);
    expect([...found.missingTypes]).toEqual([]);
    expect(found.pages.get(4)).toHaveLength(1);
  });

  it('ignores a sidecar of another theatre and an entry whose stock type the library lacks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await load(scenario, 'temperate');
    expect(other.type('GTGCANA')).toBeUndefined();
    expect(other.type('INGRNLMP')!.invisible).toBe(true);
    expect(warn).toHaveBeenCalledWith('[HD] scenario types were made for snow, the library is temperate: ignored');
    warn.mockClear();
    const partial = await load({
      ...scenario,
      types: { ...scenario.types, CLONE: { kind: 'building', art: 'NOSUCH' } },
    });
    expect(partial.type('CLONE')).toBeUndefined();
    expect(partial.type('GTGCANA')).toBeDefined();
    expect(warn).toHaveBeenCalledWith('[HD] scenario type CLONE: the library has no building NOSUCH to draw it with');
  });
});
