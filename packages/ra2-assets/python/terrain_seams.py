#!/usr/bin/env python3
"""Seam metric for tiled or banded terrain re-detail (NumPy and Pillow only).

Why this exists: the first queue QA measured column/row spikes of the per-pixel gradient of |re-detail - ESRGAN|,
averaged over whole columns with transparent and water pixels set to zero. On XMP32S8 (build 12) that metric failed a
seam-free map and passed planted seams:

* its largest spikes sat in the outermost 600 px, where the cell staircase of the map border switches whole runs of
  pixels between "zeroed" and "difference ~8" every 60 px (col 1.85 at x 26, row 2.22 at y 6604);
* in open snow the original tiles carry a faint once-per-cell row feature that the re-detail reproduces and ESRGAN
  smooths away, so |re-detail - ESRGAN| spikes every 60 rows (row 1.82 at y 211) although nothing is wrong;
* planted tone steps of 2 levels every 416 px, a 4 px blurred line every 416 rows, or a 1.5 level band step all
  scored only 1.1-1.2, because one pixel's gradient of the textured difference is dominated by texture.

This metric instead compares the re-detail with a seam-free reference that has the original's content (the
edge-bled scale-1 composite upscaled with Lanczos), on eroded land only, and looks for the two ways tiled diffusion
shows a seam:

tone    per chunk of `chunk` rows, |mean(D) right - mean(D) left| over `half` px on each side of every column
        boundary (D = luminance of the re-detail minus the reference), averaged over the chunks where both windows are
        land. Tone drift between independently generated tiles or bands appears as a step at the same column in many
        chunks; texture noise averages out.
detail  mean high-pass energy of the re-detail in a 2*`line` px line at each boundary. A cross-fade between two
        independent generations, or a pasted band edge, lowers (or raises) fine detail in a thin line.

Both profiles are divided by the median of the same profile 12-48 px away on both sides (the tone profile by at
least TONE_FLOOR); the detail ratio is also inverted so that a dip scores like a peak. Rows are the same computation on
the transposed images. Boundaries with fewer than `min_chunks` usable chunks (map corners, mostly water) are not
scored. Measured numbers are in the queue QA notes (build 12, XMP32S8); planted seams of the kinds above fail against
the queue's unchanged limit of 1.8.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
# Smallest neighbourhood tone-step level (8-bit luminance) a peak is compared with. In very uniform ground (open snow)
# the neighbourhood median falls to ~0.2 and the once-per-cell structure of the original tiles, which no upscaler
# reproduces pixel-exactly, then scores 2.5-3.6 for Real-ESRGAN itself (XMP32S8, columns every 60 px near the border)
# at an absolute step of only ~0.7 levels. With the floor a peak must reach 0.9 levels (1.8 x 0.5) to fail, below
# which a straight luminance step is not visible on 8-bit terrain; planted 1-1.5 level tile/band steps still fail.
TONE_FLOOR = 0.5


def bleed_rgb(rgba: np.ndarray, iterations: int = 24) -> np.ndarray:
    """RGB with transparent pixels filled from their opaque neighbours, so a resampling filter does not pull the
    transparent colour (black) into the map border."""
    rgb = np.asarray(rgba, np.float32)[..., :3].copy()
    known = np.asarray(rgba)[..., 3] > 0
    if not known.any():
        return rgb
    fill = rgb[known].mean(0)
    for _ in range(iterations):
        if known.all():
            break
        total = np.zeros_like(rgb)
        count = np.zeros(known.shape, np.float32)
        for target, source in (((slice(1, None), slice(None)), (slice(None, -1), slice(None))),
                               ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
                               ((slice(None), slice(1, None)), (slice(None), slice(None, -1))),
                               ((slice(None), slice(None, -1)), (slice(None), slice(1, None)))):
            valid = known[source]
            total[target] += rgb[source] * valid[..., None]
            count[target] += valid
        grow = (~known) & (count > 0)
        rgb[grow] = total[grow] / count[grow][:, None]
        known = known | grow
    rgb[~known] = fill
    return rgb


def lanczos_up(rgba: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Edge-bled RGB of a scale-1 image resized to `size` (width, height) with Lanczos, float32."""
    rgb = np.rint(bleed_rgb(rgba)).clip(0, 255).astype(np.uint8)
    return np.asarray(Image.fromarray(rgb).resize(size, Image.LANCZOS), np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return np.asarray(rgb, np.float32)[..., :3] @ LUMA


def binomial_blur(lum: np.ndarray) -> np.ndarray:
    """3x3 binomial blur (edge-clamped): a cheap sigma ~0.7 low-pass for the detail-energy image."""
    p = np.pad(np.asarray(lum, np.float32), 1, mode="edge")
    h = p[:, :-2] * 0.25 + p[:, 1:-1] * 0.5 + p[:, 2:] * 0.25
    return h[:-2] * 0.25 + h[1:-1] * 0.5 + h[2:] * 0.25


def erode(mask: np.ndarray, radius: int) -> np.ndarray:
    """Square binary erosion; pixels outside the image count as background."""
    out = np.asarray(mask, bool).copy()
    for axis in (0, 1):
        src = out.copy()
        for shift in range(1, radius + 1):
            fwd = np.zeros_like(src)
            bwd = np.zeros_like(src)
            if axis == 0:
                fwd[:-shift] = src[shift:]
                bwd[shift:] = src[:-shift]
            else:
                fwd[:, :-shift] = src[:, shift:]
                bwd[:, shift:] = src[:, :-shift]
            out &= fwd & bwd
    return out


def local_ratio(profile: np.ndarray, scored: np.ndarray, near: int = 12, far: int = 48,
                floor: float = 0.0) -> np.ndarray:
    """profile[i] / max(floor, median of the scored profile at distance near..far on both sides); 0 where not
    scored."""
    out = np.zeros(len(profile))
    for i in np.nonzero(scored)[0]:
        nb = np.r_[max(0, i - far):max(0, i - near + 1), min(len(profile), i + near):min(len(profile), i + far + 1)]
        nb = nb[scored[nb]]
        if len(nb) < 16:
            continue
        median = max(float(np.median(profile[nb])), floor)
        if median > 1e-6:
            out[i] = profile[i] / median
    return out


def _windows(sums: np.ndarray, counts: np.ndarray, start: np.ndarray, stop: np.ndarray):
    cs = np.concatenate([np.zeros((sums.shape[0], 1)), np.cumsum(sums, 1)], 1)
    cn = np.concatenate([np.zeros((counts.shape[0], 1)), np.cumsum(counts, 1)], 1)
    return cs[:, stop] - cs[:, start], cn[:, stop] - cn[:, start]


def column_profiles(diff: np.ndarray, energy: np.ndarray, land: np.ndarray, chunk: int = 64, half: int = 8,
                    line: int = 2, min_chunks: int = 8,
                    tone_floor: float = TONE_FLOOR) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(tone ratio, detail ratio, scored) for the boundary left of every column. See the module docstring."""
    H, W = diff.shape
    n = H // chunk
    if n == 0:
        zero = np.zeros(W)
        return zero, zero, np.zeros(W, bool)
    w = np.asarray(land[: n * chunk], np.float64)
    S = (diff[: n * chunk] * w).reshape(n, chunk, W).sum(1)
    SE = (energy[: n * chunk] * w).reshape(n, chunk, W).sum(1)
    N = w.reshape(n, chunk, W).sum(1)
    x = np.arange(W)
    ls, ln = _windows(S, N, np.clip(x - half, 0, W), x)
    rs, rn = _windows(S, N, x, np.clip(x + half, 0, W))
    full = chunk * half * 0.9
    ok = (ln >= full) & (rn >= full)
    count = ok.sum(0)
    scored = count >= min_chunks
    tone = np.where(ok, np.abs(rs / np.maximum(rn, 1) - ls / np.maximum(ln, 1)), 0).sum(0) / np.maximum(count, 1)
    le, lc = _windows(SE, N, np.clip(x - line, 0, W), np.clip(x + line, 0, W))
    okl = ok & (lc >= chunk * 2 * line * 0.9)
    detail = np.where(okl, le / np.maximum(lc, 1), 0).sum(0) / np.maximum(okl.sum(0), 1)
    tone_ratio = local_ratio(tone, scored, floor=tone_floor)
    detail_ratio = local_ratio(detail, scored)
    detail_ratio = np.maximum(detail_ratio, np.where(detail_ratio > 0, 1 / np.maximum(detail_ratio, 1e-6), 0))
    return tone_ratio, detail_ratio, scored


def seam_scores(result_rgb: np.ndarray, reference_rgb: np.ndarray, land: np.ndarray, **kw) -> dict:
    """Column and row seam scores of a re-detail against a seam-free reference of the same size.

    `land` should already exclude transparent and water pixels and be eroded a few pixels, so that the alpha and
    shore boundaries themselves are never measured."""
    lum = luminance(result_rgb)
    diff = lum - luminance(reference_rgb)
    energy = np.abs(lum - binomial_blur(lum))
    land = np.asarray(land, bool)
    tc, dc, sc = column_profiles(diff, energy, land, **kw)
    tr, dr, sr = column_profiles(np.ascontiguousarray(diff.T), np.ascontiguousarray(energy.T),
                                 np.ascontiguousarray(land.T), **kw)

    def peak(profile):
        return (float(profile.max()), int(profile.argmax())) if profile.size else (0.0, -1)

    out = {}
    for name, profile in (("tone_col", tc), ("detail_col", dc), ("tone_row", tr), ("detail_row", dr)):
        out[name], out[name + "_at"] = peak(profile)
    out.update(scored_cols=int(sc.sum()), scored_rows=int(sr.sum()))
    return out
