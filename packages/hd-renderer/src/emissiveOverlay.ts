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

/** All colours are display-linear, independent of the scene's exposure and grade. */
export interface PlasmaOrb {
  radius: number;
  hot: OverlayRgb;
  body: OverlayRgb;
  limb: OverlayRgb;
  filaments: OverlayRgb;
  halo: OverlayRgb;
  coreRadius: number;
  bodyStart: number;
  bodyEnd: number;
  alpha: number;
  haloAlpha: number;
  haloScale: number;
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
  push?: number;
}

/** Convert engine-pixel width using the same world-to-original-pixel scale as the owner's sprites. */
export function strokeWorldWidth(enginePixels: number, pixelsPerWorldUnit: number): number {
  return enginePixels / pixelsPerWorldUnit;
}

/** r186 can blend MRT attachments independently on WebGPU or WebGL2 with indexed draw-buffer blending. */
export function emissiveMrtSupported(renderer: WebGPURenderer): boolean {
  const backend = renderer.backend as { isWebGPUBackend?: boolean; drawBuffersIndexedExt?: unknown };
  // WebGL2 guarantees at least four colour attachments; this pipeline needs at most three.
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
    const discs = batch(discCapacity, 7);
    this.discData = discs.data;
    const [p, extra, hot, body, limb, filaments, halo] = discs.nodes;
    const xy: ShaderNode = uv().sub(0.5).mul(2).mul(extra!.z);
    const d = length(xy);
    const turbulence = mx_noise_float(vec3(xy.mul(7), this.now.mul(0.9).add(extra!.y.mul(17))));
    // Sparse moving filaments preserve the saturated body; a hot centre covering the whole sphere caused a veil.
    const streak = smoothstep(0.88, 0.98, xy.x.mul(19).add(xy.y.mul(9)).add(turbulence.mul(4)).sin())
      .mul(smoothstep(0.15, 0.55, turbulence))
      .mul(smoothstep(0.3, 0.45, d))
      .mul(float(1).sub(smoothstep(0.85, 1, d)));
    const sphere = mix(
      mix(hot!.rgb, body!.rgb, smoothstep(hot!.w, limb!.w, d)),
      limb!.rgb,
      smoothstep(filaments!.w, 1, d),
    );
    const rgb = mix(sphere, filaments!.rgb, streak.mul(0.65));
    const outside = smoothstep(0.99, 1.01, d);
    const alpha = mix(body!.w, halo!.w.mul(float(1).sub(smoothstep(1, extra!.z, d))), outside).mul(
      d.lessThan(extra!.z).select(float(1), float(0)),
    );
    const discMaterial = material(mix(rgb, halo!.rgb, outside).mul(extra!.w), alpha);
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
    const span = length(projected).max(1e-6);
    const axis = projected.div(span);
    const side = this.cameraRight
      .mul(dot(axis, this.cameraUp).negate())
      .add(this.cameraUp.mul(dot(axis, this.cameraRight)));
    const along = uv().x.mul(span.add(width)).sub(width.mul(0.5));
    const cap = max(along.negate(), along.sub(span)).max(0).div(width.mul(0.5));
    const r = length(vec2(cap, uv().y.sub(0.5).mul(2)));
    // fwidth supplies a one-device-pixel edge at any zoom/DPR; capsules overlap at every polyline joint.
    const cover = float(1).sub(smoothstep(float(1).sub(fwidth(r)), 1, r));
    const strokeMaterial = material(
      mix(edge!.rgb, core!.rgb, float(1).sub(smoothstep(0.3, 0.4, r))),
      cover.mul(core!.w),
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
      write4(this.discData, i, 1, d.push, d.seed, o.haloScale, d.brightness);
      write4(this.discData, i, 2, o.hot[0], o.hot[1], o.hot[2], o.coreRadius);
      write4(this.discData, i, 3, o.body[0], o.body[1], o.body[2], o.alpha * d.alpha);
      write4(this.discData, i, 4, o.limb[0], o.limb[1], o.limb[2], o.bodyStart);
      write4(this.discData, i, 5, o.filaments[0], o.filaments[1], o.filaments[2], o.bodyEnd);
      write4(this.discData, i, 6, o.halo[0], o.halo[1], o.halo[2], o.haloAlpha * d.alpha);
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
        write4(this.strokeData, n, 3, s.edge[0], s.edge[1], s.edge[2], 0);
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
