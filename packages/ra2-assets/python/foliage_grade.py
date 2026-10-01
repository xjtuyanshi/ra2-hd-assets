"""Foliage grade for an HD terrain map: pull grass and lawn texels towards one approved vegetation look.

The approved cinematic targets show sunlit grass as a golden yellow-green of one brightness everywhere, while the HD
terrain maps carry the original tiles' spread: cool blue-green wild grass next to lush lawns (XMP29U2 battle area vs
city park). This grade moves each foliage texel's LOCAL MEAN (a Gaussian blur of CIELAB at `sigma` texels) part of the
way towards a target lightness, hue angle and chroma, and adds the texel's own deviation from that mean back
unchanged, so mowing stripes, clumps and mottling keep their contrast. Texels outside the green-yellow hue band, with
little chroma or no alpha are untouched; the band edges are feathered.

    python3 foliage_grade.py in.png out.png [--L 47 --kL 0.7 --hue 100 --kH 0.6 --C 34 --kC 0.5 --sigma 40]

All targets are texel values (the art before the renderer's lighting), CIELAB D65: L* lightness, hue angle h_ab in
degrees (90 = yellow, 135 = green), chroma C*. k* are the shares of the distance to the target that are closed.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f > 0.206893, f**3, (f - 16 / 116) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    m = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    c = np.clip(xyz @ m.T, 0, None)
    return np.clip(np.where(c > 0.0031308, 1.055 * c ** (1 / 2.4) - 0.055, 12.92 * c), 0, 1)


def gaussian(field: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a 2-D float field (OpenCV when available, else a separable numpy convolution)."""
    if sigma <= 0:
        return field
    try:
        import cv2

        return cv2.GaussianBlur(field.astype(np.float32), (0, 0), sigma, borderType=cv2.BORDER_REFLECT)
    except ImportError:
        r = int(3 * sigma)
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        out = np.pad(field, r, mode='reflect')
        out = np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 0, out)
        return np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 1, out)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def foliage_weight(lab: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """0..1: green-yellow hue band (h_ab about 85-165 deg, feathered), some chroma, visible."""
    h = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360
    c = np.hypot(lab[..., 1], lab[..., 2])
    band = smoothstep(78, 92, h) * smoothstep(175, 160, h)
    return band * smoothstep(6, 12, c) * smoothstep(8, 14, lab[..., 0]) * (alpha > 0)


def grade(
    rgba: np.ndarray,
    L: float = 47.0,
    kL: float = 0.7,
    hue: float = 100.0,
    kH: float = 0.6,
    C: float = 34.0,
    kC: float = 0.5,
    sigma: float = 40.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Graded RGBA (uint8) and the foliage weight; see the module docstring."""
    # float32 keeps a whole-map grade (7200 x 3630 texels) within a few GB.
    rgb = rgba[..., :3].astype(np.float32) / 255
    lab = srgb_to_lab(rgb).astype(np.float32)
    w = foliage_weight(lab, rgba[..., 3]).astype(np.float32)
    # Local means over foliage only (weighted blur), so a road or a flower bed next to a lawn does not drag it.
    ws = gaussian(w, sigma) + 1e-6
    mean = np.stack([gaussian(lab[..., i] * w, sigma) / ws for i in range(3)], -1)
    mean_h = np.degrees(np.arctan2(mean[..., 2], mean[..., 1]))
    mean_c = np.hypot(mean[..., 1], mean[..., 2]) + 1e-6
    d_h = ((hue - mean_h + 180) % 360) - 180
    rot = np.radians(kH * d_h * w)
    scale = 1 + (kC * (C / mean_c - 1)) * w
    a, b = lab[..., 1], lab[..., 2]
    out = lab.copy()
    out[..., 0] = lab[..., 0] + kL * (L - mean[..., 0]) * w
    out[..., 1] = (a * np.cos(rot) - b * np.sin(rot)) * scale
    out[..., 2] = (a * np.sin(rot) + b * np.cos(rot)) * scale
    res = rgba.copy()
    res[..., :3] = np.clip(lab_to_srgb(out) * 255 + 0.5, 0, 255).astype(np.uint8)
    return res, w


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('out')
    for name, default in (('L', 47.0), ('kL', 0.7), ('hue', 100.0), ('kH', 0.6), ('C', 34.0), ('kC', 0.5), ('sigma', 40.0)):
        ap.add_argument('--' + name, type=float, default=default)
    o = ap.parse_args(argv)
    rgba = np.array(Image.open(o.src).convert('RGBA'))
    res, w = grade(rgba, o.L, o.kL, o.hue, o.kH, o.C, o.kC, o.sigma)
    Image.fromarray(res, 'RGBA').save(o.out, compress_level=3)
    m = w > 0.5
    before = srgb_to_lab(rgba[..., :3][m].astype(np.float64) / 255)
    after = srgb_to_lab(res[..., :3][m].astype(np.float64) / 255)
    def stats(v: np.ndarray) -> str:
        h = np.degrees(np.arctan2(v[:, 2].mean(), v[:, 1].mean()))
        return f'L {v[:, 0].mean():.1f} h {h:.1f} C {np.hypot(v[:, 1], v[:, 2]).mean():.1f}'
    print(f'foliage texels {int(m.sum())}: {stats(before)} -> {stats(after)}')


if __name__ == '__main__':
    main(sys.argv[1:])
