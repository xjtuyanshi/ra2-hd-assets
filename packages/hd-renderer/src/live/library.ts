import { DataTexture, NearestFilter, NoColorSpace, RedFormat, Texture, UnsignedByteType } from 'three/webgpu';
import type { LibraryType, TypeLibrary } from '../../../ra2-assets/src/library';
import { indexedBitmapPixels } from './indexedPixels';
import type { PageUpload } from '../pageUpload';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import type { SpriteMaterialAtlas } from '../ra2/spriteLook';
import {
  loadSpriteMaterialAtlas,
  validateLibrarySpriteMaterials,
  type LibrarySpriteMaterialsSidecar,
} from '../ra2/spriteMaterials';
import {
  addPalette,
  fetchOptionalJson,
  loadHdAtlas,
  loadMaskTexture,
  readPalettePng,
  type HdAtlas,
  type HdAtlasRef,
  type Ra2Cache,
  type WindowsIndex,
} from '../ra2/cache';

/** Palette keys of the library live next to the map cache's own under this prefix. */
export const LIBRARY_PALETTE_PREFIX = 'lib:';

/**
 * The per-theater type library (packages/ra2-assets/src/library.ts): art for every building, vehicle, infantry and
 * aircraft type, so a live match can draw what players build. Atlas pages and voxel models are loaded on first use;
 * callers ask again on a later frame until they are ready.
 */
export class LiveLibrary {
  private readonly pages = new Map<
    number,
    { texture: Texture; width: number; height: number } | 'loading' | 'failed'
  >();
  /** Changes when asynchronous art settles; presentation can sleep while nothing has arrived. */
  revision = 0;
  /** 'ahead': being fetched before anything asked for it (preloadVoxels); it is nobody's missing art yet. */
  private readonly voxels = new Map<string, VoxelModel | 'loading' | 'ahead' | 'failed'>();
  private voxelTypes?: Map<string, string>;
  private readonly hdPages = new Map<number, HdAtlas | 'loading' | 'failed'>();
  private readonly windowPages = new Map<number, Texture | 'loading' | 'failed'>();
  private readonly materialPages = new Map<number, SpriteMaterialAtlas | 'loading' | 'failed'>();
  private materialsDisposed = false;
  private depthTemplateDisposed = false;
  /** Uploads a freshly decoded page straight to the GPU (the view's PageUploader); see loadIndexedPage. */
  uploadPage: PageUpload | null = null;

  private constructor(
    readonly base: string,
    readonly library: TypeLibrary,
    /** Lit-window masks per atlas page (pnpm hd:lights -- --library <theater>), when extracted. */
    readonly windows: WindowsIndex | null,
    private readonly materials: LibrarySpriteMaterialsSidecar | null,
    private readonly cache: Ra2Cache,
    private readonly depthTemplate: Ra2Cache['depthTemplate'],
  ) {}

  /** Null when the theater has no extracted library (pnpm hd:library), in which case the map cache is used alone. */
  static async load(base: string, cache: Ra2Cache): Promise<LiveLibrary | null> {
    const root = base.replace(/\/$/, '');
    const response = await fetch(`${root}/library.json`).catch(() => null);
    if (!response?.ok) return null;
    const library = (await response.json()) as TypeLibrary;
    // HD pages recorded outside library.json (a sidecar written by a later tool, same shape as spriteAtlasesHd), so
    // library.json itself never has to be rewritten.
    if (!library.spriteAtlasesHd) {
      const sidecar = await fetch(`${root}/sprites-hd.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const pages = Array.isArray(sidecar)
        ? sidecar
        : (sidecar as { spriteAtlasesHd?: unknown } | null)?.spriteAtlasesHd;
      if (Array.isArray(pages)) library.spriteAtlasesHd = pages as TypeLibrary['spriteAtlasesHd'];
    }
    for (const [key, file] of Object.entries(library.palettes))
      addPalette(cache, LIBRARY_PALETTE_PREFIX + key, await readPalettePng(`${root}/${file}`));
    const windows = await fetchOptionalJson<WindowsIndex>(`${root}/windows.json`);
    const materials = await fetchOptionalJson(`${root}/normals.json`, validateLibrarySpriteMaterials);
    for (const [index, page] of Object.entries(materials?.pages ?? {})) {
      const hd = library.spriteAtlasesHd?.[Number(index)];
      if (
        !hd ||
        hd.width !== page.width ||
        hd.height !== page.height ||
        hd.file !== page.atlas ||
        hd.scale !== page.scale
      ) {
        console.warn(
          `${root}/normals.json: page ${index} made for ${page.atlas} (${page.width}x${page.height}, scale ${page.scale}), ignored`,
        );
        delete materials!.pages[index];
      }
    }
    // Publish before LiveView constructs any sprite materials: every atlas page uses this same texture.
    // An absent descriptor deliberately retains the analytic path; a declared but invalid payload is an error.
    const depthTemplate =
      library.depthTemplate === undefined ? undefined : await loadDepthTemplate(root, library.depthTemplate);
    if (depthTemplate) cache.depthTemplate = depthTemplate;
    else delete cache.depthTemplate;
    return new LiveLibrary(root, library, windows, materials, cache, depthTemplate);
  }

  /** Pages, masks and voxel models that were asked for and are still being fetched or decoded. */
  get loading(): number {
    let count = 0;
    for (const entries of [this.pages, this.hdPages, this.windowPages, this.materialPages, this.voxels])
      for (const entry of entries.values()) if (entry === 'loading') count++;
    return count;
  }

  /** Whether a compatible material page exists and has not failed; this never requests the PNG. */
  hasMaterialsPage(index: number): boolean {
    return (
      !this.materialsDisposed && !!this.materials?.pages[String(index)] && this.materialPages.get(index) !== 'failed'
    );
  }

  /** Material data loads only when an enhanced look needs it. A pending/failed page keeps the existing art. */
  materialsPage(index: number): SpriteMaterialAtlas | null {
    if (!this.hasMaterialsPage(index)) return null;
    const entry = this.materialPages.get(index);
    if (entry === undefined) {
      this.materialPages.set(index, 'loading');
      const page = this.materials!.pages[String(index)]!;
      void loadSpriteMaterialAtlas(`${this.base}/${page.file}`, this.uploadPage ?? undefined).then((atlas) => {
        if (this.materialsDisposed) {
          atlas?.texture.dispose();
          return;
        }
        this.materialPages.set(index, atlas ?? 'failed');
        this.revision++;
      });
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /** The live view owns these shared textures; replacing a sprite mesh must not release them. */
  disposeMaterials(): void {
    this.materialsDisposed = true;
    for (const atlas of this.materialPages.values()) if (typeof atlas !== 'string') atlas.texture.dispose();
    this.materialPages.clear();
  }

  /** Shared by sprite materials; only the owning live view releases it, never an individual atlas page. */
  disposeDepthTemplate(): void {
    if (this.depthTemplateDisposed) return;
    this.depthTemplateDisposed = true;
    this.depthTemplate?.texture.dispose();
    // A later library may already own the cache binding when the old view finishes disposing.
    if (this.cache.depthTemplate === this.depthTemplate) delete this.cache.depthTemplate;
  }

  /** Whether the page has a lit-window mask (loaded or loading). */
  hasWindowsPage(index: number): boolean {
    return !!this.windows?.pages?.[String(index)] && this.windowPages.get(index) !== 'failed';
  }

  /** The page's lit-window mask, null while it loads or when the page has none. */
  windowsPage(index: number): Texture | null {
    const file = this.windows?.pages?.[String(index)];
    if (!file) return null;
    const entry = this.windowPages.get(index);
    if (entry === undefined) {
      this.windowPages.set(index, 'loading');
      void loadMaskTexture(`${this.base}/${file}`).then((texture) => {
        this.windowPages.set(index, texture ?? 'failed');
        this.revision++;
      });
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /** Lit window pixels of a building sprite's frame (0 when none or unknown). */
  litWindows(sprite: string, frame: number): number {
    return this.windows?.frames[sprite]?.[String(frame)]?.lit ?? 0;
  }

  /**
   * Lit-pane columns of a building sprite's frame as [screen x from the draw point, panes] (see windowPaneColumns),
   * empty when none or unknown.
   */
  windowColumns(sprite: string, frame: number): [number, number][] {
    const art = this.library.sprites[sprite]?.frames[frame];
    const columns = this.windows?.frames[sprite]?.[String(frame)]?.columns;
    return art && columns ? columns.map(([x, panes]) => [art.offset[0] + x, panes]) : [];
  }

  type(id: string): LibraryType | undefined {
    return this.library.types[id];
  }

  /** 16 remap colours of a house's colour scheme index, as the game's runtime array orders them. */
  remap(colorIndex: number): [number, number, number][] | undefined {
    const remap = this.library.colorSchemes[colorIndex]?.remap;
    // In-game measurement: the engine's ramp is less saturated than rules [Colors] at the bright end (about 0.77x on
    // index 16, reaching full saturation by index 28); the extracted ramp keeps full saturation, so adjust here.
    return remap?.map(([r, g, b], i) => desaturate(r, g, b, 0.77 + 0.23 * Math.min(1, i / 12)));
  }

  get conditionYellow(): number {
    return this.library.conditionYellow;
  }

  /** The atlas page texture, or null while it loads (or if it failed). */
  page(index: number): { texture: Texture; width: number; height: number } | null {
    const entry = this.pages.get(index);
    const ref = this.library.spriteAtlases[index];
    if (!ref) return null;
    if (entry === undefined) {
      this.pages.set(index, 'loading');
      loadIndexedPage(`${this.base}/${ref.file}`, this.uploadPage ?? undefined)
        .then((texture) => {
          this.pages.set(index, { texture, width: ref.width, height: ref.height });
          this.revision++;
        })
        .catch(() => {
          this.pages.set(index, 'failed');
          this.revision++;
        });
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /** A missing/failed page is settled, so infrequently changing cell layers need not retry it every frame. */
  pageFailed(index: number): boolean {
    return !this.library.spriteAtlases[index] || this.pages.get(index) === 'failed';
  }

  /**
   * The page's HD atlas (pnpm hd:sprites --library), null while loading or when the page has none. Callers draw the
   * indexed page until it arrives.
   */
  hdPage(index: number): HdAtlas | null {
    const refs = (this.library as TypeLibrary & { spriteAtlasesHd?: (HdAtlasRef | null)[] }).spriteAtlasesHd;
    const ref = refs?.[index];
    if (!ref) return null;
    const entry = this.hdPages.get(index);
    if (entry === undefined) {
      this.hdPages.set(index, 'loading');
      loadHdAtlas(this.base, ref, this.uploadPage ?? undefined)
        .then((atlas) => {
          this.hdPages.set(index, atlas);
          this.revision++;
        })
        .catch(() => {
          this.hdPages.set(index, 'failed');
          this.revision++;
        });
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /** Whether the page has an HD atlas that has not failed to load. */
  hasHdPage(index: number): boolean {
    const refs = (this.library as TypeLibrary & { spriteAtlasesHd?: (HdAtlasRef | null)[] }).spriteAtlasesHd;
    return !!refs?.[index] && this.hdPages.get(index) !== 'failed';
  }

  /** A voxel model by library voxel id, or null while it loads. */
  voxel(id: string): VoxelModel | null {
    const entry = this.voxels.get(id);
    const file = this.library.voxels[id];
    if (!file) return null;
    if (entry === undefined) this.fetchVoxel(id, file, 'loading');
    // Asked for while it is fetched ahead: from now on it is art on its way, and its arrival is news.
    else if (entry === 'ahead') this.voxels.set(id, 'loading');
    return typeof entry === 'object' ? entry : null;
  }

  private fetchVoxel(id: string, file: string, state: 'loading' | 'ahead'): void {
    this.voxels.set(id, state);
    const settle = (result: VoxelModel | 'failed') => {
      // Only a model something waits for changes what is drawn; one fetched ahead arrives silently.
      const wanted = this.voxels.get(id) === 'loading';
      this.voxels.set(id, result);
      if (wanted) this.revision++;
    };
    fetch(`${this.base}/${file}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.statusText))))
      .then(settle, () => settle('failed'));
  }

  /**
   * Fetch the model files nothing has asked for yet, at most `inFlight` at a time; call again (every frame is fine)
   * until it answers true: every model of the library has been requested. A model file is what a unit's first frame
   * needs before anything can be drawn for it (its mesh has a stand-in, its file has none), and the whole set is
   * small (94 files, 5.7 MB in the extracted library), so a view fetches it ahead once its opening art is in instead
   * of at each kind's first appearance. Models fetched ahead do not count as `loading` and do not change `revision`.
   */
  preloadVoxels(inFlight = 2): boolean {
    let ahead = 0;
    for (const entry of this.voxels.values()) if (entry === 'ahead') ahead++;
    let complete = true;
    for (const [id, file] of Object.entries(this.library.voxels)) {
      if (this.voxels.has(id)) continue;
      if (ahead >= inFlight) {
        complete = false;
        break;
      }
      this.fetchVoxel(id, file, 'ahead');
      ahead++;
    }
    return complete;
  }

  /**
   * The type id that draws library voxel `voxel` (a type names its unloading image by voxel id, the engine reports the
   * image by type id): the type of the same name when it uses that voxel, else the first vehicle/aircraft that does.
   */
  voxelType(voxel: string): string | undefined {
    let types = this.voxelTypes;
    if (!types) {
      types = this.voxelTypes = new Map();
      for (const [id, type] of Object.entries(this.library.types))
        if (type.voxel && (id === type.voxel || !types.has(type.voxel))) types.set(type.voxel, id);
    }
    return types.get(voxel);
  }

  /** Whether a voxel model is missing from the library or failed to load (as opposed to still loading). */
  voxelFailed(id: string): boolean {
    return !this.library.voxels[id] || this.voxels.get(id) === 'failed';
  }
}

/** The extractor has already applied BUILDNGZ's signed-byte transform; preserve every byte, including zero. */
async function loadDepthTemplate(
  root: string,
  ref: NonNullable<TypeLibrary['depthTemplate']>,
): Promise<NonNullable<Ra2Cache['depthTemplate']>> {
  if (
    !ref ||
    typeof ref.file !== 'string' ||
    !ref.file.length ||
    !Number.isSafeInteger(ref.width) ||
    !Number.isSafeInteger(ref.height) ||
    ref.width <= 0 ||
    ref.height <= 0 ||
    !Number.isSafeInteger(ref.width * ref.height)
  ) {
    throw new Error(`${root}/library.json: invalid depthTemplate descriptor`);
  }
  const url = `${root}/${ref.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = ref.width * ref.height;
  if (bytes.byteLength !== expected) {
    throw new Error(`${url}: depthTemplate has ${bytes.byteLength} bytes, expected ${expected}`);
  }
  const texture = new DataTexture(bytes, ref.width, ref.height, RedFormat, UnsignedByteType);
  indexedSettings(texture);
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, width: ref.width, height: ref.height };
}

/**
 * An indexed atlas page (8-bit grayscale PNG: the value is a palette index) as a single-channel R8 texture: a quarter
 * of the GPU memory of the RGBA8 texture an image loader makes (16 MiB instead of 64 MiB for a 4096 x 4096 page).
 * Decoded without colour conversion or premultiplication, never filtered, flipped or mipmapped.
 *
 * With `upload` (the renderer's initTexture) the decoded bitmap goes to the GPU as it is: WebGPU's
 * copyExternalImageToTexture (WebGL: texImage2D with RED) writes its red channel into the R8 texture, so the main
 * thread never touches the 16.7 M pixels, and the bitmap is released right after the upload. Without it (tests, other
 * hosts), bounded strips yield between reads; the R8 CPU copy is released after the renderer's first upload.
 */
export async function loadIndexedPage(url: string, upload?: PageUpload): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const { width, height } = bitmap;
  try {
    if (upload) {
      const texture = new Texture(bitmap as unknown as HTMLImageElement);
      indexedSettings(texture);
      texture.format = RedFormat;
      texture.type = UnsignedByteType;
      texture.premultiplyAlpha = false;
      texture.needsUpdate = true;
      try {
        await upload(texture);
      } catch (error) {
        texture.dispose();
        throw error;
      }
      // Only dimensions survive: this immutable page is never uploaded again.
      texture.image = { width, height } as unknown as HTMLImageElement;
      return texture;
    }
    const indices = await indexedBitmapPixels(bitmap);
    const texture = new DataTexture(indices, width, height, RedFormat, UnsignedByteType);
    indexedSettings(texture);
    texture.unpackAlignment = 1;
    texture.onUpdate = () => {
      // Both renderer backends have copied these immutable bytes when onUpdate runs.
      texture.image.data = null;
      texture.onUpdate = null;
    };
    texture.needsUpdate = true;
    return texture;
  } finally {
    bitmap.close();
  }
}

function indexedSettings(texture: Texture): void {
  texture.flipY = false;
  texture.colorSpace = NoColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
}

/** Scale an sRGB colour's HSV saturation, keeping hue and value. */
function desaturate(r: number, g: number, b: number, factor: number): [number, number, number] {
  const max = Math.max(r, g, b);
  return [r, g, b].map((c) => Math.round(max - (max - c) * factor)) as [number, number, number];
}
