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
import { Fn, If, cameraFar, cameraNear, float, min, screenCoordinate, textureLoad, uniform, varying } from 'three/tsl';
import type { ShaderNode } from './tsl';

/** Reserved for explicitly registered terrain-class main meshes; ordinary scene cameras retain layer 0. */
export const TERRAIN_DEPTH_LAYER = 31;
/**
 * Camera-space world units. At the orthographic 0.1..400 range this is 2.500625e-6 normalized depth,
 * over 41 D24 steps and 20 float32 ULPs even at depth 1. T uses depth32float; the scene uses depth24plus.
 * This clears depth-format rounding while remaining far below the sphere's 0.03205 foreground-unit margin.
 */
export const TERRAIN_DEPTH_EPSILON = 0.001;

function supported(renderer: Renderer): boolean {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
}

/** CPU twin: a far (cleared) texel must leave even a card close to the far plane exactly unchanged. */
export function terrainDepthPull(
  cardDepth: number,
  terrainDepth: number,
  cameraNear: number,
  cameraFar: number,
): number {
  return terrainDepth < 1
    ? Math.min(cardDepth, terrainDepth - TERRAIN_DEPTH_EPSILON / (cameraFar - cameraNear))
    : cardDepth;
}

/** Generic, renderer-owned depth capture and shared fragment pull; callers choose the occluder policy. */
export class TerrainDepth {
  readonly target = new RenderTarget(1, 1, {
    samples: 0,
    stencilBuffer: false,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  readonly camera = new OrthographicCamera();
  readonly depth = textureLoad(this.target.depthTexture!, screenCoordinate).r;
  readonly enabled = uniform(0)
    .setName('terrainDepthPullEnabled')
    .onObjectUpdate(({ renderer, camera }) => (renderer && this.isMainPass(renderer, camera) ? 1 : 0));
  private readonly meshes = new Map<Mesh, boolean>();
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
  }

  register(mesh: Mesh): () => void {
    if (this.disposed) throw new Error('Cannot register a depth occluder after disposal');
    if (this.meshes.has(mesh)) return () => {};
    this.meshes.set(mesh, mesh.layers.isEnabled(TERRAIN_DEPTH_LAYER));
    // r186 Renderer._projectObject tests each object's layers and still traverses children. Enabling this mesh
    // never admits its shadow/decal/reflection children, whose masks remain unchanged. Materials are reused as-is.
    mesh.layers.enable(TERRAIN_DEPTH_LAYER);
    return () => {
      const alreadyEnabled = this.meshes.get(mesh);
      if (alreadyEnabled === undefined) return;
      if (!alreadyEnabled) mesh.layers.disable(TERRAIN_DEPTH_LAYER);
      this.meshes.delete(mesh);
    };
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
        const terrain = this.depth.toVar();
        result.assign(
          terrain
            .lessThan(1)
            .select(min(result, terrain.sub(float(TERRAIN_DEPTH_EPSILON).div(cameraFar.sub(cameraNear)))), result),
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
  }

  render(renderer: WebGPURenderer, scene: Scene, view: OrthographicCamera): void {
    this.ready = false;
    if (this.disposed || !supported(renderer)) return;
    this.resize(renderer);
    this.camera.copy(view, false);
    this.camera.layers.set(TERRAIN_DEPTH_LAYER);
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
      renderer.setRenderTarget(this.target);
      renderer.autoClear = false;
      renderer.setClearDepth(1);
      renderer.clear(false, true, false);
      // Check ancestor visibility/count without changing any material, depth node, discard or painter bias.
      // Empty frames still clear T so a removed/hidden occluder cannot leave a stale foreground pull.
      for (const mesh of this.meshes.keys()) {
        if ('count' in mesh && mesh.count === 0) continue;
        let object: typeof mesh | import('three/webgpu').Object3D | null = mesh;
        while (object?.visible) object = object.parent;
        if (object !== null) continue;
        renderer.render(scene, this.camera);
        break;
      }
      this.ready = true;
    } finally {
      scene.background = previousBackground;
      scene.backgroundNode = previousBackgroundNode;
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      renderer.setMRT(previousMRT);
      renderer.setClearDepth(previousClearDepth);
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = this.mainActive = false;
    this.enabled.value = 0;
    for (const [mesh, alreadyEnabled] of this.meshes) if (!alreadyEnabled) mesh.layers.disable(TERRAIN_DEPTH_LAYER);
    this.meshes.clear();
    this.mainTarget = this.mainCamera = null;
    this.target.dispose();
    this.target.depthTexture!.dispose();
  }
}
