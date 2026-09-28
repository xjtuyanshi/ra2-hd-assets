import { DataTexture, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import {
  Fn,
  clamp,
  color,
  float,
  max,
  mix,
  mx_noise_float,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from './tsl';
import { createWaterUniforms, waterSurface, type WaterUniforms } from './waterShading';

export type { WaterUniforms };

/**
 * Stylised-physical water for a fixed isometric camera: no planar reflection (sprites have no backs to reflect), only
 * an analytic sky, sun glints, depth-tinted body colour and shoreline foam driven by the terrain height texture.
 */
export function buildWater(
  width: number,
  height: number,
  waterY: number,
  heightTexture: DataTexture,
): { mesh: Mesh; uniforms: WaterUniforms } {
  // Extend past the map so the black border also covers seabed that parallax reveals below the plane's cut edge
  // (a surface 1 level lower shows up ~1.5 cells further out at the 30° pitch).
  const margin = 3;
  const geometry = new PlaneGeometry(width + margin * 2, height + margin * 2, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(width / 2, waterY, height / 2);

  const uniforms = createWaterUniforms();

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;

  material.colorNode = Fn(() => {
    const p: ShaderNode = positionWorld.xz;
    const { fresnel, sky, glint } = waterSurface(uniforms);

    // Depth from the terrain height texture (world units); shallow water is clear and warm, deep water dark teal.
    const terrainY = texture(heightTexture, p.div(vec2(width, height))).r;
    const signedDepth = float(waterY).sub(terrainY);
    const depth = max(signedDepth, 0);
    // RA2 shrouds the map border; fading to black also hides the cut edges of the water plane and seabed.
    const border = smoothstep(0.0, 1.5, p.x.min(p.y).min(float(width).sub(p.x)).min(float(height).sub(p.y)));
    const shallow = color(0x3f8f8a);
    const deep = color(0x0c2f3f);
    const body = mix(shallow, deep, smoothstep(0.0, 1.2, depth)).mul(uniforms.ambient.add(uniforms.sunColor.mul(0.35)));

    // Shoreline foam: bands travelling towards the beach, broken up by noise.
    const foamBand = sin(depth.mul(38.0).sub(time.mul(2.2)))
      .mul(0.5)
      .add(0.5);
    const foamNoise = mx_noise_float(vec3(p.mul(6.0), time.mul(0.4)))
      .mul(0.5)
      .add(0.5);
    const lapping = smoothstep(0.06, 0.0, depth).mul(foamNoise.mul(1.4).sub(0.2));
    const foam = smoothstep(0.28, 0.0, depth).mul(smoothstep(0.3, 0.75, foamBand.mul(foamNoise).add(lapping)));
    const lit = mix(body, sky, fresnel).add(glint);
    const withFoam = mix(lit, uniforms.ambient.add(uniforms.sunColor.mul(0.8)), clamp(foam, 0, 1));

    // Terrain above the waterline already hides the plane by depth test, except along the map's cut edges.
    const wet = smoothstep(-0.005, 0.005, signedDepth);
    const alpha = clamp(smoothstep(0.0, 0.5, depth).mul(0.65).add(0.3).add(foam), 0, 1).mul(wet);
    return vec4(withFoam.mul(border).mul(wet), mix(float(1), alpha, border));
  })();

  const mesh = new Mesh(geometry, material);
  mesh.name = 'water';
  mesh.renderOrder = 10;
  return { mesh, uniforms };
}
