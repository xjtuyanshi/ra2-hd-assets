import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Frustum,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  PhysicalLightingModel,
  RedFormat,
  Vector3,
  type Object3D,
  type ReflectorNode,
} from 'three/webgpu';
import {
  BRDF_GGX,
  BRDF_Lambert,
  Fn,
  If,
  abs,
  attribute,
  clamp,
  color,
  diffuseColor,
  dot,
  float,
  floor,
  fract,
  max,
  mix,
  normalView,
  positionWorld,
  reflector,
  roughness,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  DEFAULT_ATMOSPHERE_NODES,
  moonlit,
  localLightHeadroom,
  pavedAt,
  puddleNoise,
  sampleLightField,
  weatherGroundClearAt,
  type AtmosphereNodes,
} from '../atmosphere';
import { createWaterUniforms, waterSurface, type WaterUniforms } from '../waterShading';
import type { TerrainBuild } from '../terrain';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT } from '../world';
import { NO_TILE, ra2Screen, type Ra2Cache, tileAtlasPixel } from './cache';
import { srgbScale, terrainGradeAt } from './mapLighting';
import { SHORE_MAX, SHORE_MIN } from './shoreField';
import { spriteLookFor } from './spriteLook';
import { bedWaterLook, reflectionOffset, rippledReflection, waterLook, waterPreset, wetShore } from './waterLook';
import { groupWaterCells, selectWaterMirrorLevels, type WaterCell, type WaterLevel } from './waterLevels';

/**
 * Display compensation of the HD water look. The water (waterLook.ts) was tuned on screen under PBR Neutral, which
 * darkens and saturates dark colours; the faithful display transform (post.ts) shows them as they are, which lifted
 * open water by about 40 %. By day the water body and its reflections are scaled by WATER_LEVEL and the body's
 * saturation by WATER_SATURATION so the water keeps its tuned look, measured against the Neutral renders on RiverRam
 * (the approved concept); at night the display is Neutral again (HdRenderer) and the compensation fades out with it.
 * The legacy water takes no map grade of its own: waterLook mixes the (graded) tile art's hue into the water column.
 * With a painted lake bed, only the in-scattered column receives this compensation; transmitted sand keeps its grade.
 */
const WATER_LEVEL = 0.67;
const WATER_SATURATION = 1.8;

function waterForDisplay(body: ShaderNode, nodes: AtmosphereNodes): ShaderNode {
  const level: ShaderNode = body.mul(WATER_LEVEL);
  const luma: ShaderNode = dot(level, vec3(0.2126, 0.7152, 0.0722));
  return mix(body, mix(vec3(luma), level, WATER_SATURATION).max(0), nodes.faithfulDisplay);
}

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
  /** Water mirror target, or a group of per-level targets; must be in the scene graph. Null without a mirror. */
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
  const waterCells: WaterCell[] = [];

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
      if (isWater(x, y)) waterCells.push({ x, y, level: h });
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
  geometry.setAttribute(
    'contact',
    new BufferAttribute(contactShade(positions, walls, hGrid, W * SUB + 1, H * SUB + 1), 1),
  );
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
  const materials = createMaterials(cache, wetness, water, groupWaterCells(waterCells));
  const mesh = new Mesh(geometry, [materials.ground, materials.wall]);
  mesh.name = 'ra2-terrain';
  mesh.receiveShadow = true;
  // The tile art already paints every cliff's and hill's own shading; a sun shadow cast by the cell-stepped cliff
  // geometry only adds a zig-zag edge the original never shows.
  mesh.castShadow = false;

  const heightAt = (wx: number, wz: number) => {
    const i = Math.min(W * SUB, Math.max(0, Math.round(wx * SUB)));
    const j = Math.min(H * SUB, Math.max(0, Math.round(wz * SUB)));
    const value = hGrid[j * (W * SUB + 1) + i]!;
    return value >= 50 ? 0 : value;
  };
  const waterHeightAt = (wx: number, wz: number): number | undefined => {
    const x = Math.floor(wx),
      z = Math.floor(wz);
    return cellExists(x, z) && isWater(x, z) ? baseLevel(x, z) * LEVEL_HEIGHT : undefined;
  };
  return {
    mesh,
    heightTexture,
    heightAt,
    waterHeightAt,
    wetness,
    waterY: null,
    water,
    reflectionTarget: materials.reflectionTarget,
  };
}

/** Extra shore distance (cells) given to water right at a cliff foot, so it reads as deep water (see waterLook). */
const CLIFF_WATER_DEPTH = 1.5;

/**
 * Contact shading at the feet of cliffs and raised ground (no sun shadow: original maps take none, see the mesh's
 * castShadow). For each ground vertex, every one of eight directions contributes its strongest rise within
 * CONTACT_REACH cells: full at CONTACT_RISE levels or more, fading with distance over CONTACT_FALLOFF cells. The mean,
 * times CONTACT_STRENGTH, darkens the ground (never below CONTACT_FLOOR), so water and shore at a cliff base read deeper
 * and the cliff stands on its base instead of floating over smeared shore art; open ground and plateau tops keep
 * exactly their art. A straight cliff darkens the ground at its foot by about a third, one cell out by a sixth.
 */
const CONTACT_REACH = 2;
const CONTACT_RISE = 1.5;
const CONTACT_FALLOFF = 0.8;
const CONTACT_STRENGTH = 2.0;
const CONTACT_FLOOR = 0.5;

function contactShade(positions: number[], walls: number[], grid: Float32Array, gw: number, gh: number): Float32Array {
  const count = positions.length / 3;
  const out = new Float32Array(count).fill(1);
  const reach = CONTACT_REACH * SUB;
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (let v = 0; v < count; v++) {
    if (walls[v] === 1) continue;
    const gx = Math.round(positions[v * 3]! * SUB);
    const gz = Math.round(positions[v * 3 + 2]! * SUB);
    const own = positions[v * 3 + 1]!;
    let sum = 0;
    for (const [dx, dz] of dirs) {
      const step = Math.hypot(dx, dz) / SUB;
      let best = 0;
      for (let d = 1; d <= reach; d++) {
        const x = gx + dx * d;
        const z = gz + dz * d;
        if (x < 0 || z < 0 || x >= gw || z >= gh) break;
        const h = grid[z * gw + x]!;
        if (h >= 50) continue; // missing cell
        const rise = Math.min(1, Math.max(0, (h - own) / LEVEL_HEIGHT / CONTACT_RISE));
        best = Math.max(best, rise * Math.exp(-(d * step) / CONTACT_FALLOFF));
      }
      sum += best;
    }
    out[v] = Math.max(CONTACT_FLOOR, 1 - (CONTACT_STRENGTH * sum) / dirs.length);
  }
  return out;
}

/** Water templates: TMP land type 9 marks open water in TS/RA2; fall back to template names for safety. */
export function isWaterTile(t: { terrainType: number; file: string }): boolean {
  return t.terrainType === 9 || /^water/i.test(t.file);
}

/** Day rain coefficients, shared by the shader and its asset-free analytical reference below. */
export const WET_GROUND_LOOK = {
  softDiffuse: 0.9,
  pavedDiffuse: 0.75,
  pavedRoughness: 0.26,
  skyFresnel: 0.2,
  puddleLift: 0.14,
  rippleLift: 0.02,
  rippleRadius: 0.14,
  rippleWidth: 0.018,
  rippleFrequency: 1.6,
} as const;

/**
 * CPU reference for flat, unoccluded ground before tone mapping. `puddle` is the soft noise mask, not its wetness-
 * weighted value. Sky gain is relative to the wet diffuse luminance; it preserves the sky hue while avoiding milky
 * white patches on dark asphalt. The night coefficients remain the existing light-reflection presentation.
 */
export function wetGroundResponse(wetness: number, paved: number, puddle: number, night = 0, groundClear = 1) {
  const blend = (a: number, b: number, k: number) => a + (b - a) * k;
  const wet = Math.max(0, Math.min(1, wetness)) * Math.max(0, Math.min(1, groundClear));
  const pool = puddle * wet * paved;
  const diffuse =
    blend(
      1,
      blend(blend(WET_GROUND_LOOK.softDiffuse, 0.93, night), blend(WET_GROUND_LOOK.pavedDiffuse, 0.76, night), paved),
      wet,
    ) * blend(1, blend(1, 0.6, night), pool);
  const sky = WET_GROUND_LOOK.skyFresnel * wet * paved;
  return {
    diffuse,
    puddle: pool,
    roughness: blend(
      blend(0.95, blend(0.7, blend(WET_GROUND_LOOK.pavedRoughness, 0.45, night), paved), wet),
      0.1,
      pool,
    ),
    gloss: wet * blend(paved, 1, night),
    daySkyGain: (sky + (1 + sky) * WET_GROUND_LOOK.puddleLift * pool) * (1 - night),
  };
}

/**
 * Paving loses diffuse light to a glossy water film; its reflected sky is added by wetSheen. Day puddles no longer
 * multiply the tile art by a dirty dark mask. Soft ground only darkens 10 % at saturation and never grows puddles.
 * All wet inputs are footprint-masked by the ground material; walls do not enter this path.
 */
function wetGround(
  albedo: ShaderNode,
  wetness: ShaderNode,
  paved: ShaderNode,
  nodes: AtmosphereNodes,
): { albedo: ShaderNode; puddle: ShaderNode; roughness: ShaderNode } {
  const { night } = nodes;
  const puddle = puddleNoise(positionWorld, float(1).sub(nodes.night)).mul(wetness).mul(paved);
  const darken = mix(
    float(1),
    mix(
      mix(float(WET_GROUND_LOOK.softDiffuse), float(0.93), night),
      mix(float(WET_GROUND_LOOK.pavedDiffuse), float(0.76), night),
      paved,
    ),
    wetness,
  );
  return {
    albedo: albedo.mul(darken).mul(mix(float(1), mix(float(1), float(0.6), night), puddle)),
    puddle,
    roughness: mix(
      mix(float(0.95), mix(float(0.7), mix(float(WET_GROUND_LOOK.pavedRoughness), float(0.45), night), paved), wetness),
      float(0.1),
      puddle,
    ),
  };
}

/** Ground direction towards the fixed camera: mirror images of lights lie on the far side of a puddle, away from it. */
const TOWARDS_CAMERA = vec2(Math.SQRT1_2, Math.SQRT1_2);
/**
 * Where a lamp head about one cell high shows in a puddle: its mirror image lies about head x sqrt 3 in front of the
 * post, so the light seen at a puddle point comes from the ground that far behind it (away from the camera).
 */
const GLINT_REACH = 1.6;

/**
 * Light added on wet paved ground: a faint sky sheen that makes rain read as wet, and in puddles small glints of the
 * lamps and fires mirrored in them. Wet paving reflects lights mainly as streaks (emitters.ts), not as a brighter pool:
 * a sheen proportional to the local light, added regardless of albedo, lifted dark asphalt under every lamp into a
 * broad golden haze, so the glints are sparse sparkles (a twinkling hash over small cells) sampling the light
 * field behind the point. Day paving reflects the overcast sky at a 0.20 isometric Fresnel weight, with sky luminance
 * relative to the lit wet art: saturated puddles are 14 % brighter than adjacent wet asphalt. Small expanding impact
 * rings only brighten that reflected term. The night path retains its existing dim sky and sparse lamp glints.
 */
function wetSheen(
  albedo: ShaderNode,
  light: ShaderNode,
  sky: ShaderNode,
  wetness: ShaderNode,
  paved: ShaderNode,
  puddle: ShaderNode,
  nodes: AtmosphereNodes,
): ShaderNode {
  const { night, sceneBrightness } = nodes;
  const wetPaved = wetness.mul(paved);
  const skyLevel = mix(float(1), sceneBrightness.min(1).mul(0.5), night);
  const mirroredLight: ShaderNode = sampleLightField(positionWorld.xz.sub(TOWARDS_CAMERA.mul(GLINT_REACH)), nodes);
  // Glint cells are thin across the view and long towards the camera, so each sparkle reads as a tiny upright streak.
  const xz: ShaderNode = positionWorld.xz;
  const cell = floor(vec2(dot(xz, vec2(Math.SQRT1_2, -Math.SQRT1_2)).mul(16), dot(xz, TOWARDS_CAMERA).mul(5)));
  const hash = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const sparkle = step(0.95, fract(hash.add(time.mul(0.35))));
  const nightSheen = light
    .mul(puddle.mul(0.015))
    .add(mirroredLight.mul(puddle).mul(sparkle).mul(0.16))
    .add(sky.mul(float(0.03).add(puddle.mul(0.045))).mul(skyLevel))
    .mul(wetPaved);
  // An independent impact in each small cell keeps rings spatially sparse and avoids coherent waves over a road.
  const rippleCell: ShaderNode = floor(xz.mul(2.2));
  const rippleSeed = fract(sin(dot(rippleCell, vec2(91.73, 37.19))).mul(42319.173));
  const rippleCentre = vec2(
    fract(rippleSeed.mul(17.13)).mul(0.3).add(0.35),
    fract(rippleSeed.mul(31.71)).mul(0.3).add(0.35),
  );
  const phase = fract(time.mul(WET_GROUND_LOOK.rippleFrequency).add(rippleSeed));
  const radius = phase.mul(WET_GROUND_LOOK.rippleRadius);
  const distance = xz.mul(2.2).fract().sub(rippleCentre).div(2.2).length();
  const ring = float(1)
    .sub(smoothstep(WET_GROUND_LOOK.rippleWidth * 0.3, WET_GROUND_LOOK.rippleWidth, abs(distance.sub(radius))))
    .mul(float(1).sub(phase))
    .mul(smoothstep(0, 0.12, phase))
    .mul(nodes.rainAmount);
  const skyLuma = dot(sky, vec3(0.2126, 0.7152, 0.0722)).max(1e-4);
  const wetLitLuma = dot(albedo.mul(nodes.sceneLevel), vec3(0.2126, 0.7152, 0.0722))
    .mul(nodes.referenceLevel)
    .mul(1 / Math.PI);
  const reflected = wetPaved.mul(WET_GROUND_LOOK.skyFresnel);
  const puddleLift = float(1)
    .add(reflected)
    .mul(puddle)
    .mul(float(WET_GROUND_LOOK.puddleLift).add(ring.mul(WET_GROUND_LOOK.rippleLift)));
  const daySheen = sky.div(skyLuma).mul(wetLitLuma).mul(reflected.add(puddleLift));
  return mix(daySheen, nightSheen, night);
}

/**
 * Lighting for original tile art: plain Lambert diffuse from the sun and sky, and specular only where the ground is wet
 * (`gloss`). three's physical model takes the Fresnel share out of the diffuse light and adds a 4 % dielectric
 * highlight everywhere; on painted tiles that lifted every dark colour by about 0.02 (linear) and cut the rest by 5 %,
 * which read as haze over the whole battlefield (flat ground is calibrated to show the art exactly at clear noon).
 */
class ArtLightingModel extends PhysicalLightingModel {
  constructor(private readonly gloss: ShaderNode) {
    super();
  }

  override direct({
    lightDirection,
    lightColor,
    reflectedLight,
  }: Parameters<PhysicalLightingModel['direct']>[0]): void {
    const irradiance: ShaderNode = (normalView as ShaderNode).dot(lightDirection).clamp().mul(lightColor);
    (reflectedLight.directDiffuse as ShaderNode).addAssign(
      irradiance.mul(BRDF_Lambert({ diffuseColor: (diffuseColor as ShaderNode).rgb })),
    );
    (reflectedLight.directSpecular as ShaderNode).addAssign(
      irradiance.mul(BRDF_GGX({ lightDirection, f0: vec3(0.04), f90: 1, roughness } as never)).mul(this.gloss),
    );
  }

  override indirect(builder: Parameters<PhysicalLightingModel['indirect']>[0]): void {
    const { irradiance, reflectedLight } = builder.context as unknown as {
      irradiance: ShaderNode;
      reflectedLight: { indirectDiffuse: ShaderNode };
    };
    reflectedLight.indirectDiffuse.addAssign(
      irradiance.mul(BRDF_Lambert({ diffuseColor: (diffuseColor as ShaderNode).rgb })),
    );
  }
}

class ArtMaterial extends MeshStandardNodeMaterial {
  /** 0 = dry art (diffuse only) .. 1 = full wet specular. */
  gloss: ShaderNode = float(0);
  override setupLightingModel(): PhysicalLightingModel {
    return new ArtLightingModel(this.gloss);
  }
}

/**
 * Schedule one of the enhanced bed's per-level mirrors: skip its render while its level's water is off screen, and
 * keep the shared NodeFrame intact for the next mirror. three r186 runs every mirror of the ground material from the
 * same NodeFrame while drawing the ground; a mirror's nested scene render overwrites that frame's camera, material,
 * object and scene with the last object it drew, so without restoring them the second mirror rendered from the first
 * mirror's virtual camera and hid the wrong material: only one level ever showed reflections.
 */
function scheduleWaterMirror(mirror: ReflectorNode, level: WaterLevel): void {
  const y = level.level * LEVEL_HEIGHT;
  const bounds = new Box3(
    new Vector3(level.minX, y, level.minY),
    new Vector3(level.maxX + 1, y, level.maxY + 1),
  ).expandByScalar(1);
  const projectionView = new Matrix4();
  const frustum = new Frustum();
  // r186 schedules ReflectorBaseNode, shared by the colour and depth samples, rather than the texture wrapper.
  const instance = mirror.reflector;
  const updateBefore = instance.updateBefore;
  instance.updateBefore = (frame) => {
    const { camera, material, object, scene, renderer } = frame;
    if (camera) {
      projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionView, camera.coordinateSystem, camera.reversedDepth);
      // No fragment from this level is visible, so its previous colour/depth texture can safely remain untouched.
      // No fragment from this level is visible, so its previous colour/depth texture can safely remain untouched.
      if (!frustum.intersectsBox(bounds)) return;
    }
    const result = updateBefore.call(instance, frame);
    frame.camera = camera;
    frame.material = material;
    frame.object = object;
    frame.scene = scene;
    frame.renderer = renderer;
    return result;
  };
}

/**
 * Terrain materials. Ground and cliff walls are separate materials because the water's mirrored render hides the
 * material that samples it: with walls on their own material, cliffs still appear in the reflection.
 */
function createMaterials(
  cache: Ra2Cache,
  wetness: ShaderNode,
  water: WaterUniforms,
  waterLevels: readonly WaterLevel[],
): { ground: MeshStandardNodeMaterial; wall: MeshStandardNodeMaterial; reflectionTarget: Object3D | null } {
  const nodes = cache.nodes ?? DEFAULT_ATMOSPHERE_NODES;
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
  const wall = new ArtMaterial();
  {
    const upper = sample('atlasUv', 'atlasRect').colour;
    const lower = sample('atlasUv2', 'atlasRect2').colour;
    const upperCover = smoothstep(0.2, 0.6, upper.a);
    const lowerCover = smoothstep(0.2, 0.6, lower.a);
    const colour = srgbScale(
      mix(mix(color(0x5a5248), lower.rgb, lowerCover), upper.rgb, upperCover),
      terrainGradeAt(cache.mapLight, positionWorld.xz),
    );
    // The sun and sky see the night-desaturated albedo; local lights (emissive) the full colour.
    // Ground rain never paints a water film on vertical art, even when the adjoining cell is paved.
    wall.colorNode = moonlit(colour, nodes);
    wall.gloss = float(0);
    wall.roughnessNode = float(0.95);
    wall.metalnessNode = float(0);
    // Local lights (map light sources, lamps, fires, explosions) from the light field, as diffuse irradiance.
    wall.emissiveNode = localLightHeadroom(
      colour
        .mul(nodes.sceneLevel)
        .mul(nodes.referenceLevel)
        .mul(1 / Math.PI),
      colour.mul(sampleLightField(positionWorld.xz, nodes)).mul(1 / Math.PI),
      nodes.localLightCap,
    );
  }

  const ground = new ArtMaterial();
  const { uv, colour: raw } = sample('atlasUv', 'atlasRect');
  // Tile art under the map's own light (see mapLighting.ts), as the engine draws it.
  const grade: ShaderNode = terrainGradeAt(cache.mapLight, positionWorld.xz);
  const art: ShaderNode = vec4(srgbScale(raw.rgb, grade), raw.a);
  // The surface texture is linearly filtered for ordinary light dressing. Weather must not borrow paving from a
  // neighbouring road into a grass/sand cell; retain the established continuous night blend.
  const paved: ShaderNode = mix(
    pavedAt(floor(positionWorld.xz).add(0.5), nodes),
    pavedAt(positionWorld.xz, nodes),
    nodes.night,
  );
  const localLight: ShaderNode = sampleLightField(positionWorld.xz, nodes);
  const groundWetness = wetness.mul(weatherGroundClearAt(positionWorld.xz, nodes));
  const wet = wetGround(art.rgb, groundWetness, paved, nodes);
  let albedo: ShaderNode = wet.albedo;
  let roughness: ShaderNode = wet.roughness;
  let gloss: ShaderNode = groundWetness.mul(mix(paved, float(1), nodes.night));
  let sheen: ShaderNode = wetSheen(wet.albedo, localLight, water.skyHorizon, groundWetness, paved, wet.puddle, nodes);
  let weatherLand: ShaderNode = float(1);
  let reflectionTarget: Object3D | null = null;
  const map = cache.terrainMap;
  if (map) {
    // Whole-map terrain: depth, foam and wet sand come from the signed shore distance, reflections from a mirrored
    // render of the scene at the water's level (see waterLook.ts).
    // Water at the foot of a cliff is deep in the original art (the wall drops straight into it). There the painted
    // mask leaves small islands of shore rock that the upscaled art smears into pale blotches ringed with foam, so
    // water and land within a few tenths of a cell of it at a cliff foot become deep water: no islands, sandy bed,
    // caustics or lapping foam. Land further from the water keeps its art.
    const nearCliff: ShaderNode = clamp(float(1).sub(attribute('contact', 'float')).mul(6), 0, 1);
    const painted: ShaderNode = texture(map.shore, uv)
      .r.mul(SHORE_MAX - SHORE_MIN)
      .add(SHORE_MIN);
    const cliffWater: ShaderNode = nearCliff.mul(smoothstep(-0.45, -0.15, painted));
    const shore: ShaderNode = painted.add(cliffWater.mul(CLIFF_WATER_DEPTH));
    // Water wherever the painted mask or the distance field says so; the soft painted shore band (grey foam art) is
    // replaced by our own shoreline instead of blending with it.
    const waterness: ShaderNode = smoothstep(0.3, 0.55, texture(map.waterMask, uv).r)
      .max(smoothstep(0.0, 0.08, shore))
      .max(cliffWater);
    weatherLand = float(1).sub(waterness);
    let reflection: { colour: ShaderNode; coverage: ShaderNode } | undefined;
    if (map.waterBed && waterPreset.style === 'enhanced') {
      const levels = selectWaterMirrorLevels(waterLevels);
      if (levels.length) {
        const targets = new Group();
        let colour: ShaderNode = vec3(0);
        let coverage: ShaderNode = float(0);
        for (const level of levels) {
          const waterY = level.level * LEVEL_HEIGHT;
          const mirror = reflector({ resolutionScale: 0.5, depth: true });
          mirror.target.rotateX(-Math.PI / 2);
          mirror.target.position.y = waterY;
          targets.add(mirror.target);
          scheduleWaterMirror(mirror, level);
          const rippled = rippledReflection(mirror, positionWorld, water);
          // Base levels are at least LEVEL_HEIGHT apart, so plane weights never overlap; omitted levels keep sky.
          const onPlane: ShaderNode = smoothstep(
            0.3 * LEVEL_HEIGHT,
            0.1 * LEVEL_HEIGHT,
            abs(positionWorld.y.sub(waterY)),
          );
          colour = colour.add(rippled.colour.mul(onPlane));
          coverage = coverage.add(rippled.coverage.mul(onPlane));
        }
        reflection = { colour, coverage };
        reflectionTarget = targets;
      }
    } else if (waterLevels.length) {
      // Classic and legacy enhanced water retain the single lowest mirror, including levels with fewer than 12 cells.
      const waterY = waterLevels.reduce((lowest, { level }) => Math.min(lowest, level), Infinity) * LEVEL_HEIGHT;
      const mirror = reflector({ resolutionScale: 0.5, depth: true });
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = waterY;
      const offset: ShaderNode = reflectionOffset(positionWorld.xz, water.wind, water.rain);
      mirror.uvNode = (mirror.uvNode as ShaderNode).add(offset);
      const depth = mirror.getDepthNode() as ShaderNode;
      depth.uvNode = mirror.uvNode;
      reflection = { colour: (mirror as ShaderNode).rgb, coverage: smoothstep(0.9999, 0.999, depth.x) };
      reflectionTarget = mirror.target;
    }
    // Sheltered water within about 1.5 cells of a cliff: no surf there, so the scree the art paints at a cliff foot is
    // not outlined in foam (the enhanced look's `calm`).
    const calm: ShaderNode = clamp(float(1).sub(attribute('contact', 'float')).mul(12), 0, 1);
    if (map.waterBed && waterPreset.style === 'enhanced') {
      // No inland band replacement: the mask includes the old shallows and the composite already paints real sand.
      const bedAt = (offsetXZ: ShaderNode): ShaderNode => {
        // World xz -> original engine screen pixels -> composite UV; height does not change under refraction.
        const offsetUv = vec2(
          offsetXZ.x.sub(offsetXZ.y).mul((30 * map.ref.scale) / map.ref.width),
          offsetXZ.x.add(offsetXZ.y).mul((15 * map.ref.scale) / map.ref.height),
        );
        const bed = srgbScale(
          texture(colourMap, clamp(uv.add(offsetUv), halfTexel, vec2(1).sub(halfTexel))).rgb,
          grade,
        );
        // Share rain darkening with the adjacent land, including at exactly zero optical depth.
        return wetGround(bed, groundWetness, paved, nodes).albedo;
      };
      const look = bedWaterLook(
        {
          position: positionWorld,
          shore,
          waterness,
          art: albedo,
          uniforms: water,
          reflection,
          calm,
          bedAt,
          detail: map.waterDetail ? texture(map.waterDetail, uv) : undefined,
          surface: map.waterSurface ?? undefined,
          cliff: map.cliff ? texture(map.cliff, uv).r : undefined,
          columnForDisplay: (column) => waterForDisplay(column, nodes),
          reflectionLevel: mix(float(1), float(WATER_LEVEL), nodes.faithfulDisplay),
        },
        nodes,
      );
      // The same sheet and foam cross onto land, independently of the static water mask.
      albedo = mix(mix(look.land, look.body, look.coverage), look.foamColour, look.foam);
      roughness = mix(roughness, look.roughness, look.wetness.max(waterness));
      gloss = max(gloss, look.gloss);
      sheen = sheen.mul(float(1).sub(look.openWater));
      ground.emissiveNode = look.emission;
    } else {
      const look = waterLook(
        { position: positionWorld, shore, waterness, art: art.rgb, uniforms: water, reflection, calm },
        nodes,
      );
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
      const inland: ShaderNode = srgbScale(
        texture(colourMap, uv.sub(towardsWater.mul(reach).mul(smoothstep(-0.7, 0.0, shore)))).rgb,
        grade,
      );
      const band = smoothstep(-0.55, -0.12, shore);
      const sand = wetShore(shore);
      const land = mix(albedo, wetGround(inland, groundWetness, paved, nodes).albedo, band).mul(
        mix(float(1), float(0.8), sand),
      );
      albedo = mix(land, waterForDisplay(look.body, nodes), waterness);
      roughness = mix(mix(roughness, float(0.35), sand), float(1), waterness);
      sheen = sheen.mul(float(1).sub(waterness));
      ground.emissiveNode = look.emission.mul(mix(float(1), float(WATER_LEVEL), nodes.faithfulDisplay));
    }
  } else {
    // Per-tile atlas fallback: the painted water with sky reflection and glints, as before.
    const surface = waterSurface(water);
    const waterness: ShaderNode = texture(cache.waterMask, uv).r;
    weatherLand = float(1).sub(waterness);
    const body = albedo.mul(float(1).sub(surface.fresnel.mul(0.8)));
    albedo = mix(albedo, body, waterness);
    ground.emissiveNode = surface.sky.mul(surface.fresnel).add(surface.glint).mul(waterness);
    roughness = mix(roughness, float(0.25), waterness);
  }
  // Contact shading darkens every light at cliff feet (an occlusion term); the sun and sky see the night-desaturated
  // albedo, local lights (emissive, below) the full colour.
  const look = spriteLookFor(nodes);
  const contact = Fn(() => {
    const value: ShaderNode = attribute('contact', 'float').toVar();
    If(look.enabled.greaterThan(0.5).and(look.contactShade.notEqual(1)), () => {
      value.assign(float(1).sub(float(1).sub(value).mul(look.contactShade).min(0.85)));
    });
    If(nodes.weatherSunShare.notEqual(1), () => {
      value.assign(float(1).sub(float(1).sub(value).mul(nodes.weatherSunShare)));
    });
    return value;
  })();
  const litAlbedo = albedo;
  albedo = Fn(() => {
    const value = litAlbedo.toVar();
    If(nodes.weatherDesaturation.greaterThan(0), () => {
      const luma = dot(value, vec3(0.2126, 0.7152, 0.0722));
      value.assign(mix(value, vec3(luma), nodes.weatherDesaturation.mul(weatherLand)));
    });
    return value;
  })();
  albedo = albedo.mul(contact);
  ground.colorNode = moonlit(albedo, nodes);
  // Dry original art has no sheen of its own; wet ground and puddles reflect the sun.
  ground.gloss = gloss;
  ground.roughnessNode = roughness;
  ground.metalnessNode = float(0);
  // Local lights from the light field (exactly zero by day without explosions), plus the wet paved sheen.
  ground.emissiveNode = (ground.emissiveNode as ShaderNode)
    .add(
      localLightHeadroom(
        albedo
          .mul(nodes.sceneLevel)
          .mul(nodes.referenceLevel)
          .mul(1 / Math.PI),
        albedo.mul(localLight).mul(1 / Math.PI),
        nodes.localLightCap,
      ),
    )
    .add(sheen);
  return { ground, wall, reflectionTarget };
}
