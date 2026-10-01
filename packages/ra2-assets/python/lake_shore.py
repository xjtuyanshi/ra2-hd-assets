#!/usr/bin/env python3
"""Extend painted shallows into the water mask and paint a dry lake bed beneath it.

Inputs are the colour-matched classification composite, the repainted RGBA terrain
and the original grayscale water mask, all at the same 2x composite resolution.
CELL is 84 composite px per ground cell (42 engine px). Classification reaches
64 px from existing water (10 px for the neutral fringe), with HSV hue 70..262
and saturation < 0.5/value < 0.8. Morphology uses 5/9/11 px ellipse diameters;
holes < 900 px^2 are filled and components < 400 px^2 removed. The outline blur
is 3 px and the soft edge blur is 1.1 px with contrast 2.2.

Beach samples come from a 6..48 px land ring; teal cleanup reaches 90 px. Bed
colour grades from shore sand to silt over 0.08..0.8 cells, with 11 px ripples
fading by 0.9 cells and pebbles by 0.6 cells. Linear-light painting uses gamma
2.2 and deterministic noise seed 7; the tuned noise scales/amplitudes remain
beside each operation below. Alpha is retained exactly. The outputs feed
materials.json terrainMap/waterMask plus waterBed: true; no JSON is modified.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
CELL = 84.0  # Composite px per ground cell at the tuned 2x resolution.


def prepare(cls: np.ndarray, land_rgba: np.ndarray, water_mask: np.ndarray
            ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return RGBA terrain, the 8-bit soft water mask, and the binary water field for diagnostics."""
    H, W = cls.shape[:2]
    if land_rgba.shape[:2] != (H, W) or water_mask.shape != (H, W):
        raise ValueError("classification, terrain and water mask must have the same dimensions")
    m2 = water_mask.astype(np.float32) / 255
    opaque = land_rgba[..., 3] >= 128

    w0 = (m2 >= 0.5).astype(np.uint8)
    d_w0 = cv2.distanceTransform(1 - w0, cv2.DIST_L2, 5)

    blur = cv2.GaussianBlur(cls, (0, 0), 1.5)
    hsv = cv2.cvtColor(blur, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    hue = hsv[..., 0] * 360 / 256
    sat = hsv[..., 1] / 255
    val = hsv[..., 2] / 255

    # Painted shallows: teal/green-grey/blue-grey, weakly to moderately saturated, not bright. Beach sand is orange-yellow
    # (hue < 55), grass saturated yellow-green (sat > 0.5), cliffs saturated orange: all stay land.
    band = (hue >= 70) & (hue <= 262) & (sat < 0.5) & (val < 0.8) & (d_w0 <= 64)
    band |= (d_w0 <= 10) & (sat < 0.35) & (val < 0.6) & (hue >= 50)
    band &= opaque
    band = band.astype(np.uint8)
    band = cv2.morphologyEx(band, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    band = cv2.morphologyEx(band, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    joint = np.maximum(band, w0)
    n, lab = cv2.connectedComponents(joint, connectivity=8)
    keep = np.zeros(n, bool)
    keep[np.unique(lab[w0 > 0])] = True
    keep[0] = False
    water = (keep[lab] & (joint > 0)).astype(np.uint8)
    water = cv2.morphologyEx(water, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    # Fill enclosed land holes smaller than ~0.12 cells^2 and drop water specks.
    inv = 1 - water
    n, lab, st, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    small = np.zeros(n, bool)
    small[1:] = st[1:, cv2.CC_STAT_AREA] < 900
    water[small[lab] & (inv > 0)] = 1
    n, lab, st, _ = cv2.connectedComponentsWithStats(water, connectivity=8)
    tiny = np.zeros(n, bool)
    tiny[1:] = st[1:, cv2.CC_STAT_AREA] < 400
    water[tiny[lab]] = 0
    # Smooth the outline a little (pixel stairs of the band classification), then a soft 2-3 px edge.
    water = (cv2.GaussianBlur(water.astype(np.float32), (0, 0), 3.0) > 0.5).astype(np.uint8)
    soft = cv2.GaussianBlur(water.astype(np.float32), (0, 0), 1.1)
    mask = np.clip((soft - 0.5) * 2.2 + 0.5, 0, 1)
    print('water px old', int(w0.sum()), 'new', int(water.sum()))

    # ------------------------------------------------------------------------------------------------ lake bed
    rgb = land_rgba[..., :3].astype(np.float32) / 255
    lin = rgb ** 2.2
    wb = water.astype(bool)
    landm = ~wb & opaque
    d_in = cv2.distanceTransform(water, cv2.DIST_L2, 5)  # px from the waterline, over water
    d_out = cv2.distanceTransform(1 - water, cv2.DIST_L2, 5)  # px from the waterline, over land
    lhsv = cv2.cvtColor(cv2.GaussianBlur(land_rgba[..., :3], (0, 0), 1.5), cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    lh = lhsv[..., 0] * 360 / 256
    ls = lhsv[..., 1] / 255
    lv = lhsv[..., 2] / 255
    teal_land = landm & (d_out <= 90) & (((hue >= 70) & (hue <= 262) & (sat < 0.5) & (val < 0.8)) |
                                         ((lh >= 70) & (lh <= 262) & (ls < 0.45) & (lv < 0.8)))
    teal_land = cv2.dilate(teal_land.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & landm
    cliffish = (lh < 34) & (ls > 0.42) & (lv < 0.92)
    dark = lv < 0.3
    ring = landm & (d_out >= 6) & (d_out <= 48) & ~teal_land & ~cliffish & ~dark

    def fill_from(src_mask, sigmas=(4, 8, 16, 32, 64, 128, 256)):
        if not src_mask.any():
            raise ValueError("lake bed needs surrounding land samples outside the water, cliffs and dark/teal paint")
        acc = np.zeros_like(lin)
        done = np.zeros((H, W), bool)
        r = src_mask.astype(np.float32)
        for s in sigmas:
            wsum = cv2.GaussianBlur(r, (0, 0), s)
            csum = cv2.GaussianBlur(lin * r[..., None], (0, 0), s)
            ok = (wsum > 2e-3) & ~done
            acc[ok] = csum[ok] / wsum[ok, None]
            done |= ok
        acc[~done] = lin[src_mask].mean(0)
        return acc

    fill = fill_from(ring)
    # Reference beach sand: sandy land near the water.
    sandy = landm & (d_out < 240) & (lh > 28) & (lh < 55) & (ls > 0.2) & (lv > 0.55) & ~teal_land
    sand_ref = np.median(lin[sandy], 0) if sandy.sum() > 2000 else np.array([0.55, 0.42, 0.25])
    print('sand ref sRGB', (sand_ref ** (1 / 2.2) * 255).round())
    fs = np.clip(fill, 0, 1) ** (1 / 2.2)
    fh = cv2.cvtColor((fs * 255).astype(np.uint8), cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    fhue = fh[..., 0] * 360 / 256
    green = (np.clip((fhue - 52) / 16, 0, 1) * np.clip((180 - fhue) / 20, 0, 1))[..., None]
    # A bed is not green: grassy shores continue as sand under the water.
    near = fill * (1 - 0.85 * green) + sand_ref * 0.9 * (0.85 * green)
    luma = (near @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    near = luma + (near - luma) * 0.9
    silt = (np.array([92, 86, 64]) / 255.0) ** 2.2
    dc = d_in / CELL
    t = np.clip((dc - 0.08) / (0.8 - 0.08), 0, 1)
    t = (t * t * (3 - 2 * t))[..., None]
    bed = near * (1 - t) + silt * t

    rng = np.random.default_rng(7)

    def noise(sigma, amp=1.0):
        nn = cv2.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), sigma)
        return nn / (nn.std() + 1e-6) * amp

    grain = noise(0.7, 0.05) + noise(2.0, 0.04) + noise(9, 0.07) + noise(30, 0.06)
    phase = d_in / 11.0 * 2 * np.pi + noise(18, 2.2)
    ripple = np.sin(phase) * 0.07 * np.clip(1 - dc / 0.9, 0, 1) * (0.5 + 0.5 * np.clip(noise(40, 1.0), -1, 1))
    peb = noise(1.2, 1.0)
    pebbles = np.where(peb > 2.6, -0.3, 0) + np.where(peb < -2.9, 0.2, 0)
    pebbles = cv2.GaussianBlur(pebbles.astype(np.float32), (0, 0), 0.6) * np.clip(1 - dc / 0.6, 0, 1)
    mult = np.exp(grain + ripple + pebbles)[..., None]
    bed = np.clip(bed * mult, 0, 1)

    # Composite: bed under the water (a little past the soft edge so no land colour rims the waterline), and the
    # surrounding ground over the teal smears left on the sand.
    a_bed = np.clip(cv2.GaussianBlur((d_out <= 3).astype(np.float32) * 1.0, (0, 0), 1.0) + wb, 0, 1)
    land_fill = fill_from(landm & ~teal_land & ~cliffish & ~dark & (d_out >= 4), sigmas=(3, 6, 12, 24, 48, 96))
    tex = np.exp(grain * 0.8)[..., None]
    smear = cv2.GaussianBlur(teal_land.astype(np.float32), (0, 0), 2.0)[..., None]
    res = lin * (1 - smear) + np.clip(land_fill * tex, 0, 1) * smear
    res = res * (1 - a_bed[..., None]) + bed * a_bed[..., None]
    res = np.clip(res, 0, 1) ** (1 / 2.2)
    outa = land_rgba.copy()
    outa[..., :3] = np.round(res * 255).astype(np.uint8)
    return outa, np.round(mask * 255).astype(np.uint8), water


def box_arg(value: str) -> tuple[int, int, int, int]:
    try:
        box = tuple(map(int, value.split(",")))
        if len(box) != 4 or box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected x0,y0,x1,y1 with positive area") from error
    return box


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--classification", required=True, type=Path, help="colour-matched original 2x composite")
    parser.add_argument("--terrain", required=True, type=Path, help="repainted 2x terrain composite")
    parser.add_argument("--water-mask", required=True, type=Path, help="original 2x water mask")
    parser.add_argument("--output", required=True, type=Path, help="RGBA terrain containing the lake bed")
    parser.add_argument("--output-mask", required=True, type=Path, help="extended grayscale water mask")
    parser.add_argument("--debug-box", type=box_arg, help="write <output-stem>_dbg.png for x0,y0,x1,y1")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        with Image.open(args.classification) as image:
            classification = np.array(image.convert("RGB"))
        with Image.open(args.terrain) as image:
            terrain = np.array(image.convert("RGBA"))
        with Image.open(args.water_mask) as image:
            mask = np.array(image.convert("L"))
        result, mask, water = prepare(classification, terrain, mask)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output_mask.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(result).save(args.output)
        Image.fromarray(mask).save(args.output_mask)
        if args.debug_box:
            x0, y0, x1, y1 = args.debug_box
            overlay = result[y0:y1, x0:x1, :3].copy()
            edge = cv2.Canny((water[y0:y1, x0:x1] * 255).astype(np.uint8), 50, 150) > 0
            overlay[edge] = [255, 0, 255]
            debug = args.output.with_name(args.output.stem + "_dbg.png")
            Image.fromarray(np.concatenate([classification[y0:y1, x0:x1], overlay], 1)).save(debug)
        print("done", args.output, args.output_mask)
    except (OSError, ValueError, cv2.error) as error:
        print(f"lake_shore: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
