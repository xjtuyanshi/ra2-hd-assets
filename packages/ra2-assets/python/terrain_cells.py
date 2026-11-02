#!/usr/bin/env python3
"""Pebble/scale ("cell") texture metric for terrain re-detail (NumPy and Pillow only).

Why this exists: on temperate XMP27T8 (build 12) the first re-detail settings drew grass and sand as a field of
pebbles or scales outlined by a network of thin dark cracks. The queue's static QA passed it: colour, layout and
seams were fine, and its detail check only asks for more high-pass energy than Real-ESRGAN, which pebbles provide.
This metric looks for the two things that make the cell look and that grass blades or sand grain do not:

valley  the fraction of land pixels on a thin dark line: at sigma `VALLEY_SIGMA` the luminance Hessian has one
        strongly positive eigenvalue (a valley across the line) and a small one along it. The crack network between
        pebbles is such a line everywhere; grass blades are mostly bright strokes and fine noise below the scale.
mid     mean |G(1) - G(3)| of the luminance: blob-sized (3-8 px at 2x) structure. Pebbles and scales are blobs;
        grass blades and sand grain sit mostly below sigma 1.

Both are compared per `chunk` x `chunk` block of land with the same statistic of a reference that has the original
layout and no invented cells (the Real-ESRGAN base). A block is a "cell block" when both ratios exceed their limits.
Measured at 2x on XMP27T8 256 px source crops (Real-ESRGAN = 1.0): the pebbly re-detail had valley 1.3-3.1 and mid
1.15-1.7 on grass, sand, cliff tops, shore and pavement; settings judged clean at 1:1 stayed at or below about 1.1 on
both. The decision (fraction of cell blocks) is left to the caller (the queue's qa_map.py).
"""

from __future__ import annotations

from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rematerialize as remat  # noqa: E402
from terrain_seams import luminance  # noqa: E402

VALLEY_SIGMA = 1.2
# Valley strength threshold in 8-bit luminance per px^2 (central second difference of the sigma-1.2 blur) and the
# largest |cross eigenvalue| relative to it that still counts as a line, not a dark spot.
VALLEY_LEVEL = 5.0
VALLEY_ANISOTROPY = 0.5
VALLEY_LIMIT = 1.25  # block valley-fraction ratio vs reference above which a block may be cell texture
MID_LIMIT = 1.2  # block mid-band ratio vs reference above which a block may be cell texture
MIN_LAND = 0.6  # a block is scored when at least this fraction of it is land


def _second_differences(b: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    p = np.pad(b, 1, mode="edge")
    dxx = p[1:-1, 2:] - 2 * p[1:-1, 1:-1] + p[1:-1, :-2]
    dyy = p[2:, 1:-1] - 2 * p[1:-1, 1:-1] + p[:-2, 1:-1]
    dxy = (p[2:, 2:] - p[2:, :-2] - p[:-2, 2:] + p[:-2, :-2]) / 4
    return dxx, dyy, dxy


def valley_map(lum: np.ndarray, sigma: float = VALLEY_SIGMA) -> np.ndarray:
    """Boolean map of thin dark lines (cracks, outlines between pebbles)."""
    b = remat.gaussian_blur(np.asarray(lum, np.float32), sigma)
    dxx, dyy, dxy = _second_differences(b)
    half = (dxx + dyy) / 2
    root = np.sqrt(((dxx - dyy) / 2) ** 2 + dxy ** 2)
    big, small = half + root, half - root
    return (big > VALLEY_LEVEL) & (np.abs(small) < VALLEY_ANISOTROPY * big)


def mid_band(lum: np.ndarray) -> np.ndarray:
    lum = np.asarray(lum, np.float32)
    return np.abs(remat.gaussian_blur(lum, 1.0) - remat.gaussian_blur(lum, 3.0))


def cell_scores(result_rgb: np.ndarray, reference_rgb: np.ndarray, land: np.ndarray, chunk: int = 256,
                blocks: bool = False) -> dict:
    """Compare cell texture of `result_rgb` with `reference_rgb` (same size, RGB) on `land` (bool).

    Returns valley/mid ratios over all scored land, the number of scored blocks, the fraction of cell blocks (both
    ratios above their limits), and with `blocks=True` the per-block list (x, y, valley ratio, mid ratio).
    Works in horizontal strips of `chunk` rows with a 16 px context so whole maps fit in memory."""
    land = np.asarray(land, bool)
    h, w = land.shape
    rows = []
    tot = np.zeros(4)
    pad = 16
    for y in range(0, h - chunk + 1, chunk):
        a, b = max(0, y - pad), min(h, y + chunk + pad)
        lo = luminance(np.asarray(result_rgb[a:b])[..., :3])
        lr = luminance(np.asarray(reference_rgb[a:b])[..., :3])
        r0 = y - a
        vo, vr = valley_map(lo)[r0:r0 + chunk], valley_map(lr)[r0:r0 + chunk]
        mo, mr = mid_band(lo)[r0:r0 + chunk], mid_band(lr)[r0:r0 + chunk]
        for x in range(0, w - chunk + 1, chunk):
            m = land[y:y + chunk, x:x + chunk]
            if m.mean() < MIN_LAND:
                continue
            xs = slice(x, x + chunk)
            s = (float(vo[:, xs][m].mean()), float(vr[:, xs][m].mean()),
                 float(mo[:, xs][m].mean()), float(mr[:, xs][m].mean()))
            tot += np.array(s) * m.sum()
            # +0.005 / +0.1: keep near-empty reference blocks (open sand, still water edges) from dividing by ~0
            rows.append((x, y, (s[0] + 0.005) / (s[1] + 0.005), (s[2] + 0.1) / (s[3] + 0.1)))
    cells = [r for r in rows if r[2] > VALLEY_LIMIT and r[3] > MID_LIMIT]
    out = {
        "blocks": len(rows),
        "cell_blocks": len(cells),
        "cell_fraction": len(cells) / len(rows) if rows else 0.0,
        "valley_ratio": float((tot[0] + 1e-9) / (tot[1] + 1e-9)),
        "mid_ratio": float((tot[2] + 1e-9) / (tot[3] + 1e-9)),
        "valley_p90": float(np.percentile([r[2] for r in rows], 90)) if rows else 0.0,
        "mid_p90": float(np.percentile([r[3] for r in rows], 90)) if rows else 0.0,
    }
    if blocks:
        out["block_list"] = rows
    return out


def plant_cells(base: np.ndarray, seed: int, cell: int = 9) -> np.ndarray:
    """`base` (RGB float) with Voronoi-like cells of about `cell` px, dark outlines and lighter interiors added: a
    synthetic pebble/scale field for tests and for the QA positive control (the detector must flag it on the map)."""
    rng = np.random.default_rng(seed)
    size = base.shape[0]
    g = -(-size // cell)
    pts = (np.mgrid[0:g, 0:g].transpose(1, 2, 0) + rng.uniform(0.15, 0.85, (g, g, 2))) * cell  # jittered grid
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    gy, gx = (yy // cell).astype(int), (xx // cell).astype(int)
    best = np.full((size, size), np.inf, np.float32)
    second = np.full((size, size), np.inf, np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cy, cx = np.clip(gy + dy, 0, g - 1), np.clip(gx + dx, 0, g - 1)
            d = np.hypot(yy - pts[cy, cx, 0], xx - pts[cy, cx, 1])
            d = np.where((gy + dy == cy) & (gx + dx == cx), d, np.inf)
            second = np.where(d < best, best, np.minimum(second, d))
            best = np.minimum(best, d)
    edge = second - best  # ~0 on the cell boundary
    out = base.copy()
    out += (np.clip(edge / 4, 0, 1) * 14 - 22 * np.exp(-edge ** 2 / 2))[..., None]
    return out.clip(0, 255)
