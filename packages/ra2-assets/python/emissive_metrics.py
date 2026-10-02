"""Review metrics for emissive heads (the Tesla reactor's plasma orb and arcs) on rendered framings.

The art-direction reviews judge the reactor by two pixel classes in a fixed box: saturated blue (HSV hue 205-260,
S >= 0.5, V >= 0.6: the orb and arcs read as electric) and pale lavender (hue 200-290, S 0.03-0.3, V >= 0.85: the
milky veil that bloom used to spread over facades and pavement). Gates compare a render against the faithful render
or the original frame of the same scene (saturated blue 1.0-1.5x, lavender <= 2000).

    python3 emissive_metrics.py counts img.png x0,y0,x1,y1 [img2.png ...]
    python3 emissive_metrics.py fit img.png x0,y0,x1,y1 [--ymax Y]     # glass sphere circle of the art
    python3 emissive_metrics.py reach base.png img.png cx,cy x0,y0,x1,y1 [--threshold 40] [--scale 2]

`fit` locates the painted glass (bluish, bright) in a box and fits a circle to its outline (points below --ymax are
ignored: arcs and pads merge with the sphere's foot), which is how the overlay orb radius and head were measured.
`reach` reports how far an overlay changed pixels from a centre (render with and without the overlay), in engine
pixels when --scale gives device pixels per engine pixel.
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image


def hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """0..1 RGB to hue (degrees), saturation and value."""
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    nz = d > 1e-6
    dd = np.where(nz, d, 1)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    return np.where(nz, h, 0), np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0), mx


def classes(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Boolean masks of the reviews' saturated-blue and pale-lavender pixels (rgb 0..1)."""
    h, s, v = hsv(rgb)
    satblue = (h >= 205) & (h <= 260) & (s >= 0.5) & (v >= 0.6)
    lavender = (h >= 200) & (h <= 290) & (s >= 0.03) & (s <= 0.3) & (v >= 0.85)
    return satblue, lavender


def counts(rgb: np.ndarray, box: tuple[int, int, int, int]) -> dict[str, int]:
    x0, y0, x1, y1 = box
    satblue, lavender = classes(rgb[y0:y1, x0:x1])
    return {'satblue': int(satblue.sum()), 'lavender': int(lavender.sum())}


def glass_mask(rgb: np.ndarray) -> np.ndarray:
    """Bright bluish glass: blue channel high, above red and at least green (0..1 input)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (b > 140 / 255) & (b > r + 8 / 255) & (b >= g)


def fit_circle(xs: np.ndarray, ys: np.ndarray, rounds: int = 3) -> tuple[float, float, float]:
    """Algebraic (Kasa) circle fit with trimming of the worst 30 % residuals per round."""
    xs = xs.astype(np.float64)
    ys = ys.astype(np.float64)
    cx = cy = radius = 0.0
    for _ in range(rounds):
        a = np.c_[2 * xs, 2 * ys, np.ones(len(xs))]
        c = np.linalg.lstsq(a, xs * xs + ys * ys, rcond=None)[0]
        cx, cy = c[0], c[1]
        radius = float(np.sqrt(c[2] + cx * cx + cy * cy))
        res = np.abs(np.hypot(xs - cx, ys - cy) - radius)
        keep = res <= max(2.0, float(np.percentile(res, 70)))
        if keep.sum() < 8:
            break
        xs, ys = xs[keep], ys[keep]
    return float(cx), float(cy), radius


def fit_sphere(rgb: np.ndarray, box: tuple[int, int, int, int], ymax: float | None = None) -> dict[str, float]:
    """Circle through the outline of the glass region in a box (rgb 0..1); points with y >= ymax are ignored."""
    x0, y0, x1, y1 = box
    m = glass_mask(rgb[y0:y1, x0:x1])
    # Outline: glass pixels with at least one non-glass 4-neighbour (the box border counts as outside).
    p = np.pad(m, 1)
    inner = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    ys, xs = np.nonzero(m & ~inner)
    xs = xs + x0
    ys = ys + y0
    if ymax is not None:
        keep = ys < ymax
        xs, ys = xs[keep], ys[keep]
    if len(xs) < 8:
        raise ValueError('too few glass outline pixels in the box')
    cx, cy, radius = fit_circle(xs, ys)
    return {'cx': round(cx, 2), 'cy': round(cy, 2), 'radius': round(radius, 2), 'glass': int(m.sum())}


def reach(
    base: np.ndarray,
    img: np.ndarray,
    centre: tuple[float, float],
    box: tuple[int, int, int, int],
    threshold: float = 40,
    scale: float = 1,
) -> dict[str, float]:
    """Distance from `centre` of pixels that differ between two renders (0..255 sums over RGB), divided by scale."""
    x0, y0, x1, y1 = box
    diff = np.abs(img[y0:y1, x0:x1] - base[y0:y1, x0:x1]).sum(-1) * 255 > threshold
    ys, xs = np.nonzero(diff)
    if len(xs) == 0:
        return {'changed': 0, 'p99': 0.0, 'max': 0.0}
    r = np.hypot(xs + x0 - centre[0], ys + y0 - centre[1]) / scale
    return {'changed': int(diff.sum()), 'p99': round(float(np.percentile(r, 99)), 2), 'max': round(float(r.max()), 2)}


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255


def _box(text: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = (int(v) for v in text.split(','))
    return x0, y0, x1, y1


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] not in ('counts', 'fit', 'reach'):
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    opts: dict[str, str] = {}
    rest: list[str] = []
    i = 0
    while i < len(args):
        if args[i].startswith('--'):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            rest.append(args[i])
            i += 1
    if cmd == 'counts':
        box = _box(rest[1])
        for path in [rest[0], *rest[2:]]:
            print(path, json.dumps(counts(load(path), box)))
    elif cmd == 'fit':
        ymax = float(opts['ymax']) if 'ymax' in opts else None
        print(json.dumps(fit_sphere(load(rest[0]), _box(rest[1]), ymax)))
    else:
        cx, cy = (float(v) for v in rest[2].split(','))
        result = reach(
            load(rest[0]),
            load(rest[1]),
            (cx, cy),
            _box(rest[3]),
            float(opts.get('threshold', 40)),
            float(opts.get('scale', 1)),
        )
        print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
