import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { AtmosphereNodes } from '../src/atmosphere';
import type { HdRenderer } from '../src/HdRenderer';
import { artVariant, LiveView, type LiveObject } from '../src/live/liveView';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { CARGO_LOOKS, cargoLook } from '../src/ra2/cargoLook';
import { voxelProjectionLibrary } from '../src/ra2/voxelProjection';
import { parseVoxelProjectionManifest, type VoxelProjectionManifest } from '../src/ra2/voxelProjectionMath';
import type { HdWorld } from '../src/ra2/world';
import { syntheticSection } from './fixtures/syntheticVoxels';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A miner's manifest: a body with the three bin variants and a turret without any (the War Miner's gun). */
function manifest(variants: Record<string, string> | undefined = undefined): VoxelProjectionManifest {
  const part = (name: string) => ({
    colour: `HARV_${name}.png`,
    paint: `HARV_${name}_paint.png`,
    size: [320, 32] as [number, number],
    frames: Array.from({ length: 16 }, (_, i) => ({
      k: i * 2,
      facing: i * 16,
      pivot: [i * 20 + 8, 24] as [number, number],
      rect: [i * 20 + 1, 1, 16, 16] as [number, number, number, number],
    })),
  });
  return {
    version: 1,
    type: 'HARV',
    frames: 16,
    facingStep: 16,
    scale: 1,
    jacobian: [
      [120, 0, -120],
      [60, -146.96938, 60],
    ],
    house: { first: 16, count: 16 },
    parts: {
      body: {
        ...part('body'),
        variants: variants ?? Object.fromEntries(CARGO_LOOKS.map((look) => [look, `HARV_body-${look}.png`])),
      },
      turret: part('turret'),
    },
    registration: [],
  };
}

function mockAssets(spec: VoxelProjectionManifest, missing: string[] = []) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('index.json'))
      return new Response(JSON.stringify({ version: 1, types: { [spec.type]: 'HARV.json' } }));
    if (url.endsWith('HARV.json')) return new Response(JSON.stringify(spec));
    return new Response('', { status: missing.some((name) => url.endsWith(name)) ? 404 : 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 320, height: 32, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
  return { fetchMock, bitmaps };
}

const model: VoxelModel = {
  id: 'HARV',
  palette: 'unit',
  normalsMode: 4,
  turretOffset: 50,
  parts: (['body', 'turret'] as const).map((role) => ({ role, sections: [syntheticSection(2, true)] })),
};

describe('how a harvester bin is drawn for its load', () => {
  it('is the page as drawn (gold ore) for ore, and for an object that reports no load', () => {
    expect(cargoLook(undefined)).toBe('');
    expect(cargoLook(null)).toBe('');
    expect(cargoLook({ ore: 1, gems: 0 })).toBe('');
    expect(cargoLook({ ore: 40, gems: 0 })).toBe('');
    // A little of the other kind does not change the picture.
    expect(cargoLook({ ore: 30, gems: 10 })).toBe('');
  });

  it('is empty below one bale, gems for a gem load and mixed between', () => {
    expect(cargoLook({ ore: 0, gems: 0 })).toBe('empty');
    expect(cargoLook({ ore: 0.25, gems: 0.2 })).toBe('empty');
    expect(cargoLook({ ore: 0, gems: 1 })).toBe('gems');
    expect(cargoLook({ ore: 10, gems: 30 })).toBe('gems');
    expect(cargoLook({ ore: 20, gems: 20 })).toBe('mixed');
    expect(cargoLook({ ore: 29, gems: 11 })).toBe('mixed');
    expect(cargoLook({ ore: 11, gems: 29 })).toBe('mixed');
  });

  it('treats unusable amounts as nothing carried', () => {
    expect(cargoLook({ ore: Number.NaN, gems: Number.NaN })).toBe('empty');
    expect(cargoLook({ ore: -5, gems: 3 })).toBe('gems');
  });

  it('selects a variant only for vehicles', () => {
    expect(artVariant({ kind: 'vehicle', cargo: { ore: 0, gems: 9 } })).toBe('gems');
    expect(artVariant({ kind: 'vehicle' })).toBe('');
    expect(artVariant({ kind: 'building', cargo: { ore: 0, gems: 9 } })).toBe('');
  });
});

describe('redraw page variants', () => {
  it('accepts variant pages on a part and rejects unusable names or paths', () => {
    expect(parseVoxelProjectionManifest(manifest()).parts.body!.variants).toEqual({
      empty: 'HARV_body-empty.png',
      gems: 'HARV_body-gems.png',
      mixed: 'HARV_body-mixed.png',
    });
    expect(parseVoxelProjectionManifest(manifest({})).parts.body!.variants).toEqual({});
    for (const bad of [
      { Gems: 'a.png' },
      { 'gems!': 'a.png' },
      { gems: '../a.png' },
      { gems: '/abs/a.png' },
      { '': 'a.png' },
    ])
      expect(() => parseVoxelProjectionManifest(manifest(bad))).toThrow('Invalid projection variant');
    const notAnObject = manifest();
    (notAnObject.parts.body as { variants: unknown }).variants = ['gems'];
    expect(() => parseVoxelProjectionManifest(notAnObject)).toThrow();
  });

  it('loads the variant pages with the type: same frames and paint, another colour page, parts without one shared', async () => {
    const { fetchMock, bitmaps } = mockAssets(manifest());
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    expect(library.hasVariant('HARV', 'gems')).toBe(false);
    const base = (await library.loadType('HARV', ['body', 'turret']))!;
    // index + manifest + 2 parts x (colour, paint) + 3 variant pages.
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(bitmaps).toHaveLength(7);
    expect(library.get('HARV', ['body'])).toBe(base);
    expect(library.get('HARV', ['body'], '')).toBe(base);
    for (const look of CARGO_LOOKS) {
      expect(library.hasVariant('HARV', look)).toBe(true);
      const variant = library.get('HARV', ['body', 'turret'], look)!;
      expect(variant).not.toBe(base);
      expect(variant.manifest).toBe(base.manifest);
      expect(variant.parts.body!.colour).not.toBe(base.parts.body!.colour);
      expect(variant.parts.body!.paint).toBe(base.parts.body!.paint);
      expect(variant.parts.body!.frameTable).toBe(base.parts.body!.frameTable);
      expect(variant.parts.body!.spec).toBe(base.parts.body!.spec);
      // The gun has no variant: the very same part, so it keeps its material.
      expect(variant.parts.turret).toBe(base.parts.turret);
      expect(await library.loadType('HARV', ['body'], look)).toBe(variant);
    }
    // A name the type does not have is the base look, not an error.
    expect(library.hasVariant('HARV', 'frozen')).toBe(false);
    expect(library.get('HARV', ['body'], 'frozen')).toBe(base);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    const pages = CARGO_LOOKS.map((look) => library.get('HARV', ['body'], look)!.parts.body!.colour);
    const disposed = pages.map((page) => vi.spyOn(page, 'dispose'));
    nodes.dispose();
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce();
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('keeps the base page for a variant whose page is missing, and warns once', async () => {
    mockAssets(manifest(), ['HARV_body-gems.png']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    const base = (await library.loadType('HARV'))!;
    expect(base).not.toBeNull();
    expect(library.hasVariant('HARV', 'gems')).toBe(false);
    expect(library.get('HARV', ['body'], 'gems')).toBe(base);
    expect(library.hasVariant('HARV', 'empty')).toBe(true);
    expect(library.get('HARV', ['body'], 'empty')).not.toBe(base);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('HARV@gems');
    nodes.dispose();
  });

  it('a manifest without variants loads exactly as before', async () => {
    const plain = manifest();
    delete plain.parts.body!.variants;
    const { fetchMock } = mockAssets(plain);
    const nodes = new AtmosphereNodes();
    const library = voxelProjectionLibrary('/vehicles-hd', nodes);
    const base = (await library.loadType('HARV'))!;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(base.variants).toBeUndefined();
    expect(library.get('HARV', ['body'], 'gems')).toBe(base);
    nodes.dispose();
  });

  it('paints a unit of a variant with that page: another body material, the same gun material', async () => {
    mockAssets(manifest());
    const nodes = new AtmosphereNodes();
    const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
    const world = { nodes, voxelProjection: '/vehicles-hd' } as HdWorld;
    const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
    const units = new VoxelUnits(hd, world, cache);
    await vi.waitFor(() => expect(units.prepare(model, 'unit', 'HARV@unit')).toBe(true));
    expect(units.hasVariant(model, 'gems')).toBe(true);
    expect(units.hasVariant(model, '')).toBe(false);
    // The variants came with the type: a unit of one is final at once.
    expect(units.prepare(model, 'unit', 'HARV@unit#gems', 'gems')).toBe(true);
    const materials = (unit: { root: Group }) => {
      const found: { name: string }[] = [];
      unit.root.traverse((object) => {
        if (object instanceof Mesh && object.userData.painterDepth) found.push(object.material as { name: string });
      });
      return found;
    };
    const ore = materials(units.build(model, 'unit', 'HARV@unit'));
    const gems = materials(units.build(model, 'unit', 'HARV@unit#gems', 'gems'));
    const again = materials(units.build(model, 'unit', 'HARV@unit#gems', 'gems'));
    expect(ore).toHaveLength(2);
    for (const material of [...ore, ...gems]) expect(material.name).toContain('-projected');
    expect(gems[0]).not.toBe(ore[0]);
    expect(gems[1]).toBe(ore[1]);
    expect(again).toEqual(gems);
    expect(again[0]).toBe(gems[0]);
    nodes.dispose();
  });
});

interface TestVisual {
  type: string;
  variant?: string;
  paletteKey: string;
  firstFrame: number;
  root: Group;
  mode: string;
  lastMoveFrame?: number;
}

/** The real visual selection of LiveView with GPU construction replaced by a scene group (see liveImageType.test). */
function visualView() {
  const types = new Map<string, LibraryType>();
  const models = new Map<string, VoxelModel>();
  for (const id of ['HARV', 'HORV', 'MTNK']) {
    types.set(id, {
      kind: 'vehicle',
      image: id,
      voxel: `${id}-voxel`,
      drawOffset: [0, 0],
      lighting: 'full',
      remap: true,
    });
    models.set(`${id}-voxel`, { id, palette: 'unit', normalsMode: 4, parts: [] });
  }
  const state = {
    library: {
      type: vi.fn((id: string) => types.get(id)),
      voxel: vi.fn((id: string) => models.get(id) ?? null),
      voxelType: vi.fn((voxel: string) => [...types].find(([, type]) => type.voxel === voxel)?.[0]),
      voxelFailed: vi.fn(() => false),
    },
    cache: {
      voxels: new Map<string, VoxelModel>(),
      manifest: { sprites: {} as Record<string, { frames: unknown[] }> },
      paletteRow: new Map([['lib:unit@house0', 0]]),
    },
    voxelUnits: {
      geometryReady: vi.fn(() => true),
      prepare: vi.fn((_model: VoxelModel, _palette: string, _key: string, _variant?: string) => true),
      build: vi.fn((_model: VoxelModel, _palette: string, _key: string, _variant?: string) => ({ root: new Group() })),
      dispose: vi.fn((unit: { root: Group }) => unit.root.removeFromParent()),
    },
    root: new Group(),
    visuals: new Map<number, TestVisual>(),
    appearances: new Map<number, { frame: number }>(),
    housePaletteKeys: new Map([[0, 'house0']]),
    libraryPaletteKeys: new Map<string, string>(),
    warnedTypes: new Set<string>(),
    options: {},
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    visualFor(object: LiveObject, colorIndex: number, frame: number): TestVisual;
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'vehicle',
    type: 'HARV',
    owner: 0,
    x: 256,
    y: 512,
    z: 0,
    facingRaw: 0,
    health: 1,
    isSelected: false,
  };
  return { view, state, models, object };
}

describe('a live miner follows its load', () => {
  it('is built with the variant of its load and rebuilt only when the look changes', () => {
    const h = visualView();
    h.object.cargo = { ore: 0, gems: 0 };
    const empty = h.view.visualFor(h.object, 0, 10);
    expect(empty).toMatchObject({ type: 'HARV', mode: 'voxel', variant: 'empty' });
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(
      h.models.get('HARV-voxel'),
      'lib:unit@house0',
      'HARV@lib:unit@house0#empty',
      'empty',
    );
    Object.assign(empty, { lastMoveFrame: 9 });
    // Gathering ore: the first bale fills the bin with ore; further bales change nothing.
    h.object.cargo = { ore: 1, gems: 0 };
    const ore = h.view.visualFor(h.object, 0, 11);
    expect(ore).not.toBe(empty);
    expect(h.state.voxelUnits.dispose).toHaveBeenCalledWith(empty);
    expect(ore).toMatchObject({ variant: '', lastMoveFrame: 9 });
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(
      h.models.get('HARV-voxel'),
      'lib:unit@house0',
      'HARV@lib:unit@house0',
      '',
    );
    h.object.cargo = { ore: 25, gems: 0 };
    expect(h.view.visualFor(h.object, 0, 12)).toBe(ore);
    // Moving on to a gem field: mixed, then gems.
    h.object.cargo = { ore: 25, gems: 15 };
    const mixed = h.view.visualFor(h.object, 0, 13);
    expect(mixed).toMatchObject({ variant: 'mixed' });
    h.object.cargo = { ore: 2, gems: 38 };
    const gems = h.view.visualFor(h.object, 0, 14);
    expect(gems).toMatchObject({ variant: 'gems' });
    expect(h.view.visualFor(h.object, 0, 15)).toBe(gems);
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(4);
    expect(h.state.root.children).toEqual([gems.root]);
  });

  it('carries the load into the unloading image and shows the emptied bin after it', () => {
    const h = visualView();
    h.object.cargo = { ore: 0, gems: 40 };
    const full = h.view.visualFor(h.object, 0, 10);
    h.object.imageType = 'HORV';
    const unloading = h.view.visualFor(h.object, 0, 11);
    expect(unloading).not.toBe(full);
    expect(unloading).toMatchObject({ type: 'HORV', variant: 'gems' });
    expect(h.state.voxelUnits.prepare).toHaveBeenLastCalledWith(
      h.models.get('HORV-voxel'),
      'lib:unit@house0',
      'HORV@lib:unit@house0#gems',
      'gems',
    );
    h.object.cargo = { ore: 0, gems: 0 };
    expect(h.view.visualFor(h.object, 0, 12)).toMatchObject({ type: 'HORV', variant: 'empty' });
    delete h.object.imageType;
    expect(h.view.visualFor(h.object, 0, 13)).toMatchObject({ type: 'HARV', variant: 'empty' });
  });

  it('leaves a unit that reports no load on the pages as drawn', () => {
    const h = visualView();
    h.object.type = 'MTNK';
    const tank = h.view.visualFor(h.object, 0, 10);
    expect(tank.variant).toBe('');
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(
      h.models.get('MTNK-voxel'),
      'lib:unit@house0',
      'MTNK@lib:unit@house0',
      '',
    );
    expect(h.view.visualFor(h.object, 0, 11)).toBe(tank);
  });
});
