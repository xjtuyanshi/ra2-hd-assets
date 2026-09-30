export type VoxelMaterialClass = 'house' | 'paint' | 'metal' | 'dark' | 'rubber' | 'glass' | 'light';

export interface VoxelMaterialParameters {
  kind: VoxelMaterialClass;
  roughness: number;
  metalness: number;
  emissive: number;
}

export const VOXEL_CLASS_ID: Readonly<Record<VoxelMaterialClass, number>> = {
  house: 0,
  paint: 1,
  metal: 2,
  dark: 3,
  rubber: 4,
  glass: 5,
  light: 6,
};

/** RA2 unit-palette policy, separate from the mesher and the procedural shading mechanism.
 * No stock ramp is confidently glass: keep blue paint blue paint until an explicit art classification is supplied.
 * RGB arguments are reserved for future palette-specific tuning, including non-stock house remaps.
 */
export function ra2VoxelClass(index: number, _r: number, _g: number, _b: number): VoxelMaterialParameters {
  let kind: VoxelMaterialClass = 'paint';
  let roughness = 0.5;
  let metalness = 0.1;
  let emissive = 0;
  if (index >= 16 && index <= 31) {
    kind = 'house';
    roughness = 0.36;
    metalness = 0.2;
  } else if ((index >= 32 && index <= 47) || (index >= 12 && index <= 14)) {
    kind = 'metal';
    roughness = 0.32;
    metalness = 0.85;
  } else if (index >= 48 && index <= 56) {
    kind = 'dark';
    roughness = 0.42;
    metalness = 0.75;
  } else if ((index >= 57 && index <= 63) || (index >= 160 && index <= 167)) {
    kind = 'rubber';
    roughness = 0.82;
    metalness = 0;
  } else if (index >= 176 && index <= 199) roughness = 0.45;
  else if (index >= 200 && index <= 203) roughness = 0.4;
  else if (index >= 240 && index <= 255) {
    kind = 'light';
    roughness = 0.3;
    emissive = 0.6;
  }
  return { kind, roughness, metalness, emissive };
}
