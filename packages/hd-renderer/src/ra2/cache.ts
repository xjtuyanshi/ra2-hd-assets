import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType,
} from 'three/webgpu';
import type { HdCacheManifest, TileEntry, VoxelModel } from '../../../ra2-assets/src/manifest';
import { SCENARIO_TYPES_FILE, validateScenarioTypes, type ScenarioTypesSidecar } from '../../../ra2-assets/src/library';
import { validateMapLights, type MapLightsSidecar } from '../../../ra2-assets/src/lights';
import { MAP_MATERIALS_FILE, type MapMaterials } from '../../../ra2-assets/src/mapMaterials';
import { MapLightGrade, setPaletteGrade, setPaletteNodes } from './mapLighting';
import { AtmosphereNodes } from '../atmosphere';
import { withDecodedPage, type PageUpload } from '../pageUpload';
import { buildCliffField, buildShoreField } from './shoreField';

/** windows.json next to a lit-window mask (packages/ra2-assets src/node/lights.ts WindowsSidecar). */
export interface WindowsIndex {
  version: number;
  /** Library only: mask file per atlas page. */
  pages?: Record<string, string>;
  /**
   * Per building frame: lit pixels, their centroid and (version 2) the lit-pane columns [centre x, panes, lowest lit
   * y], frame-relative.
   */
  frames: Record<
    string,
    Record<string, { lit: number; centroid: [number, number]; columns?: [number, number, number][] }>
  >;
  denied?: string[];
}

/**
 * A loaded HD cache (see packages/ra2-assets/src/manifest.ts): decoded cell arrays plus GPU textures. The cache is
 * produced locally from the player's own game files and served from gameres/hd-cache by the sandbox dev server.
 */
export interface Ra2Cache {
  /** Material inputs of the renderer/world owning this cache. */
  nodes?: AtmosphereNodes;
  base: string;
  manifest: HdCacheManifest;
  exists: Uint8Array;
  height: Uint8Array;
  tile: Uint16Array;
  terrainAtlas: Texture;
  /** R8 mask over the terrain atlas: 1 where the original art shows open water (see buildWaterMask). */
  waterMask: DataTexture;
  /** Whole-map terrain composite (possibly AI-upscaled) and its water mask, when the cache provides one. */
  terrainMap?: {
    texture: DataTexture;
    waterMask: DataTexture;
    /** The terrain image contains a painted lake bed; only the enhanced water style uses bed optics. */
    waterBed: boolean;
    /** Composite-space apparent water colour (sRGB) and roughness (A); null when absent or unreadable. */
    waterDetail: Texture | null;
    /** Repeating painted open-water surface tile (see MapMaterials.waterSurface) and its size; null when absent. */
    waterSurface: { texture: Texture; scale: number } | null;
    /** Signed distance to the shoreline in cells, encoded as in shoreField.ts (drives depth, foam and wet sand). */
    shore: DataTexture;
    /** Normalised cliff contact distance (CLIFF_FIELD_MAX cells = 1); null without a loaded shore-ignore mask. */
    cliff: DataTexture | null;
    ref: NonNullable<HdCacheManifest['terrainMap']>;
  };
  spriteAtlas: Texture;
  /** Shared native BUILDNGZ bytes; owned by LiveLibrary, sampled with integer texture loads. */
  depthTemplate?: { texture: DataTexture; width: number; height: number };
  /** 2x HD version of the sprite atlas (full colour + house-paint mask), when extracted (pnpm hd:sprites). */
  spriteAtlasHd: HdAtlas | null;
  /** All palettes stacked into one 256xN texture; `paletteRow` maps a palette key to its row. */
  paletteAtlas: DataTexture;
  paletteRow: Map<string, number>;
  /** Raw RGB palettes (0..255) by key, for CPU-side colour resolution (voxels). */
  paletteRgb: Map<string, Uint8Array>;
  voxels: Map<string, VoxelModel>;
  /** The map's light sidecar (pnpm hd:lights), or null when the cache has none (or it failed to load). */
  lights: MapLightsSidecar | null;
  /**
   * The engine's per-cell light of the map ([Lighting] and light sources, see mapLighting.ts), from the light sidecar
   * when present, else the manifest's [Lighting]; null when the map records neither.
   */
  mapLight: MapLightGrade | null;
  /** Lit-window mask over the sprite atlas (same layout) and its index, when extracted. */
  windows: { texture: Texture; index: WindowsIndex } | null;
  /**
   * Types the scenario's own rules define or redefine (scenario-types.json, packages/ra2-assets ScenarioType), for the
   * live library to lay over the theatre's stock types; null or absent when the map cache has none.
   */
  scenarioTypes?: ScenarioTypesSidecar | null;
}

export const NO_TILE = 0xffff;

/** Median base height level of the map's existing cells (the typical terrain height, e.g. for map lighting). */
export function medianLevel(cache: Pick<Ra2Cache, 'exists' | 'height'>): number {
  const counts = new Array<number>(256).fill(0);
  let total = 0;
  for (let i = 0; i < cache.height.length; i++) {
    if (!cache.exists[i]) continue;
    counts[cache.height[i]!]!++;
    total++;
  }
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += counts[level]!;
    if (seen * 2 >= total && total) return level;
  }
  return 0;
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Fetch an optional sidecar. A missing file (404, or the dev server's HTML fallback) resolves to null with an info
 * message; a file that exists but fails to parse or validate resolves to null with a warning. The two are never
 * confused, and nothing is fabricated.
 */
export async function fetchOptionalJson<T>(
  url: string,
  validate: (json: unknown) => T = (j) => j as T,
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.warn(`${url}: request failed`, error);
    return null;
  }
  const type = response.headers.get('content-type') ?? '';
  if (response.status === 404 || (response.ok && type.includes('text/html'))) {
    console.info(`${url}: not present (optional)`);
    return null;
  }
  if (!response.ok) {
    console.warn(`${url}: HTTP ${response.status}`);
    return null;
  }
  try {
    return validate(await response.json());
  } catch (error) {
    console.warn(`${url}: invalid`, error);
    return null;
  }
}

/**
 * Light sidecars refer to manifest.objects by index (hidden lamp dummies, light sources). When the manifest changed
 * since `pnpm hd:lights` ran (its recorded sha256 differs), those indices are dropped with a warning; positions and
 * lighting stay valid.
 */
async function sidecarForManifest(
  lights: MapLightsSidecar | null,
  manifestBytes: ArrayBuffer,
): Promise<MapLightsSidecar | null> {
  if (!lights) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return lights;
  const digest = new Uint8Array(await subtle.digest('SHA-256', manifestBytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex === lights.extractor.manifestSha256) return lights;
  console.warn('lights.json was written for another manifest.json: ignoring its object indices (rerun pnpm hd:lights)');
  return { ...lights, hiddenObjects: [], lights: lights.lights.map(({ objectIndex: _unused, ...light }) => light) };
}

/** Load a data mask (lit windows): no colour conversion, linear filtering, no mipmaps. */
export async function loadMaskTexture(url: string): Promise<Texture | null> {
  try {
    const texture = await new TextureLoader().loadAsync(url);
    texture.flipY = false;
    texture.colorSpace = NoColorSpace;
    // Nearest: a pane's variant (G) must never blend with its dark surroundings (the panes follow the original pixels).
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.generateMipmaps = false;
    return texture;
  } catch (error) {
    console.warn(`${url}: failed to load`, error);
    return null;
  }
}

export interface Ra2CacheOptions {
  nodes?: AtmosphereNodes;
  /** Use the manifest's whole-map terrain image (AI-upscaled when available); default true. */
  terrainMap?: boolean;
  /** Use the HD sprite atlas when the cache has one; default true. */
  hdSprites?: boolean;
  /**
   * Prefer the colour-matched terrain image named by the map's materials.json sidecar (pnpm hd:materials --terrain)
   * when there is one; default true.
   */
  colourMatched?: boolean;
}

/** Where an HD sprite atlas is recorded (manifest.spriteAtlasHd / library spriteAtlasesHd entries). */
export interface HdAtlasRef {
  file: string;
  remap: string;
  scale: number;
  width: number;
  height: number;
  /** House-paint saturation in linear light, 0..1; absent means 1. Preserves Rec.709 luminance. */
  paintSaturation?: number;
}

/** Loaded HD page textures and its optional house-paint grade. */
export interface HdAtlas {
  color: Texture;
  remap: Texture;
  /** House-paint saturation, 0..1; absent means 1 (no additional shader nodes). */
  paintSaturation?: number;
}

/**
 * One page of an HD sprite atlas as a filtered, mipmapped texture, decoded off the main thread.
 *
 * An image element (TextureLoader) is decoded lazily: the first upload decodes the whole PNG on the main thread, inside
 * the frame that first draws the page. HD pages are up to 8192 x 8192 and arrive one after another while a match starts
 * (every type on screen brings its page and mask). Measured in one session on the same two maps (a two- and a
 * four-player skirmish start): each image-element upload of such a page held the main thread for about 0.4 s, 23 to 25
 * of them (about 4 s) in the first minute; a bitmap decoded by createImageBitmap uploads in 0.02 to 0.09 s, 0.5 to 0.9 s
 * in all. The picture is the same: opaque building texels differ less between the two loaders than between two matches
 * with the old one. The start-up stutter that remains is not image upload: the same profile's other entries were
 * voxel smoothing meshes and shader builds.
 *
 * Straight alpha, no colour conversion: the texels are the PNG's own values (the pages carry no colour profile). The
 * texture owns the bitmap until its first upload (or disposal before first use) and keeps only the dimensions
 * afterwards, like loadIndexedPage: a page is immutable, and a decoded 8192 x 4096 page is 128 MiB. `upload` (the
 * renderer's initTexture, or a PageUploader that copies the page over several frames) uploads before the texture is
 * handed out, so the bitmap never outlives the load.
 */
export async function loadHdTexture(
  url: string,
  colorSpace: Texture['colorSpace'],
  upload?: PageUpload,
  /** 'red': the page is a grey mask read through its red channel only (the house-paint mask). */
  channels: 'rgba' | 'red' = 'rgba',
): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // Decoded inside the upload's gate: the page exists decoded only from here until its upload is through.
  return withDecodedPage(await response.blob(), upload, async (bitmap) => {
    const { width, height } = bitmap;
    const texture = new Texture(bitmap as unknown as HTMLImageElement);
    texture.colorSpace = colorSpace;
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    if (channels === 'red') {
      // One channel of a grey page: a quarter of the GPU memory (the upload writes the red channel, as for indexed
      // pages; see loadIndexedPage).
      texture.format = RedFormat;
      texture.type = UnsignedByteType;
    }
    const release = () => {
      bitmap.close();
      texture.image = { width, height } as unknown as HTMLImageElement;
      texture.onUpdate = null;
      texture.removeEventListener('dispose', release);
    };
    texture.addEventListener('dispose', release);
    // The renderer calls onUpdate after the upload and mipmap generation of a texture it draws or initialises.
    texture.onUpdate = release;
    texture.needsUpdate = true;
    if (upload) {
      try {
        await upload(texture);
      } catch (error) {
        texture.dispose();
        throw error;
      }
      // A host whose upload does not report back (onUpdate) still must not keep the decoded page.
      texture.onUpdate?.(texture);
    }
    return texture;
  });
}

/**
 * Load an HD sprite atlas pair: colour art (sRGB, filtered) and the house-paint mask (linear data). See loadHdTexture
 * for decoding and `upload`.
 */
export async function loadHdAtlas(base: string, ref: HdAtlasRef, upload?: PageUpload): Promise<HdAtlas> {
  const pages = await Promise.allSettled([
    loadHdTexture(`${base}/${ref.file}`, SRGBColorSpace, upload),
    loadHdTexture(`${base}/${ref.remap}`, NoColorSpace, upload, 'red'),
  ]);
  const failed = pages.find((page) => page.status === 'rejected');
  if (failed) {
    // Half a pair is no atlas: free the page that did load (its GPU texture or its bitmap).
    for (const page of pages) if (page.status === 'fulfilled') page.value.dispose();
    throw failed.reason;
  }
  const [color, remap] = pages.map((page) => (page as PromiseFulfilledResult<Texture>).value) as [Texture, Texture];
  return { color, remap, paintSaturation: ref.paintSaturation ?? 1 };
}

/**
 * The map has no cache at all: its manifest.json is not there (404, or the dev server's HTML fallback). Callers tell
 * this apart from a cache that exists but fails to load, e.g. to say that the map was never prepared.
 */
export class MapCacheMissingError extends Error {
  override readonly name = 'MapCacheMissingError';
  constructor(readonly base: string) {
    super(`${base}: no HD cache for this map (manifest.json not found)`);
  }
}

export async function loadRa2Cache(base: string, options: Ra2CacheOptions = {}): Promise<Ra2Cache> {
  const nodes = options.nodes ?? new AtmosphereNodes();
  const url = (file: string) => `${base.replace(/\/$/, '')}/${file}`;
  const manifestResponse = await fetch(url('manifest.json'));
  if (
    manifestResponse.status === 404 ||
    (manifestResponse.ok && (manifestResponse.headers.get('content-type') ?? '').includes('text/html'))
  )
    throw new MapCacheMissingError(base);
  if (!manifestResponse.ok) throw new Error(`${url('manifest.json')}: HTTP ${manifestResponse.status}`);
  const manifestBytes = await manifestResponse.arrayBuffer();
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as HdCacheManifest;
  const tileBytes = decodeBase64(manifest.cells.tile);
  const tile = new Uint16Array(tileBytes.buffer, tileBytes.byteOffset, tileBytes.byteLength / 2);

  const loader = new TextureLoader();
  const load = async (file: string) => {
    const texture = await loader.loadAsync(url(file));
    // Atlas rows are addressed top-down in pixel space; keep PNG orientation.
    texture.flipY = false;
    return texture;
  };
  const { texture: terrainAtlas, original } = await loadDilated(url(manifest.terrainAtlas.file));
  const waterMask = buildWaterMask(original, manifest.terrainAtlas.width, manifest.terrainAtlas.height, manifest.tiles);
  terrainAtlas.colorSpace = SRGBColorSpace;
  terrainAtlas.magFilter = LinearFilter;
  terrainAtlas.minFilter = LinearFilter;
  terrainAtlas.generateMipmaps = false;
  const spriteAtlas = await load(manifest.spriteAtlas.file);
  // Palette indices must never be filtered or colour-converted.
  spriteAtlas.colorSpace = NoColorSpace;
  spriteAtlas.magFilter = NearestFilter;
  spriteAtlas.minFilter = NearestFilter;
  spriteAtlas.generateMipmaps = false;
  const hdRef = (manifest as HdCacheManifest & { spriteAtlasHd?: HdAtlasRef }).spriteAtlasHd;
  const spriteAtlasHd =
    hdRef && options.hdSprites !== false ? await loadHdAtlas(base.replace(/\/$/, ''), hdRef).catch(() => null) : null;

  const paletteRow = new Map<string, number>();
  const paletteRgb = new Map<string, Uint8Array>();
  for (const key of Object.keys(manifest.palettes))
    paletteRgb.set(key, await readPalettePng(url(manifest.palettes[key]!)));
  // House remaps are baked as extra palette rows ("<palette>@<owner>"): indices 16-31 take the house's 16 colours,
  // exactly how the engine recolours remappable art.
  for (const [owner, house] of Object.entries(manifest.houses ?? {})) {
    for (const [key, rgb] of [...paletteRgb]) {
      if (key.includes('@')) continue;
      const remapped = rgb.slice();
      house.remap.forEach(([r, g, b], i) => remapped.set([r, g, b], (16 + i) * 3));
      paletteRgb.set(`${key}@${owner}`, remapped);
    }
  }
  const keys = [...paletteRgb.keys()];
  // Spare rows let a live match add house remaps after load without resizing the texture shaders index into.
  const rows = Math.max(PALETTE_ROWS, keys.length);
  const stacked = new Uint8Array(256 * rows * 4);
  for (const [row, key] of keys.entries()) {
    paletteRow.set(key, row);
    writePaletteRow(stacked, row, paletteRgb.get(key)!);
  }
  const paletteAtlas = new DataTexture(stacked, 256, rows);
  paletteAtlas.colorSpace = SRGBColorSpace;
  paletteAtlas.magFilter = NearestFilter;
  paletteAtlas.minFilter = NearestFilter;
  paletteAtlas.needsUpdate = true;

  const voxels = new Map<string, VoxelModel>();
  await Promise.all(
    Object.entries(manifest.voxels).map(async ([id, file]) => {
      const response = await fetch(url(file));
      if (response.ok) voxels.set(id, (await response.json()) as VoxelModel);
    }),
  );

  let terrainMap: Ra2Cache['terrainMap'];
  const ref = options.terrainMap === false ? undefined : manifest.terrainMap;
  const materials = ref && options.colourMatched !== false ? await loadMapMaterials(url(MAP_MATERIALS_FILE)) : null;
  if (ref) {
    const material = resolveTerrainMaterials(ref, materials);
    // Upscaled composites already carry bled colours under their transparent border; only the raw scale-1 image
    // needs the dilation pass.
    // The colour-matched image has the same size and layout as ref.file.
    const { texture, original } = await loadDilated(url(material.file), ref.scale > 1 ? 0 : 10);
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    // A whole map is far larger than the screen when zoomed out: mipmaps keep it from shimmering.
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    // The composite's own water mask when present; otherwise treat nothing as water rather than guessing.
    const mask = material.waterMask ? await loadMask(url(material.waterMask)) : null;
    let waterDetail: Texture | null = null;
    if (material.waterDetail) {
      try {
        waterDetail = await load(material.waterDetail);
        // load() keeps PNG rows top-down (flipY = false), matching loadMask/loadDilated DataTextures and atlasUv.
        // Alpha is roughness data, not transparency; RGB is decoded from sRGB only when the shader samples it.
        waterDetail.colorSpace = SRGBColorSpace;
        waterDetail.magFilter = LinearFilter;
        waterDetail.minFilter = LinearMipmapLinearFilter;
        waterDetail.generateMipmaps = true;
        waterDetail.wrapS = ClampToEdgeWrapping;
        waterDetail.wrapT = ClampToEdgeWrapping;
      } catch (error) {
        console.warn(`${url(material.waterDetail)}: failed to load water detail; ignoring it`, error);
      }
    }
    let waterSurface: { texture: Texture; scale: number } | null = null;
    if (material.waterSurface) {
      try {
        const surface = await load(material.waterSurface);
        // Data channels (relief ratio, glints, foam lace): no sRGB decode; a seamless tile repeats in both axes.
        surface.colorSpace = NoColorSpace;
        surface.magFilter = LinearFilter;
        surface.minFilter = LinearMipmapLinearFilter;
        surface.generateMipmaps = true;
        surface.anisotropy = 8;
        surface.wrapS = RepeatWrapping;
        surface.wrapT = RepeatWrapping;
        waterSurface = { texture: surface, scale: material.waterSurfaceScale };
      } catch (error) {
        console.warn(`${url(material.waterSurface)}: failed to load water surface; ignoring it`, error);
      }
    }
    let shoreIgnore: Uint8Array | undefined;
    if (mask && material.shoreIgnore) {
      const ignoreUrl = url(material.shoreIgnore);
      try {
        const ignore = await loadMask(ignoreUrl);
        if (ignore.width === mask.width && ignore.height === mask.height) shoreIgnore = ignore.bytes;
        else console.warn(`${ignoreUrl}: shore-ignore size differs from the water mask; ignoring it`);
        // Only the CPU bytes feed the distance fields; this mask is never sampled by a material.
        ignore.texture.dispose();
      } catch (error) {
        console.warn(`${ignoreUrl}: failed to load shore-ignore mask; ignoring it`, error);
      }
    }
    void original;
    const downsample = material.waterBed ? 2 : 4;
    terrainMap = {
      texture,
      waterMask: mask?.texture ?? emptyMask(),
      waterBed: material.waterBed,
      waterDetail,
      waterSurface,
      // The lake-bed shoreline needs a finer, higher-precision distance field (see buildShoreField).
      shore: mask
        ? buildShoreField(mask.bytes, mask.width, mask.height, ref.scale, downsample, material.waterBed, shoreIgnore)
            .texture
        : emptyMask(),
      cliff:
        mask && shoreIgnore
          ? buildCliffField(mask.bytes, shoreIgnore, mask.width, mask.height, ref.scale, downsample).texture
          : null,
      ref,
    };
  }

  // Optional sidecars (pnpm hd:lights): the map's light sources and lit-window masks.
  const lights = await sidecarForManifest(
    await fetchOptionalJson(url('lights.json'), validateMapLights),
    manifestBytes,
  );
  const windowsIndex = await fetchOptionalJson<WindowsIndex>(url('windows.json'));
  const scenarioTypes = await fetchOptionalJson(url(SCENARIO_TYPES_FILE), validateScenarioTypes);
  const windowsTexture = windowsIndex ? await loadMaskTexture(url('windows.png')) : null;
  const windows = windowsIndex && windowsTexture ? { texture: windowsTexture, index: windowsIndex } : null;

  const exists = decodeBase64(manifest.cells.exists);
  const height = decodeBase64(manifest.cells.height);
  const lighting = lights?.lighting.normal ?? manifest.lighting;
  const mapLight = lighting
    ? new MapLightGrade(
        { width: manifest.grid.width, height: manifest.grid.height, z: height, exists },
        lighting,
        lights?.lights ?? [],
      )
    : null;
  for (const rgb of paletteRgb.values()) {
    setPaletteGrade(rgb, mapLight);
    setPaletteNodes(rgb, nodes);
  }

  return {
    base,
    nodes,
    manifest,
    lights,
    mapLight,
    windows,
    scenarioTypes,
    terrainMap,
    exists,
    height,
    tile,
    terrainAtlas,
    waterMask,
    spriteAtlas,
    spriteAtlasHd,
    paletteAtlas,
    paletteRow,
    paletteRgb,
    voxels,
  };
}

const PALETTE_ROWS = 128;

/** Default width of one painted water-surface tile, in screen units of 30 engine px (MapMaterials.waterSurfaceScale). */
export const DEFAULT_WATER_SURFACE_SCALE = 13;

/** Resolve the optional material overrides together, so the mask and the distance field always use the same asset. */
export function resolveTerrainMaterials(
  ref: NonNullable<HdCacheManifest['terrainMap']>,
  materials: MapMaterials | null,
): {
  file: string;
  waterMask: string | undefined;
  shoreIgnore: string | undefined;
  waterBed: boolean;
  waterDetail: string | undefined;
  waterSurface: string | undefined;
  waterSurfaceScale: number;
} {
  return {
    file: materials?.terrainMap ?? ref.file,
    waterMask: materials?.waterMask ?? ref.waterMask,
    shoreIgnore: typeof materials?.shoreIgnore === 'string' ? materials.shoreIgnore : undefined,
    waterBed: materials?.waterBed === true,
    waterDetail: typeof materials?.waterDetail === 'string' ? materials.waterDetail : undefined,
    waterSurface: typeof materials?.waterSurface === 'string' ? materials.waterSurface : undefined,
    waterSurfaceScale:
      typeof materials?.waterSurfaceScale === 'number' && materials.waterSurfaceScale > 0
        ? materials.waterSurfaceScale
        : DEFAULT_WATER_SURFACE_SCALE,
  };
}

/** The optional per-map materials sidecar; null when absent or unreadable (dev servers may answer 404 or HTML). */
async function loadMapMaterials(url: string): Promise<MapMaterials | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const json = (await response.json()) as MapMaterials;
    // Resolve optional shoreIgnore/waterDetail types without rejecting legacy sidecars or their other overrides.
    return json && json.version === 1 ? json : null;
  } catch {
    return null;
  }
}

function writePaletteRow(stacked: Uint8Array, row: number, rgb: Uint8Array): void {
  for (let i = 0; i < 256; i++) stacked.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, 255], (row * 256 + i) * 4);
}

/** Add (or replace) a base palette row at runtime, e.g. a type library's palettes under a prefixed key. */
export function addPalette(cache: Ra2Cache, key: string, rgb: Uint8Array): boolean {
  const stacked = cache.paletteAtlas.image.data as Uint8Array;
  let row = cache.paletteRow.get(key);
  if (row === undefined) {
    if (cache.paletteRow.size >= cache.paletteAtlas.image.height) return false;
    row = cache.paletteRow.size;
    cache.paletteRow.set(key, row);
  }
  cache.paletteRgb.set(key, rgb);
  setPaletteGrade(rgb, cache.mapLight);
  if (cache.nodes) setPaletteNodes(rgb, cache.nodes);
  writePaletteRow(stacked, row, rgb);
  cache.paletteAtlas.needsUpdate = true;
  return true;
}

/**
 * Add "<palette>@<owner>" rows for a house discovered at runtime (a live match's players): palette indices 16-31 take
 * the house's 16 remap colours, like the rows baked at load for houses named by the map. Returns false when the atlas
 * is full; existing rows are left untouched.
 */
export function addHousePalettes(
  cache: Ra2Cache,
  owner: string,
  remap: readonly (readonly [number, number, number])[],
): boolean {
  const stacked = cache.paletteAtlas.image.data as Uint8Array;
  const capacity = cache.paletteAtlas.image.height;
  const bases = [...cache.paletteRgb.keys()].filter((key) => !key.includes('@'));
  let next = cache.paletteRow.size;
  for (const key of bases) {
    const houseKey = `${key}@${owner}`;
    const remapped = cache.paletteRgb.get(key)!.slice();
    remap.slice(0, 16).forEach(([r, g, b], i) => remapped.set([r, g, b], (16 + i) * 3));
    cache.paletteRgb.set(houseKey, remapped);
    setPaletteGrade(remapped, cache.mapLight);
    if (cache.nodes) setPaletteNodes(remapped, cache.nodes);
    let row = cache.paletteRow.get(houseKey);
    if (row === undefined) {
      if (next >= capacity) return false;
      row = next++;
      cache.paletteRow.set(houseKey, row);
    }
    writePaletteRow(stacked, row, remapped);
  }
  cache.paletteAtlas.needsUpdate = true;
  return true;
}

/** Palettes are 256x1 RGB(A) PNGs; decode through a canvas to get exact bytes. */
export async function readPalettePng(url: string): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, 1).data;
  const rgb = new Uint8Array(256 * 3);
  for (let i = 0; i < Math.min(256, bitmap.width); i++)
    rgb.set([pixels[i * 4]!, pixels[i * 4 + 1]!, pixels[i * 4 + 2]!], i * 3);
  return rgb;
}

/** Engine screen projection of a cell-space point (x, y, height level) in original pixels. */
export function ra2Screen(x: number, y: number, level: number): [number, number] {
  return [(x - y) * 30, (x + y) * 15 - level * 15];
}

/** Atlas pixel of a world point drawn by `tile`, whose raster is anchored at the cell's top corner (cx, cy, level). */
export function tileAtlasPixel(
  tile: TileEntry,
  cx: number,
  cy: number,
  level: number,
  x: number,
  y: number,
  z: number,
): [number, number] {
  const [ax, ay] = ra2Screen(cx, cy, level);
  const [px, py] = ra2Screen(x, y, z);
  return [tile.rect[0] + tile.anchor[0] + (px - ax), tile.rect[1] + tile.anchor[1] + (py - ay)];
}

/** Palette key for an object's art: the house-remapped row when the art is remappable and the owner is known. */
const remapKeys = new WeakMap<Ra2Cache, Map<string, Map<string, string>>>();

export function paletteFor(cache: Ra2Cache, palette: string, remap: boolean, owner?: string): string {
  if (!remap || !owner) return palette;
  let owners = remapKeys.get(cache);
  if (!owners) remapKeys.set(cache, (owners = new Map()));
  let palettes = owners.get(owner);
  if (!palettes) owners.set(owner, (palettes = new Map()));
  let key = palettes.get(palette);
  if (!key) palettes.set(palette, (key = `${palette}@${owner}`));
  // Palette rows may arrive after the first lookup, so cache only the key, never its availability.
  return cache.paletteRow.has(key) ? key : palette;
}

/** World point on the ground at `level` whose engine projection is the screen point (sx, sy). */
export function screenToCell(sx: number, sy: number, level: number): [x: number, y: number] {
  const diff = sx / 30;
  const sum = (sy + level * 15) / 15;
  return [(sum + diff) / 2, (sum - diff) / 2];
}

/**
 * Load an RGBA atlas and bleed opaque colours into neighbouring transparent texels. Tile diamonds end exactly on
 * their cell edges, so bilinear filtering there would otherwise mix in the transparent (black) surroundings and draw a
 * dark grid. Alpha is kept so wall geometry can still tell art from empty raster.
 */
async function loadDilated(url: string, passes = 10): Promise<{ texture: DataTexture; original: Uint8Array }> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const { width, height } = bitmap;
  const data = context.getImageData(0, 0, width, height).data;
  const pixels = new Uint8Array(data.buffer.slice(0));
  const original = pixels.slice();
  let filled = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) filled[i] = pixels[i * 4 + 3]! >= 128 ? 1 : 0;
  // Wide enough to cover ramp cells whose geometry samples a few pixels past the painted diamond.
  for (let pass = 0; pass < passes; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (!filled[j]) continue;
          r += pixels[j * 4]!;
          g += pixels[j * 4 + 1]!;
          b += pixels[j * 4 + 2]!;
          n++;
        }
        if (n) {
          pixels[i * 4] = r / n;
          pixels[i * 4 + 1] = g / n;
          pixels[i * 4 + 2] = b / n;
          next[i] = 1;
        }
      }
    }
    filled = next;
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return { texture, original };
}

/** Template families that can contain open water: open sea, shores, water cliffs and bridges over water. */
const WATER_FAMILIES = /^(water|shore|w-a-|w-b-|wbrdge|wtr|bank)/i;

/**
 * Per-pixel open-water mask over the terrain atlas, classified from the original art so HD water follows the painted
 * shoreline exactly. Only water-related templates are classified (grey cliffs or blue-ish rocks elsewhere never turn
 * into water); pure water templates (land type 9) are water wherever they are opaque. The mask is softened a little
 * so the shoreline band can carry foam.
 */
function buildWaterMask(rgba: Uint8Array, width: number, height: number, tiles: readonly TileEntry[]): DataTexture {
  const mask = new Float32Array(width * height);
  for (const tile of tiles) {
    const family = tile.file.replace(/\d+\..*$/, '');
    if (!WATER_FAMILIES.test(family) && tile.terrainType !== 9) continue;
    const [rx, ry, rw, rh] = tile.rect;
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = y * width + x;
        if (rgba[i * 4 + 3]! < 128) continue;
        if (tile.terrainType === 9) {
          mask[i] = 1;
          continue;
        }
        const r = rgba[i * 4]! / 255;
        const g = rgba[i * 4 + 1]! / 255;
        const b = rgba[i * 4 + 2]! / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        // Water in the RA2 theater palettes is a desaturated navy/teal: blue dominates and value stays low.
        const blueness = b - Math.max(r, g * 0.9);
        const score =
          Math.min(1, Math.max(0, (blueness - 0.02) / 0.08)) *
          Math.min(1, Math.max(0, (saturation - 0.12) / 0.15)) *
          (max < 0.75 ? 1 : 0);
        mask[i] = score;
      }
    }
  }
  // Soften the painted edge into a short band (foam lives there), averaging only over opaque texels so the diamond
  // borders of neighbouring atlas entries never read as shoreline; then bleed values into transparent texels, like
  // the colour dilation, so bilinear sampling at cell edges stays continuous.
  const opaque = new Uint8Array(width * height);
  for (let i = 0; i < opaque.length; i++) opaque[i] = rgba[i * 4 + 3]! >= 128 ? 1 : 0;
  let current = mask;
  for (let pass = 0; pass < 2; pass++) {
    const next = current.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!opaque[i]) continue;
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || !opaque[ny * width + nx]) continue;
            sum += current[ny * width + nx]!;
            n++;
          }
        }
        next[i] = sum / n;
      }
    }
    current = next;
  }
  let filled = opaque.slice();
  for (let pass = 0; pass < 3; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (filled[i]) continue;
        let sum = 0;
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !filled[ny * width + nx]) continue;
          sum += current[ny * width + nx]!;
          n++;
        }
        if (n) {
          current[i] = sum / n;
          next[i] = 1;
        }
      }
    }
    filled = next;
  }
  const bytes = new Uint8Array(width * height);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(current[i]! * 255);
  const texture = new DataTexture(bytes, width, height, RedFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

async function loadMask(
  url: string,
): Promise<{ texture: DataTexture; bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const bytes = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < bytes.length; i++) bytes[i] = rgba[i * 4]!;
  const texture = new DataTexture(bytes, bitmap.width, bitmap.height, RedFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, bytes, width: bitmap.width, height: bitmap.height };
}

function emptyMask(): DataTexture {
  const texture = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}
