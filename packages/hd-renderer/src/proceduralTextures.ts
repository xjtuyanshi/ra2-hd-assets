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
export function rippleField(size = WATER_TEXTURE_SIZE, seed = 11, waves = 96, spread = 1.3): RippleField {
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
    const angle = (random() * 2 - 1) * spread * (0.5 + 0.5 * random());
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
  /**
   * Like ripple, but its waves stay within about +-25 degrees of +x: long-crested chop whose crests read as strokes
   * across the wind instead of the ripple tile's cellular cross-sea (used for the fine chop of detailed water).
   */
  chop: DataTexture;
  caustics: DataTexture;
  noise: DataTexture;
}

let shared: WaterTextures | null = null;

/** The textures, built on first use and shared by every material that reads them. */
export function waterTextures(): WaterTextures {
  if (shared) return shared;
  const size = WATER_TEXTURE_SIZE;
  const pack = (ripple: RippleField): Uint8Array => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const sx = ripple.slopeX[i]!;
      const sy = ripple.slopeY[i]!;
      data[i * 4] = toByte(0.5 + sx / (2 * RIPPLE_SLOPE_RANGE));
      data[i * 4 + 1] = toByte(0.5 + sy / (2 * RIPPLE_SLOPE_RANGE));
      data[i * 4 + 2] = toByte(0.5 + ripple.height[i]! / 6);
      // Crests: high and steep points, where wind first breaks the surface into white.
      const steep = Math.hypot(sx, sy) / 2.5;
      data[i * 4 + 3] = toByte(Math.max(0, ripple.height[i]! - 1) * 0.6 + steep * 0.4);
    }
    return data;
  };
  const rippleData = pack(rippleField(size));
  const chopData = pack(rippleField(size, 17, 72, 0.45));
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
    chop: repeatTexture(chopData, size, true),
    caustics: repeatTexture(causticData, size, true),
    // The hash channel must not be filtered across mip levels; the noise is only read at scales near 1:1 or larger.
    noise: repeatTexture(noiseData, size, false),
  };
  return shared;
}

/** Candidate A: integer Fourier modes repeat over one tile; all distances below are tile fractions. */
export const OCEAN_NORMAL = {
  size: 256,
  seed: 777,
  windDegrees: 200,
  rmsSlope: 0.24,
  peakCycles: 9,
  cutoffCycles: 110,
  foamCycles: 30,
} as const;
const G = 9.81;
function fft1(re: Float32Array, im: Float32Array, n: number, off: number, stride: number, inv: boolean) {
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) {
      const a = off + i * stride,
        c = off + j * stride;
      let t = re[a]!;
      re[a] = re[c]!;
      re[c] = t;
      t = im[a]!;
      im[a] = im[c]!;
      im[c] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len,
      wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride,
          b = off + (i + k + len / 2) * stride;
        const tr = re[b]! * cr - im[b]! * ci,
          ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}
function ifft2(re: Float32Array, im: Float32Array, N: number) {
  for (let r = 0; r < N; r++) fft1(re, im, N, r * N, 1, true);
  for (let c = 0; c < N; c++) fft1(re, im, N, c, N, true);
}
// ---------- wind-wave spectrum (Pierson-Moskowitz-like in k, cos^2s spreading) ----------
function makeSpectrum(
  N: number,
  L: number,
  lambdaPeak: number,
  windDeg: number,
  spreadPow: number,
  lMin: number,
  randn: () => number,
) {
  const kp = (2 * Math.PI) / lambdaPeak,
    wd = (windDeg * Math.PI) / 180,
    wx = Math.cos(wd),
    wz = Math.sin(wd);
  const h0r = new Float32Array(N * N),
    h0i = new Float32Array(N * N),
    kx = new Float32Array(N * N),
    kz = new Float32Array(N * N),
    om = new Float32Array(N * N);
  for (let m = 0; m < N; m++)
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const ix = n < N / 2 ? n : n - N,
        iz = m < N / 2 ? m : m - N;
      const KX = (2 * Math.PI * ix) / L,
        KZ = (2 * Math.PI * iz) / L,
        k = Math.hypot(KX, KZ);
      kx[i] = KX;
      kz[i] = KZ;
      om[i] = Math.sqrt(G * k);
      const g1 = randn(),
        g2 = randn();
      if (k < 1e-6 || k > (2 * Math.PI) / lMin) continue;
      const c = (KX * wx + KZ * wz) / k;
      const D =
        0.92 * Math.pow(Math.max(0, (1 + c) * 0.5), spreadPow) + 0.08 * Math.pow(Math.max(0, (1 - c) * 0.5), spreadPow);
      const S = Math.pow(k, -4) * Math.exp(-1.25 * Math.pow(kp / k, 2)) * D;
      const a = Math.sqrt(S / 2);
      h0r[i] = g1 * a;
      h0i[i] = g2 * a;
    }
  return { N, L, h0r, h0i, kx, kz, om };
}
// fields at time t: (slopeX, slopeZ, Jacobian, height); chop = horizontal displacement factor
function synth(sp: ReturnType<typeof makeSpectrum>, t: number, chop: number, kFoam = 1e9) {
  const { N, h0r, h0i, kx, kz, om } = sp,
    n2 = N * N;
  const ar = new Float32Array(n2),
    ai = new Float32Array(n2),
    br = new Float32Array(n2),
    bi = new Float32Array(n2),
    cr = new Float32Array(n2),
    ci = new Float32Array(n2);
  for (let m = 0; m < N; m++)
    for (let n = 0; n < N; n++) {
      const i = m * N + n,
        j = ((N - m) % N) * N + ((N - n) % N);
      const co = Math.cos(om[i]! * t),
        si = -Math.sin(om[i]! * t); // e^{-iwt}: waves travel along +k (downwind)
      const hr = h0r[i]! * co - h0i[i]! * si + h0r[j]! * co - h0i[j]! * si; // h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
      const hi = h0r[i]! * si + h0i[i]! * co - (h0r[j]! * si + h0i[j]! * co);
      const KX = kx[i]!,
        KZ = kz[i]!,
        k = Math.hypot(KX, KZ) || 1;
      const sxr = -KX * hi,
        sxi = KX * hr,
        szr = -KZ * hi,
        szi = KZ * hr; // i k h
      ar[i] = sxr - szi;
      ai[i] = sxi + szr; // Sx + i Sz
      const kf = k > kFoam ? 0 : 1 / k; // whitecap Jacobian from the longer waves only
      const fxx = KX * KX * kf,
        fzz = KZ * KZ * kf,
        fxz = KX * KZ * kf;
      br[i] = fxx * hr - fzz * hi;
      bi[i] = fxx * hi + fzz * hr; // Dxx + i Dzz
      cr[i] = fxz * hr - hi;
      ci[i] = fxz * hi + hr; // Dxz + i h
    }
  ifft2(ar, ai, N);
  ifft2(br, bi, N);
  ifft2(cr, ci, N);
  const out = new Float32Array(n2 * 4);
  for (let i = 0; i < n2; i++) {
    const dxx = br[i]! * chop,
      dzz = bi[i]! * chop,
      dxz = cr[i]! * chop;
    out[i * 4] = ar[i]!;
    out[i * 4 + 1] = ai[i]!;
    out[i * 4 + 2] = (1 - dxx) * (1 - dzz) - dxz * dxz;
    out[i * 4 + 3] = ci[i]!;
  }
  return out;
}
function rmsSlope(f: Float32Array) {
  let s = 0;
  const n = f.length / 4;
  for (let i = 0; i < n; i++) s += f[i * 4]! ** 2 + f[i * 4 + 1]! ** 2;
  return Math.sqrt(s / n);
}
function scaleSpectrum(sp: ReturnType<typeof makeSpectrum>, s: number) {
  for (let i = 0; i < sp.h0r.length; i++) {
    sp.h0r[i] *= s;
    sp.h0i[i] *= s;
  }
}
function pct(f: Float32Array, ch: number, p: number) {
  const n = f.length / 4,
    a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = f[i * 4 + ch]!;
  a.sort();
  return a[Math.floor(n * p)]!;
}

/** Generate RGB tangent normals (x,z,up), A = long-wave compression. No evolving FFT or per-frame upload. */
export function oceanNormalTile(size = OCEAN_NORMAL.size, seed: number = OCEAN_NORMAL.seed): Uint8Array {
  if (size < 8 || size > 1024 || (size & (size - 1)) !== 0 || !Number.isInteger(size))
    throw new RangeError('Ocean tile size must be a power of two from 8 to 1024');
  // Match the approved prototype's LCG and Gaussian sequence exactly, without mutable global RNG state.
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const randn = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());
  const sp = makeSpectrum(
    size,
    1,
    1 / OCEAN_NORMAL.peakCycles,
    OCEAN_NORMAL.windDegrees,
    2,
    1 / OCEAN_NORMAL.cutoffCycles,
    randn,
  );
  scaleSpectrum(sp, OCEAN_NORMAL.rmsSlope / rmsSlope(synth(sp, 0, 0)));
  const field = synth(sp, 0, 0);
  // Only wavelengths longer than 26/30 m contribute to the whitecap Jacobian.
  const caps = synth(sp, 0, 1, 2 * Math.PI * OCEAN_NORMAL.foamCycles);
  const low = pct(caps, 2, 0.004)!,
    high = pct(caps, 2, 0.15)!;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const sx = field[i * 4]!,
      sz = field[i * 4 + 1]!;
    const length = Math.hypot(sx, sz, 1);
    data[i * 4] = toByte(0.5 - (sx / length) * 0.5);
    data[i * 4 + 1] = toByte(0.5 - (sz / length) * 0.5);
    data[i * 4 + 2] = toByte(0.5 + 0.5 / length);
    data[i * 4 + 3] = toByte(Math.pow(Math.max(0, Math.min(1, (high - caps[i * 4 + 2]!) / (high - low))), 0.7));
  }
  return data;
}
let sharedOceanNormal: DataTexture | undefined;
/** Lazy cache is independent of enhanced/muted textures, so their load cost and data stay unchanged. */
export function oceanNormalTexture(): DataTexture {
  return (sharedOceanNormal ??= repeatTexture(oceanNormalTile(), OCEAN_NORMAL.size, true));
}
