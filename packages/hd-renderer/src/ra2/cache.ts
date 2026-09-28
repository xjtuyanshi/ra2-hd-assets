import {
  DataTexture,
  NearestFilter,
  NoColorSpace,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  LinearFilter,
  UnsignedByteType,
  RGBAFormat,
  RedFormat,
} from 'three/webgpu';
import type { HdCacheManifest, TileEntry, VoxelModel } from '../../../ra2-assets/src/manifest';

/**
 * A loaded HD cache (see packages/ra2-assets/src/manifest.ts): decoded cell arrays plus GPU textures. The cache is
 * produced locally from the player's own game files and served from gameres/hd-cache by the sandbox dev server.
 */
export interface Ra2Cache {
  base: string;
  manifest: HdCacheManifest;
  exists: Uint8Array;
  height: Uint8Array;
  tile: Uint16Array;
  terrainAtlas: Texture;
  /** R8 mask over the terrain atlas: 1 where the original art shows open water (see buildWaterMask). */
  waterMask: DataTexture;
  /** Whole-map terrain composite (possibly AI-upscaled) and its water mask, when the cache provides one. */
  terrainMap?: { texture: DataTexture; waterMask: DataTexture; ref: NonNullable<HdCacheManifest['terrainMap']> };
  spriteAtlas: Texture;
  /** All palettes stacked into one 256xN texture; `paletteRow` maps a palette key to its row. */
  paletteAtlas: DataTexture;
  paletteRow: Map<string, number>;
  /** Raw RGB palettes (0..255) by key, for CPU-side colour resolution (voxels). */
  paletteRgb: Map<string, Uint8Array>;
  voxels: Map<string, VoxelModel>;
}

export const NO_TILE = 0xffff;

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function loadRa2Cache(base: string): Promise<Ra2Cache> {
  const url = (file: string) => `${base.replace(/\/$/, '')}/${file}`;
  const manifest = (await (await fetch(url('manifest.json'))).json()) as HdCacheManifest;
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
  const stacked = new Uint8Array(256 * keys.length * 4);
  for (const [row, key] of keys.entries()) {
    const rgb = paletteRgb.get(key)!;
    paletteRow.set(key, row);
    for (let i = 0; i < 256; i++)
      stacked.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, 255], (row * 256 + i) * 4);
  }
  const paletteAtlas = new DataTexture(stacked, 256, Math.max(1, keys.length));
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
  const ref = manifest.terrainMap;
  if (ref) {
    const { texture, original } = await loadDilated(url(ref.file));
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearFilter;
    // The composite's own water mask when present; otherwise treat nothing as water rather than guessing.
    const mask = ref.waterMask ? await loadMask(url(ref.waterMask)) : emptyMask();
    void original;
    terrainMap = { texture, waterMask: mask, ref };
  }

  return {
    base,
    manifest,
    terrainMap,
    exists: decodeBase64(manifest.cells.exists),
    height: decodeBase64(manifest.cells.height),
    tile,
    terrainAtlas,
    waterMask,
    spriteAtlas,
    paletteAtlas,
    paletteRow,
    paletteRgb,
    voxels,
  };
}

/** Palettes are 256x1 RGB(A) PNGs; decode through a canvas to get exact bytes. */
async function readPalettePng(url: string): Promise<Uint8Array> {
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
export function paletteFor(cache: Ra2Cache, palette: string, remap: boolean, owner?: string): string {
  const key = `${palette}@${owner}`;
  return remap && owner && cache.paletteRow.has(key) ? key : palette;
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
async function loadDilated(url: string): Promise<{ texture: DataTexture; original: Uint8Array }> {
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
  for (let pass = 0; pass < 10; pass++) {
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

async function loadMask(url: string): Promise<DataTexture> {
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
  return texture;
}

function emptyMask(): DataTexture {
  const texture = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}
