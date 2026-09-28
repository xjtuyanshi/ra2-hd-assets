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
  color,
  float,
  hash,
  instanceIndex,
  max,
  mod,
  positionLocal,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
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

  // --- falling streaks: thin quads stretched along the fall direction, facing the fixed camera ---
  const streakGeometry = new PlaneGeometry(0.018, 0.55);
  const streakMaterial = new MeshBasicNodeMaterial();
  streakMaterial.transparent = true;
  streakMaterial.depthWrite = false;
  streakMaterial.blending = AdditiveBlending;
  streakMaterial.positionNode = Fn(() => {
    const i = float(instanceIndex);
    const sx = hash(i.add(1.1));
    const sz = hash(i.add(7.3));
    const sy = hash(i.add(3.7));
    const speed = float(11).add(hash(i.add(9.1)).mul(4));
    const fall = mod(sy.mul(RAIN_TOP).sub(time.mul(speed)), RAIN_TOP);
    const x = wrapped(sx, center.x);
    const z = wrapped(sz, center.z);
    const ground = groundAt(x, z);
    // Drops slant with the wind. The quad's own offset is turned 45° about +y so it faces the fixed isometric
    // camera; the mesh transform stays identity because the instance position above is already in world space.
    const drift = vec3(windX, 0, windZ).mul(fall);
    const inside = x.greaterThan(0).and(z.greaterThan(0)).and(x.lessThan(mapWidth)).and(z.lessThan(mapHeight));
    const visible = intensity
      .greaterThan(hash(i.add(5.5)))
      .and(inside)
      .select(float(1), float(0));
    const facing = vec3(positionLocal.x.mul(Math.SQRT1_2), positionLocal.y, positionLocal.x.mul(-Math.SQRT1_2));
    return vec3(x, ground.add(fall), z).add(drift).add(facing.mul(visible));
  })();
  streakMaterial.colorNode = vec4(color(0xb8c8d8), float(0.22).mul(smoothstep(0, 0.3, intensity)));
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
  splashMaterial.positionNode = Fn(() => {
    const i = float(instanceIndex);
    // Re-seed position every cycle so splashes do not repeat in place.
    const cycle = time
      .mul(float(1.6).add(hash(i.add(2.2))))
      .add(hash(i.add(4.4)))
      .floor();
    const x = wrapped(hash(i.add(cycle.mul(13.1))), center.x);
    const z = wrapped(hash(i.add(cycle.mul(17.7)).add(0.5)), center.z);
    const inside = x.greaterThan(0).and(z.greaterThan(0)).and(x.lessThan(mapWidth)).and(z.lessThan(mapHeight));
    const visible = intensity
      .greaterThan(hash(i.add(8.8)))
      .and(inside)
      .select(float(1), float(0));
    const scale = splashAge().mul(1.4).add(0.2).mul(visible);
    return vec3(x, groundAt(x, z).add(0.01), z).add(positionLocal.mul(scale));
  })();
  splashMaterial.colorNode = vec4(
    color(0xd8e4ee),
    float(1)
      .sub(splashAge())
      .mul(0.35)
      .mul(smoothstep(0, 0.3, intensity)),
  );
  const splashes = new InstancedMesh(splashGeometry, splashMaterial, SPLASHES);
  splashes.frustumCulled = false;
  group.add(splashes);

  group.visible = true;
  return { object: group, center, intensity, windX, windZ };
}
