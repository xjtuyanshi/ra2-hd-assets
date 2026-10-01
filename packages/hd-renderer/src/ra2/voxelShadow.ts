import {
  LessDepth,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Object3D,
  type OrthographicCamera,
} from 'three/webgpu';
import { floor, screenCoordinate, uniform } from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, type AtmosphereNodes } from '../atmosphere';
import { LEVEL_HEIGHT } from '../world';
import { spriteLookFor } from './spriteLook';

/**
 * Engine-style voxel shadows. The original draws a unit's shadow by flattening the model onto the ground along a fixed
 * light and darkening those pixels once, with a crisp edge; it never lets the sun of the HD scene decide where a unit's
 * shadow lies. A 3D sun shadow put tank shadows several cells away from where the original has them, left hovering
 * aircraft without any shadow under them and made every vehicle read as floating.
 *
 * Here each voxel part gets five twins sharing geometry/material, drawn with P . matrixWorld, where P projects
 * world points onto the ground plane under the unit along the engine's shadow direction. A physical shadow-origin override
 * translates render-offset geometry back to that origin before ground projection, regardless of render altitude.
 * Four twins offset by 0.04 cells soften the edge; their increasing lifts draw in order. Each layer's opacity is
 * 1 - (1 - target)^(1/5), so the shared core retains the engine/enhanced darkness. Within each layer, overlapping
 * parts and faces darken a pixel only once: all use the same analytic plane depth at the pixel centre, pulled to the
 * nearest depth within the pixel (so every ground multisample passes), quantised to SHADOW_DEPTH_STEPS. It passes
 * only in front of what is there (LessDepth), so a second fragment on the same plane fails the depth test. (A stencil
 * did the same, but a depth-stencil target cannot be sampled in three r186, and the post pipeline samples the scene
 * depth for the mist and the shroud. Without the per-pixel nearest depth, a pixel-centre depth failed against about
 * half the ground's multisamples under MSAA and the shadows came out half as dark. Derivatives of interpolated
 * triangle depth introduced a stippled fringe; analytic coefficients keep identical depths across voxel edges.)
 * Review tooling can restore a single hard twin. Shadows draw after the sprites'
 * decals and before upright art is blended over them only where they are in front (renderOrder and SHADOW_LIFT).
 */

/**
 * Shadow direction: a point h world units above the ground lands SHADOW_SHEAR_X * h along +x and SHADOW_SHEAR_Z * h
 * along +z. Fitted on 15 isolated vehicles of same-moment captures (MTNK, AMCV at facings 0-224, the original taken
 * from the engine's framebuffer) with the voxels at their engine size and shadows at the engine's darkness: shadow
 * intersection over union 0.52 (0.33 at the earlier 0.15), integrated darkening 1.13x the original's. X 0.45 reached
 * 0.55 but 1.26x the darkening; the Z term hardly matters (-0.25 .. 0.05 all within 0.05 IoU).
 */
export const SHADOW_SHEAR_X = 0.4;
export const SHADOW_SHEAR_Z = -0.07;
/** The shear in use (review tooling may change it before units are drawn); defaults to the constants above. */
export const shadowShear = { x: SHADOW_SHEAR_X, z: SHADOW_SHEAR_Z };
/**
 * Opacity of black that halves the displayed colour, as the engine's shadows do (it halves each 16-bit RGB channel of
 * the pixel under a shadow). The scene blends in linear light before the display transform, so half the displayed
 * value is about 0.5^2.2 = 0.22 of the linear value: black at 1 - 0.22 = 0.78. (Black at 0.5 kept 73 % of the displayed
 * brightness, and shadows under tanks and buildings looked half as dark as the original's.)
 */
export const ENGINE_SHADOW_OPACITY = 1 - Math.pow(0.5, 2.2);
/** Voxel shadows darken like every engine shadow. */
export const SHADOW_OPACITY = ENGINE_SHADOW_OPACITY;
/**
 * Lift above the ground plane: above the sprite decals' 0.02 (ore, smudges, bibs, SHP shadows), so a unit's shadow
 * darkens them too, as the engine draws shadows over the ground layer.
 */
export const SHADOW_LIFT = 0.03;
/** Contact penumbra radius in cells, independent of camera zoom. */
export const SHADOW_PENUMBRA = 0.04;
/** Extra normal lift per layer, above the iso camera's depth quantisation step (400 / 2^20). */
export const SHADOW_COPY_LIFT = 0.001;
export const SHADOW_COPIES = [
  { x: 0, z: 0, lift: 0 },
  { x: -SHADOW_PENUMBRA, z: 0, lift: SHADOW_COPY_LIFT },
  { x: SHADOW_PENUMBRA, z: 0, lift: 2 * SHADOW_COPY_LIFT },
  { x: 0, z: -SHADOW_PENUMBRA, lift: 3 * SHADOW_COPY_LIFT },
  { x: 0, z: SHADOW_PENUMBRA, lift: 4 * SHADOW_COPY_LIFT },
] as const;

/** Equal black-alpha layers whose fully covered core composes to the target darkness. */
export function shadowCopyOpacity(target: number, copies: number = SHADOW_COPIES.length): number {
  return 1 - Math.pow(1 - target, 1 / copies);
}

const shadowModes = new WeakMap<AtmosphereNodes, { soft: boolean }>();
/** Renderer-local review switch; hard mode hides the four extra twins and restores single-layer opacity. */
export function voxelShadowFor(nodes = DEFAULT_ATMOSPHERE_NODES): { soft: boolean } {
  let mode = shadowModes.get(nodes);
  if (!mode) shadowModes.set(nodes, (mode = { soft: true }));
  return mode;
}
/** A unit whose origin is higher than this above the ground (world units) is airborne: aircraft, jumpjets. */
export const AIRBORNE_HEIGHT = 0.1;
/**
 * Height above the ground (world units) at which an airborne unit's shadow is drawn at half size. The original
 * shrinks a flying unit's shadow with its altitude and drops it straight down; measured on same-moment captures of a
 * spy plane at the standard flight level (1500 leptons, 5.9 world units): about half its landed footprint (34 px wide
 * against 33 px here, where the sheared full-size shadow was 49 px).
 */
export const AIRBORNE_SHADOW_HALF = (1500 / 104) * LEVEL_HEIGHT;

/**
 * Where an airborne shadow lies relative to the ground point: this far along +x and +z per world unit of height. The
 * original draws a flying spy plane's shadow about 10 px right of (and 2 px above) the straight-down point at the
 * standard flight level; that is the only aircraft in the captures, so other heights scale linearly from it.
 */
export const AIRBORNE_SHADOW_DRIFT_X = 0.0194;
export const AIRBORNE_SHADOW_DRIFT_Z = -0.0386;

/** Size of an airborne unit's shadow relative to its footprint on the ground, at `height` world units up. */
export function airborneShadowScale(height: number): number {
  return AIRBORNE_SHADOW_HALF / (AIRBORNE_SHADOW_HALF + Math.max(0, height));
}

/** Ground under a world position: height of the terrain or the water surface there, and optionally its normal. */
export interface ShadowGround {
  height(x: number, z: number): number;
  /** Unit surface normal of the ground at (x, z) written to `out`; absent = flat. */
  normal?(x: number, z: number, out: Vector3): Vector3;
}

/**
 * Ground from a height field: normals by central differences half a cell apart. A step steeper than `maxSlope`
 * (height per world unit) is a cliff edge, not a surface, and counts as flat along that axis.
 */
export function groundFromHeights(height: (x: number, z: number) => number, maxSlope: number): ShadowGround {
  const e = 0.25;
  const slope = (d: number) => (Math.abs(d) > maxSlope ? 0 : d);
  return {
    height,
    normal(x, z, out) {
      const dx = slope((height(x + e, z) - height(x - e, z)) / (2 * e));
      const dz = slope((height(x, z + e) - height(x, z - e)) / (2 * e));
      return out.set(-dx, 1, -dz).normalize();
    },
  };
}

const grounds = new WeakMap<Object3D, ShadowGround>();
const shadowOrigins = new WeakMap<Object3D, Vector3>();

/** Set a unit root's physical world-space shadow origin, forcing ground projection; absent restores normal shadows. */
export function setShadowOrigin(unit: Object3D, origin?: Vector3): void {
  if (!origin) {
    shadowOrigins.delete(unit);
    return;
  }
  let stored = shadowOrigins.get(unit);
  if (!stored) shadowOrigins.set(unit, (stored = new Vector3()));
  stored.copy(origin);
}

/** Register the ground of a scene; voxel units and their shadows below `scene` look it up by walking to their root. */
export function setShadowGround(scene: Object3D, ground: ShadowGround | ((x: number, z: number) => number)): void {
  grounds.set(scene, typeof ground === 'function' ? { height: ground } : ground);
}

/** The ground registered for the scene graph `object` belongs to, if any. */
export function groundOf(object: Object3D): ShadowGround | undefined {
  let root = object;
  while (root.parent) root = root.parent;
  return grounds.get(root);
}

const UP = new Vector3(0, 1, 0);

/**
 * Projection of world points onto the plane through `point` with normal `normal` (default: horizontal), along the
 * shadow direction (SHADOW_SHEAR_X, -1, SHADOW_SHEAR_Z), lifted by SHADOW_LIFT along the normal. On a horizontal
 * plane at height g a point (x, y, z) lands on (x + a (y - g), g + lift, z + b (y - g)).
 */
export function shadowProjection(point: Vector3, normal: Vector3 = UP, out = new Matrix4()): Matrix4 {
  const sx = shadowShear.x;
  const sy = -1;
  const sz = shadowShear.z;
  const { x: nx, y: ny, z: nz } = normal;
  const ns = nx * sx + ny * sy + nz * sz;
  const d = nx * point.x + ny * point.y + nz * point.z;
  // p' = p - s (n.p - d) / (n.s) + lift n
  const k = -1 / ns;
  return out.set(
    1 + k * sx * nx,
    k * sx * ny,
    k * sx * nz,
    -k * sx * d + SHADOW_LIFT * nx,
    k * sy * nx,
    1 + k * sy * ny,
    k * sy * nz,
    -k * sy * d + SHADOW_LIFT * ny,
    k * sz * nx,
    k * sz * ny,
    1 + k * sz * nz,
    -k * sz * d + SHADOW_LIFT * nz,
    0,
    0,
    0,
    1,
  );
}

/** Translate geometry from its drawn origin to its physical origin, then apply the ordinary ground projection. */
export function shadowOriginProjection(
  drawnOrigin: Vector3,
  physicalOrigin: Vector3,
  ground: Vector3,
  normal: Vector3 = UP,
  out = new Matrix4(),
): Matrix4 {
  shadowProjection(ground, normal, out);
  const dx = physicalOrigin.x - drawnOrigin.x;
  const dy = physicalOrigin.y - drawnOrigin.y;
  const dz = physicalOrigin.z - drawnOrigin.z;
  // P * T(physical - drawn), without allocating a translation matrix for every shadow part each frame.
  const e = out.elements;
  e[12] += e[0]! * dx + e[4]! * dy + e[8]! * dz;
  e[13] += e[1]! * dx + e[5]! * dy + e[9]! * dz;
  e[14] += e[2]! * dx + e[6]! * dy + e[10]! * dz;
  return out;
}

/**
 * Shadow of an airborne unit whose origin is at `origin`, over the ground point `ground` below it: the model is
 * flattened along the shadow direction relative to its own origin (its own body height only, as on the ground), dropped
 * straight down onto the horizontal plane through `ground` and shrunk about that point by `scale`.
 */
export function airborneShadowProjection(
  origin: Vector3,
  ground: Vector3,
  scale: number,
  out = new Matrix4(),
): Matrix4 {
  const a = shadowShear.x * scale;
  const b = shadowShear.z * scale;
  return out.set(
    scale,
    a,
    0,
    ground.x - scale * origin.x - a * origin.y,
    0,
    0,
    0,
    ground.y + SHADOW_LIFT,
    0,
    b,
    scale,
    ground.z - scale * origin.z - b * origin.y,
    0,
    0,
    0,
    1,
  );
}

/**
 * Quantise analytic plane depth to 2^-20 of the camera range (about 0.0004 world units for the iso camera's 400).
 * All parts/faces of a layer use the same coefficients, so triangle interpolation/derivatives cannot split a bin.
 */
export const SHADOW_DEPTH_STEPS = 2 ** 20;

/** Pixel-centre depth c0 + cx*x + cy*y of n.p = constant, plus the nearest-sample pull in w (pixels, y down). */
export function shadowPlaneDepth(
  camera: OrthographicCamera,
  width: number,
  height: number,
  normal: Vector3,
  constant: number,
  out: Vector4,
): Vector4 {
  const m = camera.matrixWorld.elements;
  const p = camera.projectionMatrixInverse.elements;
  const nx = normal.x * m[0]! + normal.y * m[1]! + normal.z * m[2]!;
  const ny = normal.x * m[4]! + normal.y * m[5]! + normal.z * m[6]!;
  const nz = normal.x * m[8]! + normal.y * m[9]! + normal.z * m[10]!;
  const d = constant - normal.x * m[12]! - normal.y * m[13]! - normal.z * m[14]!;
  const range = camera.far - camera.near;
  const c0 = ((nx * (p[12]! - p[0]!) + ny * (p[13]! + p[5]!) - d) / nz - camera.near) / range;
  const cx = (2 * nx * p[0]!) / (width * nz * range);
  const cy = (-2 * ny * p[5]!) / (height * nz * range);
  return out.set(c0, cx, cy, (Math.abs(cx) + Math.abs(cy)) / 2);
}

const planeSize = new Vector2();

/** One shared material per renderer context, drawn once per pixel per layer (see the depth notes above). */
const sharedMaterials = new WeakMap<AtmosphereNodes, MeshBasicNodeMaterial>();
export function voxelShadowMaterial(nodes = DEFAULT_ATMOSPHERE_NODES): MeshBasicNodeMaterial {
  const shared = sharedMaterials.get(nodes);
  if (shared) return shared;
  const material = new MeshBasicNodeMaterial({ color: 0x000000 });
  material.name = 'voxel-shadow';
  material.transparent = true;
  material.opacity = SHADOW_OPACITY;
  const look = spriteLookFor(nodes);
  const mode = voxelShadowFor(nodes);
  material.opacityNode = uniform(SHADOW_OPACITY).onObjectUpdate(() => {
    const target =
      look.enabled.value > 0.5 && look.shadowDarkness.value !== 1
        ? Math.min(SHADOW_OPACITY * look.shadowDarkness.value, 0.9)
        : SHADOW_OPACITY;
    return shadowCopyOpacity(target, mode.soft ? SHADOW_COPIES.length : 1);
  });
  material.depthWrite = true;
  material.depthFunc = LessDepth;
  const plane = uniform(new Vector4());
  plane.onObjectUpdate(({ object, camera, renderer }) => {
    if (!renderer || !camera) return;
    const target = renderer.getRenderTarget();
    if (target) planeSize.set(target.width, target.height);
    else renderer.getDrawingBufferSize(planeSize);
    const shadow = object instanceof VoxelShadowMesh ? object : undefined;
    shadowPlaneDepth(
      camera as OrthographicCamera,
      planeSize.x,
      planeSize.y,
      shadow?.planeNormal ?? UP,
      shadow?.planeConstant ?? SHADOW_LIFT,
      plane.value,
    );
  });
  material.depthNode = floor(
    plane.x
      .add(plane.y.mul(screenCoordinate.x))
      .add(plane.z.mul(screenCoordinate.y))
      .sub(plane.w)
      .mul(SHADOW_DEPTH_STEPS),
  ).div(SHADOW_DEPTH_STEPS);
  sharedMaterials.set(nodes, material);
  nodes.own(material);
  return material;
}

const point = new Vector3();
const origin = new Vector3();
const normal = new Vector3();
const projection = new Matrix4();

/**
 * Flattened twin of a voxel part. Add it to the unit's root group after every part (the scene graph updates children
 * in order, so the source's world matrix is current by then); it follows the source's pose every frame.
 */
export class VoxelShadowMesh extends Mesh {
  readonly planeNormal = new Vector3(0, 1, 0);
  planeConstant = SHADOW_LIFT;
  private readonly mode: { soft: boolean };

  constructor(
    readonly source: Mesh,
    nodes = DEFAULT_ATMOSPHERE_NODES,
    readonly copyIndex = 0,
  ) {
    super(source.geometry, voxelShadowMaterial(nodes));
    this.mode = voxelShadowFor(nodes);
    this.name = 'voxel-shadow';
    this.matrixAutoUpdate = false;
    this.castShadow = false;
    this.receiveShadow = false;
    // After the sprite layers (4): over their ground decals (lifted less), behind upright art and voxel bodies.
    this.renderOrder = 4.5 + copyIndex * 0.001;
  }

  override updateMatrixWorld(force?: boolean): void {
    this.visible = this.copyIndex === 0 || this.mode.soft;
    const parent = this.parent;
    const ground = groundOf(this);
    if (!parent || !ground) {
      super.updateMatrixWorld(force);
      return;
    }
    // An override casts from a physical origin instead of a render-offset root, always with ground shear. Otherwise
    // vehicles use their own origin; aircraft and jumpjets drop onto the terrain/water and shrink with their height.
    const e = parent.matrixWorld.elements;
    origin.set(e[12]!, e[13]!, e[14]!);
    const physicalOrigin = shadowOrigins.get(parent);
    const anchor = physicalOrigin ?? origin;
    point.set(anchor.x, ground.height(anchor.x, anchor.z), anchor.z);
    const height = origin.y - point.y;
    if (!physicalOrigin && height > AIRBORNE_HEIGHT) {
      point.x += AIRBORNE_SHADOW_DRIFT_X * height;
      point.z += AIRBORNE_SHADOW_DRIFT_Z * height;
      airborneShadowProjection(origin, point, airborneShadowScale(height), projection);
      normal.copy(UP);
    } else {
      if (ground.normal) ground.normal(point.x, point.z, normal);
      else normal.copy(UP);
      if (physicalOrigin) shadowOriginProjection(origin, physicalOrigin, point, normal, projection);
      else shadowProjection(point, normal, projection);
    }
    const copy = SHADOW_COPIES[this.copyIndex]!;
    // Offset in the tangent plane (including ramps), then lift along its normal. Flight never scales the penumbra.
    const p = projection.elements;
    p[12] += copy.x + copy.lift * normal.x;
    p[13] += -(normal.x * copy.x + normal.z * copy.z) / normal.y + copy.lift * normal.y;
    p[14] += copy.z + copy.lift * normal.z;
    this.planeNormal.copy(normal);
    this.planeConstant = normal.dot(point) + SHADOW_LIFT + copy.lift;
    this.matrixWorld.multiplyMatrices(projection, this.source.matrixWorld);
    this.matrixWorldNeedsUpdate = false;
    for (const child of this.children) child.updateMatrixWorld(force);
  }
}
