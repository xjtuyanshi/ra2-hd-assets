import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import { buildSmoothPartGeometry } from '../src/ra2/voxelSmoothGeometry';
import { DEFAULT_SMOOTH_VOXEL } from '../src/ra2/voxelSmooth';

// Explicit read-only input; game data, generated meshes, and benchmark output are never written to the checkout.
const directory = process.argv[2];
if (!directory)
  throw new Error('Usage: pnpm exec tsx packages/hd-renderer/scripts/benchmarkVoxelSmooth.ts <voxel-json-directory>');
console.log(
  `Node ${process.version}; supersample ${DEFAULT_SMOOTH_VOXEL.supersample}; IMLS; ${DEFAULT_SMOOTH_VOXEL.aoRays} AO rays; all parts; uncached builds`,
);
console.log('| Model | First (ms) | Warm median, 3 runs (ms) | Vertices | Triangles |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const id of ['HTNK', 'MTNK', 'HARV', 'SMCV', 'AMCV', 'BUS', 'CAR']) {
  const model = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as VoxelModel;
  const times: number[] = [];
  let vertices = 0;
  let triangles = 0;
  for (let run = 0; run < 4; run++) {
    const start = performance.now();
    const meshes = model.parts.map((p) => buildSmoothPartGeometry(p.sections, DEFAULT_SMOOTH_VOXEL));
    times.push(performance.now() - start);
    vertices = meshes.reduce((n, g) => n + g.getAttribute('position').count, 0);
    triangles = meshes.reduce((n, g) => n + g.index!.count / 3, 0);
    for (const mesh of meshes) mesh.dispose();
  }
  console.log(
    `| ${id} | ${times[0]!.toFixed(1)} | ${times
      .slice(1)
      .sort((a, b) => a - b)[1]!
      .toFixed(1)} | ${vertices} | ${triangles} |`,
  );
}
