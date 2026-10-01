import { Mesh, type Group } from 'three/webgpu';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import type { HdRenderer } from '../HdRenderer';
import type { Ra2Cache } from '../ra2/cache';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  projectVoxelMaterials,
  VoxelUnit as VoxelRoot,
  type VoxelGeometry,
} from '../ra2/voxels';
import type { HdWorld } from '../ra2/world';
import { LEVEL_HEIGHT } from '../world';
import { smoothVoxelOptions, type SmoothVoxelOptions } from '../ra2/voxelSmooth';
import { buildSmoothVoxelGeometry } from '../ra2/voxelSmoothGeometry';
import { projectionParts, voxelProjectionLibrary, type VoxelProjectionLibrary } from '../ra2/voxelProjection';

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
   * A new instance of `model` drawn with palette row `paletteKey` (already resolved with paletteFor, so house-remapped
   * when the owner is known). `cacheKey` identifies the geometry set to share, e.g. `${type}@${paletteKey}`.
   */
  build(model: VoxelModel, paletteKey: string, cacheKey: string): VoxelUnit {
    let parts = this.geometries.get(cacheKey);
    if (!parts) {
      parts =
        this.voxelLook === 'remaster'
          ? buildSmoothVoxelGeometry(model, this.cache.paletteRgb.get(paletteKey)!, this.hd.nodes, this.smoothVoxel)
          : buildVoxelGeometry(model, this.cache.paletteRgb.get(paletteKey)!, this.hd.nodes);
      this.geometries.set(cacheKey, parts);
      const projection = this.projections;
      if (projection) {
        const palette = this.cache.paletteRgb.get(paletteKey)!;
        const required = projectionParts(parts);
        if (!projectVoxelMaterials(parts, palette, projection.get(model.id, required), this.hd.nodes)) {
          const waiting = new Set<VoxelUnit>();
          const target = parts;
          this.pending.set(target, waiting);
          void projection.loadType(model.id, required).then((asset) => {
            if (projectVoxelMaterials(target, palette, asset, this.hd.nodes)) {
              const materials = new Map(target.map((part) => [part.geometry, part.material!]));
              for (const unit of waiting)
                unit.root.traverse((mesh) => {
                  // Shadow twins share geometry but own their shadow material and must never be repainted.
                  if (mesh instanceof Mesh && mesh.userData.painterDepth) {
                    const material = materials.get(mesh.geometry);
                    if (material) mesh.material = material;
                  }
                });
            }
            waiting.clear();
            this.pending.delete(target);
          });
        }
      }
    }
    const unit = instantiateVoxel(parts, this.material, this.hd.nodes);
    this.pending.get(parts)?.add(unit);
    return unit;
  }

  /**
   * Place a unit at an engine pose. Engine facing 0 = north (world -z), clockwise; the model's nose is local +x. The
   * turret yaws relative to the body (`turretFacing` in radians like `facing`; null = aligned with the body).
   */
  pose(unit: VoxelUnit, pose: VoxelPose, turretFacing: number | null): void {
    unit.root.position.set(
      pose.x / LEPTONS_PER_CELL,
      (pose.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT,
      pose.y / LEPTONS_PER_CELL,
    );
    unit.root.rotation.y = Math.PI / 2 - pose.facing;
    if (unit.turret) unit.turret.rotation.y = pose.facing - (turretFacing ?? pose.facing);
  }

  /** Preserve full mesh depth; no slot compression or override of physical overlays. */
  setPainterBias(unit: VoxelUnit, bias: number): void {
    if (unit.root instanceof VoxelRoot) unit.root.setPainterBias(bias);
  }

  /** Take a unit out of the scene (geometry stays cached for the next instance of its type). */
  dispose(unit: VoxelUnit): void {
    for (const waiting of this.pending.values()) waiting.delete(unit);
    unit.root.removeFromParent();
  }
}
