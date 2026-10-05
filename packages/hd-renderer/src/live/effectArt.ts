import type { PageUpload } from '../pageUpload';
import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three/webgpu';
import type {
  EffectAnim,
  EffectBullet,
  EffectCellArt,
  EffectHdAnim,
  EffectHdLibrary,
  EffectLibrary,
  EffectParticle,
  EffectSpriteRef,
} from '../../../ra2-assets/src/effects';
import type { SpriteEntry, VoxelModel } from '../../../ra2-assets/src/manifest';
import type { TheaterId } from '../../../ra2-assets/src/theater';
import { addPalette, readPalettePng, type Ra2Cache } from '../ra2/cache';
import { LIBRARY_PALETTE_PREFIX, loadIndexedPage } from './library';
import type { EffectPage } from './effectSprites';

/** Seconds before a page that failed to load is requested again. */
export const PAGE_RETRY_SECONDS = 30;

/** Palette keys of the effect sidecar live next to the map cache's own under this prefix. */
export const EFFECT_PALETTE_PREFIX = 'fx:';

/** An anim type ready to draw: its art record, the theater's sprite and the palette row key (before house remap). */
export interface ResolvedAnim {
  id: string;
  art: EffectAnim;
  sprite: SpriteEntry;
  /** Base palette key ("fx:anim", or the unit palette for AltPalette art). */
  palette: string;
  /** Whether the owner's house colours apply (AltPalette art). */
  remap: boolean;
}

/**
 * The effect art sidecar (packages/ra2-assets/src/effects.ts, `pnpm hd:effects`): original art of every anim,
 * projectile, debris voxel, particle, overlay and smudge. effects.json is fetched on first use and atlas pages and
 * voxel models on demand, like LiveLibrary: callers ask again on a later frame until the art is there. Without the
 * sidecar every lookup stays null and the live view simply draws no native effect art.
 * A separate optional effects-hd.json supplies RGBA replacement frames; its index and pages settle independently and
 * never change native lookups, palette ownership or page numbering.
 */
export class EffectArt {
  private library: EffectLibrary | null = null;
  private state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private readonly pages = new Map<number, EffectPage | 'loading' | { failedAt: number }>();
  private hdLibrary: EffectHdLibrary | null = null;
  private hdLoading: Promise<void> | null = null;
  private hdIndexLoading = false;
  private readonly hdPages = new Map<number, EffectPage | 'loading' | { failedAt: number }>();
  private readonly hdPinned = new Set<number>();
  private settledRevision = 0;
  /** Pages requested by preload(): kept when idle (every battle needs them again). */
  private readonly pinned = new Set<number>();
  private readonly voxels = new Map<string, VoxelModel | 'loading' | 'failed'>();
  private readonly resolved = new Map<string, ResolvedAnim | null>();
  private readonly resolvedBullets = new Map<string, { art: EffectBullet; sprite?: SpriteEntry } | null>();
  /** Anim ids without art, for diagnostics. */
  readonly missing = new Set<string>();
  /** Uploads a freshly decoded page straight to the GPU (the renderer's initTexture); see loadIndexedPage. */
  uploadPage: PageUpload | null = null;

  constructor(
    /** Directory holding effects.json (…/_library/common/effects). */
    readonly base: string,
    private readonly cache: Ra2Cache,
    readonly theater: TheaterId,
    /** Whether the type library's palettes (lib:unit with house rows) are loaded. */
    private readonly libraryPalettes: boolean,
    /** Optional RGBA flipbooks, alongside the native effect sidecar by default. */
    readonly hdBase: string = `${base}/../effects-hd`,
  ) {}

  /** Start loading effects.json (idempotent); resolves when it is loaded or known to be missing. */
  load(): Promise<void> {
    if (this.state !== 'idle') return Promise.resolve();
    this.state = 'loading';
    return fetch(`${this.base}/effects.json`)
      .then((r) => (r.ok ? (r.json() as Promise<EffectLibrary>) : Promise.reject(new Error(r.statusText))))
      .then(async (library) => {
        // Palettes first, so a resolved anim always has its row. The unit palette of the map's theater is only
        // needed when the type library (which already holds it with house rows) is missing.
        const keys = ['anim', ...(this.libraryPalettes ? [] : [`unit.${this.theater}`])];
        for (const key of keys) {
          const file = library.palettes[key];
          if (!file) continue;
          const name = EFFECT_PALETTE_PREFIX + key.replace(`.${this.theater}`, '');
          if (!addPalette(this.cache, name, await readPalettePng(`${this.base}/${file}`)))
            console.warn(`[HD] palette atlas full: effect palette ${name} not added`);
        }
        this.library = library;
        this.state = 'ready';
        this.settledRevision++;
      })
      .catch((error) => {
        this.state = 'failed';
        this.settledRevision++;
        console.info('[HD] no effect art sidecar (pnpm hd:effects); native effects are not drawn', error);
      });
  }

  /** The index, HD index, pages and voxel models that were asked for and are still being fetched or decoded. */
  get loading(): number {
    let count = (this.state === 'loading' ? 1 : 0) + (this.hdIndexLoading ? 1 : 0);
    for (const entries of [this.pages, this.hdPages, this.voxels])
      for (const entry of entries.values()) if (entry === 'loading') count++;
    return count;
  }

  /** Fetch the optional HD index once; absence is informational and never prevents native effect art from loading. */
  loadHd(): Promise<void> {
    if (!this.hdLoading) this.hdIndexLoading = true;
    return (this.hdLoading ??= fetch(`${this.hdBase}/effects-hd.json`)
      .then((r) => (r.ok ? (r.json() as Promise<EffectHdLibrary>) : Promise.reject(new Error(r.statusText))))
      .then((library) => {
        if (library.version !== 1) throw new Error(`Unsupported HD effect library version: ${library.version}`);
        this.hdLibrary = library;
      })
      .catch(() => {
        console.info('[HD] no HD effect flipbook sidecar; effects keep their native art');
      })
      .finally(() => {
        this.hdIndexLoading = false;
        this.settledRevision++;
      }));
  }

  /** Redrawn frames of an anim, or null until the optional index loads (or when it has no replacement). */
  hdAnim(type: string): EffectHdAnim | null {
    if (!this.hdLibrary) {
      void this.loadHd();
      return null;
    }
    return this.hdLibrary.anims[type] ?? this.hdLibrary.anims[type.toUpperCase()] ?? null;
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  get failed(): boolean {
    return this.state === 'failed';
  }

  /** Changes only when asynchronous art settles; presentation frames need not rebuild while requests are pending. */
  get revision(): number {
    return this.settledRevision;
  }

  private sprite(ref: EffectSpriteRef | undefined): SpriteEntry | undefined {
    if (!ref || !this.library) return undefined;
    const id = typeof ref === 'string' ? ref : ref[this.theater];
    return id ? this.library.sprites[id] : undefined;
  }

  /** Art of an anim type, or null while effects.json loads or when the type has no art. */
  anim(type: string): ResolvedAnim | null {
    if (!this.library) {
      void this.load();
      return null;
    }
    const known = this.resolved.get(type);
    if (known !== undefined) return known;
    const art = this.library.anims[type] ?? this.library.anims[type.toUpperCase()];
    const sprite = art ? this.sprite(art.sprite) : undefined;
    let result: ResolvedAnim | null = null;
    if (art && sprite?.frames.length) {
      const unit = art.palette === 'unit';
      const palette = unit
        ? this.libraryPalettes
          ? `${LIBRARY_PALETTE_PREFIX}unit`
          : `${EFFECT_PALETTE_PREFIX}unit`
        : `${EFFECT_PALETTE_PREFIX}anim`;
      result = { id: type, art, sprite, palette, remap: unit };
    } else this.missing.add(type);
    this.resolved.set(type, result);
    return result;
  }

  bullet(type: string): { art: EffectBullet; sprite?: SpriteEntry } | null {
    if (!this.library) return null;
    const known = this.resolvedBullets.get(type);
    if (known !== undefined) return known;
    const art = this.library.bullets[type] ?? this.library.bullets[type.toUpperCase()];
    const found = art ? { art, sprite: this.sprite(art.sprite) } : null;
    this.resolvedBullets.set(type, found);
    return found;
  }

  particle(type: string): { art: EffectParticle; sprite: SpriteEntry } | null {
    const art = this.library?.particles[type];
    const sprite = art ? this.sprite(art.sprite) : undefined;
    return art && sprite ? { art, sprite } : null;
  }

  overlay(type: string): { art: EffectCellArt; sprite: SpriteEntry } | null {
    const art = this.library?.overlays[type];
    const sprite = art ? this.sprite(art.sprite) : undefined;
    return art && sprite ? { art, sprite } : null;
  }

  smudge(type: string): { art: EffectCellArt; sprite: SpriteEntry } | null {
    const art = this.library?.smudges[type];
    const sprite = art ? this.sprite(art.sprite) : undefined;
    return art && sprite ? { art, sprite } : null;
  }

  /**
   * Whether a building stores ore (its ActiveAnimTwo..Four are storage levels). Unknown while effects.json loads or
   * without the sidecar: refinery-like types (a numbered ActiveAnim series) are then treated as storage buildings.
   */
  storesOre(type: string): boolean | undefined {
    return this.library ? (this.library.storageBuildings ?? []).includes(type) : undefined;
  }

  /** Rules WalkRate/IdleRate of an SHP vehicle (see shpUnits.ts). */
  shpUnitRates(type: string): { walkRate?: number; idleRate?: number } | undefined {
    return this.library?.shpUnits[type];
  }

  /** The indexed atlas page texture, or null while it loads (or if it failed). */
  page(index: number): { texture: Texture; width: number; height: number } | null {
    const state = this.pageState(index);
    return state === 'loading' ? null : state;
  }

  /**
   * The indexed atlas page: the texture, 'loading' (requested now if needed), or null when the page does not exist or
   * failed to load. A failed page is settled (callers skip its art instead of asking every frame) and requested again
   * PAGE_RETRY_SECONDS later.
   */
  pageState(index: number): { texture: Texture; width: number; height: number } | 'loading' | null {
    const ref = this.library?.spriteAtlases[index];
    if (!ref) return null;
    const entry = this.pages.get(index);
    const retry = typeof entry === 'object' && 'failedAt' in entry && seconds() - entry.failedAt > PAGE_RETRY_SECONDS;
    if (entry === undefined || retry) {
      this.pages.set(index, 'loading');
      // Single-channel R8 (the pages hold palette indices only).
      loadIndexedPage(`${this.base}/${ref.file}`, this.uploadPage ?? undefined)
        .then((texture) => {
          this.pages.set(index, { texture, width: ref.width, height: ref.height });
          this.settledRevision++;
        })
        .catch(() => {
          this.pages.set(index, { failedAt: seconds() });
          this.settledRevision++;
        });
      return 'loading';
    }
    if (entry === 'loading') return 'loading';
    if ('failedAt' in entry) return null;
    return entry;
  }

  /** Free an idle page's texture (it is loaded again on its next use); preloaded pages stay. */
  release(index: number): void {
    if (this.pinned.has(index)) return;
    const entry = this.pages.get(index);
    if (!entry || entry === 'loading' || 'failedAt' in entry) return;
    entry.texture.dispose();
    this.pages.delete(index);
  }

  /** RGBA atlas page with the same settled/failure/retry contract as pageState(), in a separate page namespace. */
  hdPageState(index: number): EffectPage | 'loading' | null {
    const ref = this.hdLibrary?.pages[index];
    if (!ref) return null;
    const entry = this.hdPages.get(index);
    const retry = typeof entry === 'object' && 'failedAt' in entry && seconds() - entry.failedAt > PAGE_RETRY_SECONDS;
    if (entry === undefined || retry) {
      this.hdPages.set(index, 'loading');
      loadHdPage(`${this.hdBase}/${ref.file}`, this.uploadPage ?? undefined)
        .then((texture) => {
          this.hdPages.set(index, { texture, width: ref.width, height: ref.height });
          this.settledRevision++;
        })
        .catch(() => {
          this.hdPages.set(index, { failedAt: seconds() });
          this.settledRevision++;
        });
      return 'loading';
    }
    if (entry === 'loading') return 'loading';
    if ('failedAt' in entry) return null;
    return entry;
  }

  /** Free an idle RGBA page; combat pages pinned by preloadHd() stay resident like the native combat pages. */
  releaseHd(index: number): void {
    if (this.hdPinned.has(index)) return;
    const entry = this.hdPages.get(index);
    if (!entry || entry === 'loading' || 'failedAt' in entry) return;
    entry.texture.dispose();
    this.hdPages.delete(index);
  }

  /** Pages whose textures are loaded now (diagnostics). */
  get loadedPages(): number {
    let n = 0;
    for (const entry of this.pages.values()) if (typeof entry === 'object' && !('failedAt' in entry)) n++;
    return n;
  }

  /**
   * Start loading the atlas pages of every anim whose id matches `anims` and of the given particle types, so the first
   * explosion or muzzle flash of a battle is not skipped while its page loads (atlas pages load on first use).
   */
  preload(anims: RegExp, particles: readonly string[] = []): number[] {
    const library = this.library;
    if (!library) return [];
    const pages = new Set<number>();
    const add = (sprite: SpriteEntry | undefined) => {
      if (sprite) for (const page of EffectArt.pagesOf(sprite)) pages.add(page);
    };
    for (const [id, anim] of Object.entries(library.anims)) if (anims.test(id)) add(this.sprite(anim.sprite));
    for (const id of particles) add(this.sprite(library.particles[id]?.sprite));
    for (const page of pages) {
      this.pinned.add(page);
      this.page(page);
    }
    return [...pages].sort((a, b) => a - b);
  }

  /** Pin and request every HD page used by matching anims after loadHd() settles, skipping empty frames. */
  preloadHd(anims: RegExp): number[] {
    if (!this.hdLibrary) return [];
    const pages = new Set<number>();
    for (const [id, anim] of Object.entries(this.hdLibrary.anims))
      if (anims.test(id)) for (const frame of anim.frames) if (frame) pages.add(frame.page);
    for (const page of pages) {
      this.hdPinned.add(page);
      this.hdPageState(page);
    }
    return [...pages].sort((a, b) => a - b);
  }

  /** A voxel model of the sidecar (debris, voxel projectiles), or null while it loads. */
  voxel(id: string): VoxelModel | null {
    const file = this.library?.voxels[id];
    if (!file) return null;
    const entry = this.voxels.get(id);
    if (entry === undefined) {
      this.voxels.set(id, 'loading');
      fetch(`${this.base}/${file}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
        .then((model: VoxelModel) => {
          this.voxels.set(id, model);
          this.settledRevision++;
        })
        .catch(() => {
          this.voxels.set(id, 'failed');
          this.settledRevision++;
        });
      return null;
    }
    return typeof entry === 'string' ? null : entry;
  }

  /**
   * Request every voxel model of the sidecar (debris pieces, voxel shells: ten files, 48 kB in the extracted
   * library), so a shell in flight or a piece of wreckage is not skipped while its file loads on first use.
   */
  preloadVoxels(): void {
    for (const id of Object.keys(this.library?.voxels ?? {})) this.voxel(id);
  }

  /** Every atlas page a sprite's frames (and shadows) sit on. */
  static pagesOf(sprite: SpriteEntry): number[] {
    const pages = new Set<number>();
    for (const f of [...sprite.frames, ...(sprite.shadows ?? [])]) if (f.rect[2] > 0) pages.add(f.page ?? 0);
    return [...pages];
  }
}

/**
 * Decode straight-alpha sRGB art without conversion. The texture owns its bitmap until upload (or disposal before
 * first use); eager renderer uploads release it immediately, just like loadIndexedPage, without a CPU pixel copy.
 */
async function loadHdPage(url: string, upload?: PageUpload): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const { width, height } = bitmap;
  const texture = new Texture(bitmap as unknown as HTMLImageElement);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  const release = () => {
    bitmap.close();
    texture.image = { width, height } as unknown as HTMLImageElement;
    texture.onUpdate = null;
    texture.removeEventListener('dispose', release);
  };
  texture.addEventListener('dispose', release);
  texture.onUpdate = release;
  texture.needsUpdate = true;
  try {
    if (upload) {
      await upload(texture);
      // initTexture may already have called onUpdate synchronously.
      texture.onUpdate?.(texture);
    }
    return texture;
  } catch (error) {
    texture.dispose();
    throw error;
  }
}

function seconds(): number {
  return performance.now() / 1000;
}
