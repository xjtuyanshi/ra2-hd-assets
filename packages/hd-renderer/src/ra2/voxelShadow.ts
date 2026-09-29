import { LessDepth, Matrix4, Mesh, MeshBasicNodeMaterial, Vector3, type Object3D } from 'three/webgpu';
import { depth, floor, fwidth } from 'three/tsl';
import { LEVEL_HEIGHT } from '../world';

/**
 * Engine-style voxel shadows. The original draws a unit's shadow by flattening the model onto the ground along a fixed
 * light and darkening those pixels once, with a crisp edge; it never lets the sun of the HD scene decide where a unit's
 * shadow lies. A 3D sun shadow put tank shadows several cells away from where the original has them, left hovering
 * aircraft without any shadow under them and made every vehicle read as floating.
 *
 * Here each voxel part gets a twin that shares its geometry and is drawn with P . matrixWorld, where P projects world
 * points onto the ground plane under the unit along the engine's shadow direction. Overlapping parts and faces darken
 * a pixel only once: every twin of a unit lies on one plane and writes one depth per pixel, the plane's nearest depth
 * within the pixel (so every multisample of the ground behind it passes) quantised to SHADOW_DEPTH_STEPS; it passes
 * only in front of what is there (LessDepth), so a second fragment on the same plane fails the depth test. (A stencil
 * did the same, but a depth-stencil target cannot be sampled in three r186, and the post pipeline samples the scene
 * depth for the mist and the shroud. Without the per-pixel nearest depth, a pixel-centre depth failed against about
 * half the ground's multisamples under MSAA and the shadows came out half as dark.) Shadows draw after the sprites'
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
 * Depth quantisation of shadow twins: coplanar triangles interpolate the same depth up to rounding, and quantising to
 * 2^-20 of the camera range (about 0.0004 world units for the iso camera's 400) makes them exactly equal.
 */
const SHADOW_DEPTH_STEPS = 2 ** 20;

/** One shared material: flat black at SHADOW_OPACITY, drawn once per pixel (see the depth notes above). */
let sharedMaterial: MeshBasicNodeMaterial | null = null;
export function voxelShadowMaterial(): MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const material = new MeshBasicNodeMaterial({ color: 0x000000 });
  material.name = 'voxel-shadow';
  material.transparent = true;
  material.opacity = SHADOW_OPACITY;
  material.depthWrite = true;
  material.depthFunc = LessDepth;
  material.depthNode = floor(depth.sub(fwidth(depth)).mul(SHADOW_DEPTH_STEPS)).div(SHADOW_DEPTH_STEPS);
  sharedMaterial = material;
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
  constructor(readonly source: Mesh) {
    super(source.geometry, voxelShadowMaterial());
    this.name = 'voxel-shadow';
    this.matrixAutoUpdate = false;
    this.castShadow = false;
    this.receiveShadow = false;
    // After the sprite layers (4): over their ground decals (lifted less), behind upright art and voxel bodies.
    this.renderOrder = 4.5;
  }

  override updateMatrixWorld(force?: boolean): void {
    const parent = this.parent;
    const ground = groundOf(this);
    if (!parent || !ground) {
      super.updateMatrixWorld(force);
      return;
    }
    // Ground under the unit's origin: its own position for vehicles on the ground, the terrain or water below it for
    // aircraft and jumpjets, whose shadow drops straight down there and shrinks with their height.
    const e = parent.matrixWorld.elements;
    origin.set(e[12]!, e[13]!, e[14]!);
    point.set(origin.x, ground.height(origin.x, origin.z), origin.z);
    const height = origin.y - point.y;
    if (height > AIRBORNE_HEIGHT) {
      point.x += AIRBORNE_SHADOW_DRIFT_X * height;
      point.z += AIRBORNE_SHADOW_DRIFT_Z * height;
      airborneShadowProjection(origin, point, airborneShadowScale(height), projection);
    } else {
      if (ground.normal) ground.normal(point.x, point.z, normal);
      else normal.copy(UP);
      shadowProjection(point, normal, projection);
    }
    this.matrixWorld.multiplyMatrices(projection, this.source.matrixWorld);
    this.matrixWorldNeedsUpdate = false;
    for (const child of this.children) child.updateMatrixWorld(force);
  }
}
