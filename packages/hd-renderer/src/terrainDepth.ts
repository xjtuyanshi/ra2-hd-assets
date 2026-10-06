import {
  Color,
  DepthTexture,
  FloatType,
  HalfFloatType,
  MeshBasicNodeMaterial,
  MRTNode,
  OrthographicCamera,
  QuadMesh,
  RGFormat,
  RenderTarget,
  Vector2,
  Vector3,
  type Mesh,
  type NodeBuilder,
  type Renderer,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  cameraFar,
  cameraNear,
  float,
  ivec2,
  max,
  min,
  outputStruct,
  property,
  diffuseColor,
  screenCoordinate,
  textureLoad,
  uniform,
  varying,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from './tsl';
import {
  ALWAYS_COVER_CODE,
  EMPTY_DEPTH,
  NOT_CAPTURED_CODE,
  OBJECT_CODE_TOLERANCE,
  OBJECT_DEPTH_CAP,
  OBJECT_DEPTH_EPSILON,
} from './objectDepth';

/** Only explicitly selected main meshes join this capture; ordinary cameras retain layer zero. */
export const TERRAIN_DEPTH_LAYER = 31;
function supported(renderer: Renderer): boolean {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
}

/**
 * r186 MRTNode.setup converts RG targets to vec2, dropping the fragment alpha used by NormalBlending. WebGPU
 * permits a vec4 shader output for rg16float: only R/G are stored, but A still supplies the blend factor. Keep
 * this capture-only output struct at vec4; do not modify materials, texture formats or renderer-wide builders.
 */
class CaptureMRT extends MRTNode {
  override merge(): this {
    // This pass captures object codes and coverage, never a material's colour/emission outputs. The base merge
    // would replace that contract and construct a plain MRTNode, also losing the vec4 blend-alpha guarantee below.
    return this;
  }

  override setup(): undefined {
    this.members = [this.get('output')];
    return undefined;
  }
}

/** Renderer-owned capture/reduction mechanism. The caller supplies the anchor distance policy and membership. */
export class TerrainDepth {
  readonly target = new RenderTarget(1, 1, {
    samples: 0,
    stencilBuffer: false,
    format: RGFormat,
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  readonly reductionTarget = new RenderTarget(1, 1, {
    count: 2,
    samples: 0,
    depthBuffer: false,
    stencilBuffer: false,
    type: HalfFloatType,
  });
  readonly camera = new OrthographicCamera();
  readonly reference = uniform(new Vector3());
  readonly horizontal = uniform(new Vector2());
  readonly depthReference = uniform(150);
  private readonly extent = uniform(new Vector2(1, 1));
  /** Recomputed after nested reflector renders, for the actual object/target/camera. */
  readonly captureEnabled = uniform(0)
    .setName('objectDepthCaptureEnabled')
    .onObjectUpdate(({ renderer, camera }) => (renderer && this.isCapturePass(renderer, camera) ? 1 : 0));
  readonly objectCode = uniform(ALWAYS_COVER_CODE)
    .setName('objectDepthAnchorCode')
    .onObjectUpdate(({ object }) => object?.userData.objectDepthAnchorCode ?? ALWAYS_COVER_CODE);
  readonly enabled = uniform(0)
    .setName('terrainDepthPullEnabled')
    .onObjectUpdate(({ renderer, camera }) => (renderer && this.isMainPass(renderer, camera) ? 1 : 0));
  readonly captureMRT = new CaptureMRT({
    output: Fn(([], builder: NodeBuilder) => {
      const code: ShaderNode = builder.material.userData.objectDepthCodeNode ?? this.objectCode;
      // Normal alpha blending multiplies BOTH R and G by the same source factor. Negative codes must bypass the
      // normal colour pipeline's unsigned clamp; this MRT replaces output only in the capture render.
      const a = diffuseColor.a;
      return vec4(code.mul(a), a, 0, a);
    })(),
  });
  readonly reductionMaterial = new MeshBasicNodeMaterial();
  readonly reductionQuad = new QuadMesh(this.reductionMaterial);
  private readonly meshes = new Map<Mesh, { originalLayer: boolean; hadCode: boolean; originalCode: unknown }>();
  private captureActive = false;
  private readonly size = new Vector2();
  private readonly direction = new Vector3();
  private readonly cameraPoint = new Vector3();
  private readonly clearColour = new Color();
  private mainTarget: RenderTarget | null = null;
  private mainCamera: OrthographicCamera | null = null;
  private mainActive = false;
  private ready = false;
  private disposed = false;
  private needed = false;

  constructor(private readonly frontDistance: number) {
    this.target.texture.name = 'output';
    this.target.depthTexture!.name = 'object-surface-depth';
    this.reductionTarget.textures[0]!.name = 'object-depth-a';
    this.reductionTarget.textures[1]!.name = 'object-depth-b';
    this.camera.layers.set(TERRAIN_DEPTH_LAYER);
    this.reductionMaterial.depthTest = this.reductionMaterial.depthWrite = false;
    const recordB = property('vec4');
    const recordA = Fn(() => {
      const nearest = float(EMPTY_DEPTH).toVar();
      const codeA = float(NOT_CAPTURED_CODE).toVar();
      const depths: ShaderNode[] = [];
      const codes: ShaderNode[] = [];
      for (let y = -1; y <= 1; y++)
        for (let x = -1; x <= 1; x++) {
          const coordinate: ShaderNode = ivec2(screenCoordinate).add(ivec2(x, y));
          const pixel = coordinate.clamp(ivec2(0), ivec2(this.extent).sub(1));
          const d = textureLoad(this.target.depthTexture!, pixel).r.toVar();
          const encoded = textureLoad(this.target.texture, pixel).toVar();
          const captured: ShaderNode = d.lessThan(1).and(encoded.g.greaterThan(0));
          const s = captured
            .select(d.mul(this.captureRange).add(this.captureNear).sub(this.depthReference), float(EMPTY_DEPTH))
            .toVar();
          const c = captured.select(encoded.r.div(encoded.g), float(NOT_CAPTURED_CODE)).toVar();
          depths.push(s);
          codes.push(c);
          If(captured, () => {
            If(s.lessThan(nearest), () => {
              nearest.assign(s);
              codeA.assign(c);
            });
          });
        }
      // Keep the centre's object even when a different object's silhouette is nearer in the neighbourhood.
      If(depths[4]!.lessThan(EMPTY_DEPTH), () => codeA.assign(codes[4]!));
      const nearestB = float(EMPTY_DEPTH).toVar();
      const codeB = float(NOT_CAPTURED_CODE).toVar();
      for (let i = 0; i < depths.length; i++)
        If(depths[i]!.lessThan(nearestB).and(abs(codes[i]!.sub(codeA)).greaterThan(OBJECT_CODE_TOLERANCE)), () => {
          nearestB.assign(depths[i]!);
          codeB.assign(codes[i]!);
        });
      const records = [codeA, codeB].map((code) => {
        const lo = float(EMPTY_DEPTH).toVar();
        const hi = float(-EMPTY_DEPTH).toVar();
        const valid = float(0).toVar();
        // Each object's own texels bound its MSAA spread; another object never widens its pull or push.
        for (let i = 0; i < depths.length; i++)
          If(
            depths[i]!.lessThan(EMPTY_DEPTH).and(abs(codes[i]!.sub(code)).lessThanEqual(OBJECT_CODE_TOLERANCE)),
            () => {
              lo.assign(min(lo, depths[i]!));
              hi.assign(max(hi, depths[i]!));
              valid.assign(1);
            },
          );
        return valid.greaterThan(0).select(vec4(lo, hi, code, valid), vec4(0));
      });
      recordB.assign(records[1]!);
      return records[0]!;
    })();
    // Both MRT outputs share the same 18 loads. Assign B while computing A, then emit the second attachment.
    this.reductionMaterial.fragmentNode = outputStruct(recordA, recordB);
  }

  /** Set before membership/uploads, so CPU and shader codes share this frame's reference exactly. */
  setReference(camera: OrthographicCamera, centre: Vector3): void {
    this.reference.value.copy(centre);
    this.direction.setFromMatrixColumn(camera.matrixWorld, 2);
    this.horizontal.value.set(this.direction.x, this.direction.z).normalize();
    this.depthReference.value = -this.cameraPoint.copy(centre).applyMatrix4(camera.matrixWorldInverse).z;
    this.captureNear.value = camera.near;
    this.captureRange.value = camera.far - camera.near;
  }
  private readonly captureNear = uniform(0.1);
  private readonly captureRange = uniform(399.9);
  anchorCode(point: { x: number; z: number }): number {
    return (
      (point.x - this.reference.value.x) * this.horizontal.value.x +
      (point.z - this.reference.value.z) * this.horizontal.value.y
    );
  }
  codeNode(anchor: ShaderNode): ShaderNode {
    return anchor.xz.sub(this.reference.xz).dot(this.horizontal);
  }
  setNeeded(needed: boolean): void {
    this.needed = needed;
    if (!needed) {
      this.ready = false;
      this.enabled.value = 0;
    }
  }
  register(mesh: Mesh): () => void {
    this.setCaptured(mesh, true);
    return () => this.setCaptured(mesh, false);
  }
  /** Register this mesh only. Voxel callers select part meshes, never their shadows/reflections/glow twins. */
  setCaptured(mesh: Mesh, captured: boolean, code = ALWAYS_COVER_CODE): void {
    if (this.disposed) {
      if (captured) throw new Error('Cannot register a depth occluder after disposal');
      return;
    }
    let entry = this.meshes.get(mesh);
    if (!entry && captured) {
      entry = {
        originalLayer: mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER),
        hadCode: Object.hasOwn(mesh.userData, 'objectDepthAnchorCode'),
        originalCode: mesh.userData.objectDepthAnchorCode,
      };
      this.meshes.set(mesh, entry);
    }
    if (!entry) return;
    if (captured) {
      mesh.layers.enable(TERRAIN_DEPTH_LAYER);
      mesh.userData.objectDepthAnchorCode = code;
    } else {
      if (!entry.originalLayer) mesh.layers.disable(TERRAIN_DEPTH_LAYER);
      if (entry.hadCode) mesh.userData.objectDepthAnchorCode = entry.originalCode;
      else delete mesh.userData.objectDepthAnchorCode;
      this.meshes.delete(mesh);
    }
  }
  private isCapturePass(renderer: Renderer, camera: unknown): boolean {
    return (
      this.captureActive &&
      !this.disposed &&
      supported(renderer) &&
      renderer.getRenderTarget() === this.target &&
      camera === this.camera
    );
  }
  setMainPass(target: RenderTarget, camera: OrthographicCamera): void {
    this.mainTarget = target;
    this.mainCamera = camera;
  }
  isMainPass(renderer: Renderer, camera: unknown): boolean {
    return (
      !this.disposed &&
      this.ready &&
      this.mainActive &&
      supported(renderer) &&
      renderer.getRenderTarget() === this.mainTarget &&
      camera === this.mainCamera
    );
  }
  renderMainPass(render: () => void): void {
    this.mainActive = true;
    try {
      render();
    } finally {
      this.mainActive = false;
      this.enabled.value = 0;
    }
  }
  node(base: ShaderNode, anchor: ShaderNode, eligible: ShaderNode = float(1)): ShaderNode {
    return Fn(([], builder: NodeBuilder) => {
      if (!supported(builder.renderer)) return base;
      const result = base.toVar();
      const eligibility: ShaderNode = varying(eligible);
      const fireCode: ShaderNode = varying(this.codeNode(anchor));
      If(this.enabled.greaterThan(0).and(eligibility.greaterThan(0)), () => {
        // Two loads per eligible fire fragment; all nine-neighbour work happens once in the reduction.
        const p = float(EMPTY_DEPTH).toVar();
        const q = float(-EMPTY_DEPTH).toVar();
        // Absent sides are unbounded. Flags avoid substituting finite sentinels for +/-infinity at combination.
        const hasCover = float(0).toVar();
        const hasFront = float(0).toVar();
        for (const texture of this.reductionTarget.textures) {
          const bounds = textureLoad(texture, screenCoordinate).toVar();
          If(bounds.a.greaterThan(0), () => {
            const spread = min(bounds.g.sub(bounds.r), OBJECT_DEPTH_CAP);
            If(bounds.b.sub(fireCode).lessThan(this.frontDistance), () => {
              p.assign(min(p, bounds.r.sub(spread).sub(OBJECT_DEPTH_EPSILON)));
              hasCover.assign(1);
            }).Else(() => {
              q.assign(max(q, bounds.g.add(spread).add(OBJECT_DEPTH_EPSILON)));
              hasFront.assign(1);
            });
          });
        }
        const normalized = (s: ShaderNode) => s.add(this.depthReference).sub(cameraNear).div(cameraFar.sub(cameraNear));
        If(hasFront.greaterThan(0), () => result.assign(max(result, normalized(q))));
        // depth = min(max(base, Q), P). If Q > P, a COVER surface is in front of a FRONT object;
        // that covered surface is the visible front, so cover wins by applying P last.
        If(hasCover.greaterThan(0), () => result.assign(min(result, normalized(p))));
      });
      return result;
    })();
  }
  resize(renderer: WebGPURenderer): void {
    if (this.disposed) return;
    renderer.getDrawingBufferSize(this.size);
    if (this.size.x !== this.target.width || this.size.y !== this.target.height) this.ready = false;
    this.extent.value.copy(this.size);
    this.target.setSize(this.size.x, this.size.y);
    this.reductionTarget.setSize(this.size.x, this.size.y);
  }
  render(renderer: WebGPURenderer, scene: Scene, view: OrthographicCamera): void {
    this.ready = false;
    if (!this.needed || this.disposed || !supported(renderer)) return;
    this.resize(renderer);
    this.captureNear.value = view.near;
    this.captureRange.value = view.far - view.near;
    this.camera.copy(view, false);
    this.camera.layers.set(TERRAIN_DEPTH_LAYER);
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousMRT = renderer.getMRT();
    const previousClearDepth = renderer.getClearDepth();
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColour);
    const previousAutoClear = renderer.autoClear;
    const previousBackground = scene.background;
    const previousBackgroundNode = scene.backgroundNode;
    try {
      scene.background = scene.backgroundNode = null;
      renderer.autoClear = false;
      renderer.setClearDepth(1);
      renderer.setClearColor(0, 0);
      renderer.setRenderTarget(this.target);
      renderer.setMRT(this.captureMRT);
      renderer.clear(true, true, false);
      this.captureActive = true;
      for (const [mesh] of this.meshes) {
        // Nothing to draw: an instanced mesh without instances (the count is the mesh's or its geometry's).
        const instanced = mesh.geometry as { isInstancedBufferGeometry?: boolean; instanceCount?: number };
        if (instanced.isInstancedBufferGeometry ? instanced.instanceCount === 0 : 'count' in mesh && mesh.count === 0)
          continue;
        let object: import('three/webgpu').Object3D | null = mesh;
        while (object?.visible) object = object.parent;
        if (object !== null) continue;
        renderer.render(scene, this.camera);
        break;
      }
      this.captureActive = false;
      this.captureEnabled.value = 0;
      renderer.setRenderTarget(this.reductionTarget);
      renderer.setMRT(null);
      this.reductionQuad.render(renderer);
      this.ready = true;
    } finally {
      this.captureActive = false;
      this.captureEnabled.value = 0;
      scene.background = previousBackground;
      scene.backgroundNode = previousBackgroundNode;
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      renderer.setMRT(previousMRT);
      renderer.setClearDepth(previousClearDepth);
      renderer.setClearColor(this.clearColour, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    for (const [mesh] of this.meshes) this.setCaptured(mesh, false);
    this.disposed = true;
    this.ready = this.mainActive = this.captureActive = false;
    this.captureEnabled.value = this.enabled.value = 0;
    this.mainTarget = this.mainCamera = null;
    this.target.dispose();
    this.target.depthTexture!.dispose();
    this.reductionTarget.dispose();
    this.reductionMaterial.dispose();
  }
}
