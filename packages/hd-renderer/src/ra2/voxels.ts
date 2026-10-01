import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { lookupNormal, normalTableFor } from '../../../ra2-formats/src/index';
import type { VoxelModel, VoxelSection } from '../../../ra2-assets/src/manifest';
import { sectionNormalsMode } from '../../../ra2-assets/src/voxelNormals';
import type { AtmosphereNodes } from '../atmosphere';
import { createPainterDepth, meshPainterDepthNode } from '../painterDepth';
import { decodeBase64 } from './cache';
import { paletteNodes } from './mapLighting';
import { SHADOW_COPIES, VoxelShadowMesh, groundOf } from './voxelShadow';
import { voxelFill, voxelMaterialFor, voxelProjectedMaterialFor } from './vpl';
import type { VoxelProjectionAsset } from './voxelProjection';
import { CARD_CLEARANCE } from './cardDepth';
import { VOXEL_TO_WORLD } from './voxelScale';

/**
 * Original VXL units, rendered as real meshes. The engine draws voxels through a pure rotation (the default voxel
 * matrix at 0xB44318) straight into screen pixels, so one voxel is one pixel of the voxel camera: 256 / (30 * sqrt 2)
 * = 6.034 leptons, the length a cell edge of 256 leptons shrinks to 42.4 px on screen (its z factor 0.1435 is
 * cos 30° / 6.034). One world unit is one cell edge, so a voxel is 1 / PIXELS_PER_CELL_EDGE world units. Measured on
 * same-moment captures, the silhouettes then overlap the originals' at 0.91-0.97 IoU (0.66-0.73 at the earlier 8
 * leptons per voxel, which drew every vehicle a third too large and made it look lifted off the ground).
 */
export { VOXEL_TO_WORLD } from './voxelScale';
/** Engine leptons per cell edge: art offsets such as TurretOffset are given in leptons. */
const LEPTONS_PER_CELL = 256;

export interface VoxelGeometry {
  role: 'body' | 'turret' | 'barrel';
  geometry: BufferGeometry;
  /**
   * Where the turret and barrel turn, in the model's local frame (world units, +x = nose): the art's TurretOffset
   * along the body's facing. The turret geometry itself is modelled around that point.
   */
  turretOffset: number;
  /** Material for this geometry's palette (engine lighting table), when known. */
  material?: MeshStandardNodeMaterial;
}

/** Apply only complete part sets. Turret and barrel share both the projected material and the turret pivot. */
export function projectVoxelMaterials(
  parts: VoxelGeometry[],
  palette: Uint8Array | null,
  asset: VoxelProjectionAsset | null,
  nodes: AtmosphereNodes,
): boolean {
  if (!asset || parts.some((part) => !asset.parts[part.role === 'body' ? 'body' : 'turret'])) return false;
  for (const part of parts) {
    part.material = voxelProjectedMaterialFor(palette, asset.parts[part.role === 'body' ? 'body' : 'turret']!, nodes);
    if (!part.material.depthNode) part.material.depthNode = meshPainterDepthNode();
  }
  return true;
}

const FACES: { dir: [number, number, number]; corners: [number, number, number][] }[] = [
  {
    dir: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    dir: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    dir: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    dir: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    dir: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
  {
    dir: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
];

/** Fixed topology; section-specific pitches are applied once before walking the exposed faces. */
const FACE_CORNERS = new Uint8Array(FACES.flatMap((face) => face.corners.flat()));
const FACE_AO = FACES.flatMap((face) => {
  const axes = [0, 1, 2].filter((a) => face.dir[a] === 0);
  return face.corners.flatMap((corner) => {
    const u = [0, 0, 0];
    const w = [0, 0, 0];
    u[axes[0]!] = corner[axes[0]!] ? 1 : -1;
    w[axes[1]!] = corner[axes[1]!] ? 1 : -1;
    return [...u, ...w];
  });
});

/** The 26-neighbourhood, in the original accumulation order to preserve floating-point results. */
const NEIGHBOURS: number[] = [];
const NEIGHBOUR_DISTANCE = new Float64Array(26);
for (let dz = -1; dz <= 1; dz++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      NEIGHBOUR_DISTANCE[NEIGHBOURS.length / 3] = Math.hypot(dx, dy, dz);
      NEIGHBOURS.push(dx, dy, dz);
    }
  }
}

/**
 * Surface nets only depend on the eight occupied cells touching a corner. Precompute the 256 results, including
 * the original Float32 rounding, instead of repeating twelve edge tests and allocating a lookup closure per corner.
 */
const CORNER_OFFSETS = new Float32Array(256 * 3);
for (let mask = 0; mask < 256; mask++) {
  let n = 0;
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      if (((mask >> (2 * a + 4 * b)) & 1) !== ((mask >> (1 + 2 * a + 4 * b)) & 1)) {
        ay += a - 0.5;
        az += b - 0.5;
        n++;
      }
      if (((mask >> (a + 4 * b)) & 1) !== ((mask >> (a + 2 + 4 * b)) & 1)) {
        ax += a - 0.5;
        az += b - 0.5;
        n++;
      }
      if (((mask >> (a + 2 * b)) & 1) !== ((mask >> (a + 2 * b + 4)) & 1)) {
        ax += a - 0.5;
        ay += b - 0.5;
        n++;
      }
    }
  }
  if (n) {
    CORNER_OFFSETS[mask * 3] = ax / n;
    CORNER_OFFSETS[mask * 3 + 1] = ay / n;
    CORNER_OFFSETS[mask * 3 + 2] = az / n;
  }
}

/*
 * Model-local frame used by the renderer: +x forward (the vehicle's nose), +y up, +z to the vehicle's right. Voxel
 * space is +X forward, +Y to the left, +Z up, so (X, Y, Z) maps to (x, z, -y), a proper rotation (no mirror), scaled by
 * VOXEL_TO_WORLD for positions.
 */

/**
 * Build-time shape refinement (once per model, shared by every house colour; no per-frame cost):
 * - cornerRelax: each lattice corner moves this far towards the centroid of the occupancy-edge crossings of its
 *   2x2x2 neighbourhood (surface nets), rounding the stair-stepped cubes that read as "old 3D" when one voxel covers
 *   several screen pixels. Kept at or below 0.7 so one-voxel features (antennas, barrels) survive.
 * - normalBlend: each stored normal is blended with its exposed neighbours' (weight / distance). The engine shades
 *   every voxel by its own stored normal (vpl.ts); blending calms the per-voxel mottling at HD zoom but flattens the
 *   original's highlights and creases, so it stays small.
 * - Occlusion per corner from the three outside neighbours touching it (AO_LEVELS), stored raw in the 'occlusion'
 *   attribute; the material applies it with its own strength (vpl.ts voxelOcclusion).
 * Legacy tooling may change the defaults below; worlds snapshot them before asynchronous loading starts. Geometry
 * is shared only when both the model and refinement values match.
 */
export interface VoxelShape {
  cornerRelax: number;
  normalBlend: number;
}
export const voxelShape: VoxelShape = { cornerRelax: 0.6, normalBlend: 0.15 };
const shapes = new WeakMap<AtmosphereNodes, Readonly<VoxelShape>>();

/** Capture one world's shape options; later edits to the caller's settings cannot change its model builds. */
export function setVoxelShapeFor(nodes: AtmosphereNodes, shape: Readonly<VoxelShape>): Readonly<VoxelShape> {
  const value = Object.freeze({ cornerRelax: shape.cornerRelax, normalBlend: shape.normalBlend });
  shapes.set(nodes, value);
  return value;
}

/** A renderer's immutable refinement options, lazily copied from the legacy defaults for standalone callers. */
export function voxelShapeFor(nodes: AtmosphereNodes): Readonly<VoxelShape> {
  return shapes.get(nodes) ?? setVoxelShapeFor(nodes, voxelShape);
}
const AO_LEVELS = [0.35, 0.6, 0.8, 1] as const;

interface SharedPart {
  role: VoxelGeometry['role'];
  geometry: BufferGeometry;
}
/** Palette-independent geometry per model: vertices carry palette indices, the material maps them to colours. */
const sharedParts = new WeakMap<VoxelModel, Map<string, SharedPart[]>>();

/**
 * Merge a part's sections into one geometry: exposed voxel faces only, lit by the original per-voxel normals. Each
 * vertex carries its palette index (colour, lighting table row and highlight class come from the palette's material,
 * see vpl.ts) and ambient occlusion. The geometry is built once per model and shared by every palette; each returned
 * part carries the material of `palette` (house remaps included).
 */
export function buildVoxelGeometry(
  model: VoxelModel,
  palette: Uint8Array | null,
  nodes?: AtmosphereNodes,
  shape?: Readonly<VoxelShape>,
): VoxelGeometry[] {
  const context = nodes ?? paletteNodes(palette);
  const refinement = shape ?? (context ? voxelShapeFor(context) : voxelShape);
  // String keys keep numerically equal options shared across renderer contexts; preserve signed zero as well.
  const relax = refinement.cornerRelax;
  const blend = refinement.normalBlend;
  const key = `${Object.is(relax, -0) ? '-0' : relax}:${Object.is(blend, -0) ? '-0' : blend}`;
  let variants = sharedParts.get(model);
  if (!variants) {
    variants = new Map();
    sharedParts.set(model, variants);
  }
  let parts = variants.get(key);
  if (!parts) {
    parts = model.parts.map((part) => ({ role: part.role, geometry: buildPartGeometry(part.sections, refinement) }));
    variants.set(key, parts);
  }
  const material = voxelMaterialFor(palette, context);
  const turretOffset = (model.turretOffset ?? 0) / LEPTONS_PER_CELL;
  return parts.map(({ role, geometry }) => ({ role, geometry, turretOffset, material }));
}

interface SectionGrid {
  section: VoxelSection;
  raw: Uint8Array;
  filled: Uint8Array;
  cells: Int32Array;
  faces: Uint8Array;
  faceOffsets: Int32Array;
  faceCount: number;
  px: number;
  pxy: number;
}

function sectionGrid(section: VoxelSection): SectionGrid {
  const raw = decodeBase64(section.voxels);
  const [sx, sy, sz] = section.size;
  // The two-cell empty border includes neighbours of a face's outside cell, avoiding inner-loop bounds checks.
  const px = sx + 4;
  const pxy = px * (sy + 4);
  const origin = 2 + 2 * px + 2 * pxy;
  const filled = new Uint8Array(pxy * (sz + 4));
  const cells = new Int32Array(raw.length / 5);
  const faces = new Uint8Array(cells.length);
  const faceOffsets = new Int32Array([1, -1, px, -px, pxy, -pxy]);
  for (let v = 0; v < cells.length; v++) {
    const i = v * 5;
    const k = origin + raw[i]! + px * raw[i + 1]! + pxy * raw[i + 2]!;
    cells[v] = k;
    filled[k] = 1;
  }
  let faceCount = 0;
  for (let v = 0; v < cells.length; v++) {
    const k = cells[v]!;
    let mask = 0;
    for (let f = 0; f < 6; f++) {
      if (filled[k + faceOffsets[f]!]) continue;
      mask |= 1 << f;
      faceCount++;
    }
    faces[v] = mask;
  }
  return { section, raw, filled, cells, faces, faceOffsets, faceCount, px, pxy };
}

function buildPartGeometry(sections: readonly VoxelSection[], shape: Readonly<VoxelShape>): BufferGeometry {
  const grids = sections.map(sectionGrid);
  let vertexCount = 0;
  for (const grid of grids) vertexCount += grid.faceCount * 4;
  // Count visible faces first: write GPU-ready arrays directly, without growing and then copying five JS arrays.
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const pindices = new Float32Array(vertexCount);
  const occlusion = new Float32Array(vertexCount);
  const indices = vertexCount > 65535 ? new Uint32Array((vertexCount / 4) * 6) : new Uint16Array((vertexCount / 4) * 6);
  let vertex = 0;
  let index = 0;
  for (const grid of grids) addSection(grid);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('pindex', new BufferAttribute(pindices, 1));
  geometry.setAttribute('occlusion', new BufferAttribute(occlusion, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;

  function addSection({ section, raw, filled, cells, faces, faceOffsets, px, pxy }: SectionGrid) {
    // Each section has its own normal table; models such as the Rhino mix them (see voxelNormals.ts).
    const table = normalTableFor(sectionNormalsMode(section, raw));
    const [sx, sy, sz] = section.size;
    const step0 = (section.maxBounds[0] - section.minBounds[0]) / Math.max(1, sx);
    const step1 = (section.maxBounds[1] - section.minBounds[1]) / Math.max(1, sy);
    const step2 = (section.maxBounds[2] - section.minBounds[2]) / Math.max(1, sz);
    const m = section.transform;
    const relax = shape.cornerRelax;
    const cx1 = sx + 1;
    const cxy = cx1 * (sy + 1);
    const cornerDone = new Uint8Array(cxy * (sz + 1));
    // Adjacent faces share the same final position as well as the same rounded corner offset.
    const cornerPositions = new Float32Array(cornerDone.length * 3);
    const cornerOrigin = 1 + px + pxy;
    const cornerPosition = (cx: number, cy: number, cz: number): number => {
      const k = cx + cx1 * cy + cxy * cz;
      const p = k * 3;
      if (cornerDone[k]) return p;
      const o = cornerOrigin + cx + px * cy + pxy * cz;
      const mask =
        filled[o]! |
        (filled[o + 1]! << 1) |
        (filled[o + px]! << 2) |
        (filled[o + px + 1]! << 3) |
        (filled[o + pxy]! << 4) |
        (filled[o + pxy + 1]! << 5) |
        (filled[o + pxy + px]! << 6) |
        (filled[o + pxy + px + 1]! << 7);
      const off = mask * 3;
      const bxp = section.minBounds[0] + (cx + relax * CORNER_OFFSETS[off]!) * step0;
      const byp = section.minBounds[1] + (cy + relax * CORNER_OFFSETS[off + 1]!) * step1;
      const bzp = section.minBounds[2] + (cz + relax * CORNER_OFFSETS[off + 2]!) * step2;
      const X = m[0]! * bxp + m[1]! * byp + m[2]! * bzp + m[3]!;
      const Y = m[4]! * bxp + m[5]! * byp + m[6]! * bzp + m[7]!;
      const Z = m[8]! * bxp + m[9]! * byp + m[10]! * bzp + m[11]!;
      cornerPositions[p] = X * VOXEL_TO_WORLD;
      cornerPositions[p + 1] = Z * VOXEL_TO_WORLD;
      cornerPositions[p + 2] = -Y * VOXEL_TO_WORLD;
      cornerDone[k] = 1;
      return p;
    };

    // Keep the original Float32 rounding before blending neighbouring stored normals.
    const exposedNormal = new Float32Array(filled.length * 3);
    const isExposed = new Uint8Array(filled.length);
    for (let v = 0; v < cells.length; v++) {
      if (!faces[v]) continue;
      const k = cells[v]!;
      const n = lookupNormal(table, raw[v * 5 + 4]!);
      exposedNormal[k * 3] = n[0];
      exposedNormal[k * 3 + 1] = n[1];
      exposedNormal[k * 3 + 2] = n[2];
      isExposed[k] = 1;
    }
    const neighbourOffsets = new Int32Array(26);
    const neighbourWeights = new Float64Array(26);
    for (let j = 0; j < neighbourOffsets.length; j++) {
      const t = j * 3;
      neighbourOffsets[j] = NEIGHBOURS[t]! + px * NEIGHBOURS[t + 1]! + pxy * NEIGHBOURS[t + 2]!;
      neighbourWeights[j] = shape.normalBlend / NEIGHBOUR_DISTANCE[j]!;
    }
    const aoOffsets = new Int32Array(6 * 4 * 2);
    for (let j = 0; j < aoOffsets.length; j++) {
      const t = j * 3;
      aoOffsets[j] = FACE_AO[t]! + px * FACE_AO[t + 1]! + pxy * FACE_AO[t + 2]!;
    }

    for (let v = 0; v < cells.length; v++) {
      const mask = faces[v]!;
      // Fully internal voxels contribute neither vertices nor normals to exposed-neighbour blending.
      if (!mask) continue;
      const i = v * 5;
      const vx = raw[i]!;
      const vy = raw[i + 1]!;
      const vz = raw[i + 2]!;
      const c = raw[i + 3]!;
      const own = lookupNormal(table, raw[i + 4]!);
      const k = cells[v]!;
      let bx = own[0];
      let by = own[1];
      let bz = own[2];
      for (let j = 0; j < neighbourOffsets.length; j++) {
        const q = k + neighbourOffsets[j]!;
        if (!isExposed[q]) continue;
        const w = neighbourWeights[j]!;
        bx += exposedNormal[q * 3]! * w;
        by += exposedNormal[q * 3 + 1]! * w;
        bz += exposedNormal[q * 3 + 2]! * w;
      }
      // Rotate by the section transform, then voxel (X fwd, Y left, Z up) to model (x fwd, y up, z right).
      const rx = m[0]! * bx + m[1]! * by + m[2]! * bz;
      const ry = m[4]! * bx + m[5]! * by + m[6]! * bz;
      const rz = m[8]! * bx + m[9]! * by + m[10]! * bz;
      const nl = Math.hypot(rx, ry, rz) || 1;
      const nx0 = rx / nl;
      const ny0 = rz / nl;
      const nz0 = -ry / nl;
      for (let f = 0; f < 6; f++) {
        if (!(mask & (1 << f))) continue;
        const outside = k + faceOffsets[f]!;
        const base = vertex;
        for (let corner = 0; corner < 4; corner++) {
          const cornerIndex = f * 4 + corner;
          const t = cornerIndex * 3;
          const o = cornerPosition(vx + FACE_CORNERS[t]!, vy + FACE_CORNERS[t + 1]!, vz + FACE_CORNERS[t + 2]!);
          const p = vertex * 3;
          positions[p] = cornerPositions[o]!;
          positions[p + 1] = cornerPositions[o + 1]!;
          positions[p + 2] = cornerPositions[o + 2]!;
          // The engine lights a voxel by its stored normal, not its cube faces: keep the smooth retail look.
          normals[p] = nx0;
          normals[p + 1] = ny0;
          normals[p + 2] = nz0;
          pindices[vertex] = c;
          const u = aoOffsets[cornerIndex * 2]!;
          const w = aoOffsets[cornerIndex * 2 + 1]!;
          const s1 = filled[outside + u]!;
          const s2 = filled[outside + w]!;
          const sc = filled[outside + u + w]!;
          const level = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
          occlusion[vertex] = 1 - AO_LEVELS[level]!;
          vertex++;
        }
        indices[index++] = base;
        indices[index++] = base + 1;
        indices[index++] = base + 2;
        indices[index++] = base;
        indices[index++] = base + 2;
        indices[index++] = base + 3;
      }
    }
  }
}

/**
 * Shared material for callers that pass one to instantiateVoxel. Geometries carry their own palette material (see
 * vpl.ts); this one is used only for geometries that lack it.
 */
export function createVoxelMaterial(nodes?: AtmosphereNodes): MeshStandardNodeMaterial {
  return voxelMaterialFor(null, nodes);
}
/** Voxel light level relative to the flat-ground noon level: 1 shows exactly the table colours at clear noon. */
export const VOXEL_FILL = 1;
export { voxelFill };

const UP = new Vector3(0, 1, 0);
const groundNormal = new Vector3();
const tilt = new Quaternion();
/** A unit whose origin is within this height of the ground stands on it and follows its slope. */
const ON_GROUND = 0.05;
/** Keep contact pixels ahead of the deck card's small clearance; never lift the mesh or its shadow. */
export const VOXEL_CLEARANCE = CARD_CLEARANCE + 0.005;

/**
 * Root of a placed voxel unit. Callers set position and rotation (yaw) as for any Object3D; on sloped ground the
 * unit additionally tilts onto the ground's surface, the way the engine applies its ramp matrix to units standing on
 * ramps (applied in world space, after the yaw).
 */
export class VoxelUnit extends Group {
  private readonly painterDepth = createPainterDepth();

  constructor() {
    super();
    this.painterDepth.bias = VOXEL_CLEARANCE;
  }

  /** Real meshes share a bounded physical-depth bias; shadow twins retain ordinary ground depth. */
  addSourceMesh(mesh: Mesh): void {
    mesh.userData.painterDepth = this.painterDepth;
  }

  setPainterBias(bias: number): void {
    this.painterDepth.bias = VOXEL_CLEARANCE + bias;
  }

  override updateMatrix(): void {
    const ground = groundOf(this);
    const { x, y, z } = this.position;
    if (ground?.normal && Math.abs(y - ground.height(x, z)) < ON_GROUND) {
      ground.normal(x, z, groundNormal);
      tilt.setFromUnitVectors(UP, groundNormal).multiply(this.quaternion);
      this.matrix.compose(this.position, tilt, this.scale);
    } else {
      this.matrix.compose(this.position, this.quaternion, this.scale);
    }
    this.matrixWorldNeedsUpdate = true;
  }
}

/**
 * A placed vehicle: parts share the body transform; turret and barrel yaw together around the turret offset. Voxel
 * meshes neither cast nor receive the scene's sun shadows: every part instead gets flattened contact-shadow twins
 * on the ground below the unit (see voxelShadow.ts).
 */
export function instantiateVoxel(
  parts: VoxelGeometry[],
  material: MeshStandardNodeMaterial,
  nodes?: AtmosphereNodes,
): { root: VoxelUnit; turret?: Group } {
  const root = new VoxelUnit();
  let turret: Group | undefined;
  const meshes: Mesh[] = [];
  for (const part of parts) {
    const mesh = new Mesh(part.geometry, part.material ?? material);
    const sourceMaterial = part.material ?? material;
    // Palette materials are shared. The node reads the currently rendered mesh's depth slot.
    if (!sourceMaterial.depthNode) sourceMaterial.depthNode = meshPainterDepthNode();
    root.addSourceMesh(mesh);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
    if (part.role === 'body') {
      root.add(mesh);
      continue;
    }
    if (!turret) {
      turret = new Group();
      turret.position.set(part.turretOffset, 0, 0);
      root.add(turret);
    }
    turret.add(mesh);
  }
  // Shadow twins last: the scene graph updates children in order, so their sources' world matrices are current.
  for (let copy = 0; copy < SHADOW_COPIES.length; copy++)
    for (const mesh of meshes) root.add(new VoxelShadowMesh(mesh, nodes, copy));
  return { root, turret };
}
