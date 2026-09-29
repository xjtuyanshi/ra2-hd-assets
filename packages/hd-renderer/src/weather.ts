import {
  AdditiveBlending,
  CircleGeometry,
  DataTexture,
  InstancedMesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  exp,
  float,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  mod,
  positionLocal,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import { night, referenceLevel, sampleLightField, sceneBrightness, surfaceTexture, surfaceSize } from './atmosphere';
import type { ShaderNode } from './tsl';

const RAIN_DROPS = 9000;
const SPLASHES = 2500;
/** Side of the square rain volume around the camera target, in cells. */
const AREA = 48;
const RAIN_TOP = 9;

export interface RainSystem {
  object: Object3D;
  /** Camera target; drops wrap around it so panning never reveals the volume's edge. */
  center: ShaderNode;
  intensity: ShaderNode;
  windX: ShaderNode;
  windZ: ShaderNode;
}

export function buildRain(mapWidth: number, mapHeight: number, heightTexture: DataTexture, waterY: number): RainSystem {
  const group = new Object3D();
  group.name = 'rain';
  const center = uniform(new Vector3());
  const intensity = uniform(0);
  const windX = uniform(0.15);
  const windZ = uniform(0.05);

  // World-anchored wrap: each instance owns a fixed world lattice slot, offset by whole AREA steps to stay near center.
  const wrapped = (seed: ShaderNode, axisCenter: ShaderNode) => {
    const base = seed.mul(AREA);
    return base.add(axisCenter.sub(base).div(AREA).add(0.5).floor().mul(AREA));
  };
  const groundAt = (x: ShaderNode, z: ShaderNode) =>
    max(texture(heightTexture, vec2(x.div(mapWidth), z.div(mapHeight))).level(float(0)).r, float(waterY));

  // Rain is lit, not glowing: drops take the scene's light level (1 at clear noon; squared for streaks, so thin rain
  // all but vanishes in the dark away from lamps) and the local lights of the light field, fading with height above
  // the lit ground. Sampled per vertex (the light field is smooth).
  const rainColour = vec3(0.72, 0.78, 0.85);
  const litAt = (x: ShaderNode, z: ShaderNode, height: ShaderNode, local: number, level: ShaderNode) =>
    level.add(
      sampleLightField(vec2(x, z))
        .div(referenceLevel)
        .mul(local)
        .mul(exp(height.max(0).mul(-0.35))),
    );

  // --- falling streaks: thin quads stretched along the fall direction, facing the fixed camera ---
  const streakGeometry = new PlaneGeometry(0.018, 0.55);
  const streakMaterial = new MeshBasicNodeMaterial();
  streakMaterial.transparent = true;
  streakMaterial.depthWrite = false;
  streakMaterial.blending = AdditiveBlending;
  const streakI = float(instanceIndex);
  const streakX = wrapped(hash(streakI.add(1.1)), center.x);
  const streakZ = wrapped(hash(streakI.add(7.3)), center.z);
  const speed = float(11).add(hash(streakI.add(9.1)).mul(4));
  const fall = mod(hash(streakI.add(3.7)).mul(RAIN_TOP).sub(time.mul(speed)), RAIN_TOP);
  streakMaterial.positionNode = Fn(() => {
    const ground = groundAt(streakX, streakZ);
    // Drops slant with the wind. The quad's own offset is turned 45° about +y so it faces the fixed isometric
    // camera; the mesh transform stays identity because the instance position above is already in world space.
    const drift = vec3(windX, 0, windZ).mul(fall);
    const inside = streakX
      .greaterThan(0)
      .and(streakZ.greaterThan(0))
      .and(streakX.lessThan(mapWidth))
      .and(streakZ.lessThan(mapHeight));
    const visible = intensity
      .greaterThan(hash(streakI.add(5.5)))
      .and(inside)
      .select(float(1), float(0));
    // Each drop has its own length (0.7..1.3 x).
    const stretch = float(0.7).add(hash(streakI.add(11.1)).mul(0.6));
    const facing = vec3(
      positionLocal.x.mul(Math.SQRT1_2),
      positionLocal.y.mul(stretch),
      positionLocal.x.mul(-Math.SQRT1_2),
    );
    return vec3(streakX, ground.add(fall), streakZ).add(drift).add(facing.mul(visible));
  })();
  const streakLight: ShaderNode = vertexStage(
    litAt(streakX, streakZ, fall, 0.6, sceneBrightness.mul(sceneBrightness).mul(0.7)),
  );
  // Daylight streaks are lit by the bright sky only faintly (unlit, like smoke): a little more opacity keeps day rain
  // as visible as night rain, where lamps light the drops.
  const streakAlpha = float(0.1)
    .add(hash(streakI.add(13.3)).mul(0.14))
    .mul(mix(float(1.35), float(1), night));
  // Tapered ends: a streak is a motion-blurred drop, brightest in its lower half.
  const taper = smoothstep(0.0, 0.25, uv().y).mul(smoothstep(1.0, 0.55, uv().y));
  streakMaterial.colorNode = vec4(
    rainColour.mul(streakLight),
    streakAlpha.mul(taper).mul(smoothstep(0, 0.3, intensity)),
  );
  const streaks = new InstancedMesh(streakGeometry, streakMaterial, RAIN_DROPS);
  streaks.frustumCulled = false;
  group.add(streaks);

  // --- ground splashes: small rings that grow and fade, placed on the terrain or water surface ---
  const splashGeometry = new CircleGeometry(0.09, 12);
  splashGeometry.rotateX(-Math.PI / 2);
  const splashMaterial = new MeshBasicNodeMaterial();
  splashMaterial.transparent = true;
  splashMaterial.depthWrite = false;
  splashMaterial.blending = AdditiveBlending;
  const splashAge = Fn(() => {
    const i = float(instanceIndex);
    return time
      .mul(float(1.6).add(hash(i.add(2.2))))
      .add(hash(i.add(4.4)))
      .fract();
  });
  const splashI = float(instanceIndex);
  // Re-seed position every cycle so splashes do not repeat in place.
  const cycle = time
    .mul(float(1.6).add(hash(splashI.add(2.2))))
    .add(hash(splashI.add(4.4)))
    .floor();
  const splashX = wrapped(hash(splashI.add(cycle.mul(13.1))), center.x);
  const splashZ = wrapped(hash(splashI.add(cycle.mul(17.7)).add(0.5)), center.z);
  // Hard ground throws full rings; grass and soil swallow most of them; open water has its own rain rings.
  const surface: ShaderNode = texture(surfaceTexture, vec2(splashX, splashZ).div(surfaceSize)).level(float(0));
  const paved = surface.r;
  splashMaterial.positionNode = Fn(() => {
    const inside = splashX
      .greaterThan(0)
      .and(splashZ.greaterThan(0))
      .and(splashX.lessThan(mapWidth))
      .and(splashZ.lessThan(mapHeight));
    const visible = intensity
      .greaterThan(hash(splashI.add(8.8)))
      .and(inside)
      .select(float(1), float(0));
    const size = mix(float(0.6), float(1), paved);
    const scale = splashAge().mul(1.4).add(0.2).mul(visible).mul(size);
    return vec3(splashX, groundAt(splashX, splashZ).add(0.01), splashZ).add(positionLocal.mul(scale));
  })();
  const splashLight: ShaderNode = vertexStage(litAt(splashX, splashZ, float(0), 0.8, sceneBrightness.mul(0.6)));
  const splashFade = vertexStage(mix(float(0.35), float(1), paved).mul(float(1).sub(surface.g)));
  const d = length(uv().sub(0.5).mul(2));
  const ring = smoothstep(0.55, 0.8, d).mul(smoothstep(1.0, 0.85, d));
  splashMaterial.colorNode = vec4(
    vec3(0.85, 0.89, 0.93).mul(splashLight),
    float(1)
      .sub(splashAge())
      .mul(0.35)
      .mul(ring)
      .mul(2.2)
      .mul(splashFade)
      .mul(smoothstep(0, 0.3, intensity)),
  );
  const splashes = new InstancedMesh(splashGeometry, splashMaterial, SPLASHES);
  splashes.frustumCulled = false;
  group.add(splashes);

  group.visible = true;

  return { object: group, center, intensity, windX, windZ };
}
