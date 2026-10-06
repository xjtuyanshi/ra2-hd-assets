import {
  BackSide,
  BufferGeometry,
  Color,
  DoubleSide,
  LessDepth,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector2,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
  type OrthographicCamera,
} from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  mix,
  positionGeometry,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, type AtmosphereNodes } from '../atmosphere';
import type { ShaderNode } from '../tsl';
import { sceneLitColour } from '../lighting';
import { bindSlots } from '../materialSlots';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../world';
import { spriteLookFor } from './spriteLook';
import { voxelReflectionColour, voxelReflectionSource } from './voxelReflectionColour';

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
 * Grounded water origins instead use straight-down contact twins, broken waterline foam and a rippled mirrored
 * colour reflection flattened along the view ray. Their analytic depth layers keep the foam outside the contact core;
 * aircraft and physical-origin overrides retain the original projection. All twins share their source geometry.
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

export const WATER_CONTACT_OPACITY = 0.3;
export const WATER_FOAM_OPACITY = 0.3;
export const WATER_FOAM_SCALE = 1.06;
export const WATER_FOAM_FORWARD_SCALE = 1.14;
export const WATER_REFLECTION_OPACITY = 0.6;
/** Previous silhouette alpha, retained exactly for the flat reflection review. */
export const WATER_FLAT_REFLECTION_OPACITY = 0.3;
export const WATER_REFLECTION_FADE = 0.8;
/** Contact must write ahead of every foam layer, so foam fails depth inside the hull rather than whitening it. */
const WATER_CONTACT_LIFT = (SHADOW_COPIES.length + 1) * SHADOW_COPY_LIFT;

interface VoxelShadowState {
  soft: boolean;
  naval: boolean;
  reflection: 'colour' | 'flat';
  /** Seconds on the renderer's presentation clock, including frozen sandbox captures. */
  time: number;
  toCamera: Vector3;
}
const shadowModes = new WeakMap<AtmosphereNodes, VoxelShadowState>();
/** Renderer-local review switches and frame inputs; old naval mode restores ordinary shadows on water. */
export function voxelShadowFor(nodes = DEFAULT_ATMOSPHERE_NODES): VoxelShadowState {
  let mode = shadowModes.get(nodes);
  if (!mode)
    shadowModes.set(
      nodes,
      (mode = {
        soft: true,
        naval: true,
        reflection: 'colour',
        time: 0,
        toCamera: new Vector3(Math.sqrt(1.5), 1, Math.sqrt(1.5)).normalize(),
      }),
    );
  return mode;
}

/** Shared parsing for the sandbox and replay bench; the three review switches are independent. */
export function applyVoxelShadowParams(params: URLSearchParams, nodes = DEFAULT_ATMOSPHERE_NODES): void {
  const mode = voxelShadowFor(nodes);
  mode.soft = params.get('vshadow') !== 'hard';
  mode.naval = params.get('vnaval') !== 'old';
  mode.reflection = params.get('vrefl') === 'flat' ? 'flat' : 'colour';
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
  /** Surface water at the origin, or undefined on land; absent preserves ordinary shadows. */
  waterHeight?(x: number, z: number): number | undefined;
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

/**
 * The engine's shadow of a unit standing on the ground (YR 1.001 UnitClass draw 0x73C47A..0x73C5C4, FootClass
 * 0x4DB0D0, TechnoClass 0x706BD0 / 0x707280 / 0x753F90, locomotor Shadow_Matrix 0x55A7D0 and Shadow_Point 0x55A8C0):
 * the top-down silhouette of ONE body section (art ShadowIndex) on the bottom face of that section's bounds, turned
 * with the body and with the ramp under it, and drawn 3 px to the right of the unit's draw point (0x887420 =
 * -6 * light.x, light = (-0.5, -0.707, 0.5) from 0x754C00). No turret or barrel, no shear by height: the shadow is a
 * footprint that hugs the hull, visible as a band about three pixels wide under its right and lower edges. Replayed
 * offline from the voxel data, that model covers the darkened pixels of frozen original frames at 0.73 to 0.91
 * intersection over union; the earlier sheared projection (and its sun-following stretch) showed 2.6 to 4.3 times
 * the original's shadow area below the hull, which read as a vehicle hovering over a drop shadow.
 */
export const CONTACT_SHADOW_OFFSET_PX = 3;
/** World x (and -z) component of that offset: screen-right is (1, 0, -1) / sqrt 2 and a pixel is 1 / 42.4 units. */
export const CONTACT_SHADOW_OFFSET = CONTACT_SHADOW_OFFSET_PX / PIXELS_PER_CELL_EDGE / Math.SQRT2;
/**
 * Edge softness of a contact shadow in cells: a sixth of an engine pixel, enough to anti-alias the edge. The engine's
 * footprint is pixel-crisp and the visible band is only about three pixels wide: the earlier half-pixel penumbra
 * showed as a dark line under the whole lower outline of a hull (frozen same-frame pairs: 18 shadow pixels below a
 * miner driving towards the camera where the original has none).
 */
export const CONTACT_SHADOW_PENUMBRA = 0.004;
/**
 * A contact shadow darkens like the engine's own, whatever the look does to other shadows: the original halves the
 * ground under a vehicle (frozen same-frame pairs: 0.49 to 0.50 of the ground's brightness), and the enhanced look's
 * darker shadows (0.30 measured) turned the three-pixel band into a black outline that read as a gap under the hull.
 */
export const CONTACT_SHADOW_OPACITY = ENGINE_SHADOW_OPACITY;
/** A contact unit within this height of the registered ground lies on it (ramp corners are not exact planes). */
export const CONTACT_GROUND_TOLERANCE = 0.3 * LEVEL_HEIGHT;
/**
 * On sloped ground a contact footprint's depth plane is raised by this much beyond what its sample points ask for:
 * the registered height is the cell's bilinear surface, and the drawn triangles of a corner ramp stand up to a
 * quarter level above it.
 */
export const CONTACT_SLOPE_MARGIN = 0.25 * LEVEL_HEIGHT;
/** The most a contact footprint's depth plane is raised (a footprint that reaches over a cliff edge stays behind it). */
export const CONTACT_CLEARANCE_MAX = LEVEL_HEIGHT;

const sample = new Vector3();
/**
 * How far the plane through `origin` with `normal` must rise so that it is nowhere under the ground beneath a contact
 * footprint (`matrix` lays the body's local x/z box onto the drawn plane). The twin's depth is one analytic plane; the
 * surface it lies on is not where a ramp begins or ends or on a corner ramp, and there the ground's own depth hid the
 * footprint: a vehicle entering a ramp lost its shadow for several frames (frozen pairs with the hull hidden: 0 to 25
 * visible pixels where the original shows 91 to 169). Level ground asks for nothing.
 */
export function contactClearance(
  ground: ShadowGround,
  normal: Vector3,
  origin: Vector3,
  matrix: Matrix4,
  box: { min: Vector3; max: Vector3 } | null | undefined,
): number {
  if (!box || !(box.max.x >= box.min.x) || !(box.max.z >= box.min.z)) return 0;
  let clear = 0;
  let sloped = Math.abs(normal.y) < 0.9999;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      sample
        .set(box.min.x + ((box.max.x - box.min.x) * i) / 2, 0, box.min.z + ((box.max.z - box.min.z) * j) / 2)
        .applyMatrix4(matrix);
      const plane = origin.y - (normal.x * (sample.x - origin.x) + normal.z * (sample.z - origin.z)) / normal.y;
      const surface = ground.height(sample.x, sample.z);
      if (Math.abs(surface - origin.y) > 1e-3) sloped = true;
      clear = Math.max(clear, surface - plane);
    }
  return sloped ? Math.min(clear + CONTACT_SLOPE_MARGIN, CONTACT_CLEARANCE_MAX) : 0;
}

interface ShadowContact {
  /** Plane the footprint is drawn in; null = the ground's own plane under the unit. */
  normal: Vector3 | null;
  /** The footprint lies on the bottom face of the body's bounds instead of the plane through the unit's origin. */
  bottomFace: boolean;
  /** Rise of the depth plane over the ground under the footprint (contactClearance), set by the first twin. */
  clearance: number;
}
const contacts = new WeakMap<Object3D, ShadowContact>();

/**
 * Mark a unit root as standing on a surface at its own origin (terrain, a bridge deck): it then casts the engine's
 * contact shadow there instead of the sheared projection onto the registered ground. `normal` is the plane of a body
 * the host tilts itself; without it the footprint lies on the ground under the unit (level off the terrain).
 * `false` restores the ordinary rules (flight, water, shear). `bottomFace` puts the footprint on the bottom face of
 * the body's bounds, where the engine draws a vehicle's (the section's lowest voxel layer, which a few models keep
 * well below their origin: the Chrono Miner by four voxels); without it the plane passes through the origin.
 */
export function setShadowContact(unit: Object3D, contact: boolean, normal?: Vector3, bottomFace = false): void {
  if (!contact) {
    contacts.delete(unit);
    return;
  }
  let stored = contacts.get(unit);
  if (!stored) contacts.set(unit, (stored = { normal: null, bottomFace, clearance: 0 }));
  stored.bottomFace = bottomFace;
  if (!normal) stored.normal = null;
  else (stored.normal ??= new Vector3()).copy(normal).normalize();
}

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

/** Straight-down footprint, optionally scaled in xz about the unit origin, lifted above its water plane. */
export function waterContactProjection(point: Vector3, scale = 1, out = new Matrix4()): Matrix4 {
  return out.set(
    scale,
    0,
    0,
    point.x * (1 - scale),
    0,
    0,
    0,
    point.y + SHADOW_LIFT,
    0,
    0,
    scale,
    point.z * (1 - scale),
    0,
    0,
    0,
    1,
  );
}

/** Extend bow/wake along the source's +x nose, retaining a narrower rim across the hull at every facing. */
export function waterFoamProjection(point: Vector3, source: Matrix4, pulse = 0, out = new Matrix4()): Matrix4 {
  const e = source.elements;
  const length = Math.hypot(e[0]!, e[2]!);
  const fx = length > 0 ? e[0]! / length : 1;
  const fz = length > 0 ? e[2]! / length : 0;
  const side = WATER_FOAM_SCALE + 0.02 * pulse;
  const extra = WATER_FOAM_FORWARD_SCALE - WATER_FOAM_SCALE;
  const xx = side + extra * fx * fx;
  const xz = extra * fx * fz;
  const zz = side + extra * fz * fz;
  return out.set(
    xx,
    0,
    xz,
    point.x * (1 - xx) - point.z * xz,
    0,
    0,
    0,
    point.y + SHADOW_LIFT,
    xz,
    0,
    zz,
    point.z * (1 - zz) - point.x * xz,
    0,
    0,
    0,
    1,
  );
}

/** Smooth value noise: two cell sizes keep the rim patchy without textures or a wall-clock dependency. */
function waterFoamNoise(p: ShaderNode, clock: ShaderNode): ShaderNode {
  const drifting = p.add(vec2(clock.mul(0.018), clock.mul(-0.012)));
  const noise = (scale: number): ShaderNode => {
    const v: ShaderNode = drifting.mul(scale);
    const i: ShaderNode = floor(v);
    const f: ShaderNode = fract(v);
    const u: ShaderNode = f.mul(f).mul(float(3).sub(f.mul(2)));
    const hash = (q: ShaderNode): ShaderNode => fract(sin(q.dot(vec2(127.1, 311.7))).mul(43758.5453));
    return mix(
      mix(hash(i), hash(i.add(vec2(1, 0))), u.x),
      mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x),
      u.y,
    );
  };
  return noise(5)
    .mul(2 / 3)
    .add(noise(10).mul(1 / 3));
}

/** Mirror about water, then intersect the view ray with the lifted plane: screen xy equals the mirrored point. */
export function waterReflectionProjection(point: Vector3, toCamera: Vector3, out = new Matrix4()): Matrix4 {
  const x = toCamera.x / toCamera.y,
    z = toCamera.z / toCamera.y;
  return out.set(
    1,
    x,
    0,
    x * (SHADOW_LIFT - point.y),
    0,
    0,
    0,
    point.y + SHADOW_LIFT,
    0,
    z,
    1,
    z * (SHADOW_LIFT - point.y),
    0,
    0,
    0,
    1,
  );
}

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
type WaterLayer = 'foam' | 'reflection';
type SurfaceLayer = 'shadow' | WaterLayer;
const sharedMaterials = new WeakMap<AtmosphereNodes, Map<SurfaceLayer, MeshBasicNodeMaterial>>();
const reflectionMaterials = new WeakMap<AtmosphereNodes, WeakMap<Material, MeshBasicNodeMaterial>>();
export function voxelShadowMaterial(nodes = DEFAULT_ATMOSPHERE_NODES): MeshBasicNodeMaterial {
  return voxelSurfaceMaterial(nodes, 'shadow');
}

export function voxelWaterMaterial(
  nodes: AtmosphereNodes,
  layer: WaterLayer,
  sourceMaterial?: Material,
): MeshBasicNodeMaterial {
  if (layer === 'reflection' && sourceMaterial && voxelShadowFor(nodes).reflection === 'colour') {
    sourceMaterial = voxelReflectionSource(sourceMaterial);
    let materials = reflectionMaterials.get(nodes);
    if (!materials) reflectionMaterials.set(nodes, (materials = new WeakMap()));
    let material = materials.get(sourceMaterial);
    if (!material) {
      material = createSurfaceMaterial(nodes, layer, sourceMaterial);
      materials.set(sourceMaterial, material);
    }
    return material;
  }
  return voxelSurfaceMaterial(nodes, layer);
}

function voxelSurfaceMaterial(nodes: AtmosphereNodes, layer: SurfaceLayer): MeshBasicNodeMaterial {
  let materials = sharedMaterials.get(nodes);
  if (!materials) sharedMaterials.set(nodes, (materials = new Map()));
  const shared = materials.get(layer);
  if (shared) return shared;
  const material = createSurfaceMaterial(nodes, layer);
  materials.set(layer, material);
  return material;
}

function createSurfaceMaterial(
  nodes: AtmosphereNodes,
  layer: SurfaceLayer,
  sourceMaterial?: Material,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    color: layer === 'foam' ? 0xddeef5 : layer === 'reflection' ? new Color(0.16, 0.19, 0.22) : 0x000000,
  });
  material.name = `voxel-${layer}${sourceMaterial ? '-colour' : ''}`;
  material.transparent = true;
  material.opacity = SHADOW_OPACITY;
  const look = spriteLookFor(nodes);
  const mode = voxelShadowFor(nodes);
  const opacity = uniform(SHADOW_OPACITY).onObjectUpdate(({ object }) => {
    const surface = object instanceof VoxelSurfaceMesh ? object : undefined;
    if (layer === 'reflection') return sourceMaterial ? WATER_REFLECTION_OPACITY : WATER_FLAT_REFLECTION_OPACITY;
    if (layer === 'foam') return shadowCopyOpacity(WATER_FOAM_OPACITY * (1 + 0.03 * (surface?.foamPulse ?? 0)));
    if (surface?.onWater) return shadowCopyOpacity(WATER_CONTACT_OPACITY * nodes.weatherSunShare.value);
    const target = surface?.contact
      ? CONTACT_SHADOW_OPACITY
      : look.enabled.value > 0.5 && look.shadowDarkness.value !== 1
        ? Math.min(SHADOW_OPACITY * look.shadowDarkness.value, 0.9)
        : SHADOW_OPACITY;
    return shadowCopyOpacity(
      target * nodes.weatherSunShare.value * nodes.sceneSunShadow.value,
      mode.soft ? SHADOW_COPIES.length : 1,
    );
  });
  material.opacityNode = opacity;
  // Black shadow/contact RGB needs no second event factor. The coloured reflection and waterline foam do.
  if (layer !== 'shadow') material.colorNode = sceneLitColour(uniform(material.color), nodes.sceneObjectMul);
  if (layer !== 'shadow') {
    // A real mirror reverses winding. Flattening preserves its screen winding but makes the matrix singular,
    // hiding the negative determinant from Three's automatic front-face flip. Cull the mirrored rear surfaces
    // explicitly for colour; the legacy silhouette and foam retain their original double-sided coverage.
    material.side = sourceMaterial ? BackSide : DoubleSide;
    material.forceSinglePass = true; // Analytic depth already rejects duplicate faces; avoid transparent back/front passes.
    // Retain the complete source basis: the drawn matrix is singular. Geometry coordinates and this independent
    // matrix supply height, atlas facing and house paint without ever using the flattened normal matrix.
    const sourceMatrix = uniform(new Matrix4()).onObjectUpdate(({ object }) => {
      if (object instanceof VoxelSurfaceMesh) sourceMatrix.value.copy(object.source.matrixWorld);
    });
    const waterY = uniform(0).onObjectUpdate(({ object }) => (object instanceof VoxelSurfaceMesh ? object.waterY : 0));
    const clock = uniform(0).onRenderUpdate(() => mode.time);
    const height = sourceMatrix.mul(vec4(positionGeometry, 1)).y.sub(waterY);
    if (layer === 'foam') {
      const waterline = float(1).sub(smoothstep(0.06, 0.14, height));
      const patches = smoothstep(0.4, 0.7, waterFoamNoise(positionWorld.xz, clock));
      material.opacityNode = opacity.mul(waterline).mul(patches);
    } else {
      if (sourceMaterial) material.colorNode = voxelReflectionColour(sourceMaterial, sourceMatrix);
      const ripple = sin(
        positionWorld.z
          .mul(36)
          .add(clock.mul(0.8))
          .add(sin(positionWorld.x.mul(20).add(clock.mul(0.5))).mul(0.6)),
      )
        .mul(0.12)
        .add(0.88);
      material.opacityNode = opacity.mul(float(1).sub(abs(height).div(WATER_REFLECTION_FADE)).clamp()).mul(ripple);
    }
    material.alphaTest = 0.001;
  }
  material.depthWrite = true;
  material.depthFunc = LessDepth;
  const plane = uniform(new Vector4());
  plane.onObjectUpdate(({ object, camera, renderer }) => {
    if (!renderer || !camera) return;
    const target = renderer.getRenderTarget();
    if (target) planeSize.set(target.width, target.height);
    else renderer.getDrawingBufferSize(planeSize);
    const shadow = object instanceof VoxelSurfaceMesh ? object : undefined;
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
  nodes.own(material);
  return material;
}

/**
 * Silhouette geometries: a coarse mesh with the outline of a part geometry (within a fraction of a voxel), built
 * on first use. A twin that draws a part's outline alone (the ground shadow, the waterline foam: flat colour through
 * a projection that flattens the part) draws it in place of the part's own geometry: a redraw-quality part has
 * dozens of triangles per screen pixel, five shadow twins of every part drew all of them again, and in a battle
 * four of every five triangles of the frame were shadow (measured: 48 of 59 million with a hundred vehicles in view).
 * The colour reflection reads the part's own attributes and keeps its geometry.
 */
const silhouettes = new WeakMap<BufferGeometry, BufferGeometry | (() => BufferGeometry)>();

/**
 * `build` makes the silhouette of `geometry` when a twin first needs it; it is disposed with `geometry`. Call once
 * per geometry, by whoever builds it (it knows what the geometry was made from).
 */
export function registerSilhouetteGeometry(geometry: BufferGeometry, build: () => BufferGeometry): void {
  silhouettes.set(geometry, build);
  const release = (): void => {
    geometry.removeEventListener('dispose', release);
    const made = silhouettes.get(geometry);
    silhouettes.delete(geometry);
    if (made && typeof made !== 'function') made.dispose();
  };
  geometry.addEventListener('dispose', release);
}

/** The registered silhouette of `geometry` (built now if this is its first use), or `geometry` itself. */
export function silhouetteGeometry(geometry: BufferGeometry): BufferGeometry {
  const entry = silhouettes.get(geometry);
  if (!entry) return geometry;
  if (typeof entry !== 'function') return entry;
  const made = entry();
  silhouettes.set(geometry, made);
  return made;
}

/** What a twin of `layer` draws for a part with `geometry`. */
function surfaceGeometry(geometry: BufferGeometry, layer: SurfaceLayer): BufferGeometry {
  return layer === 'reflection' ? geometry : silhouetteGeometry(geometry);
}

/**
 * `userData` key of a silhouette geometry: how many of its leading indices draw the faces that look up the part's
 * own up axis (+y). A closed surface's upward faces cover everything the whole surface covers once it is flattened
 * along that axis, and they are the faces that survive back-face culling there: the contact footprint draws only
 * them (the others were transformed and then culled, five times per part and frame).
 */
export const SILHOUETTE_FOOTPRINT = 'silhouetteFootprintIndices';
const footprints = new WeakMap<BufferGeometry, BufferGeometry>();

/** The leading footprint range of `silhouette` as a geometry over the same buffers, or `silhouette` without one. */
export function footprintGeometry(silhouette: BufferGeometry): BufferGeometry {
  const count: unknown = silhouette.userData[SILHOUETTE_FOOTPRINT];
  const index = silhouette.index;
  if (typeof count !== 'number' || !index || count <= 0 || count >= index.count) return silhouette;
  let view = footprints.get(silhouette);
  if (!view) {
    view = new BufferGeometry();
    // The same attribute and index objects: three keeps one GPU buffer for each.
    for (const name of Object.keys(silhouette.attributes)) view.setAttribute(name, silhouette.getAttribute(name));
    view.setIndex(index);
    view.setDrawRange(0, count);
    view.boundingSphere = silhouette.boundingSphere;
    view.boundingBox = silhouette.boundingBox;
    footprints.set(silhouette, view);
    const made = view;
    const release = (): void => {
      silhouette.removeEventListener('dispose', release);
      footprints.delete(silhouette);
      made.dispose();
    };
    silhouette.addEventListener('dispose', release);
  }
  return view;
}

const point = new Vector3();
const origin = new Vector3();
const normal = new Vector3();
const projection = new Matrix4();
const bodyUp = new Vector3();
const axisX = new Vector3();
const axisZ = new Vector3();
const retilt = new Quaternion();

/**
 * Flattened twin of a voxel part. Add it to the unit's root group after every part (the scene graph updates children
 * in order, so the source's world matrix is current by then); it follows the source's pose every frame.
 */
class VoxelSurfaceMesh extends Mesh {
  readonly planeNormal = new Vector3(0, 1, 0);
  planeConstant = SHADOW_LIFT;
  onWater = false;
  /** This twin currently draws the engine's contact footprint (see setShadowContact). */
  contact = false;
  waterY = 0;
  foamPulse = 0;
  private readonly mode: VoxelShadowState;
  private readonly nodes: AtmosphereNodes;

  constructor(
    readonly source: Mesh,
    nodes = DEFAULT_ATMOSPHERE_NODES,
    readonly copyIndex = 0,
    readonly layer: SurfaceLayer = 'shadow',
  ) {
    const outline = surfaceGeometry(source.geometry, layer);
    super(outline, voxelSurfaceMaterial(nodes, layer));
    this.sourceGeometry = source.geometry;
    this.outline = outline;
    this.mode = voxelShadowFor(nodes);
    this.nodes = nodes;
    if (layer === 'reflection') this.updateReflectionMaterial();
    this.name = `voxel-${layer}`;
    this.matrixAutoUpdate = false;
    this.castShadow = false;
    this.receiveShadow = false;
    // After the sprite layers (4): over their ground decals (lifted less), behind upright art and voxel bodies.
    this.renderOrder = (layer === 'reflection' ? 4.49 : layer === 'foam' ? 4.51 : 4.5) + copyIndex * 0.001;
    this.visible = this.wanted = layer === 'shadow' && (copyIndex === 0 || this.mode.soft);
  }

  /**
   * The colour reflection reads the source part's palette and redraw through the slots of the source material's
   * shader graph (materialSlots.ts): bind the part this twin mirrors before it is drawn.
   */
  override onBeforeRender = (): void => {
    if (this.layer === 'reflection') bindSlots(this.source.material);
  };

  /** The source's geometry this twin's own was chosen for (a part changes geometry when its final mesh arrives). */
  private sourceGeometry: BufferGeometry;
  /** What this twin draws of it: the part's silhouette, or the part itself (see surfaceGeometry). */
  private outline: BufferGeometry;

  /** Visibility the review modes and the water test ask for, applied only when it changes: hiding by other code (the
   * sandbox bake's isolation, review tooling) is never overridden every frame. */
  private wanted: boolean;
  private updateReflectionMaterial(): void {
    // Production voxel parts each have one material. Unknown multi-material meshes keep the flat fallback.
    const source = Array.isArray(this.source.material) ? undefined : this.source.material;
    this.material = voxelWaterMaterial(this.nodes, 'reflection', source);
  }
  private show(wanted: boolean): void {
    if (wanted !== this.wanted) this.visible = this.wanted = wanted;
  }

  override updateMatrixWorld(force?: boolean): void {
    if (this.sourceGeometry !== this.source.geometry) {
      this.sourceGeometry = this.source.geometry;
      this.outline = surfaceGeometry(this.sourceGeometry, this.layer);
    }
    const drawn = this.place(force) ? footprintGeometry(this.outline) : this.outline;
    if (this.geometry !== drawn) this.geometry = drawn;
  }

  /** Pose this twin for the frame. True when it draws the contact footprint: the part flattened along its up axis. */
  private place(force?: boolean): boolean {
    if (this.layer === 'reflection') this.updateReflectionMaterial();
    const land = this.layer === 'shadow' && (this.copyIndex === 0 || this.mode.soft);
    this.onWater = false;
    this.contact = false;
    const parent = this.parent;
    const ground = groundOf(this);
    if (!parent || !ground) {
      this.show(land);
      super.updateMatrixWorld(force);
      return false;
    }
    // An override casts from a physical origin instead of a render-offset root, always with ground shear. Otherwise
    // vehicles use their own origin; aircraft and jumpjets drop onto the terrain/water and shrink with their height.
    const e = parent.matrixWorld.elements;
    origin.set(e[12]!, e[13]!, e[14]!);
    const physicalOrigin = shadowOrigins.get(parent);
    const anchor = physicalOrigin ?? origin;
    point.set(anchor.x, ground.height(anchor.x, anchor.z), anchor.z);
    const height = origin.y - point.y;
    const waterY = !physicalOrigin && this.mode.naval ? ground.waterHeight?.(origin.x, origin.z) : undefined;
    this.onWater = waterY !== undefined && Math.abs(origin.y - waterY) <= AIRBORNE_HEIGHT;
    const contact = physicalOrigin || this.onWater ? undefined : contacts.get(parent);
    // Water contact/foam always retain the penumbra, independently of land's hard review mode. A contact shadow is
    // the body's footprint alone: turret and barrel twins rest.
    this.show(this.onWater || (land && !(contact && this.source.parent !== parent)));
    if (this.layer !== 'shadow' && !this.onWater) return false;
    if (contact) {
      if (this.source.parent !== parent) return false;
      this.contact = true;
      // Depth follows the ground the unit stands on (a ramp tilts the body more steeply than the terrain it is on).
      if (ground.normal && Math.abs(origin.y - ground.height(origin.x, origin.z)) < CONTACT_GROUND_TOLERANCE)
        ground.normal(origin.x, origin.z, normal);
      else normal.copy(UP);
      const drawn = contact.normal ?? normal;
      bodyUp.set(e[4]!, e[5]!, e[6]!);
      // Height of the footprint's plane above the origin along the drawn normal: the body's lowest face.
      let bottom = 0;
      if (contact.bottomFace) {
        const geometry = this.source.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box && !box.isEmpty()) bottom = box.min.y * bodyUp.length();
      }
      bodyUp.normalize();
      retilt.setFromUnitVectors(bodyUp, drawn);
      axisX.set(e[0]!, e[1]!, e[2]!).applyQuaternion(retilt);
      axisZ.set(e[8]!, e[9]!, e[10]!).applyQuaternion(retilt);
      // Three pixels to the right on screen: slide that offset along the view ray into the footprint's plane.
      const view = this.mode.toCamera;
      const k = CONTACT_SHADOW_OFFSET;
      const slide = -((drawn.x - drawn.z) * k) / drawn.dot(view);
      const copy = SHADOW_COPIES[this.copyIndex]!;
      const soft = CONTACT_SHADOW_PENUMBRA / SHADOW_PENUMBRA;
      const cx = copy.x * soft;
      const cz = copy.z * soft;
      const cy = -(drawn.x * cx + drawn.z * cz) / drawn.y;
      // The picture is exactly the footprint through the unit's origin; only the analytic depth is lifted.
      this.matrixWorld.set(
        axisX.x,
        0,
        axisZ.x,
        origin.x + k + slide * view.x + cx + bottom * drawn.x,
        axisX.y,
        0,
        axisZ.y,
        origin.y + slide * view.y + cy + bottom * drawn.y,
        axisX.z,
        0,
        axisZ.z,
        origin.z - k + slide * view.z + cz + bottom * drawn.z,
        0,
        0,
        0,
        1,
      );
      // One measure per unit and frame: the first twin samples the ground under the footprint, the others reuse it.
      if (this.copyIndex === 0) {
        const geometry = this.source.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        contact.clearance = contactClearance(
          ground,
          normal,
          origin,
          this.matrixWorld,
          box && !box.isEmpty() ? box : null,
        );
      }
      this.planeNormal.copy(normal);
      this.planeConstant = normal.dot(origin) + SHADOW_LIFT + copy.lift + contact.clearance * normal.y;
      this.matrixWorldNeedsUpdate = false;
      for (const child of this.children) child.updateMatrixWorld(force);
      // Flattened along the body's own up axis: its upward faces are the whole footprint.
      return true;
    }
    if (this.onWater) {
      this.waterY = waterY!;
      this.foamPulse = Math.sin(this.mode.time * Math.PI);
      point.y = this.waterY;
      normal.copy(UP);
      if (this.layer === 'reflection') waterReflectionProjection(point, this.mode.toCamera, projection);
      else if (this.layer === 'foam') waterFoamProjection(point, this.source.matrixWorld, this.foamPulse, projection);
      else waterContactProjection(point, 1, projection);
      if (this.layer === 'shadow') projection.elements[13] += WATER_CONTACT_LIFT;
      // Reflection is the lowest decal. Moving along the view ray keeps its screen position unchanged.
      if (this.layer === 'reflection') {
        projection.elements[12] -= (SHADOW_COPY_LIFT * this.mode.toCamera.x) / this.mode.toCamera.y;
        projection.elements[13] -= SHADOW_COPY_LIFT;
        projection.elements[14] -= (SHADOW_COPY_LIFT * this.mode.toCamera.z) / this.mode.toCamera.y;
      }
    } else if (!physicalOrigin && height > AIRBORNE_HEIGHT) {
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
    if (this.onWater)
      this.planeConstant +=
        this.layer === 'shadow' ? WATER_CONTACT_LIFT : this.layer === 'reflection' ? -SHADOW_COPY_LIFT : 0;
    this.matrixWorld.multiplyMatrices(projection, this.source.matrixWorld);
    this.matrixWorldNeedsUpdate = false;
    for (const child of this.children) child.updateMatrixWorld(force);
    return false;
  }
}

/** Land/air shadow twin, switching to straight-down contact darkening at a grounded water origin. */
export class VoxelShadowMesh extends VoxelSurfaceMesh {}

/** Water-only twins; hidden on land, in flight, for physical-origin overrides and in old naval review mode. */
export class VoxelWaterMesh extends VoxelSurfaceMesh {
  constructor(source: Mesh, nodes: AtmosphereNodes | undefined, layer: WaterLayer, copyIndex = 0) {
    super(source, nodes, copyIndex, layer);
  }
}
