import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  RedFormat,
} from 'three/webgpu';
import {
  attribute,
  bumpMap,
  color,
  float,
  fract,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  uniform,
} from 'three/tsl';
import { DEFAULT_ATMOSPHERE_NODES, sampleLightField, type AtmosphereNodes } from './atmosphere';
import type { RenderMap, TerrainClass } from './contract';
import { LEVEL_HEIGHT } from './world';
import type { ShaderNode } from './tsl';

/** Vertices per cell edge; 4 keeps shorelines smooth without a per-pixel heightmap. */
const SUBDIVISIONS = 4;

/** Material weight channels carried per vertex: road, pavement, beach, rough. Grass fills the remainder. */
const CHANNEL: Partial<Record<TerrainClass, number>> = { road: 0, pavement: 1, beach: 2, water: 2, rough: 3 };

export interface TerrainBuild {
  mesh: Mesh;
  /** World-space height (y) sampled on the vertex grid; shared with water and weather. */
  heightTexture: DataTexture;
  heightAt(x: number, z: number): number;
  /** Water surface at the origin, or undefined on land/outside the map; independent of unit type. */
  waterHeightAt?(x: number, z: number): number | undefined;
  /** 0..1 surface wetness, raised by rain and dried over time. */
  wetness: { value: number };
}

export function buildTerrain(map: RenderMap, nodes = DEFAULT_ATMOSPHERE_NODES): TerrainBuild {
  const cols = map.width * SUBDIVISIONS + 1;
  const rows = map.height * SUBDIVISIONS + 1;
  const positions = new Float32Array(cols * rows * 3);
  const weights = new Float32Array(cols * rows * 4);
  const heights = new Float32Array(cols * rows);
  const corner = (cx: number, cy: number) => map.cornerHeights[cy * (map.width + 1) + cx]!;

  // Blur cell classes over a 3x3 neighbourhood so material borders become soft transitions, not cell-aligned steps.
  const cellWeights = new Float32Array(map.width * map.height * 4);
  for (let cy = 0; cy < map.height; cy++) {
    for (let cx = 0; cx < map.width; cx++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = Math.min(map.width - 1, Math.max(0, cx + ox));
          const ny = Math.min(map.height - 1, Math.max(0, cy + oy));
          const channel = CHANNEL[map.terrain[ny * map.width + nx]!];
          if (channel !== undefined)
            cellWeights[(cy * map.width + cx) * 4 + channel] += (ox === 0 && oy === 0 ? 4 : 1) / 12;
        }
      }
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const fx = col / SUBDIVISIONS;
      const fy = row / SUBDIVISIONS;
      const cx = Math.min(map.width - 1, Math.floor(fx));
      const cy = Math.min(map.height - 1, Math.floor(fy));
      const u = fx - cx;
      const v = fy - cy;
      const h =
        corner(cx, cy) * (1 - u) * (1 - v) +
        corner(cx + 1, cy) * u * (1 - v) +
        corner(cx, cy + 1) * (1 - u) * v +
        corner(cx + 1, cy + 1) * u * v;
      const index = row * cols + col;
      const y = h * LEVEL_HEIGHT;
      positions.set([fx, y, fy], index * 3);
      heights[index] = y;
      // Interpolate between cell centres so class borders fade across the cell instead of stepping at its edge.
      const gx = Math.min(map.width - 1, Math.max(0, fx - 0.5));
      const gy = Math.min(map.height - 1, Math.max(0, fy - 0.5));
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(map.width - 1, x0 + 1);
      const y1 = Math.min(map.height - 1, y0 + 1);
      const tx = gx - x0;
      const ty = gy - y0;
      for (let c = 0; c < 4; c++) {
        const w = (cx2: number, cy2: number) => cellWeights[(cy2 * map.width + cx2) * 4 + c]!;
        const value = (w(x0, y0) * (1 - tx) + w(x1, y0) * tx) * (1 - ty) + (w(x0, y1) * (1 - tx) + w(x1, y1) * tx) * ty;
        weights[index * 4 + c] = Math.min(1, value);
      }
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('terrainWeights', new BufferAttribute(weights, 4));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.setAttribute('normal', new BufferAttribute(smoothNormals(heights, cols, rows), 3));

  const heightTexture = new DataTexture(heights, cols, rows, RedFormat, FloatType);
  heightTexture.minFilter = LinearFilter;
  heightTexture.magFilter = LinearFilter;
  heightTexture.needsUpdate = true;

  const wetness = uniform(0);
  const material = createTerrainMaterial(wetness, map.waterLevel * LEVEL_HEIGHT, map.width, map.height, nodes);
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'terrain';

  const heightAt = (x: number, z: number): number => {
    const col = Math.min(cols - 1, Math.max(0, Math.round(x * SUBDIVISIONS)));
    const row = Math.min(rows - 1, Math.max(0, Math.round(z * SUBDIVISIONS)));
    return heights[row * cols + col]!;
  };
  const waterHeightAt = (x: number, z: number): number | undefined =>
    x >= 0 && z >= 0 && x < map.width && z < map.height && heightAt(x, z) < map.waterLevel * LEVEL_HEIGHT
      ? map.waterLevel * LEVEL_HEIGHT
      : undefined;
  return { mesh, heightTexture, heightAt, waterHeightAt, wetness };
}

function createTerrainMaterial(
  wetness: ShaderNode,
  waterY: number,
  width: number,
  height: number,
  nodes: AtmosphereNodes,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const weights = attribute('terrainWeights', 'vec4');
  const p = positionWorld;

  // Large-scale variation keeps flat fields from looking tiled; fine noise supplies grain at 4x pixel density.
  const macro = mx_fractal_noise_float(p.mul(0.18), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  const detail = mx_noise_float(p.mul(3.1)).mul(0.5).add(0.5);
  const grain = mx_noise_float(p.mul(14.0)).mul(0.5).add(0.5);

  const grass = mix(color(0x3f5a22), color(0x6f8a34), macro).mul(mix(0.82, 1.08, detail));
  const dirt = mix(color(0x5b4632), color(0x7a6147), detail).mul(mix(0.9, 1.05, grain));
  const sand = mix(color(0xb9a57a), color(0xd6c396), macro).mul(mix(0.92, 1.04, grain));
  const asphalt = mix(color(0x2b2c2e), color(0x3a3b3d), grain).mul(mix(0.9, 1.1, macro));
  // Concrete slabs: 1-cell grid with thin darker joints.
  const slab = fract(p.xz);
  const joint = smoothstep(0.0, 0.03, slab.x).mul(smoothstep(0.0, 0.03, slab.y));
  const concrete = mix(color(0x6d6c68), color(0x8b8a85), macro)
    .mul(mix(0.7, 1.0, joint))
    .mul(mix(0.94, 1.04, grain));
  const rock = mix(color(0x5e5850), color(0x8a8175), detail).mul(mix(0.85, 1.1, grain));

  // Noise-broken thresholds turn smooth weight ramps into natural, irregular borders.
  const edge = (w: ShaderNode, softness: number) =>
    smoothstep(0.5 - softness, 0.5 + softness, w.add(detail.sub(0.5).mul(0.45)));
  let albedo: ShaderNode = mix(grass, dirt, edge(weights.w, 0.12));
  albedo = mix(albedo, sand, edge(weights.z, 0.1));
  albedo = mix(albedo, concrete, smoothstep(0.45, 0.55, weights.y));
  albedo = mix(albedo, asphalt, smoothstep(0.45, 0.55, weights.x));
  // Slopes steeper than ~50° read as rock/cliff regardless of the painted class.
  const steep = smoothstep(0.78, 0.6, normalWorld.y);
  albedo = mix(albedo, rock, steep);
  // Below the waterline the seabed turns dark and silty.
  const submerged = smoothstep(waterY + 0.02, waterY - 0.25, p.y);
  albedo = mix(albedo, color(0x4a4a3a), submerged.mul(0.6));

  let roughness: ShaderNode = mix(float(0.92), float(0.72), weights.x.add(weights.y).min(1));
  roughness = mix(roughness, float(0.8), steep);
  // Wave-washed band just above the waterline: darker, glossier sand.
  const shoreWet = smoothstep(waterY + 0.12, waterY, p.y).mul(float(1).sub(submerged));
  albedo = albedo.mul(mix(float(1), float(0.68), shoreWet));
  roughness = mix(roughness, float(0.3), shoreWet);

  // Wet surfaces darken and gloss; puddles only form on flat ground and on hard or packed surfaces.
  const flat = smoothstep(0.97, 0.995, normalWorld.y);
  const puddleNoise = mx_fractal_noise_float(p.mul(0.55), 2, 2, 0.5, 1).mul(0.5).add(0.5);
  // Puddles need a genuine low spot: noise-selected, on flat ground, never on sand (it drains) or steep terrain.
  const drains = smoothstep(0.3, 0.6, weights.z);
  const puddle = smoothstep(0.6, 0.66, puddleNoise)
    .mul(flat)
    .mul(wetness)
    .mul(float(1).sub(steep))
    .mul(float(1).sub(drains));
  albedo = albedo.mul(mix(float(1), float(0.62), wetness)).mul(mix(float(1), float(0.55), puddle));
  roughness = mix(
    roughness,
    mix(float(0.45), float(0.6), steep.add(smoothstep(0.995, 0.97, normalWorld.y)).min(1)),
    wetness,
  );
  roughness = mix(roughness, float(0.1), puddle);

  // Border shroud: fade to black over the outermost 1.5 cells (matches the water plane).
  const border = smoothstep(0.0, 1.5, p.x.min(p.z).min(float(width).sub(p.x)).min(float(height).sub(p.z)));
  material.colorNode = albedo.mul(border);
  // Local lights (explosions, fires) from the light field, as diffuse irradiance on the albedo.
  material.emissiveNode = albedo
    .mul(border)
    .mul(sampleLightField(p.xz, nodes))
    .mul(1 / Math.PI);
  material.roughnessNode = mix(float(1), roughness, border);
  material.metalnessNode = float(0);
  // Micro relief from noise; puddles stay mirror-flat.
  const bump = mx_noise_float(p.mul(9.0)).mul(float(1).sub(puddle));
  material.normalNode = bumpMap(bump, float(0.012));
  return material;
}

/**
 * Shading normals from a blurred copy of the height grid. RA2 ramps are one-level steps across a cell; flat-faceted
 * normals make each ramp a mirror that flashes when wet. Positions keep the exact heights, so silhouettes and
 * unit placement are unchanged.
 */
function smoothNormals(heights: Float32Array, cols: number, rows: number): Float32Array {
  let current = heights;
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(current.length);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = col + dx;
            const y = row + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            sum += current[y * cols + x]!;
            count++;
          }
        }
        next[row * cols + col] = sum / count;
      }
    }
    current = next;
  }
  const normals = new Float32Array(cols * rows * 3);
  const step = 2 / SUBDIVISIONS;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const h = (x: number, y: number) =>
        current[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))]!;
      const dx = (h(col + 1, row) - h(col - 1, row)) / step;
      const dz = (h(col, row + 1) - h(col, row - 1)) / step;
      const length = Math.hypot(dx, 1, dz);
      normals.set([-dx / length, 1 / length, -dz / length], (row * cols + col) * 3);
    }
  }
  return normals;
}
