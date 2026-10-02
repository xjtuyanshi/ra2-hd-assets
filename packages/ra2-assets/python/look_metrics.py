"""Lighting-depth metrics of a rendered framing against its approved target (same framing, same size).

Used to tune the HD renderer's looks numerically instead of by eye: two renders of the same bench framing (or a render
and a style target painted at the same scale) are compared region by region.

    python3 look_metrics.py target=t.png l5=a.png [--box name=x0,y0,x1,y1 ...] [--size 1680x1050] [--json out.json]
    python3 look_metrics.py --rings target=t.png@845,285 l5=a.png@860,280

Per image and region: L* mean/std and percentiles, local contrast at two scales (|L - blur2(L)| for pixel texture,
|blur2 - blur8| for mid-scale form), the sun/shade separation (p90 - p10 of L* on a 24 px blur: how different lit and
shaded areas are at the scale of whole faces), highlight share (L* > 85), deep-shade share (L* < 22), mean chroma and
mean a*/b*. --rings prints the median b* and L* in elliptical rings around a point (a light source's spill: the
ellipse is squashed 1.6x vertically, between a ground circle's 2:1 and an upright building's).
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image, ImageFilter

RINGS = (0, 20, 40, 70, 100, 140, 190, 250, 320)


def lab(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """sRGB (0..255 floats, D65) to CIE L*a*b*."""
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return 116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])


def blur(L: np.ndarray, radius: float) -> np.ndarray:
    im = Image.fromarray(np.clip(L * 2.55, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64) / 2.55


def load(path: str, size: tuple[int, int]) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB').resize(size), dtype=np.float64)


def metrics(rgb: np.ndarray, boxes: dict[str, tuple[int, int, int, int]]) -> dict[str, dict[str, float]]:
    L, a, b = lab(rgb)
    b2, b8, b24 = blur(L, 2), blur(L, 8), blur(L, 24)
    out = {}
    for name, (x0, y0, x1, y1) in boxes.items():
        region = (slice(y0, y1), slice(x0, x1))
        l = L[region]
        p = np.percentile(l, [5, 50, 95, 99])
        s24 = b24[region]
        out[name] = {
            'L': round(float(l.mean()), 1),
            'Lstd': round(float(l.std()), 1),
            'p5': round(float(p[0]), 1),
            'p50': round(float(p[1]), 1),
            'p95': round(float(p[2]), 1),
            'p99': round(float(p[3]), 1),
            'lc_fine': round(float(np.abs(l - b2[region]).mean()), 2),
            'lc_mid': round(float(np.abs(b2[region] - b8[region]).mean()), 2),
            'sunshade': round(float(np.percentile(s24, 90) - np.percentile(s24, 10)), 1),
            'hi_share': round(float((l > 85).mean() * 100), 2),
            'dark_share': round(float((l < 22).mean() * 100), 2),
            'chroma': round(float(np.hypot(a[region], b[region]).mean()), 1),
            'a': round(float(a[region].mean()), 1),
            'b': round(float(b[region].mean()), 1),
        }
    return out


def rings(rgb: np.ndarray, centre: tuple[float, float], edges=RINGS) -> list[tuple[float, float]]:
    """Median (b*, L*) per elliptical ring around centre."""
    L, _, b = lab(rgb)
    yy, xx = np.mgrid[0 : rgb.shape[0], 0 : rgb.shape[1]]
    r = np.hypot(xx - centre[0], (yy - centre[1]) * 1.6)
    out = []
    for r0, r1 in zip(edges, edges[1:]):
        m = (r >= r0) & (r < r1)
        out.append((float(np.median(b[m])), float(np.median(L[m]))) if m.any() else (float('nan'), float('nan')))
    return out


def main(argv: list[str]) -> None:
    size = (1680, 1050)
    boxes: dict[str, tuple[int, int, int, int]] = {}
    out_json = None
    ring_mode = False
    items = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--size':
            w, h = argv[i + 1].split('x')
            size = (int(w), int(h))
            i += 2
        elif arg == '--box':
            name, coords = argv[i + 1].split('=', 1)
            boxes[name] = tuple(int(v) for v in coords.split(','))  # type: ignore[assignment]
            i += 2
        elif arg == '--json':
            out_json = argv[i + 1]
            i += 2
        elif arg == '--rings':
            ring_mode = True
            i += 1
        else:
            items.append(arg.split('=', 1))
            i += 1
    if ring_mode:
        print('ring(px)  ' + ' '.join(f'{a}-{b}'.rjust(9) for a, b in zip(RINGS, RINGS[1:])))
        for name, spec in items:
            path, xy = spec.rsplit('@', 1)
            cx, cy = (float(v) for v in xy.split(','))
            values = rings(load(path, size), (cx, cy))
            print(f'{name:<8} b* ' + ' '.join(f'{v[0]:9.1f}' for v in values))
            print(f'{name:<8} L* ' + ' '.join(f'{v[1]:9.1f}' for v in values))
        return
    boxes = boxes or {'all': (0, 0, size[0], size[1])}
    result = {name: metrics(load(path, size), boxes) for name, path in items}
    for region in boxes:
        print(f'== {region}')
        keys = list(next(iter(result.values()))[region])
        print('name'.ljust(10) + ''.join(k.rjust(10) for k in keys))
        for name, values in result.items():
            print(name.ljust(10) + ''.join(f'{values[region][k]:10}' for k in keys))
    if out_json:
        with open(out_json, 'w') as f:
            json.dump(result, f, indent=1)


if __name__ == '__main__':
    main(sys.argv[1:])
