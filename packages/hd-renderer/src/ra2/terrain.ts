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
  clamp,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { createWaterUniforms, waterSurface, type WaterUniforms } from '../waterShading';
import type { TerrainBuild } from '../terrain';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT } from '../world';
import { NO_TILE, ra2Screen, type Ra2Cache, tileAtlasPixel } from './cache';

/** Vertices per cell edge; ramps are planar per triangle in the engine, so 2 keeps slopes smooth enough. */
const SUB = 2;
/**
 * Water is shaded per pixel on the terrain itself (see createMaterial), so cells never sink: geometry stays exactly
 * the original heights and the shoreline is the painted one.
 */
const SEABED_DEPTH = 0;

export interface Ra2TerrainBuild extends TerrainBuild {
  /** Always null for original maps: there is no separate water plane. */
  waterY: number | null;
  /** Inputs of the per-pixel water shading, driven by the renderer's lighting and weather each frame. */
  water: WaterUniforms;
}

/**
 * Terrain built from the original map: every cell keeps its original tile raster, projected onto real 3D geometry.
 * Because RA2 art is itself a fixed-camera projection, sampling the raster at each surface point's engine screen
 * position reproduces the original pixels from the default view, while the geometry can now take shadows, lights,
 * wetness and water. Cliff faces come from the tiles' extra graphics, projected onto vertical walls.
 */
export function buildRa2Terrain(cache: Ra2Cache): Ra2TerrainBuild {
  const { manifest, exists, height, tile } = cache;
  const W = manifest.grid.width;
  const H = manifest.grid.height;
  // Texture space the UVs are expressed in: the composite's pixels, or the tile atlas's.
  const atlasW = cache.terrainMap ? cache.terrainMap.ref.width : manifest.terrainAtlas.width;
  const atlasH = cache.terrainMap ? cache.terrainMap.ref.height : manifest.terrainAtlas.height;
  const index = (x: number, y: number) => y * W + x;
  const cellExists = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && exists[index(x, y)] === 1;
  const tileAt = (x: number, y: number) => {
    const t = tile[index(x, y)]!;
    return t === NO_TILE ? undefined : manifest.tiles[t];
  };
  const isWater = (x: number, y: number) => {
    const t = tileAt(x, y);
    return !!t && isWaterTile(t);
  };
  const baseLevel = (x: number, y: number) => height[index(x, y)]!;

  // Corner heights: flat tiles stay flat (their art already carries any cliff); ramp tiles rise to the neighbouring
  // levels at the corners they share, capped at one level, which is how the engine's ramp templates are laid out.
  const cornerLevel = (x: number, y: number, cx: number, cy: number): number => {
    const h = baseLevel(x, y);
    const t = tileAt(x, y);
    if (!t || t.rampType === 0) return h;
    let highest = h;
    for (const [nx, ny] of [
      [cx - 1, cy - 1],
      [cx, cy - 1],
      [cx - 1, cy],
      [cx, cy],
    ] as const) {
      if (cellExists(nx, ny)) highest = Math.max(highest, Math.min(h + 1, baseLevel(nx, ny)));
    }
    return highest;
  };
  const surfaceLevel = (x: number, y: number, corner: number) => corner - (isWater(x, y) ? SEABED_DEPTH : 0);

  const positions: number[] = [];
  const uvs: number[] = [];
  const rects: number[] = [];
  const walls: number[] = [];
  const uvs2: number[] = [];
  const rects2: number[] = [];
  const indices: number[] = [];
  const hGrid = new Float32Array((W * SUB + 1) * (H * SUB + 1)).fill(50);
  let waterLevel = Infinity;

  type Rect = [number, number, number, number];
  // With a whole-map composite every surface point samples the image at its engine screen position; the per-tile
  // atlas path below remains the fallback when the cache has no composite.
  const map = cache.terrainMap?.ref;
  const mapPixel = (x: number, y: number, level: number): [number, number] => {
    const [sx, sy] = ra2Screen(x, y, level);
    return [
      ((sx - map!.originX) * map!.scale * atlasW) / map!.width,
      ((sy - map!.originY) * map!.scale * atlasH) / map!.height,
    ];
  };
  const FULL: [number, number, number, number] = [0, 0, atlasW, atlasH];
  const pushVertex = (
    x: number,
    y: number,
    level: number,
    uv: [number, number],
    rect: Rect,
    wall = 0,
    uv2: [number, number] = uv,
    rect2: Rect = rect,
  ) => {
    positions.push(x, level * LEVEL_HEIGHT, y);
    walls.push(wall);
    uvs2.push(uv2[0] / atlasW, uv2[1] / atlasH);
    rects2.push(rect2[0] / atlasW, rect2[1] / atlasH, (rect2[0] + rect2[2]) / atlasW, (rect2[1] + rect2[3]) / atlasH);
    uvs.push(uv[0] / atlasW, uv[1] / atlasH);
    rects.push(rect[0] / atlasW, rect[1] / atlasH, (rect[0] + rect[2]) / atlasW, (rect[1] + rect[3]) / atlasH);
    return positions.length / 3 - 1;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!cellExists(x, y)) continue;
      const t = tileAt(x, y);
      if (!t) continue;
      const h = baseLevel(x, y);
      if (isWater(x, y)) waterLevel = Math.min(waterLevel, h);
      const c = [
        cornerLevel(x, y, x, y),
        cornerLevel(x, y, x + 1, y),
        cornerLevel(x, y, x, y + 1),
        cornerLevel(x, y, x + 1, y + 1),
      ];
      const levelAt = (u: number, v: number) =>
        surfaceLevel(x, y, c[0]! * (1 - u) * (1 - v) + c[1]! * u * (1 - v) + c[2]! * (1 - u) * v + c[3]! * u * v);
      const first = positions.length / 3;
      for (let j = 0; j <= SUB; j++) {
        for (let i = 0; i <= SUB; i++) {
          const u = i / SUB;
          const v = j / SUB;
          // Sample the raster where the ORIGINAL (unsunk) surface would project; water keeps its own art as seabed.
          const drawnLevel = c[0]! * (1 - u) * (1 - v) + c[1]! * u * (1 - v) + c[2]! * (1 - u) * v + c[3]! * u * v;
          const level = levelAt(u, v);
          if (map) pushVertex(x + u, y + v, level, mapPixel(x + u, y + v, drawnLevel), FULL);
          else pushVertex(x + u, y + v, level, tileAtlasPixel(t, x, y, h, x + u, y + v, drawnLevel), t.rect);
          hGrid[(y * SUB + j) * (W * SUB + 1) + (x * SUB + i)] = level * LEVEL_HEIGHT;
        }
      }
      for (let j = 0; j < SUB; j++) {
        for (let i = 0; i < SUB; i++) {
          const a = first + j * (SUB + 1) + i;
          const b = a + 1;
          const d = a + SUB + 1;
          const e = d + 1;
          indices.push(a, d, b, b, d, e);
        }
      }

      // Vertical walls towards lower neighbours (cliffs, raised plateaus). Only the two camera-facing sides are
      // visible from the fixed view, but all four are closed so lights and shadows see solid ground.
      // [ax, ay, bx, by] of this edge, then the offset of the neighbour across it.
      const edges: [number, number, number, number, number, number][] = [
        [x + 1, y, x + 1, y + 1, 1, 0],
        [x, y + 1, x + 1, y + 1, 0, 1],
        [x, y, x, y + 1, -1, 0],
        [x, y, x + 1, y, 0, -1],
      ];
      const ownCorner = (cx: number, cy: number) => surfaceLevel(x, y, c[(cy - y) * 2 + (cx - x)]!);
      for (const [ax, ay, bx, by, dx, dy] of edges) {
        const nx = x + dx;
        const ny = y + dy;
        if (!cellExists(nx, ny) || !tileAt(nx, ny)) continue;
        const nC = (cx: number, cy: number) => surfaceLevel(nx, ny, cornerLevel(nx, ny, cx, cy));
        const topA = ownCorner(ax, ay);
        const topB = ownCorner(bx, by);
        const lowA = nC(ax, ay);
        const lowB = nC(bx, by);
        if (topA - lowA < 0.05 && topB - lowB < 0.05) continue;
        // The engine paints cliff faces either as the upper tile's extra graphics (hanging down) or as the lower
        // tile's (rising up). Carry both projections and let the shader take whichever raster has art there.
        const tn = tileAt(nx, ny)!;
        const nh = baseLevel(nx, ny);
        const sunk = isWater(x, y) ? SEABED_DEPTH : 0;
        const nSunk = isWater(nx, ny) ? SEABED_DEPTH : 0;
        const wallVertex = (cx: number, cy: number, level: number) =>
          map
            ? pushVertex(cx, cy, level, mapPixel(cx, cy, level + sunk), FULL, 1)
            : pushVertex(
                cx,
                cy,
                level,
                tileAtlasPixel(t, x, y, h, cx, cy, level + sunk),
                t.rect,
                1,
                tileAtlasPixel(tn, nx, ny, nh, cx, cy, level + nSunk),
                tn.rect,
              );
        const p0 = wallVertex(ax, ay, topA);
        const p1 = wallVertex(bx, by, topB);
        const p2 = wallVertex(ax, ay, Math.min(lowA, topA));
        const p3 = wallVertex(bx, by, Math.min(lowB, topB));
        // Winding so the face points away from this cell, towards the lower neighbour (front faces only are drawn).
        const e1 = [bx - ax, topB - topA, by - ay];
        // The drop at either end may be zero where a wall tapers out; use the larger one.
        const e2 = [0, Math.min(Math.min(lowA, topA) - topA, Math.min(lowB, topB) - topB), 0];
        const normalX = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
        const normalZ = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
        if (normalX * dx + normalZ * dy > 0) indices.push(p0, p1, p2, p1, p3, p2);
        else indices.push(p0, p2, p1, p1, p2, p3);
      }
    }
  }

  const geometry = new BufferGeometry();
  const count = positions.length / 3;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  // The tile art already contains the engine's slope shading; flat shading normals avoid lighting it twice.
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('atlasUv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('atlasRect', new BufferAttribute(new Float32Array(rects), 4));
  geometry.setAttribute('wall', new BufferAttribute(new Float32Array(walls), 1));
  geometry.setAttribute('atlasUv2', new BufferAttribute(new Float32Array(uvs2), 2));
  geometry.setAttribute('atlasRect2', new BufferAttribute(new Float32Array(rects2), 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const heightTexture = new DataTexture(hGrid, W * SUB + 1, H * SUB + 1, RedFormat, FloatType);
  heightTexture.minFilter = LinearFilter;
  heightTexture.magFilter = LinearFilter;
  heightTexture.needsUpdate = true;

  const wetness = uniform(0);
  const water = createWaterUniforms();
  const mesh = new Mesh(geometry, createMaterial(cache, wetness, water));
  mesh.name = 'ra2-terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  const heightAt = (wx: number, wz: number) => {
    const i = Math.min(W * SUB, Math.max(0, Math.round(wx * SUB)));
    const j = Math.min(H * SUB, Math.max(0, Math.round(wz * SUB)));
    const value = hGrid[j * (W * SUB + 1) + i]!;
    return value >= 50 ? 0 : value;
  };
  void waterLevel;
  return { mesh, heightTexture, heightAt, wetness, waterY: null, water };
}

/** Water templates: TMP land type 9 marks open water in TS/RA2; fall back to template names for safety. */
export function isWaterTile(t: { terrainType: number; file: string }): boolean {
  return t.terrainType === 9 || /^water/i.test(t.file);
}

function createMaterial(cache: Ra2Cache, wetness: ShaderNode, water: WaterUniforms): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const rect: ShaderNode = attribute('atlasRect', 'vec4');
  // Clamp inside the tile's own raster so linear filtering never bleeds a neighbouring atlas entry.
  const colourMap = cache.terrainMap?.texture ?? cache.terrainAtlas;
  const waterMap = cache.terrainMap?.waterMask ?? cache.waterMask;
  const size = cache.terrainMap?.ref ?? cache.manifest.terrainAtlas;
  const halfTexel = vec2(0.5 / size.width, 0.5 / size.height);
  const uv: ShaderNode = clamp(attribute('atlasUv', 'vec2'), rect.xy.add(halfTexel), rect.zw.sub(halfTexel));
  const primary: ShaderNode = texture(colourMap, uv);
  const rect2: ShaderNode = attribute('atlasRect2', 'vec4');
  const uv2: ShaderNode = clamp(attribute('atlasUv2', 'vec2'), rect2.xy.add(halfTexel), rect2.zw.sub(halfTexel));
  const secondary: ShaderNode = texture(colourMap, uv2);
  // Ground surfaces always use their own (dilated) raster colour. Walls take the upper tile's art, else the lower
  // tile's, else neutral rock where neither raster covers the face.
  const wall: ShaderNode = attribute('wall', 'float');
  const upperCover = smoothstep(0.2, 0.6, primary.a);
  const lowerCover = smoothstep(0.2, 0.6, secondary.a);
  const wallColour = mix(mix(color(0x5a5248), secondary.rgb, lowerCover), primary.rgb, upperCover);
  let albedo: ShaderNode = mix(primary.rgb, wallColour, wall);

  const p = positionWorld;
  const puddleNoise = mx_fractal_noise_float(p.mul(0.55), 2, 2, 0.5, 1).mul(0.5).add(0.5);
  const puddle = smoothstep(0.62, 0.68, puddleNoise).mul(wetness);
  albedo = albedo.mul(mix(float(1), float(0.68), wetness)).mul(mix(float(1), float(0.6), puddle));
  // Open water from the original art: the painted colour stays as the water body (so it still reads as RA2 water),
  // with wind waves, sky reflection, sun glints and rain rings on top, and animated foam along the painted shoreline.
  const surface = waterSurface(water);
  const waterness: ShaderNode = texture(waterMap, uv).r.mul(float(1).sub(wall));
  // Foam: a thin, broken band just inside the painted waterline, pulsing as small waves wash in.
  const band = smoothstep(0.15, 0.35, waterness).mul(smoothstep(0.7, 0.4, waterness));
  const foamNoise = mx_noise_float(vec3(p.xz.mul(6.0), time.mul(0.45)))
    .mul(0.5)
    .add(0.5);
  const surf = sin(time.mul(1.6).add(waterness.mul(12.0)).add(foamNoise.mul(4.0)))
    .mul(0.5)
    .add(0.5);
  const foam = band.mul(smoothstep(0.62, 0.9, foamNoise.mul(0.6).add(surf.mul(0.55)))).mul(0.7);
  // Shallows near the shore lean turquoise over the painted navy, which reads as depth without changing the art.
  const shallow = smoothstep(0.95, 0.4, waterness).mul(waterness);
  albedo = mix(albedo, albedo.mul(vec3(0.8, 1.25, 1.2)).add(vec3(0.0, 0.05, 0.06)), shallow.mul(0.8));
  const body = albedo.mul(float(1).sub(surface.fresnel.mul(0.8)));
  material.colorNode = mix(mix(albedo, body, waterness), color(0xe8eef0), foam.mul(0.85));
  material.emissiveNode = surface.sky
    .mul(surface.fresnel)
    .add(surface.glint)
    .mul(waterness.mul(float(1).sub(foam)));
  material.roughnessNode = mix(mix(mix(float(0.95), float(0.5), wetness), float(0.1), puddle), float(0.25), waterness);
  material.metalnessNode = float(0);
  return material;
}
