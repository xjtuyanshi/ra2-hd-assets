import { DataTexture, LinearFilter, Object3D, RGFormat, UnsignedByteType, Vector3 } from 'three/webgpu';
import { SURFACE, surfaceFromLandType } from '../../../ra2-assets/src/lights';
import type { MapObject } from '../../../ra2-assets/src/manifest';
import { AtmosphereNodes, type WorldDressing } from '../atmosphere';
import type { TerrainBuild } from '../terrain';
import type { WeatherFoundation } from '../weatherGroundMask';
import { remapRamp, type Hsv } from '../../../ra2-assets/src/remap';
import { addHousePalettes, decodeBase64, loadRa2Cache, paletteFor, type Ra2Cache, type Ra2CacheOptions } from './cache';
import type { MapLightGrade } from './mapLighting';
import { Ra2NightDressing } from './nightDressing';
import { SpriteLayer, cardPush, isUnlitMapOverlay, objectAnchor, type SpriteInstance } from './sprites';
import { buildingUsesHouseConverter, mapObjectUsesHouseConverter } from './unlitPalette';
import { loadSpriteMaterials } from './spriteMaterials';
import type { SpriteMaterialAtlas } from './spriteLook';
import { objectYSort, painterObject } from './painterOrder';
import { HIGH_BRIDGE_HEIGHT, highBridgeLight, isHighBridge } from './bridgeDepth';
import { buildRa2Terrain } from './terrain';
import {
  buildVoxelGeometry,
  createVoxelMaterial,
  instantiateVoxel,
  projectVoxelMaterials,
  setVoxelShapeFor,
  updateVoxelNativeDepth,
  voxelShapeFor,
  type VoxelGeometry,
  type VoxelShape,
} from './voxels';
import { loadVoxelLighting } from './vpl';
import { smoothVoxelOptions, type SmoothVoxelOptions } from './voxelSmooth';
import { buildSmoothVoxelGeometry } from './voxelSmoothGeometry';
import { projectionParts, voxelProjectionLibrary, type VoxelProjectionLibrary } from './voxelProjection';
import { frameInclusiveBottom, terrainObjectDepth } from './nativeDepth';
import { TerrainObjectCards } from './terrainObjectCards';

/** A battlefield the HD renderer can draw: terrain, optional water, and everything standing on it. */
export interface HdWorld {
  nodes?: AtmosphereNodes;
  /** Load-time geometry choice, also inherited by units created later in live matches. */
  voxelLook?: 'engine' | 'remaster';
  smoothVoxel?: Readonly<SmoothVoxelOptions>;
  voxelProjection?: string;
  projections?: VoxelProjectionLibrary;
  width: number;
  height: number;
  terrain: TerrainBuild;
  /** Ground-weather exclusions for the buildings actually included in this static scene. */
  weatherFoundations?: readonly WeatherFoundation[];
  waterY: number | null;
  /** Per-pixel water shading inputs when water is part of the terrain material. */
  water?: import('../waterShading').WaterUniforms;
  root: Object3D;
  /** Where the camera starts (world units). */
  focus: Vector3;
  sprites?: SpriteLayer;
  /** Depth cards of the map's upright terrain objects, for whole-object ties with ground units. */
  terrainObjectCards?: TerrainObjectCards;
  /** Shared map sprite materials, loaded once with this world and reused by live map-cache cell layers. */
  spriteMaterials?: SpriteMaterialAtlas | null;
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
    voxelLook?: 'engine' | 'remaster';
    smoothVoxel?: Partial<SmoothVoxelOptions>;
    /** Optional base URL of view-dependent vehicle redraw atlases; absent/failed types keep their current look. */
    voxelProjection?: string;
    /** Keep only map objects passing this test (a live match draws units and buildings from game memory instead). */
    includeObject?: (object: MapObject) => boolean;
    /** Load the optional sprite material atlas (normals.json) for the enhanced look; default true. */
    spriteMaterials?: boolean;
    /**
     * Review houses the map does not name (owner -> rules [Colors] HSV): their remap rows are added before any object
     * is built, so extra objects owned by them draw in that house colour.
     */
    extraHouses?: Record<string, Hsv>;
  } & Ra2CacheOptions = {},
): Promise<HdWorld> {
  const nodes = options.nodes ?? new AtmosphereNodes();
  const voxelLook = options.voxelLook ?? 'engine';
  const smoothVoxel = smoothVoxelOptions(options.smoothVoxel);
  const projections = options.voxelProjection ? voxelProjectionLibrary(options.voxelProjection, nodes) : undefined;
  if (options.voxelShape) setVoxelShapeFor(nodes, options.voxelShape);
  else voxelShapeFor(nodes);
  // The engine's voxel lighting table lives next to the map caches, in the type library's common directory; without
  // it voxels use a fitted fallback curve.
  const [cache] = await Promise.all([
    loadRa2Cache(base, { ...options, nodes }),
    loadVoxelLighting(`${base.replace(/\/$/, '')}/../_library/common/voxels-vpl.json`, nodes),
  ]);
  const { manifest } = cache;
  // Include cached map models even when static objects are filtered out for a live match.
  if (projections)
    await Promise.all(
      [...cache.voxels.values()].map((model) => projections.loadType(model.id, projectionParts(model.parts))),
    );
  const unitPalette = cache.paletteRgb.get('unit');
  for (const [owner, hsv] of Object.entries(options.extraHouses ?? {}))
    if (unitPalette) addHousePalettes(cache, owner, remapRamp(unitPalette, hsv));
  const hdRef = manifest.spriteAtlasHd;
  const materials =
    options.spriteMaterials === false || !cache.spriteAtlasHd
      ? null
      : await loadSpriteMaterials(base, hdRef ? { width: hdRef.width, height: hdRef.height } : null);
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
  const terrainObjectCards = new TerrainObjectCards();
  const weatherFoundations: WeatherFoundation[] = [];
  // Enhanced-look decals (spriteLook.ts; drawn only while their effect is on): ground contact shades first, under
  // every other decal, and wet-paving mirror images of upright art.
  const lookDecals: SpriteInstance[] = [];
  const bridgeCells = new Set(
    objects
      .filter((object) => object.kind === 'overlay' && isHighBridge(object.type))
      .map((object) => `${object.x},${object.y}`),
  );
  for (const object of objects) {
    const anchor = objectAnchor(object);
    const ground = terrain.heightAt(anchor.x, anchor.z);
    // Static caches have no registration/locomotor state. Unit kinds at terrain or a known high deck are the
    // ground-layer equivalent; raised aircraft/units retain physical depth. No harvester bonus is inferred
    // because static map objects do not include rules flags.
    const groundUnit =
      (object.kind === 'vehicle' || object.kind === 'infantry' || object.kind === 'aircraft') &&
      (anchor.y <= ground + 0.01 ||
        (bridgeCells.has(`${object.x},${object.y}`) && Math.abs(anchor.y - ground - HIGH_BRIDGE_HEIGHT) <= 0.01));
    if (object.voxel) {
      const model = cache.voxels.get(object.voxel);
      if (!model) continue;
      const paletteKey = paletteFor(cache, model.palette, true, object.owner);
      const cacheKey = `${object.voxel}@${paletteKey}`;
      let parts = geometries.get(cacheKey);
      if (!parts) {
        parts =
          voxelLook === 'remaster'
            ? buildSmoothVoxelGeometry(model, cache.paletteRgb.get(paletteKey)!, nodes, smoothVoxel)
            : buildVoxelGeometry(model, cache.paletteRgb.get(paletteKey)!, nodes);
        projectVoxelMaterials(
          parts,
          cache.paletteRgb.get(paletteKey)!,
          projections?.get(model.id, projectionParts(model.parts)) ?? null,
          nodes,
        );
        geometries.set(cacheKey, parts);
      }
      const { root: vehicle } = instantiateVoxel(parts, voxelMaterial, nodes);
      vehicle.position.copy(anchor);
      vehicle.position.y = Math.max(anchor.y, ground);
      // Engine facing 0 = north (world -z), clockwise; the model's nose is local +x.
      const phi = ((object.facing ?? 0) / 256) * Math.PI * 2;
      vehicle.rotation.y = Math.PI / 2 - phi;
      root.add(vehicle);
      updateVoxelNativeDepth(vehicle, vehicle.position, 0, groundUnit);
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
    const painter = painterObject(
      2,
      objectYSort((object.x + 0.5) * 256, (object.y + 0.5) * 256, object.kind === 'building'),
    );
    if (object.kind === 'building') {
      painter.foundation = entry.foundation;
      painter.x = object.x;
      painter.z = object.y;
      // The footprint starts at the same cell corner as painter depth, independent of the art's draw offset.
      if (entry.foundation)
        weatherFoundations.push({
          x: object.x,
          z: object.y,
          width: entry.foundation[0],
          height: entry.foundation[1],
        });
    }
    const deckHeight = object.kind === 'overlay' && isHighBridge(object.type) ? HIGH_BRIDGE_HEIGHT : undefined;
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
          houseConverter: object.kind === 'building' && buildingUsesHouseConverter(bib.palette),
        });
    }
    // Shadows are cast on the ground: draw them as decals too. The painter carries the foundation the enhanced look
    // turns them about (flat decals take no depth from it).
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) sprites.push({ anchor, frame: shadow, palette, push: 0, shadow: true, flat: true, painter });
    if (object.kind === 'building' && entry.foundation) {
      const [w, h] = entry.foundation;
      const margin = 30;
      lookDecals.push({
        anchor,
        frame: {
          rect: [0, 0, 30 * (w + h) + 2 * margin, 15 * (w + h) + 2 * margin],
          offset: [-30 * h - margin, -margin],
        },
        palette,
        push: 0,
        shadow: false,
        flat: true,
        kind: 'contact',
        painter,
      });
    }
    if (!flat && object.kind !== 'overlay')
      sprites.push({
        anchor,
        frame,
        palette,
        push: 0,
        shadow: false,
        flat: true,
        lighting,
        painter,
        kind: 'reflection',
      });
    if (object.kind === 'tree' && !flat) terrainObjectCards.add(anchor, frame);
    sprites.push({
      anchor,
      frame,
      palette,
      push,
      shadow: false,
      flat,
      glint: object.kind === 'overlay' && flat && lighting === 'none' ? 1 : undefined,
      unlit: isUnlitMapOverlay(object),
      lighting,
      houseConverter: mapObjectUsesHouseConverter(object.kind, entry.palette),
      // A deck is lit at its own height, four levels above the owner cell on the river (bridgeDepth.ts).
      light: deckHeight !== undefined && manifest.lighting ? highBridgeLight(manifest.lighting, object.z) : undefined,
      painter: object.kind === 'overlay' ? undefined : painter,
      deckHeight,
      nativeDepth:
        groundUnit && !flat
          ? { mode: 'card', bottom: frameInclusiveBottom(frame), bonus: object.kind === 'infantry' ? 12 : 0 }
          : object.kind === 'tree' && !flat
            ? terrainObjectDepth(frame)
            : undefined,
    });
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
          painter,
          painterPart: 0.1,
          houseConverter: object.kind === 'building' && buildingUsesHouseConverter(art.palette),
        });
    }
  }
  sprites.unshift(...lookDecals);
  const spriteLayer = new SpriteLayer(
    cache,
    sprites,
    sprites.length,
    undefined,
    cache.spriteAtlasHd,
    cache.windows?.texture ?? null,
    materials,
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
    voxelLook,
    smoothVoxel,
    voxelProjection: options.voxelProjection,
    projections,
    width: manifest.grid.width,
    height: manifest.grid.height,
    terrain,
    weatherFoundations,
    waterY: terrain.waterY,
    water: terrain.water,
    root,
    focus,
    sprites: spriteLayer,
    terrainObjectCards,
    spriteMaterials: materials,
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
