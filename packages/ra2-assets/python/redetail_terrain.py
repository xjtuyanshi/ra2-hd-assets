#!/usr/bin/env python3
"""Supersampled terrain re-detail: more surface detail than the original art, same layout and colours.

Why this exists: rematerialize.py diffuses the Real-ESRGAN 2x terrain at 2x. Real-ESRGAN first smooths the original
art's texture noise (grass, asphalt grain) away, and SDXL cannot draw features below its ~8 px latent cell, so at 2x
the result is smoother than the original. This script instead

1. upscales the scale-1 composite (terrain-map.png) 4x with Real-ESRGAN (clean edges for markings, kerbs, pavers),
2. re-adds the original art's own micro-texture (high-pass of its Lanczos 4x upscale) inside flat ground areas, so
   the diffusion model sees material texture and turns it into blades, grain and cracks instead of smoothing it,
3. runs the tiled SDXL + tile ControlNet img2img from rematerialize.py at 4x, where features are large enough,
4. area-averages back to the target scale (2x) in linear light, and
5. restores the original's low-frequency colour in CIE Lab exactly like the `hd:materials` colour match
   (terrainColour.ts: delta = blur(original) - blur(HD area-averaged to 1x), sigma in original pixels), with a much
   finer sigma on thin structures (markings, kerbs) so their colour and brightness follow the original too.

Water-mask pixels keep the base image (rematerialize.preserve_water) and alpha always comes from the base image.
With --region the processed rectangle (plus --margin) is pasted into a full-size copy of the base image with a
raised-cosine feather across the margin; without it the whole map is processed. The manifest and materials.json
are never modified: point materials.json at the output yourself after review.

Run under the shared GPU lock when other jobs use the GPU. Needs NumPy, Pillow, and for diffusion the local
diffusers venv used by rematerialize.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rematerialize as remat  # noqa: E402

# Prompts: rematerialize.py's defaults. On the XMP29U2 test tile a material-naming prompt ("lawn with grass clumps
# and blades, red brick pavers with mortar joints, asphalt with fine gravel grain and small cracks, concrete sidewalk
# slabs") measured marginally less detail and marking contrast, and does not mention the soil/dirt tiles.
DEFAULT_PROMPT = remat.DEFAULT_PROMPT
DEFAULT_NEGATIVE = remat.NEGATIVE_PROMPT


# ---------------------------------------------------------------------------------------------------------------
# Colour maths (sRGB <-> CIE Lab D65), identical constants to src/mapMaterials.ts.

def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = np.asarray(rgb, np.float32) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = c @ np.array([[0.4124564, 0.3575761, 0.1804375],
                        [0.2126729, 0.7151522, 0.0721750],
                        [0.0193339, 0.1191920, 0.9503041]], np.float32).T
    xyz /= np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    lab = np.asarray(lab, np.float32)
    fy = (lab[..., 0] + 16) / 116
    fx, fz = fy + lab[..., 1] / 500, fy - lab[..., 2] / 200

    def inv(t):
        return np.where(t ** 3 > 216 / 24389, t ** 3, (116 * t - 16) / (24389 / 27))

    xyz = np.stack([inv(fx), inv(fy), inv(fz)], -1) * np.array([0.95047, 1.0, 1.08883], np.float32)
    c = np.clip(xyz @ np.array([[3.2404542, -1.5371385, -0.4985314],
                                [-0.9692660, 1.8760108, 0.0415560],
                                [0.0556434, -0.2040259, 1.0572252]], np.float32).T, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055) * 255.0


def area_down(rgb: np.ndarray, factor: int) -> np.ndarray:
    """Integer area average in linear light (the upscale step's box filter for integer factors)."""
    c = np.asarray(rgb, np.float32)[..., :3] / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    h, w = lin.shape[0] // factor, lin.shape[1] // factor
    lin = lin[:h * factor, :w * factor].reshape(h, factor, w, factor, 3).mean((1, 3))
    s = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.rint(np.clip(s, 0, 1) * 255).astype(np.uint8)


def weighted_blur(values: np.ndarray, weight: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """blur(v * w) / blur(w) with terrainColour.ts's validity floor; returns (values, valid)."""
    num = remat.gaussian_blur(values * weight[..., None], sigma)
    den = remat.gaussian_blur(weight, sigma)
    # terrainColour.ts uses an unnormalized kernel and a floor of 0.05 * (kernel sum)^2; normalized, that is 0.05.
    valid = den > 0.05
    out = np.where(valid[..., None], num / np.maximum(den, 1e-6)[..., None], 0)
    return out.astype(np.float32), valid


def colour_match(hd_rgb: np.ndarray, source_rgba: np.ndarray, sigma: float) -> np.ndarray:
    """Port of terrainColour.ts colourMatchTerrain for one crop: returns RGB uint8 at the HD size."""
    hd = np.asarray(hd_rgb, np.float32)[..., :3]
    H, W = hd.shape[:2]
    h, w = source_rgba.shape[:2]
    factor = H // h
    if factor * h != H or factor * w != W:
        raise ValueError("HD crop must be an integer multiple of the source crop")
    opaque = (source_rgba[..., 3] >= 128).astype(np.float32)
    lab_hd = srgb_to_lab(hd)
    low = lab_hd.reshape(h, factor, w, factor, 3).mean((1, 3))
    src, sv = weighted_blur(srgb_to_lab(source_rgba[..., :3]), opaque, sigma)
    low, lv = weighted_blur(low, opaque, sigma)
    delta = np.where((sv & lv)[..., None], src - low, 0).astype(np.float32)
    fy = np.clip((np.arange(H) + 0.5) / factor - 0.5, 0, h - 1)
    fx = np.clip((np.arange(W) + 0.5) / factor - 0.5, 0, w - 1)
    y0 = np.floor(fy).astype(int); y1 = np.minimum(h - 1, y0 + 1); ty = (fy - y0)[:, None, None]
    x0 = np.floor(fx).astype(int); x1 = np.minimum(w - 1, x0 + 1); tx = (fx - x0)[None, :, None]
    up = (delta[y0][:, x0] * (1 - tx) + delta[y0][:, x1] * tx) * (1 - ty) \
        + (delta[y1][:, x0] * (1 - tx) + delta[y1][:, x1] * tx) * ty
    return np.rint(lab_to_srgb(lab_hd + up)).clip(0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------------------------------------------
# Input construction.

def box_sum(a: np.ndarray, k: int) -> np.ndarray:
    r = k // 2
    p = np.pad(np.asarray(a, np.float32), r, mode="edge")
    cs = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    h, w = a.shape
    return cs[k:k + h, k:k + w] - cs[:h, k:k + w] - cs[k:k + h, :w] + cs[:h, :w]


def flat_ground_mask(source_rgb: np.ndarray) -> np.ndarray:
    """Scale-1 mask of flat ground where the original's micro-texture is re-added.

    Generic, theater-independent rule: exclude pixels near strong structural edges of the lightly blurred original
    (lane markings, parking lines, kerbs). Those keep Real-ESRGAN's clean edges, while texture noise inside a
    material stays below the threshold after the blur. On the XMP29U2 (urban) test tile it excludes 95 % of
    lane-marking pixels and keeps 99 % of lawn, 95 % of brick, 72 % of asphalt and 48 % of the strongly textured
    sidewalk pixels.
    """
    lum = np.asarray(source_rgb, np.float32)[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    b = remat.gaussian_blur(lum, 1.0)
    gy, gx = np.gradient(b)
    edge = np.hypot(gx, gy) > 14.0
    return box_sum(edge.astype(np.float32), 3) < 0.5


def hybrid_input(esr: np.ndarray, source_rgb: np.ndarray, scale: int, alpha: float, sigma: float) -> np.ndarray:
    """Real-ESRGAN structure + alpha * high-pass(Lanczos upscale of the original) inside flat ground."""
    h, w = source_rgb.shape[:2]
    lz = np.asarray(Image.fromarray(np.ascontiguousarray(source_rgb[..., :3])).resize(
        (w * scale, h * scale), Image.LANCZOS), np.float32)
    mask = flat_ground_mask(source_rgb).repeat(scale, 0).repeat(scale, 1).astype(np.float32)
    mask = remat.gaussian_blur(mask, scale / 2)
    hp = lz - remat.gaussian_blur(lz, sigma)
    return np.rint(np.clip(np.asarray(esr, np.float32)[..., :3] + alpha * mask[..., None] * hp, 0, 255)).astype(np.uint8)


def run_esrgan(binary: Path, rgb: np.ndarray, scale: int, work: Path) -> np.ndarray:
    """Real-ESRGAN x4plus (native 4x); other scales are not supported here."""
    if scale != 4:
        raise ValueError("--gen-scale must be 4 (Real-ESRGAN x4plus native scale)")
    work.mkdir(parents=True, exist_ok=True)
    src, dst = work / "esrgan-in.png", work / "esrgan-out.png"
    Image.fromarray(np.ascontiguousarray(rgb[..., :3])).save(src)
    subprocess.run([str(binary), "-i", str(src), "-o", str(dst), "-n", "realesrgan-x4plus", "-s", "4",
                    "-m", str(binary.parent / "models")], check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    out = np.asarray(Image.open(dst).convert("RGB"))
    if out.shape[:2] != (rgb.shape[0] * 4, rgb.shape[1] * 4):
        raise ValueError(f"Real-ESRGAN returned {out.shape}; expected 4x of {rgb.shape}")
    return out


def bleed(rgba: np.ndarray) -> np.ndarray:
    return remat.fill_transparent_rgb(rgba)


def centred_tile_weights(tile: remat.Tile, blend: int) -> np.ndarray:
    """Tile weights whose cross-fade is at most `blend` pixels wide, centred in each overlap.

    rematerialize.tile_weights fades across the whole overlap. That is fine for the regular 192 px overlaps, but the
    last row/column is anchored to the image edge and can overlap its neighbour by almost a full tile; averaging two
    independent generations over that width measurably lowers fine detail (about 10 % on XMP29U2's lawn). A short,
    centred cross-fade keeps each generation intact elsewhere; the colour match afterwards hides tone differences.
    """
    def axis(length: int, before: int, after: int) -> np.ndarray:
        pos = np.arange(length, dtype=np.float32) + 0.5
        weights = np.ones(length, dtype=np.float32)
        if before:
            half = min(before, blend) / 2
            t = np.clip((pos - (before / 2 - half)) / (2 * half), 0, 1)
            weights *= 0.5 - 0.5 * np.cos(np.pi * t)
        if after:
            half = min(after, blend) / 2
            t = np.clip(((length - after / 2 + half) - pos) / (2 * half), 0, 1)
            weights *= 0.5 - 0.5 * np.cos(np.pi * t)
        return np.maximum(weights, 1e-6)

    return axis(tile.height, tile.top, tile.bottom)[:, None] * axis(tile.width, tile.left, tile.right)[None, :]


# ---------------------------------------------------------------------------------------------------------------

def parse_box(value: str) -> tuple[int, int, int, int]:
    parts = tuple(int(v) for v in value.split(","))
    if len(parts) != 4 or min(parts[:2]) < 0 or min(parts[2:]) < 1:
        raise argparse.ArgumentTypeError("expected x,y,width,height with non-negative x,y")
    return parts


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--map", required=True)
    p.add_argument("--cache", type=Path)
    p.add_argument("--models", type=Path)
    p.add_argument("--esrgan", type=Path, help="realesrgan-ncnn-vulkan binary (default: gameres/tools/realesrgan)")
    p.add_argument("--source", default="terrain-map.png", help="scale-1 original composite in the map directory")
    p.add_argument("--base", help="full-size target-scale image the result is pasted into "
                   "(default: materials.json terrainMap, else manifest terrainMap.file)")
    p.add_argument("--output", type=Path, required=True, help="output PNG (full size of --base)")
    p.add_argument("--work", type=Path, required=True, help="directory for intermediates and resumable tiles")
    p.add_argument("--region", type=parse_box, help="x,y,w,h in target-scale (base) pixels; default whole map")
    p.add_argument("--margin", type=int, default=256, help="extra processed border, feathered into the base")
    p.add_argument("--gen-scale", type=int, default=4, help="generation scale relative to the source (4)")
    p.add_argument("--hybrid-alpha", type=float, default=1.0, help="weight of the original's micro-texture")
    p.add_argument("--hybrid-sigma", type=float, default=4.0, help="high-pass sigma in generation pixels")
    p.add_argument("--strength", type=float, default=0.6)
    p.add_argument("--control", type=float, default=0.6)
    p.add_argument("--guidance", type=float, default=6.5)
    p.add_argument("--steps", type=int, default=30)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--tile", type=int, default=1024)
    p.add_argument("--overlap", type=int, default=192)
    p.add_argument("--blend", type=int, default=96,
                   help="tile cross-fade width in generation pixels, centred in each overlap (0 = whole overlap)")
    p.add_argument("--prompt", default=DEFAULT_PROMPT)
    p.add_argument("--negative-prompt", default=DEFAULT_NEGATIVE)
    p.add_argument("--color-sigma", type=float, default=2.0, help="Lab colour-match sigma in source pixels")
    p.add_argument("--structure-color-sigma", type=float, default=0.5,
                   help="finer Lab colour-match sigma (source pixels) on markings/kerbs outside flat ground; 0 = off")
    p.add_argument("--water-feather", type=float, default=3.0)
    p.add_argument("--dry-run", action="store_true", help="identity diffusion (pipeline check without a GPU)")
    return p


def run(args: argparse.Namespace) -> Path:
    cache, models = remat.resolve_paths(args.cache, args.models)
    directory = remat.map_path(cache, args.map)
    manifest = json.loads((directory / "manifest.json").read_text())
    ref = manifest.get("terrainMap") or {}
    base_name = args.base
    if not base_name:
        materials = directory / "materials.json"
        base_name = (json.loads(materials.read_text()).get("terrainMap") if materials.exists() else None) \
            or ref.get("file")
    base = np.asarray(Image.open(remat.map_path(directory, base_name)).convert("RGBA")).copy()
    source = np.asarray(Image.open(remat.map_path(directory, args.source)).convert("RGBA"))
    scale = base.shape[1] // source.shape[1]
    if scale * source.shape[1] != base.shape[1] or abs(base.shape[0] - scale * source.shape[0]) > 1:
        if not float(ref.get("scale") or 1).is_integer():
            # A composite fitted under the texture limit (terrain_scale.py) has no integer pixel grid over the source.
            raise ValueError(
                f"base {base.shape[1]}x{base.shape[0]} is fitted at fractional scale {ref['scale']}; re-detail works on "
                "an integer multiple of the source: pass --base with an integer-scale (e.g. 2x) image and fit the "
                "result with `pnpm hd:fit-terrain` (packages/ra2-assets README, 'Fitted terrain')")
        raise ValueError("base image must be an integer multiple of the source composite")
    gen = args.gen_scale
    if gen % scale:
        raise ValueError("--gen-scale must be a multiple of the base scale")
    water = None
    if ref.get("waterMask"):
        w_img = Image.open(remat.map_path(directory, ref["waterMask"]))
        if w_img.size == (base.shape[1], base.shape[0]):
            water = np.asarray(w_img.convert("L")).astype(np.float32) / 255

    H, W = base.shape[:2]
    if args.region:
        x, y, w, h = args.region
        x0, y0 = max(0, x - args.margin), max(0, y - args.margin)
        x1, y1 = min(W, x + w + args.margin), min(H, y + h + args.margin)
    else:
        x, y, w, h = 0, 0, W, H
        x0, y0, x1, y1 = 0, 0, W, H
    # Snap the processed box to whole source pixels.
    x0, y0 = x0 // scale * scale, y0 // scale * scale
    x1, y1 = -(-x1 // scale) * scale, -(-y1 // scale) * scale
    x1, y1 = min(x1, source.shape[1] * scale), min(y1, source.shape[0] * scale)
    sx0, sy0, sx1, sy1 = x0 // scale, y0 // scale, x1 // scale, y1 // scale
    work = args.work
    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    print(f"Processing base box ({x0},{y0})-({x1},{y1}) = {x1 - x0}x{y1 - y0} at scale {scale}; "
          f"generation {gen}x of source", flush=True)

    # 1. Real-ESRGAN 4x of the source crop with context padding.
    pad = 16
    px0, py0 = max(0, sx0 - pad), max(0, sy0 - pad)
    px1, py1 = min(source.shape[1], sx1 + pad), min(source.shape[0], sy1 + pad)
    src_pad = source[py0:py1, px0:px1]
    src_rgba = source[sy0:sy1, sx0:sx1]
    esr_path = work / "esrgan-crop.png"
    key = hashlib.sha256(src_pad.tobytes() + str((px0, py0, px1, py1)).encode()).hexdigest()[:16]
    if esr_path.exists() and (work / "esrgan-crop.key").exists() and (work / "esrgan-crop.key").read_text() == key:
        esr = np.asarray(Image.open(esr_path).convert("RGB"))
    else:
        t = time.perf_counter()
        binary = args.esrgan or (remat.resolve_paths(args.cache, None)[0].parent / "tools/realesrgan/realesrgan-ncnn-vulkan")
        full = run_esrgan(Path(binary), bleed(src_pad), gen, work)
        esr = full[(sy0 - py0) * gen:(sy1 - py0) * gen, (sx0 - px0) * gen:(sx1 - px0) * gen].copy()
        Image.fromarray(esr).save(esr_path)
        (work / "esrgan-crop.key").write_text(key)
        print(f"Real-ESRGAN {time.perf_counter() - t:.1f}s", flush=True)

    # 2. Hybrid input.
    hyb = hybrid_input(esr, bleed(src_rgba), gen, args.hybrid_alpha, args.hybrid_sigma)
    Image.fromarray(hyb).save(work / "input-hybrid.png")

    # 3. Tiled diffusion at generation scale (resumable per tile).
    gh, gw = hyb.shape[:2]
    alpha_gen = src_rgba[..., 3].repeat(gen, 0).repeat(gen, 1)
    rgba_gen = np.dstack([hyb, alpha_gen])
    tiles = remat.tile_layout(gw, gh, args.tile, args.overlap)
    opts = {k: getattr(args, k) for k in ("strength", "control", "guidance", "steps", "seed", "tile", "overlap",
                                          "prompt", "negative_prompt", "hybrid_alpha", "hybrid_sigma", "dry_run")}
    fp = hashlib.sha256(json.dumps(opts, sort_keys=True).encode() + hyb.tobytes()).hexdigest()[:16]
    tile_dir = work / f"tiles-{fp}"
    tile_dir.mkdir(exist_ok=True)
    (tile_dir / "job.json").write_text(json.dumps(opts, indent=1))
    acc = np.zeros((gh, gw, 3), np.float32)
    wts = np.zeros((gh, gw), np.float32)
    runner = None
    t0 = time.perf_counter()
    done = 0
    for tile in tiles:
        ys, xs = slice(tile.y, tile.y + tile.height), slice(tile.x, tile.x + tile.width)
        src = rgba_gen[ys, xs]
        if not src[..., 3].any():
            continue
        cached = tile_dir / f"{tile.index:05d}.png"
        if cached.exists():
            out = np.asarray(Image.open(cached).convert("RGB"))
        else:
            t = time.perf_counter()
            if args.dry_run:
                out = src[..., :3].copy()
            else:
                if runner is None:
                    runner = remat.DiffusionRunner(models, argparse.Namespace(
                        prompt=args.prompt, negative_prompt=args.negative_prompt, strength=args.strength,
                        steps=args.steps, guidance=args.guidance, control=args.control))
                out = runner(src, args.seed + tile.index)
            Image.fromarray(out).save(cached)
            done += 1
            eta = (time.perf_counter() - t0) / done * (len(tiles) - tile.index - 1)
            print(f"Tile {tile.index + 1}/{len(tiles)} {time.perf_counter() - t:.1f}s, ETA {eta / 60:.1f} min",
                  flush=True)
        wt = centred_tile_weights(tile, args.blend) if args.blend > 0 else remat.tile_weights(tile)
        acc[ys, xs] += out.astype(np.float32) * wt[..., None]
        wts[ys, xs] += wt
    del runner
    gen_rgb = np.where(wts[..., None] > 0, acc / np.maximum(wts, 1e-6)[..., None], hyb).astype(np.float32)
    del acc, wts
    gen_rgb = np.rint(gen_rgb).clip(0, 255).astype(np.uint8)
    Image.fromarray(gen_rgb).save(work / "generated-genscale.png")

    # 4. Back to the base scale; 5. Lab low-frequency colour from the original.
    detail = area_down(gen_rgb, gen // scale)
    matched = colour_match(detail, src_rgba, args.color_sigma).astype(np.float32)
    if args.structure_color_sigma > 0:
        # Thin structures (lane and parking lines, kerbs) are narrower than the colour-match filter, so the model's
        # tint and brightness on them survive it (parking lines came out warmer and darker than the original's).
        # Outside flat ground, take colour at a much finer scale from the original instead.
        fine = colour_match(detail, src_rgba, args.structure_color_sigma).astype(np.float32)
        flat = flat_ground_mask(bleed(src_rgba)).repeat(scale, 0).repeat(scale, 1).astype(np.float32)
        flat = remat.gaussian_blur(flat, scale / 2)[..., None]
        matched = matched * flat + fine * (1 - flat)
    crop_base = base[y0:y1, x0:x1]
    if water is not None:
        matched = remat.preserve_water(matched, crop_base[..., :3].astype(np.float32), water[y0:y1, x0:x1],
                                       args.water_feather)
    Image.fromarray(np.rint(matched).clip(0, 255).astype(np.uint8)).save(work / "region-result.png")

    # 6. Paste with a raised-cosine feather across the margin: weight 0 at the outer edge of the processed box,
    # 1 inside the requested region. Sides clipped by the image border need no feather.
    def axis_weight(lo: int, hi: int, start: int, stop: int, limit: int) -> np.ndarray:
        idx = np.arange(start, stop, dtype=np.float32) + 0.5
        t = np.ones(stop - start, np.float32)
        if start > 0:
            t = np.minimum(t, np.clip((idx - (lo - args.margin)) / max(1, args.margin), 0, 1))
        if stop < limit:
            t = np.minimum(t, np.clip((hi + args.margin - idx) / max(1, args.margin), 0, 1))
        return 0.5 - 0.5 * np.cos(np.pi * t)

    if args.region and args.margin > 0:
        feather = axis_weight(y, y + h, y0, y1, H)[:, None] * axis_weight(x, x + w, x0, x1, W)[None, :]
    else:
        feather = np.ones((y1 - y0, x1 - x0), np.float32)
    feather = feather.astype(np.float32)[..., None]
    out = base.copy()
    mixed = crop_base[..., :3].astype(np.float32) * (1 - feather) + matched * feather
    opaque = crop_base[..., 3] > 0
    region_rgb = crop_base[..., :3].copy()
    region_rgb[opaque] = np.rint(mixed[opaque]).clip(0, 255).astype(np.uint8)
    out[y0:y1, x0:x1, :3] = region_rgb
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".tmp", delete=False) as handle:
        tmp = Path(handle.name)
    Image.fromarray(out).save(tmp, format="PNG")
    tmp.chmod(0o644)  # NamedTemporaryFile creates 0600; match ordinary cache files
    tmp.replace(args.output)
    print(f"Wrote {args.output} ({time.perf_counter() - started:.1f}s total)", flush=True)
    return args.output


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        run(args)
    except (OSError, ValueError, ImportError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"redetail_terrain: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
