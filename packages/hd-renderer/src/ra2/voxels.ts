import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
} from 'three/webgpu';
import { attribute, float, mix, uniform } from 'three/tsl';
import { lookupNormal, normalTableFor } from '../../../ra2-formats/src/index';
import type { VoxelModel, VoxelSection } from '../../../ra2-assets/src/manifest';
import type { ShaderNode } from '../tsl';
import { decodeBase64 } from './cache';

/**
 * Original VXL units, rendered as real meshes. The engine places one voxel unit at 8 leptons, and a cell edge is 256
 * leptons (one world unit), so HD vehicles keep the originals' size exactly. Vertically, a level is 104 leptons and
 * LEVEL_HEIGHT world units, which works out to the same scale within half a percent.
 */
export const VOXEL_TO_WORLD = 8 / 256;

export interface VoxelGeometry {
  role: 'body' | 'turret' | 'barrel';
  geometry: BufferGeometry;
  /** Rotation pivot (turret/barrel) in the model's local frame. */
  pivot: [number, number, number];
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

/**
 * Model-local frame used by the renderer: +x forward (the vehicle's nose), +y up, +z to the vehicle's right.
 * Voxel space is +X forward, +Y to the left, +Z up, so (X, Y, Z) maps to (x, z, -y) — a proper rotation, no mirror.
 */
function toLocal(p: [number, number, number]): [number, number, number] {
  return [p[0] * VOXEL_TO_WORLD, p[2] * VOXEL_TO_WORLD, -p[1] * VOXEL_TO_WORLD];
}

function applyTransform(m: readonly number[], p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ];
}

function rotate(m: readonly number[], v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2],
    m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2],
  ];
}

/** Merge a part's sections into one geometry: exposed voxel faces only, lit by the original per-voxel normals. */
export function buildVoxelGeometry(model: VoxelModel, palette: Uint8Array): VoxelGeometry[] {
  const table = normalTableFor(model.normalsMode);
  const out: VoxelGeometry[] = [];
  for (const part of model.parts) {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const remaps: number[] = [];
    const indices: number[] = [];
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const section of part.sections) addSection(section);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geometry.setAttribute('remap', new BufferAttribute(new Float32Array(remaps), 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const pivot: [number, number, number] = [
      (bounds.min[0]! + bounds.max[0]!) / 2,
      bounds.min[1]!,
      (bounds.min[2]! + bounds.max[2]!) / 2,
    ];
    out.push({ role: part.role, geometry, pivot });

    function addSection(section: VoxelSection) {
      const raw = decodeBase64(section.voxels);
      const [sx, sy, sz] = section.size;
      const filled = new Set<number>();
      const key = (x: number, y: number, z: number) => x + sx * (y + sy * z);
      for (let i = 0; i < raw.length; i += 5) filled.add(key(raw[i]!, raw[i + 1]!, raw[i + 2]!));
      const step = [0, 1, 2].map(
        (a) => (section.maxBounds[a]! - section.minBounds[a]!) / Math.max(1, section.size[a]!),
      ) as [number, number, number];
      const colour = new Color();
      for (let i = 0; i < raw.length; i += 5) {
        const vx = raw[i]!;
        const vy = raw[i + 1]!;
        const vz = raw[i + 2]!;
        const c = raw[i + 3]!;
        const n = lookupNormal(table, raw[i + 4]!);
        const normal = toLocal(rotate(section.transform, [n[0], n[1], n[2]]));
        const nl = Math.hypot(...normal) || 1;
        colour.setRGB(palette[c * 3]! / 255, palette[c * 3 + 1]! / 255, palette[c * 3 + 2]! / 255, SRGBColorSpace);
        const remap = c >= 16 && c <= 31 ? 1 - (c - 16) / 15 : -1;
        for (const face of FACES) {
          const [dx, dy, dz] = face.dir;
          const nx = vx + dx;
          const ny = vy + dy;
          const nz = vz + dz;
          if (nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz && filled.has(key(nx, ny, nz))) continue;
          const base = positions.length / 3;
          for (const [cx, cy, cz] of face.corners) {
            const boundsPoint: [number, number, number] = [
              section.minBounds[0] + (vx + cx) * step[0],
              section.minBounds[1] + (vy + cy) * step[1],
              section.minBounds[2] + (vz + cz) * step[2],
            ];
            const p = toLocal(applyTransform(section.transform, boundsPoint));
            positions.push(p[0], p[1], p[2]);
            for (let a = 0; a < 3; a++) {
              bounds.min[a] = Math.min(bounds.min[a]!, p[a]!);
              bounds.max[a] = Math.max(bounds.max[a]!, p[a]!);
            }
            // The engine lights a voxel by its stored normal, not its cube faces: this keeps the smooth retail look.
            normals.push(normal[0] / nl, normal[1] / nl, normal[2] / nl);
            colors.push(colour.r, colour.g, colour.b);
            remaps.push(remap);
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  return out;
}

/**
 * Voxel material. House colours are already baked into the vertex colours (the geometry is built from the house's
 * remapped palette); the remap attribute only marks team paint so it can read slightly glossier than bare metal.
 */
/**
 * Ambient fill shared by every voxel material, set each frame by the renderer from the scene's light level. The engine
 * lights voxels through a lookup table that brightens faces towards the light rather than only darkening faces away
 * from it, so original vehicles read brighter than their raw palette colours; this fill restores that level (and
 * still follows day and night).
 */
export const voxelFill = uniform(new Color(0, 0, 0));
/** Fill strength relative to the flat-ground noon level. */
export const VOXEL_FILL = 0.45;

export function createVoxelMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const paint: ShaderNode = attribute('remap', 'float').greaterThanEqual(0).select(float(1), float(0));
  material.colorNode = attribute('color', 'vec3');
  material.emissiveNode = attribute('color', 'vec3').mul(voxelFill);
  // Mostly dielectric: metalness darkens the diffuse term, and the originals read as brightly lit painted metal.
  material.metalnessNode = mix(float(0.05), float(0.12), paint);
  material.roughnessNode = mix(float(0.55), float(0.38), paint);
  return material;
}

/** A placed vehicle: parts share the body transform; turret/barrel yaw around their pivot. */
export function instantiateVoxel(
  parts: VoxelGeometry[],
  material: MeshStandardNodeMaterial,
): { root: Group; turret?: Group } {
  const root = new Group();
  let turret: Group | undefined;
  for (const part of parts) {
    const mesh = new Mesh(part.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (part.role === 'body') {
      root.add(mesh);
      continue;
    }
    if (!turret) {
      turret = new Group();
      turret.position.set(part.pivot[0], 0, part.pivot[2]);
      root.add(turret);
    }
    mesh.position.set(-turret.position.x, 0, -turret.position.z);
    turret.add(mesh);
  }
  return { root, turret };
}
