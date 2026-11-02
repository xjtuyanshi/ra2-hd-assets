/**
 * HD cache manifest: the contract between the local asset extraction step (Node, reads the player's own MIX/map files)
 * and the HD renderer. Everything under gameres/hd-cache/<map>/ is derived from EA assets and must never be committed
 * or redistributed; it is regenerated from the player's install (the "install step" transformation).
 *
 * Coordinates: map cells (x, y) as stored in the map's IsoMapPack, height in RA2 levels. Screen conventions follow the
 * original engine: a cell corner (x, y, z) projects to screen ((x - y) * 30, (x + y) * 15 - z * 15) pixels.
 *
 * Optional fields added by the extractor (packages/ra2-assets, all backwards compatible with version 1):
 * - HdCacheManifest.houses, HdCacheManifest.paletteSources, HdCacheManifest.lighting, HdCacheManifest.extractor,
 *   HdCacheManifest.mapSize, HdCacheManifest.visibleRect
 * - SpriteEntry.file, SpriteEntry.underlays, SpriteEntry.frameCount, SpriteEntry.sourceFrames, SpriteEntry.loop
 * - MapObject.drawOffset, MapObject.subCell, MapObject.flat, MapObject.health, MapObject.lighting
 * - VoxelModel.file, VoxelModel.turretOffset, VoxelModel.turretVariants
 * - SpriteFrame.page (atlas page for multi-page atlases such as the type library's; absent = 0)
 * Draw-order rules the preview (and the HD renderer) follow: tile diamonds by cell depth (x + y), then tile extra
 * graphics (cliff faces, banks) by the same depth, then `flat` objects (smudges, ore/gems, low bridges), then all
 * shadows (darken), then the remaining objects sorted by the screen Y of their draw point.
 * Renderers should clip to `visibleRect`: cells outside it (border strips, truncated cliffs at the [Map] Size edge)
 * are real map data the player never sees.
 */
export const HD_CACHE_VERSION = 1;

/** Base64 of a little-endian typed array; row-major by y over the grid. */
export type Base64Array = string;

export interface HdCacheManifest {
  version: typeof HD_CACHE_VERSION;
  /** Map display name and source file name. */
  name: string;
  source: string;
  theater: 'temperate' | 'snow' | 'urban' | 'newurban' | 'desert' | 'lunar';
  /** Cell grid covering every cell that has a tile: x in [0, width), y in [0, height). */
  grid: { width: number; height: number };
  /** The map's [Map] LocalSize (visible play area) in its native iso-rectangle units, for camera framing. */
  localSize?: { x: number; y: number; width: number; height: number };
  /** Added: the map's [Map] Size width/height (the cell rhombus; see mapSizeCells in iso.ts). */
  mapSize?: { width: number; height: number };
  /**
   * Added: the playable screen rectangle the engine's camera is limited to, in the screen coordinates above (heights
   * included), derived from `mapSize`, `localSize` and the map's cutoff height (localScreenRect in iso.ts).
   * Everything outside it is never visible in game.
   */
  visibleRect?: { x: number; y: number; width: number; height: number };
  cells: {
    /** Uint8: 1 where the cell exists in the map. */
    exists: Base64Array;
    /** Uint8: cell base height level (IsoMapPack z). */
    height: Base64Array;
    /** Uint16: index into `tiles`, 0xffff where missing. */
    tile: Base64Array;
  };
  /** One entry per distinct (template file, sub-tile) used by the map. */
  tiles: TileEntry[];
  /** RGBA atlas of all tile images (palette applied: the theater iso palette). */
  terrainAtlas: TerrainAtlasRef;
  /** Indexed SHP atlas (R8, or legacy RGBA with the index in red; 0 = transparent); see `palettes`. */
  spriteAtlas: AtlasRef;
  /** Optional offline 2x sprite colours and house-remap mask, with the source atlas's normalized UVs. */
  spriteAtlasHd?: SpriteAtlasHdRef;
  /** 256-entry RGB palettes as 256x1 PNGs, keyed by name (e.g. "unit", "iso", "theater", "anim"). */
  palettes: Record<string, string>;
  /** SHP-based art keyed by an id such as "tree:TREE05" or "building:GACNST". */
  sprites: Record<string, SpriteEntry>;
  /** Voxel models keyed by rules type id (e.g. "MTNK"), each a JSON file under voxels/. */
  voxels: Record<string, string>;
  objects: MapObject[];
  waypoints: { id: number; x: number; y: number }[];
  /** Added: house colours by owner name (as used in MapObject.owner), for palette index 16..31 remapping. */
  houses?: Record<string, HouseColor>;
  /** Added: original palette file per key in `palettes` (e.g. { unit: "unittem.pal" }). */
  paletteSources?: Record<string, string>;
  /**
   * Added: the map's normal [Lighting] as written in the map (not the Ion Storm / Dominator variants; Level defaults
   * to 0.032 when the map omits it). Palettes of an object on a cell at level z are multiplied per MapObject.lighting
   * class by mapLightMultipliers in iso.ts, the engine's cell formula (Ambient - Ground + Level * z, times the
   * normalised (red, green, blue) for class 'full' only), clamped to 255.
   */
  lighting?: MapLighting;
  /**
   * Added (HD terrain): the whole map's terrain (tile diamonds + extra graphics, no objects) composited exactly as the
   * engine draws it, optionally upscaled. Pixel (px, py) of `file` shows engine screen point
   * (originX + px / scale, originY + py / scale). Renderers project terrain surfaces into this image instead of the
   * per-tile atlas, so upscaled or repainted terrain stays seamless.
   */
  terrainMap?: TerrainMapRef;
  /** Added: extractor identification and per-kind counts, for diagnostics only. */
  extractor?: { tool: string; counts: Record<string, number>; warnings: string[] };
}

/**
 * Added: how an object is lit (see mapLightMultipliers): 'full' = level + RGB tint (tiles, trees, rocks, overlays,
 * smudges), 'ambient' = level without tint (buildings, units, infantry, aircraft, walls), 'none' = unlit (ore/gems,
 * tiberium trees).
 */
export type LightingClass = 'full' | 'ambient' | 'none';

/** Added: [Lighting] values as stored in the map. */
export interface MapLighting {
  ambient: number;
  red: number;
  green: number;
  blue: number;
  ground: number;
  level: number;
}

/** Added: a whole-map terrain image (see HdCacheManifest.terrainMap). */
export interface TerrainMapRef {
  /** RGBA terrain composite, possibly upscaled (e.g. "terrain-map@2x.png"). */
  file: string;
  /** Optional R8 open-water mask composited the same way (same size as `file`). */
  waterMask?: string;
  /** Output pixels per original engine pixel (1 = original resolution). */
  scale: number;
  /** Engine screen coordinates of the image's top-left pixel at scale 1. */
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** Added: a house's colour scheme. */
export interface HouseColor {
  /** rules [Colors] entry name, e.g. "DarkRed". */
  colorName: string;
  /** HSV from rules [Colors] (0..255 each). */
  hsv: [h: number, s: number, v: number];
  /** 16 RGB entries replacing palette indices 16..31 of the unit palette (brightest first). */
  remap: [r: number, g: number, b: number][];
}

export interface AtlasRef {
  file: string;
  width: number;
  height: number;
}

export interface TerrainAtlasRef extends AtlasRef {
  /**
   * Added: single-channel atlas with the same layout as `file`, holding the engine's TMP z byte of every opaque tile
   * pixel (tileRaster.ts). Terrain compositors resolve overlapping tiles with it exactly as the engine's Z-buffer
   * does. Caches extracted before this field existed lack it; compositors then fall back to the approximate
   * diamonds-then-extras painter, which lets a cliff face cover ground in front of it.
   */
  depth?: string;
}

/** Optional offline sprite atlas. Source indexed art remains authoritative for shadows and palette lookup. */
export interface SpriteAtlasHdRef extends AtlasRef {
  /** RGBA colour atlas, with remappable indices 16..31 replaced by a neutral grey ramp. */
  file: string;
  /** Single-channel soft house-remap mask, matching the colour atlas dimensions. */
  remap: string;
  /**
   * HD texels per indexed texel, an integer of at least 2: the page has exactly `scale` times the indexed page's
   * dimensions and the same layout, so every frame rectangle maps to `scale` times itself. `hd:sprites` writes 2;
   * higher-resolution redraws (e.g. 4x infantry, python/sprite_hd_pages.py) live on pages of their own, which a sprite
   * entry's frames reference frame by frame, so 2x stays the fallback per type and per frame.
   */
  scale: number;
  /** House-paint saturation in linear light, 0..1; absent means 1. Preserves Rec.709 luminance. */
  paintSaturation?: number;
}

export interface TileEntry {
  /** Template file, e.g. "clat12.tem". */
  file: string;
  subTile: number;
  /**
   * Tile's own height offset (levels) inside its template. Informational: the map's IsoMapPack z (`cells.height`)
   * already includes it (verified on RiverRam: sub-tiles of height 4 sit on cells with z = base + 4), so renderers
   * must not add it again.
   */
  height: number;
  rampType: number;
  terrainType: number;
  /**
   * Atlas rectangle holding the tile raster: the 60x30 diamond plus any extra graphics (cliff faces, bank art).
   * `anchor` is the pixel inside that rectangle where the cell's top corner (x, y) sits, so the renderer can project
   * any world point into this raster with the screen formula above.
   */
  rect: [x: number, y: number, w: number, h: number];
  anchor: [x: number, y: number];
  /**
   * Added: true when the TMP tile has no z-data. The engine draws such a tile without testing or writing depth, so
   * it covers whatever was drawn before it and never blocks what is drawn after it.
   */
  noDepth?: true;
}

export interface SpriteFrame {
  rect: [x: number, y: number, w: number, h: number];
  /** Offset of the frame raster's top-left from the SHP canvas centre (engine draw origin), in pixels. */
  offset: [x: number, y: number];
  /**
   * Added: atlas page of `rect` when the sprites span several pages (TypeLibrary.spriteAtlases); absent = page 0.
   * The single-page map cache never writes it.
   */
  page?: number;
}

export interface SpriteEntry {
  /** Palette key in HdCacheManifest.palettes. */
  palette: string;
  /** Palette indices 16-31 are house-remappable. */
  remap: boolean;
  /** Full SHP canvas size. */
  canvas: [width: number, height: number];
  frames: SpriteFrame[];
  /** Shadow frames (1-bit masks), same order as `frames`, when the SHP carries them. */
  shadows?: SpriteFrame[];
  /** Building footprint (Foundation=WxH) in cells. */
  foundation?: [width: number, height: number];
  /** Extra art layers drawn on top (e.g. building ActiveAnim/idle anims), each its own sprite id. */
  layers?: string[];
  /** Added: art layers drawn below the body with the same origin (building BibShape), each its own sprite id. */
  underlays?: string[];
  /** Added: source SHP file name inside the install (e.g. "ggpowr.shp"). */
  file?: string;
  /** Added: total frame count of the source SHP (body + shadow halves). */
  frameCount?: number;
  /**
   * Added: source SHP body frame of each entry of `frames` when only some frames were exported. Building anim layers
   * keep one representative still frame (animStillFrame in art.ts); infantry, SHP vehicles and aircraft keep only the
   * frames the map's objects use (MapObject.frame indexes the exported list). Absent = the SHP's body frames.
   */
  sourceFrames?: number[];
  /** Added: the anim's art LoopStart/LoopEnd (source frame indices, inclusive), for renderers that animate later. */
  loop?: [start: number, end: number];
}

export type MapObjectKind = 'building' | 'vehicle' | 'infantry' | 'aircraft' | 'tree' | 'overlay' | 'smudge';

export interface MapObject {
  kind: MapObjectKind;
  /** Rules id, e.g. "GACNST", "MTNK", "TREE05", "GEM01", "CR1". */
  type: string;
  x: number;
  y: number;
  /** Height level of the cell. */
  z: number;
  /** Owner house name from the map (e.g. "Americans"), absent for neutral objects. */
  owner?: string;
  /**
   * Owner remap colour slot (0-7) when known. The extractor does not fill it: a map file only names owner houses,
   * and multiplayer colour slots are chosen in the lobby. Renderers use `houses[owner]` for the remap colours.
   */
  house?: number;
  /** 0..255 engine facing (0 = north, clockwise). */
  facing?: number;
  /** Sprite id in `sprites` (SHP art) or voxel id in `voxels`. */
  sprite?: string;
  voxel?: string;
  /**
   * Index into the sprite's exported `frames` (overlays: OverlayData value; buildings: 0 = healthy, 1 = damaged;
   * see SpriteEntry.sourceFrames for trimmed sprites).
   */
  frame?: number;
  /**
   * Added: screen offset in pixels from the projected top corner of cell (x, y) at level z to the object's engine
   * draw point — where the SHP canvas centre (or the voxel origin) goes. Includes the cell-centre, infantry
   * sub-cell and building-foundation terms, so renderers need no per-kind rules.
   */
  drawOffset?: [x: number, y: number];
  /** Added: infantry sub-cell spot 0..4 from the map ([Infantry] column 6). */
  subCell?: number;
  /**
   * Added: true when the engine draws this object flat in the ground pass (smudges, ore/gems, low bridges). High
   * bridges (BRIDGE*, BRIDGEB*, RAILBRDG*) are never flat: their deck is lifted 4 levels and sorts with upright
   * objects.
   */
  flat?: boolean;
  /**
   * Added: health 0..256 from the map (buildings use the damaged frame 1 at or below the rules ConditionYellow,
   * "50%" in YR, frame 0 above it).
   */
  health?: number;
  /** Added: lighting class (see LightingClass); absent = 'full'. */
  lighting?: LightingClass;
}

/** voxels/<id>.json */
export interface VoxelModel {
  id: string;
  /** Palette key (normally "unit"). */
  palette: string;
  /**
   * Normal table id from a VXL section tailer: 2 = Tiberian Sun (36 normals), 4 = Red Alert 2 (244 normals). Sections
   * of one model may differ (VoxelSection.normalsMode); caches extracted before that field recorded the last section's
   * mode here, which is wrong for mixed models, so readers use sectionNormalsMode (voxelNormals.ts).
   */
  normalsMode: number;
  parts: VoxelPart[];
  /** Added: body VXL file the model came from (e.g. "mtnk.vxl"). */
  file?: string;
  /** Added: art `TurretOffset=` (leptons forward along the body's facing), 0 when absent. */
  turretOffset?: number;
  /**
   * Added: alternate turret/barrel parts keyed by the engine's zero-based turret index (1 and above). The shared
   * body and default turret remain in `parts`, so older/static readers keep the original model. A missing entry
   * means that variant's art is unavailable; consumers retain the default art as a fallback without claiming
   * the requested variant is present.
   */
  turretVariants?: Record<string, VoxelPart[]>;
}

export interface VoxelPart {
  /** "body", "turret", "barrel" — which rules part this VXL/HVA pair is. */
  role: 'body' | 'turret' | 'barrel';
  sections: VoxelSection[];
}

export interface VoxelSection {
  name: string;
  size: [x: number, y: number, z: number];
  /** Section scale from the tailer (world leptons per voxel unit, before the engine's 256-lepton cell). */
  scale: number;
  minBounds: [number, number, number];
  maxBounds: [number, number, number];
  /** 3x4 row-major transform: HVA frame 0 matrix (translation already multiplied by scale as the engine does). */
  transform: number[];
  /** Base64 Uint8 quintuples (x, y, z, colour index, normal index) per voxel. */
  voxels: Base64Array;
  /** Added: this section's normal table (tailer normalsMode); absent in older caches (see sectionNormalsMode). */
  normalsMode?: number;
}
