import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  PointLight,
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
  mx_noise_float,
  positionLocal,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from './tsl';

const FIREBALLS = 96;
const SMOKE = 1536;
const SPARKS = 1024;
const SCORCHES = 96;
const SHOCKWAVES = 48;
const LIGHTS = 8;
const GLOWS = 4096;

/** A ring buffer of instanced particles whose per-instance data lives in GPU attributes; only spawns touch the CPU. */
class ParticlePool {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicNodeMaterial;
  readonly start: InstancedBufferAttribute;
  readonly origin: InstancedBufferAttribute;
  readonly velocity: InstancedBufferAttribute;
  readonly params: InstancedBufferAttribute;
  private cursor = 0;

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

  spawn(now: number, origin: Vector3, velocity: Vector3, size: number, lifetime: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.start.count;
    this.start.setX(i, now);
    this.origin.setXYZ(i, origin.x, origin.y, origin.z);
    this.velocity.setXYZ(i, velocity.x, velocity.y, velocity.z);
    this.params.setXYZW(i, size, lifetime, Math.random(), 0);
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
  private readonly fire: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly scorch: ParticlePool;
  private readonly shock: ParticlePool;
  /** Coloured glow points (beams, bolts): colour rides in the velocity attribute, which glows do not use. */
  private readonly glow: ParticlePool;
  private readonly lights: { light: PointLight; born: number; peak: number }[] = [];
  private nextLight = 0;
  /** Seconds of camera shake still pending, scaled by explosion size. */
  shake = 0;

  constructor() {
    const quad = new PlaneGeometry(1, 1);

    this.fire = new ParticlePool(FIREBALLS, quad, additive(), (pool) => {
      const { age, life, size, seed, origin } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const grow = size.mul(float(0.35).add(smoothstep(0, 0.35, t).mul(0.9)));
      pool.material.positionNode = billboard(
        origin.add(vec3(0, t.mul(0.35), 0)),
        grow,
        this.cameraRight,
        this.cameraUp,
      );
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const turbulence = mx_noise_float(vec3(p.mul(2.2), seed.mul(10).add(t.mul(3)))).mul(0.35);
        const radius = length(p).add(turbulence);
        const core = smoothstep(1.0, 0.1, radius);
        const heat = float(1).sub(t);
        const tint = mix(color(0xff4a10), color(0xfff0b0), smoothstep(0.3, 0.9, core.mul(heat)));
        const alpha = core.mul(smoothstep(1.0, 0.55, t)).mul(smoothstep(0.0, 0.04, age));
        return vec4(tint.mul(float(1.4).add(heat.mul(3))), alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    this.smoke = new ParticlePool(SMOKE, quad, blended(), (pool) => {
      const { age, life, size, seed, origin, velocity } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      // Rise and spread while slowing down (drag); wind is folded into the spawn velocity.
      const drift = velocity.mul(float(1).sub(float(1).div(age.mul(0.9).add(1)))).mul(1.6);
      const grow = size.mul(float(0.5).add(t.mul(1.8)));
      pool.material.positionNode = billboard(origin.add(drift), grow, this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const p = uv().sub(0.5).mul(2);
        const n = mx_noise_float(vec3(p.mul(1.8), seed.mul(20).add(t.mul(1.5)))).mul(0.3);
        const mask = smoothstep(1.0, 0.2, length(p).add(n));
        const shade = mix(color(0x26221f), color(0x6b6660), seed).mul(
          mix(float(1.6), float(0.9), smoothstep(0, 0.25, t)),
        );
        const alpha = mask
          .mul(smoothstep(0.0, 0.08, t))
          .mul(smoothstep(1.0, 0.35, t))
          .mul(0.7);
        return vec4(shade, alpha.mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    this.sparks = new ParticlePool(SPARKS, new PlaneGeometry(1, 1), additive(), (pool) => {
      const { age, life, size, origin, velocity } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const gravity = vec3(0, -9.0, 0).mul(age.mul(age).mul(0.5));
      const position = origin.add(velocity.mul(age)).add(gravity);
      pool.material.positionNode = billboard(position, size.mul(float(1).sub(t)), this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const mask = smoothstep(1.0, 0.0, length(uv().sub(0.5).mul(2)));
        return vec4(color(0xffc070).mul(8), mask.mul(float(1).sub(t)).mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    const ground = new PlaneGeometry(1, 1);
    ground.rotateX(-Math.PI / 2);
    this.scorch = new ParticlePool(SCORCHES, ground, blended(), (pool) => {
      const { age, life, size, seed, origin } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = origin.add(vec3(0, 0.015, 0)).add(positionLocal.mul(size));
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
      const { age, life, size, origin } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      const radius = size.mul(float(0.15).add(smoothstep(0, 1, t).mul(1.0)));
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
      const { age, life, size, origin, velocity } = particleInputs(pool, this.now);
      const t = clamp(age.div(life), 0, 1);
      pool.material.positionNode = billboard(origin, size, this.cameraRight, this.cameraUp);
      pool.material.colorNode = Fn(() => {
        const d = length(uv().sub(0.5).mul(2));
        const core = smoothstep(1.0, 0.0, d);
        const hot = smoothstep(0.35, 0.0, d);
        const tint = mix(velocity, vec3(1, 1, 1), hot.mul(0.7));
        return vec4(tint.mul(3.5), core.mul(float(1).sub(t)).mul(t.lessThan(1).select(float(1), float(0))));
      })();
    });

    for (const pool of [this.scorch, this.shock, this.smoke, this.fire, this.sparks, this.glow])
      this.root.add(pool.mesh);
    for (let i = 0; i < LIGHTS; i++) {
      const light = new PointLight(new Color(1.0, 0.5, 0.2), 0, 6, 2);
      this.root.add(light);
      this.lights.push({ light, born: -1e6, peak: 0 });
    }
  }

  explode(now: number, at: Vector3, scale: number, wind: Vector3): void {
    const r = (spread: number) => (Math.random() - 0.5) * spread;
    // Initial white-hot flash, then a cluster of rolling fireballs.
    this.fire.spawn(now, at.clone().add(new Vector3(0, 0.4, 0)), new Vector3(), 2.2 * scale, 0.12);
    for (let i = 0; i < 5 + Math.round(scale * 3); i++) {
      this.fire.spawn(
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
    const slot = this.lights[this.nextLight]!;
    this.nextLight = (this.nextLight + 1) % LIGHTS;
    slot.light.position.copy(at).add(new Vector3(0, 0.8, 0));
    slot.born = now;
    slot.peak = 35 * scale;
    this.shake = Math.max(this.shake, 0.35 * scale);
  }

  /** Weapon muzzle flash: a brief white-hot flash, a few sparks and a small light. */
  muzzleFlash(now: number, at: Vector3, scale: number): void {
    this.fire.spawn(now, at, new Vector3(), 0.9 * scale, 0.08);
    for (let i = 0; i < 4; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5).multiplyScalar(3);
      this.sparks.spawn(now, at, velocity, 0.04, 0.2 + Math.random() * 0.2);
    }
    this.flashLight(now, at, 6 * scale);
  }

  /** Small impact (bullets hitting ground or armour): a dust puff and a few sparks. */
  impact(now: number, at: Vector3, scale: number, wind: Vector3): void {
    this.smoke.spawn(now, at, new Vector3(0, 0.4, 0).add(wind), 0.45 * scale, 1.2 + Math.random() * 0.6);
    for (let i = 0; i < 6; i++) {
      const velocity = new Vector3(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).multiplyScalar(2.5);
      this.sparks.spawn(now, at, velocity, 0.035, 0.25 + Math.random() * 0.25);
    }
  }

  /** One puff of a continuous smoke column (burning buildings, damaged vehicles). */
  smokePuff(now: number, at: Vector3, scale: number, wind: Vector3): void {
    const jitter = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.25 * scale);
    const velocity = new Vector3(0, 0.9 + Math.random() * 0.5, 0).add(wind);
    this.smoke.spawn(now, at.clone().add(jitter), velocity, 0.9 * scale, 3 + Math.random() * 2);
  }

  /** One tongue of a continuous fire (burning buildings, napalm). */
  flame(now: number, at: Vector3, scale: number): void {
    const jitter = new Vector3(Math.random() - 0.5, Math.random() * 0.2, Math.random() - 0.5).multiplyScalar(
      0.3 * scale,
    );
    this.fire.spawn(now, at.clone().add(jitter), new Vector3(), 0.55 * scale * (0.7 + Math.random() * 0.6), 0.45);
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
    this.flashLight(now, to, bolt ? 5 : 3);
  }

  /** A glowing tracer sample along a projectile's flight. */
  tracer(now: number, at: Vector3): void {
    this.fire.spawn(now, at, new Vector3(), 0.16, 0.1);
  }

  private flashLight(now: number, at: Vector3, peak: number): void {
    const slot = this.lights[this.nextLight]!;
    this.nextLight = (this.nextLight + 1) % LIGHTS;
    slot.light.position.copy(at).add(new Vector3(0, 0.5, 0));
    slot.born = now;
    slot.peak = peak;
  }

  update(now: number, cameraRight: Vector3, cameraUp: Vector3): void {
    this.now.value = now;
    this.cameraRight.value.copy(cameraRight);
    this.cameraUp.value.copy(cameraUp);
    for (const slot of this.lights) {
      const age = now - slot.born;
      slot.light.intensity = age < 0 || age > 0.9 ? 0 : slot.peak * Math.exp(-age * 5) * Math.min(1, age * 30 + 0.2);
    }
  }
}

function particleInputs(pool: ParticlePool, now: ShaderNode) {
  const start: ShaderNode = instancedBufferAttribute(pool.start, 'float');
  const params: ShaderNode = instancedBufferAttribute(pool.params, 'vec4');
  return {
    age: now.sub(start) as ShaderNode,
    size: params.x as ShaderNode,
    life: params.y as ShaderNode,
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
