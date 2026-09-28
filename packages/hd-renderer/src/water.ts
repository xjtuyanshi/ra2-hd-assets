import { Color, DataTexture, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from './tsl';

export interface WaterUniforms {
  sunDirection: ShaderNode;
  sunColor: ShaderNode;
  skyZenith: ShaderNode;
  skyHorizon: ShaderNode;
  ambient: ShaderNode;
  rain: ShaderNode;
  wind: ShaderNode;
}

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

  const uniforms: WaterUniforms = {
    sunDirection: uniform(new Vector3(-0.6, 0.7, -0.2).normalize()),
    sunColor: uniform(new Color(1, 0.95, 0.85)),
    skyZenith: uniform(new Color(0.25, 0.45, 0.75)),
    skyHorizon: uniform(new Color(0.7, 0.8, 0.9)),
    ambient: uniform(new Color(0.4, 0.45, 0.5)),
    rain: uniform(0),
    wind: uniform(0.3),
  };

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;

  const waveHeight = Fn(([p]: [ShaderNode]): ShaderNode => {
    const t: ShaderNode = time.mul(uniforms.wind.mul(0.6).add(0.25));
    const a = mx_noise_float(vec3(p.mul(0.9).add(vec2(t.mul(0.7), t.mul(0.4))), t.mul(0.2)));
    const b = mx_noise_float(vec3(p.mul(2.7).sub(vec2(t.mul(0.9), t.mul(-0.6))), t.mul(0.35)));
    const c = mx_noise_float(vec3(p.mul(7.5).add(vec2(t.mul(1.6), 0)), t.mul(0.8)));
    return a.mul(0.6).add(b.mul(0.3)).add(c.mul(0.07));
  });

  // Raindrop rings: sparse cells, each an expanding sine ring with a random phase.
  const rainRipples = Fn(([p]: [ShaderNode]): ShaderNode => {
    const cell = p.mul(4.0).floor();
    const seed = mx_noise_float(vec3(cell.mul(1.7), 0.0))
      .mul(0.5)
      .add(0.5);
    const seed2 = mx_noise_float(vec3(cell.mul(2.3), 5.0))
      .mul(0.5)
      .add(0.5);
    // Jitter each ring centre inside its cell and skip about half the cells so the pattern never reads as a grid.
    const local = p.mul(4.0).fract().sub(vec2(seed, seed2).mul(0.6).add(0.2));
    const phase = time.mul(1.1).add(seed.mul(9.0)).fract();
    const r = local.length();
    const ring = sin(r.sub(phase.mul(0.45)).mul(45.0))
      .mul(smoothstep(0.35, 0.0, r))
      .mul(float(1).sub(phase));
    const active = smoothstep(0.45, 0.55, seed2);
    return ring.mul(active).mul(uniforms.rain).mul(0.6);
  });

  material.colorNode = Fn(() => {
    const p: ShaderNode = positionWorld.xz;
    const e = float(0.05);
    const h0 = waveHeight(p).add(rainRipples(p).mul(0.25));
    const hx = waveHeight(p.add(vec2(e, 0))).add(rainRipples(p.add(vec2(e, 0))).mul(0.25));
    const hz = waveHeight(p.add(vec2(0, e))).add(rainRipples(p.add(vec2(0, e))).mul(0.25));
    const slope = float(0.12).add(uniforms.wind.mul(0.12));
    const n = normalize(vec3(h0.sub(hx).mul(slope).div(e), 1.0, h0.sub(hz).mul(slope).div(e)));

    const view = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(n, view), 0)), 5)));
    const r = reflect(view.negate(), n);
    const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0.0, 0.6, r.y));
    // Broad soft sheen plus sparse tight glints; too many tight glints read as noise at RTS distance.
    const sunDot = max(dot(r, uniforms.sunDirection), 0);
    const glint = pow(sunDot, 60).mul(0.35).add(pow(sunDot, 600).mul(2.0)).mul(uniforms.sunColor);

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
