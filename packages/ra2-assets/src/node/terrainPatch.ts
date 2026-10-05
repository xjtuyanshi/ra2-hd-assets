/**
 * Local repair of an upscaled terrain image after its scale-1 composite changed in a few places (Node only).
 *
 * Re-running the whole-map upscale for a handful of corrected sites costs minutes per map and would discard a later
 * redraw of the terrain. This instead finds the pixels that differ between the previous and the corrected composite,
 * upscales only those places (with context) through the same steps as upscaleTerrainMap — transparent-colour bleed,
 * the player's Real-ESRGAN executable, linear-light box reduction, bilinear alpha — and feathers them into the
 * existing image. Everything away from the corrected sites keeps its bytes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { bleedTransparentRgb, downsampleLinearRgb, resizeBilinear, runBinary } from './upscale.ts';

export interface PatchRegion {
  /** Scale-1 rectangle sent to inference: the changed pixels plus growth, feather and context. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Changed scale-1 pixels inside it. */
  changed: number;
}

export interface PatchPlan {
  width: number;
  height: number;
  /** 1 where the two composites differ in any channel. */
  mask: Uint8Array;
  changed: number;
  regions: PatchRegion[];
}

export interface PatchGeometry {
  /** Scale-1 pixels around a changed pixel that are fully replaced (default 3). */
  grow?: number;
  /** Scale-1 width of the cross-fade outside the grown area (default 5). */
  feather?: number;
  /** Extra scale-1 pixels of surrounding terrain given to inference beyond the cross-fade (default 20). */
  context?: number;
}

const geometry = (g: PatchGeometry = {}): Required<PatchGeometry> => ({
  grow: g.grow ?? 3,
  feather: g.feather ?? 5,
  context: g.context ?? 20,
});

/**
 * Pixels that differ between two RGBA composites of the same size, grouped into inference rectangles. Rectangles
 * that overlap after padding are merged, so every changed pixel belongs to exactly one region.
 */
export function planTerrainPatches(before: PngImage, after: PngImage, options: PatchGeometry = {}): PatchPlan {
  if (before.channels !== 4 || after.channels !== 4) throw new Error('terrain composites must be RGBA');
  if (before.width !== after.width || before.height !== after.height)
    throw new Error(
      `terrain composites differ in size (${before.width}x${before.height} and ${after.width}x${after.height})`,
    );
  const { grow, feather, context } = geometry(options);
  const pad = grow + feather + context;
  const { width, height } = after;
  const mask = new Uint8Array(width * height);
  // Coarse blocks keep the grouping cheap; a block is the unit of adjacency, the rectangle is exact.
  const B = 16;
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  const blocks = new Int32Array(bw * bh).fill(-1);
  let changed = 0;
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    if (
      before.data[p] === after.data[p] &&
      before.data[p + 1] === after.data[p + 1] &&
      before.data[p + 2] === after.data[p + 2] &&
      before.data[p + 3] === after.data[p + 3]
    )
      continue;
    mask[i] = 1;
    changed++;
    blocks[Math.floor(Math.floor(i / width) / B) * bw + Math.floor((i % width) / B)] = -2;
  }
  // Tight bounds of the changed pixels per 8-connected group of blocks.
  const bounds: [number, number, number, number, number][] = [];
  const stack: number[] = [];
  for (let s = 0; s < blocks.length; s++) {
    if (blocks[s] !== -2) continue;
    const id = bounds.length;
    blocks[s] = id;
    stack.push(s);
    const box: [number, number, number, number, number] = [width, height, -1, -1, 0];
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % bw;
      const qy = Math.floor(q / bw);
      for (let y = qy * B; y < Math.min(height, (qy + 1) * B); y++) {
        for (let x = qx * B; x < Math.min(width, (qx + 1) * B); x++) {
          if (!mask[y * width + x]) continue;
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], y);
          box[4]++;
        }
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = qx + dx;
          const y = qy + dy;
          if (x < 0 || y < 0 || x >= bw || y >= bh || blocks[y * bw + x] !== -2) continue;
          blocks[y * bw + x] = id;
          stack.push(y * bw + x);
        }
      }
    }
    bounds.push(box);
  }
  let rects = bounds.map(([x0, y0, x1, y1, n]) => ({
    x0: Math.max(0, x0 - pad),
    y0: Math.max(0, y0 - pad),
    x1: Math.min(width, x1 + 1 + pad),
    y1: Math.min(height, y1 + 1 + pad),
    changed: n,
  }));
  for (let merged = true; merged;) {
    merged = false;
    const out: typeof rects = [];
    for (const r of rects) {
      const hit = out.find((o) => r.x0 < o.x1 && o.x0 < r.x1 && r.y0 < o.y1 && o.y0 < r.y1);
      if (!hit) {
        out.push({ ...r });
        continue;
      }
      hit.x0 = Math.min(hit.x0, r.x0);
      hit.y0 = Math.min(hit.y0, r.y0);
      hit.x1 = Math.max(hit.x1, r.x1);
      hit.y1 = Math.max(hit.y1, r.y1);
      hit.changed += r.changed;
      merged = true;
    }
    rects = out;
  }
  return {
    width,
    height,
    mask,
    changed,
    regions: rects.map((r) => ({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, changed: r.changed })),
  };
}

/**
 * Blend weight of a region at output scale, 0..1: 1 within `grow` scale-1 pixels (Chebyshev) of a changed pixel,
 * falling linearly to 0 over the next `feather` pixels. Row-major, `region.width * scale` wide.
 */
export function patchWeights(
  plan: PatchPlan,
  region: PatchRegion,
  scale: number,
  options: PatchGeometry = {},
): Float32Array {
  const { grow, feather } = geometry(options);
  const w = region.width;
  const h = region.height;
  // Chebyshev distance to the nearest changed pixel, by two chamfer sweeps (exact for this metric).
  const far = grow + feather + 1;
  const dist = new Int32Array(w * h).fill(far);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (plan.mask[(region.y + y) * plan.width + region.x + x]) dist[y * w + x] = 0;
  const relax = (i: number, x: number, y: number, dx: number, dy: number): void => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
    const d = dist[ny * w + nx]! + 1;
    if (d < dist[i]!) dist[i] = d;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      relax(i, x, y, -1, 0);
      relax(i, x, y, -1, -1);
      relax(i, x, y, 0, -1);
      relax(i, x, y, 1, -1);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      relax(i, x, y, 1, 0);
      relax(i, x, y, 1, 1);
      relax(i, x, y, 0, 1);
      relax(i, x, y, -1, 1);
    }
  const base = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = dist[i]!;
    base[i] = d <= grow ? 255 : d >= grow + feather ? 0 : Math.round((255 * (grow + feather - d)) / feather);
  }
  const big = resizeBilinear({ width: w, height: h, channels: 1, data: base }, w * scale, h * scale).data;
  const out = new Float32Array(big.length);
  for (let i = 0; i < big.length; i++) out[i] = big[i]! / 255;
  return out;
}

/**
 * Blend an upscaled region into `target` (RGBA at output scale, modified in place). `rgb` is the region at output
 * scale; `alpha` the corrected scale-1 alpha resized like the whole-map upscale does.
 *
 * With `matchTone` the patch first takes on the tones of the image it goes into: the region's unchanged surroundings
 * show the same terrain in the patch and in the target, so their two brightness distributions give a monotone curve
 * (the target's luma at the same rank) that carries the patch to the target's rendering — a redrawn image's darker
 * cliffs and its snow stay what they are. The curve moves luma only, so the patch keeps its own hue. With fewer than
 * 256 such pixels only the mean colour difference is applied.
 */
export function blendPatch(
  target: PngImage,
  region: PatchRegion,
  scale: number,
  rgb: Uint8Array,
  alpha: Uint8Array,
  weights: Float32Array,
  matchTone: boolean,
): void {
  const w = region.width * scale;
  const h = region.height * scale;
  if (rgb.length !== w * h * 3 || alpha.length !== w * h || weights.length !== w * h)
    throw new RangeError('patch buffers do not match the region size');
  const at = (x: number, y: number): number => ((region.y * scale + y) * target.width + region.x * scale + x) * 4;
  const luma = (r: number, g: number, b: number): number => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  /** Luma offset per patch luma, and a constant colour offset. */
  const lift = new Float32Array(256);
  const shift = [0, 0, 0];
  if (matchTone) {
    const from = new Float64Array(256);
    const to = new Float64Array(256);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (weights[i]! > 0) continue;
        const t = at(x, y);
        if (target.data[t + 3]! < 255 || alpha[i]! < 255) continue;
        from[luma(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)]!++;
        to[luma(target.data[t]!, target.data[t + 1]!, target.data[t + 2]!)]!++;
        for (let c = 0; c < 3; c++) sum[c]! += target.data[t + c]! - rgb[i * 3 + c]!;
        n++;
      }
    }
    if (n > 0 && n < 256) for (let c = 0; c < 3; c++) shift[c] = sum[c]! / n;
    if (n >= 256) {
      // Rank matching at bin centres; patch lumas outside the sampled range keep the offset of the nearest sample.
      let seen = 0;
      let cursor = 0;
      let below = 0;
      let first = -1;
      let last = -1;
      for (let v = 0; v < 256; v++) {
        const count = from[v]!;
        if (!count) continue;
        const rank = seen + count / 2;
        while (cursor < 255 && below + to[cursor]! < rank) below += to[cursor++]!;
        lift[v] = cursor - v;
        seen += count;
        if (first < 0) first = v;
        last = v;
      }
      for (let v = 0; v < 256; v++) {
        if (from[v]!) continue;
        if (v < first) lift[v] = lift[first]!;
        else if (v > last) lift[v] = lift[last]!;
        else {
          let lo = v;
          let hi = v;
          while (!from[lo]!) lo--;
          while (!from[hi]!) hi++;
          lift[v] = lift[lo]! + ((lift[hi]! - lift[lo]!) * (v - lo)) / (hi - lo);
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = weights[i]!;
      if (k <= 0) continue;
      const t = at(x, y);
      const up = lift[luma(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)]!;
      for (let c = 0; c < 3; c++) {
        const v = rgb[i * 3 + c]! + up + shift[c]!;
        target.data[t + c] = Math.max(0, Math.min(255, Math.round(target.data[t + c]! * (1 - k) + v * k)));
      }
      target.data[t + 3] = Math.round(target.data[t + 3]! * (1 - k) + alpha[i]! * k);
    }
  }
}

export interface TerrainPatchOptions extends PatchGeometry {
  /** Previous and corrected scale-1 composites (terrain-map.png). */
  before: string;
  after: string;
  /** Upscaled images to repair: read from `file`, written to `out` (may be the same path). */
  targets: { file: string; out: string; matchTone?: boolean }[];
  model?: string;
  /** Defaults to gameres/tools/realesrgan/realesrgan-ncnn-vulkan in this checkout. */
  bin?: string;
  modelsDir?: string;
  tile?: number;
  /** Process runner; synthetic tests inject a fake. */
  run?: (bin: string, args: string[]) => Promise<void>;
  log?: (message: string) => void;
}

export interface TerrainPatchResult {
  changed: number;
  regions: number;
  /** Scale-1 pixels sent to inference. */
  inferred: number;
  scale: number;
  /** Output files written (none when the composites are identical). */
  written: string[];
}

export async function patchUpscaledTerrain(opts: TerrainPatchOptions): Promise<TerrainPatchResult> {
  const before = decodePng(readFileSync(opts.before));
  const after = decodePng(readFileSync(opts.after));
  const plan = planTerrainPatches(before, after, opts);
  const inferred = plan.regions.reduce((n, r) => n + r.width * r.height, 0);
  if (!plan.changed) return { changed: 0, regions: 0, inferred: 0, scale: 0, written: [] };
  const model = opts.model ?? 'realesrgan-x4plus';
  if (!/^realesrgan-x4plus(?:-anime)?$/.test(model)) throw new Error(`Unsupported model ${model}`);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bin = resolve(opts.bin ?? join(repoRoot, 'gameres/tools/realesrgan/realesrgan-ncnn-vulkan'));
  const temp = mkdtempSync(join(tmpdir(), 'ra2-terrain-patch-'));
  const written: string[] = [];
  let scale = 0;
  try {
    const input = join(temp, 'in');
    const output = join(temp, 'out');
    mkdirSync(input);
    mkdirSync(output);
    const crops = plan.regions.map((r) => {
      const rgba = new Uint8Array(r.width * r.height * 4);
      for (let y = 0; y < r.height; y++) {
        const s = ((r.y + y) * after.width + r.x) * 4;
        rgba.set(after.data.subarray(s, s + r.width * 4), y * r.width * 4);
      }
      return rgba;
    });
    plan.regions.forEach((r, i) => {
      writeFileSync(
        join(input, `${i}.png`),
        encodePng({
          width: r.width,
          height: r.height,
          channels: 3,
          data: bleedTransparentRgb(crops[i]!, r.width, r.height),
        }),
      );
    });
    opts.log?.(`${plan.changed} changed px in ${plan.regions.length} regions, ${inferred} px to inference`);
    await (opts.run ?? runBinary)(bin, [
      '-i',
      input,
      '-o',
      output,
      '-n',
      model,
      '-s',
      '4',
      '-m',
      resolve(opts.modelsDir ?? join(dirname(bin), 'models')),
      '-t',
      String(opts.tile ?? 256),
      '-f',
      'png',
    ]);
    for (const target of opts.targets) {
      const image = decodePng(readFileSync(target.file));
      if (image.channels !== 4) throw new Error(`${target.file} must be RGBA`);
      scale = image.width / after.width;
      if (!Number.isInteger(scale) || scale < 1 || scale > 4 || image.height !== after.height * scale)
        throw new Error(`${target.file} is not an integer 1..4x upscale of the composite`);
      plan.regions.forEach((r, i) => {
        const file = join(output, `${i}.png`);
        if (!existsSync(file)) throw new Error(`Real-ESRGAN did not write region ${i}`);
        const big = decodePng(readFileSync(file));
        if (big.width !== r.width * 4 || big.height !== r.height * 4 || big.channels === 1)
          throw new Error(`Real-ESRGAN returned ${big.width}x${big.height} for a ${r.width}x${r.height} region`);
        let rgb = big.data;
        if (big.channels === 4) {
          rgb = new Uint8Array(big.width * big.height * 3);
          for (let p = 0; p < big.width * big.height; p++)
            for (let c = 0; c < 3; c++) rgb[p * 3 + c] = big.data[p * 4 + c]!;
        }
        if (scale !== 4) rgb = downsampleLinearRgb(rgb, big.width, big.height, r.width * scale, r.height * scale);
        const alpha = new Uint8Array(r.width * r.height);
        for (let p = 0; p < alpha.length; p++) alpha[p] = crops[i]![p * 4 + 3]!;
        const resizedAlpha = resizeBilinear(
          { width: r.width, height: r.height, channels: 1, data: alpha },
          r.width * scale,
          r.height * scale,
        ).data;
        blendPatch(image, r, scale, rgb, resizedAlpha, patchWeights(plan, r, scale, opts), target.matchTone ?? false);
      });
      mkdirSync(dirname(target.out), { recursive: true });
      writeFileSync(target.out, encodePng(image));
      written.push(target.out);
      opts.log?.(`${target.file} -> ${target.out}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { changed: plan.changed, regions: plan.regions.length, inferred, scale, written };
}
