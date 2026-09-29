import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  clamp,
  color,
  float,
  instancedBufferAttribute,
  length,
  mix,
  min,
  mx_noise_float,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { objectLight, referenceLevel, sceneBrightness } from './atmosphere';
import type { LightField } from './lightField';
import type { ShaderNode } from './tsl';

const FIREBALLS = 96;
const FLAMES = 768;
const SMOKE = 1536;
const SPARKS = 1024;
const SCORCHES = 96;
const SHOCKWAVES = 48;
const GLOWS = 4096;
const EMBERS = 256;

/**
 * Local light of each effect, drawn into the light field (irradiance; the exposure reference is noon flat ground, about
 * 3.4). Explosions are deliberately exaggerated: they light a wide circle for a moment, day or night.
 */
export const EFFECT_LIGHTS = {
  explosion: { colour: [1.0, 0.55, 0.22], radius: 6, peak: 28, life: 0.9, decay: 5 },
  muzzle: { colour: [1.0, 0.72, 0.4], radius: 2.5, peak: 5, life: 0.12, decay: 12 },
  beam: { radius: 2.5, peak: 4, life: 0.08, decay: 10 },
  fire: { colour: [1.0, 0.6, 0.26], radius: 3.6, peak: 5.5, flicker: 0.25, ttl: 0.6 },
} as const;
/** Seconds between flame tongues of one persistent fire. */
const FIRE_INTERVAL = 1 / 14;
/** Share of a persistent fire's beats that also emit a puff of its dark smoke column. */
const FIRE_SMOKE = 0.45;
/**
 * Fire colours in linear light, golden rather than red: a red-dominant colour pushed into the tone mapper's shoulder
 * desaturates towards pink, a golden one towards the yellow-white of a real flame core.
 */
const FLAME_CORE = vec3(1.0, 0.75, 0.35);
const FLAME_EDGE = vec3(1.0, 0.42, 0.1);
const FLAME_TIP = vec3(0.9, 0.22, 0.04);

/**
 * A ring buffer of instanced particles whose per-instance data lives in GPU attributes; only spawns touch the CPU.
 * Materials collapse dead instances to a point in the vertex stage (particleInputs().alive), so particles past their
 * lifetime cost no fragments, and the whole mesh is hidden once the last spawned particle has died (`until`).
 */
class ParticlePool {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicNodeMaterial;
  readonly start: InstancedBufferAttribute;
  readonly origin: InstancedBufferAttribute;
  readonly velocity: InstancedBufferAttribute;
  readonly params: InstancedBufferAttribute;
  private cursor = 0;
  /** Seconds (effect clock) at which the last spawned particle dies; the pool draws nothing after that. */
  until = -Infinity;

  constructor(
    count: number,
    geometry: PlaneGeometry,
    material: MeshBasicNodeMaterial,
    build: (pool: ParticlePool) => void,
  ) {
    this.start = new InstancedBufferAttribute(new Float32Array(count).fill(-1e6), 1);
    this.origin = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.velocity = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    // x = size, y = lifetime, z = seed, w = spare
    this.params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.material = material;
    this.mesh = new InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    build(this);
  }

  /** `extra` rides in params.w (smoke: 1 = the dark soot of a burning wreck). */
  spawn(now: number, origin: Vector3, velocity: Vector3, size: number, lifetime: number, extra = 0): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.start.count;
    this.start.setX(i, now);
    this.origin.setXYZ(i, origin.x, origin.y, origin.z);
    this.velocity.setXYZ(i, velocity.x, velocity.y, velocity.z);
    this.params.setXYZW(i, size, lifetime, Math.random(), extra);
    this.until = Math.max(this.until, now + lifetime);
    for (const attribute of [this.start, this.origin, this.velocity, this.params]) {
      attribute.addUpdateRange(i * attribute.itemSize, attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
}

export class EffectsLayer {
  readonly root = new Object3D();
  /** Seconds, shared by CPU spawns and GPU animation. */
  readonly now = uniform(0);
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  /** Towards the (orthographic) camera: billboards are pulled along it so they never cut into the ground. */
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  private readonly fireballs: ParticlePool;
  /** Flame tongues of persistent fires (burning wrecks, napalm). */
  private readonly flames: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly scorch: ParticlePool;
  private readonly shock: ParticlePool;
  /** Coloured glow points (beams, bolts): colour rides in the velocity attribute, which glows do not use. */
  private readonly glow: ParticlePool;
  /** Hot bed of a persistent fire on the ground: the base its flame tongues rise from. */
  private readonly embers: ParticlePool;
  /** Where effect lights go; null until the renderer attaches its light field (effects then cast no light). */
  private lightField: LightField | null = null;
  /** Next flame emission per persistent fire key. */
  private readonly fireEmit = new Map<string, number>();
  /** Every pool, in draw order. */
  private readonly pools: readonly ParticlePool[];
  /** Seconds of camera shake still pending, scaled by explosion size. */
  shake = 0;

  constructor() {
    const quad = new PlaneGeometry(1, 1);

    this.fireballs = new ParticlePool(FIREBALLS, quad, additive(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.35).add(smoothstep(0, 0.35, t).mul(0.9)));
      pool.material.positionNode = billboard(
        origin.add(vec3(0, t.mul(0.35), 0)).add(this.toCamera.mul(grow.mul(0.5))),
        grow.mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const turbulence = mx_noise_float(vec3(p.mul(2.2), seed.mul(10).add(t.mul(3)))).mul(0.35);
        const radius = length(p).add(turbulence);
        const core = smoothstep(1.0, 0.1, radius);
        const heat = float(1).sub(t);
        // Golden fire: red-orange edges, a yellow core, white-hot only in the first instants.
        const hot = smoothstep(0.3, 0.9, core.mul(heat));
        const tint = mix(mix(FLAME_EDGE, FLAME_CORE, hot), vec3(1.0, 0.92, 0.75), smoothstep(0.75, 1.0, heat).mul(hot));
        // The edge fade keeps the noise-displaced core from showing the quad's square edges.
        const alpha = core
          .mul(smoothstep(1.0, 0.55, t))
          .mul(smoothstep(0.0, 0.04, age))
          .mul(smoothstep(1.0, 0.8, length(p)));
        return vec4(tint.mul(float(1.1).add(heat.mul(1.3))), alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    // Flame tongues: upright (twice as tall as wide), rising, licked sideways by noise, flickering; yellow at the root,
    // orange and red towards the tip.
    this.flames = new ParticlePool(FLAMES, quad, additive(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const width = size
        .mul(
          float(0.7)
            .add(smoothstep(0, 0.25, t).mul(0.3))
            .sub(smoothstep(0.5, 1, t).mul(0.45)),
        )
        .mul(alive);
      // Tongues stay rooted in the fire's bed: the base drifts up only a little while the tongue stretches taller over
      // its life, so flames lick upwards instead of detaching and floating away.
      const height = width.mul(float(1.3).add(t.mul(0.9)));
      const base = velocity.mul(min(age, life)).mul(0.25);
      pool.material.positionNode = origin
        .add(base)
        .add(this.toCamera.mul(size.mul(1.2)))
        .add(this.cameraRight.mul(positionLocal.x.mul(width)))
        .add(this.cameraUp.mul(positionLocal.y.add(0.5).mul(height)));
      pool.material.colorNode = Fn(() => {
        const y = uv().y;
        const lick = mx_noise_float(vec3(y.mul(2.5).sub(this.now.mul(3.5)), seed.mul(13), t.mul(2))).mul(0.3);
        const x = uv().x.sub(0.5).mul(2).add(lick.mul(y));
        // Teardrop: widest a quarter up, closing to a flickering tip.
        const halfWidth = pow(float(1).sub(y), 0.9).mul(smoothstep(0.0, 0.25, y).mul(0.3).add(0.5));
        const tip = mx_noise_float(vec3(x.mul(3), y.mul(4).sub(this.now.mul(5)), seed.mul(7))).mul(0.18);
        const body = smoothstep(halfWidth, halfWidth.mul(0.35), x.abs())
          .mul(smoothstep(1.0, 0.55, y.add(tip)))
          .mul(smoothstep(0.0, 0.14, y));
        const heat = float(1)
          .sub(y)
          .mul(float(1).sub(t.mul(0.6)));
        const tint = mix(
          mix(FLAME_TIP, FLAME_EDGE, smoothstep(0.1, 0.45, heat)),
          FLAME_CORE,
          smoothstep(0.45, 0.9, heat),
        );
        const flicker = float(0.85).add(mx_noise_float(vec3(this.now.mul(11), seed.mul(31), 0)).mul(0.3));
        const alpha = body
          .mul(smoothstep(0.0, 0.12, t))
          .mul(smoothstep(1.0, 0.6, t))
          .mul(t.lessThan(1).select(float(1), float(0)));
        // About eight tongues overlap in a burning wreck (additive): each stays dim, so the stack peaks at 1.5-2x the
        // exposure reference instead of washing out to white.
        return vec4(tint.mul(float(0.16).add(heat.mul(0.26))).mul(flicker), alpha);
      })();
    });

    this.smoke = new ParticlePool(SMOKE, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, velocity, alive } = particleInputs(pool, this.now);
      const soot = (instancedBufferAttribute(pool.params, 'vec4') as ShaderNode).w;
      const t = clamp(age.div(life), 0, 1);
      // Rise and spread while slowing down (drag); wind is folded into the spawn velocity.
      const drift = velocity.mul(float(1).sub(float(1).div(min(age, life).mul(0.9).add(1)))).mul(1.6);
      const grow = size.mul(float(0.5).add(t.mul(1.8))).mul(alive);
      // Pulled towards the camera by half its size, so a puff never cuts a hard edge into the ground or water.
      pool.material.positionNode = billboard(
        origin.add(drift).add(this.toCamera.mul(grow.mul(0.5))),
        grow,
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(1.8), seed.mul(20).add(t.mul(1.5)))).mul(0.3);
        const mask = smoothstep(1.0, 0.2, length(p).add(n));
        // Unlit smoke follows the scene's light level (1 at clear noon) and glows near fires and explosions, lit from
        // below at half the light's saturation (objectLight), so a blast next to water never paints it deep red.
        // Soot glows more from the fire under it (lit from below).
        const lit = sceneBrightness.add(objectLight(positionWorld.xz).div(referenceLevel).mul(float(0.5).add(soot)));
        const grey = mix(mix(color(0x26221f), color(0x6b6660), seed), color(0x141210), soot);
        const shade = grey.mul(mix(float(1.6), float(0.9), smoothstep(0, 0.25, t))).mul(lit);
        // Soot fades in slowly as it rises, so it never lays dark discs on the ground beside the fire.
        const alpha = mask
          .mul(smoothstep(0.0, mix(float(0.08), float(0.3), soot), t))
          .mul(smoothstep(1.0, 0.35, t))
          .mul(mix(float(0.7), float(0.5), soot));
        return vec4(shade, alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    this.sparks = new ParticlePool(SPARKS, new PlaneGeometry(1, 1), additive(), (pool) => {
      const { age, life, size, origin, velocity, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const flight = min(age, life);
      const gravity = vec3(0, -9.0, 0).mul(flight.mul(flight).mul(0.5));
      const position = origin.add(velocity.mul(flight)).add(gravity);
      pool.material.positionNode = billboard(
        position,
        size.mul(float(1).sub(t)).mul(alive),
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const mask = smoothstep(1.0, 0.0, length(uv().sub(0.5).mul(2)));
        return vec4(color(0xffc070).mul(8), mask.mul(float(1).sub(t)).mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    const ground = new PlaneGeometry(1, 1);
    ground.rotateX(-Math.PI / 2);
    this.scorch = new ParticlePool(SCORCHES, ground, blended(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = origin.add(vec3(0, 0.015, 0)).add(positionLocal.mul(size.mul(alive)));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(3.0), seed.mul(30))).mul(0.35);
        const mask = smoothstep(1.0, 0.3, length(p).add(n));
        const ember: ShaderNode = color(0xff5a1a).mul(
          smoothstep(0.35, 0.0, length(p))
            .mul(smoothstep(0.08, 0.0, t))
            .mul(4),
        );
        return vec4(color(0x0d0b09).add(ember), mask.mul(0.8).mul(smoothstep(1.0, 0.6, t)));
      })();
    });
    this.scorch.mesh.renderOrder = 5;

    // Ground shockwave: a hot ring racing outward in the first half-second, the part that sells "big boom" at RTS zoom.
    this.shock = new ParticlePool(SHOCKWAVES, ground, additive(), (pool) => {
      const { age, life, size, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const radius = size.mul(float(0.15).add(smoothstep(0, 1, t).mul(1.0))).mul(alive);
      pool.material.positionNode = origin.add(vec3(0, 0.03, 0)).add(positionLocal.mul(radius));
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        // A thin hot ring only; a filled disc reads as a coloured halo over dark water.
        const ring = smoothstep(0.1, 0.0, d.sub(0.85).abs());
        const fade = float(1).sub(t).mul(float(1).sub(t));
        return vec4(
          color(0xffe2b8).mul(1.4),
          ring
            .mul(fade)
            .mul(0.8)
            .mul(t.lessThan(1).select(float(1), float(0))),
        );
      })();
    });

    this.glow = new ParticlePool(GLOWS, quad, additive(), (pool) => {
      const { age, life, size, origin, velocity, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = billboard(origin, size.mul(alive), this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        const core = smoothstep(1.0, 0.0, d);
        const hot = smoothstep(0.35, 0.0, d);
        const tint = mix(velocity, vec3(1, 1, 1), hot.mul(0.7));
        return vec4(tint.mul(3.5), core.mul(float(1).sub(t)).mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    // Ember bed: a flat, flickering, white-yellow core on the ground under a persistent fire (additive), refreshed with
    // every flame beat.
    this.embers = new ParticlePool(EMBERS, ground, additive(), (pool) => {
      const { age, life, size, seed, origin, alive } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = origin.add(vec3(0, 0.025, 0)).add(positionLocal.mul(size.mul(alive)));
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(3.0), seed.mul(17).add(this.now.mul(2.5)))).mul(0.3);
        const d = length(p).add(n);
        const bed = smoothstep(1.0, 0.2, d);
        const core = smoothstep(0.45, 0.0, d);
        const tint = mix(FLAME_EDGE, vec3(1.0, 0.9, 0.6), core);
        const fade = smoothstep(0.0, 0.15, t).mul(smoothstep(1.0, 0.5, t));
        return vec4(tint.mul(bed.mul(0.5).add(core.mul(0.9))), fade.mul(0.55));
      })();
    });
    this.embers.mesh.renderOrder = 6;

    // Fire and sparks always draw over smoke (the smoke of a fire rises above and behind its flames).
    this.smoke.mesh.renderOrder = 6;
    for (const pool of [this.flames, this.fireballs, this.sparks, this.glow]) pool.mesh.renderOrder = 7;
    this.pools = [
      this.scorch,
      this.shock,
      this.embers,
      this.smoke,
      this.flames,
      this.fireballs,
      this.sparks,
      this.glow,
    ];
    for (const pool of this.pools) {
      pool.mesh.visible = false;
      this.root.add(pool.mesh);
    }
  }

  /** Route effect lights into a light field (they replace the point lights earlier versions used). */
  attachLightField(lightField: LightField | null): void {
    this.lightField = lightField;
  }

  explode(now: number, at: Vector3, scale: number, wind: Vector3): void {
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    // Initial white-hot flash, then a cluster of rolling fireballs.
    this.fireballs.spawn(now, at.clone().add(new Vector3(0, 0.4, 0)), new Vector3(), 2.2 * scale, 0.12);
    for (let i = 0; i < 5 + Math.round(scale * 3); i++) {
      this.fireballs.spawn(
        now + i * 0.045,
        at.clone().add(new Vector3(r(0.8), 0.15 + Math.random() * 0.5, r(0.8)).multiplyScalar(scale)),
        new Vector3(),
        1.5 * scale * (0.7 + Math.random() * 0.6),
        0.6 + Math.random() * 0.35,
      );
    }
    this.shock.spawn(now, at, new Vector3(), 3.4 * scale, 0.5);
    for (let i = 0; i < 16 + Math.round(scale * 12); i++) {
      const velocity = new Vector3(r(1.6), 1.0 + Math.random() * 1.1, r(1.6)).multiplyScalar(scale).add(wind);
      this.smoke.spawn(
        now + 0.08 + Math.random() * 0.3,
        at.clone().add(new Vector3(r(0.6), 0.25, r(0.6))),
        velocity,
        1.2 * scale,
        3.5 + Math.random() * 2.5,
      );
    }
    for (let i = 0; i < 30 + Math.round(scale * 24); i++) {
      const velocity = new Vector3(r(9), 4 + Math.random() * 6, r(9)).multiplyScalar(0.6 + scale * 0.4);
      this.sparks.spawn(now, at.clone().add(new Vector3(0, 0.2, 0)), velocity, 0.06, 0.5 + Math.random() * 0.6);
    }
    this.scorch.spawn(now, at, new Vector3(), 1.4 * scale, 40);
    const light = EFFECT_LIGHTS.explosion;
    this.lightField?.pulse(
      now,
      at,
      light.colour,
      light.radius * scale,
      light.peak * scale,
      light.life,
      light.decay,
      'explosion',
    );
    this.shake = Math.max(this.shake, 0.35 * scale);
  }

  /** Weapon muzzle flash: a brief white-hot flash, a few sparks and a small light. */
  muzzleFlash(now: number, at: Vector3, scale: number): void {
    this.fireballs.spawn(now, at, new Vector3(), 0.9 * scale, 0.08);
    for (let i = 0; i < 4; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(3);
      this.sparks.spawn(now, at, velocity, 0.04, 0.2 + Math.random() * 0.2);
    }
    const light = EFFECT_LIGHTS.muzzle;
    this.lightField?.pulse(now, at, light.colour, light.radius, light.peak * scale, light.life, light.decay, 'flash');
  }

  /** Small impact (bullets hitting ground or armour): a dust puff and a few sparks. */
  impact(now: number, at: Vector3, scale: number, wind: Vector3): void {
    this.smoke.spawn(now, at, new Vector3(0, 0.4, 0).add(wind), 0.45 * scale, 1.2 + Math.random() * 0.6);
    for (let i = 0; i < 6; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).multiplyScalar(2.5);
      this.sparks.spawn(now, at, velocity, 0.035, 0.25 + Math.random() * 0.25);
    }
  }

  /** One puff of a continuous smoke column (burning buildings, damaged vehicles); `soot` for a fire's dark smoke. */
  smokePuff(now: number, at: Vector3, scale: number, wind: Vector3, soot = false): void {
    const jitter = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.25 * scale);
    const velocity = new Vector3(0, 0.9 + Math.random() * 0.5, 0).add(wind);
    this.smoke.spawn(now, at.clone().add(jitter), velocity, 0.9 * scale, 3 + Math.random() * 2, soot ? 1 : 0);
  }

  /**
   * One tongue of a continuous fire (burning buildings, napalm). With a `key` (the tracked anim's identity) the fire
   * also keeps a flickering light alive in the light field for as long as tongues keep coming.
   */
  flame(now: number, at: Vector3, scale: number, key?: string): void {
    const jitter = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.55 * scale);
    const rise = new Vector3((Math.random() - 0.5) * 0.15, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.15);
    this.flames.spawn(
      now,
      at.clone().add(jitter),
      rise.multiplyScalar(scale),
      0.5 * scale * (0.7 + Math.random() * 0.6),
      0.45 + Math.random() * 0.3,
    );
    if (key !== undefined) {
      const light = EFFECT_LIGHTS.fire;
      this.lightField?.keep(
        key,
        now,
        at,
        light.colour,
        light.radius * scale,
        light.peak * scale,
        light.flicker,
        light.ttl,
      );
    }
  }

  /**
   * A persistent fire (a burning wreck), called every frame: flame tongues at a steady rate, a continuous column of
   * dark smoke and a kept-alive light. Stops (and its light fades) when the calls stop.
   */
  fire(now: number, at: Vector3, scale: number, key: string, wind = new Vector3()): void {
    const next = this.fireEmit.get(key) ?? 0;
    if (now < next) return;
    this.fireEmit.set(key, now + FIRE_INTERVAL);
    if (this.fireEmit.size > 512) this.fireEmit.clear();
    // A burning wreck: a glowing ember bed, two tongues per beat (one larger) rooted in it and a steady soot column
    // rising well above them.
    this.embers.spawn(now, at, new Vector3(), 1.1 * scale * (0.85 + Math.random() * 0.3), 0.35);
    this.flame(now, at, scale, key);
    this.flame(now, at, scale * 1.3);
    if (Math.random() < FIRE_SMOKE) this.smokePuff(now, at.clone().setY(at.y + 1.1 * scale), scale, wind, true);
  }

  /**
   * One frame of an energy beam from `from` to `to` (linear RGB colour): a straight laser, or for `bolt` a jagged,
   * flickering lightning path regenerated every call. Drawn as dense glow points, with a light at the impact end.
   */
  beam(now: number, from: Vector3, to: Vector3, colour: Vector3, bolt: boolean): void {
    const length = from.distanceTo(to);
    const steps = Math.max(6, Math.min(80, Math.round(length * 18)));
    const side = new Vector3(to.z - from.z, 0, from.x - to.x).normalize();
    let offset = 0;
    const at = new Vector3();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      at.lerpVectors(from, to, t);
      if (bolt) {
        // A random walk pinned at both ends reads as lightning.
        offset += (Math.random() - 0.5) * 0.12;
        offset *= Math.sin(Math.PI * t) > 0.05 ? 1 : 0;
        at.addScaledVector(side, offset * Math.sin(Math.PI * t)).add(new Vector3(0, (Math.random() - 0.5) * 0.06, 0));
      }
      this.glow.spawn(now, at, colour, bolt ? 0.1 : 0.08, bolt ? 0.07 : 0.05);
    }
    const light = EFFECT_LIGHTS.beam;
    const max = Math.max(colour.x, colour.y, colour.z, 1e-3);
    this.lightField?.pulse(
      now,
      to,
      [colour.x / max, colour.y / max, colour.z / max],
      light.radius,
      light.peak * (bolt ? 1.25 : 1),
      light.life,
      light.decay,
      'flash',
    );
  }

  /** A glowing tracer sample along a projectile's flight. */
  tracer(now: number, at: Vector3): void {
    this.fireballs.spawn(now, at, new Vector3(), 0.16, 0.1);
  }

  update(now: number, cameraRight: Vector3, cameraUp: Vector3, toCamera?: Vector3): void {
    this.now.value = now;
    // Pools whose last particle has died draw nothing at all (no draw call, no vertex work).
    for (const pool of this.pools) pool.mesh.visible = now < pool.until;
    this.cameraRight.value.copy(cameraRight);
    this.cameraUp.value.copy(cameraUp);
    if (toCamera) this.toCamera.value.copy(toCamera);
  }

  /** Active effect lights per pool and the strongest explosion light (console checks and tests). */
  lightStats(now: number): { explosion: number; flash: number; kept: number; explosionPeak: number } {
    const lf = this.lightField;
    if (!lf) return { explosion: 0, flash: 0, kept: 0, explosionPeak: 0 };
    const s = lf.stats(now);
    return { explosion: s.explosion, flash: s.flash, kept: s.kept, explosionPeak: lf.peakIntensity('explosion', now) };
  }
}

/**
 * Per-instance inputs. `alive` is 1 from spawn to the end of the lifetime and 0 otherwise: materials scale their quad
 * by it, so pending and dead instances collapse to a point and produce no fragments.
 */
function particleInputs(pool: ParticlePool, now: ShaderNode) {
  const start: ShaderNode = instancedBufferAttribute(pool.start, 'float');
  const params: ShaderNode = instancedBufferAttribute(pool.params, 'vec4');
  const age: ShaderNode = now.sub(start);
  const life: ShaderNode = params.y;
  return {
    age,
    alive: step(0, age).mul(step(age, life)) as ShaderNode,
    size: params.x as ShaderNode,
    life,
    seed: params.z as ShaderNode,
    origin: instancedBufferAttribute(pool.origin, 'vec3') as ShaderNode,
    velocity: instancedBufferAttribute(pool.velocity, 'vec3') as ShaderNode,
  };
}

/** Camera-facing quad around `center`, sized in world units. */
function billboard(center: ShaderNode, size: ShaderNode, right: ShaderNode, up: ShaderNode) {
  return center.add(right.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size)));
}

function additive(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  return material;
}

function blended(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = NormalBlending;
  return material;
}
