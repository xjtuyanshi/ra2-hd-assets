import {
  DoubleSide,
  MeshBasicNodeMaterial,
  NormalBlending,
  Object3D,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  dot,
  float,
  fwidth,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  mx_noise_float,
  positionGeometry,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DirtyAttribute } from './dirtyAttribute';
import { InstancedQuad } from './instancedQuad';
import type { ShaderNode } from './tsl';

export type OverlayRgb = readonly [number, number, number];
export type OverlayPoint = Readonly<{ x: number; y: number; z: number }>;

/** Disc-local radius units, with screen x right and y down; angles follow that same y-down frame. */
export interface OrbOccluder {
  corner: readonly [number, number];
  /** Edge angles in degrees, with to > from and a span below 180 degrees. */
  from: number;
  to: number;
}

/** All colours are display-linear, independent of the scene's exposure and grade. */
export interface PlasmaOrb {
  radius: number;
  hot: OverlayRgb;
  mid: OverlayRgb;
  body: OverlayRgb;
  limb: OverlayRgb;
  filaments: OverlayRgb;
  halo: OverlayRgb;
  coreRadius: number;
  bodyStart: number;
  bodyEnd: number;
  alpha: number;
  coreAlpha: number;
  bodyAlpha: number;
  limbAlpha: number;
  filamentMix: number;
  haloAlpha: number;
  haloScale: number;
  /** At most two wedges are uploaded; additional entries are ignored. */
  occluders?: readonly OrbOccluder[];
}
export interface EmissiveDisc {
  centre: OverlayPoint;
  orb: PlasmaOrb;
  push: number;
  seed: number;
  alpha: number;
  brightness: number;
}
export interface EmissiveStroke {
  points: readonly OverlayPoint[];
  /** One engine pixel occupies one CSS pixel at the original sprite scale. */
  width: number;
  core: OverlayRgb;
  edge: OverlayRgb;
  alpha: number;
  /** Fraction of the half-width occupied by the core (default 0.25); zero keeps only the edge colour. */
  coreFraction?: number;
  push?: number;
}

/** Convert engine-pixel width using the same world-to-original-pixel scale as the owner's sprites. */
export function strokeWorldWidth(enginePixels: number, pixelsPerWorldUnit: number): number {
  return enginePixels / pixelsPerWorldUnit;
}

/** Signed unit-normal distances to the two wedge edges; nonnegative on both means occluded. */
export function orbOccluderDistances(x: number, y: number, occluder: OrbOccluder): readonly [number, number] {
  const dx = x - occluder.corner[0];
  const dy = y - occluder.corner[1];
  const from = (occluder.from * Math.PI) / 180;
  const to = (occluder.to * Math.PI) / 180;
  return [Math.cos(from) * dy - Math.sin(from) * dx, Math.sin(to) * dx - Math.cos(to) * dy];
}

/** CPU twin of the shader's wedge test, also used to keep procedural filaments off the painted occluder. */
export function orbOccluded(x: number, y: number, occluder?: OrbOccluder): boolean {
  if (!occluder || !(occluder.to > occluder.from)) return false;
  return orbOccluderDistances(x, y, occluder).every((distance) => distance >= 0);
}

/** A disabled halo must not enlarge either the quad or the depth clearance. */
export function orbSilhouetteScale(orb: Pick<PlasmaOrb, 'haloAlpha' | 'haloScale'>): number {
  return orb.haloAlpha > 0 && orb.haloScale > 1 ? orb.haloScale : 1;
}

/** CPU twin of the radial shader alpha, with derivatives supplied by asset-free tests in radius units. */
export function orbRadialAlpha(
  d: number,
  sphereAlpha: number,
  haloAlpha: number,
  haloScale: number,
  radialFwidth: number,
): number {
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const outside = smooth(1 - Math.max(radialFwidth, 1e-6), 1, d);
  const halo = haloAlpha > 0 && haloScale > 1 ? haloAlpha * (1 - smooth(1, Math.max(haloScale, 1.000001), d)) : 0;
  return sphereAlpha * (1 - outside) + halo * outside;
}

/** r186 can blend MRT attachments independently on WebGPU or WebGL2 with indexed draw-buffer blending. */
export function emissiveMrtSupported(renderer: WebGPURenderer): boolean {
  const backend = renderer.backend as { isWebGPUBackend?: boolean; drawBuffersIndexedExt?: unknown };
  // WebGL2 guarantees at least four colour attachments; this pipeline needs at most four, including self-lit art.
  return backend.isWebGPUBackend === true || !!backend.drawBuffersIndexedExt;
}

function batch(capacity: number, vectors: number) {
  const data = new DirtyAttribute(new Float32Array(capacity * vectors * 4), vectors * 4);
  const shared = data.interleaved();
  const nodes = Array.from(
    { length: vectors },
    (_, i) => instancedBufferAttribute(shared, 'vec4', vectors * 4, i * 4) as ShaderNode,
  );
  return { data, nodes };
}
function write4(data: DirtyAttribute, index: number, vector: number, x: number, y: number, z: number, w: number): void {
  const offset = vector * 4;
  data.setComponent(index, offset, x);
  data.setComponent(index, offset + 1, y);
  data.setComponent(index, offset + 2, z);
  data.setComponent(index, offset + 3, w);
}
function flush(data: DirtyAttribute, range: { start: number; count: number }): void {
  // GPU uploads clear updateRanges. Reuse a prefix range so even continuously animated alpha/brightness uploads
  // do not allocate new range records once warm; DirtyAttribute merges pending writes into this same record.
  if (data.updateRanges.length === 0) {
    range.start = range.count = 0;
    data.updateRanges.push(range);
  }
  data.flush();
}
function material(rgb: ShaderNode, alpha: ShaderNode): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthTest = true;
  m.depthWrite = false;
  m.side = DoubleSide;
  m.blending = NormalBlending;
  m.colorNode = vec4(0, 0, 0, alpha);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, alpha), emissive: vec4(rgb, alpha) });
  return m;
}

/** Fixed-capacity alpha-over primitives; setters reuse their buffers after construction. */
export class EmissiveOverlay {
  readonly root = new Object3D();
  readonly cameraRight = uniform(new Vector3(1, 0, 0));
  readonly cameraUp = uniform(new Vector3(0, 1, 0));
  readonly toCamera = uniform(new Vector3(0, 0, 1));
  readonly now = uniform(0);
  readonly discs: InstancedQuad;
  readonly strokes: InstancedQuad;
  private readonly discData: DirtyAttribute;
  private readonly strokeData: DirtyAttribute;
  private readonly discRange = { start: 0, count: 0 };
  private readonly strokeRange = { start: 0, count: 0 };
  private enabled = false;
  private readonly renderVisibility: boolean[] = [];

  constructor(
    readonly pixelsPerWorldUnit: number,
    readonly discCapacity = 256,
    readonly segmentCapacity = 16384,
  ) {
    this.root.name = 'unbloomed-emissive';
    this.root.visible = false;
    // Eleven interleaved vec4s plus the quad's position/UV consume thirteen of WebGPU's sixteen attributes.
    const discs = batch(discCapacity, 11);
    this.discData = discs.data;
    const [p, extra, hot, body, limb, filaments, halo, mid, opacity, occluder0, occluder1] = discs.nodes;
    const xy: ShaderNode = uv().sub(0.5).mul(2).mul(extra!.z);
    const d = length(xy);
    const turbulence = mx_noise_float(vec3(xy.mul(7), this.now.mul(0.9).add(extra!.y.mul(17))));
    // Saturated cyan between the white-hot core and blue body avoids a desaturated blue/lavender veil.
    const streak = smoothstep(0.88, 0.98, xy.x.mul(19).add(xy.y.mul(9)).add(turbulence.mul(4)).sin())
      .mul(smoothstep(0.15, 0.55, turbulence))
      .mul(smoothstep(0.3, 0.45, d))
      .mul(float(1).sub(smoothstep(0.85, 1, d)));
    const sphere = mix(
      mix(mix(hot!.rgb, mid!.rgb, smoothstep(hot!.w.mul(0.5), hot!.w, d)), body!.rgb, smoothstep(hot!.w, limb!.w, d)),
      limb!.rgb,
      smoothstep(filaments!.w, 1, d),
    );
    const rgb = mix(sphere, filaments!.rgb, streak.mul(mid!.w));
    // Keep the core nearly opaque, reveal the painted glass through the body, then strengthen the glassy limb.
    const sphereAlpha = mix(
      mix(opacity!.x, opacity!.y, smoothstep(hot!.w, limb!.w, d)),
      opacity!.z,
      smoothstep(limb!.w, 1, d),
    ).mul(body!.w);
    // Feather inward by one device pixel so a halo-free silhouette has exactly zero alpha beyond its radius.
    const outside = smoothstep(float(1).sub(fwidth(d).max(1e-6)), 1, d);
    const hasHalo = extra!.z.greaterThan(1);
    // Even a select's unused branch must be defined: smoothstep(1, 1, d) is undefined on GPU backends.
    const haloAlpha = hasHalo.select(halo!.w.mul(float(1).sub(smoothstep(1, extra!.z.max(1.000001), d))), float(0));
    const screenXY = vec2(xy.x, xy.y.negate());
    let orbVisible: ShaderNode = float(1);
    for (const occluder of [occluder0!, occluder1!]) {
      const delta = screenXY.sub(occluder.xy);
      const fromDistance = dot(delta, vec2(occluder.z.sin().negate(), occluder.z.cos()));
      const toDistance = dot(delta, vec2(occluder.w.sin(), occluder.w.cos().negate()));
      // The wedge is the intersection of two half-planes. Feather on the visible side, keeping its interior empty.
      const removed = smoothstep(fwidth(fromDistance).max(1e-6).negate(), 0, fromDistance).mul(
        smoothstep(fwidth(toDistance).max(1e-6).negate(), 0, toDistance),
      );
      orbVisible = orbVisible.mul(occluder.w.greaterThan(occluder.z).select(float(1).sub(removed), float(1)));
    }
    const alpha = mix(sphereAlpha, haloAlpha, outside).mul(orbVisible);
    const discMaterial = material(mix(rgb, halo!.rgb, hasHalo.select(outside, float(0))).mul(extra!.w), alpha);
    discMaterial.positionNode = p!.xyz
      .add(this.toCamera.mul(extra!.x))
      .add(this.cameraRight.mul(positionGeometry.x.mul(p!.w).mul(extra!.z).mul(2)))
      .add(this.cameraUp.mul(positionGeometry.y.mul(p!.w).mul(extra!.z).mul(2)));
    this.discs = new InstancedQuad(discMaterial, discCapacity);
    this.discs.count = 0;
    this.discs.renderOrder = 9;

    const strokes = batch(segmentCapacity, 4);
    this.strokeData = strokes.data;
    const [a, b, core, edge] = strokes.nodes;
    const width = a!.w;
    const delta = b!.xyz.sub(a!.xyz);
    const projected = this.cameraRight
      .mul(dot(delta, this.cameraRight))
      .add(this.cameraUp.mul(dot(delta, this.cameraUp)));
    const projectedSpan = length(projected);
    const span = projectedSpan.max(1e-6);
    // View-aligned segments must contribute no alpha: stacked glow dots painted a dark-blue eye over the hot core.
    const visible = projectedSpan.greaterThanEqual(width.mul(0.05));
    const axis = visible.select(projected.div(span), this.cameraRight);
    const side = this.cameraRight
      .mul(dot(axis, this.cameraUp).negate())
      .add(this.cameraUp.mul(dot(axis, this.cameraRight)));
    const along = uv().x.mul(span.add(width)).sub(width.mul(0.5));
    const cap = max(along.negate(), along.sub(span)).max(0).div(width.mul(0.5));
    const r = length(vec2(cap, uv().y.sub(0.5).mul(2)));
    // fwidth supplies a one-device-pixel edge at any zoom/DPR; capsules overlap at every polyline joint.
    const cover = float(1).sub(smoothstep(float(1).sub(fwidth(r)), 1, r));
    // Preserve the legacy 0.18/0.3 ramp at coreFraction 0.25; glow strokes use zero for a pure saturated edge.
    // The core follows the distance ACROSS the stroke, not the capsule radius: with a radial core every segment's
    // round start cap painted edge blue over the previous segment's core end, which broke each bolt into dashes.
    const across = uv().y.sub(0.5).mul(2).abs();
    const coreMix = edge!.w
      .greaterThan(0)
      .select(float(1).sub(smoothstep(edge!.w.mul(0.72), edge!.w.mul(1.2).max(1e-6), across)), float(0));
    const strokeMaterial = material(
      mix(edge!.rgb, core!.rgb, coreMix),
      cover
        .mul(core!.w)
        .mul(mix(float(1), float(0.7), smoothstep(0.3, 1, r)))
        .mul(visible.select(float(1), float(0))),
    );
    strokeMaterial.positionNode = Fn(() => {
      const distance = positionGeometry.x.add(0.5).mul(span.add(width)).sub(width.mul(0.5));
      const t = distance.div(span).clamp(0, 1);
      return mix(a!.xyz, b!.xyz, t)
        .add(axis.mul(distance.sub(t.mul(span))))
        .add(side.mul(positionGeometry.y.mul(width)))
        .add(this.toCamera.mul(b!.w));
    })();
    this.strokes = new InstancedQuad(strokeMaterial, segmentCapacity);
    this.strokes.count = 0;
    this.strokes.renderOrder = 10;
    this.root.add(this.discs, this.strokes);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
  }

  /** Called by the owning scene before its render list is built, including nested reflection renders. */
  beginRender(renderer: WebGPURenderer): void {
    this.renderVisibility.push(this.root.visible);
    // three r186 ReflectorNode clones the camera (including layers) and calls setMRT(null) before rendering.
    // Camera layers alone cannot exclude us. Renderer.js invokes scene.onBeforeRender before _projectObject:
    // checking the actual attachment here removes both meshes from mirror/fallback render lists, so black output
    // never punches holes. The stack restores main-pass visibility after nested mirrors, whose lists are independent.
    let attached = false;
    if (this.enabled && renderer.getMRT()?.has('emissive')) {
      const textures = renderer.getRenderTarget()?.textures;
      if (textures)
        for (let i = 0; i < textures.length; i++) {
          if (textures[i]!.name === 'emissive') {
            attached = true;
            break;
          }
        }
    }
    this.root.visible = attached;
  }
  endRender(): void {
    this.root.visible = this.renderVisibility.pop() ?? this.enabled;
  }

  setDiscs(list: readonly EmissiveDisc[]): void {
    const n = Math.min(list.length, this.discCapacity);
    for (let i = 0; i < n; i++) {
      const d = list[i]!;
      const o = d.orb;
      write4(this.discData, i, 0, d.centre.x, d.centre.y, d.centre.z, o.radius);
      write4(this.discData, i, 1, d.push, d.seed, orbSilhouetteScale(o), d.brightness);
      write4(this.discData, i, 2, o.hot[0], o.hot[1], o.hot[2], o.coreRadius);
      write4(this.discData, i, 3, o.body[0], o.body[1], o.body[2], o.alpha * d.alpha);
      write4(this.discData, i, 4, o.limb[0], o.limb[1], o.limb[2], o.bodyStart);
      write4(this.discData, i, 5, o.filaments[0], o.filaments[1], o.filaments[2], o.bodyEnd);
      write4(this.discData, i, 6, o.halo[0], o.halo[1], o.halo[2], o.haloAlpha * d.alpha);
      write4(this.discData, i, 7, o.mid[0], o.mid[1], o.mid[2], o.filamentMix);
      write4(this.discData, i, 8, o.coreAlpha, o.bodyAlpha, o.limbAlpha, 0);
      for (let j = 0; j < 2; j++) {
        const wedge = o.occluders?.[j];
        // Equal angles disable the slot, including when a reused instance loses its previous occluder.
        write4(
          this.discData,
          i,
          9 + j,
          wedge?.corner[0] ?? 0,
          wedge?.corner[1] ?? 0,
          ((wedge?.from ?? 0) * Math.PI) / 180,
          ((wedge?.to ?? 0) * Math.PI) / 180,
        );
      }
    }
    flush(this.discData, this.discRange);
    this.discs.count = n;
  }
  setStrokes(list: readonly EmissiveStroke[]): void {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (let j = 1; j < s.points.length && n < this.segmentCapacity; j++) {
        const a = s.points[j - 1]!;
        const b = s.points[j]!;
        write4(this.strokeData, n, 0, a.x, a.y, a.z, strokeWorldWidth(s.width, this.pixelsPerWorldUnit));
        write4(this.strokeData, n, 1, b.x, b.y, b.z, s.push ?? 0);
        write4(this.strokeData, n, 2, s.core[0], s.core[1], s.core[2], s.alpha);
        write4(this.strokeData, n, 3, s.edge[0], s.edge[1], s.edge[2], s.coreFraction ?? 0.25);
        n++;
      }
      if (n === this.segmentCapacity) break;
    }
    flush(this.strokeData, this.strokeRange);
    this.strokes.count = n;
  }
  dispose(): void {
    for (const mesh of [this.discs, this.strokes]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.root.clear();
    this.root.removeFromParent();
  }
}
