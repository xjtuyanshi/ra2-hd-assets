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
  try {
    const response = await fetch(`${root}/${sidecar.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = NoColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return { texture };
  } catch (error) {
    console.warn(`${root}/${sidecar.file}: failed to load`, error);
    return null;
  }
}
