#!/usr/bin/env python3
"""Build a waterDetail layer from a whole-map repaint and a framed colour target.

RGB is the target's linear-light shore-distance profile plus non-radial repaint
variation, encoded as sRGB. Alpha is roughness/glitter energy (0.5 neutral).
ECC registers the repaint to its input; the target is already framed by target-box.
Distances stretch y by 2 for isometric geometry. Detail dimensions round up after
division by detail-scale; coordinates retain that uniform composite-pixel scale.
The repaint transform is composite = screen * repaint-scale + repaint-offset,
with repaint-input pixels = screen * repaint-screen-scale (pixel centres).

Defaults preserve the tuned filters: 31 samples per profile bin, median 5 px,
speck excess 18 sRGB levels, near-white >150 with saturation <0.35; target water
has linear B > 1.6R and G > 1.25R, eroded 3 px. Repaint ratios clamp to 0.5..2,
fade in over 0.25..0.7 cells, and target ratios over 0.1..0.35 cells. Roughness
uses sigma 1.5 high frequencies, speck weight 25, sigma 6 aggregation, and a
0.12..1 clamp. Push-pull fills land. <out>.json records profiles and registration;
neither the source images nor materials.json are edited.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
NBINS = np.array([0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 99])
LUMA = np.array([0.2126, 0.7152, 0.0722])


def srgb_to_lin(x: np.ndarray) -> np.ndarray:
    x = x / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055) * 255


def signed_distance(mask: np.ndarray, cell_size: float) -> np.ndarray:
    """Signed cells (positive in water), with cell_size measured in stretched detail pixels."""
    if mask.ndim != 2 or not np.isfinite(cell_size) or cell_size <= 0:
        raise ValueError("distance needs a 2D mask and a positive finite cell size")
    binary = (mask > 0).astype(np.uint8)
    if not binary.any() or binary.all():
        raise ValueError("distance needs both water and non-ignored land")
    h, w = binary.shape
    big = cv2.resize(binary, (w, h * 2), interpolation=cv2.INTER_NEAREST)
    din = cv2.distanceTransform(big, cv2.DIST_L2, 5)
    dout = cv2.distanceTransform(1 - big, cv2.DIST_L2, 5)
    return cv2.resize(din - dout, (w, h), interpolation=cv2.INTER_AREA) / cell_size


def normconv(img: np.ndarray, weight: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Blur only weighted samples, returning colour and blurred sample confidence."""
    num = cv2.GaussianBlur(img * weight[..., None], (0, 0), sigma)
    if num.ndim == 2:
        num = num[..., None]
    den = cv2.GaussianBlur(weight, (0, 0), sigma)
    return num / np.maximum(den[..., None], 1e-6), den


def pushpull(img: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Fill holes from a weighted pyramid, retaining every fully valid pixel exactly."""
    if img.ndim != 3 or valid.shape != img.shape[:2]:
        raise ValueError("pushpull expects HxWxC colours and matching HxW weights")
    if not np.isfinite(valid).all() or np.any((valid < 0) | (valid > 1)) or not valid.any():
        raise ValueError("pushpull needs weights in [0, 1] with at least one valid pixel")
    levels = []
    cur = np.where(valid[..., None] > 0, img, 0) * valid[..., None]
    cw = valid.astype(np.float32)
    # Reach a populated root even for large holes or narrow images; stopping at 4 px can leave black holes.
    while max(cur.shape[:2]) > 1:
        levels.append((cur, cw))
        h, w = cur.shape[:2]
        size = (max(1, w // 2), max(1, h // 2))
        cur = cv2.resize(cur, size, interpolation=cv2.INTER_AREA)
        if cur.ndim == 2:
            cur = cur[..., None]
        cw = cv2.resize(cw, size, interpolation=cv2.INTER_AREA)
    # A sparse root may have a very small positive weight; clamping it would darken the fill.
    col = np.divide(cur, cw[..., None], out=np.zeros_like(cur), where=cw[..., None] > 0)
    for cur, cw in reversed(levels):
        h, w = cur.shape[:2]
        up = cv2.resize(col, (w, h), interpolation=cv2.INTER_LINEAR)
        if up.ndim == 2:
            up = up[..., None]
        colour = np.divide(cur, cw[..., None], out=np.zeros_like(cur), where=cw[..., None] > 0)
        a = np.clip(cw, 0, 1)[..., None]
        col = colour * a + up * (1 - a)
    return col


def profile(img_lin: np.ndarray, dist: np.ndarray, valid: np.ndarray,
            bins: np.ndarray = NBINS, min_samples: int = 31) -> np.ndarray:
    """Mean colour per shore-distance bin; fill gaps from the preceding/first populated bin."""
    bins = np.asarray(bins, dtype=float)
    if bins.ndim != 1 or len(bins) < 2 or not np.isfinite(bins).all() or np.any(np.diff(bins) <= 0):
        raise ValueError("profile bins must be finite and strictly increasing")
    if img_lin.ndim != 3 or dist.shape != img_lin.shape[:2] or valid.shape != dist.shape or min_samples < 1:
        raise ValueError("profile needs matching image/distance/mask dimensions and positive min_samples")
    prof = []
    for low, high in zip(bins[:-1], bins[1:]):
        sel = valid.astype(bool) & (dist >= low) & (dist < high)
        prof.append(img_lin[sel].mean(0) if sel.sum() >= min_samples else None)
    if all(colour is None for colour in prof):
        raise ValueError(f"profile needs at least one bin with {min_samples} valid samples")
    last = None
    for k, colour in enumerate(prof):
        if colour is None:
            prof[k] = last
        else:
            last = colour
    following = None
    for k in reversed(range(len(prof))):
        if prof[k] is None:
            prof[k] = following
        else:
            following = prof[k]
    return np.array(prof)


def interp(prof: np.ndarray, dist: np.ndarray) -> np.ndarray:
    centres = (NBINS[:-1] + np.minimum(NBINS[1:], 5)) / 2
    return np.stack([np.interp(dist, centres, prof[:, c]) for c in range(prof.shape[1])], -1)


def register(repaint: np.ndarray, reference: np.ndarray) -> tuple[np.ndarray, float, np.ndarray]:
    """ECC affine registration; a failed fit is an error, never an identity fallback."""
    if repaint.ndim != 3 or repaint.shape[-1] != 3 or repaint.shape != reference.shape:
        raise ValueError("repaint and repaint input must be RGB images with the same dimensions")
    a, i = repaint.astype(np.float32), reference.astype(np.float32)
    ga = cv2.GaussianBlur(cv2.cvtColor(a, cv2.COLOR_RGB2GRAY) / 255, (0, 0), 2)
    gi = cv2.GaussianBlur(cv2.cvtColor(i, cv2.COLOR_RGB2GRAY) / 255, (0, 0), 2)
    matrix = np.eye(2, 3, dtype=np.float32)
    score, matrix = cv2.findTransformECC(gi, ga, matrix, cv2.MOTION_AFFINE,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    aligned = cv2.warpAffine(a, matrix, (a.shape[1], a.shape[0]),
                             flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)
    return aligned, float(score), matrix


def frame_coordinates(size: tuple[int, int], detail_scale: float, scale: float,
                      offset: tuple[float, float], screen_scale: float) -> tuple[np.ndarray, np.ndarray]:
    """Map detail pixel centres through composite and screen space into repaint-input pixels."""
    u, v = np.meshgrid(np.arange(size[0]), np.arange(size[1]))
    sx = ((u + 0.5) * detail_scale - offset[0]) / scale * screen_scale - 0.5
    sy = ((v + 0.5) * detail_scale - offset[1]) / scale * screen_scale - 0.5
    return sx.astype(np.float32), sy.astype(np.float32)


def specks(linear: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    luminance = lin_to_srgb(linear @ LUMA)
    median = cv2.medianBlur(np.clip(luminance, 0, 255).astype(np.uint8), 5).astype(np.float32)
    saturation = (linear.max(-1) - linear.min(-1)) / np.maximum(linear.max(-1), 1e-4)
    return (luminance > median + 18) | ((luminance > 150) & (saturation < 0.35)), luminance


def correction_profile(correction: dict) -> np.ndarray:
    """Validate optional closed-loop RGB multipliers in the tool's shore-distance bins."""
    if not isinstance(correction, dict) or "ratio" not in correction:
        raise ValueError("correction must contain a ratio array")
    ratio = np.asarray(correction["ratio"], dtype=float)
    if ratio.shape != (len(NBINS) - 1, 3) or not np.isfinite(ratio).all() or (ratio < 0).any():
        raise ValueError(f"correction ratio must contain {len(NBINS) - 1} finite, nonnegative RGB triplets")
    if "bins" in correction and not np.array_equal(np.asarray(correction["bins"]), NBINS):
        raise ValueError("correction bins must match the water-detail profile bins")
    return ratio


def prepare(repaint: np.ndarray, repaint_input: np.ndarray, target: np.ndarray,
            water_mask: np.ndarray, shore_ignore: np.ndarray, *, composite_size: tuple[int, int],
            repaint_scale: float, repaint_offset: tuple[float, float], repaint_screen_scale: float,
            target_box: tuple[float, float, float, float], detail_scale: float = 4, gain: float = 1,
            sigma: float = 3, target_spatial: float = 0, cell_size: float = 84.85,
            target_border: float = 40, correction: dict | None = None) -> tuple[np.ndarray, dict]:
    """Build RGBA pixels and diagnostics; all framing comes from arguments or image dimensions."""
    if len(composite_size) != 2 or any(n < 1 or int(n) != n for n in composite_size):
        raise ValueError("composite size must contain positive integer dimensions")
    if any(not np.isfinite(n) or n <= 0 for n in
           (repaint_scale, repaint_screen_scale, detail_scale, sigma, cell_size, target_border)):
        raise ValueError("scales, sigma, cell size and target border must be positive and finite")
    if not np.isfinite(gain) or gain < 0 or not 0 <= target_spatial <= 1:
        raise ValueError("gain must be finite and nonnegative; target spatial must be in [0, 1]")
    if len(repaint_offset) != 2 or not np.isfinite(repaint_offset).all():
        raise ValueError("repaint offset needs two finite composite coordinates")
    if len(target_box) != 4 or not np.isfinite(target_box).all():
        raise ValueError("target box needs four finite composite coordinates")
    x0, y0, x1, y1 = target_box
    if x1 <= x0 or y1 <= y0:
        raise ValueError("target box must have positive area")
    if target.ndim != 3 or target.shape[-1] != 3 or min(target.shape[:2]) < 2:
        raise ValueError("target must be an RGB image at least 2 pixels on each axis")
    if water_mask.shape != (composite_size[1], composite_size[0]) or shore_ignore.shape != water_mask.shape:
        raise ValueError("water mask and shore ignore must match the composite size")
    cprof = correction_profile(correction) if correction is not None else None
    size = tuple(math.ceil(n / detail_scale) for n in composite_size)

    def mask_at_detail(mask):
        return np.asarray(Image.fromarray(mask).convert("L").resize(size, Image.Resampling.BILINEAR)) > 127

    water, ignore = mask_at_detail(water_mask), mask_at_detail(shore_ignore)
    sd = signed_distance(water | ignore, cell_size / detail_scale)
    aligned, score, matrix = register(repaint, repaint_input)
    sx, sy = frame_coordinates(size, detail_scale, repaint_scale, repaint_offset, repaint_screen_scale)
    ai = cv2.remap(aligned, sx, sy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    inside = (sx >= 0) & (sy >= 0) & (sx < aligned.shape[1] - 1) & (sy < aligned.shape[0] - 1)
    ail = srgb_to_lin(ai)
    speck, lum_s = specks(ail)
    core = water & inside & (sd > 0.2) & ~speck
    base, _ = normconv(ail, core.astype(np.float32), sigma)
    ai_prof = profile(base, sd, core)

    # Target dimensions are read from the image; the framing is supplied in composite pixels.
    th, tw = target.shape[:2]
    u, v = np.meshgrid(np.arange(size[0]), np.arange(size[1]))
    tx = ((u + 0.5) * detail_scale - x0) / (x1 - x0) * tw - 0.5
    ty = ((v + 0.5) * detail_scale - y0) / (y1 - y0) * th - 0.5
    tin = (tx >= 0) & (ty >= 0) & (tx < tw - 1) & (ty < th - 1)
    tl = srgb_to_lin(cv2.remap(target.astype(np.float32), tx.astype(np.float32), ty.astype(np.float32), cv2.INTER_AREA))
    tspeck, _ = specks(tl)
    # Registration is approximate: cliff/sand colours must not enter the water profile or spatial variation.
    waterlike = (tl[..., 2] > tl[..., 0] * 1.6) & (tl[..., 1] > tl[..., 0] * 1.25)
    waterlike = cv2.erode(waterlike.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    tvalid = water & tin & (sd > 0.2) & ~tspeck & waterlike
    tbase, target_weight = normconv(tl, tvalid.astype(np.float32), sigma)
    t_prof = profile(tbase, sd, tvalid)
    ai_radial, t_radial = interp(ai_prof, np.clip(sd, 0, 5)), interp(t_prof, np.clip(sd, 0, 5))
    ratio = np.clip(base / np.maximum(ai_radial, 1e-4), 0.5, 2.0)
    fade = np.clip((sd - 0.25) / 0.45, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    logr = np.log(ratio) * gain * fade[..., None]
    if target_spatial > 0:
        tratio = np.clip(tbase / np.maximum(t_radial, 1e-4), 0.5, 2.0)
        # Preserve the tuned framing-relative border scaling while allowing arbitrary target dimensions.
        edge = np.minimum.reduce([tx, ty, tw - 1 - tx, th - 1 - ty]) * (size[0] / ((x1 - x0) / detail_scale))
        border = np.clip(edge / target_border, 0, 1) * tin
        weight = (target_spatial * np.clip(target_weight * 2, 0, 1) * border)[..., None]
        tfade = np.clip((sd - 0.1) / 0.25, 0, 1)
        tfade = (tfade * tfade * (3 - 2 * tfade))[..., None]
        logr = logr * (1 - weight) + np.log(tratio) * tfade * weight
    col = t_radial * np.exp(logr)
    if cprof is not None:
        col *= interp(cprof, np.clip(sd, 0, 5))

    hf = np.abs(lum_s - cv2.GaussianBlur(lum_s, (0, 0), 1.5))
    openw = water & inside & (sd > 0.45)
    if not openw.any():
        raise ValueError("roughness needs repaint coverage of water deeper than 0.45 cells")
    energy, _ = normconv((hf + 25 * speck)[..., None], openw.astype(np.float32), 6)
    energy = energy[..., 0]
    rough = np.clip(0.5 * energy / max(energy[openw].mean(), 1e-3), 0.12, 1.0)
    valid = water & inside & (sd > 0.2)
    filled = pushpull(col, valid.astype(np.float32))
    rfill = pushpull(rough[..., None], openw.astype(np.float32))[..., 0]
    rgb = np.clip(lin_to_srgb(filled), 0, 255).astype(np.uint8)
    alpha = np.clip(rfill * 255, 0, 255).astype(np.uint8)
    report = {"gain": gain, "sigma": sigma, "target_spatial": target_spatial, "bins": NBINS.tolist(),
              "ai_profile_srgb": lin_to_srgb(ai_prof).round(1).tolist(),
              "target_profile_srgb": lin_to_srgb(t_prof).round(1).tolist(), "ecc": matrix.tolist(),
              "ecc_score": score, "composite_size": list(composite_size), "detail_scale": detail_scale,
              "cell_size": cell_size, "target_box": list(target_box), "target_border": target_border,
              "repaint_scale": repaint_scale, "repaint_offset": list(repaint_offset),
              "repaint_screen_scale": repaint_screen_scale}
    return np.dstack([rgb, alpha]), report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repaint", required=True, type=Path)
    parser.add_argument("--repaint-input", required=True, type=Path)
    transform = parser.add_argument_group("repaint transform (screen to composite)")
    transform.add_argument("--repaint-scale", required=True, type=float, help="composite pixels per screen pixel")
    transform.add_argument("--repaint-offset", required=True, nargs=2, type=float, metavar=("X", "Y"))
    transform.add_argument("--repaint-screen-scale", required=True, type=float, help="input pixels per screen pixel")
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--target-box", required=True, nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--water-mask", required=True, type=Path)
    parser.add_argument("--shore-ignore", required=True, type=Path)
    parser.add_argument("--composite-size", required=True, nargs=2, type=int, metavar=("W", "H"))
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--detail-scale", type=float, default=4, help="composite pixels per detail pixel (default: 4)")
    parser.add_argument("--gain", type=float, default=1, help="repaint non-radial variation gain (default: 1)")
    parser.add_argument("--sigma", type=float, default=3, help="normalized blur in detail pixels (default: 3)")
    parser.add_argument("--target-spatial", type=float, default=0, help="target non-radial variation weight, 0..1")
    parser.add_argument("--cell-size", type=float, default=84.85,
                        help="composite pixels per cell after stretching y by 2 (default: 84.85)")
    parser.add_argument("--target-border", type=float, default=40, help="target border fade width (default: 40)")
    parser.add_argument("--correction", type=Path, help="JSON with ratio: one RGB multiplier per shore-distance bin")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        def load(path, mode):
            with Image.open(path) as image:
                return np.array(image.convert(mode))

        correction = json.loads(args.correction.read_text(encoding="utf-8")) if args.correction else None
        rgba, report = prepare(load(args.repaint, "RGB"), load(args.repaint_input, "RGB"), load(args.target, "RGB"),
                               load(args.water_mask, "L"), load(args.shore_ignore, "L"),
                               composite_size=tuple(args.composite_size), repaint_scale=args.repaint_scale,
                               repaint_offset=tuple(args.repaint_offset), repaint_screen_scale=args.repaint_screen_scale,
                               target_box=tuple(args.target_box), detail_scale=args.detail_scale, gain=args.gain,
                               sigma=args.sigma, target_spatial=args.target_spatial, cell_size=args.cell_size,
                               target_border=args.target_border, correction=correction)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgba).save(args.out)
        Path(str(args.out) + ".json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("wrote", args.out)
    except (OSError, ValueError, cv2.error) as error:
        print(f"water_detail: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
