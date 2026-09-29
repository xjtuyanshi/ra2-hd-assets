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
  float,
  instancedBufferAttribute,
  length,
  max,
  mx_noise_float,
  positionGeometry,
  positionWorld,
  select,
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
/** Dynamic instances: every pool has its own reserved share, so a burst of flashes never starves fires. */
const DYNAMIC = POOLS.explosion + POOLS.flash + KEPT;

/** Per-instance attributes of one light mesh: aPos = (x, z, radius, shape), aCol = (r, g, b, flicker), aExtra.x = seed. */
interface LightInstances {
  mesh: InstancedMesh;
  aPos: InstancedBufferAttribute;
  aCol: InstancedBufferAttribute;
  aExtra: InstancedBufferAttribute;
  attributes: readonly InstancedBufferAttribute[];
}

/** A dynamic light as mirrored into other layers (reflection streaks, glows). */
export interface DynamicLight {
  x: number;
  z: number;
  colour: [number, number, number];
  kind: 'pulse' | 'fire';
}

/**
 * Whole-map light field: a top-down additive render of every local light into a W*t x H*t texture (t texels per cell,
 * at most 8, and at most 2048 texels a side), read by terrain, sprites, voxels, rain, smoke and mist through
 * atmosphere.ts. Layer 1 is a base grid (one RGB value per cell, linear-filtered: the engine's own per-cell light);
 * layer 2 is instanced round lights in two meshes: static ones (lamps, windows; written once per setStatic, scaled by
 * the night-driven static gain and hidden while it is 0) and dynamic ones (explosion and flash pulses in separate ring
 * pools, kept-alive fires; rewritten while any is alive). The texture is re-rendered only when something changed or a
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
    const aExtra = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    const material = additiveMaterial();
    const p: ShaderNode = instancedBufferAttribute(aPos, 'vec4');
    const c: ShaderNode = instancedBufferAttribute(aCol, 'vec4');
    const seed: ShaderNode = instancedBufferAttribute(aExtra, 'float');
    material.positionNode = vec3(p.xy.add(positionGeometry.xy.mul(p.z.mul(2))), 0);
    material.colorNode = Fn(() => {
      const d = length(uv().sub(0.5).mul(2));
      const linear = max(float(1).sub(d), 0);
      const window = max(float(1).sub(d.mul(d)), 0);
      const pool = window.mul(window).div(float(1).add(d.mul(d).mul(10)));
      const shape = select(p.w.greaterThan(0.5), pool, linear);
      const flicker = float(1).add(c.w.mul(mx_noise_float(vec2(time.mul(9).add(seed.mul(17.3)), seed.mul(3.1)))));
      return vec4(c.rgb.mul(shape).mul(flicker.max(0)).mul(gain).div(this.encodeScale), 1);
    })();
    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, capacity);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return { mesh, aPos, aCol, aExtra, attributes: [aPos, aCol, aExtra] };
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
  ): void {
    target.aPos.setXYZW(i, x, z, radius, shape);
    target.aCol.setXYZW(i, colour[0]! * scale, colour[1]! * scale, colour[2]! * scale, flicker);
    target.aExtra.setX(i, seed);
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
  stats(now: number): { static: number; explosion: number; flash: number; kept: number; staticGain: number } {
    const active = (pool: PulsePool) => this.pulses[pool].filter((p) => LightField.pulseIntensity(p, now) > 0).length;
    return {
      static: this.staticList.length,
      explosion: active('explosion'),
      flash: active('flash'),
      kept: this.kept.size,
      staticGain: this.staticGain,
    };
  }

  /** Strongest active pulse intensity in a pool (tests: flashes must not steal explosion lights). */
  peakIntensity(pool: PulsePool, now: number): number {
    return this.pulses[pool].reduce((m, p) => Math.max(m, LightField.pulseIntensity(p, now)), 0);
  }

  /**
   * Active explosion and fire lights for mirroring into other layers (reflection streaks, glows), written into `out`
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
  return entry;
}
