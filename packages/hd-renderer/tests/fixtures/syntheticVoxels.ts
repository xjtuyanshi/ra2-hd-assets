import type { VoxelModel, VoxelSection } from '../../../ra2-assets/src/manifest';

/** Deterministic synthetic data only: no original game assets are needed by tests or CPU benchmarks. */
export function syntheticSection(size: number, solid = false, normalsMode = 4): VoxelSection {
  const bytes: number[] = [];
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!solid && (x * 17 + y * 31 + z * 13) % 7 < 2) continue;
        bytes.push(x, y, z, 1 + ((x * 7 + y * 13 + z * 17) % 255), (x * 11 + y * 7 + z * 19) % 256);
      }
    }
  }
  return {
    name: 'synthetic',
    size: [size, size, size],
    scale: 1 / 12,
    minBounds: [-2.75, -0.325, -4.125],
    maxBounds: [size * 1.13, size * 0.7, size * 1.9],
    transform: [0.866, -0.5, 0.12, 2.375, 0.5, 0.866, 0.03, -3.175, 0.04, 0.09, 1.1, 0.213],
    normalsMode,
    voxels: Buffer.from(bytes).toString('base64'),
  };
}

export function syntheticModel(sections: VoxelSection[]): VoxelModel {
  return { id: 'SYNTHETIC', palette: 'unit', normalsMode: 4, parts: [{ role: 'body', sections }] };
}
