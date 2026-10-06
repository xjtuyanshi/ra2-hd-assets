import { withDecodedPage, type PageUpload } from '../pageUpload';
import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, Texture } from 'three/webgpu';
import { fetchOptionalJson } from './cache';
import type { SpriteMaterialAtlas } from './spriteLook';

/**
 * normals.json next to a map cache's HD sprite atlas (packages/ra2-assets python/sprite_normals.py): the material atlas
 * file and the atlas it was made for.
 */
export interface SpriteMaterialsSidecar {
  version: 1;
  file: string;
  atlas: string;
  width: number;
  height: number;
  scale: number;
}

/** Library material pages retain the HD colour page identity separately from the material PNG's resolution. */
export interface LibrarySpriteMaterialsSidecar {
  version: 1;
  pages: Record<
    string,
    Omit<SpriteMaterialsSidecar, 'version'> & {
      materialWidth: number;
      materialHeight: number;
      frames: number;
    }
  >;
}

export function validateLibrarySpriteMaterials(json: unknown): LibrarySpriteMaterialsSidecar {
  const value = json as Partial<LibrarySpriteMaterialsSidecar> | null;
  if (!value || value.version !== 1 || !value.pages || typeof value.pages !== 'object' || Array.isArray(value.pages))
    throw new Error('not a version 1 library sprite material sidecar');
  for (const [page, entry] of Object.entries(value.pages)) {
    if (!/^(0|[1-9]\d*)$/.test(page)) throw new Error('invalid material page index');
    validate({ ...entry, version: 1 });
    if (typeof entry.atlas !== 'string' || !/^[\w@.-]+\.png$/.test(entry.atlas))
      throw new Error('invalid HD atlas file');
    for (const size of [entry.width, entry.height, entry.scale, entry.materialWidth, entry.materialHeight])
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error('invalid material page size or scale');
    if (!Number.isSafeInteger(entry.frames) || entry.frames < 0) throw new Error('invalid material frame count');
  }
  return value as LibrarySpriteMaterialsSidecar;
}

function validate(json: unknown): SpriteMaterialsSidecar {
  const value = json as Partial<SpriteMaterialsSidecar> | null;
  if (!value || value.version !== 1 || typeof value.file !== 'string' || !/^[\w@.-]+\.png$/.test(value.file))
    throw new Error('not a version 1 sprite material sidecar');
  if (!(Number(value.width) > 0 && Number(value.height) > 0)) throw new Error('missing atlas size');
  return value as SpriteMaterialsSidecar;
}

/**
 * Load the optional sprite material atlas of a map cache (normals.json + its PNG). Absent (or made for an atlas of
 * another size) resolves to null and sprites keep exactly their original shading; the file is data, so it is decoded
 * without colour conversion or premultiplied alpha (alpha 0 marks "no data").
 */
export async function loadSpriteMaterials(
  base: string,
  hdAtlas: { width: number; height: number } | null,
): Promise<SpriteMaterialAtlas | null> {
  const root = base.replace(/\/$/, '');
  const sidecar = await fetchOptionalJson(`${root}/normals.json`, validate);
  if (!sidecar) return null;
  if (!hdAtlas || hdAtlas.width !== sidecar.width || hdAtlas.height !== sidecar.height) {
    console.warn(`${root}/normals.json: made for a ${sidecar.width}x${sidecar.height} atlas, ignored`);
    return null;
  }
  return loadSpriteMaterialAtlas(`${root}/${sidecar.file}`);
}

/**
 * Decode material data identically for map atlases and lazily loaded library pages. Like loadHdTexture (cache.ts),
 * the texture owns the decoded bitmap only until its upload (or disposal before first use) and keeps the dimensions
 * afterwards: a page is immutable, and a decoded 8192 x 8096 page is 253 MiB that used to stay in memory for as long
 * as its texture lived. `upload` (the view's PageUploader) uploads before the page is handed out, outside the frame
 * that first draws it.
 */
export async function loadSpriteMaterialAtlas(url: string, upload?: PageUpload): Promise<SpriteMaterialAtlas | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Decoded inside the upload's gate: the page exists decoded only from here until its upload is through.
    return await withDecodedPage(await response.blob(), upload, async (bitmap) => {
      const { width, height } = bitmap;
      const texture = new Texture(bitmap);
      texture.flipY = false;
      texture.colorSpace = NoColorSpace;
      texture.premultiplyAlpha = false;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      const release = () => {
        bitmap.close();
        texture.image = { width, height } as unknown as ImageBitmap;
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
      return { texture };
    });
  } catch (error) {
    console.warn(`${url}: failed to load`, error);
    return null;
  }
}
