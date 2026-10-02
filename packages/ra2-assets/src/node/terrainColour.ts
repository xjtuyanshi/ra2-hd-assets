/**
 * Colour-matched HD terrain (Node only, pure image maths): keep the HD terrain image's detail, take its low-frequency
 * colour from the original composite. AI upscaling and re-materialisation compress contrast and drift colours (bright
 * pavement came out 13 % darker and dark asphalt 37 % lighter than the original tiles on XMP29U2), which no global
 * display curve can undo without breaking every other colour.
 *
 * In CIE Lab, at the original's resolution: delta = blur(original) - blur(HD downsampled), with a Gaussian of `sigma`
 * original pixels over opaque pixels only; the output is HD + delta upsampled bilinearly. Transparent pixels are left
 * as they are.
 */
import { labToSrgb, srgbToLab } from '../mapMaterials.ts';
import type { PngImage } from './png.ts';

const OPAQUE = 128;

/** Separable Gaussian of weighted channels: out = blur(v * w) / blur(w) where blur(w) is large enough, else 0. */
function weightedBlur(
  values: Float32Array[],
  weight: Float32Array,
  width: number,
  height: number,
  sigma: number,
): void {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  for (let i = -radius; i <= radius; i++) kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const channels = [...values.map((v) => v.map((x, i) => x * weight[i]!)), weight.slice()];
  const tmp = new Float32Array(width * height);
  for (const ch of channels) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let s = 0;
        const lo = Math.max(0, x - radius);
        const hi = Math.min(width - 1, x + radius);
        for (let k = lo; k <= hi; k++) s += ch[row + k]! * kernel[k - x + radius]!;
        tmp[row + x] = s;
      }
    }
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let s = 0;
        const lo = Math.max(0, y - radius);
        const hi = Math.min(height - 1, y + radius);
        for (let k = lo; k <= hi; k++) s += tmp[k * width + x]! * kernel[k - y + radius]!;
        ch[y * width + x] = s;
      }
    }
  }
  const w = channels[channels.length - 1]!;
  const floor = 0.05 * kernel.reduce((a, b) => a + b, 0) ** 2;
  values.forEach((v, c) => {
    const blurred = channels[c]!;
    for (let i = 0; i < v.length; i++) v[i] = w[i]! > floor ? blurred[i]! / w[i]! : 0;
  });
  weight.set(w.map((x) => (x > floor ? 1 : 0)));
}

/** Lab channels (and opacity weights) of an RGBA image, area-averaged down by an integer factor. */
function labAt(
  img: PngImage,
  factor: number,
): { lab: Float32Array[]; weight: Float32Array; width: number; height: number } {
  const width = Math.floor(img.width / factor);
  const height = Math.floor(img.height / factor);
  const n = width * height;
  const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const weight = new Float32Array(n);
  const lab = [0, 0, 0];
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < width * factor; x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p + 3]! < OPAQUE) continue;
      srgbToLab(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!, lab);
      const i = Math.floor(y / factor) * width + Math.floor(x / factor);
      sum[0]![i] = sum[0]![i]! + lab[0]!;
      sum[1]![i] = sum[1]![i]! + lab[1]!;
      sum[2]![i] = sum[2]![i]! + lab[2]!;
      weight[i] = weight[i]! + 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const w = weight[i]!;
    if (!w) continue;
    for (const s of sum) s[i]! /= w;
    weight[i] = w / (factor * factor);
  }
  return { lab: sum, weight, width, height };
}

export function colourMatchTerrain(hd: PngImage, source: PngImage, sigma = 2): PngImage {
  if (hd.channels !== 4 || source.channels !== 4) throw new Error('colourMatchTerrain: RGBA images expected');
  const factor = Math.round(hd.width / source.width);
  if (
    factor < 1 ||
    Math.abs(hd.width / source.width - factor) > 1e-6 ||
    Math.abs(hd.height / source.height - factor) > 0.01
  )
    throw new Error(
      `colourMatchTerrain: HD ${hd.width}x${hd.height} is not an integer multiple of ${source.width}x${source.height}`,
    );
  const src = labAt(source, 1);
  const low = labAt(hd, factor);
  if (low.width !== src.width || low.height !== src.height) throw new Error('colourMatchTerrain: size mismatch');
  weightedBlur(src.lab, src.weight, src.width, src.height, sigma);
  weightedBlur(low.lab, low.weight, low.width, low.height, sigma);
  const { width, height } = src;
  const delta = [0, 1, 2].map((c) => {
    const d = new Float32Array(width * height);
    for (let i = 0; i < d.length; i++) d[i] = src.weight[i]! && low.weight[i]! ? src.lab[c]![i]! - low.lab[c]![i]! : 0;
    return d;
  });
  const out = new Uint8Array(hd.data);
  const lab = [0, 0, 0];
  const rgb = [0, 0, 0];
  for (let y = 0; y < hd.height; y++) {
    // Bilinear position of this HD pixel's centre in the low-resolution grid.
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < hd.width; x++) {
      const p = (y * hd.width + x) * 4;
      if (hd.data[p + 3]! < OPAQUE) continue;
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = fx - x0;
      srgbToLab(hd.data[p]!, hd.data[p + 1]!, hd.data[p + 2]!, lab);
      for (let c = 0; c < 3; c++) {
        const d = delta[c]!;
        const top = d[y0 * width + x0]! * (1 - tx) + d[y0 * width + x1]! * tx;
        const bottom = d[y1 * width + x0]! * (1 - tx) + d[y1 * width + x1]! * tx;
        lab[c] = lab[c]! + top * (1 - ty) + bottom * ty;
      }
      labToSrgb(lab[0]!, lab[1]!, lab[2]!, rgb);
      out[p] = rgb[0]!;
      out[p + 1] = rgb[1]!;
      out[p + 2] = rgb[2]!;
    }
  }
  return { width: hd.width, height: hd.height, channels: 4, data: out };
}
