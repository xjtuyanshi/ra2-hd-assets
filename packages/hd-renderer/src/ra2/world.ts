import { DataTexture, LinearFilter, Object3D, RGFormat, UnsignedByteType, Vector3 } from 'three/webgpu';
import { SURFACE, surfaceFromLandType } from '../../../ra2-assets/src/lights';
import type { MapObject } from '../../../ra2-assets/src/manifest';
import { AtmosphereNodes, type WorldDressing } from '../atmosphere';
import type { TerrainBuild } from '../terrain';
import { decodeBase64, loadRa2Cache, paletteFor, type Ra2Cache, type Ra2CacheOptions } from './cache';
import type { MapLightGrade } from './mapLighting';
import { Ra2NightDressing } from './nightDressing';
import { SpriteLayer, cardPush, objectAnchor, type SpriteInstance } from './sprites';
import { buildRa2Terrain } from './terrain';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  setVoxelShapeFor,
  voxelShapeFor,
  type VoxelGeometry,
  type VoxelShape,
} from './voxels';
import { loadVoxelLighting } from './vpl';

/** A battlefield the HD renderer can draw: terrain, optional water, and everything standing on it. */
export interface HdWorld {
  nodes?: AtmosphereNodes;
  width: number;
  height: number;
  terrain: TerrainBuild;
  waterY: number | null;
  /** Per-pixel water shading inputs when water is part of the terrain material. */
  water?: import('../waterShading').WaterUniforms;
  root: Object3D;
  /** Where the camera starts (world units). */
  focus: Vector3;
  sprites?: SpriteLayer;
  cache?: Ra2Cache;
  /** Per-cell surface (RG8, linear): R = paved (asphalt, concrete, brick, roads), G = open water. */
  surfaceTexture?: DataTexture;
  /** Per-cell SurfaceClass (ra2-assets lights.ts), from the light sidecar or the land-type fallback. */
  surface?: Uint8Array;
  /** Night dressing: map light sources, HD street lamps, window glows. */
  dressing?: WorldDressing & Ra2NightDressing;
  /** The engine's per-cell light of the map ([Lighting] plus light sources), applied by day (see mapLighting.ts). */
  mapLight?: MapLightGrade;
}

/** Surface classes per cell: the sidecar's (tile colours) when present, else land types only. */
function cellSurface(cache: Ra2Cache): Uint8Array {
  const { manifest } = cache;
  const W = manifest.grid.width;
  const H = manifest.grid.height;
  const fromSidecar = cache.lights ? decodeBase64(cache.lights.cells.surface) : null;
  if (fromSidecar && fromSidecar.length === W * H) return fromSidecar;
  return surfaceFromLandType(
    { width: W, height: H, exists: cache.exists, tile: cache.tile },
    manifest.tiles,
    manifest.theater,
  );
}

function surfaceTexture(surface: Uint8Array, width: number, height: number): DataTexture {
  const data = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const s = surface[i]!;
    data[i * 2] = s === SURFACE.paved || s === SURFACE.road ? 255 : 0;
    data[i * 2 + 1] = s === SURFACE.water ? 255 : 0;
  }
  const texture = new DataTexture(data, width, height, RGFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Build the original map from a local HD cache (gameres/hd-cache/<map>/, served by the sandbox dev server). */
export async function loadRa2World(
  base: string,
  options: {
    extraObjects?: (manifest: Ra2Cache['manifest']) => MapObject[];
    /** Immutable per-world voxel refinement; defaults are captured before asynchronous resource loading starts. */
    voxelShape?: Readonly<VoxelShape>;
    /** Keep only map objects passing this test (a live match draws units and buildings from game memory instead). */
    includeObject?: (object: MapObject) => boolean;
  } & Ra2CacheOptions = {},
): Promise<HdWorld> {
  const nodes = options.nodes ?? new AtmosphereNodes();
  if (options.voxelShape) setVoxelShapeFor(nodes, options.voxelShape);
  else voxelShapeFor(nodes);
  // The engine's voxel lighting table lives next to the map caches, in the type library's common directory; without
  // it voxels use a fitted fallback curve.
  const [cache] = await Promise.all([
    loadRa2Cache(base, { ...options, nodes }),
    loadVoxelLighting(`${base.replace(/\/$/, '')}/../_library/common/voxels-vpl.json`, nodes),
  ]);
  const { manifest } = cache;
  // InvisibleInGame objects (lamp-post dummies such as INGALITE) are never drawn by the engine.
  const hidden = new Set(cache.lights?.hiddenObjects ?? []);
  const placed = manifest.objects.filter(
    (object, i) => !hidden.has(i) && (options.includeObject ? options.includeObject(object) : true),
  );
  const objects = [...placed, ...(options.extraObjects?.(manifest) ?? [])];
  const terrain = buildRa2Terrain(cache);
  const root = new Object3D();
  root.name = 'ra2-world';
  if (terrain.reflectionTarget) root.add(terrain.reflectionTarget);

  // Geometry is shared per model/refinement; each owner gets its palette material.
  const voxelMaterial = createVoxelMaterial(nodes);
  const geometries = new Map<string, VoxelGeometry[]>();
  const sprites: SpriteInstance[] = [];
  for (const object of objects) {
    const anchor = objectAnchor(object);
    if (object.voxel) {
      const model = cache.voxels.get(object.voxel);
      if (!model) continue;
      const paletteKey = paletteFor(cache, model.palette, true, object.owner);
      const cacheKey = `${object.voxel}@${paletteKey}`;
      let parts = geometries.get(cacheKey);
      if (!parts) {
        parts = buildVoxelGeometry(model, cache.paletteRgb.get(paletteKey)!, nodes);
        geometries.set(cacheKey, parts);
      }
      const { root: vehicle } = instantiateVoxel(parts, voxelMaterial);
      vehicle.position.copy(anchor);
      vehicle.position.y = Math.max(anchor.y, terrain.heightAt(anchor.x, anchor.z));
      // Engine facing 0 = north (world -z), clockwise; the model's nose is local +x.
      const phi = ((object.facing ?? 0) / 256) * Math.PI * 2;
      vehicle.rotation.y = Math.PI / 2 - phi;
      root.add(vehicle);
      continue;
    }
    if (!object.sprite) continue;
    const entry = manifest.sprites[object.sprite];
    if (!entry || entry.frames.length === 0) continue;
    const frameIndex = Math.min(object.frame ?? 0, entry.frames.length - 1);
    const palette = paletteFor(cache, entry.palette, entry.remap, object.owner);
    const frame = entry.frames[frameIndex]!;
    const flat = !!object.flat;
    const push = cardPush(frame);
    // The extractor records how the engine lights each object (absent = 'full', terrain-class art).
    const lighting = object.lighting ?? 'full';
    for (const underlay of entry.underlays ?? []) {
      const bib = manifest.sprites[underlay];
      if (bib?.frames[0])
        sprites.push({
          anchor,
          frame: bib.frames[0],
          palette: paletteFor(cache, bib.palette, bib.remap, object.owner),
          push: 0,
          shadow: false,
          flat: true,
          lighting,
        });
    }
    // Shadows are cast on the ground: draw them as decals too.
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) sprites.push({ anchor, frame: shadow, palette, push: 0, shadow: true, flat: true });
    sprites.push({ anchor, frame, palette, push, shadow: false, flat, lighting });
    for (const layer of entry.layers ?? []) {
      const art = manifest.sprites[layer];
      if (art?.frames[0])
        sprites.push({
          anchor,
          frame: art.frames[0],
          palette: paletteFor(cache, art.palette, art.remap, object.owner),
          push: push + 0.01,
          shadow: false,
          lighting,
        });
    }
  }
  const spriteLayer = new SpriteLayer(
    cache,
    sprites,
    sprites.length,
    undefined,
    cache.spriteAtlasHd,
    cache.windows?.texture ?? null,
  );
  root.add(spriteLayer.mesh);
  const surface = cellSurface(cache);
  const mapLight = cache.mapLight ?? undefined;
  const dressing = new Ra2NightDressing({
    cache,
    heightAt: terrain.heightAt,
    root,
    objects,
    mapLight,
  });

  const waypoint = manifest.waypoints.find((w) => w.id === 0) ?? manifest.waypoints[0];
  const focus = waypoint
    ? new Vector3(waypoint.x + 0.5, terrain.heightAt(waypoint.x + 0.5, waypoint.y + 0.5), waypoint.y + 0.5)
    : new Vector3(manifest.grid.width / 2, 0, manifest.grid.height / 2);
  return {
    nodes,
    width: manifest.grid.width,
    height: manifest.grid.height,
    terrain,
    waterY: terrain.waterY,
    water: terrain.water,
    root,
    focus,
    sprites: spriteLayer,
    cache,
    surface,
    surfaceTexture: surfaceTexture(surface, manifest.grid.width, manifest.grid.height),
    dressing,
    mapLight,
  };
}

/** Point another sprite layer's camera and light uniforms at the world layer's (updated by HdRenderer each frame). */
export function shareSpriteUniforms(shared: SpriteLayer, layer: SpriteLayer): void {
  layer.cameraRight.value = shared.cameraRight.value;
  layer.cameraUp.value = shared.cameraUp.value;
  layer.toCamera.value = shared.toCamera.value;
  layer.light.value = shared.light.value;
}
