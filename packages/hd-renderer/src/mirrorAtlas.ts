import {
  Box3,
  DepthTexture,
  Frustum,
  HalfFloatType,
  Matrix4,
  Node,
  NodeUpdateType,
  Object3D,
  Plane,
  RenderTarget,
  TextureNode,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
  type Camera,
  type NodeBuilder,
  type NodeFrame,
  type Texture,
} from 'three/webgpu';
import { screenUV, uniform, vec2 } from 'three/tsl';
import type { ShaderNode } from './tsl';

/**
 * Planar mirrors of several horizontal planes rendered into ONE colour and ONE depth texture.
 *
 * A material may sample only 16 textures per shader stage on a default WebGPU device. three's ReflectorNode owns a
 * render target per mirror, so a ground material that mirrors four water terraces spent eight of them on mirrors
 * alone and its pipeline was refused (the ground stayed the clear colour). The atlas gives every plane a tile of one
 * shared target instead: two sampled textures whatever the number of planes, at the same pixels per plane.
 *
 * Each tile is the scene rendered from that plane's mirrored camera into its viewport (the oblique near-plane
 * construction is three r186's ReflectorNode.updateBefore, kept identical so depth still converts to height the same
 * way). Planes whose bounds are off screen are skipped; a skipped tile may hold cleared texels, which no visible
 * fragment samples.
 */

/** One horizontal mirror plane of the atlas. */
export interface MirrorAtlasPlane {
  /** Height of the plane in the atlas target's local space. */
  y: number;
  /** World-space box of the surface that shows this mirror; its render is skipped while the box is off screen. */
  bounds?: Box3;
}

/** Tiles per row and per column for a number of planes: 1 -> 1x1, 2 -> 2x1, 3 or 4 -> 2x2, then 3x2, 3x3 ... */
export function mirrorAtlasLayout(count: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

/** Pixel rectangle [x, y, width, height] of a tile; the origin is the top-left texel, as WebGPU viewports are. */
export function mirrorAtlasTileRect(
  index: number,
  columns: number,
  tileWidth: number,
  tileHeight: number,
): [number, number, number, number] {
  return [(index % columns) * tileWidth, Math.floor(index / columns) * tileHeight, tileWidth, tileHeight];
}

/**
 * Atlas UV of a tile-local UV. The tile UV is clamped half a texel inside the tile, which is what a clamped sampler
 * does at the edge of a texture of its own: neither a rippled lookup nor bilinear filtering reads a neighbouring tile.
 */
export function mirrorAtlasUv(
  u: number,
  v: number,
  index: number,
  columns: number,
  rows: number,
  tileWidth: number,
  tileHeight: number,
): [number, number] {
  const marginU = 0.5 / tileWidth;
  const marginV = 0.5 / tileHeight;
  const cu = Math.min(Math.max(u, marginU), 1 - marginU);
  const cv = Math.min(Math.max(v, marginV), 1 - marginV);
  return [((index % columns) + cu) / columns, (Math.floor(index / columns) + cv) / rows];
}

const reflectorPlane = new Plane();
const normal = new Vector3();
const planePoint = new Vector3();
const cameraPosition = new Vector3();
const rotation = new Matrix4();
const lookAt = new Vector3();
const view = new Vector3();
const target = new Vector3();
const clipPlane = new Vector4();
const q = new Vector4();
const size = new Vector2();
const projectionView = new Matrix4();
const frustum = new Frustum();

/**
 * Point `virtualCamera` at the scene as mirrored in the plane through `point` with unit `planeNormal`, with an oblique
 * near plane on the mirror so nothing below it is drawn. Returns false when the camera is behind the plane.
 */
export function mirrorCamera(
  camera: Camera,
  virtualCamera: Camera,
  point: Vector3,
  planeNormal: Vector3,
  webgpu: boolean,
): boolean {
  cameraPosition.setFromMatrixPosition(camera.matrixWorld);
  view.subVectors(point, cameraPosition);
  if (view.dot(planeNormal) > 0) return false;
  view.reflect(planeNormal).negate();
  view.add(point);
  rotation.extractRotation(camera.matrixWorld);
  lookAt.set(0, 0, -1).applyMatrix4(rotation).add(cameraPosition);
  target.subVectors(point, lookAt);
  target.reflect(planeNormal).negate();
  target.add(point);

  virtualCamera.coordinateSystem = camera.coordinateSystem;
  virtualCamera.position.copy(view);
  virtualCamera.up.set(0, 1, 0).applyMatrix4(rotation).reflect(planeNormal);
  virtualCamera.lookAt(target);
  const source = camera as Camera & { near?: number; far?: number };
  const mirrored = virtualCamera as Camera & { near?: number; far?: number };
  mirrored.near = source.near;
  mirrored.far = source.far;
  virtualCamera.updateMatrixWorld();
  virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

  // Oblique near plane (Lengyel), exactly as three r186's ReflectorNode builds it.
  reflectorPlane.setFromNormalAndCoplanarPoint(planeNormal, point);
  reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
  clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
  const e = virtualCamera.projectionMatrix.elements;
  q.x = (Math.sign(clipPlane.x) + e[8]!) / e[0]!;
  q.y = (Math.sign(clipPlane.y) + e[9]!) / e[5]!;
  q.z = -1;
  q.w = (1 + e[10]!) / e[14]!;
  clipPlane.multiplyScalar(1 / clipPlane.dot(q));
  e[2] = clipPlane.x;
  e[6] = clipPlane.y;
  e[10] = webgpu ? clipPlane.z : clipPlane.z + 1;
  e[14] = clipPlane.w;
  return true;
}

/** Texture node of the atlas; building it schedules the atlas's renders for the material that samples it. */
class MirrorAtlasTextureNode extends TextureNode {
  static get type(): string {
    return 'MirrorAtlasTextureNode';
  }

  readonly _atlasNode: MirrorAtlasNode;

  constructor(value: Texture, atlasNode: MirrorAtlasNode, uvNode: ShaderNode = screenUV) {
    // A UV node is always given, so three never applies the texture's own UV transform (as for its reflector).
    super(value, uvNode);
    this._atlasNode = atlasNode;
  }

  override setup(builder: NodeBuilder): ShaderNode {
    // Not in post-processing quads: a mirror belongs to the scene object whose material samples it (as three does).
    if (!(builder.object as { isQuadMesh?: boolean } | null)?.isQuadMesh) this._atlasNode.build(builder);
    return super.setup(builder);
  }

  override clone(): this {
    const node = new MirrorAtlasTextureNode(this.value, this._atlasNode, this.uvNode);
    const source = this as ShaderNode;
    const copy = node as ShaderNode;
    for (const key of [
      'levelNode',
      'biasNode',
      'sampler',
      'depthNode',
      'compareNode',
      'gradNode',
      'gatherNode',
      'offsetNode',
    ])
      copy[key] = source[key];
    return node as this;
  }
}

/** What a water look needs from one mirror: three's ReflectorNode has the same members. */
export interface MirrorSource {
  /** UV of the fragment in the mirrored view (0..1 across it). */
  uvNode: ShaderNode;
  /** Mirrored scene colour at a mirrored-view UV. */
  sample(uv: ShaderNode): ShaderNode;
  /** Mirrored scene depth; `.sample(uv).x` is the depth at a mirrored-view UV. */
  getDepthNode(): { sample(uv: ShaderNode): ShaderNode };
  /** State of the mirrored render: whether it has drawn yet, and the camera it draws from for a scene camera. */
  reflector: { hasOutput: boolean; getVirtualCamera(camera: Camera): Camera };
}

/** One plane's tile: a MirrorSource whose samples are redirected into the plane's rectangle of the atlas. */
export class MirrorAtlasTile implements MirrorSource {
  readonly uvNode: ShaderNode = screenUV.flipX();
  readonly reflector: { hasOutput: boolean; getVirtualCamera(camera: Camera): Camera };
  private readonly cameras = new WeakMap<Camera, Camera>();
  private readonly mapped = new WeakMap<object, ShaderNode>();
  private readonly depthSource: { sample(uv: ShaderNode): ShaderNode };

  constructor(
    readonly atlas: MirrorAtlas,
    readonly index: number,
    readonly plane: MirrorAtlasPlane,
  ) {
    this.reflector = {
      hasOutput: false,
      getVirtualCamera: (camera) => {
        let virtual = this.cameras.get(camera);
        if (!virtual) {
          virtual = camera.clone();
          this.cameras.set(camera, virtual);
        }
        return virtual;
      },
    };
    this.depthSource = { sample: (uv) => atlas.depthNode.sample(this.atlasUv(uv)) };
  }

  /**
   * Atlas UV node of a mirrored-view UV node (see mirrorAtlasUv). One node per UV node: a colour tap and a depth tap
   * at the same place share it, as they share the UV on a mirror with a target of its own.
   */
  atlasUv(uv: ShaderNode): ShaderNode {
    let mapped: ShaderNode = this.mapped.get(uv);
    if (!mapped) {
      const { columns, rows } = this.atlas.layout;
      const margin: ShaderNode = this.atlas.texelMargin;
      mapped = uv
        .clamp(margin, vec2(1).sub(margin))
        .add(vec2(this.index % columns, Math.floor(this.index / columns)))
        .mul(vec2(1 / columns, 1 / rows));
      this.mapped.set(uv, mapped);
    }
    return mapped;
  }

  sample(uv: ShaderNode): ShaderNode {
    return this.atlas.colourNode.sample(this.atlasUv(uv));
  }

  getDepthNode(): { sample(uv: ShaderNode): ShaderNode } {
    return this.depthSource;
  }
}

/** Renders the visible tiles before the object that samples the atlas is drawn (once per render of the scene). */
export class MirrorAtlasNode extends Node {
  static get type(): string {
    return 'MirrorAtlasNode';
  }

  private rendering = false;

  constructor(private readonly atlas: MirrorAtlas) {
    super();
    this.updateBeforeType = NodeUpdateType.RENDER;
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    // A mirrored render never draws the mirrors of its own atlas again (the sampling material is hidden in it).
    if (this.rendering) return false;
    const { scene, camera, renderer, material, object } = frame;
    if (!scene || !camera || !renderer || !material) return false;
    this.rendering = true;
    try {
      this.atlas.render(renderer, scene, camera, material, () => {
        // The nested render used the shared NodeFrame for its own objects; the caller still draws this one.
        frame.camera = camera;
        frame.material = material;
        frame.object = object;
        frame.scene = scene;
        frame.renderer = renderer;
      });
    } finally {
      this.rendering = false;
    }
    return undefined;
  }
}

/** The subset of the renderer the atlas drives (three's Renderer; narrowed so tests can pass a recorder). */
export interface MirrorAtlasRenderer {
  coordinateSystem: number;
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  getDrawingBufferSize(target: Vector2): Vector2;
  getRenderTarget(): RenderTarget | null;
  setRenderTarget(target: RenderTarget | null): void;
  getMRT(): unknown;
  setMRT(mrt: never): unknown;
  getScissorTest(): boolean;
  setScissorTest(enabled: boolean): void;
  render(scene: Object3D, camera: Camera): unknown;
}

export class MirrorAtlas {
  /** In the scene graph: plane heights are local to it, so the mirrors follow the world they belong to. */
  readonly target = new Object3D();
  readonly layout: { columns: number; rows: number };
  readonly renderTarget: RenderTarget;
  /** Scheduled with every material that samples the atlas: renders the visible tiles before that material's object. */
  readonly node: MirrorAtlasNode;
  readonly colourNode: ShaderNode;
  readonly depthNode: ShaderNode;
  /** Half a texel of one tile, in tile UV units (kept current with the drawing buffer). */
  readonly texelMargin = uniform(new Vector2(0.5, 0.5));
  readonly tiles: readonly MirrorAtlasTile[];
  /** Tile size as a fraction of the drawing buffer; below 1, so a tile is never mistaken for the whole target. */
  readonly resolutionScale: number;
  private warmNext = false;

  constructor(planes: readonly MirrorAtlasPlane[], options: { resolutionScale?: number } = {}) {
    if (!planes.length) throw new Error('MirrorAtlas needs at least one plane');
    this.resolutionScale = Math.min(options.resolutionScale ?? 0.5, 0.75);
    this.layout = mirrorAtlasLayout(planes.length);
    this.renderTarget = new RenderTarget(1, 1, { type: HalfFloatType });
    this.renderTarget.depthTexture = new DepthTexture(1, 1);
    this.renderTarget.texture.name = 'mirror-atlas';
    this.renderTarget.depthTexture.name = 'mirror-atlas-depth';
    this.node = new MirrorAtlasNode(this);
    this.colourNode = new MirrorAtlasTextureNode(this.renderTarget.texture, this.node);
    this.depthNode = new MirrorAtlasTextureNode(this.renderTarget.depthTexture, this.node);
    this.tiles = planes.map((plane, index) => new MirrorAtlasTile(this, index, plane));
  }

  /** Pixel size of one tile for a drawing buffer. */
  tileSize(bufferWidth: number, bufferHeight: number): [number, number] {
    return [
      Math.max(1, Math.round(bufferWidth * this.resolutionScale)),
      Math.max(1, Math.round(bufferHeight * this.resolutionScale)),
    ];
  }

  /**
   * Render every plane whose bounds the camera sees into its tile; `hidden` (the material sampling the atlas) is not
   * drawn, since a texture cannot be sampled while it is rendered to. `afterEach` runs after each nested render.
   */
  render(
    renderer: MirrorAtlasRenderer,
    scene: Object3D,
    camera: Camera,
    hidden: { visible: boolean },
    afterEach?: () => void,
  ): number {
    projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(
      projectionView,
      camera.coordinateSystem,
      (camera as Camera & { reversedDepth?: boolean }).reversedDepth,
    );
    const webgpu = renderer.coordinateSystem === WebGPUCoordinateSystem;
    normal.set(0, 1, 0).transformDirection(this.target.matrixWorld);
    const warm = this.warmNext;
    this.warmNext = false;
    const mirrored = (tile: MirrorAtlasTile): boolean => {
      planePoint.set(0, tile.plane.y, 0).applyMatrix4(this.target.matrixWorld);
      return mirrorCamera(camera, tile.reflector.getVirtualCamera(camera), planePoint, normal, webgpu);
    };
    const visible = this.tiles.filter(
      (tile) => (!tile.plane.bounds || frustum.intersectsBox(tile.plane.bounds)) && mirrored(tile),
    );
    if (!visible.length && warm) {
      // A warm frame: one tile is rendered although no plane is in view, so the mirror pass has its shaders.
      const tile = this.tiles.find(mirrored);
      if (tile) visible.push(tile);
    }
    if (!visible.length) return 0;

    renderer.getDrawingBufferSize(size);
    const [tileWidth, tileHeight] = this.tileSize(size.width, size.height);
    const { columns, rows } = this.layout;
    this.renderTarget.setSize(tileWidth * columns, tileHeight * rows);
    this.texelMargin.value.set(0.5 / tileWidth, 0.5 / tileHeight);

    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    const previousAutoClear = renderer.autoClear;
    const previousChannels = [renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil] as const;
    const previousScissorTest = renderer.getScissorTest();
    const wasVisible = hidden.visible;
    hidden.visible = false;
    try {
      renderer.setMRT(null as never);
      renderer.setRenderTarget(this.renderTarget);
      renderer.setScissorTest(true);
      let first = true;
      for (const tile of visible) {
        const [x, y, width, height] = mirrorAtlasTileRect(tile.index, columns, tileWidth, tileHeight);
        this.renderTarget.viewport.set(x, y, width, height);
        this.renderTarget.scissor.set(x, y, width, height);
        // A render pass clears its whole attachment, whatever its viewport: only the first tile of a pass over the
        // atlas may clear. autoClear alone is not enough, because a scene whose background is a colour clears on
        // every render (three r186 Background.update, forceClear); the per-channel switches are honoured there too.
        renderer.autoClear = first;
        if (!first) renderer.autoClearColor = renderer.autoClearDepth = renderer.autoClearStencil = false;
        first = false;
        renderer.render(scene, tile.reflector.getVirtualCamera(camera));
        tile.reflector.hasOutput = true;
        afterEach?.();
      }
    } finally {
      this.renderTarget.viewport.set(0, 0, this.renderTarget.width, this.renderTarget.height);
      this.renderTarget.scissor.set(0, 0, this.renderTarget.width, this.renderTarget.height);
      renderer.setScissorTest(previousScissorTest);
      renderer.setMRT(previousMrt as never);
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      [renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil] = previousChannels;
      hidden.visible = wasVisible;
    }
    return visible.length;
  }

  /** Render a tile in the next render even if no plane is in view (a warm frame: see HdRenderer.warm). */
  warm(): void {
    this.warmNext = true;
  }

  dispose(): void {
    this.renderTarget.dispose();
  }
}
