import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { setPaletteNodes } from '../src/ra2/mapLighting';
import { buildVoxelGeometry, setVoxelShapeFor, voxelShape, voxelShapeFor } from '../src/ra2/voxels';
import { buildLegacyPartGeometry } from './fixtures/legacyVoxelGeometry';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

function expectIdentical(actual: BufferGeometry, expected: BufferGeometry) {
  for (const name of ['position', 'normal', 'pindex', 'occlusion']) {
    const a = actual.getAttribute(name);
    const e = expected.getAttribute(name);
    expect(a.itemSize, name).toBe(e.itemSize);
    expect(a.array, name).toEqual(e.array);
  }
  expect(actual.getIndex()!.array).toEqual(expected.getIndex()!.array);
  expect(actual.boundingSphere).toEqual(expected.boundingSphere);
}

describe('optimized voxel geometry', () => {
  it('matches the original builder exactly for all 256 corner occupancy patterns', () => {
    const sections = Array.from({ length: 256 }, (_, mask) => {
      const section = syntheticSection(2);
      const bytes: number[] = [];
      for (let z = 0; z < 2; z++) {
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            const bit = x + 2 * y + 4 * z;
            if (mask & (1 << bit)) bytes.push(x, y, z, 17 + bit * 7, bit * 29);
          }
        }
      }
      return { ...section, voxels: Buffer.from(bytes).toString('base64') };
    });
    const expected = buildLegacyPartGeometry(sections);
    const actual = buildVoxelGeometry(syntheticModel(sections), null)[0]!.geometry;
    expectIdentical(actual, expected);
    actual.dispose();
    expected.dispose();
  });

  it.each([
    { cornerRelax: 0.6, normalBlend: 0.15 },
    { cornerRelax: 0, normalBlend: 0 },
    { cornerRelax: 0.7, normalBlend: 0.35 },
  ])('preserves mixed normal tables, transforms, AO and interior cells at %j', (shape) => {
    const saved = { ...voxelShape };
    Object.assign(voxelShape, shape);
    try {
      const sections = [syntheticSection(6, false, 4), syntheticSection(5, true, 2), syntheticSection(1)];
      // Old extracted sections have no explicit normal-table mode; retain the inference path.
      delete sections[2]!.normalsMode;
      const expected = buildLegacyPartGeometry(sections);
      const actual = buildVoxelGeometry(syntheticModel(sections), null)[0]!.geometry;
      expectIdentical(actual, expected);
      actual.dispose();
      expected.dispose();
    } finally {
      Object.assign(voxelShape, saved);
    }
  });

  it('retains Uint32 indices for geometry above the Uint16 vertex limit', () => {
    const sections = [syntheticSection(24)];
    const expected = buildLegacyPartGeometry(sections);
    const actual = buildVoxelGeometry(syntheticModel(sections), null)[0]!.geometry;
    expect(actual.getIndex()!.array).toBeInstanceOf(Uint32Array);
    expectIdentical(actual, expected);
    actual.dispose();
    expected.dispose();
  });

  it('isolates renderer shape snapshots and shares only equal model/shape variants', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const c = new AtmosphereNodes();
    const rounded = { cornerRelax: 0.6, normalBlend: 0.15 };
    setVoxelShapeFor(a, rounded);
    setVoxelShapeFor(b, { cornerRelax: 0, normalBlend: 0 });
    setVoxelShapeFor(c, rounded);
    rounded.cornerRelax = 0;
    expect(voxelShapeFor(a)).toEqual({ cornerRelax: 0.6, normalBlend: 0.15 });
    expect(Object.isFrozen(voxelShapeFor(a))).toBe(true);
    const model = syntheticModel([syntheticSection(4)]);
    const palette = new Uint8Array(768);
    setPaletteNodes(palette, a);
    const first = buildVoxelGeometry(model, palette)[0]!.geometry;
    const second = buildVoxelGeometry(model, palette, b)[0]!.geometry;
    const third = buildVoxelGeometry(model, palette, c)[0]!.geometry;
    expect(second).not.toBe(first);
    expect(second.getAttribute('position').array).not.toEqual(first.getAttribute('position').array);
    expect(second.getAttribute('normal').array).not.toEqual(first.getAttribute('normal').array);
    expect(third).toBe(first);
    expect(buildVoxelGeometry(model, null, a, { cornerRelax: 0, normalBlend: 0 })[0]!.geometry).toBe(second);
    // An explicit new setting selects a different cached variant without mutating another renderer's snapshot.
    setVoxelShapeFor(b, voxelShapeFor(a));
    expect(buildVoxelGeometry(model, palette, b)[0]!.geometry).toBe(first);
    first.dispose();
    second.dispose();
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('captures legacy defaults once per context before later asynchronous builds', () => {
    const saved = { ...voxelShape };
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    try {
      const first = voxelShapeFor(a);
      voxelShape.cornerRelax = 0;
      voxelShape.normalBlend = 0;
      const second = voxelShapeFor(b);
      expect(voxelShapeFor(a)).toBe(first);
      expect(first).toEqual(saved);
      expect(second).toEqual({ cornerRelax: 0, normalBlend: 0 });
      const model = syntheticModel([syntheticSection(3)]);
      const original = buildVoxelGeometry(model, null, a)[0]!.geometry;
      const changed = buildVoxelGeometry(model, null, b)[0]!.geometry;
      expect(changed).not.toBe(original);
      // Calls without a renderer keep the legacy default-setting API.
      expect(buildVoxelGeometry(model, null)[0]!.geometry).toBe(changed);
      original.dispose();
      changed.dispose();
    } finally {
      Object.assign(voxelShape, saved);
      a.dispose();
      b.dispose();
    }
  });

  it('reuses palette-independent geometry for repeat calls on the same model', () => {
    const model = syntheticModel([syntheticSection(3)]);
    const first = buildVoxelGeometry(model, null);
    const second = buildVoxelGeometry(model, new Uint8Array(768));
    expect(second[0]!.geometry).toBe(first[0]!.geometry);
    expect(second[0]!.material).not.toBe(first[0]!.material);
    first[0]!.geometry.dispose();
  });
});
