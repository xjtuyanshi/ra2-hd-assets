import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three/webgpu';

/**
 * Tileable procedural textures generated once on the CPU, for the enhanced water look (ra2/waterLook.ts) and the
 * enhanced effects (effects.ts: rolling smoke, heat shimmer): fetching them costs a few texture reads per pixel, where
 * the equivalent procedural noise (3D gradient and Worley noise) cost tens of hash evaluations each. Nothing here is
 * derived from game art.
 *
 *   ripple   RG = surface slope (x, y) of a wind-ripple height field, B = the height itself, A = crest sharpness
 *   caustics R = the bright web of light a rippled surface focuses on a shallow bed (Voronoi cell borders)
 *   noise    R = broad fbm (gusts, swash phase), G = medium fbm (foam breakup), B = fine fbm (foam lace), A = white hash
 */

/** Texels per side of every water texture. */
export const WATER_TEXTURE_SIZE = 256;
/** Ripple slopes are stored as 0.5 + slope / (2 * RIPPLE_SLOPE_RANGE) after normalising to unit RMS per axis. */
export const RIPPLE_SLOPE_RANGE = 3;

/** Seeded generator (mulberry32), so every build draws the same water. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RippleField {
  size: number;
  /** Slopes dh/dx, dh/dy in height units per texel, normalised to unit RMS per axis. */
  slopeX: Float32Array;
  slopeY: Float32Array;
  /** Height, normalised to unit RMS. */
  height: Float32Array;
}

/**
 * A tileable wind-ripple height field: a sum of `waves` sinusoids with integer wave vectors (so the tile repeats
 * exactly), wave numbers log-uniform between 3 and 40 cycles per tile, travelling within about +-75 degrees of +x (the
 * layer's wind axis; the shader rotates each layer), with a height spectrum falling as k^-1.8 so the long waves shape
 * the surface and the short ones carry most of the slope, like a wind sea. Slopes are exact analytic derivatives.
 */
export function rippleField(size = WATER_TEXTURE_SIZE, seed = 11, waves = 96): RippleField {
  const random = seeded(seed);
  const cosTable = new Float64Array(size);
  const sinTable = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / size);
    sinTable[i] = Math.sin((2 * Math.PI * i) / size);
  }
  const n = size * size;
  const h = new Float64Array(n);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  for (let w = 0; w < waves; w++) {
    const k = 3 * Math.pow(40 / 3, random());
    const angle = (random() * 2 - 1) * 1.3 * (0.5 + 0.5 * random());
    let kx = Math.round(k * Math.cos(angle));
    const ky = Math.round(k * Math.sin(angle));
    if (kx === 0 && ky === 0) kx = 3;
    const magnitude = Math.hypot(kx, ky);
    const amplitude = Math.pow(magnitude, -1.8) * (0.5 + random());
    const phase = random() * Math.PI * 2;
    const cp = Math.cos(phase);
    const sp = Math.sin(phase);
    // d/dx cos(2 pi (kx x + ky y) / size + phase) = -sin(...) * 2 pi kx / size
    const gx = (-amplitude * 2 * Math.PI * kx) / size;
    const gy = (-amplitude * 2 * Math.PI * ky) / size;
    const kxm = ((kx % size) + size) % size;
    const kym = ((ky % size) + size) % size;
    for (let y = 0; y < size; y++) {
      let index = (kym * y) % size;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        // cos(a + phase), sin(a + phase) from the table by angle addition.
        const c = cosTable[index]! * cp - sinTable[index]! * sp;
        const s = sinTable[index]! * cp + cosTable[index]! * sp;
        h[row + x]! += amplitude * c;
        sx[row + x]! += gx * s;
        sy[row + x]! += gy * s;
        index += kxm;
        if (index >= size) index -= size;
      }
    }
  }
  const rms = (a: Float64Array) => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) / a.length) || 1;
  const rh = rms(h);
  const rs = Math.sqrt((rms(sx) ** 2 + rms(sy) ** 2) / 2);
  return {
    size,
    height: Float32Array.from(h, (v) => v / rh),
    slopeX: Float32Array.from(sx, (v) => v / rs),
    slopeY: Float32Array.from(sy, (v) => v / rs),
  };
}

/**
 * Tileable caustic web, 0..1: bright along the borders of a jittered Voronoi tiling (small F2 - F1), falling off
 * quickly inside the cells. `cells` feature points per side; distances wrap around the tile.
 */
export function causticField(size = WATER_TEXTURE_SIZE, seed = 23, cells = 8): Float32Array {
  const random = seeded(seed);
  const points: [number, number][] = [];
  for (let i = 0; i < cells * cells; i++) points.push([random(), random()]);
  const out = new Float32Array(size * size);
  const cell = size / cells;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / cell;
      const py = (y + 0.5) / cell;
      const cx = Math.floor(px);
      const cy = Math.floor(py);
      let f1 = Infinity;
      let f2 = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const ix = cx + dx;
          const iy = cy + dy;
          const p = points[(((iy % cells) + cells) % cells) * cells + (((ix % cells) + cells) % cells)]!;
          const d = Math.hypot(ix + p[0] - px, iy + p[1] - py);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      out[y * size + x] = Math.exp(-(f2 - f1) * 4.5);
    }
  return out;
}

/** Tileable gradient noise (period `period` lattice cells over the tile), about -1..1. */
function periodicNoise(size: number, period: number, random: () => number): Float32Array {
  const gradients: [number, number][] = [];
  for (let i = 0; i < period * period; i++) {
    const a = random() * Math.PI * 2;
    gradients.push([Math.cos(a), Math.sin(a)]);
  }
  const g = (ix: number, iy: number) => gradients[(iy % period) * period + (ix % period)]!;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const out = new Float32Array(size * size);
  const scale = period / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * scale;
      const py = (y + 0.5) * scale;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const fx = px - ix;
      const fy = py - iy;
      const dot = (cx: number, cy: number) => {
        const [gx, gy] = g(ix + cx, iy + cy);
        return gx * (fx - cx) + gy * (fy - cy);
      };
      const u = fade(fx);
      const v = fade(fy);
      const a = dot(0, 0) + (dot(1, 0) - dot(0, 0)) * u;
      const b = dot(0, 1) + (dot(1, 1) - dot(0, 1)) * u;
      out[y * size + x] = (a + (b - a) * v) * 1.4;
    }
  return out;
}

/** Tileable fbm, 0..1 (octaves double the lattice period, so every octave tiles too). */
export function fbmField(size: number, period: number, octaves: number, seed: number): Float32Array {
  const random = seeded(seed);
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = periodicNoise(size, period << o, random);
    for (let i = 0; i < out.length; i++) out[i]! += layer[i]! * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, 0.5 + (0.5 * out[i]!) / total));
  return out;
}

function toByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

function repeatTexture(data: Uint8Array, size: number, mipmaps: boolean): DataTexture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = mipmaps;
  texture.needsUpdate = true;
  return texture;
}

export interface WaterTextures {
  ripple: DataTexture;
  caustics: DataTexture;
  noise: DataTexture;
}

let shared: WaterTextures | null = null;

/** The textures, built on first use and shared by every material that reads them. */
export function waterTextures(): WaterTextures {
  if (shared) return shared;
  const size = WATER_TEXTURE_SIZE;
  const ripple = rippleField(size);
  const rippleData = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const sx = ripple.slopeX[i]!;
    const sy = ripple.slopeY[i]!;
    rippleData[i * 4] = toByte(0.5 + sx / (2 * RIPPLE_SLOPE_RANGE));
    rippleData[i * 4 + 1] = toByte(0.5 + sy / (2 * RIPPLE_SLOPE_RANGE));
    rippleData[i * 4 + 2] = toByte(0.5 + ripple.height[i]! / 6);
    // Crests: high and steep points, where wind first breaks the surface into white.
    const steep = Math.hypot(sx, sy) / 2.5;
    rippleData[i * 4 + 3] = toByte(Math.max(0, ripple.height[i]! - 1) * 0.6 + steep * 0.4);
  }
  const caustic = causticField(size);
  const causticData = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = toByte(caustic[i]!);
    causticData[i * 4] = v;
    causticData[i * 4 + 1] = v;
    causticData[i * 4 + 2] = v;
    causticData[i * 4 + 3] = 255;
  }
  const broad = fbmField(size, 4, 3, 31);
  const medium = fbmField(size, 8, 3, 37);
  const fine = fbmField(size, 24, 2, 41);
  const random = seeded(43);
  const noiseData = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    noiseData[i * 4] = toByte(broad[i]!);
    noiseData[i * 4 + 1] = toByte(medium[i]!);
    noiseData[i * 4 + 2] = toByte(fine[i]!);
    noiseData[i * 4 + 3] = toByte(random());
  }
  shared = {
    ripple: repeatTexture(rippleData, size, true),
    caustics: repeatTexture(causticData, size, true),
    // The hash channel must not be filtered across mip levels; the noise is only read at scales near 1:1 or larger.
    noise: repeatTexture(noiseData, size, false),
  };
  return shared;
}
