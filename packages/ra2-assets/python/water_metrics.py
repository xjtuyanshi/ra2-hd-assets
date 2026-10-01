#!/usr/bin/env python3
"""Measure water colour, shore falloff, spatial bands, and highlight coverage.

Consolidates shoreprof.py, scale.py, and glintdist.py without changing their
thresholds, distance bins, Gaussian sigmas, or reported precision. RGB inputs
are uint8 sRGB arrays. Measurement functions resize to SIZE with LANCZOS;
segment and shore_distance preserve the supplied dimensions.

Examples::

    python3 water_metrics.py profile image.png other.png
    python3 water_metrics.py bands image.png
    python3 water_metrics.py highlights image.png
    python3 water_metrics.py box 400,300,900,700 image.png

The CLI prints one JSON object per image: {"image": path, "metrics": result}.
Undefined colour means (empty percentile selections) are represented by null.
Profile/band measurements require open water more than 1.2 cells from shore;
profiles also require at least one populated bin in the first 0.3 cells.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

SIZE = (1680, 1050)
CELL = 52.0
BINS = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0, 1.3, 1.7, 2.2, 3.0, 99]
HIGHLIGHT_BINS = [0.15, 0.4, 0.8, 1.2, 2.0, 3.0, 99]


def _validate_rgb(rgb: np.ndarray) -> np.ndarray:
    """Require uint8 RGB so OpenCV uses the scratch scripts' Lab encoding."""
    rgb = np.asarray(rgb)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or min(rgb.shape[:2]) < 1 or rgb.dtype != np.uint8:
        raise ValueError("rgb must be a nonempty HxWx3 uint8 array")
    return rgb


def _resize_rgb(rgb: np.ndarray) -> np.ndarray:
    """Normalize the framing before applying pixel-scale measurements."""
    rgb = _validate_rgb(rgb)
    if rgb.shape[:2] == (SIZE[1], SIZE[0]):
        return rgb
    return np.asarray(Image.fromarray(rgb).resize(SIZE, Image.Resampling.LANCZOS))


def segment(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return an HxW bool water mask, float L* (0..100), and encoded float Lab.

    Each image supplies its own mask: blue pixels seed water, adjacent neutral
    foam joins it, morphology removes gaps/noise, and components of 4000 pixels
    or less are dropped. Lab a*/b* are stored with OpenCV's offset of 128.
    This function does not resize or modify the input.
    """
    rgb = _validate_rgb(rgb)
    f = rgb.astype(np.int32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    L = lab[..., 0] * 100 / 255
    chroma = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128)
    water = (b > r + 6) & (b * 10 > g * 7)
    foam = (L > 70) & (chroma < 16)
    m = water.astype(np.uint8)
    # Foam counts as water only next to water.
    near = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 9)))
    m = (m | (foam & (near > 0))).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 5)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 7)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] > 4000
    return keep[labels], L, lab


def shore_distance(water_mask: np.ndarray, cell: float = CELL) -> np.ndarray:
    """Return shore distance in cells, stretching y by two for the 2:1 view.

    Nearest-neighbour stretching precedes the L2/5 distance transform; area
    resampling restores the original HxW dimensions before division by cell.
    """
    water_mask = np.asarray(water_mask)
    if water_mask.ndim != 2 or min(water_mask.shape) < 1:
        raise ValueError("water_mask must be a nonempty HxW array")
    if not np.isfinite(cell) or cell <= 0:
        raise ValueError("cell must be finite and positive")
    h, w = water_mask.shape
    big = cv2.resize(water_mask.astype(np.uint8), (w, h * 2), interpolation=cv2.INTER_NEAREST)
    return cv2.resize(cv2.distanceTransform(big, cv2.DIST_L2, 5), (w, h),
                      interpolation=cv2.INTER_AREA) / cell


def _mean_rgb(pixels: np.ndarray, integers: bool = False) -> list | None:
    """Return an RGB mean, or None when strict percentile ties leave no pixels."""
    if not len(pixels):
        return None
    return [int(x) if integers else float(x) for x in pixels.mean(0)]


def shore_profile(rgb: np.ndarray) -> dict:
    """Return the scratch shore profile and open-water/surf summary fields.

    profile entries use BINS, require 50 pixels, and contain d, rgb, L, C, n;
    unpopulated entries are None. RGB/L are median-filtered with kernel 5 while
    chroma and open percentiles use the original pixels. shallowWidth is the
    first bin's upper bound below the shore/open half-light level. Cyan sheen
    is open L* > median+12 with a* < 0 or b* < 0; surf white is L* > 75,
    chroma < 18 within 0.6 cells. Field names/rounding match shoreprof.py.
    """
    rgb = _resize_rgb(rgb)
    w, L, lab = segment(rgb)
    d = shore_distance(w)
    med = cv2.medianBlur(rgb, 5).astype(np.float32)
    medL = cv2.medianBlur((L * 2.55).astype(np.uint8), 5).astype(np.float32) / 2.55
    a, b = lab[..., 1] - 128, lab[..., 2] - 128
    chroma = np.hypot(a, b)
    profile = []
    for lo, hi in zip(BINS[:-1], BINS[1:]):
        mask = w & (d > lo) & (d <= hi)
        if mask.sum() < 50:
            profile.append(None)
            continue
        profile.append({"d": f"{lo}-{hi}", "rgb": [int(x) for x in med[mask].mean(0)],
                        "L": round(float(medL[mask].mean()), 1),
                        "C": round(float(chroma[mask].mean()), 1), "n": int(mask.sum())})
    openm = w & (d > 1.2)
    if not openm.any():
        raise ValueError("shore_profile requires open water beyond 1.2 cells")
    peaks = [p["L"] for p in profile[:3] if p]
    if not peaks:
        raise ValueError("shore_profile requires populated shore bins within 0.3 cells")
    v = L[openm]
    median = float(np.median(v))
    peak = max(peaks)
    floor = float(medL[openm].mean())
    half = (peak + floor) / 2
    width = None
    for p, hi in zip(profile, BINS[1:]):
        if p and p["L"] < half:
            width = hi
            break
    sheen = (L > median + 12) & ((a < 0) | (b < 0)) & openm
    top = v > np.percentile(v, 95)
    surfm = w & (d < 0.6)
    white = (L > 75) & (chroma < 18)
    return {
        "waterPct": round(float(w.mean() * 100), 1),
        "shallowPeakL": round(peak, 1), "openMeanL": round(floor, 1), "shallowWidth": width,
        "openLpct[5,25,50,75,95,99]": [round(float(x), 1) for x in np.percentile(v, [5, 25, 50, 75, 95, 99])],
        "open>med+10/20/30": [round(float((v > median + t).mean() * 100), 2) for t in (10, 20, 30)],
        "openCyanSheenPct": round(float(sheen.sum() / openm.sum() * 100), 2),
        "openTop5rgb": _mean_rgb(rgb[openm][top], integers=True),
        "openMeanRgb": _mean_rgb(rgb[openm], integers=True),
        "surfWhitePct": round(float((white & surfm).sum() / max(surfm.sum(), 1) * 100), 2),
        "profile": profile,
    }


def band_structure(rgb: np.ndarray) -> dict:
    """Return bands, vert/horiz grad, meanRGB, and p95-p50 for open water.

    bands contains fine/wave/mid/broad L* standard deviations for Gaussian
    sigma pairs (0,1.5), (1.5,4), (4,12), (12,40). Missing water is filled by a
    sigma-20 weighted local mean to limit edge leakage. The gradient ratio is
    mean(gy**2)/max(mean(gx**2),1e-6), using Sobel on sigma-1 minus sigma-4 L*.
    Band deviations and ratio retain two decimals; p95-p50 retains one.
    """
    rgb = _resize_rgb(rgb)
    w, L, _ = segment(rgb)
    m = shore_distance(w) > 1.2
    if not m.any():
        raise ValueError("band_structure requires open water beyond 1.2 cells")
    Lf = L.astype(np.float32)
    fill = cv2.GaussianBlur(np.where(m, Lf, 0), (0, 0), 20) / np.maximum(
        cv2.GaussianBlur(m.astype(np.float32), (0, 0), 20), 1e-3)
    X = np.where(m, Lf, fill)

    def g(sigma: float) -> np.ndarray:
        return cv2.GaussianBlur(X, (0, 0), sigma) if sigma > 0 else X

    bands = {}
    for name, (a, b) in {"fine": (0, 1.5), "wave": (1.5, 4), "mid": (4, 12), "broad": (12, 40)}.items():
        bp = g(a) - g(b)
        bands[name] = round(float(bp[m].std()), 2)
    wave = g(1.0) - g(4)
    gx = cv2.Sobel(wave, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(wave, cv2.CV_32F, 0, 1)
    ratio = float((gy[m] ** 2).mean() / max((gx[m] ** 2).mean(), 1e-6))
    return {"bands": bands, "vert/horiz grad": round(ratio, 2),
            "meanRGB": [int(v) for v in rgb[m].mean(0)],
            "p95-p50": round(float(np.percentile(Lf[m], 95) - np.percentile(Lf[m], 50)), 1)}


def highlight_distribution(rgb: np.ndarray) -> list[dict]:
    """Return d, hi, warm, blue percentages per HIGHLIGHT_BINS interval.

    hi is L* > the sigma-25 water-weighted local mean + 12. warm is hi with
    b* > 0 or chroma < 10; blue is hi with b* < -5. These are shares of all
    water pixels in each (lo, hi] bin, rounded to one decimal, as glintdist.py
    printed them. Empty bins have zero shares.
    """
    rgb = _resize_rgb(rgb)
    w, L, lab = segment(rgb)
    d = shore_distance(w)
    Lf = L.astype(np.float32)
    mf = w.astype(np.float32)
    local = cv2.GaussianBlur(Lf * mf, (0, 0), 25) / np.maximum(
        cv2.GaussianBlur(mf, (0, 0), 25), 1e-3)
    hi = (Lf > local + 12) & w
    a, b = lab[..., 1] - 128, lab[..., 2] - 128
    warm = hi & ((b > 0) | (np.hypot(a, b) < 10))
    blue = hi & (b < -5)
    rows = []
    for lo, up in zip(HIGHLIGHT_BINS[:-1], HIGHLIGHT_BINS[1:]):
        s = (d > lo) & (d <= up) & w
        n = max(s.sum(), 1)
        rows.append({"d": f"{lo}-{up}", "hi": round(float(100 * hi[s].sum() / n), 1),
                     "warm": round(float(100 * warm[s].sum() / n), 1),
                     "blue": round(float(100 * blue[s].sum() / n), 1)})
    return rows


def box_crest_trough(rgb: np.ndarray, box: tuple[int, int, int, int]) -> dict:
    """Return mean, trough, crest RGB means in a box at 1680x1050 framing.

    Coordinates are (x0,y0,x1,y1), with exclusive upper edges. Resize the whole
    image using LANCZOS before cropping. Rank pixels by arithmetic channel
    mean: trough uses values strictly below p30; crest uses p85..p97 inclusive.
    Return unrounded RGB floats, or None for an empty percentile selection.
    """
    if len(box) != 4 or not all(isinstance(v, (int, np.integer)) for v in box):
        raise ValueError("box must contain four integer coordinates")
    x0, y0, x1, y1 = box
    if not (0 <= x0 < x1 <= SIZE[0] and 0 <= y0 < y1 <= SIZE[1]):
        raise ValueError("box must be nonempty and within 1680x1050")
    pixels = _resize_rgb(rgb)[y0:y1, x0:x1].reshape(-1, 3)
    channel_mean = pixels.mean(1)
    p30, p85, p97 = np.percentile(channel_mean, [30, 85, 97])
    return {"mean": _mean_rgb(pixels), "trough": _mean_rgb(pixels[channel_mean < p30]),
            "crest": _mean_rgb(pixels[(channel_mean >= p85) & (channel_mean <= p97)])}


def _parse_box(value: str) -> tuple[int, int, int, int]:
    """Parse CLI box coordinates without treating them as an image path."""
    try:
        box = tuple(int(v) for v in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("box must be x0,y0,x1,y1 integers") from error
    if len(box) != 4:
        raise argparse.ArgumentTypeError("box must be x0,y0,x1,y1 integers")
    return box


def main(argv: list[str] | None = None) -> int:
    """Read images, print one JSON line per image, and return an exit status."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("profile", "bands", "highlights", "box"):
        command = commands.add_parser(name)
        if name == "box":
            command.add_argument("box", type=_parse_box, metavar="x0,y0,x1,y1")
        command.add_argument("images", nargs="+", type=Path)
    args = parser.parse_args(argv)
    measure = {"profile": shore_profile, "bands": band_structure, "highlights": highlight_distribution}
    try:
        for path in args.images:
            with Image.open(path) as image:
                rgb = np.asarray(image.convert("RGB").resize(SIZE, Image.Resampling.LANCZOS))
            result = box_crest_trough(rgb, args.box) if args.command == "box" else measure[args.command](rgb)
            print(json.dumps({"image": str(path), "metrics": result}, allow_nan=False))
    except (OSError, ValueError, cv2.error) as error:
        print(f"water_metrics: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
