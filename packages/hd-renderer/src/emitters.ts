import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
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
  instancedBufferAttribute,
  length,
  mix,
  mx_noise_float,
  positionGeometry,
  positionWorld,
  pow,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { pavedAt, puddleNoise, rainAmount } from './atmosphere';
import type { ShaderNode } from './tsl';

/** One visible light source: a glowing head above its base and, on wet paved ground, its reflection. */
export interface Emitter {
  /** Base on the ground (world). */
  x: number;
  y: number;
  z: number;
  /** Head height above the base (world units). */
  head: number;
  /** Head glow colour (linear radiance multiplier); zero for reflection-only emitters (lit facades). */
  glow: readonly [number, number, number];
  /** Reflection streak colour (linear radiance). */
  streak: readonly [number, number, number];
  /**
   * How far the head is pulled towards the camera (world units), so the emitter's own card never hides it while art
   * standing in front of the post still does. Default: HEAD_PUSH.
   */
  push?: number;
  /** Streak length (world units); default: the mirrored head smeared by the wet surface (head x sqrt 3 x STREAK_SMEAR). */
  streakLength?: number;
  /** Streak half-width (world units); default 0.3. */
  streakWidth?: number;
}

const STATIC_CAPACITY = 1024;
const DYNAMIC_CAPACITY = 256;
/** Toward the fixed camera on the ground plane (IsoCamera looks from +x +z). */
const TO_CAMERA_GROUND = new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2);
/**
 * A rain-stirred wet surface smears a mirrored light into a long streak towards the viewer (concept C: streaks several
 * cells long under every lamp): this many times the ideal mirror image's distance.
 */
const STREAK_SMEAR = 3.2;
/** Default head pull towards the camera: a little more than a thin post card's own push. */
export const HEAD_PUSH = 0.35;

/**
 * Light sources seen directly: camera-facing glows at lamp heads and reflection streaks on wet paved ground. Static
 * emitters (lamps) fade in with the night; dynamic ones (fires, explosions) are refreshed every frame from the light
 * field. Everything is additive and exactly zero while the gains are zero.
 */
export class EmitterLayer {
  readonly root = new Object3D();
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /** Static (lamp) head/streak gain: the renderer sets smoothstep(0.3, 0.8, night) when lamps are enabled. */
  readonly lampGain = uniform(0);
  /** Surface wetness 0..1 (streaks only appear on wet paved ground). */
  readonly wet = uniform(0);
  private readonly layers: { heads: InstancedMesh; streaks: InstancedMesh; attrs: InstancedBufferAttribute[] }[];
  private staticCount = 0;
  /** Emitters with a head (glow) per layer: reflection-only lists (lit facades) draw no head quads at all. */
  private readonly headCount = [0, 0];
  private readonly streakCount = [0, 0];

  constructor() {
    this.root.name = 'emitters';
    this.layers = [STATIC_CAPACITY, DYNAMIC_CAPACITY].map((capacity, index) => this.build(capacity, index === 0));
  }

  private build(capacity: number, isStatic: boolean) {
    // aPos = (x, y, z, head), aGlow = (r, g, b, size), aStreak = (r, g, b, length), aExtra = (push, half-width, seed).
    const aPos = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const aGlow = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const aStreak = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const aExtra = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const p: ShaderNode = instancedBufferAttribute(aPos, 'vec4');
    const g: ShaderNode = instancedBufferAttribute(aGlow, 'vec4');
    const s: ShaderNode = instancedBufferAttribute(aStreak, 'vec4');
    const x: ShaderNode = instancedBufferAttribute(aExtra, 'vec3');
    const gain: ShaderNode = isStatic ? this.lampGain : float(1);

    const heads = new MeshBasicNodeMaterial();
    heads.transparent = true;
    heads.depthWrite = false;
    heads.blending = AdditiveBlending;
    const head = p.xyz.add(vec3(0, p.w, 0));
    // Pulled towards the camera just past the lamp's own card (orthographic: no shift on screen), so units standing in
    // front of the post still cover its head.
    heads.positionNode = head
      .add(this.cameraRight.mul(positionGeometry.x.mul(g.w)))
      .add(this.cameraUp.mul(positionGeometry.y.mul(g.w)))
      .add(this.toCamera.mul(x.x));
    heads.colorNode = Fn(() => {
      const d = length(uv().sub(0.5).mul(2));
      // A modest core keeps sodium heads orange below the tone mapper's shoulder instead of cream-white.
      const core = smoothstep(0.2, 0.0, d).mul(2.5);
      const halo = pow(smoothstep(1.0, 0.0, d), 3).mul(float(0.3).add(rainAmount.mul(0.2)));
      return vec4(g.rgb.mul(core.add(halo)).mul(gain), 1);
    })();
    const headMesh = new InstancedMesh(new PlaneGeometry(1, 1), heads, capacity);
    headMesh.frustumCulled = false;
    headMesh.renderOrder = 8;
    headMesh.count = 0;

    const streaks = new MeshBasicNodeMaterial();
    streaks.transparent = true;
    streaks.depthWrite = false;
    // The decal is built in world space from the quad's corners; either winding must show from above.
    streaks.side = DoubleSide;
    streaks.blending = AdditiveBlending;
    const fwd = vec3(Math.SQRT1_2, 0, Math.SQRT1_2);
    const side = vec3(Math.SQRT1_2, 0, -Math.SQRT1_2);
    // From just behind the base to `length` towards the camera; the mirrored head lands h * sqrt(3) out.
    const len: ShaderNode = s.w;
    streaks.positionNode = p.xyz
      .add(vec3(0, 0.03, 0))
      .add(fwd.mul(positionGeometry.y.add(0.5).mul(len).sub(0.15)))
      .add(side.mul(positionGeometry.x.mul(x.y.mul(2))));
    streaks.colorNode = Fn(() => {
      const along = uv().y;
      const across = uv().x.sub(0.5).mul(2);
      // Where along the streak the ideal mirror image sits (0..1).
      const mirror = p.w.mul(Math.sqrt(3)).div(len).clamp(0.05, 0.6);
      // A mirrored light smeared by the rain-stirred surface into a long, thin streak towards the viewer: brightest at
      // the mirror point, a steady tail, a wavering centre line and shimmering bands; puddles reflect more.
      const wobble = mx_noise_float(vec3(positionWorld.xz.mul(4), time.mul(1.2).add(x.z.mul(7))));
      const core = float(1)
        .sub(across.add(wobble.mul(0.25)).abs())
        .max(0);
      const lengthwise = smoothstep(0.0, mirror.mul(0.7), along)
        .mul(pow(float(1).sub(along), 1.2))
        .mul(0.8);
      // Lamps and fires reflect a bright image of their head; reflection-only emitters (the stacked panes of a lit
      // facade, no head quad) reflect as an even streak.
      const peak = exp(along.sub(mirror).mul(along.sub(mirror)).mul(-60)).mul(
        g.w.greaterThan(0).select(float(1.2), float(0.25)),
      );
      const shape = pow(core, 4).mul(lengthwise.add(peak));
      const gloss = mix(float(0.6), float(1.8), puddleNoise(positionWorld));
      const bands = smoothstep(0.1, 0.9, along.mul(30).add(wobble.mul(3)).add(time.mul(2.5)).sin().mul(0.5).add(0.5));
      const ripple = mix(float(0.45), float(1), bands);
      const surface = pavedAt(positionWorld.xz).mul(this.wet);
      return vec4(s.rgb.mul(shape).mul(gloss).mul(ripple).mul(surface).mul(gain), 1);
    })();
    const streakMesh = new InstancedMesh(new PlaneGeometry(1, 1), streaks, capacity);
    streakMesh.frustumCulled = false;
    streakMesh.renderOrder = 3;
    streakMesh.count = 0;
    this.root.add(streakMesh, headMesh);
    return { heads: headMesh, streaks: streakMesh, attrs: [aPos, aGlow, aStreak, aExtra] };
  }

  private write(layer: 0 | 1, list: readonly Emitter[], sizeOf: (e: Emitter) => number): number {
    const { heads, streaks, attrs } = this.layers[layer]!;
    const [aPos, aGlow, aStreak, aExtra] = attrs as [
      InstancedBufferAttribute,
      InstancedBufferAttribute,
      InstancedBufferAttribute,
      InstancedBufferAttribute,
    ];
    const n = Math.min(list.length, aPos.count);
    for (let i = 0; i < n; i++) {
      const e = list[i]!;
      aPos.setXYZW(i, e.x, e.y, e.z, e.head);
      aGlow.setXYZW(i, e.glow[0], e.glow[1], e.glow[2], sizeOf(e));
      const length = e.streakLength ?? e.head * Math.sqrt(3) * STREAK_SMEAR;
      aStreak.setXYZW(i, e.streak[0], e.streak[1], e.streak[2], Math.max(0.3, length));
      // A stable per-emitter seed from its position jitters each streak's shimmer.
      aExtra.setXYZ(
        i,
        e.push ?? HEAD_PUSH,
        e.streakWidth ?? 0.3,
        (Math.sin(e.x * 12.9898 + e.z * 78.233) * 43758.5453) % 1,
      );
    }
    for (const a of attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    heads.count = n;
    streaks.count = n;
    let withHead = 0;
    for (let i = 0; i < n; i++) if (sizeOf(list[i]!) > 0) withHead++;
    this.headCount[layer] = withHead;
    this.streakCount[layer] = n;
    this.sync();
    return n;
  }

  /**
   * Show only what can contribute: static heads and streaks while the lamp gain is up, streaks only on wet ground.
   * Every fragment of a hidden layer would add exactly zero. Call after changing lampGain or wet.
   */
  sync(): void {
    const lamps = this.lampGain.value > 0;
    const wet = this.wet.value > 0;
    this.layers.forEach(({ heads, streaks }, layer) => {
      const on = layer === 1 || lamps;
      heads.visible = on && this.headCount[layer]! > 0;
      streaks.visible = on && wet && this.streakCount[layer]! > 0;
    });
  }

  /** Replace the static emitters (lamps). */
  setStatic(list: readonly Emitter[]): void {
    // Reflection-only emitters (no glow) get an empty head quad.
    this.staticCount = this.write(0, list, (e) => (e.glow[0] + e.glow[1] + e.glow[2] > 0 ? 0.9 : 0));
  }

  /** Replace the dynamic emitters (fires, explosions) for this frame. */
  setDynamic(list: readonly Emitter[]): void {
    this.write(1, list, (e) => (e.glow[0] + e.glow[1] + e.glow[2] > 0 ? Math.min(1.6, 0.5 + e.head) : 0));
  }

  get staticEmitters(): number {
    return this.staticCount;
  }

  /** Ground direction reflections run along (towards the camera). */
  static get towardsCamera(): Vector3 {
    return TO_CAMERA_GROUND.clone();
  }
}
