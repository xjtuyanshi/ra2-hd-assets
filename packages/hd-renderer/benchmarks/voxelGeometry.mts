/** Run from the repository root: pnpm exec node --import tsx packages/hd-renderer/benchmarks/voxelGeometry.mts */
import { performance } from 'node:perf_hooks';
import { buildVoxelGeometry } from '../src/ra2/voxels';
import { buildLegacyPartGeometry } from '../tests/fixtures/legacyVoxelGeometry';
import { syntheticModel, syntheticSection } from '../tests/fixtures/syntheticVoxels';

const iterations = 25;
function median(values: number[]) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

for (const solid of [true, false]) {
  const section = syntheticSection(24, solid);
  const legacy = () => buildLegacyPartGeometry([section]);
  // A fresh model deliberately misses the per-model cache, measuring actual geometry construction.
  const optimized = () => buildVoxelGeometry(syntheticModel([section]), null)[0]!.geometry;
  for (let i = 0; i < 8; i++) {
    legacy().dispose();
    optimized().dispose();
  }
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < iterations; i++) {
    // Alternate execution order to reduce systematic order / GC effects.
    for (const which of i % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      const geometry = which ? optimized() : legacy();
      (which ? after : before).push(performance.now() - start);
      geometry.dispose();
    }
  }
  const beforeMs = median(before);
  const afterMs = median(after);
  const model = syntheticModel([section]);
  const cached = buildVoxelGeometry(model, null);
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) buildVoxelGeometry(model, null);
  const cachedUs = ((performance.now() - start) * 1000) / 10_000;
  console.log(
    JSON.stringify({
      node: process.version,
      shape: solid ? 'solid 24-cube' : 'perforated 24-cube',
      voxels: Buffer.from(section.voxels, 'base64').length / 5,
      vertices: cached[0]!.geometry.getAttribute('position').count,
      iterations,
      beforeMs,
      afterMs,
      speedup: beforeMs / afterMs,
      cachedUs,
    }),
  );
  cached[0]!.geometry.dispose();
}
