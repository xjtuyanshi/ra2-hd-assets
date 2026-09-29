import type { Group } from 'three/webgpu';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import type { HdRenderer } from '../HdRenderer';
import type { Ra2Cache } from '../ra2/cache';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  VoxelUnit as VoxelRoot,
  type VoxelGeometry,
} from '../ra2/voxels';
import type { HdWorld } from '../ra2/world';
import { LEVEL_HEIGHT } from '../world';

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
 * Voxel vehicles and aircraft of the live view: builds meshes from VXL models (one geometry set per type and palette
 * row, because house colours are baked into the vertex colours) and places them from engine poses. LiveView keeps
 * the bookkeeping (which object uses which unit); everything about how a voxel unit looks lives here.
 */
export class VoxelUnits {
  private readonly material: ReturnType<typeof createVoxelMaterial>;
  private readonly geometries = new Map<string, VoxelGeometry[]>();

  constructor(
    readonly hd: HdRenderer,
    readonly world: HdWorld,
    private readonly cache: Ra2Cache,
    readonly libraryBase?: string,
  ) {
    this.material = createVoxelMaterial(hd.nodes);
  }

  /**
   * A new instance of `model` drawn with palette row `paletteKey` (already resolved with paletteFor, so house-remapped
   * when the owner is known). `cacheKey` identifies the geometry set to share, e.g. `${type}@${paletteKey}`.
   */
  build(model: VoxelModel, paletteKey: string, cacheKey: string): VoxelUnit {
    let parts = this.geometries.get(cacheKey);
    if (!parts) {
      parts = buildVoxelGeometry(model, this.cache.paletteRgb.get(paletteKey)!);
      this.geometries.set(cacheKey, parts);
    }
    return instantiateVoxel(parts, this.material);
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

  /** Keep physical poses/shadows unchanged while all of an object's meshes share its painter slot. */
  setPainterDepth(unit: VoxelUnit, depth: number, width: number, part = 0): void {
    if (unit.root instanceof VoxelRoot) unit.root.setPainterDepth(depth, width, part);
  }

  /** Take a unit out of the scene (geometry stays cached for the next instance of its type). */
  dispose(unit: VoxelUnit): void {
    unit.root.removeFromParent();
  }
}
