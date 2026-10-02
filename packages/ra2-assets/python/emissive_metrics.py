"""Review metrics for emissive heads (the Tesla reactor's plasma orb and arcs) on rendered framings.

The art-direction reviews judge the reactor by two pixel classes in a fixed box: saturated blue (HSV hue 205-260,
S >= 0.5, V >= 0.6: the orb and arcs read as electric) and pale lavender (hue 200-290, S 0.03-0.3, V >= 0.85: the
milky veil that bloom used to spread over facades and pavement). Gates compare a render against the faithful render
or the original frame of the same scene (saturated blue 1.0-1.5x, lavender <= 2000).

    python3 emissive_metrics.py counts img.png x0,y0,x1,y1 [img2.png ...]
    python3 emissive_metrics.py fit img.png x0,y0,x1,y1 [--ymax Y]     # glass sphere circle of the art
    python3 emissive_metrics.py reach base.png img.png cx,cy x0,y0,x1,y1 [--threshold 40] [--scale 2]
    python3 emissive_metrics.py mask present.png absent.png out.png [--threshold 0.04] [--dilate 2]
    python3 emissive_metrics.py outside base.png img.png (--mask mask.png | --poly "x,y;x,y;...") [--box box] [--dv 0.03]
    python3 emissive_metrics.py footprint x y w h [--height H] [--scale 1] [--cell 60x30]
    python3 emissive_metrics.py pairgate orig.png hd.png box --poly "x,y;x,y;..." [--max-ratio 1.1] [--tol 0]

`fit` locates the painted glass (bluish, bright) in a box and fits a circle to its outline (points below --ymax are
ignored: arcs and pads merge with the sphere's foot), which is how the overlay orb radius and head were measured.
`reach` reports how far an overlay changed pixels from a centre (render with and without the overlay), in engine
pixels when --scale gives device pixels per engine pixel.

`mask` keeps the largest 8-connected RGB-difference component and original components touching its square dilation
(radius --dilate), then fills holes; it writes a 0/255 L PNG and prints {area, bbox}. `outside` counts added value OR
blueness outside/inside that mask or an even-odd polygon, with max_v_increase_outside and up to five outside_clusters
(largest first, area >= 4). Boxes use exclusive right/bottom bounds; polygons test pixel centres (x + 0.5, y + 0.5).
`footprint` prints an RA2 foundation diamond, or its convex hull with a copy shifted up by height * scale, as a
semicolon-separated polygon rounded to 0.1 px. Its x,y is the foundation's top corner; cell dimensions are engine px.
`pairgate` prints orig/hd class counts, satblue_ratio, outside_orig/outside_hd (either class), pass_ratio,
pass_outside and pass. With zero original blue, the ratio is null and its gate passes only if HD blue is also zero.
Pair gates always exit 0 for a completed measurement, including a failed gate.
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


def connected_components(mask: np.ndarray, connectivity: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Label a boolean mask using horizontal runs and union-find; return labels and areas (label 0 is background).

    A run has one label, so solid silhouettes do not require a Python visit for every foreground pixel.
    """
    mask = np.asarray(mask, dtype=bool)
    if mask.ndim != 2 or connectivity not in (4, 8):
        raise ValueError('components require a 2D mask and connectivity 4 or 8')
    labels = np.zeros(mask.shape, dtype=np.int32)
    parents = [0]
    ranks = [0]

    def find(label: int) -> int:
        while parents[label] != label:
            parents[label] = parents[parents[label]]
            label = parents[label]
        return label

    def union(a: int, b: int) -> None:
        a, b = find(a), find(b)
        if a == b:
            return
        if ranks[a] < ranks[b]:
            a, b = b, a
        parents[b] = a
        if ranks[a] == ranks[b]:
            ranks[a] += 1

    previous: list[tuple[int, int, int]] = []
    gap = 0 if connectivity == 8 else 1
    for y, row in enumerate(mask):
        edges = np.flatnonzero(np.diff(np.pad(row.astype(np.int8), (1, 1))))
        current: list[tuple[int, int, int]] = []
        p = 0
        for start, end in zip(edges[::2].tolist(), edges[1::2].tolist()):
            label = len(parents)
            parents.append(label)
            ranks.append(0)
            labels[y, start:end] = label
            while p < len(previous) and previous[p][1] < start + gap:
                p += 1
            j = p
            while j < len(previous) and previous[j][0] <= end - gap:
                union(label, previous[j][2])
                j += 1
            current.append((start, end, label))
        previous = current
    roots = np.fromiter((find(i) for i in range(len(parents))), dtype=np.int32, count=len(parents))
    labels = roots[labels]
    return labels, np.bincount(labels.ravel(), minlength=len(parents))


def dilate_square(mask: np.ndarray, radius: int) -> np.ndarray:
    """Square dilation by a radius in pixels, using separable NumPy shifts without wrapping at image edges."""
    mask = np.asarray(mask, dtype=bool)
    if mask.ndim != 2 or radius < 0 or int(radius) != radius:
        raise ValueError('dilation requires a 2D mask and a non-negative integer radius')
    horizontal = mask.copy()
    for offset in range(1, min(int(radius), mask.shape[1] - 1) + 1):
        horizontal[:, offset:] |= mask[:, :-offset]
        horizontal[:, :-offset] |= mask[:, offset:]
    result = horizontal.copy()
    for offset in range(1, min(int(radius), mask.shape[0] - 1) + 1):
        result[offset:] |= horizontal[:-offset]
        result[:-offset] |= horizontal[offset:]
    return result


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """Fill background regions that cannot reach an image edge through 4-connected background pixels."""
    mask = np.asarray(mask, dtype=bool)
    if mask.ndim != 2:
        raise ValueError('hole filling requires a 2D mask')
    if mask.size == 0:
        return mask.copy()
    labels, areas = connected_components(~mask, connectivity=4)
    exterior = np.zeros(len(areas), dtype=bool)
    exterior[0] = True
    exterior[np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1]))] = True
    return mask | ~exterior[labels]


def mask_bbox(mask: np.ndarray) -> list[int] | None:
    """Exclusive x0,y0,x1,y1 bounds of true pixels, or None for an empty mask."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def _check_pair(base: np.ndarray, img: np.ndarray) -> None:
    if base.shape != img.shape or base.ndim != 3 or base.shape[2] != 3:
        raise ValueError('images must have matching HxWx3 RGB shapes (0..1 values)')


def silhouette_mask(present: np.ndarray, absent: np.ndarray, threshold: float = 0.04, dilate: int = 2) -> np.ndarray:
    """Keep the largest difference component, its nearby components, and holes, without enlarging the silhouette."""
    _check_pair(present, absent)
    if not np.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('threshold must be between 0 and 1')
    if dilate < 0 or int(dilate) != dilate:
        raise ValueError('dilate must be a non-negative integer')
    changed = np.max(np.abs(present - absent), axis=-1) >= threshold
    labels, areas = connected_components(changed)
    if len(areas) == 1:
        return changed
    largest = int(np.argmax(areas[1:])) + 1
    nearby = dilate_square(labels == largest, dilate)
    keep = np.zeros(len(areas), dtype=bool)
    keep[labels[nearby]] = True
    keep[0] = False
    return fill_holes(keep[labels])


def polygon_mask(shape: tuple[int, int], polygon: np.ndarray) -> np.ndarray:
    """Even-odd fill of a simple polygon at pixel centres; horizontal edges do not count as ray crossings."""
    polygon = np.asarray(polygon, dtype=np.float64)
    if polygon.ndim != 2 or polygon.shape[1] != 2 or len(polygon) < 3 or not np.isfinite(polygon).all():
        raise ValueError('polygon requires at least three finite x,y points')
    height, width = shape
    mask = np.zeros(shape, dtype=bool)
    # Only rasterize the polygon's clipped bounds, even for a large live frame.
    x0 = max(0, min(width, int(np.floor(polygon[:, 0].min()))))
    x1 = max(0, min(width, int(np.ceil(polygon[:, 0].max()))))
    y0 = max(0, min(height, int(np.floor(polygon[:, 1].min()))))
    y1 = max(0, min(height, int(np.ceil(polygon[:, 1].max()))))
    xs = np.arange(x0, x1, dtype=np.float64)[None, :] + 0.5
    ys = np.arange(y0, y1, dtype=np.float64)[:, None] + 0.5
    inside = mask[y0:y1, x0:x1]
    for (ax, ay), (bx, by) in zip(polygon, np.roll(polygon, -1, axis=0)):
        if ay == by:
            continue
        crossing = ((ay > ys) != (by > ys)) & (xs < ax + (ys - ay) * (bx - ax) / (by - ay))
        inside ^= crossing
    return mask


def _region(shape: tuple[int, int], box: tuple[int, int, int, int] | None) -> tuple[slice, slice, int, int]:
    """Clip exclusive box bounds to the image, keeping cluster coordinates in the full frame."""
    height, width = shape
    if box is None:
        return slice(0, height), slice(0, width), 0, 0
    x0, y0, x1, y1 = box
    if x1 < x0 or y1 < y0:
        raise ValueError('box bounds must be ordered x0,y0,x1,y1')
    x0, x1 = max(0, min(width, x0)), max(0, min(width, x1))
    y0, y1 = max(0, min(height, y0)), max(0, min(height, y1))
    return slice(y0, y1), slice(x0, x1), x0, y0


def outside(
    base: np.ndarray,
    img: np.ndarray,
    mask: np.ndarray,
    box: tuple[int, int, int, int] | None = None,
    dv: float = 0.03,
) -> dict:
    """Count overlay additions (value OR blueness) inside/outside a silhouette or polygon mask (RGB 0..1)."""
    _check_pair(base, img)
    mask = np.asarray(mask, dtype=bool)
    if mask.shape != base.shape[:2]:
        raise ValueError('mask dimensions must match the images')
    if not np.isfinite(dv) or dv < 0:
        raise ValueError('dv must be finite and non-negative')
    sy, sx, x0, y0 = _region(mask.shape, box)
    base, img, mask = base[sy, sx], img[sy, sx], mask[sy, sx]
    value_delta = img.max(-1) - base.max(-1)
    delta = img - base
    blue_delta = delta[..., 2] - (delta[..., 0] + delta[..., 1]) / 2
    added = (value_delta >= dv) | (blue_delta >= dv)
    spill = added & ~mask
    labels, areas = connected_components(spill)
    candidates = np.flatnonzero(areas[1:] >= 4) + 1
    candidates = sorted(candidates.tolist(), key=lambda label: (-int(areas[label]), label))[:5]
    clusters = []
    for label in candidates:
        bx0, by0, bx1, by1 = mask_bbox(labels == label)
        clusters.append([bx0 + x0, by0 + y0, bx1 + x0, by1 + y0])
    return {
        'outside': int(spill.sum()),
        'inside': int((added & mask).sum()),
        'max_v_increase_outside': max(0.0, float(value_delta[~mask].max())) if (~mask).any() else 0.0,
        'outside_clusters': clusters,
    }


def convex_hull(points: np.ndarray) -> np.ndarray:
    """Monotone-chain hull, excluding collinear intermediate points."""
    ordered = sorted(set(map(tuple, np.asarray(points, dtype=np.float64))))

    def cross(o: tuple, a: tuple, b: tuple) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def half(sequence: list) -> list:
        hull: list = []
        for point in sequence:
            while len(hull) >= 2 and cross(hull[-2], hull[-1], point) <= 0:
                hull.pop()
            hull.append(point)
        return hull

    if len(ordered) <= 1:
        return np.asarray(ordered, dtype=np.float64).reshape(-1, 2)
    return np.asarray(half(ordered)[:-1] + half(ordered[::-1])[:-1], dtype=np.float64)


def footprint(
    x: float,
    y: float,
    w: float,
    h: float,
    height: float = 0,
    scale: float = 1,
    cell: tuple[float, float] = (60, 30),
) -> np.ndarray:
    """Foundation diamond, optionally extruded upward to cover the art; return screen points starting at the top."""
    if not np.isfinite([x, y, w, h, height, scale, *cell]).all() or min(w, h, scale, *cell) <= 0 or height < 0:
        raise ValueError('foundation, scale and cell dimensions must be positive; height must be non-negative')
    dx, dy = cell[0] * scale / 2, cell[1] * scale / 2
    diamond = np.array([(x, y), (x + dx * w, y + dy * w),
                        (x + dx * (w - h), y + dy * (w + h)), (x - dx * h, y + dy * h)], dtype=np.float64)
    if height == 0:
        return diamond
    hull = convex_hull(np.concatenate((diamond, diamond + (0, -height * scale))))
    first = int(np.lexsort((hull[:, 0], hull[:, 1]))[0])
    return np.roll(hull, -first, axis=0)


def pairgate(
    orig: np.ndarray,
    hd: np.ndarray,
    box: tuple[int, int, int, int],
    polygon: np.ndarray,
    max_ratio: float = 1.1,
    tol: int = 0,
) -> dict:
    """Measure original/HD classes and outside spill in one frozen frame; return gate flags without file I/O."""
    _check_pair(orig, hd)
    if not np.isfinite(max_ratio) or max_ratio < 0 or tol < 0 or int(tol) != tol:
        raise ValueError('max-ratio and integer tol must be non-negative')
    mask = polygon_mask(orig.shape[:2], polygon)
    sy, sx, _, _ = _region(mask.shape, box)
    exterior = ~mask[sy, sx]
    measured = []
    for rgb in (orig, hd):
        satblue, lavender = classes(rgb[sy, sx])
        measured.append(({'satblue': int(satblue.sum()), 'lavender': int(lavender.sum())},
                         int(((satblue | lavender) & exterior).sum())))
    (original, outside_orig), (enhanced, outside_hd) = measured
    ratio = enhanced['satblue'] / original['satblue'] if original['satblue'] else None
    pass_ratio = ratio <= max_ratio if ratio is not None else enhanced['satblue'] == 0
    pass_outside = outside_hd <= outside_orig + tol
    return {
        'orig': original, 'hd': enhanced, 'satblue_ratio': ratio,
        'outside_orig': outside_orig, 'outside_hd': outside_hd,
        'pass_ratio': pass_ratio, 'pass_outside': pass_outside, 'pass': pass_ratio and pass_outside,
    }


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255


def _box(text: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = (int(v) for v in text.split(','))
    return x0, y0, x1, y1


def _polygon(text: str) -> np.ndarray:
    return np.asarray([[float(v) for v in point.split(',')] for point in text.split(';')], dtype=np.float64)


def _measurement(cmd: str, rest: list[str], opts: dict[str, str]) -> None:
    """File/CLI boundary for the containment measurements; all measurement helpers above are pure."""
    required, allowed = {
        'mask': (3, {'threshold', 'dilate'}),
        'outside': (2, {'mask', 'poly', 'box', 'dv'}),
        'footprint': (4, {'height', 'scale', 'cell'}),
        'pairgate': (3, {'poly', 'max-ratio', 'tol'}),
    }[cmd]
    if len(rest) != required or opts.keys() - allowed:
        raise ValueError(f'invalid arguments for {cmd}; see module usage')
    if cmd == 'mask':
        mask = silhouette_mask(load(rest[0]), load(rest[1]), float(opts.get('threshold', 0.04)), int(opts.get('dilate', 2)))
        Image.fromarray(mask.astype(np.uint8) * 255).save(rest[2], format='PNG')
        print(json.dumps({'area': int(mask.sum()), 'bbox': mask_bbox(mask)}))
    elif cmd == 'outside':
        if ('mask' in opts) == ('poly' in opts):
            raise ValueError('outside requires exactly one of --mask or --poly')
        base, img = load(rest[0]), load(rest[1])
        if 'mask' in opts:
            with Image.open(opts['mask']) as image:
                mask = np.asarray(image.convert('L')) != 0
        else:
            mask = polygon_mask(base.shape[:2], _polygon(opts['poly']))
        box = _box(opts['box']) if 'box' in opts else None
        print(json.dumps(outside(base, img, mask, box, float(opts.get('dv', 0.03)))))
    elif cmd == 'footprint':
        cell = tuple(float(v) for v in opts.get('cell', '60x30').split('x'))
        if len(cell) != 2:
            raise ValueError('cell must be widthxheight in engine pixels')
        polygon = footprint(*(float(v) for v in rest), height=float(opts.get('height', 0)),
                            scale=float(opts.get('scale', 1)), cell=cell)
        print(';'.join(f'{x:.1f},{y:.1f}' for x, y in polygon))
    else:
        if 'poly' not in opts:
            raise ValueError('pairgate requires --poly')
        result = pairgate(load(rest[0]), load(rest[1]), _box(rest[2]), _polygon(opts['poly']),
                          float(opts.get('max-ratio', 1.1)), int(opts.get('tol', 0)))
        print(json.dumps(result))


def main(argv: list[str]) -> int:
    measurements = ('mask', 'outside', 'footprint', 'pairgate')
    if len(argv) < 3 or argv[0] not in ('counts', 'fit', 'reach', *measurements):
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    opts: dict[str, str] = {}
    rest: list[str] = []
    i = 0
    while i < len(args):
        if args[i].startswith('--'):
            if cmd in measurements and i + 1 == len(args):
                print(f'{args[i]} requires a value', file=sys.stderr)
                return 2
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            rest.append(args[i])
            i += 1
    if cmd in measurements:
        try:
            _measurement(cmd, rest, opts)
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return 2
    elif cmd == 'counts':
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
