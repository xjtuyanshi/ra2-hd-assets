import {
  DepthTexture,
  FloatType,
  OrthographicCamera,
  RenderTarget,
  Vector2,
  type Mesh,
  type NodeBuilder,
  type Renderer,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  cameraFar,
  cameraNear,
  float,
  max,
  min,
  screenCoordinate,
  textureLoad,
  uniform,
  varying,
} from 'three/tsl';
import type { ShaderNode } from './tsl';

/** Reserved for explicitly registered COVER main meshes; ordinary scene cameras retain layer 0. */
export const TERRAIN_DEPTH_LAYER = 31;
export const FRONT_DEPTH_LAYER = 30;
export const DepthClass = { NONE: 0, COVER: 1, FRONT: 2 } as const;
export type DepthCaptureClass = (typeof DepthClass)[keyof typeof DepthClass];
/**
 * Camera-space world units. At the orthographic 0.1..400 range this is 2.500625e-6 normalized depth,
 * over 41 D24 steps and 20 float32 ULPs even at depth 1. Both captures use depth32float; the scene uses depth24plus.
 * This clears depth-format rounding while remaining far below the sphere's 0.03205 foreground-unit margin.
 */
export const TERRAIN_DEPTH_EPSILON = 0.001;

function supported(renderer: Renderer): boolean {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
}

/** Pure twin of the two-class combination; empty texels leave the fallback exactly unchanged. */
export function objectDepthCombine(base: number, cover: number, front: number, near: number, far: number): number {
  const eps = TERRAIN_DEPTH_EPSILON / (far - near);
  if (cover < front && cover < 1) return Math.min(base, cover - eps);
  if (front < 1) return Math.max(base, front + eps);
  return base;
}

/** Round-one terrain-only twin, retained for its independent regression evidence. */
export function terrainDepthPull(base: number, terrain: number, near: number, far: number): number {
  return objectDepthCombine(base, terrain, 1, near, far);
}

/** Generic, renderer-owned two-class depth capture and fragment combination; callers choose the occluder policy. */
export class TerrainDepth {
  readonly target = new RenderTarget(1, 1, {
    samples: 0,
    stencilBuffer: false,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  readonly frontTarget = new RenderTarget(1, 1, {
    samples: 0,
    stencilBuffer: false,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  readonly camera = new OrthographicCamera();
  readonly frontCamera = new OrthographicCamera();
  readonly frontDepth = textureLoad(this.frontTarget.depthTexture!, screenCoordinate).r;
  /** Object-group gate: capture class is zero in main/mirror/other renders, even during nested renders. */
  readonly captureClass = uniform(0)
    .setName('objectDepthCaptureClass')
    .onObjectUpdate(({ renderer, camera }) => (renderer ? this.capturePass(renderer, camera) : 0));
  readonly depth = textureLoad(this.target.depthTexture!, screenCoordinate).r;
  readonly enabled = uniform(0)
    .setName('terrainDepthPullEnabled')
    .onObjectUpdate(({ renderer, camera }) => (renderer && this.isMainPass(renderer, camera) ? 1 : 0));
  private readonly meshes = new Map<
    Mesh,
    { cover: boolean; front: boolean; originalCover: boolean; originalFront: boolean }
  >();
  private captureActive = false;
  private readonly size = new Vector2();
  private mainTarget: RenderTarget | null = null;
  private mainCamera: OrthographicCamera | null = null;
  private mainActive = false;
  private ready = false;
  private disposed = false;

  constructor() {
    this.target.texture.name = 'terrain-class-depth-colour';
    this.target.depthTexture!.name = 'terrain-class-depth';
    this.camera.layers.set(TERRAIN_DEPTH_LAYER);
    this.frontCamera.layers.set(FRONT_DEPTH_LAYER);
    this.frontTarget.texture.name = 'front-object-depth-colour';
    this.frontTarget.depthTexture!.name = 'front-object-depth';
  }

  register(mesh: Mesh): () => void {
    this.setClasses(mesh, true, false);
    return () => this.setClasses(mesh, false, false);
  }

  /** Register only this mesh, never its children/twins. Mixed instanced batches may participate in both passes. */
  setClasses(mesh: Mesh, cover: boolean, front: boolean): void {
    if (this.disposed) {
      if (cover || front) throw new Error('Cannot register a depth occluder after disposal');
      return;
    }
    let entry = this.meshes.get(mesh);
    if (!entry) {
      if (!cover && !front) return;
      entry = {
        cover,
        front,
        originalCover: mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER),
        originalFront: mesh.layers.isEnabled(FRONT_DEPTH_LAYER),
      };
      this.meshes.set(mesh, entry);
    }
    entry.cover = cover;
    entry.front = front;
    // r186 tests each mesh's layers and still traverses children. Never propagate either layer down the tree.
    // Layer masks must return exactly to their prior state when classification ends.
    if (cover || entry.originalCover) mesh.layers.enable(TERRAIN_DEPTH_LAYER);
    else mesh.layers.disable(TERRAIN_DEPTH_LAYER);
    if (front || entry.originalFront) mesh.layers.enable(FRONT_DEPTH_LAYER);
    else mesh.layers.disable(FRONT_DEPTH_LAYER);
    if (!cover && !front) this.meshes.delete(mesh);
  }

  setClass(mesh: Mesh, classification: DepthCaptureClass): void {
    this.setClasses(mesh, classification === DepthClass.COVER, classification === DepthClass.FRONT);
  }

  private capturePass(renderer: Renderer, camera: unknown): number {
    if (!this.captureActive || this.disposed || !supported(renderer)) return 0;
    const target = renderer.getRenderTarget();
    if (target === this.target && camera === this.camera) return DepthClass.COVER;
    if (target === this.frontTarget && camera === this.frontCamera) return DepthClass.FRONT;
    return 0;
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

  /** Bound the gate to the pipeline call as well as its actual scene target/camera; default off everywhere else. */
  renderMainPass(render: () => void): void {
    this.mainActive = true;
    try {
      render();
    } finally {
      this.mainActive = false;
      this.enabled.value = 0;
    }
  }

  node(cardDepth: ShaderNode, eligible: ShaderNode = float(1)): ShaderNode {
    return Fn(([], builder: NodeBuilder) => {
      // The WebGL2 fallback keeps its existing depth policy, with no extra sampler or capture pass.
      if (!supported(builder.renderer)) return cardDepth;
      const result = cardDepth.toVar();
      // r186 Renderer._renderObjectDirect runs updateBefore (including ReflectorNode's nested render) FIRST,
      // then NodeManager.updateForRender and Bindings.updateForRender. This OBJECT-group uniform is recomputed
      // and uploaded for the actual target/camera on every draw; a mirror gets 0 and the resumed main draw gets 1.
      // A frame/render-group cache or camera layer mask alone would not provide that guarantee.
      const eligibility: ShaderNode = varying(eligible);
      If(this.enabled.greaterThan(0).and(eligibility.greaterThan(0)), () => {
        const cover = this.depth.toVar();
        const front = this.frontDepth.toVar();
        const eps = float(TERRAIN_DEPTH_EPSILON).div(cameraFar.sub(cameraNear));
        // At a pixel the scene depth holds the front-most surface. For a COVER object it equals c; for a FRONT
        // object it equals f. Pulling before c or pushing behind f therefore decides the WHOLE visible object,
        // independently of where the fallback sphere crosses its hull/turret/barrel volume. Occluded surfaces
        // keep normal occlusion: c < f selects the nearer class, with FRONT winning an exact cross-class tie.
        If(cover.lessThan(front).and(cover.lessThan(1)), () => result.assign(min(result, cover.sub(eps)))).ElseIf(
          front.lessThan(1),
          () => result.assign(max(result, front.add(eps))),
        );
      });
      return result;
    })();
  }

  resize(renderer: WebGPURenderer): void {
    if (this.disposed) return;
    renderer.getDrawingBufferSize(this.size);
    if (this.size.x !== this.target.width || this.size.y !== this.target.height) this.ready = false;
    this.target.setSize(this.size.x, this.size.y);
    this.frontTarget.setSize(this.size.x, this.size.y);
  }

  render(renderer: WebGPURenderer, scene: Scene, view: OrthographicCamera): void {
    this.ready = false;
    if (this.disposed || !supported(renderer)) return;
    this.resize(renderer);
    this.camera.copy(view, false);
    this.camera.layers.set(TERRAIN_DEPTH_LAYER);
    this.frontCamera.copy(view, false);
    this.frontCamera.layers.set(FRONT_DEPTH_LAYER);
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousMRT = renderer.getMRT();
    const previousClearDepth = renderer.getClearDepth();
    const previousAutoClear = renderer.autoClear;
    const previousBackground = scene.background;
    const previousBackgroundNode = scene.backgroundNode;
    try {
      // r186 Background.update can insert a mesh independently of camera layers. Capture only occluders,
      // and avoid a colour background's forceClear changing this pass's explicit clear policy.
      scene.background = scene.backgroundNode = null;
      renderer.setMRT(null);
      renderer.autoClear = false;
      renderer.setClearDepth(1);
      this.captureActive = true;
      this.capture(renderer, scene, this.target, this.camera, 'cover');
      // Empty FRONT frames still clear to far; skip projection/draws so removal cannot leave stale depth.
      this.capture(renderer, scene, this.frontTarget, this.frontCamera, 'front');
      this.ready = true;
    } finally {
      this.captureActive = false;
      this.captureClass.value = 0;
      scene.background = previousBackground;
      scene.backgroundNode = previousBackgroundNode;
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      renderer.setMRT(previousMRT);
      renderer.setClearDepth(previousClearDepth);
      renderer.autoClear = previousAutoClear;
    }
  }

  private capture(
    renderer: WebGPURenderer,
    scene: Scene,
    target: RenderTarget,
    camera: OrthographicCamera,
    kind: 'cover' | 'front',
  ): void {
    renderer.setRenderTarget(target);
    renderer.clear(false, true, false);
    for (const [mesh, entry] of this.meshes) {
      if (!entry[kind] || ('count' in mesh && mesh.count === 0)) continue;
      let object: import('three/webgpu').Object3D | null = mesh;
      while (object?.visible) object = object.parent;
      if (object !== null) continue;
      renderer.render(scene, camera);
      break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = this.mainActive = this.captureActive = false;
    this.captureClass.value = 0;
    this.enabled.value = 0;
    for (const [mesh, entry] of this.meshes) {
      if (!entry.originalCover) mesh.layers.disable(TERRAIN_DEPTH_LAYER);
      if (!entry.originalFront) mesh.layers.disable(FRONT_DEPTH_LAYER);
    }
    this.meshes.clear();
    this.mainTarget = this.mainCamera = null;
    this.target.dispose();
    this.target.depthTexture!.dispose();
    this.frontTarget.dispose();
    this.frontTarget.depthTexture!.dispose();
  }
}
