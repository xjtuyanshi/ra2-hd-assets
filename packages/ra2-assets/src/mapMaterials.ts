/**
 * Optional per-map material sidecar (contract only): `<cache>/<map>/materials.json`, written by
 * `pnpm hd:materials -- --terrain <map>` next to the map's manifest without touching it. Renderers that find it prefer
 * its files; without it they use the manifest's as before.
 */
export const MAP_MATERIALS_FILE = 'materials.json';

export interface MapMaterials {
  version: 1;
  /**
   * Replacement for manifest.terrainMap.file with the same size and layout: the HD terrain with its low-frequency
   * colour taken from the original composite (terrain-map.png), keeping the HD image's own detail.
   */
  terrainMap?: string;
  /**
   * Replacement for manifest.terrainMap.waterMask, with the same size, layout and 8-bit greyscale encoding
   * (255 = open water). Include the painted shallow band so the waterline meets the sand, not the old blue water.
   */
  waterMask?: string;
  /**
   * Same size/layout as the water mask; greyscale values >= 128 exclude land (cliff tops and walls beside water in
   * screen space) from the shoreline distance field. Ignored land stays dry; water keeps its original classification.
   */
  shoreIgnore?: string;
  /**
   * True when terrainMap paints a lake bed under the water mask (shore sand grading into deeper silt), rather than
   * painted water. Opts into transmitted/refracted bed shading only with the enhanced water style; default false.
   */
  waterBed?: boolean;
  /**
   * RGBA8 PNG covering exactly the terrain composite's area, at any resolution with the same aspect ratio
   * (typically a quarter of the composite's resolution). RGB is the sRGB apparent colour of open water: low/mid
   * frequencies from an image-model repaint of the map's water, extrapolated over land so bilinear filtering never
   * bleeds land colour into water. A is 0..1 surface roughness / sun-glitter weight (128 = neutral), carrying wind
   * patches and current streaks. Used only by the enhanced water style with waterBed.
   */
  waterDetail?: string;
  /**
   * Seamless RGBA8 tile of the open-water surface as the fixed isometric camera sees it (its x runs along the screen
   * x axis, its y down the screen), any square size, repeated over every water level in screen-aligned ground space
   * (one tile is waterSurfaceScale x waterSurfaceScale screen units of 30 engine px). Linear data, not colour:
   * R = luminance ratio of the painted chop to its local mean / 2 (0.5 = neutral),
   * G = sun-glint strength on wave crests (0..1),
   * B = surf / foam lace mask (0..1),
   * A = 1. Used only by the enhanced water style with waterBed.
   */
  waterSurface?: string;
  /** Width of one waterSurface tile in screen units of 30 engine px (default 13). */
  waterSurfaceScale?: number;
  /** How the files were made (source images, filter width), for review. */
  notes?: string;
}

/** CIE Lab (D65) of an sRGB colour given as 0..255 channels. */
export function srgbToLab(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/** sRGB 0..255 (rounded, clamped) of a CIE Lab (D65) colour. */
export function labToSrgb(L: number, a: number, b: number, out: Uint8Array | number[], o = 0): void {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fz) * 1.08883;
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  out[o] = enc(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  out[o + 1] = enc(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
  out[o + 2] = enc(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
}
