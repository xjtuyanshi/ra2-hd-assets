import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import type { VoxelModel, VoxelPart } from '../../ra2-assets/src/manifest';
import { LiveView, type LiveObject } from '../src/live/liveView';
import { selectVoxelTurretModel, selectedVoxelTurretIndex } from '../src/ra2/voxelTurrets';
import { syntheticSection } from './fixtures/syntheticVoxels';

function model(): VoxelModel {
  const part = (role: VoxelPart['role'], size: number): VoxelPart => ({ role, sections: [syntheticSection(size)] });
  return {
    id: 'FV',
    palette: 'unit',
    normalsMode: 4,
    turretOffset: 32,
    parts: [part('body', 2), part('turret', 1), part('barrel', 1)],
    turretVariants: { '1': [part('turret', 3)], '2': [part('turret', 4)], '3': [part('turret', 5), part('barrel', 2)] },
  };
}

interface TestVisual {
  type: string;
  turretIndex?: number;
  root: Group;
  firstFrame: number;
  lastMoveFrame?: number;
  firedFrame?: number;
  deadFrame?: number;
}

/** Real LiveView selection/lifecycle with only the GPU mesh construction replaced. */
function visualView(source: VoxelModel, fromLibrary = false) {
  const state = {
    ...(fromLibrary
      ? {
          library: {
            type: vi.fn(() => ({ voxel: 'fv.json', remap: true })),
            voxel: vi.fn(() => source),
          },
        }
      : {}),
    cache: {
      voxels: new Map(fromLibrary ? [] : [['FV', source]]),
      manifest: { sprites: {} },
      paletteRow: new Map([
        ['unit@house0', 0],
        ['unit@house1', 1],
        ['lib:unit@house0', 2],
        ['lib:unit@house1', 3],
      ]),
    },
    voxelUnits: {
      build: vi.fn((_model: VoxelModel, _palette: string, _key: string, _variant: string) => ({ root: new Group() })),
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
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'vehicle',
    type: 'FV',
    owner: 0,
    x: 256,
    y: 512,
    z: 0,
    facingRaw: 1234,
    turretFacingRaw: 4321,
    health: 1,
    isSelected: false,
    turretIndex: 0,
  };
  return { view, state, object };
}

describe('engine-selected voxel turret models', () => {
  it('keeps the hull and model metadata, replaces both turret and barrel, and caches each selection', () => {
    const original = model();
    const repair = selectVoxelTurretModel(original, 2);
    expect(repair).not.toBe(original);
    expect(repair).toMatchObject({ id: 'FV', palette: 'unit', turretOffset: 32 });
    expect(repair.parts).toEqual([original.parts[0], ...original.turretVariants!['2']!]);
    expect(repair.parts[0]).toBe(original.parts[0]);
    expect(repair.parts.some((part) => part.role === 'barrel')).toBe(false);
    expect(selectVoxelTurretModel(original, 2)).toBe(repair);
    expect(selectedVoxelTurretIndex(repair)).toBe(2);
    expect(selectedVoxelTurretIndex(original)).toBe(0);
    for (const index of [1, 3]) {
      const selected = selectVoxelTurretModel(original, index);
      expect(selected.parts).toEqual([original.parts[0], ...original.turretVariants![String(index)]!]);
      expect(selectVoxelTurretModel(original, index)).toBe(selected);
      expect(selected).not.toBe(repair);
    }
    expect(original.parts).toHaveLength(3);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Infinity, 4])('retains the default for unavailable index %s', (index) => {
    const original = model();
    expect(selectVoxelTurretModel(original, index)).toBe(original);
  });

  it('retains legacy, missing and invalid variant art without changing its default part list', () => {
    for (const variants of [
      undefined,
      {},
      { '2': [] },
      { '2': [{ role: 'body' as const, sections: [] }] },
      { '2': [{ role: 'barrel' as const, sections: [syntheticSection(1)] }] },
      { '2': [{ role: 'turret' as const, sections: [] }] },
    ]) {
      const original = { ...model(), turretVariants: variants };
      expect(selectVoxelTurretModel(original, 2)).toBe(original);
    }
  });
});

describe('live passenger turret transitions', () => {
  it.each([false, true])('rebuilds 0 -> 2 -> 0 from library=%s, preserving clocks and cache identities', (library) => {
    const original = model();
    const { view, state, object } = visualView(original, library);
    const palette = `${library ? 'lib:' : ''}unit@house0`;
    const normal = view.visualFor(object, 0, 10);
    Object.assign(normal, { lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    expect(view.visualFor(object, 0, 11)).toBe(normal);
    object.turretIndex = 2;
    const repair = view.visualFor(object, 0, 12);
    expect(repair).toMatchObject({ turretIndex: 2, firstFrame: 10, lastMoveFrame: 8, firedFrame: 9, deadFrame: 7 });
    expect(state.voxelUnits.dispose).toHaveBeenCalledWith(normal);
    expect(state.voxelUnits.build).toHaveBeenLastCalledWith(
      selectVoxelTurretModel(original, 2),
      palette,
      `FV@${palette}:turret2`,
      '',
    );
    expect(view.visualFor(object, 0, 13)).toBe(repair);
    object.turretIndex = 0;
    const empty = view.visualFor(object, 0, 14);
    expect(empty).toMatchObject({ turretIndex: 0, firstFrame: 10, firedFrame: 9 });
    expect(state.voxelUnits.build).toHaveBeenLastCalledWith(original, palette, `FV@${palette}`, '');
    expect(state.root.children).toEqual([empty.root]);
    expect(state.voxelUnits.build).toHaveBeenCalledTimes(3);
    expect(object).toMatchObject({ type: 'FV', facingRaw: 1234, turretFacingRaw: 4321 });
  });

  it('separates different passenger turrets, owner palettes and cargo pages while sharing selected models', () => {
    const original = model();
    const { view, state, object } = visualView(original);
    object.turretIndex = 1;
    view.visualFor(object, 0, 10);
    const machineGun = state.voxelUnits.build.mock.calls.at(-1)![0];
    object.turretIndex = 3;
    const third = view.visualFor(object, 0, 11);
    expect(state.voxelUnits.build.mock.calls.at(-1)![0]).not.toBe(machineGun);
    object.owner = 1;
    const captured = view.visualFor(object, 1, 12);
    expect(captured).not.toBe(third);
    expect(state.voxelUnits.build).toHaveBeenLastCalledWith(
      selectVoxelTurretModel(original, 3),
      'unit@house1',
      'FV@unit@house1:turret3',
      '',
    );
    object.turretIndex = 1;
    object.cargo = { ore: 0, gems: 3 };
    view.visualFor(object, 1, 13);
    expect(state.voxelUnits.build).toHaveBeenLastCalledWith(
      machineGun,
      'unit@house1',
      'FV@unit@house1:turret1#gems',
      'gems',
    );
    expect(state.root.children).toHaveLength(1);
  });

  it('does not churn the visual when an old cache or missing variant can only show the default turret', () => {
    for (const variants of [undefined, { '1': model().turretVariants!['1']! }]) {
      const original = { ...model(), turretVariants: variants };
      const { view, state, object } = visualView(original);
      const normal = view.visualFor(object, 0, 10);
      for (const index of [2, 0, 4, undefined]) {
        object.turretIndex = index;
        expect(view.visualFor(object, 0, 11)).toBe(normal);
      }
      expect(state.voxelUnits.build).toHaveBeenCalledOnce();
    }
  });
});
