import { Mesh, type BufferGeometry, type Group, type Vector3 } from 'three/webgpu';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import type { HdRenderer } from '../HdRenderer';
import type { ObjectTint } from '../objectTint';
import type { Ra2Cache } from '../ra2/cache';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  projectVoxelMaterials,
  updateVoxelNativeDepth,
  VoxelUnit as VoxelRoot,
  voxelShapeFor,
  type VoxelGeometry,
} from '../ra2/voxels';
import type { HdWorld } from '../ra2/world';
import { NOT_CAPTURED_CODE } from '../objectDepth';
import { LEVEL_HEIGHT } from '../world';
import { smoothVoxelOptions, type SmoothVoxelOptions } from '../ra2/voxelSmooth';
import {
  buildSmoothVoxelGeometry,
  buildStandInVoxelParts,
  ensureSmoothVoxelGeometry,
  hasSmoothVoxelGeometry,
  prepareSmoothVoxelGeometry,
  smoothVoxelPartGeometries,
} from '../ra2/voxelSmoothGeometry';
import { voxelPbrMaterialFor } from '../ra2/voxelPbr';
import { createSmoothVoxelPool, type SmoothSectionBuilder } from '../ra2/voxelSmoothPool';
import { projectionParts, voxelProjectionLibrary, type VoxelProjectionLibrary } from '../ra2/voxelProjection';
import { setShadowContact } from '../ra2/voxelShadow';
import type { VoxelCardTies } from '../ra2/voxelNativeDepth';
import { selectedVoxelTurretIndex } from '../ra2/voxelTurrets';

export interface VoxelUnitsOptions {
  voxelLook?: 'engine' | 'remaster';
  smoothVoxel?: Partial<SmoothVoxelOptions>;
  voxelProjection?: string;
  /**
   * Where the remaster look's smooth meshes are built. Default: a pool of Workers when the host has Workers, else
   * (and with null) on the calling thread at the first instance of a model.
   */
  smoothBuilder?: (SmoothSectionBuilder & { dispose?(): void }) | null;
}

const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/** A placed voxel unit: the body root and, for Turret=yes types, the group the turret (and barrel) yaw in. */
export interface VoxelUnit {
  root: Group;
  turret?: Group;
}

/**
 * What draws a model while its smooth mesh is being built: the stand-in geometries (one per part, shared by every
 * house palette), the geometry sets made from them and the roots of the placed units that show them (callers keep
 * their own record of a unit around the same root, so the root is what identifies it).
 */
interface StandIn {
  geometries: BufferGeometry[];
  sets: Set<VoxelGeometry[]>;
  units: Set<Group>;
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
  /** Builds the remaster look's meshes off this thread; null: built in place by the first instance. */
  private readonly smoothBuilder: (SmoothSectionBuilder & { dispose?(): void }) | null;
  /** Models whose mesh is being built by `smoothBuilder`. */
  private readonly meshing = new Set<VoxelModel>();
  /** Models drawn with a stand-in mesh until `smoothBuilder` answers (see build). */
  private readonly standIns = new Map<VoxelModel, StandIn>();
  /** The stand-in a geometry set was made from, while it is one. */
  private readonly standInOf = new Map<VoxelGeometry[], StandIn>();
  private disposed = false;
  /** Changes when a mesh or a redraw projection asked for earlier has arrived: what waited for it can draw now. */
  revision = 0;

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
    this.smoothBuilder =
      this.voxelLook !== 'remaster'
        ? null
        : options.smoothBuilder !== undefined
          ? options.smoothBuilder
          : createSmoothVoxelPool();
  }

  /** Meshes being built and redraw projections being fetched: art that was asked for and is not on screen yet. */
  get loading(): number {
    return this.meshing.size + this.pending.size;
  }

  /** Successful section requests served by persistent storage or freshly built, for startup diagnostics. */
  get cacheHits(): number {
    return this.smoothBuilder?.cacheHits ?? 0;
  }
  get meshBuilds(): number {
    return this.smoothBuilder?.meshBuilds ?? 0;
  }

  /** Placed units still drawn with a stand-in mesh (diagnostics: a healthy match counts down to 0 within seconds). */
  get standInUnits(): number {
    let count = 0;
    for (const standIn of this.standIns.values()) count += standIn.units.size;
    return count;
  }

  /** Whether `unit` is still drawn with the stand-in mesh of its model (see build). */
  isStandIn(unit: VoxelUnit): boolean {
    for (const standIn of this.standIns.values()) if (standIn.units.has(unit.root)) return true;
    return false;
  }

  /**
   * Whether the model's final mesh exists, so that build() makes an instance of the final look. The remaster look's
   * smooth mesh costs 0.02 to 3.3 s of CPU per model (measured over the 94 library models; 3 s for the vehicles of
   * one skirmish start, once the longest freeze of a match's first seconds), so it is built by Workers: the first
   * call for a model starts that and answers false; `revision` changes when the mesh is there. That can take
   * seconds (measured: 7.2 s for a War Miner on a loaded machine, with the Workers started anew), so nothing that is
   * on screen may wait for it: build() draws a stand-in meanwhile. Callers ask this to hold back what nobody sees
   * yet (a view out of sight, the alternate image of a unit that still shows its usual one). Without Workers the
   * mesh is built by the first instance as before, and this is always true.
   */
  geometryReady(model: VoxelModel): boolean {
    const builder = this.smoothBuilder;
    if (!builder || this.voxelLook !== 'remaster' || hasSmoothVoxelGeometry(model, this.smoothVoxel)) return true;
    if (this.meshing.has(model)) return false;
    this.meshing.add(model);
    prepareSmoothVoxelGeometry(model, this.smoothVoxel, builder)
      .catch((error) => {
        if (this.disposed) return;
        // The Worker could not build it: build in place once rather than keeping the stand-in for good.
        console.warn(`[HD] smooth voxel mesh of ${model.id} built on the main thread`, error);
        ensureSmoothVoxelGeometry(model, this.smoothVoxel);
      })
      .finally(() => {
        this.meshing.delete(model);
        if (!this.disposed) this.adoptSmooth(model);
        this.revision++;
      });
    return false;
  }

  /**
   * The model's smooth mesh has arrived: every geometry set made from its stand-in, and every placed unit that shows
   * one, changes to the smooth geometries in place (same parts in the same order, same materials), and the stand-in
   * is released. A unit is the same object before and after, so nothing about where and how it stands can jump.
   */
  private adoptSmooth(model: VoxelModel): void {
    const standIn = this.standIns.get(model);
    if (!standIn) return;
    const smooth = smoothVoxelPartGeometries(model, this.smoothVoxel);
    // Not built after all (cannot happen: a failed build is repeated in place above): the stand-in stays.
    if (!smooth || smooth.length !== standIn.geometries.length) return;
    this.standIns.delete(model);
    const swap = new Map(standIn.geometries.map((geometry, index) => [geometry, smooth[index]!]));
    for (const parts of standIn.sets) {
      for (const part of parts) part.geometry = swap.get(part.geometry) ?? part.geometry;
      this.standInOf.delete(parts);
    }
    for (const root of standIn.units) {
      if (!(root instanceof VoxelRoot) || !root.replaceGeometry(swap)) continue;
      // A resting unit may receive no new pose: its depth card follows the new bounds now, like a repaint does.
      const { anchor, bonus, enabled } = root.nativeDepth;
      updateVoxelNativeDepth(root, anchor, bonus, enabled !== 0);
    }
    for (const geometry of standIn.geometries) geometry.dispose();
  }

  /** Geometry set of a model whose smooth mesh is still being built: its stand-in parts with the look's material. */
  private standInParts(model: VoxelModel, palette: Uint8Array): VoxelGeometry[] {
    let standIn = this.standIns.get(model);
    if (!standIn) {
      const built = buildStandInVoxelParts(model, voxelShapeFor(this.hd.nodes));
      standIn = { geometries: built.map((part) => part.geometry), sets: new Set(), units: new Set() };
      this.standIns.set(model, standIn);
    }
    const material = voxelPbrMaterialFor(palette, this.hd.nodes);
    const turretOffset = (model.turretOffset ?? 0) / LEPTONS_PER_CELL;
    const parts = model.parts.map((part, index) => ({
      role: part.role,
      geometry: standIn.geometries[index]!,
      turretOffset,
      material,
    }));
    standIn.sets.add(parts);
    this.standInOf.set(parts, standIn);
    return parts;
  }

  /**
   * The shared geometry set of `model` for palette row `paletteKey`, built once per `cacheKey`; its redraw projection
   * (when the look has one) is requested here and repaints every waiting instance when it arrives. `variant` names
   * the redraw's page variant the set is painted with (VoxelProjectionLibrary.get); callers put it in `cacheKey`.
   */
  private partsFor(model: VoxelModel, paletteKey: string, cacheKey: string, variant = ''): VoxelGeometry[] {
    let parts = this.geometries.get(cacheKey);
    if (parts) return parts;
    const palette = this.cache.paletteRgb.get(paletteKey)!;
    parts =
      this.voxelLook !== 'remaster'
        ? buildVoxelGeometry(model, palette, this.hd.nodes)
        : this.geometryReady(model)
          ? buildSmoothVoxelGeometry(model, palette, this.hd.nodes, this.smoothVoxel)
          : this.standInParts(model, palette);
    this.geometries.set(cacheKey, parts);
    const projection = this.projections;
    if (!projection) return parts;
    // Alternate native turrets have different silhouettes: retain the HD hull, but never paint the default gun
    // over a repair arm or another passenger's turret. Those parts keep their own palette/smooth material.
    const projected = selectedVoxelTurretIndex(model) ? parts.filter((part) => part.role === 'body') : parts;
    if (!projected.length) return parts;
    const required = projectionParts(projected);
    if (projectVoxelMaterials(projected, palette, projection.get(model.id, required, variant), this.hd.nodes))
      return parts;
    const waiting = new Set<VoxelUnit>();
    const target = parts;
    this.pending.set(target, waiting);
    void projection.loadType(model.id, required, variant).then((asset) => {
      if (projectVoxelMaterials(projected, palette, asset, this.hd.nodes)) {
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
      this.revision++;
    });
    return parts;
  }

  /** Whether a geometry set (and its materials) already exists for `cacheKey`: an instance of it builds no shader. */
  built(cacheKey: string): boolean {
    return this.geometries.has(cacheKey);
  }

  /**
   * Build the shared geometry and request its projection ahead of the first instance. True once a new instance
   * would draw its final look at once (the mesh is built; the projection has arrived, is absent or failed); callers
   * that swap one model for another on the same object keep the old one on screen until then.
   */
  prepare(model: VoxelModel, paletteKey: string, cacheKey: string, variant = ''): boolean {
    if (!this.geometryReady(model)) return false;
    return !this.pending.has(this.partsFor(model, paletteKey, cacheKey, variant));
  }

  /**
   * Whether the model's redraw has pages of its own for `variant`. False while the redraw loads and for a model
   * without that variant: such a unit is drawn (and keyed) as the base look, so it is never rebuilt for a variant
   * that would look the same.
   */
  hasVariant(model: VoxelModel, variant: string): boolean {
    return !!variant && !!this.projections?.hasVariant(model.id, variant);
  }

  /**
   * A new instance of `model` drawn with palette row `paletteKey` (already resolved with paletteFor, so house-remapped
   * when the owner is known). `cacheKey` identifies the geometry set to share, e.g. `${type}@${paletteKey}`.
   *
   * Never waits and never builds a smooth mesh on this thread while Workers do that: until the model's own mesh is
   * there the instance is made from its stand-in (the plain exposed-face mesh, milliseconds to build), with the
   * materials the smooth mesh gets, and changes to the smooth mesh in place when it arrives (adoptSmooth). A unit
   * the game shows is therefore on screen from its first frame, where it belongs.
   */
  build(model: VoxelModel, paletteKey: string, cacheKey: string, variant = ''): VoxelUnit {
    const parts = this.partsFor(model, paletteKey, cacheKey, variant);
    const unit = instantiateVoxel(parts, this.material, this.hd.nodes);
    this.pending.get(parts)?.add(unit);
    this.standInOf.get(parts)?.units.add(unit.root);
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
  /** The unit's picture tint (objectTint.ts); undefined draws it unchanged. */
  setTint(unit: VoxelUnit, tint: ObjectTint | undefined): void {
    if (unit.root instanceof VoxelRoot) unit.root.setTint(tint);
  }

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

  /** Stop the mesh Workers; the view that owns this calls it once, after its last unit is gone. */
  disposeAll(): void {
    this.disposed = true;
    this.smoothBuilder?.dispose?.();
    this.meshing.clear();
    // Stand-ins belong to this instance alone (the smooth geometries they wait for follow their model).
    for (const standIn of this.standIns.values()) for (const geometry of standIn.geometries) geometry.dispose();
    this.standIns.clear();
    this.standInOf.clear();
  }

  /** Take a unit out of the scene (geometry stays cached for the next instance of its type). */
  dispose(unit: VoxelUnit): void {
    this.setCaptureCode(unit, NOT_CAPTURED_CODE);
    for (const waiting of this.pending.values()) waiting.delete(unit);
    for (const standIn of this.standIns.values()) standIn.units.delete(unit.root);
    if (unit.root instanceof VoxelRoot) unit.root.disposeOpacityMaterials();
    unit.root.removeFromParent();
  }
}
