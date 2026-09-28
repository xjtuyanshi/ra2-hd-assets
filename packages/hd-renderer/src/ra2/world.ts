import { Object3D, Vector3 } from 'three/webgpu';
import type { MapObject } from '../../../ra2-assets/src/manifest';
import type { TerrainBuild } from '../terrain';
import { loadRa2Cache, paletteFor, type Ra2Cache, type Ra2CacheOptions } from './cache';
import { SpriteLayer, cardPush, objectAnchor, type SpriteInstance } from './sprites';
import { buildRa2Terrain } from './terrain';
import { buildVoxelGeometry, createVoxelMaterial, instantiateVoxel, type VoxelGeometry } from './voxels';

/** A battlefield the HD renderer can draw: terrain, optional water, and everything standing on it. */
export interface HdWorld {
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
}

/** Build the original map from a local HD cache (gameres/hd-cache/<map>/, served by the sandbox dev server). */
export async function loadRa2World(
  base: string,
  options: { extraObjects?: (manifest: Ra2Cache['manifest']) => MapObject[] } & Ra2CacheOptions = {},
): Promise<HdWorld> {
  const cache = await loadRa2Cache(base, options);
  const { manifest } = cache;
  const objects = [...manifest.objects, ...(options.extraObjects?.(manifest) ?? [])];
  const terrain = buildRa2Terrain(cache);
  const root = new Object3D();
  root.name = 'ra2-world';

  // Voxel vehicles: one geometry set per (model, owner) because house colours are baked into vertex colours.
  const voxelMaterial = createVoxelMaterial();
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
        parts = buildVoxelGeometry(model, cache.paletteRgb.get(paletteKey)!);
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
        });
    }
    // Shadows are cast on the ground: draw them as decals too.
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) sprites.push({ anchor, frame: shadow, palette, push: 0, shadow: true, flat: true });
    sprites.push({ anchor, frame, palette, push, shadow: false, flat });
    for (const layer of entry.layers ?? []) {
      const art = manifest.sprites[layer];
      if (art?.frames[0])
        sprites.push({
          anchor,
          frame: art.frames[0],
          palette: paletteFor(cache, art.palette, art.remap, object.owner),
          push: push + 0.01,
          shadow: false,
        });
    }
  }
  const spriteLayer = new SpriteLayer(cache, sprites);
  root.add(spriteLayer.mesh);

  const waypoint = manifest.waypoints.find((w) => w.id === 0) ?? manifest.waypoints[0];
  const focus = waypoint
    ? new Vector3(waypoint.x + 0.5, terrain.heightAt(waypoint.x + 0.5, waypoint.y + 0.5), waypoint.y + 0.5)
    : new Vector3(manifest.grid.width / 2, 0, manifest.grid.height / 2);
  return {
    width: manifest.grid.width,
    height: manifest.grid.height,
    terrain,
    waterY: terrain.waterY,
    water: terrain.water,
    root,
    focus,
    sprites: spriteLayer,
    cache,
  };
}
