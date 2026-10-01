import { describe, expect, it } from 'vitest';
import { Mesh } from 'three/webgpu';
import { lookupNormal, normalTableFor } from '../../ra2-formats/src/vxl/vxlNormals';
import type { VoxelSection } from '../../ra2-assets/src/manifest';
import { AtmosphereNodes } from '../src/atmosphere';
import {
  buildSmoothSection,
  DEFAULT_SMOOTH_VOXEL,
  smoothVoxelOptions,
  type SmoothMeshData,
} from '../src/ra2/voxelSmooth';
import { buildSmoothPartGeometry, buildSmoothVoxelGeometry } from '../src/ra2/voxelSmoothGeometry';
import { VOXEL_TO_WORLD, instantiateVoxel } from '../src/ra2/voxels';
import { VoxelShadowMesh } from '../src/ra2/voxelShadow';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { HdRenderer } from '../src/HdRenderer';
import type { HdWorld } from '../src/ra2/world';
import type { Ra2Cache } from '../src/ra2/cache';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

/** A box with outward artist normals and identity bounds, independent of proprietary voxel art. */
function box(
  size: [number, number, number],
  palette: (x: number, y: number, z: number) => number = (x) => (x < 2 ? 20 : 70),
): VoxelSection {
  const bytes: number[] = [];
  const table = normalTableFor(4);
  for (let z = 0; z < size[2]; z++)
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < size[0]; x++) {
        const direction = [(x + 0.5) / size[0] - 0.5, (y + 0.5) / size[1] - 0.5, (z + 0.5) / size[2] - 0.5];
        let best = -Infinity;
        let normal = 0;
        for (let n = 0; n < table.length; n++) {
          const v = lookupNormal(table, n);
          const dot = v[0] * direction[0]! + v[1] * direction[1]! + v[2] * direction[2]!;
          if (dot > best) {
            best = dot;
            normal = n;
          }
        }
        bytes.push(x, y, z, palette(x, y, z), normal);
      }
  return {
    ...syntheticSection(1),
    size,
    minBounds: [0, 0, 0],
    maxBounds: size,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    normalsMode: 4,
    voxels: Buffer.from(bytes).toString('base64'),
  };
}

function closed(mesh: SmoothMeshData): void {
  const point = (i: number) => Array.from(mesh.position.subarray(i * 3, i * 3 + 3)).join(',');
  const edges = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangle = [point(mesh.indices[i]!), point(mesh.indices[i + 1]!), point(mesh.indices[i + 2]!)];
    for (let j = 0; j < 3; j++) {
      const key = [triangle[j], triangle[(j + 1) % 3]].sort().join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect(edges.size).toBeGreaterThan(0);
  expect([...edges.values()].every((n) => n === 2)).toBe(true);
}

/** Non-axis-aligned ray avoids coplanarity; coincident hits on a quad diagonal count only once. */
function contains(mesh: SmoothMeshData, origin: number[]): boolean {
  const dir = [1, 0.371, 0.193];
  const hits: number[] = [];
  const p = mesh.vpos;
  const index = mesh.indices;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i]! * 3;
    const b = index[i + 1]! * 3;
    const c = index[i + 2]! * 3;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const hx = dir[1]! * vz - dir[2]! * vy;
    const hy = dir[2]! * vx - dir[0]! * vz;
    const hz = dir[0]! * vy - dir[1]! * vx;
    const det = ux * hx + uy * hy + uz * hz;
    if (Math.abs(det) < 1e-9) continue;
    const tx = origin[0]! - p[a]!;
    const ty = origin[1]! - p[a + 1]!;
    const tz = origin[2]! - p[a + 2]!;
    const u = (tx * hx + ty * hy + tz * hz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * uz - tz * uy;
    const qy = tz * ux - tx * uz;
    const qz = tx * uy - ty * ux;
    const v = (dir[0]! * qx + dir[1]! * qy + dir[2]! * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (vx * qx + vy * qy + vz * qz) / det;
    if (t > 1e-7 && !hits.some((h) => Math.abs(h - t) < 1e-6)) hits.push(t);
  }
  return hits.length % 2 === 1;
}

describe.each(['occupancy', 'imls'] as const)('smooth voxel %s', (shape) => {
  const options = { ...DEFAULT_SMOOTH_VOXEL, shape };
  it('closes a cube, preserves its bounds, points outward, and darkens ground contact', () => {
    const m = buildSmoothSection(box([5, 5, 5]), options);
    closed(m);
    let outward = 0;
    let bottom = 0;
    let bottomCount = 0;
    let top = 0;
    let topCount = 0;
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.pindex.length; i++) {
      const x = m.vpos[i * 3]!;
      const y = m.vpos[i * 3 + 1]!;
      const z = m.vpos[i * 3 + 2]!;
      const nx = m.normal[i * 3]!;
      const ny = -m.normal[i * 3 + 2]!;
      const nz = m.normal[i * 3 + 1]!;
      if ((x - 2.5) * nx + (y - 2.5) * ny + (z - 2.5) * nz > 0) outward++;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      if (z < 0.5) {
        bottom += m.occlusion[i]!;
        bottomCount++;
      }
      if (z > 4.5 && nz > 0.8) {
        top += m.occlusion[i]!;
        topCount++;
      }
      for (let a = 0; a < 3; a++) {
        mins[a] = Math.min(mins[a]!, m.vpos[i * 3 + a]!);
        maxs[a] = Math.max(maxs[a]!, m.vpos[i * 3 + a]!);
      }
    }
    expect(outward / m.pindex.length).toBeGreaterThan(0.95);
    for (let a = 0; a < 3; a++) {
      expect(mins[a]).toBeGreaterThanOrEqual(-options.bandOut - 1 / options.supersample);
      expect(mins[a]).toBeLessThan(options.bandIn + 1 / options.supersample);
      expect(maxs[a]).toBeLessThanOrEqual(5 + options.bandOut + 1 / options.supersample);
      expect(maxs[a]).toBeGreaterThan(5 - options.bandIn - 1 / options.supersample);
    }
    expect(bottomCount).toBeGreaterThan(0);
    expect(topCount).toBeGreaterThan(0);
    expect(bottom / bottomCount).toBeGreaterThan(top / topCount + 0.15);
    // Actual face winding, independently of the shading normals.
    let front = 0;
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = Array.from(m.indices.subarray(i, i + 3), (v) => v * 3);
      const p = m.vpos;
      const ux = p[b!]! - p[a!]!;
      const uy = p[b! + 1]! - p[a! + 1]!;
      const uz = p[b! + 2]! - p[a! + 2]!;
      const vx = p[c!]! - p[a!]!;
      const vy = p[c! + 1]! - p[a! + 1]!;
      const vz = p[c! + 2]! - p[a! + 2]!;
      if (
        (uy * vz - uz * vy) * (p[a!]! - 2.5) +
          (uz * vx - ux * vz) * (p[a! + 1]! - 2.5) +
          (ux * vy - uy * vx) * (p[a! + 2]! - 2.5) >
        0
      )
        front++;
    }
    expect(front / (m.indices.length / 3)).toBeGreaterThan(0.99);
  });
  it('retains every centre of a one-voxel rod', () => {
    const m = buildSmoothSection(box([1, 1, 8]), options);
    closed(m);
    for (let z = 0; z < 8; z++) expect(contains(m, [0.5, 0.5, z + 0.5]), `centre ${z}`).toBe(true);
    const heights = Array.from(m.vpos).filter((_, i) => i % 3 === 2);
    expect(Math.min(...heights)).toBeLessThan(0.5);
    expect(Math.max(...heights)).toBeGreaterThan(7.5);
  });
  it('preserves thin features at the minimum sample density and either normal endpoint', () => {
    for (const storedNormals of [0, 1]) {
      const m = buildSmoothSection(box([1, 1, 8]), { ...options, supersample: 2, storedNormals, aoRays: 0 });
      closed(m);
      for (let z = 0; z < 8; z++) expect(contains(m, [0.5, 0.5, z + 0.5])).toBe(true);
      for (let i = 0; i < m.normal.length; i += 3) {
        expect(Math.hypot(m.normal[i]!, m.normal[i + 1]!, m.normal[i + 2]!)).toBeCloseTo(1, 5);
      }
    }
  });
  it('keeps each quad palette-constant and preserves the two side colours', () => {
    const m = buildSmoothSection(box([4, 4, 4]), options);
    let left = 0;
    let right = 0;
    for (let i = 0; i < m.pindex.length; i += 4) {
      expect(new Set(m.pindex.subarray(i, i + 4)).size).toBe(1);
      const x = (m.vpos[i * 3]! + m.vpos[(i + 1) * 3]! + m.vpos[(i + 2) * 3]! + m.vpos[(i + 3) * 3]!) / 4;
      if (x < 0.5) {
        expect(m.pindex[i]).toBe(20);
        left++;
      }
      if (x > 3.5) {
        expect(m.pindex[i]).toBe(70);
        right++;
      }
    }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });
  it('is deterministic and transforms positions/ground in the same frame as engine geometry', () => {
    const section = box([3, 3, 3]);
    const a = buildSmoothSection(section, options);
    expect(buildSmoothSection(section, options)).toEqual(a);
    section.transform[11] = 20;
    const raised = buildSmoothSection(section, options);
    expect(raised.vpos).toEqual(a.vpos);
    for (let i = 0; i < a.pindex.length; i++)
      expect(raised.position[i * 3 + 1]! - a.position[i * 3 + 1]!).toBeCloseTo(20 * VOXEL_TO_WORLD, 6);
    expect(raised.occlusion.reduce((n, v) => n + v, 0)).toBeLessThan(a.occlusion.reduce((n, v) => n + v, 0));
  });
});

describe('palette-independent shade smoothing', () => {
  const options = { ...DEFAULT_SMOOTH_VOXEL, aoRays: 0 };
  it('preserves a uniform block and its original material indices', () => {
    const m = buildSmoothSection(
      box([3, 3, 3], () => 36),
      options,
    );
    expect(m.pshade.length).toBeGreaterThan(0);
    expect(m.pshade).toEqual(m.pindex);
    expect(m.pshade.every((index) => index === 36)).toBe(true);
  });
  it('averages alternating shades without changing geometry or material classes', () => {
    const section = box([3, 3, 3], (x, y, z) => ((x + y + z) % 2 ? 36 : 38));
    const m = buildSmoothSection(section, options);
    const disabled = buildSmoothSection(section, { ...options, shadeRadius: 0 });
    expect(disabled.pshade).toEqual(disabled.pindex);
    expect(m.pshade.every((index) => index > 36 && index < 38)).toBe(true);
    expect(m.pshade.some((index) => !Number.isInteger(index))).toBe(true);
    for (const name of ['position', 'normal', 'pindex', 'occlusion', 'curvature', 'vpos', 'indices'] as const)
      expect(m[name], name).toEqual(disabled[name]);
  });
  it('uses the vertex-to-centre Gaussian distance and a unit-weight owning voxel', () => {
    const radius = 1.5;
    const m = buildSmoothSection(
      box([2, 1, 1], (x) => (x ? 38 : 36)),
      { ...options, shadeRadius: radius },
    );
    let blended = 0;
    for (let v = 0; v < m.pindex.length; v++) {
      const own = m.pindex[v]!;
      const other = own === 36 ? 38 : 36;
      const d = Math.hypot(
        m.vpos[v * 3]! - (own === 36 ? 1.5 : 0.5),
        m.vpos[v * 3 + 1]! - 0.5,
        m.vpos[v * 3 + 2]! - 0.5,
      );
      const w = d <= radius ? Math.exp(-(d * d) / (2 * (radius / 2) ** 2)) : 0;
      expect(m.pshade[v]).toBeCloseTo((own + other * w) / (1 + w), 5);
      if (w) blended++;
    }
    expect(blended).toBeGreaterThan(0);
  });
  it.each([
    { indices: [36, 60], shadeRamp: 16, shadeThreshold: 255 },
    { indices: [31, 32], shadeRamp: 16, shadeThreshold: 3 },
    { indices: [34, 36], shadeRamp: 7, shadeThreshold: 3 },
    { indices: [36, 40], shadeRamp: 16, shadeThreshold: 3 },
    { indices: [36, 38], shadeRamp: 16, shadeThreshold: 0 },
    { indices: [36, 38], shadeRamp: 1, shadeThreshold: 255 },
  ])('preserves ramp boundaries and deliberately separated details: %j', ({ indices, ...overrides }) => {
    const m = buildSmoothSection(
      box([2, 1, 1], (x) => indices[x]!),
      { ...options, ...overrides },
    );
    expect(new Set(m.pindex)).toEqual(new Set(indices));
    expect(m.pshade).toEqual(m.pindex);
  });
  it('does not let hidden interior voxels change the exposed paint', () => {
    const m = buildSmoothSection(
      box([3, 3, 3], (x, y, z) => (x === 1 && y === 1 && z === 1 ? 38 : 36)),
      {
        ...options,
        shadeRadius: 5,
      },
    );
    expect(m.pindex.every((index) => index === 36)).toBe(true);
    expect(m.pshade).toEqual(m.pindex);
  });
  it('keeps endpoint shades inside custom ramps, including a partial last ramp', () => {
    for (const [first, last, shadeRamp] of [
      [33, 34, 7],
      [254, 255, 7],
      [0, 255, 256],
    ]) {
      const m = buildSmoothSection(
        box([2, 1, 1], (x) => (x ? last! : first!)),
        {
          ...options,
          shadeRamp: shadeRamp!,
          shadeThreshold: 255,
        },
      );
      expect(m.pshade.every((index) => index >= first! && index <= last!)).toBe(true);
      expect(m.pshade.some((index) => index > first! && index < last!)).toBe(true);
    }
  });
});

it('shares equal options across houses and worlds, keeps depth/shadow twins, and widens merged indices', () => {
  const a = new AtmosphereNodes();
  const b = new AtmosphereNodes();
  const section = box([4, 4, 4]);
  const model = syntheticModel([section]);
  model.turretOffset = 32;
  const options = { aoRays: 0 };
  const first = buildSmoothVoxelGeometry(model, null, a, options);
  const second = buildSmoothVoxelGeometry(model, new Uint8Array(768), b, options);
  expect(first[0]!.geometry).toBe(second[0]!.geometry);
  expect(first[0]!.material).not.toBe(second[0]!.material);
  expect(first[0]!.turretOffset).toBe(32 / 256);
  const unit = instantiateVoxel(first, first[0]!.material!);
  const twins: VoxelShadowMesh[] = [];
  unit.root.traverse((o) => {
    if (o instanceof VoxelShadowMesh) twins.push(o);
  });
  expect(twins).toHaveLength(1);
  expect(twins[0]!.geometry).toBe(first[0]!.geometry);
  expect(first[0]!.material!.depthNode).toBeTruthy();
  const changed = buildSmoothVoxelGeometry(model, null, a, { aoRays: 0, bandOut: 0.1 });
  expect(changed[0]!.geometry).not.toBe(first[0]!.geometry);
  for (const shadeOptions of [{ shadeRadius: 0 }, { shadeThreshold: 1 }, { shadeRamp: 8 }]) {
    const variant = buildSmoothVoxelGeometry(model, null, a, { ...options, ...shadeOptions });
    expect(variant[0]!.geometry).not.toBe(first[0]!.geometry);
    variant[0]!.geometry.dispose();
  }
  const merged = buildSmoothPartGeometry(
    Array.from({ length: 24 }, () => section),
    smoothVoxelOptions(options),
  );
  expect(merged.getIndex()!.array).toBeInstanceOf(Uint32Array);
  expect(merged.boundingSphere!.radius).toBeGreaterThan(0);
  expect(merged.getAttribute('pshade').itemSize).toBe(1);
  expect(merged.getAttribute('pshade').count).toBe(merged.getAttribute('pindex').count);
  expect(merged.getAttribute('pshade').array.slice(0, first[0]!.geometry.getAttribute('pshade').count)).toEqual(
    first[0]!.geometry.getAttribute('pshade').array,
  );
  first[0]!.geometry.dispose();
  changed[0]!.geometry.dispose();
  merged.dispose();
  a.dispose();
  b.dispose();
});

it('rejects invalid geometry knobs before allocating', () => {
  for (const options of [
    { supersample: NaN },
    { supersample: 0 },
    { supersample: 1 },
    { supersample: 2.5 },
    { bandIn: 0.5 },
    { aoRays: -1 },
    ...(['shadeRadius', 'shadeThreshold', 'shadeRamp'] as const).flatMap((name) =>
      [-1, NaN, Infinity, -Infinity].map((value) => ({ [name]: value })),
    ),
    { shadeRamp: 0 },
    { shadeRamp: 257 },
    { shadeRamp: 1.5 },
  ])
    expect(() => smoothVoxelOptions(options)).toThrow(RangeError);
});

it('selects the live look at construction, inherits world options and snapshots partial overrides', () => {
  const nodes = new AtmosphereNodes();
  const hd = { nodes, settings: { voxelLook: 'engine' } } as HdRenderer;
  const cache = { paletteRgb: new Map([['unit', new Uint8Array(768)]]) } as Ra2Cache;
  const model = syntheticModel([box([2, 2, 2])]);
  const world = { voxelLook: 'remaster', smoothVoxel: smoothVoxelOptions({ supersample: 2, bandOut: 0.1 }) } as HdWorld;
  const options = { smoothVoxel: { aoRays: 0 } };
  const units = new VoxelUnits(hd, world, cache, undefined, options);
  options.smoothVoxel.aoRays = 48;
  const first = units.build(model, 'unit', 'synthetic');
  const source = first.root.children.find((o) => o instanceof Mesh && !(o instanceof VoxelShadowMesh)) as Mesh;
  const expected = buildSmoothVoxelGeometry(model, cache.paletteRgb.get('unit')!, nodes, {
    ...world.smoothVoxel,
    aoRays: 0,
  });
  expect(source.geometry).toBe(expected[0]!.geometry);
  expect(source.material).toBe(expected[0]!.material);
  expect(hd.settings.voxelLook).toBe('remaster');
  const engine = new VoxelUnits(hd, world, cache, undefined, { voxelLook: 'engine' }).build(model, 'unit', 'engine');
  const engineSource = engine.root.children.find((o) => o instanceof Mesh && !(o instanceof VoxelShadowMesh)) as Mesh;
  expect(engineSource.geometry.getAttribute('curvature')).toBeUndefined();
  expect(engineSource.geometry.getAttribute('pshade')).toBeUndefined();
  expect(engineSource.material).not.toBe(source.material);
  source.geometry.dispose();
  engineSource.geometry.dispose();
  nodes.dispose();
});
