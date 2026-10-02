import type { Color, Material } from 'three/webgpu';
import { normalGeometry, transformNormal, vec3 } from 'three/tsl';
import type { ShaderNode } from '../tsl';

/** Reflection radiance relative to the part's ambient-lit albedo, before waterline coverage. */
export const VOXEL_REFLECTION_AMBIENT = 0.6;
/** A small blue-grey absorption bias; alpha compositing supplies the local water colour underneath. */
export const VOXEL_REFLECTION_TINT = [0.95, 0.98, 1] as const;

type ReflectionColourBuilder = (sourceMatrix: ShaderNode) => ShaderNode;
const builders = new WeakMap<Material, ReflectionColourBuilder>();

/** The source material owns its palette/atlas and registers an allocation-time graph factory for its water twin. */
export function registerVoxelReflectionColour(material: Material, builder: ReflectionColourBuilder): void {
  builders.set(material, builder);
}

/** Never derive normals from the water twin's singular flattening matrix. */
export function voxelReflectionNormal(sourceMatrix: ShaderNode): ShaderNode {
  return transformNormal(normalGeometry, sourceMatrix).toVarying('voxelReflectionSourceNormal').normalize();
}

/** Direct light can only lower this ceiling; it never illuminates the reflection or contributes a highlight. */
export function voxelReflectionAmbient(
  albedo: ShaderNode,
  ambient: ShaderNode,
  sourceCeiling?: ShaderNode,
): ShaderNode {
  const colour = albedo
    .max(0)
    .mul(ambient.max(0))
    .mul(VOXEL_REFLECTION_AMBIENT)
    .mul(vec3(...VOXEL_REFLECTION_TINT));
  return sourceCeiling ? colour.min(sourceCeiling.max(0)) : colour;
}

/** Called once per renderer-owned reflection material, with the original unflattened mesh matrix uniform. */
export function voxelReflectionColour(material: Material, sourceMatrix: ShaderNode): ShaderNode {
  const build = builders.get(material);
  if (build) return build(sourceMatrix);
  const colour = (material as Material & { color?: Color }).color;
  return voxelReflectionAmbient(vec3(colour?.r ?? 1, colour?.g ?? 1, colour?.b ?? 1), vec3(1));
}
