import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  RedFormat,
  type Object3D,
} from 'three/webgpu';
import {
  attribute,
  clamp,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  positionWorld,
  reflector,
  smoothstep,
  texture,
  uniform,
  vec2,
} from 'three/tsl';
import { createWaterUniforms, waterSurface, type WaterUniforms } from '../waterShading';
import type { TerrainBuild } from '../terrain';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT } from '../world';
import { NO_TILE, ra2Screen, type Ra2Cache, tileAtlasPixel } from './cache';
import { SHORE_MAX, SHORE_MIN } from './shoreField';
import { waterLook, waveNormal, wetShore } from './waterLook';

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
  /** Mirror plane of the water reflections; must be in the scene graph. Null without open water. */
  reflectionTarget: Object3D | null;
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
  // Ground triangles first, then cliff walls, each drawn with its own material (see createMaterials).
  const groundIndices: number[] = [];
  const wallIndices: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const target = walls[indices[i]!] === 1 ? wallIndices : groundIndices;
    target.push(indices[i]!, indices[i + 1]!, indices[i + 2]!);
  }
  geometry.setIndex([...groundIndices, ...wallIndices]);
  geometry.addGroup(0, groundIndices.length, 0);
  geometry.addGroup(groundIndices.length, wallIndices.length, 1);
  geometry.computeBoundingSphere();

  const heightTexture = new DataTexture(hGrid, W * SUB + 1, H * SUB + 1, RedFormat, FloatType);
  heightTexture.minFilter = LinearFilter;
  heightTexture.magFilter = LinearFilter;
  heightTexture.needsUpdate = true;

  const wetness = uniform(0);
  const water = createWaterUniforms();
  // The mirror plane sits on the lowest water level (open water in original maps is flat).
  const waterY = Number.isFinite(waterLevel) ? waterLevel * LEVEL_HEIGHT : null;
  const materials = createMaterials(cache, wetness, water, waterY);
  const mesh = new Mesh(geometry, [materials.ground, materials.wall]);
  mesh.name = 'ra2-terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  const heightAt = (wx: number, wz: number) => {
    const i = Math.min(W * SUB, Math.max(0, Math.round(wx * SUB)));
    const j = Math.min(H * SUB, Math.max(0, Math.round(wz * SUB)));
    const value = hGrid[j * (W * SUB + 1) + i]!;
    return value >= 50 ? 0 : value;
  };
  return { mesh, heightTexture, heightAt, wetness, waterY: null, water, reflectionTarget: materials.reflectionTarget };
}

/** Water templates: TMP land type 9 marks open water in TS/RA2; fall back to template names for safety. */
export function isWaterTile(t: { terrainType: number; file: string }): boolean {
  return t.terrainType === 9 || /^water/i.test(t.file);
}

/** Ground albedo shared by both materials: wetness darkening and rain puddles on top of the original art. */
function wetGround(albedo: ShaderNode, wetness: ShaderNode): { albedo: ShaderNode; puddle: ShaderNode } {
  const puddleNoise = mx_fractal_noise_float(positionWorld.mul(0.55), 2, 2, 0.5, 1).mul(0.5).add(0.5);
  const puddle = smoothstep(0.62, 0.68, puddleNoise).mul(wetness);
  return { albedo: albedo.mul(mix(float(1), float(0.68), wetness)).mul(mix(float(1), float(0.6), puddle)), puddle };
}

/**
 * Terrain materials. Ground and cliff walls are separate materials because the water's mirrored render hides the
 * material that samples it: with walls on their own material, cliffs still appear in the reflection.
 */
function createMaterials(
  cache: Ra2Cache,
  wetness: ShaderNode,
  water: WaterUniforms,
  waterY: number | null,
): { ground: MeshStandardNodeMaterial; wall: MeshStandardNodeMaterial; reflectionTarget: Object3D | null } {
  const colourMap = cache.terrainMap?.texture ?? cache.terrainAtlas;
  const size = cache.terrainMap?.ref ?? cache.manifest.terrainAtlas;
  const halfTexel = vec2(0.5 / size.width, 0.5 / size.height);
  // Clamp inside the tile's own raster so linear filtering never bleeds a neighbouring atlas entry.
  const sample = (uvName: string, rectName: string) => {
    const rect: ShaderNode = attribute(rectName, 'vec4');
    const uv: ShaderNode = clamp(attribute(uvName, 'vec2'), rect.xy.add(halfTexel), rect.zw.sub(halfTexel));
    return { uv, colour: texture(colourMap, uv) as ShaderNode };
  };

  // Cliff walls take the upper tile's art, else the lower tile's, else neutral rock where neither raster covers the face.
  const wall = new MeshStandardNodeMaterial();
  {
    const upper = sample('atlasUv', 'atlasRect').colour;
    const lower = sample('atlasUv2', 'atlasRect2').colour;
    const upperCover = smoothstep(0.2, 0.6, upper.a);
    const lowerCover = smoothstep(0.2, 0.6, lower.a);
    const colour = mix(mix(color(0x5a5248), lower.rgb, lowerCover), upper.rgb, upperCover);
    const wet = wetGround(colour, wetness);
    wall.colorNode = wet.albedo;
    wall.roughnessNode = mix(float(0.95), float(0.55), wetness);
    wall.metalnessNode = float(0);
  }

  const ground = new MeshStandardNodeMaterial();
  const { uv, colour: art } = sample('atlasUv', 'atlasRect');
  const wet = wetGround(art.rgb, wetness);
  let albedo: ShaderNode = wet.albedo;
  let roughness: ShaderNode = mix(mix(float(0.95), float(0.5), wetness), float(0.1), wet.puddle);
  let reflectionTarget: Object3D | null = null;
  const map = cache.terrainMap;
  if (map) {
    // Whole-map terrain: depth, foam and wet sand come from the signed shore distance, reflections from a mirrored
    // render of the scene at the water's level (see waterLook.ts).
    const shore: ShaderNode = texture(map.shore, uv)
      .r.mul(SHORE_MAX - SHORE_MIN)
      .add(SHORE_MIN);
    // Water wherever the painted mask or the distance field says so; the soft painted shore band (grey foam art) is
    // replaced by our own shoreline instead of blending with it.
    const waterness: ShaderNode = smoothstep(0.3, 0.55, texture(map.waterMask, uv).r).max(smoothstep(0.0, 0.08, shore));
    let reflection: { colour: ShaderNode; coverage: ShaderNode } | undefined;
    if (waterY !== null) {
      const mirror = reflector({ resolutionScale: 0.5, depth: true });
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = waterY;
      const offset: ShaderNode = waveNormal(positionWorld.xz, water.wind, water.rain).xz.mul(0.015);
      mirror.uvNode = (mirror.uvNode as ShaderNode).add(offset);
      const depth = mirror.getDepthNode() as ShaderNode;
      depth.uvNode = mirror.uvNode;
      reflection = { colour: (mirror as ShaderNode).rgb, coverage: smoothstep(0.9999, 0.999, depth.x) };
      reflectionTarget = mirror.target;
    }
    const look = waterLook({ position: positionWorld, shore, waterness, art: art.rgb, uniforms: water, reflection });
    // The original paints a grey-blue wet band along every shore. Replace that band with the ground found a little
    // further inland (stepping against the distance field's gradient), then darken it as wet sand, so the shoreline
    // reads as sand -> wet sand -> foam -> shallows instead of a dark outline.
    const texelU = 1 / map.shore.image.width;
    const texelV = 1 / map.shore.image.height;
    const gradU = texture(map.shore, uv.add(vec2(texelU, 0))).r.sub(texture(map.shore, uv.sub(vec2(texelU, 0))).r);
    const gradV = texture(map.shore, uv.add(vec2(0, texelV))).r.sub(texture(map.shore, uv.sub(vec2(0, texelV))).r);
    const towardsWater: ShaderNode = vec2(gradU, gradV).normalize();
    // Step about 0.7 cells inland, measured in composite pixels (one cell spans roughly 42 engine pixels).
    const reach = vec2((0.7 * 42 * map.ref.scale) / map.ref.width, (0.35 * 42 * map.ref.scale) / map.ref.height);
    const inland: ShaderNode = texture(
      colourMap,
      uv.sub(towardsWater.mul(reach).mul(smoothstep(-0.7, 0.0, shore))),
    ).rgb;
    const band = smoothstep(-0.55, -0.12, shore);
    const sand = wetShore(shore);
    const land = mix(albedo, wetGround(inland, wetness).albedo, band).mul(mix(float(1), float(0.8), sand));
    albedo = mix(land, look.body, waterness);
    roughness = mix(mix(roughness, float(0.35), sand), float(1), waterness);
    ground.emissiveNode = look.emission;
  } else {
    // Per-tile atlas fallback: the painted water with sky reflection and glints, as before.
    const surface = waterSurface(water);
    const waterness: ShaderNode = texture(cache.waterMask, uv).r;
    const body = albedo.mul(float(1).sub(surface.fresnel.mul(0.8)));
    albedo = mix(albedo, body, waterness);
    ground.emissiveNode = surface.sky.mul(surface.fresnel).add(surface.glint).mul(waterness);
    roughness = mix(roughness, float(0.25), waterness);
  }
  ground.colorNode = albedo;
  ground.roughnessNode = roughness;
  ground.metalnessNode = float(0);
  return { ground, wall, reflectionTarget };
}
