import {
  AdditiveBlending,
  DataTexture,
  DataUtils,
  DoubleSide,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
  UnsignedByteType,
  type Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  abs,
  float,
  instancedBufferAttribute,
  length,
  max,
  mx_noise_float,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, type AtmosphereNodes } from './atmosphere';
import type { ShaderNode } from './tsl';

/** Falloff of a light-field entry: the engine's linear 1 - d, or a tighter pool (1 - d^2)^2 / (1 + 10 d^2). */
export const SHAPE_LINEAR = 0;
export const SHAPE_POOL = 1;

export interface LightEntry {
  x: number;
  z: number;
  /** World units (cells). */
  radius: number;
  shape: typeof SHAPE_LINEAR | typeof SHAPE_POOL;
  /** Irradiance at the centre, linear RGB (the exposure reference is noon flat-ground irradiance). */
  colour: readonly [number, number, number];
  /** Flicker amplitude (0 = steady): intensity x (1 + amp * noise(t)). */
  flicker?: number;
  seed?: number;
}

/** A persistent emitter; holeOffset locates an exclusion rectangle relative to the light centre. */
export interface SourceSpec extends Omit<LightEntry, 'shape'> {
  /** Peak intensity before CPU flicker and lifetime fading (default 1). */
  peak?: number;
  /** Seconds after the last refresh; fades during the second half (default 0.6). */
  ttl?: number;
  /** Axis-aligned exclusion half-extents in world units; absent or [0, 0] leaves every fragment unchanged. */
  hole?: readonly [number, number];
  holeOffset?: readonly [number, number];
  head?: number;
  glow?: readonly [number, number, number] | null;
  glowSize?: number;
  push?: number;
}

interface Source extends Kept {
  spec: SourceSpec;
}

/** Electrical levels at 10–14 Hz, joined over 25 ms; rare surges stay within the amplitude bound. */
export function flicker(seed: number, now: number, amp = 0): number {
  if (amp === 0) return 1;
  const random = (step: number) => {
    let h = Math.imul(Math.round(seed * 1e6) ^ step, 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const hz = 10 + 4 * random(0x1234);
  const tick = Math.floor(now * hz);
  const level = (i: number) => {
    const r = random(i);
    return r > 0.88 ? 1 : -1 + (r / 0.88) * 1.4;
  };
  const t = Math.max(0, Math.min(1, (now - tick / hz) / 0.025));
  const blend = t * t * (3 - 2 * t);
  return 1 + Math.max(0, Math.min(1, amp)) * (level(tick - 1) * (1 - blend) + level(tick) * blend);
}

interface Pulse {
  born: number;
  x: number;
  z: number;
  colour: [number, number, number];
  radius: number;
  peak: number;
  life: number;
  decay: number;
}

interface Kept {
  key: string;
  x: number;
  z: number;
  colour: [number, number, number];
  radius: number;
  peak: number;
  flicker: number;
  seed: number;
  born: number;
  seen: number;
  ttl: number;
}

const POOLS = { explosion: 128, flash: 256 } as const;
export type PulsePool = keyof typeof POOLS;
/** Kept-alive lights (fires) at once; keep() ignores more. */
const KEPT = 256;
/** Static lights (lamps, window glows, visible map lamps) at once; setStatic keeps the first this many. */
const STATIC = 896;
/** Sources cannot displace fire or pulse instances. */
const SOURCES = 256;
/** Dynamic instances: every pool has its own reserved share, so a burst of flashes never starves fires. */
const DYNAMIC = POOLS.explosion + POOLS.flash + KEPT + SOURCES;

/** Per-instance attributes of one light mesh: aPos = (x, z, radius, shape), aCol = (r, g, b, flicker), aExtra = (seed, hole half-x, half-z), aHoleOffset = light-local hole centre. */
interface LightInstances {
  mesh: InstancedMesh;
  aPos: InstancedBufferAttribute;
  aCol: InstancedBufferAttribute;
  aExtra: InstancedBufferAttribute;
  aHoleOffset: InstancedBufferAttribute;
  attributes: readonly InstancedBufferAttribute[];
}

/** A dynamic light as mirrored into other layers (reflection streaks, glows). */
export interface DynamicLight {
  x: number;
  z: number;
  colour: [number, number, number];
  kind: 'pulse' | 'fire' | 'source';
  head?: number;
  glow?: [number, number, number];
  glowSize?: number;
  push?: number;
}

/**
 * Whole-map light field: a top-down additive render of every local light into a W*t x H*t texture (t texels per cell,
 * at most 8, and at most 2048 texels a side), read by terrain, sprites, voxels, rain, smoke and mist through
 * atmosphere.ts. Layer 1 is a base grid (one RGB value per cell, linear-filtered: the engine's own per-cell light);
 * layer 2 is instanced round lights in two meshes: static ones (lamps, windows; written once per setStatic, scaled by
 * the night-driven static gain and hidden while it is 0) and dynamic ones (explosion and flash pulses in separate ring
 * pools, kept-alive fires and steady sources; rewritten while any is alive). The texture is re-rendered only when something changed or a
 * dynamic light is alive.
 */
export class LightField {
  readonly target: RenderTarget;
  readonly texelsPerCell: number;
  /** Values are stored divided by this (8-bit fallback targets). */
  readonly encodeScale: number;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly baseTexture: DataTexture;
  private readonly baseGain = uniform(0);
  private readonly staticGainNode = uniform(0);
  private readonly statics: LightInstances;
  private readonly dynamics: LightInstances;
  private staticList: LightEntry[] = [];
  /** The static mesh's attributes no longer match staticList. */
  private staticDirty = false;
  private readonly pulses: Record<PulsePool, Pulse[]> = { explosion: [], flash: [] };
  private readonly cursor: Record<PulsePool, number> = { explosion: 0, flash: 0 };
  private readonly kept = new Map<string, Kept>();
  private readonly sources = new Map<string, Source>();
  private readonly mirrored = new WeakMap<DynamicLight[], DynamicLight[]>();
  private baseStrength = 0;
  /** Whether the base grid fades with the night (static gain) or is always on (see MapLightStaging). */
  private baseFollowsNight = true;
  private staticGain = 0;
  private dirty = true;
  private lastDynamic = 0;
  private lastGain = -1;
  private lastBase = -1;
  private staticFlicker = false;
  /** Renders so far (diagnostics). */
  renders = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    options: { halfFloat?: boolean; nodes?: AtmosphereNodes } = {},
  ) {
    this.texelsPerCell = Math.max(1, Math.min(8, Math.floor(2048 / Math.max(width, height))));
    const halfFloat = options.halfFloat ?? true;
    this.encodeScale = halfFloat ? 1 : 8;
    this.target = new RenderTarget(width * this.texelsPerCell, height * this.texelsPerCell, {
      type: halfFloat ? HalfFloatType : UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    // three samples render targets with uv (0, 0) at the top of the rendered image on both backends (WebGPU natively,
    // WebGL through TextureNode's runtime flip of render-target textures), while consumers address the field with
    // uv = world xz / size. So world z = 0 must be rendered at the top: top = 0, bottom = height. With the usual
    // top = height the whole field came out mirrored in z (lights landed at H - z).
    this.camera = new OrthographicCamera(0, width, 0, height, -10, 10);
    this.camera.position.set(0, 0, 5);
    this.camera.updateMatrixWorld();

    // Layer 1: the per-cell base grid; texel (i, j) covers cell (i, j), linear filtering blends cell centres. Half float:
    // filterable on every WebGPU adapter and in WebGL2 core (32-bit float filtering is an optional feature).
    this.baseTexture = new DataTexture(new Uint16Array(width * height * 4), width, height, RGBAFormat, HalfFloatType);
    this.baseTexture.magFilter = LinearFilter;
    this.baseTexture.minFilter = LinearFilter;
    this.baseTexture.needsUpdate = true;
    const baseMaterial = additiveMaterial();
    baseMaterial.colorNode = vec4(
      texture(this.baseTexture, vec2(positionWorld.x.div(width), positionWorld.y.div(height))).rgb.mul(this.baseGain),
      1,
    );
    const base = new Mesh(new PlaneGeometry(width, height), baseMaterial);
    base.position.set(width / 2, height / 2, -1);
    base.frustumCulled = false;
    this.scene.add(base);

    // Layer 2: instanced lights, static and dynamic meshes.
    this.statics = this.buildLights(STATIC, this.staticGainNode);
    this.dynamics = this.buildLights(DYNAMIC, float(1));
    this.scene.add(this.statics.mesh, this.dynamics.mesh);

    const nodes = options.nodes ?? DEFAULT_ATMOSPHERE_NODES;
    nodes.lightFieldTexture.value = this.target.texture;
    nodes.lightFieldSize.value.set(width, height);
    nodes.lightFieldScale.value = this.encodeScale;
  }

  private buildLights(capacity: number, gain: ShaderNode): LightInstances {
    const aPos = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const aCol = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const aExtra = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const aHoleOffset = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const material = additiveMaterial();
    const p: ShaderNode = instancedBufferAttribute(aPos, 'vec4');
    const c: ShaderNode = instancedBufferAttribute(aCol, 'vec4');
    const extra: ShaderNode = instancedBufferAttribute(aExtra, 'vec3');
    const seed = extra.x;
    const holeOffset: ShaderNode = instancedBufferAttribute(aHoleOffset, 'vec2');
    material.positionNode = vec3(p.xy.add(positionGeometry.xy.mul(p.z.mul(2))), 0);
    material.colorNode = Fn(() => {
      const d = length(uv().sub(0.5).mul(2));
      const linear = max(float(1).sub(d), 0);
      const window = max(float(1).sub(d.mul(d)), 0);
      const pool = window.mul(window).div(float(1).add(d.mul(d).mul(10)));
      const shape = select(p.w.greaterThan(0.5), pool, linear);
      const flicker = float(1).add(c.w.mul(mx_noise_float(vec2(time.mul(9).add(seed.mul(17.3)), seed.mul(3.1)))));
      const local = uv().sub(0.5).mul(p.z.mul(2)).sub(holeOffset);
      const border = max(abs(local.x).sub(extra.y), abs(local.y).sub(extra.z));
      // No hole is exactly one, preserving all legacy fire, pulse and lamp colours.
      const hole = select(extra.y.greaterThan(0).and(extra.z.greaterThan(0)), smoothstep(0, 0.25, border), float(1));
      return vec4(c.rgb.mul(shape).mul(flicker.max(0)).mul(gain).div(this.encodeScale).mul(hole), 1);
    })();
    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, capacity);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return { mesh, aPos, aCol, aExtra, aHoleOffset, attributes: [aPos, aCol, aExtra, aHoleOffset] };
  }

  /** Write one light into instance `i` of `target`. */
  private writeLight(
    target: LightInstances,
    i: number,
    x: number,
    z: number,
    radius: number,
    shape: number,
    colour: readonly number[],
    scale: number,
    flicker: number,
    seed: number,
    hole?: readonly [number, number],
    holeOffset?: readonly [number, number],
  ): void {
    target.aPos.setXYZW(i, x, z, radius, shape);
    target.aCol.setXYZW(i, colour[0]! * scale, colour[1]! * scale, colour[2]! * scale, flicker);
    target.aExtra.setXYZ(i, seed, hole?.[0] ?? 0, hole?.[1] ?? 0);
    target.aHoleOffset.setXY(i, holeOffset?.[0] ?? 0, holeOffset?.[1] ?? 0);
  }

  /** Upload instances [0, n) of `target` and draw that many. */
  private commit(target: LightInstances, n: number): void {
    for (const a of target.attributes) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    target.mesh.count = n;
  }

  /** Whether the renderer can render into (and filter) half-float targets; otherwise an 8-bit target is used. */
  static supportsHalfFloat(renderer: WebGPURenderer): boolean {
    const backend = renderer.backend as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext };
    if (backend.isWebGPUBackend) return true;
    const gl = backend.gl;
    return !!gl && !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
  }

  /**
   * Per-cell base light: RGB triples (width * height * 3) in units of noon irradiance, and the irradiance one unit is
   * worth (already including any gain). Null clears it. `followsNight` false keeps it on by day (dusk maps).
   */
  setBase(cells: Float32Array | null, strength = 1, followsNight = true): void {
    const data = this.baseTexture.image.data as Uint16Array;
    data.fill(0);
    if (cells) {
      for (let i = 0; i < this.width * this.height; i++) {
        data[i * 4] = DataUtils.toHalfFloat(cells[i * 3]!);
        data[i * 4 + 1] = DataUtils.toHalfFloat(cells[i * 3 + 1]!);
        data[i * 4 + 2] = DataUtils.toHalfFloat(cells[i * 3 + 2]!);
      }
    }
    this.baseStrength = cells ? strength : 0;
    this.baseFollowsNight = followsNight;
    this.baseTexture.needsUpdate = true;
    this.dirty = true;
  }

  /** Replace the static lights (scaled by the static gain). */
  setStatic(list: readonly LightEntry[]): void {
    if (list.length > STATIC) console.warn(`LightField: ${list.length} static lights, drawing the first ${STATIC}`);
    this.staticList = list.slice(0, STATIC);
    this.staticFlicker = this.staticList.some((l) => (l.flicker ?? 0) > 0);
    this.staticDirty = true;
    this.dirty = true;
  }

  /**
   * A light that flares and decays: intensity = peak * exp(-age * decay) * min(1, age * 30 + 0.2) for `life` seconds.
   * Explosions and flashes use separate ring pools, so a burst of muzzle flashes never steals an explosion's light.
   */
  pulse(
    now: number,
    at: Vector3,
    colour: readonly [number, number, number],
    radius: number,
    peak: number,
    life: number,
    decay: number,
    pool: PulsePool,
  ): void {
    const list = this.pulses[pool];
    const entry: Pulse = { born: now, x: at.x, z: at.z, colour: [...colour], radius, peak, life, decay };
    if (list.length < POOLS[pool]) list.push(entry);
    else {
      list[this.cursor[pool]] = entry;
      this.cursor[pool] = (this.cursor[pool] + 1) % POOLS[pool];
    }
  }

  /** A light kept alive by repeated calls (fires): it fades in, flickers and goes out `ttl` seconds after the last. */
  keep(
    key: string,
    now: number,
    at: Vector3,
    colour: readonly [number, number, number],
    radius: number,
    peak: number,
    flicker: number,
    ttl: number,
  ): void {
    const existing = this.kept.get(key);
    if (existing) {
      existing.x = at.x;
      existing.z = at.z;
      existing.seen = now;
      existing.peak = peak;
      existing.radius = radius;
      return;
    }
    if (this.kept.size >= KEPT) return;
    this.kept.set(key, {
      key,
      x: at.x,
      z: at.z,
      colour: [...colour],
      radius,
      peak,
      flicker,
      seed: (hashString(key) % 1000) / 1000,
      born: now,
      seen: now,
      ttl,
    });
  }

  /** Refresh a steady source; CPU flicker is shared by the field and its visible glow. */
  source(key: string, now: number, spec: SourceSpec): void {
    const existing = this.sources.get(key);
    if (!existing && this.sources.size >= SOURCES) return;
    this.sources.set(key, {
      key,
      x: spec.x,
      z: spec.z,
      colour: [...spec.colour],
      radius: spec.radius,
      peak: spec.peak ?? 1,
      flicker: spec.flicker ?? 0,
      seed: spec.seed ?? (hashString(key) % 1000) / 1000,
      born: existing?.born ?? now,
      seen: now,
      ttl: spec.ttl ?? 0.6,
      spec,
    });
  }

  /** Immediately remove sources when their owning presentation is disabled. */
  clearSources(): void {
    if (this.sources.size) this.dirty = true;
    this.sources.clear();
  }

  private static sourceIntensity(source: Source, now: number): number {
    return source.peak * Math.max(0, LightField.keptFade(source, now)) * flicker(source.seed, now, source.flicker);
  }

  /** Current intensity of a pulse (0 when over). */
  static pulseIntensity(p: Pulse, now: number): number {
    const age = now - p.born;
    if (age < 0 || age > p.life) return 0;
    return p.peak * Math.exp(-age * p.decay) * Math.min(1, age * 30 + 0.2);
  }

  /**
   * Re-render the field when needed. `staticGain` scales static lights and, unless it is always on, the base grid (0 by
   * day).
   */
  update(now: number, renderer: WebGPURenderer, staticGain: number): boolean {
    this.staticGain = staticGain;
    this.staticGainNode.value = staticGain;
    const baseGain = this.baseStrength * (this.baseFollowsNight ? staticGain : 1);
    this.baseGain.value = baseGain / this.encodeScale;
    if (this.staticDirty) {
      this.staticDirty = false;
      const list = this.staticList;
      for (let i = 0; i < list.length; i++) {
        const l = list[i]!;
        this.writeLight(this.statics, i, l.x, l.z, l.radius, l.shape, l.colour, 1, l.flicker ?? 0, l.seed ?? 0);
      }
      this.commit(this.statics, list.length);
    }
    this.statics.mesh.visible = staticGain > 0 && this.staticList.length > 0;
    // Every pool fits its reserved share of DYNAMIC, so writes never overflow.
    const dyn = this.dynamics;
    let n = 0;
    for (const p of this.pulses.explosion) {
      const k = LightField.pulseIntensity(p, now);
      if (k <= 0) continue;
      this.writeLight(dyn, n++, p.x, p.z, p.radius, SHAPE_POOL, p.colour, k, 0, 0);
    }
    for (const p of this.pulses.flash) {
      const k = LightField.pulseIntensity(p, now);
      if (k <= 0) continue;
      this.writeLight(dyn, n++, p.x, p.z, p.radius, SHAPE_POOL, p.colour, k, 0, 0);
    }
    for (const f of this.kept.values()) {
      if (now - f.seen > f.ttl) {
        this.kept.delete(f.key);
        continue;
      }
      const k = f.peak * LightField.keptFade(f, now);
      this.writeLight(dyn, n++, f.x, f.z, f.radius, SHAPE_POOL, f.colour, k, f.flicker, f.seed);
    }
    for (const source of this.sources.values()) {
      if (now - source.seen > source.ttl) {
        this.sources.delete(source.key);
        continue;
      }
      this.writeLight(
        dyn,
        n++,
        source.x,
        source.z,
        source.radius,
        SHAPE_POOL,
        source.colour,
        LightField.sourceIntensity(source, now),
        0,
        source.seed,
        source.spec.hole,
        source.spec.holeOffset,
      );
    }
    const needs =
      this.dirty ||
      n > 0 ||
      this.lastDynamic > 0 ||
      staticGain !== this.lastGain ||
      baseGain !== this.lastBase ||
      (this.staticFlicker && staticGain > 0);
    this.lastDynamic = n;
    if (!needs) return false;
    this.dirty = false;
    this.lastGain = staticGain;
    this.lastBase = baseGain;
    if (n > 0) this.commit(dyn, n);
    dyn.mesh.count = n;
    dyn.mesh.visible = n > 0;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    this.renders++;
    return true;
  }

  /** A kept light fades in over 0.25 s and out over the second half of its ttl after the last keep(). */
  private static keptFade(f: Kept, now: number): number {
    return Math.min(1, (now - f.born) / 0.25) * Math.min(1, (f.ttl - (now - f.seen)) / (f.ttl * 0.5));
  }

  /** Active light counts (for tests and stats). */
  stats(now: number): {
    static: number;
    explosion: number;
    flash: number;
    kept: number;
    sources: number;
    staticGain: number;
  } {
    const active = (pool: PulsePool) => this.pulses[pool].filter((p) => LightField.pulseIntensity(p, now) > 0).length;
    return {
      static: this.staticList.length,
      explosion: active('explosion'),
      flash: active('flash'),
      kept: this.kept.size,
      sources: [...this.sources.values()].filter((s) => now - s.seen <= s.ttl).length,
      staticGain: this.staticGain,
    };
  }

  /** Strongest active pulse intensity in a pool (tests: flashes must not steal explosion lights). */
  peakIntensity(pool: PulsePool, now: number): number {
    return this.pulses[pool].reduce((m, p) => Math.max(m, LightField.pulseIntensity(p, now)), 0);
  }

  /**
   * Active explosion, fire and source lights for mirroring into other layers (reflection streaks, glows), written into `out`
   * whose entries are reused from call to call (no allocation per frame once warm).
   */
  dynamicLights(now: number, out: DynamicLight[]): DynamicLight[] {
    let n = 0;
    let pool = this.mirrored.get(out);
    if (!pool) {
      pool = [];
      this.mirrored.set(out, pool);
    }
    for (const p of this.pulses.explosion) {
      const k = LightField.pulseIntensity(p, now);
      if (k > 0) out[n] = writeDynamicLight(pool, n++, p.x, p.z, p.colour, k, 'pulse');
    }
    for (const f of this.kept.values()) {
      if (now - f.seen > f.ttl) continue;
      out[n] = writeDynamicLight(pool, n++, f.x, f.z, f.colour, f.peak * Math.min(1, (now - f.born) / 0.25), 'fire');
    }
    for (const source of this.sources.values()) {
      if (now - source.seen > source.ttl) continue;
      const k = LightField.sourceIntensity(source, now);
      const entry = writeDynamicLight(pool, n, source.x, source.z, source.colour, k, 'source');
      entry.head = source.spec.head;
      entry.glowSize = source.spec.glowSize;
      entry.push = source.spec.push;
      const glow = (entry.glow ??= [0, 0, 0]);
      for (let c = 0; c < 3; c++) glow[c] = (source.spec.glow?.[c] ?? 0) * k;
      out[n++] = entry;
    }
    out.length = n;
    return out;
  }

  dispose(): void {
    this.target.dispose();
    this.baseTexture.dispose();
    this.scene.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
        if (object instanceof InstancedMesh) object.dispose();
      }
    });
    this.scene.clear();
    this.kept.clear();
    this.sources.clear();
    this.pulses.explosion.length = 0;
    this.pulses.flash.length = 0;
  }
}

function additiveMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.side = DoubleSide;
  return material;
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function writeDynamicLight(
  pool: DynamicLight[],
  index: number,
  x: number,
  z: number,
  colour: readonly number[],
  k: number,
  kind: DynamicLight['kind'],
): DynamicLight {
  const entry = (pool[index] ??= { x: 0, z: 0, colour: [0, 0, 0], kind });
  entry.x = x;
  entry.z = z;
  entry.colour[0] = colour[0]! * k;
  entry.colour[1] = colour[1]! * k;
  entry.colour[2] = colour[2]! * k;
  entry.kind = kind;
  if (kind !== 'source') {
    entry.head = undefined;
    entry.glow = undefined;
    entry.glowSize = undefined;
    entry.push = undefined;
  }
  return entry;
}
