import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { LiveView, type LiveObject } from '../src/live/liveView';

interface TestVisual {
  type: string;
  paletteKey: string;
  firstFrame: number;
  root: Group;
  mode: string;
  sprite?: string;
  libraryType?: LibraryType;
  pending?: boolean;
  lastMoveFrame?: number;
  firedFrame?: number;
  deadFrame?: number;
}

/** Exercise the real visual selection/cache methods with GPU construction replaced by a scene group. */
function visualView() {
  const types = new Map<string, LibraryType>();
  const models = new Map<string, VoxelModel>();
  for (const id of ['HARV', 'HORV', 'CMIN', 'CMON']) {
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
    },
    cache: {
      voxels: new Map<string, VoxelModel>(),
      manifest: { sprites: {} as Record<string, { frames: unknown[] }> },
      paletteRow: new Map([
        ['lib:unit@house0', 0],
        ['lib:unit@house1', 1],
      ]),
    },
    voxelUnits: {
      build: vi.fn((_model: VoxelModel, _palette: string, _key: string) => ({ root: new Group() })),
      dispose: vi.fn((unit: { root: Group }) => unit.root.removeFromParent()),
    },
    root: new Group(),
    visuals: new Map<number, TestVisual>(),
    appearances: new Map<number, { frame: number }>(),
    housePaletteKeys: new Map([
      [0, 'house0'],
      [1, 'house1'],
    ]),
    libraryPaletteKeys: new Map<string, string>(),
    warnedTypes: new Set<string>(),
    options: {},
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    visualFor(object: LiveObject, colorIndex: number, frame: number): TestVisual;
    buildVisual(object: LiveObject, paletteKey: string, firstFrame: number): TestVisual;
    artReady(object: LiveObject): boolean;
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
  return { view, state, types, models, object };
}

describe('live engine-selected draw images', () => {
  it.each([
    ['HARV', 'HORV'],
    ['CMIN', 'CMON'],
  ])('draws %s as %s and rebuilds on both image transitions while retaining animation clocks', (type, imageType) => {
    const h = visualView();
    Object.assign(h.object, { type });
    const normal = h.view.visualFor(h.object, 0, 10);
    Object.assign(normal, { lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    expect(h.view.visualFor(h.object, 0, 11)).toBe(normal);
    h.object.imageType = imageType;
    const unloading = h.view.visualFor(h.object, 0, 12);
    expect(unloading).not.toBe(normal);
    expect(h.state.voxelUnits.dispose).toHaveBeenCalledWith(normal);
    expect(unloading).toMatchObject({ type: imageType, mode: 'voxel', lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    expect(unloading.libraryType).toBe(h.types.get(imageType));
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(
      h.models.get(`${imageType}-voxel`),
      'lib:unit@house0',
      `${imageType}@lib:unit@house0`,
    );
    expect(h.state.root.children).toEqual([unloading.root]);
    expect(h.view.visualFor(h.object, 0, 13)).toBe(unloading);
    delete h.object.imageType;
    const finished = h.view.visualFor(h.object, 0, 14);
    expect(finished).not.toBe(unloading);
    expect(finished).toMatchObject({ type, mode: 'voxel', lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    expect(h.state.voxelUnits.build).toHaveBeenCalledTimes(3);
    expect(h.object.type).toBe(type);
  });

  it.each(['missing-type', 'no-art'])('retains the rules art when the image has %s', (missing) => {
    const h = visualView();
    const normal = h.view.visualFor(h.object, 0, 10);
    if (missing === 'missing-type') h.types.delete('HORV');
    else delete h.types.get('HORV')!.voxel;
    h.object.imageType = 'HORV';
    expect(h.view.visualFor(h.object, 0, 11)).toBe(normal);
    expect(h.view.buildVisual(h.object, 'house0', 10)).toMatchObject({ type: 'HARV', mode: 'voxel' });
  });

  it('uses image art from the map cache even without a library type', () => {
    const h = visualView();
    h.object.imageType = 'HORV';
    h.types.delete('HORV');
    const model = h.models.get('HORV-voxel')!;
    h.state.cache.voxels.set('HORV', model);
    expect(h.view.artReady(h.object)).toBe(true);
    expect(h.view.visualFor(h.object, 0, 10)).toMatchObject({ type: 'HORV', mode: 'voxel' });
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(model, 'unit', 'HORV@unit');
  });

  it('repaints a selected image on owner change and preserves motion/fire/death state', () => {
    const h = visualView();
    h.object.imageType = 'HORV';
    const first = h.view.visualFor(h.object, 0, 10);
    Object.assign(first, { lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    h.object.owner = 1;
    const captured = h.view.visualFor(h.object, 1, 11);
    expect(captured).not.toBe(first);
    expect(captured).toMatchObject({
      type: 'HORV',
      paletteKey: 'house1',
      lastMoveFrame: 8,
      firedFrame: 9,
      deadFrame: 7,
    });
    expect(h.state.voxelUnits.build).toHaveBeenLastCalledWith(
      h.models.get('HORV-voxel'),
      'lib:unit@house1',
      'HORV@lib:unit@house1',
    );
  });

  it('retries the selected image when its voxel arrives and releases pending images when unloading ends', () => {
    const h = visualView();
    const model = h.models.get('HORV-voxel')!;
    h.models.delete('HORV-voxel');
    h.object.imageType = 'HORV';
    const pending = h.view.visualFor(h.object, 0, 10);
    expect(pending).toMatchObject({ type: 'HORV', pending: true });
    expect(h.view.artReady(h.object)).toBe(false);
    expect(h.view.visualFor(h.object, 0, 11)).toBe(pending);
    delete h.object.imageType;
    expect(h.view.visualFor(h.object, 0, 12)).toMatchObject({ type: 'HARV', mode: 'voxel' });
    h.object.imageType = 'HORV';
    const retry = h.view.visualFor(h.object, 0, 13);
    expect(retry.pending).toBe(true);
    h.models.set('HORV-voxel', model);
    expect(h.view.artReady(h.object)).toBe(true);
    const ready = h.view.visualFor(h.object, 0, 14);
    expect(ready).not.toBe(retry);
    expect(ready).toMatchObject({ type: 'HORV', mode: 'voxel' });
  });

  it('rebuilds a pending visual for a different image even when both voxels are still loading', () => {
    const h = visualView();
    h.models.clear();
    const pending = h.view.visualFor(h.object, 0, 10);
    h.object.imageType = 'HORV';
    const unloading = h.view.visualFor(h.object, 0, 11);
    expect(unloading).not.toBe(pending);
    expect(unloading).toMatchObject({ type: 'HORV', pending: true });
    expect(h.view.visualFor(h.object, 1, 12)).toMatchObject({ type: 'HORV', pending: true, paletteKey: 'house1' });
  });

  it('chooses library sprite art and map sprite ids from the image type', () => {
    const h = visualView();
    h.object.kind = 'infantry';
    h.object.imageType = 'HORV';
    const image = h.types.get('HORV')!;
    delete image.voxel;
    image.sprite = 'infantry:alternate';
    const sprite = h.view.buildVisual(h.object, 'house0', 10);
    expect(sprite).toMatchObject({ type: 'HORV', mode: 'library-sprite' });
    expect(sprite.libraryType).toBe(image);
    h.types.delete('HORV');
    h.object.kind = 'building';
    h.state.cache.manifest.sprites['building:HORV'] = { frames: [{}] };
    expect(h.view.buildVisual(h.object, 'house0', 10)).toMatchObject({
      type: 'HORV',
      mode: 'map-sprite',
      sprite: 'building:HORV',
    });
  });
});
