import { DataTexture, NearestFilter, NoColorSpace, RedFormat, Texture, UnsignedByteType } from 'three/webgpu';
import type { LibraryType, TypeLibrary } from '../../../ra2-assets/src/library';
import type { VoxelModel } from '../../../ra2-assets/src/manifest';
import {
  addPalette,
  fetchOptionalJson,
  loadHdAtlas,
  loadMaskTexture,
  readPalettePng,
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
  private readonly pages = new Map<number, Texture | 'loading' | 'failed'>();
  private readonly voxels = new Map<string, VoxelModel | 'loading' | 'failed'>();
  private readonly hdPages = new Map<number, { color: Texture; remap: Texture } | 'loading' | 'failed'>();
  private readonly windowPages = new Map<number, Texture | 'loading' | 'failed'>();
  /** Uploads a freshly decoded page straight to the GPU (the renderer's initTexture); see loadIndexedPage. */
  uploadPage: ((texture: Texture) => void) | null = null;

  private constructor(
    readonly base: string,
    readonly library: TypeLibrary,
    /** Lit-window masks per atlas page (pnpm hd:lights -- --library <theater>), when extracted. */
    readonly windows: WindowsIndex | null,
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
    return new LiveLibrary(root, library, windows);
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
      void loadMaskTexture(`${this.base}/${file}`).then((texture) => this.windowPages.set(index, texture ?? 'failed'));
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
        .then((texture) => this.pages.set(index, texture))
        .catch(() => this.pages.set(index, 'failed'));
      return null;
    }
    return typeof entry === 'string' ? null : { texture: entry, width: ref.width, height: ref.height };
  }

  /**
   * The page's HD atlas (pnpm hd:sprites --library), null while loading or when the page has none. Callers draw the
   * indexed page until it arrives.
   */
  hdPage(index: number): { color: Texture; remap: Texture } | null {
    const refs = (this.library as TypeLibrary & { spriteAtlasesHd?: (HdAtlasRef | null)[] }).spriteAtlasesHd;
    const ref = refs?.[index];
    if (!ref) return null;
    const entry = this.hdPages.get(index);
    if (entry === undefined) {
      this.hdPages.set(index, 'loading');
      loadHdAtlas(this.base, ref)
        .then((atlas) => this.hdPages.set(index, atlas))
        .catch(() => this.hdPages.set(index, 'failed'));
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
    if (entry === undefined) {
      this.voxels.set(id, 'loading');
      fetch(`${this.base}/${file}`)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.statusText))))
        .then((model: VoxelModel) => this.voxels.set(id, model))
        .catch(() => this.voxels.set(id, 'failed'));
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /** Whether a voxel model is missing from the library or failed to load (as opposed to still loading). */
  voxelFailed(id: string): boolean {
    return !this.library.voxels[id] || this.voxels.get(id) === 'failed';
  }
}

/**
 * An indexed atlas page (8-bit grayscale PNG: the value is a palette index) as a single-channel R8 texture: a quarter
 * of the GPU memory of the RGBA8 texture an image loader makes (16 MiB instead of 64 MiB for a 4096 x 4096 page).
 * Decoded without colour conversion or premultiplication, never filtered, flipped or mipmapped.
 *
 * With `upload` (the renderer's initTexture) the decoded bitmap goes to the GPU as it is: WebGPU's
 * copyExternalImageToTexture (WebGL: texImage2D with RED) writes its red channel into the R8 texture, so the main
 * thread never touches the 16.7 M pixels, and the bitmap is released right after the upload. Without it (tests, other
 * hosts) the red channel is repacked on the CPU (about 45 ms per 4096 x 4096 page).
 */
export async function loadIndexedPage(url: string, upload?: (texture: Texture) => void): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const { width, height } = bitmap;
  if (upload) {
    const texture = new Texture(bitmap as unknown as HTMLImageElement);
    indexedSettings(texture);
    texture.format = RedFormat;
    texture.type = UnsignedByteType;
    texture.premultiplyAlpha = false;
    texture.needsUpdate = true;
    upload(texture);
    // The GPU copy has read the bitmap; keep only its size (the texture is never uploaded again).
    bitmap.close();
    texture.image = { width, height } as unknown as HTMLImageElement;
    return texture;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = context.getImageData(0, 0, width, height).data;
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) indices[i] = rgba[i * 4]!;
  const texture = new DataTexture(indices, width, height, RedFormat, UnsignedByteType);
  indexedSettings(texture);
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
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
