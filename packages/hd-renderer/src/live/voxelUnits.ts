import { Mesh, type Group, type Vector3 } from 'three/webgpu';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import type { HdRenderer } from '../HdRenderer';
import type { Ra2Cache } from '../ra2/cache';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  projectVoxelMaterials,
  updateVoxelNativeDepth,
  VoxelUnit as VoxelRoot,
  type VoxelGeometry,
} from '../ra2/voxels';
import type { HdWorld } from '../ra2/world';
import { NOT_CAPTURED_CODE } from '../objectDepth';
import { LEVEL_HEIGHT } from '../world';
import { smoothVoxelOptions, type SmoothVoxelOptions } from '../ra2/voxelSmooth';
import { buildSmoothVoxelGeometry } from '../ra2/voxelSmoothGeometry';
import { projectionParts, voxelProjectionLibrary, type VoxelProjectionLibrary } from '../ra2/voxelProjection';
import { setShadowContact } from '../ra2/voxelShadow';
import type { VoxelCardTies } from '../ra2/voxelNativeDepth';

export interface VoxelUnitsOptions {
  voxelLook?: 'engine' | 'remaster';
  smoothVoxel?: Partial<SmoothVoxelOptions>;
  voxelProjection?: string;
}

const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/** A placed voxel unit: the body root and, for Turret=yes types, the group the turret (and barrel) yaw in. */
export interface VoxelUnit {
  root: Group;
  turret?: Group;
}

/** Engine pose of a unit: lepton coordinates and a facing in radians (0 = north, clockwise). */
export interface VoxelPose {
  x: number;
  y: number;
  z: number;
  facing: number;
}

/**
 * Voxel vehicles and aircraft of the live view: geometry is shared across house palettes; each palette gets its own
 * LUT material. Places the models from engine poses. LiveView keeps
 * the bookkeeping (which object uses which unit); everything about how a voxel unit looks lives here.
 */
export class VoxelUnits {
  private readonly material: ReturnType<typeof createVoxelMaterial>;
  private readonly geometries = new Map<string, VoxelGeometry[]>();
  private readonly voxelLook: 'engine' | 'remaster';
  private readonly smoothVoxel: Readonly<SmoothVoxelOptions>;
  private readonly projections?: VoxelProjectionLibrary;
  /** Instances waiting for one asynchronous type load; cleared once, never visited by pose()/the frame loop. */
  private readonly pending = new Map<VoxelGeometry[], Set<VoxelUnit>>();

  constructor(
    readonly hd: HdRenderer,
    readonly world: HdWorld,
    private readonly cache: Ra2Cache,
    readonly libraryBase?: string,
    options: VoxelUnitsOptions = {},
  ) {
    this.voxelLook = options.voxelLook ?? world.voxelLook ?? hd.settings.voxelLook;
    this.smoothVoxel = smoothVoxelOptions({ ...world.smoothVoxel, ...options.smoothVoxel });
    const projectionBase = options.voxelProjection ?? world.voxelProjection;
    this.projections = projectionBase ? voxelProjectionLibrary(projectionBase, hd.nodes) : world.projections;
    if (this.voxelLook === 'remaster') hd.settings.voxelLook = 'remaster';
    this.material = createVoxelMaterial(hd.nodes);
  }

  /**
   * The shared geometry set of `model` for palette row `paletteKey`, built once per `cacheKey`; its redraw projection
   * (when the look has one) is requested here and repaints every waiting instance when it arrives.
   */
  private partsFor(model: VoxelModel, paletteKey: string, cacheKey: string): VoxelGeometry[] {
    let parts = this.geometries.get(cacheKey);
    if (parts) return parts;
    parts =
      this.voxelLook === 'remaster'
        ? buildSmoothVoxelGeometry(model, this.cache.paletteRgb.get(paletteKey)!, this.hd.nodes, this.smoothVoxel)
        : buildVoxelGeometry(model, this.cache.paletteRgb.get(paletteKey)!, this.hd.nodes);
    this.geometries.set(cacheKey, parts);
    const projection = this.projections;
    if (!projection) return parts;
    const palette = this.cache.paletteRgb.get(paletteKey)!;
    const required = projectionParts(parts);
    if (projectVoxelMaterials(parts, palette, projection.get(model.id, required), this.hd.nodes)) return parts;
    const waiting = new Set<VoxelUnit>();
    const target = parts;
    this.pending.set(target, waiting);
    void projection.loadType(model.id, required).then((asset) => {
      if (projectVoxelMaterials(target, palette, asset, this.hd.nodes)) {
        const materials = new Map(target.map((part) => [part.geometry, part.material!]));
        for (const unit of waiting) {
          unit.root.traverse((mesh) => {
            // Shadow twins share geometry but own their shadow material and must never be repainted.
            if (mesh instanceof Mesh && mesh.userData.painterDepth) {
              const material = materials.get(mesh.geometry);
              if (material) mesh.material = material;
            }
          });
          // A resting unit may receive no new pose after this callback. Preserve its active color/depth
          // pass immediately instead of showing the new physical source until a later publication.
          if (unit.root instanceof VoxelRoot) {
            const { anchor, bonus, enabled } = unit.root.nativeDepth;
            updateVoxelNativeDepth(unit, anchor, bonus, enabled !== 0);
          }
        }
      }
      waiting.clear();
      this.pending.delete(target);
    });
    return parts;
  }

  /**
   * Build the shared geometry and request its projection ahead of the first instance. True once a new instance
   * would draw its final look at once (the projection has arrived, is absent or failed); callers that swap one model
   * for another on the same object keep the old one on screen until then.
   */
  prepare(model: VoxelModel, paletteKey: string, cacheKey: string): boolean {
    return !this.pending.has(this.partsFor(model, paletteKey, cacheKey));
  }

  /**
   * A new instance of `model` drawn with palette row `paletteKey` (already resolved with paletteFor, so house-remapped
   * when the owner is known). `cacheKey` identifies the geometry set to share, e.g. `${type}@${paletteKey}`.
   */
  build(model: VoxelModel, paletteKey: string, cacheKey: string): VoxelUnit {
    const parts = this.partsFor(model, paletteKey, cacheKey);
    const unit = instantiateVoxel(parts, this.material, this.hd.nodes);
    this.pending.get(parts)?.add(unit);
    return unit;
  }

  /**
   * Place a unit at an engine pose. Engine facing 0 = north (world -z), clockwise; the model's nose is local +x. The
   * turret yaws relative to the body (`turretFacing` in radians like `facing`; null = aligned with the body).
   */
  pose(unit: VoxelUnit, pose: VoxelPose, turretFacing: number | null, up?: Vector3 | null): void {
    unit.root.position.set(
      pose.x / LEPTONS_PER_CELL,
      (pose.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT,
      pose.y / LEPTONS_PER_CELL,
    );
    unit.root.rotation.y = Math.PI / 2 - pose.facing;
    if (unit.turret) unit.turret.rotation.y = pose.facing - (turretFacing ?? pose.facing);
    // `up` (world axes) is the game's own body tilt; without it the root follows the registered ground.
    if (unit.root instanceof VoxelRoot) unit.root.setSurfaceUp(up ?? null);
  }

  /**
   * A unit standing on terrain or a bridge deck casts the engine's contact shadow at its own origin (see
   * voxelShadow.ts setShadowContact); `normal` is the plane of a tilted body, absent = the ground's own. `bottomFace`
   * lays the footprint on the bottom face of the body's bounds (vehicles).
   */
  setGroundContact(unit: VoxelUnit, grounded: boolean, normal?: Vector3, bottomFace = false): void {
    setShadowContact(unit.root, grounded, normal, bottomFace);
  }

  /** Painter bias remains additive to either physical flight depth or the native ground card. */
  setPainterBias(unit: VoxelUnit, bias: number): void {
    if (unit.root instanceof VoxelRoot) unit.root.setPainterBias(bias);
  }

  /** Native chrono blending changes body/turret/barrel alpha, never the separately rendered ground shadows. */
  setOpacity(unit: VoxelUnit, opacity: number): void {
    if (unit.root instanceof VoxelRoot) unit.root.setOpacity(opacity);
  }

  /**
   * Call after pose/turret updates; anchor is the world-space ground draw point, including bridge elevation. `ties`
   * resolves near-ties with the map's depth-writing cards for this unit as a whole.
   */
  setNativeDepth(unit: VoxelUnit, anchor: Vector3, bonus = 0, enabled = true, ties?: VoxelCardTies | null): void {
    updateVoxelNativeDepth(unit, anchor, bonus, enabled, ties);
  }

  /** Whole-object capture membership belongs only to original part meshes, including articulated barrels. */
  setCaptureCode(unit: VoxelUnit, code: number): void {
    if (unit.root instanceof VoxelRoot)
      for (const mesh of unit.root.partMeshes) this.hd.terrainDepth.setCaptured(mesh, code !== NOT_CAPTURED_CODE, code);
  }

  captureRadius(unit: VoxelUnit): number {
    return unit.root instanceof VoxelRoot ? unit.root.captureRadius : 0;
  }

  /** Take a unit out of the scene (geometry stays cached for the next instance of its type). */
  dispose(unit: VoxelUnit): void {
    this.setCaptureCode(unit, NOT_CAPTURED_CODE);
    for (const waiting of this.pending.values()) waiting.delete(unit);
    if (unit.root instanceof VoxelRoot) unit.root.disposeOpacityMaterials();
    unit.root.removeFromParent();
  }
}
