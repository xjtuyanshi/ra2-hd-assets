import {
  AdditiveBlending,
  CircleGeometry,
  DataTexture,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  cameraWorldMatrix,
  exp,
  float,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  mod,
  positionLocal,
  positionWorld,
  sin,
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
import { DEFAULT_ATMOSPHERE_NODES, sampleLightField } from './atmosphere';
import type { ShaderNode } from './tsl';

/** World-space dimensions remain independent of display scale and device pixel ratio. */
export const RAIN_LOOK = {
  drops: 12000,
  width: 0.026,
  length: [0.55, 0.85],
  dayOpacity: [0.24, 0.38],
  splashes: 3500,
  splashRadius: 0.047,
  splashScale: [0.6, 1],
  splashOpacity: 0.85,
} as const;

/** Far/middle/near layers occupy 50/35/15 percent of the volume; two percent of all flakes are oversized. */
export const SNOW_LOOK = {
  flakes: 9000,
  dayBrightnessFloor: 0.98,
  dayColour: [0.94, 0.97, 1],
  dayOpacity: [0.8, 1],
  layers: [
    { size: [0.04, 0.055], speed: [0.55, 0.8], sway: [0.06, 0.12] },
    { size: [0.055, 0.075], speed: [0.85, 1.15], sway: [0.13, 0.21] },
    { size: [0.075, 0.09], speed: [1.2, 1.65], sway: [0.22, 0.34] },
  ],
  largeFractionOfNear: 0.13,
  largeSize: [0.09, 0.12],
} as const;
/** Side of the square precipitation volume around the camera target, in cells. */
const AREA = 48;
const RAIN_TOP = 9;

export interface RainSystem {
  object: Object3D;
  /** Camera target; drops wrap around it so panning never reveals the volume's edge. */
  center: ShaderNode;
  intensity: ShaderNode;
  windX: ShaderNode;
  windZ: ShaderNode;
  dispose(): void;
}

export type SnowSystem = RainSystem;

// Each instance owns a fixed world lattice slot, offset by whole AREA steps to stay near center.
const wrapped = (seed: ShaderNode, axisCenter: ShaderNode) => {
  const base = seed.mul(AREA);
  return base.add(axisCenter.sub(base).div(AREA).add(0.5).floor().mul(AREA));
};

function weatherSampling(
  mapWidth: number,
  mapHeight: number,
  heightTexture: DataTexture,
  waterY: number,
  nodes = DEFAULT_ATMOSPHERE_NODES,
  groundMask?: DataTexture,
) {
  const groundAt = (x: ShaderNode, z: ShaderNode) =>
    max(texture(heightTexture, vec2(x.div(mapWidth), z.div(mapHeight))).level(float(0)).r, float(waterY));
  const maskedAt = (x: ShaderNode, z: ShaderNode): ShaderNode =>
    groundMask
      ? texture(groundMask, vec2(x.div(mapWidth), z.div(mapHeight)))
          .level(float(0))
          .r.greaterThan(0.5)
          .select(float(1), float(0))
      : float(0);
  // Local illumination fades above the lit ground; precipitation is lit rather than emissive.
  const litAt = (x: ShaderNode, z: ShaderNode, height: ShaderNode, local: number, level: ShaderNode) =>
    level.add(
      sampleLightField(vec2(x, z), nodes)
        .div(nodes.referenceLevel)
        .mul(local)
        .mul(exp(height.max(0).mul(-0.35))),
    );
  return { groundAt, maskedAt, litAt };
}

function disposeParticles(mesh: InstancedMesh<PlaneGeometry | CircleGeometry, MeshBasicNodeMaterial>): void {
  mesh.geometry.dispose();
  mesh.material.dispose();
  mesh.dispose();
}

export function buildRain(
  mapWidth: number,
  mapHeight: number,
  heightTexture: DataTexture,
  waterY: number,
  nodes = DEFAULT_ATMOSPHERE_NODES,
  groundMask?: DataTexture,
): RainSystem {
  const { night, sceneBrightness, surfaceTexture, surfaceSize } = nodes;
  const { groundAt, maskedAt, litAt } = weatherSampling(mapWidth, mapHeight, heightTexture, waterY, nodes, groundMask);
  const group = new Object3D();
  group.name = 'rain';
  const center = uniform(new Vector3());
  const intensity = uniform(0);
  const windX = uniform(0.15);
  const windZ = uniform(0.05);

  // Day rain scatters the overcast sky; night keeps the original squared scene level and local lamp lighting.
  // Sampled per vertex because the light field is smooth.
  const rainColour = vec3(0.72, 0.78, 0.85);

  // --- falling streaks: thin quads stretched along the fall direction, facing the fixed camera ---
  const streakGeometry = new PlaneGeometry(RAIN_LOOK.width, 1);
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
    const stretch = float(RAIN_LOOK.length[0]).add(
      hash(streakI.add(11.1)).mul(RAIN_LOOK.length[1] - RAIN_LOOK.length[0]),
    );
    // Normalize the slant so length is measured along the streak, rather than growing with stronger wind.
    const along = vec3(windX, 1, windZ).normalize().mul(positionLocal.y).mul(stretch);
    const facing = vec3(positionLocal.x.mul(Math.SQRT1_2), 0, positionLocal.x.mul(-Math.SQRT1_2)).add(along);
    return vec3(streakX, ground.add(fall), streakZ).add(drift).add(facing.mul(visible));
  })();
  const streakLight: ShaderNode = vertexStage(
    litAt(
      streakX,
      streakZ,
      fall,
      0.6,
      mix(sceneBrightness.mul(0.95), sceneBrightness.mul(sceneBrightness).mul(0.7), night),
    ),
  );
  const opacitySeed = hash(streakI.add(13.3));
  const streakAlpha = mix(
    float(RAIN_LOOK.dayOpacity[0]).add(opacitySeed.mul(RAIN_LOOK.dayOpacity[1] - RAIN_LOOK.dayOpacity[0])),
    float(0.1).add(opacitySeed.mul(0.14)),
    night,
  );
  // A narrow soft edge and dim trailing tip suggest motion blur without turning the whole line transparent.
  const taper = smoothstep(0, 0.12, uv().y)
    .mul(smoothstep(1, 0.78, uv().y))
    .mul(mix(float(1), float(0.65), uv().y))
    .mul(smoothstep(0, 0.18, uv().x))
    .mul(smoothstep(1, 0.82, uv().x));
  streakMaterial.colorNode = vec4(
    rainColour.mul(streakLight),
    streakAlpha.mul(taper).mul(smoothstep(0, 0.3, intensity)),
  );
  const streaks = new InstancedMesh(streakGeometry, streakMaterial, RAIN_LOOK.drops);
  streaks.name = 'rain-streaks';
  streaks.frustumCulled = false;
  group.add(streaks);

  // --- paved-ground splashes: 2.4..4 engine-pixel rings at the fixed 1x camera scale ---
  const splashGeometry = new CircleGeometry(RAIN_LOOK.splashRadius, 12);
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
  // Only paving throws these bright rings; open water has its own rain rings.
  // Sample categorical ground at cell centres; linear filtering at an edge must not splash onto adjacent grass.
  const surface: ShaderNode = texture(surfaceTexture, vec2(splashX, splashZ).floor().add(0.5).div(surfaceSize)).level(
    float(0),
  );
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
      .and(paved.greaterThan(0.5))
      .and(surface.g.lessThan(0.5))
      .and(maskedAt(splashX, splashZ).lessThan(0.5))
      .select(float(1), float(0));
    const scale = splashAge()
      .mul(RAIN_LOOK.splashScale[1] - RAIN_LOOK.splashScale[0])
      .add(RAIN_LOOK.splashScale[0])
      .mul(visible);
    return vec3(splashX, groundAt(splashX, splashZ).add(0.01), splashZ).add(positionLocal.mul(scale));
  })();
  const splashLight: ShaderNode = vertexStage(
    litAt(splashX, splashZ, float(0), 0.8, sceneBrightness.mul(mix(float(0.95), float(0.6), night))),
  );
  const d = length(uv().sub(0.5).mul(2));
  const ring = smoothstep(0.55, 0.8, d).mul(smoothstep(1.0, 0.85, d));
  // A ring centered on clear ground can overlap the next cell; clip those fragments at the footprint edge too.
  const groundSurface = texture(surfaceTexture, positionWorld.xz.floor().add(0.5).div(surfaceSize)).level(float(0));
  const groundClear = float(1)
    .sub(maskedAt(positionWorld.x, positionWorld.z))
    .mul(groundSurface.r)
    .mul(float(1).sub(groundSurface.g));
  splashMaterial.colorNode = vec4(
    vec3(0.85, 0.89, 0.93).mul(splashLight),
    float(1)
      .sub(splashAge())
      .mul(RAIN_LOOK.splashOpacity)
      .mul(ring)
      .mul(smoothstep(0, 0.3, intensity))
      .mul(groundClear),
  );
  const splashes = new InstancedMesh(splashGeometry, splashMaterial, RAIN_LOOK.splashes);
  splashes.name = 'rain-splashes';
  splashes.frustumCulled = false;
  group.add(splashes);

  group.visible = false;

  return {
    object: group,
    center,
    intensity,
    windX,
    windZ,
    dispose: () => {
      disposeParticles(streaks);
      disposeParticles(splashes);
    },
  };
}

/** Soft, camera-facing snowflakes with no accumulation or wet-ground contribution. */
export function buildSnow(
  mapWidth: number,
  mapHeight: number,
  heightTexture: DataTexture,
  waterY: number,
  nodes = DEFAULT_ATMOSPHERE_NODES,
  groundMask?: DataTexture,
): SnowSystem {
  const { groundAt, maskedAt, litAt } = weatherSampling(mapWidth, mapHeight, heightTexture, waterY, nodes, groundMask);
  const group = new Object3D();
  group.name = 'snow';
  const center = uniform(new Vector3());
  const intensity = uniform(0);
  const windX = uniform(0.15);
  const windZ = uniform(0.05);
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.blending = NormalBlending;

  const i = float(instanceIndex);
  const layer = hash(i.add(21.9));
  const detail = hash(i.add(11.1));
  const layerValue = (key: 'size' | 'speed' | 'sway') => {
    const values = SNOW_LOOK.layers.map(({ [key]: [low, high] }) => float(low).add(detail.mul(high - low)));
    return layer.greaterThan(0.85).select(values[2]!, layer.greaterThan(0.5).select(values[1]!, values[0]!));
  };
  // Size, fall speed and sway share a seed, so a larger flake moves consistently through its depth layer.
  const speed = layerValue('speed');
  const fall = mod(hash(i.add(3.7)).mul(RAIN_TOP).sub(time.mul(speed)), RAIN_TOP);
  const amplitude = layerValue('sway');
  const frequency = float(0.4).add(hash(i.add(17.3)).mul(0.7));
  const phase = hash(i.add(19.7)).mul(Math.PI * 2);
  const angle = time
    .mul(frequency)
    .mul(Math.PI * 2)
    .add(phase);
  const driftTime = float(RAIN_TOP).sub(fall).div(speed);
  // Wrap after displacement so even strong wind cannot move the volume away from the camera target.
  const driftX = windX.mul(driftTime).add(sin(angle).mul(amplitude));
  const driftZ = windZ.mul(driftTime).add(sin(angle.add(Math.PI / 2)).mul(amplitude));
  const x = wrapped(hash(i.add(1.1)).add(driftX.div(AREA)), center.x);
  const z = wrapped(hash(i.add(7.3)).add(driftZ.div(AREA)), center.z);
  // Sample at the drifted position, so a flake crossing a roof edge or shore cannot land on the old cell.
  const ground = groundAt(x, z);
  const surface = texture(nodes.surfaceTexture, vec2(x, z).div(nodes.surfaceSize)).level(float(0));
  const landingHeight = max(surface.g.mul(0.15), maskedAt(x, z).mul(0.6));
  const landingFade = vertexStage(smoothstep(landingHeight, landingHeight.add(0.08), fall));
  const largeThreshold = 1 - SNOW_LOOK.largeFractionOfNear;
  const largeSize = float(SNOW_LOOK.largeSize[0]).add(
    detail
      .sub(largeThreshold)
      .div(SNOW_LOOK.largeFractionOfNear)
      .mul(SNOW_LOOK.largeSize[1] - SNOW_LOOK.largeSize[0]),
  );
  const size = layer.greaterThan(0.85).and(detail.greaterThan(largeThreshold)).select(largeSize, layerValue('size'));
  material.positionNode = Fn(() => {
    const inside = x.greaterThan(0).and(z.greaterThan(0)).and(x.lessThan(mapWidth)).and(z.lessThan(mapHeight));
    const visible = intensity
      .greaterThan(hash(i.add(5.5)))
      .and(inside)
      .select(float(1), float(0));
    // Camera basis excludes translation, so the quad faces every supported orthographic view.
    const facing = cameraWorldMatrix.mul(vec4(positionLocal.xy, 0, 0)).xyz;
    return vec3(x, ground.add(fall), z).add(facing.mul(size).mul(visible));
  })();
  const light: ShaderNode = vertexStage(
    litAt(x, z, fall, 0.6, nodes.sceneBrightness.mul(nodes.sceneBrightness).mul(0.7)),
  );
  // Normal blending needs opacity to fade with the light too, or unlit flakes would remain opaque dark discs.
  const lightFade = mix(float(1), light.r.max(light.g).max(light.b).div(0.7).clamp(0, 1), nodes.night);
  const disc = float(1).sub(smoothstep(0.55, 1, length(uv().sub(0.5).mul(2))));
  const opacitySeed = hash(i.add(13.3));
  const alpha: ShaderNode = mix(
    float(SNOW_LOOK.dayOpacity[0]).add(opacitySeed.mul(SNOW_LOOK.dayOpacity[1] - SNOW_LOOK.dayOpacity[0])),
    float(0.55).add(opacitySeed.mul(0.35)),
    nodes.night,
  )
    .mul(smoothstep(0, 0.3, intensity))
    .mul(lightFade)
    .mul(landingFade)
    .mul(disc);
  // White flakes scatter the whole daytime sky, even after weather dims terrain; night retains scene/lamp lighting.
  const dayColour = vec3(...SNOW_LOOK.dayColour).mul(light.max(SNOW_LOOK.dayBrightnessFloor));
  material.colorNode = vec4(mix(dayColour, vec3(0.93, 0.95, 1).mul(light), nodes.night), alpha);
  const flakes = new InstancedMesh(geometry, material, SNOW_LOOK.flakes);
  flakes.name = 'snow-flakes';
  flakes.frustumCulled = false;
  group.add(flakes);
  group.visible = false;
  return { object: group, center, intensity, windX, windZ, dispose: () => disposeParticles(flakes) };
}
