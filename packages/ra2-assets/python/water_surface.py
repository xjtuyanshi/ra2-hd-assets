#!/usr/bin/env python3
"""Build a seamless RGBA waterSurface tile from painted chop and foam textures.

R is glint-free relief luminance / its broad mean / 2, G is glint strength,
B is foam lace, and A is 255. Half-offset blending compensates for lost variance
near the wrap edges. Glints use the 93.5..99.6 excess-luminance percentiles and
power 1.5 by default. The output contains linear data, not sRGB colour.
Also write <out-stem>_chop_seamless.png for inspection; no material JSON is edited.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


@dataclass
class SurfaceResult:
    rgba: np.ndarray
    chop: np.ndarray
    foam: np.ndarray
    ratio: np.ndarray
    glint: np.ndarray
    lace: np.ndarray


def wblur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur with periodic boundaries, including all colour channels."""
    p = int(sigma * 3) + 1
    pad = ((p, p), (p, p)) + (((0, 0),) if a.ndim == 3 else ())
    blurred = cv2.GaussianBlur(np.pad(a, pad, mode="wrap"), (0, 0), sigma)
    return blurred[p:-p, p:-p]


def seamless(a: np.ndarray, frac: float = 0.22) -> np.ndarray:
    """Blend HxWxC floats with a half-offset copy while retaining local contrast."""
    if a.ndim != 3 or min(a.shape[:2]) < 2:
        raise ValueError("seamless expects an HxWxC image at least 2 pixels on each axis")
    if not 0 < frac <= 0.5:
        raise ValueError("blend fraction must be in (0, 0.5]")
    h, w = a.shape[:2]
    shifted = np.roll(a, (h // 2, w // 2), (0, 1))

    def ramp(n):
        x = np.arange(n) / (n - 1)
        return np.clip(1 - np.minimum(x, 1 - x) / frac, 0, 1)

    m = np.maximum(ramp(h)[:, None], ramp(w)[None, :])
    m = (m * m * (3 - 2 * m))[..., None]
    mean_a = wblur(a, 24)
    mean_s = np.roll(mean_a, (h // 2, w // 2), (0, 1))
    mean = mean_a * (1 - m) + mean_s * m
    deviation = (a - mean_a) * (1 - m) + (shifted - mean_s) * m
    gain = 1 / np.sqrt((1 - m) ** 2 + m ** 2)
    return mean + deviation * gain


def prepare(chop: np.ndarray, foam: np.ndarray, glint_percentiles: tuple[float, float] = (93.5, 99.6),
            glint_gain: float = 1.0) -> SurfaceResult:
    """Encode equally sized RGB float textures in [0, 1], without changing either input."""
    if chop.ndim != 3 or chop.shape[-1] != 3 or foam.shape != chop.shape:
        raise ValueError("chop and foam must be RGB images with the same dimensions")
    lo_pct, hi_pct = glint_percentiles
    if not 0 <= lo_pct < hi_pct <= 100:
        raise ValueError("glint percentiles must satisfy 0 <= LO < HI <= 100")
    if not np.isfinite(glint_gain) or glint_gain < 0:
        raise ValueError("glint gain must be finite and nonnegative")
    c, f = seamless(chop), seamless(foam)
    luminance = c @ LUMA
    median = cv2.medianBlur((np.clip(luminance, 0, 1) * 255).astype(np.uint8), 7).astype(np.float32) / 255
    excess = luminance - wblur(median, 3)
    lo, hi = np.percentile(excess, (lo_pct, hi_pct))
    glint = np.clip((excess - lo) / max(hi - lo, 1e-3), 0, 1) ** 1.5 * glint_gain
    # Keep thin crest lighting in the relief; remove only the strongest highlights.
    noglint = np.where(excess > np.percentile(excess, 90), median, luminance)
    ratio = noglint / np.maximum(wblur(noglint, 20), 1e-3)
    lace = np.clip((f @ LUMA - 0.08) / 0.8, 0, 1)
    rgba = np.empty((*chop.shape[:2], 4), np.uint8)
    rgba[..., 0] = np.clip(ratio / 2 * 255 + 0.5, 0, 255)
    rgba[..., 1] = np.clip(glint * 255 + 0.5, 0, 255)
    rgba[..., 2] = np.clip(lace * 255 + 0.5, 0, 255)
    rgba[..., 3] = 255
    return SurfaceResult(rgba, c, f, ratio, glint, lace)


def load(path: Path, size: int) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)).astype(np.float32) / 255


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chop", required=True, type=Path)
    parser.add_argument("--foam", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--size", type=int, default=1024, help="square tile width in pixels (default: 1024)")
    parser.add_argument("--glint-percentiles", nargs=2, type=float, default=(93.5, 99.6), metavar=("LO", "HI"))
    parser.add_argument("--glint-gain", type=float, default=1.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.size < 2:
            raise ValueError("size must be at least 2")
        result = prepare(load(args.chop, args.size), load(args.foam, args.size),
                         args.glint_percentiles, args.glint_gain)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(result.rgba).save(args.out)
        debug = args.out.with_name(args.out.stem + "_chop_seamless.png")
        Image.fromarray((np.clip(result.chop, 0, 1) * 255).astype(np.uint8)).save(debug)
        ratio, glint, lace = result.ratio, result.glint, result.lace
        print('ratio mean %.3f std %.3f p5 %.2f p95 %.2f | glint cover %.1f%% mean %.3f | lace mean %.2f cover %.1f%%' % (
            ratio.mean(), ratio.std(), np.percentile(ratio, 5), np.percentile(ratio, 95), (glint > 0.1).mean() * 100,
            glint.mean(), lace.mean(), (lace > 0.3).mean() * 100))
        for name, a in (("chop", result.chop), ("foam", result.foam)):
            dx, dxi = np.abs(a[:, -1] - a[:, 0]).mean(), np.abs(a[:, 1:] - a[:, :-1]).mean()
            dy, dyi = np.abs(a[-1] - a[0]).mean(), np.abs(a[1:] - a[:-1]).mean()
            print(name, 'seam x %.3f/%.3f y %.3f/%.3f' % (dx, dxi, dy, dyi))
    except (OSError, ValueError, cv2.error) as error:
        print(f"water_surface: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
