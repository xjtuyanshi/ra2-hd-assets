import {
  Color,
  CustomBlending,
  Data3DTexture,
  Group,
  LinearFilter,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  NoColorSpace,
  Vector3,
} from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  cos,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  sin,
  smoothstep,
  sqrt,
  texture3D,
  uniform,
  varying,
  vec3,
  vec4,
  instancedBufferAttribute,
} from 'three/tsl';
import { DirtyAttribute } from './dirtyAttribute';
import { InstancedQuad } from './instancedQuad';
import type { ShaderNode } from './tsl';

export interface VolumetricBlastStyle {
  /** Number of overlapping lobes, 3..7. */
  lobes: number;
  /** Lobe centre spread as a fraction of the fireball radius. */
  lobeSpread: number;
  /** Vertical shape scale: 1 round, 0.5 a flat ground burst. */
  flatten: number;
  /** Centre rise over the lifetime in world radius units. */
  rise: number;
  /** Expansion time constant in seconds. */
  expandSeconds: number;
  /** Fire cooling time constant in seconds. */
  coolSeconds: number;
  /** Soot albedo darkness, 0..1. */
  smokeDarkness: number;
  /** Dark pockets interleaved inside the fire, 0..1. */
  pockets: number;
  /** Initial outward flame tongue strength, 0..1. */
  tongues: number;
  /** Initial white core flash strength, 0..1. */
  flash: number;
  /** Ground-to-centre mushroom stem share, 0..1. */
  stem: number;
  /** Overall density/extinction multiplier. */
  density: number;
}
const fireball: VolumetricBlastStyle = {
  lobes: 5,
  lobeSpread: 0.48,
  flatten: 0.9,
  rise: 0.65,
  expandSeconds: 0.1,
  coolSeconds: 0.55,
  smokeDarkness: 0.85,
  pockets: 0.9,
  tongues: 0.8,
  flash: 1,
  stem: 0.15,
  density: 2.8,
};
export const VOLUMETRIC_BLAST_PRESETS = {
  fireball,
  mushroom: { ...fireball, lobes: 7, flatten: 0.7, rise: 1.2, stem: 0.85, coolSeconds: 0.65 },
  groundBurst: { ...fireball, flatten: 0.5, rise: 0.2, stem: 0, tongues: 1 },
  column: { ...fireball, lobes: 3, lobeSpread: 0.3, flatten: 1.3, rise: 1.4, stem: 1 },
  oilBurn: { ...fireball, lobes: 4, coolSeconds: 0.7, smokeDarkness: 1, pockets: 1, stem: 0.6, flash: 0.4 },
} satisfies Record<string, VolumetricBlastStyle>;

export interface VolumetricBlast {
  /** World ground point of the blast, including its ground level. */
  anchor: Vector3;
  /** Maximum horizontal fireball radius in world units. */
  radius: number;
  /** Life progress at t0, 0..1. */
  progress0: number;
  /** Renderer seconds at the snapshot. */
  t0: number;
  /** Life progress per second. */
  rate: number;
  lifeSeconds: number;
  seed: number;
  style: VolumetricBlastStyle;
  /** Opacity multiplier, 0..1. */
  fade: number;
  /** World units towards the camera for card depth ordering. */
  push?: number;
}

/** Pure periodic RGBA noise: gradient noise at 4/8/16 periods, inverted cellular noise at 6. */
export function generateBlastNoise(seed = 0x51f15e, size = 64): Uint8Array {
  if (!Number.isInteger(size) || size < 2) throw new RangeError('Noise size must be an integer >= 2');
  const bytes = new Uint8Array(size ** 3 * 4);
  const hash = (x: number, y: number, z: number, channel: number): number => {
    let h =
      seed ^
      Math.imul(x, 374761393) ^
      Math.imul(y, 668265263) ^
      Math.imul(z, 1274126177) ^
      Math.imul(channel, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const wrap = (v: number, period: number) => ((v % period) + period) % period;
  const fade = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
  const gradient = (x: number, y: number, z: number, periods: number, channel: number): number => {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    const fx = x - ix,
      fy = y - iy,
      fz = z - iz;
    const u = fade(fx),
      v = fade(fy),
      w = fade(fz);
    let sum = 0;
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const h = Math.floor(
            hash(wrap(ix + dx, periods), wrap(iy + dy, periods), wrap(iz + dz, periods), channel) * 12,
          );
          const a = x - ix - dx,
            b = y - iy - dy,
            c = z - iz - dz;
          const first = h < 8 ? a : b;
          const second = h < 4 ? b : h === 8 || h === 10 ? a : c;
          const d = (h & 1 ? -first : first) + (h & 2 ? -second : second);
          sum += d * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        }
    return Math.max(0, Math.min(1, 0.5 + sum * 0.5));
  };
  const worley = (x: number, y: number, z: number): number => {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    let nearest = Infinity;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx,
            cy = iy + dy,
            cz = iz + dz;
          const wx = wrap(cx, 6),
            wy = wrap(cy, 6),
            wz = wrap(cz, 6);
          const a = cx + hash(wx, wy, wz, 3) - x;
          const b = cy + hash(wx, wy, wz, 4) - y;
          const c = cz + hash(wx, wy, wz, 5) - z;
          nearest = Math.min(nearest, a * a + b * b + c * c);
        }
    return 1 - Math.min(1, Math.sqrt(nearest));
  };
  // Duplicate boundary slices make both the value and the repeat-filter seam continuous.
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1),
          v = y / (size - 1),
          w = z / (size - 1);
        const i = ((z * size + y) * size + x) * 4;
        bytes[i] = Math.round(255 * gradient(u * 4, v * 4, w * 4, 4, 0));
        bytes[i + 1] = Math.round(255 * gradient(u * 8, v * 8, w * 8, 8, 1));
        bytes[i + 2] = Math.round(255 * worley(u * 6, v * 6, w * 6));
        bytes[i + 3] = Math.round(255 * gradient(u * 16, v * 16, w * 16, 16, 2));
      }
  return bytes;
}
let noiseBytes: Uint8Array | undefined;

/** Camera-card depth with a procedural world-space volume; owns its material, geometry and 3D texture. */
export class VolumetricBlastLayer {
  readonly root = new Group();
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 0, 1));
  readonly now = uniform(0);
  readonly light: ReturnType<typeof uniform<'color'>>;
  readonly sunDirection: ReturnType<typeof uniform<'vec3'>>;
  readonly displayScale: ReturnType<typeof uniform<'float'>>;
  /** Fixed compile-time ray step budget. */
  readonly steps = 28;
  readonly emissionGain = uniform(1);
  readonly smokeGain = uniform(1);
  readonly extinction = uniform(1.6);
  readonly noiseScale = uniform(0.42);
  readonly pocketScale = uniform(0.53);
  readonly displacement = uniform(1.4);
  readonly smoothUnion = uniform(0.25);
  readonly edgeWidth = uniform(0.18);
  readonly groundFade = uniform(0.06);
  readonly tongueReach = uniform(0.5);
  readonly tongueStart = uniform(0.15);
  readonly tongueEnd = uniform(0.45);
  readonly tongueThreshold = uniform(0.58);
  readonly flashSeconds = uniform(0.12);
  readonly flashRadius = uniform(0.9);
  readonly temperatureRadius = uniform(0.95);
  readonly temperatureNoise = uniform(0.5);
  readonly coolingPower = uniform(0.8);
  readonly pocketLow = uniform(0.35);
  readonly pocketHigh = uniform(0.65);
  readonly flowRate = uniform(0.18);
  readonly flowExpansion = uniform(0.25);
  readonly tongueHigh = uniform(0.85);
  readonly tongueSurfaceWidth = uniform(0.6);
  readonly skyLow = uniform(-0.2);
  readonly skyHigh = uniform(1);
  readonly flashSoftness = uniform(0.8);
  readonly densityCutoff = uniform(0.01);
  readonly skyBase = uniform(0.35);
  readonly skyGain = uniform(0.65);
  readonly sunGain = uniform(0.8);
  readonly skyScatter = uniform(0.45);
  readonly bounceGain = uniform(2.5);
  readonly bounceColour = uniform(new Color(1, 0.45, 0.12));
  readonly sootLight = uniform(new Color(0.32, 0.3, 0.28));
  readonly sootDark = uniform(new Color(0.07, 0.065, 0.06));
  readonly boundsRadius = uniform(1.35);
  readonly transmittanceCutoff = uniform(0.01);
  readonly shadowNear = uniform(0.2);
  readonly shadowFar = uniform(0.45);
  readonly shadowFarWeight = uniform(0.25);
  readonly coreHeight = uniform(0.55);
  readonly stemRadius = uniform(0.35);
  readonly initialRadius = uniform(0.18);
  readonly lobeRadiusMin = uniform(0.45);
  readonly lobeRadiusRange = uniform(0.3);
  readonly lobeExpansionJitter = uniform(0.25);
  readonly lobeElevationMin = uniform(0.15);
  readonly lobeElevationRange = uniform(0.7);
  readonly fbmFrequency = uniform(1.93);
  readonly fbmOffset = uniform(0.31);
  readonly fbmWeights = uniform(new Vector3(0.5, 0.25, 0.25));
  readonly pocketWeights = uniform(new Vector3(0.5, 0.3, 0.2));
  readonly pocketFlow = uniform(0.73);
  readonly pocketOffset = uniform(0.37);
  readonly heatReachMin = uniform(0.45);
  readonly heatReachRange = uniform(0.85);
  readonly heatCore = uniform(0.2);
  readonly heatPeak = uniform(1.15);
  readonly temperatureFbm = uniform(1.2);
  readonly temperatureDetail = uniform(0.6);
  readonly temperatureRidge = uniform(0.5);
  readonly pocketEarly = uniform(0.55);
  readonly flashTemperature = uniform(1.3);
  readonly glowFalloff = uniform(1.6);
  readonly fireLow = uniform(0.2);
  readonly fireHigh = uniform(0.6);
  readonly fireOpacity = uniform(0.75);
  readonly shadowFloor = uniform(0.25);
  readonly shadowLow = uniform(-0.45);
  readonly shadowHigh = uniform(0.55);
  readonly shadowNoise = uniform(0.8);
  readonly rampStep = uniform(0.2);
  readonly hotColour = uniform(new Color(8, 7.6, 6.8));
  readonly yellowColour = uniform(new Color(4, 2.88, 1.12));
  readonly orangeColour = uniform(new Color(2, 0.84, 0.16));
  readonly redColour = uniform(new Color(0.675, 0.108, 0.018));
  readonly emberColour = uniform(new Color(0.0625, 0.01, 0.0025));
  private readonly data: DirtyAttribute;
  private readonly mesh: InstancedQuad;
  private readonly noise: Data3DTexture;
  private readonly blasts: VolumetricBlast[] = [];

  constructor(options: {
    capacity?: number;
    light: ReturnType<typeof uniform<'color'>>;
    sunDirection: ReturnType<typeof uniform<'vec3'>>;
    displayScale?: ReturnType<typeof uniform<'float'>>;
  }) {
    const capacity = options.capacity ?? 128;
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Blast capacity must be positive');
    this.light = options.light;
    this.sunDirection = options.sunDirection;
    this.displayScale = options.displayScale ?? uniform(1);
    this.data = new DirtyAttribute(new Float32Array(capacity * 28), 28);
    const buffer = this.data.interleaved();
    const attr = (offset: number): ShaderNode => instancedBufferAttribute(buffer, 'vec4', 28, offset);
    const anchor = attr(0),
      timing = attr(4),
      shape = attr(8),
      heat = attr(12),
      detail = attr(16),
      misc = attr(20),
      bounds = attr(24);
    this.noise = new Data3DTexture((noiseBytes ??= generateBlastNoise()), 64, 64, 64);
    this.noise.format = RGBAFormat;
    this.noise.type = UnsignedByteType;
    this.noise.colorSpace = NoColorSpace;
    this.noise.wrapS = this.noise.wrapT = this.noise.wrapR = RepeatWrapping;
    this.noise.minFilter = this.noise.magFilter = LinearFilter;
    this.noise.generateMipmaps = false;
    this.noise.needsUpdate = true;
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthTest = true;
    material.depthWrite = false;
    material.blending = CustomBlending;
    material.blendSrc = material.blendSrcAlpha = OneFactor;
    material.blendDst = material.blendDstAlpha = OneMinusSrcAlphaFactor;
    // outputNode (not fragmentNode) so the scene pass MRT still receives the material output and its depth-mask target;
    // the node returns premultiplied RGBA, so Three must not premultiply it a second time.
    material.premultipliedAlpha = false;
    const centre = anchor.xyz.add(vec3(0, bounds.x.mul(anchor.w), 0));
    const worldCard = centre
      .add(this.cameraRight.mul(positionGeometry.x.mul(bounds.z.mul(2)).mul(anchor.w)))
      .add(this.cameraUp.mul(positionGeometry.y.mul(bounds.w.mul(2)).mul(anchor.w)));
    const rayOrigin: ShaderNode = varying(worldCard, 'blastRayOrigin');
    // Offset in the card plane only: every fragment keeps the anchor card's depth, including its explicit push.
    material.positionNode = anchor.xyz
      .add(
        this.cameraRight.mul(
          positionGeometry.x.mul(bounds.z.mul(2)).mul(anchor.w).add(bounds.x.mul(anchor.w).mul(this.cameraRight.y)),
        ),
      )
      .add(
        this.cameraUp.mul(
          positionGeometry.y.mul(bounds.w.mul(2)).mul(anchor.w).add(bounds.x.mul(anchor.w).mul(this.cameraUp.y)),
        ),
      )
      .add(this.toCamera.mul(misc.y));
    material.outputNode = Fn(() => {
      const progress: ShaderNode = clamp(timing.x.add(max(0, this.now.sub(timing.y)).mul(timing.z)), 0, 1).toVar();
      const age: ShaderNode = progress.mul(timing.w).toVar();
      const rf: ShaderNode = this.initialRadius
        .add(
          float(1)
            .sub(this.initialRadius)
            .mul(float(1).sub(exp(age.div(max(heat.x, 0.001)).negate()))),
        )
        .toVar();
      const c: ShaderNode = vec3(
        0,
        rf
          .mul(this.coreHeight)
          .mul(shape.z)
          .add(shape.w.mul(smoothstep(0, 1, progress))),
        0,
      ).toVar();
      const flow: ShaderNode = vec3(
        misc.z.mul(0.013),
        misc.z.mul(0.029).sub(age.mul(this.flowRate)),
        misc.z.mul(0.017),
      ).toVar();
      const sample = (q: ShaderNode): ShaderNode =>
        texture3D(
          this.noise,
          q
            .div(float(1).add(age.mul(this.flowExpansion)))
            .mul(this.noiseScale)
            .add(flow),
        ).level(float(0));
      const smin = (a: ShaderNode, b: ShaderNode): ShaderNode => {
        const k = max(this.smoothUnion, 0.001);
        const h = clamp(float(0.5).add(b.sub(a).mul(0.5).div(k)), 0, 1);
        return mix(b, a, h).sub(k.mul(h).mul(float(1).sub(h)));
      };
      const shapeDistance = (q: ShaderNode): ShaderNode => {
        const d: ShaderNode = float(10).toVar();
        Loop(7, ({ i }) => {
          If(float(i).lessThan(shape.x), () => {
            const h: ShaderNode = fract(sin(float(i).mul(17.31).add(misc.z.mul(0.73))).mul(43758.5453)).toVar();
            const angle = float(i).mul(2.39996).add(misc.z);
            const offset = normalize(
              vec3(cos(angle), h.mul(this.lobeElevationRange).add(this.lobeElevationMin), sin(angle)),
            )
              .mul(shape.y)
              .mul(rf);
            const delta = q
              .sub(c)
              .div(vec3(1, max(shape.z, 0.1), 1))
              .sub(offset);
            const expansion = float(1).sub(
              exp(age.div(max(heat.x.mul(float(1).add(h.mul(this.lobeExpansionJitter))), 0.001)).negate()),
            );
            const lobe = this.lobeRadiusMin
              .add(h.mul(this.lobeRadiusRange))
              .mul(this.initialRadius.add(float(1).sub(this.initialRadius).mul(expansion)));
            d.assign(smin(d, length(delta).sub(lobe)));
          });
        });
        const stemPoint = vec3(q.x, q.y.sub(clamp(q.y, 0, c.y)), q.z);
        If(detail.z.greaterThan(0), () => {
          d.assign(smin(d, length(stemPoint).sub(this.stemRadius.mul(rf).mul(detail.z))));
        });
        return d;
      };
      const densityFrom = (q: ShaderNode, n: ShaderNode, fbm: ShaderNode): ShaderNode => {
        const d: ShaderNode = shapeDistance(q)
          .add(this.displacement.mul(rf).mul(fbm.sub(0.5)))
          .toVar();
        const ridge = smoothstep(this.tongueThreshold, this.tongueHigh, n.a);
        const surface = float(1).sub(smoothstep(0, rf.mul(this.tongueSurfaceWidth), d.abs()));
        d.subAssign(
          ridge
            .mul(surface)
            .mul(this.tongueReach)
            .mul(rf)
            .mul(detail.x)
            .mul(float(1).sub(smoothstep(this.tongueStart, this.tongueEnd, age))),
        );
        return clamp(d.negate().div(max(this.edgeWidth.mul(rf), 0.001)), 0, 1)
          .mul(detail.w)
          .mul(misc.x)
          .mul(smoothstep(0, this.groundFade, q.y));
      };
      const origin: ShaderNode = rayOrigin.sub(anchor.xyz).div(max(anchor.w, 0.001)).toVar();
      const direction: ShaderNode = this.toCamera.negate().toVar();
      const axes = vec3(this.boundsRadius, bounds.y, this.boundsRadius);
      const ro: ShaderNode = origin
        .sub(vec3(0, bounds.x, 0))
        .div(axes)
        .toVar();
      const rd: ShaderNode = direction.div(axes).toVar();
      const a: ShaderNode = dot(rd, rd).toVar();
      const b: ShaderNode = dot(ro, rd).toVar();
      const discriminant: ShaderNode = b
        .mul(b)
        .sub(a.mul(dot(ro, ro).sub(1)))
        .toVar();
      const colour: ShaderNode = vec3(0).toVar();
      const transmittance: ShaderNode = float(1).toVar();
      If(discriminant.greaterThan(0).and(progress.lessThan(1)), () => {
        // Orthographic cards may lie inside the volume: integrate the full chord, including negative entry distances.
        const entry: ShaderNode = b.negate().sub(sqrt(discriminant)).div(a).toVar();
        const exit: ShaderNode = b.negate().add(sqrt(discriminant)).div(a).toVar();
        const ds: ShaderNode = exit.sub(entry).div(this.steps).toVar();
        const jitter = fract(
          float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec3(0.06711056, 0.00583715, 0).xy))),
        );
        const t: ShaderNode = entry.add(ds.mul(jitter)).toVar();
        Loop(this.steps, () => {
          If(transmittance.lessThan(this.transmittanceCutoff), () => {
            Break();
          });
          const q: ShaderNode = origin.add(direction.mul(t)).toVar();
          const n: ShaderNode = sample(q).toVar();
          const n2: ShaderNode = sample(q.mul(this.fbmFrequency).add(this.fbmOffset)).toVar();
          const fbm: ShaderNode = dot(vec3(n.r, n.g, n2.b), this.fbmWeights).toVar();
          const density: ShaderNode = densityFrom(q, n, fbm).toVar();
          If(density.greaterThan(this.densityCutoff), () => {
            const pocket: ShaderNode = texture3D(
              this.noise,
              q.mul(this.pocketScale).add(flow.mul(this.pocketFlow)).add(this.pocketOffset),
            )
              .level(float(0))
              .toVar();
            const pocketNoise = dot(pocket.rgb, this.pocketWeights);
            // Pyro model: the whole fireball is hot at first, then it cools from the outside in, leaving a glowing
            // core inside a soot shell; soot pockets break the fire up from the start and take over as it cools.
            const radial: ShaderNode = length(q.sub(c).div(vec3(1, max(shape.z, 0.1), 1)))
              .div(rf)
              .toVar();
            const heat0: ShaderNode = pow(exp(age.div(max(heat.y, 0.001)).negate()), this.coolingPower).toVar();
            const reach = this.heatReachMin.add(this.heatReachRange.mul(heat0));
            const noisyRadius = radial
              .add(n.b.sub(0.5).mul(this.temperatureNoise))
              .add(fbm.sub(0.5).mul(this.temperatureFbm))
              .add(n.a.sub(0.5).mul(this.temperatureDetail))
              // Ridged high-frequency noise: thin white-hot flame filaments instead of a smooth colour gradient.
              .sub(
                pow(float(1).sub(n2.a.mul(2).sub(1).abs()), 3)
                  .sub(0.3)
                  .mul(this.temperatureRidge),
              );
            const soot: ShaderNode = smoothstep(this.pocketLow, this.pocketHigh, pocketNoise)
              .mul(heat.w)
              .mul(mix(this.pocketEarly, 1, float(1).sub(heat0)))
              .toVar();
            const temperature: ShaderNode = float(1)
              .sub(smoothstep(reach.mul(this.heatCore), reach, noisyRadius))
              .mul(heat0.mul(this.heatPeak))
              .mul(float(1).sub(soot))
              .toVar();
            const flash = clamp(float(1).sub(age.div(this.flashSeconds)), 0, 1)
              .mul(detail.y)
              .mul(float(1).sub(smoothstep(this.flashRadius.mul(this.flashSoftness), this.flashRadius, radial)));
            temperature.assign(mix(temperature, this.flashTemperature, flash));
            const emission: ShaderNode = mix(
              vec3(0),
              this.emberColour,
              clamp(temperature.div(this.rampStep), 0, 1),
            ).toVar();
            emission.assign(
              mix(emission, this.redColour, clamp(temperature.sub(this.rampStep).div(this.rampStep), 0, 1)),
            );
            emission.assign(
              mix(emission, this.orangeColour, clamp(temperature.sub(this.rampStep.mul(2)).div(this.rampStep), 0, 1)),
            );
            emission.assign(
              mix(emission, this.yellowColour, clamp(temperature.sub(this.rampStep.mul(3)).div(this.rampStep), 0, 1)),
            );
            emission.assign(
              mix(emission, this.hotColour, clamp(temperature.sub(this.rampStep.mul(4)).div(this.rampStep), 0, 1)),
            );
            // Self-shadowing without extra density taps (they tripled the per-step cost): the sun-facing side of the
            // cluster is lit, the far side and the underside fall into shadow, broken up by the large-scale noise.
            const sunSide = dot(q.sub(c).div(max(radial.mul(rf), 0.001)), this.sunDirection);
            const sunVis: ShaderNode = mix(
              this.shadowFloor,
              1,
              smoothstep(this.shadowLow, this.shadowHigh, sunSide.add(n.g.sub(0.5).mul(this.shadowNoise))),
            ).toVar();
            const sky = this.skyBase.add(this.skyGain.mul(smoothstep(this.skyLow, this.skyHigh, q.y.sub(c.y).div(rf))));
            const albedo: ShaderNode = mix(this.sootLight, this.sootDark, heat.z.mul(mix(0.6, 1, soot))).toVar();
            // The fire lights its own smoke from inside: strongest near the hot core, fading as the blast cools.
            const glow = heat0.mul(exp(radial.mul(this.glowFalloff).negate())).mul(this.bounceGain);
            const scattered: ShaderNode = albedo
              .mul(this.light)
              .mul(this.sunGain.mul(sunVis).add(this.skyScatter.mul(sky)))
              .add(albedo.mul(this.bounceColour).mul(glow).mul(this.displayScale))
              .mul(this.smokeGain)
              .toVar();
            const fireShare = smoothstep(this.fireLow, this.fireHigh, temperature);
            const alpha: ShaderNode = float(1)
              .sub(
                exp(
                  this.extinction
                    .mul(density)
                    .mul(mix(1, this.fireOpacity, fireShare))
                    .mul(ds)
                    .negate(),
                ),
              )
              .toVar();
            colour.addAssign(
              transmittance
                .mul(alpha)
                .mul(
                  scattered
                    .mul(float(1).sub(fireShare.mul(0.7)))
                    .add(emission.mul(this.emissionGain).mul(this.displayScale)),
                ),
            );
            transmittance.mulAssign(float(1).sub(alpha));
          });
          t.addAssign(ds);
        });
      });
      return vec4(colour, float(1).sub(transmittance));
    })();
    this.mesh = new InstancedQuad(material, capacity);
    // HdRenderer refreshes shared camera vectors just before drawing; recompute projection with those same vectors.
    this.mesh.onBeforeRender = () =>
      this.update(this.now.value, this.cameraRight.value, this.cameraUp.value, this.toCamera.value);
    this.mesh.name = 'volumetric-blasts';
    this.mesh.renderOrder = 7;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.root.add(this.mesh);
  }

  /** Snapshot data is copied so the presentation loop never owns the caller's scratch list or anchors. */
  setBlasts(list: readonly VolumetricBlast[]): void {
    const count = Math.min(list.length, this.mesh.capacity);
    this.blasts.length = count;
    for (let i = 0; i < count; i++) {
      const b = list[i]!;
      this.blasts[i] = { ...b, anchor: b.anchor.clone(), style: { ...b.style } };
      const s = b.style;
      const values = [
        b.anchor.x,
        b.anchor.y,
        b.anchor.z,
        b.radius,
        b.progress0,
        b.t0,
        b.rate,
        b.lifeSeconds,
        Math.max(3, Math.min(7, Math.round(s.lobes))),
        s.lobeSpread,
        s.flatten,
        s.rise,
        s.expandSeconds,
        s.coolSeconds,
        s.smokeDarkness,
        s.pockets,
        s.tongues,
        s.flash,
        s.stem,
        s.density,
        b.fade,
        b.push ?? 0,
        (b.seed >>> 0) % 65536,
        0,
      ];
      for (let j = 0; j < values.length; j++) this.data.setComponent(i, j, values[j]!);
    }
    this.data.flush();
    this.mesh.count = count;
    this.mesh.visible = count > 0;
  }

  /** Allocation-free presentation update, including the projected bounding ellipsoid. */
  update(now: number, cameraRight: Vector3, cameraUp: Vector3, toCamera: Vector3): void {
    this.now.value = now;
    this.cameraRight.value.copy(cameraRight);
    this.cameraUp.value.copy(cameraUp);
    this.toCamera.value.copy(toCamera);
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i]!,
        s = b.style;
      const progress = Math.max(0, Math.min(1, b.progress0 + Math.max(0, now - b.t0) * b.rate));
      const rf =
        this.initialRadius.value +
        (1 - this.initialRadius.value) * (1 - Math.exp((-progress * b.lifeSeconds) / Math.max(s.expandSeconds, 0.001)));
      const cy = rf * this.coreHeight.value * s.flatten + s.rise * progress * progress * (3 - 2 * progress);
      const ry = Math.max(cy, this.boundsRadius.value * rf * s.flatten, 0.01);
      const rx = this.boundsRadius.value;
      const width = Math.sqrt(rx * rx * (cameraRight.x ** 2 + cameraRight.z ** 2) + ry * ry * cameraRight.y ** 2);
      const height = Math.sqrt(rx * rx * (cameraUp.x ** 2 + cameraUp.z ** 2) + ry * ry * cameraUp.y ** 2);
      this.data.setComponent(i, 24, cy);
      this.data.setComponent(i, 25, ry);
      this.data.setComponent(i, 26, width);
      this.data.setComponent(i, 27, height);
    }
    this.data.flush();
  }

  stats(): { count: number } {
    return { count: this.mesh.count };
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.noise.dispose();
    this.mesh.dispose();
    this.root.clear();
    this.blasts.length = 0;
    this.mesh.count = 0;
  }
}
