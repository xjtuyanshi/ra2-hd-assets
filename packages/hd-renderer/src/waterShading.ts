import { Color, Vector3 } from 'three/webgpu';
import {
  Fn,
  cameraPosition,
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
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { ShaderNode } from './tsl';

/** Scene-driven inputs shared by every water surface (updated each frame from the lighting and weather state). */
export interface WaterUniforms {
  sunDirection: ShaderNode;
  sunColor: ShaderNode;
  skyZenith: ShaderNode;
  skyHorizon: ShaderNode;
  /** 1 for airless light: reflection looks keep sky luminance without their atmospheric colour filters. */
  airless: ShaderNode;
  ambient: ShaderNode;
  rain: ShaderNode;
  wind: ShaderNode;
}

export function createWaterUniforms(): WaterUniforms {
  return {
    sunDirection: uniform(new Vector3(-0.6, 0.7, -0.2).normalize()),
    sunColor: uniform(new Color(1, 0.95, 0.85)),
    skyZenith: uniform(new Color(0.25, 0.45, 0.75)),
    skyHorizon: uniform(new Color(0.7, 0.8, 0.9)),
    airless: uniform(0),
    ambient: uniform(new Color(0.4, 0.45, 0.5)),
    rain: uniform(0),
    wind: uniform(0.3),
  };
}

export interface WaterSurface {
  normal: ShaderNode;
  /** Schlick Fresnel for the fixed isometric view. */
  fresnel: ShaderNode;
  /** Analytic sky colour in the reflected direction. */
  sky: ShaderNode;
  /** Sun sheen plus sparse tight glints. */
  glint: ShaderNode;
}

/**
 * Wind-driven waves plus rain rings, evaluated at the fragment's world position. A fixed isometric camera has no use
 * for planar reflections (sprites have no backs), so reflections come from an analytic sky and the sun.
 */
export function waterSurface(uniforms: WaterUniforms): WaterSurface {
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

  const p: ShaderNode = positionWorld.xz;
  const e = float(0.05);
  const h0 = waveHeight(p).add(rainRipples(p).mul(0.25));
  const hx = waveHeight(p.add(vec2(e, 0))).add(rainRipples(p.add(vec2(e, 0))).mul(0.25));
  const hz = waveHeight(p.add(vec2(0, e))).add(rainRipples(p.add(vec2(0, e))).mul(0.25));
  const slope = float(0.12).add(uniforms.wind.mul(0.12));
  const normal = normalize(vec3(h0.sub(hx).mul(slope).div(e), 1.0, h0.sub(hz).mul(slope).div(e)));

  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(normal, view), 0)), 5)));
  const r = reflect(view.negate(), normal);
  const sky = mix(uniforms.skyHorizon, uniforms.skyZenith, smoothstep(0.0, 0.6, r.y));
  // Broad soft sheen plus sparse tight glints; too many tight glints read as noise at RTS distance.
  const sunDot = max(dot(r, uniforms.sunDirection), 0);
  const glint = pow(sunDot, 60).mul(0.35).add(pow(sunDot, 600).mul(2.0)).mul(uniforms.sunColor);
  return { normal, fresnel, sky, glint };
}
