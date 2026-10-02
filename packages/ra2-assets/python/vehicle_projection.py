"""Build view-dependent voxel projection atlases from player-supplied redraw sheets.

Only builder code belongs in source control. Inputs, generated manifests, atlases
and review images stay in an external asset directory. Pixels use a top-left origin.
``lock`` restores design chroma; optional camouflage controls also transfer band-passed
lightness, low-frequency lightness and chroma gain without changing the sheet layout.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import tempfile
import warnings

import cv2
import numpy as np
from PIL import Image, ImageDraw

BAKE_JACOBIAN = np.array([[120, 0, -120], [60, -146.96938, 60]], np.float64)
GREY = 118.0
PADDING = 12


def rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert('RGB'), np.float32)


def unmatte(black: np.ndarray, white: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Recover straight colour and coverage, including the bake's actual backgrounds."""
    kb = black[:8, :8].mean(axis=(0, 1))
    wb = white[:8, :8].mean(axis=(0, 1))
    alpha = np.clip(1 - ((white - black) / np.maximum(wb - kb, 1)).mean(-1), 0, 1)
    alpha[alpha < 0.02] = 0
    colour = (black - kb * (1 - alpha[..., None])) / np.maximum(alpha[..., None], 1e-3)
    return np.clip(colour, 0, 255), alpha


def affine_point(matrix: np.ndarray, point) -> np.ndarray:
    return matrix[:, :2] @ np.asarray(point) + matrix[:, 2]


def sheet_matrix(cell: dict, scale: float) -> np.ndarray:
    offset = np.asarray(cell['dst_origin']) - scale * np.asarray(cell['src_centre']) - cell['cell'][:2]
    return np.array([[scale, 0, offset[0]], [0, scale, offset[1]]], np.float64)


def warp(array: np.ndarray, matrix: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    return cv2.warpAffine(array, matrix, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    # Pad first: (0, 0) must be outside even when a foreground component touches an edge.
    flooded = np.pad(mask.astype(np.uint8), 1)
    cv2.floodFill(flooded, None, (0, 0), 1)
    return mask | (flooded[1:-1, 1:-1] == 0)


def redraw_alpha(colour: np.ndarray, input_alpha: np.ndarray) -> np.ndarray:
    """Soft grey key, then repair enclosed steel and discard unrelated sheet marks."""
    distance = np.max(np.abs(colour - GREY), axis=-1)
    soft = np.clip((distance - 6) / 16, 0, 1)
    binary = cv2.morphologyEx((soft >= 0.5).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    filled = fill_holes(binary.astype(bool))
    count, labels = cv2.connectedComponents(filled.astype(np.uint8), connectivity=8)
    keep = np.zeros(count, bool)
    keep[np.unique(labels[input_alpha > 0.1])] = True
    keep[0] = False
    selected = keep[labels]
    # Keep antialiased boundary pixels next to a retained component, without restoring outside noise.
    fringe = cv2.dilate(selected.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    return np.where(selected, np.maximum(soft, 1.0), np.where(fringe, soft, 0)).astype(np.float32)


def similarity(size: tuple[int, int], scale: float, dx: float, dy: float) -> np.ndarray:
    centre = (np.asarray(size, np.float64) - 1) / 2
    return np.array([[scale, 0, centre[0] * (1 - scale) + dx],
                     [0, scale, centre[1] * (1 - scale) + dy]], np.float64)


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a >= 0.5, b >= 0.5
    union = np.count_nonzero(a | b)
    return float(np.count_nonzero(a & b) / union) if union else 0.0


@dataclass
class Registration:
    matrix: np.ndarray
    iou: float
    scale: float
    dx: float
    dy: float


def register(redraw: np.ndarray, target: np.ndarray) -> Registration:
    """Bounded similarity search, coarse-to-fine in scale, then subpixel translation.

    Cross correlation evaluates every integer translation at each scale. Union area
    is measured in the destination cell, so clipped pixels cannot bias the score.
    """
    size = (target.shape[1], target.shape[0])
    fixed = (target >= 0.5).astype(np.float32)
    if not fixed.any() or not (redraw >= 0.5).any():
        raise ValueError('Cannot register an empty silhouette')
    best = Registration(similarity(size, 1, 0, 0), mask_iou(redraw, target), 1, 0, 0)
    limit = 16
    ones = np.ones_like(fixed)
    for spacing, radius in [(0.02, 0.06), (0.005, 0.02), (0.00125, 0.005)]:
        centre = best.scale
        for scale in np.arange(max(0.94, centre - radius), min(1.06, centre + radius) + spacing / 2, spacing):
            scale = float(np.clip(scale, 0.94, 1.06))
            scaled = (warp(redraw, similarity(size, scale, 0, 0), size) >= 0.5).astype(np.float32)
            padded = np.pad(scaled, limit)
            intersection = cv2.matchTemplate(padded, fixed, cv2.TM_CCORR)
            area = cv2.matchTemplate(padded, ones, cv2.TM_CCORR)
            scores = intersection / np.maximum(fixed.sum() + area - intersection, 1)
            iy, ix = np.unravel_index(np.argmax(scores), scores.shape)
            dx, dy = float(limit - ix), float(limit - iy)
            matrix = similarity(size, scale, dx, dy)
            score = mask_iou(warp(redraw, matrix, size), target)
            if score > best.iou + 1e-8:
                best = Registration(matrix, score, scale, dx, dy)
    centre = best
    for scale in np.linspace(max(0.94, centre.scale - 0.00125), min(1.06, centre.scale + 0.00125), 5):
        for dy in np.arange(max(-16, centre.dy - 0.75), min(16, centre.dy + 0.75) + 0.01, 0.25):
            for dx in np.arange(max(-16, centre.dx - 0.75), min(16, centre.dx + 0.75) + 0.01, 0.25):
                matrix = similarity(size, float(scale), float(dx), float(dy))
                score = mask_iou(warp(redraw, matrix, size), target)
                if score > best.iou + 1e-8:
                    best = Registration(matrix, score, float(scale), float(dx), float(dy))
    return best


def linear_rgb(colour: np.ndarray) -> np.ndarray:
    c = np.asarray(colour, np.float64) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def luminance(colour: np.ndarray) -> np.ndarray:
    return linear_rgb(colour) @ np.array([0.2126, 0.7152, 0.0722])


def ramp_position(colour: np.ndarray, ramp: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Closest linear-light ramp segment, plus residual shading beyond its endpoints."""
    lum = luminance(colour)
    ramp_lum = luminance(ramp)
    best_error = np.full(lum.shape, np.inf)
    t = np.zeros(lum.shape)
    selected_lum = np.zeros(lum.shape)
    for i in range(len(ramp) - 1):
        delta = ramp_lum[i + 1] - ramp_lum[i]
        fraction = np.clip((lum - ramp_lum[i]) / delta, 0, 1) if abs(delta) > 1e-10 else np.zeros_like(lum)
        candidate = ramp_lum[i] + fraction * delta
        error = np.abs(candidate - lum)
        better = error < best_error
        t[better] = (i + fraction[better]) / (len(ramp) - 1)
        selected_lum[better] = candidate[better]
        best_error[better] = error[better]
    return t, np.clip(lum / np.maximum(selected_lum, 1e-6), 0, 2)


# Smallest house-paint component kept, in sheet pixels (about 3x3 voxels at the usual sheet scale).
MIN_PAINT_AREA = 40


def paint_channels(colour: np.ndarray, coverage: np.ndarray, source_colour: np.ndarray,
                   source_mask: np.ndarray, ramp: np.ndarray) -> np.ndarray:
    mask = source_mask > 0.05
    paint = np.zeros((*coverage.shape, 3), np.float32)
    if not mask.any():
        return paint
    source_hsv = cv2.cvtColor((source_colour / 255).astype(np.float32), cv2.COLOR_RGB2HSV)
    house = mask & (source_hsv[..., 1] > 0.2)
    if not house.any():
        return paint
    # Circular mean handles a red ramp crossing hue 0/360.
    angles = np.deg2rad(source_hsv[..., 0][house])
    hue = np.rad2deg(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean())) % 360
    hsv = cv2.cvtColor((colour / 255).astype(np.float32), cv2.COLOR_RGB2HSV)
    delta = np.abs((hsv[..., 0] - hue + 180) % 360 - 180)
    expanded = cv2.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    selected = expanded & (delta <= 25) & (hsv[..., 1] > 0.3) & (coverage > 0.02)
    # Drop specks: a one- or two-voxel house mark next to rust or ore (the War Miner's hopper) would otherwise repaint
    # a few of the redraw's orange-brown pixels in the full house colour.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(selected.astype(np.uint8), connectivity=8)
    small = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] < MIN_PAINT_AREA)
    selected &= ~np.isin(labels, small[small > 0])
    if selected.any():
        t, ratio = ramp_position(colour[selected], ramp)
        paint[selected] = np.stack([np.ones_like(t), t, ratio / 2], axis=-1)
    return paint


def dilate_colour(colour: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Nearest foreground colour everywhere in a frame's gutter, without changing alpha."""
    valid = alpha > 0.02
    if not valid.any():
        raise ValueError('Empty atlas frame')
    _, labels = cv2.distanceTransformWithLabels((~valid).astype(np.uint8), cv2.DIST_L2, 5,
                                               labelType=cv2.DIST_LABEL_PIXEL)
    colours = np.zeros((int(labels.max()) + 1, colour.shape[2]), colour.dtype)
    colours[labels[valid]] = colour[valid]
    return colours[labels]


@dataclass
class Frame:
    k: int
    facing: int
    colour: np.ndarray
    alpha: np.ndarray
    paint: np.ndarray
    pivot: np.ndarray
    outline: np.ndarray
    registration: Registration


def pack_frames(frames: list[Frame], padding: int = PADDING, max_width: int = 4096):
    if padding < 12:
        raise ValueError('Projection atlases require at least 12 pixels of padding')
    crops = []
    for frame in frames:
        ys, xs = np.nonzero(frame.alpha > 0.005)
        if not len(xs):
            raise ValueError(f'Empty frame {frame.k}')
        crops.append((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    sizes = [(x1 - x0 + 2 * padding, y1 - y0 + 2 * padding) for x0, y0, x1, y1 in crops]
    if max(w for w, _ in sizes) > max_width:
        raise ValueError('A padded frame exceeds the maximum atlas width')
    width = min(max_width, max(max(w for w, _ in sizes), math.ceil(math.sqrt(sum(w * h for w, h in sizes)) / 64) * 64))
    placements = []
    x = y = shelf = 0
    for w, h in sizes:
        if x + w > width:
            x, y, shelf = 0, y + shelf, 0
        placements.append((x, y))
        x += w
        shelf = max(shelf, h)
    height = y + shelf
    colour_atlas = np.zeros((height, width, 4), np.uint8)
    paint_atlas = np.zeros((height, width, 3), np.uint8)
    manifest_frames = []
    for frame, crop, (px, py), (w, h) in zip(frames, crops, placements, sizes):
        x0, y0, x1, y1 = crop
        alpha = np.pad(frame.alpha[y0:y1, x0:x1], padding)
        colour = np.pad(frame.colour[y0:y1, x0:x1], ((padding, padding), (padding, padding), (0, 0)))
        paint = np.pad(frame.paint[y0:y1, x0:x1], ((padding, padding), (padding, padding), (0, 0)))
        colour = dilate_colour(colour, alpha)
        # Preserve t/ratio at paint boundaries; R alone describes the paint coverage.
        if (paint[..., 0] > 0).any():
            paint[..., 1:] = dilate_colour(paint[..., 1:], paint[..., 0])
        colour_atlas[py:py + h, px:px + w, :3] = np.rint(np.clip(colour, 0, 255)).astype(np.uint8)
        colour_atlas[py:py + h, px:px + w, 3] = np.rint(alpha * 255).astype(np.uint8)
        paint_atlas[py:py + h, px:px + w] = np.rint(np.clip(paint, 0, 1) * 255).astype(np.uint8)
        offset = np.array([px + padding - x0, py + padding - y0])
        manifest_frames.append({'k': frame.k, 'facing': frame.facing, 'pivot': (frame.pivot + offset).tolist(),
                                'rect': [px + padding, py + padding, x1 - x0, y1 - y0]})
    return colour_atlas, paint_atlas, manifest_frames


def review_sheet(frames: list[Frame], path: Path):
    width = max(f.alpha.shape[1] for f in frames)
    height = max(f.alpha.shape[0] for f in frames) + 24
    sheet = Image.new('RGB', (width * 4, height * math.ceil(len(frames) / 4)), (40, 40, 40))
    draw = ImageDraw.Draw(sheet)
    for i, frame in enumerate(frames):
        a = frame.alpha[..., None]
        display = np.clip(frame.colour * a + GREY * (1 - a), 0, 255).astype(np.uint8)
        contours, _ = cv2.findContours((frame.outline >= 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(display, contours, -1, (0, 255, 160), 1)
        x, y = (i % 4) * width, (i // 4) * height
        sheet.paste(Image.fromarray(display), (x, y + 24))
        r = frame.registration
        draw.text((x + 4, y + 5), f'k={frame.k:02d} F={frame.facing:03d} IoU={r.iou:.3f} s={r.scale:.4f} d=({r.dx:g},{r.dy:g})',
                  fill=(255, 210, 100) if r.iou < 0.85 else (255, 255, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def file_stem(type_name: str) -> str:
    """File name stem of a projection type: library voxel ids of building turrets ('NAFLAK:turret') use '_'."""
    return type_name.replace(':', '_')


def build(type_name: str, bake: Path, sheets: list[Path], palettes: Path, house_key: str,
          out: Path, review: Path | None = None) -> dict:
    meta = json.loads((bake / 'meta.json').read_text())
    engine = meta['looks']['engine']
    metadata = {(f['part'], f['k']): f for f in engine['frames']}
    palette = np.asarray(json.loads(palettes.read_text())[house_key], np.uint8).reshape(256, 3)
    parts: dict[str, list[Frame]] = {}
    scale = None
    for directory in sheets:
        spec = json.loads((directory / 'input.json').read_text())
        if scale is None:
            scale = float(spec['scale'])
        if not math.isclose(scale, spec['scale'], rel_tol=1e-6):
            raise ValueError('All sheets of a type must use the same scale/Jacobian')
        with Image.open(directory / 'input.png') as image:
            size = image.size
        with Image.open(directory / 'output.png') as image:
            output = np.asarray(image.convert('RGB').resize(size, Image.Resampling.LANCZOS), np.float32)
        source_part = {'tur': 'turret'}.get(spec['part'], spec['part'])
        part = 'body' if source_part == 'all' else source_part
        if part not in ('body', 'turret'):
            raise ValueError(f'Unknown sheet part: {source_part}')
        frames = parts.setdefault(part, [])
        for cell in spec['cells']:
            k = int(cell['k'])
            md = metadata[source_part, k]
            if md['facing'] != cell['facing']:
                raise ValueError('Sheet facing does not match bake metadata')
            black = rgb(bake / 'engine' / f'{source_part}_{k:03d}_k.png')
            source_colour, source_alpha = unmatte(black, rgb(bake / 'engine' / f'{source_part}_{k:03d}_w.png'))
            second = rgb(bake / 'engine' / f'{source_part}_{k:03d}_p.png')
            source_mask = ((np.max(np.abs(black - second), axis=-1) > 2) & (source_alpha > 0.1)).astype(np.float32)
            x, y, w, h = cell['cell']
            mapping = sheet_matrix(cell, scale)
            input_alpha = warp(source_alpha, mapping, (w, h))
            input_pm = warp(source_colour * source_alpha[..., None], mapping, (w, h))
            input_colour = input_pm / np.maximum(input_alpha[..., None], 1e-4)
            input_mask = warp(source_mask, mapping, (w, h))
            redraw = output[y:y + h, x:x + w]
            alpha = redraw_alpha(redraw, input_alpha)
            registration = register(alpha, input_alpha)
            # Remove the grey matte before warping, then filter premultiplied colour.
            straight = np.clip((redraw - GREY * (1 - alpha[..., None])) / np.maximum(alpha[..., None], 1e-4), 0, 255)
            registered_alpha = warp(alpha, registration.matrix, (w, h))
            pm = warp(straight * alpha[..., None], registration.matrix, (w, h))
            colour = pm / np.maximum(registered_alpha[..., None], 1e-4)
            paint = paint_channels(colour, registered_alpha, input_colour, input_mask, palette[16:32])
            pivot = affine_point(registration.matrix, affine_point(mapping, md['pivot']))
            frames.append(Frame(k, int(cell['facing']), colour, registered_alpha, paint, pivot, input_alpha, registration))
            if registration.iou < 0.85:
                warnings.warn(f'{type_name}/{part}/{k:03d}: registration IoU {registration.iou:.4f} < 0.85', stacklevel=2)
    required = {'body', 'turret'} if engine.get('turreted', any(f['part'] == 'turret' for f in engine['frames'])) else {'body'}
    # A building's voxel turret (rules TurretAnimIsVoxel, library voxel id 'NAFLAK:turret') has only turret/barrel
    # sections: the renderer asks for the 'turret' atlas alone, so a sheet set of just that part is complete.
    if ':' in type_name and set(parts) == {'turret'}:
        required = {'turret'}
    if set(parts) != required:
        raise ValueError(f'Incomplete part set: expected {sorted(required)}, got {sorted(parts)}')
    facings = None
    for part, frames in parts.items():
        frames.sort(key=lambda f: f.facing)
        current = [f.facing for f in frames]
        n = len(current)
        if n not in (16, 32) or current != [i * 256 // n for i in range(n)]:
            raise ValueError(f'{part}: expected 16 or 32 unique, uniformly spaced facings starting at zero')
        if facings is not None and current != facings:
            raise ValueError('All parts must have the same facing set')
        facings = current
    if not facings or scale is None:
        raise ValueError('No frames')
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'type': type_name, 'frames': len(facings), 'facingStep': 256 // len(facings),
                'scale': scale, 'jacobian': (BAKE_JACOBIAN * scale).tolist(),
                'house': {'first': 16, 'count': 16} if any(np.any(f.paint[..., 0]) for fs in parts.values() for f in fs) else None,
                'parts': {}, 'registration': []}
    stem = file_stem(type_name)
    for part, frames in parts.items():
        colour, paint, packed = pack_frames(frames)
        colour_name, paint_name = f'{stem}_{part}.png', f'{stem}_{part}_paint.png'
        Image.fromarray(colour).save(out / colour_name)
        Image.fromarray(paint).save(out / paint_name)
        manifest['parts'][part] = {'colour': colour_name, 'paint': paint_name,
                                    'size': [colour.shape[1], colour.shape[0]], 'frames': packed}
        for f in frames:
            r = f.registration
            manifest['registration'].append({'part': part, 'k': f.k, 'iou': r.iou, 'scale': r.scale, 'dx': r.dx, 'dy': r.dy})
        if review:
            review_sheet(frames, review / f'{stem}_{part}.png')
    # Publish only complete types; an interrupted build must not add a partial manifest to the index.
    temporary = out / f'{stem}.json.tmp'
    temporary.write_text(json.dumps(manifest, indent=2) + '\n')
    temporary.replace(out / f'{stem}.json')
    return manifest


SHEET_SIZE = (1536, 1024)


def compose_sheet(bake: Path, part: str, out: Path, facings: list[int], cols: int = 4, rows: int = 4,
                  scale: float | None = None, margin: int = 22, scale_part: str = 'all') -> dict:
    """Write an image-model input sheet (input.png + input.json) from a bake's engine renders.

    Each listed facing's black/white pair is un-matted, resampled premultiplied at ``scale`` (Lanczos) and composited
    over flat grey, centred in its grid cell on that facing's bounding box. Without ``scale`` the largest scale (at most
    2) that fits every facing of ``scale_part`` in a cell with ``margin`` is used, so body and turret sheets of one
    vehicle share a scale. input.json records sheet_xy = dst_origin + scale * (bake_xy - src_centre) per cell, which
    ``build`` inverts.
    """
    meta = json.loads((bake / 'meta.json').read_text())
    width, height = SHEET_SIZE
    cw, ch = width // cols, height // rows
    if len(facings) > cols * rows:
        raise ValueError(f'{len(facings)} facings do not fit a {cols}x{rows} sheet')

    def load(name: str, k: int) -> tuple[np.ndarray, np.ndarray]:
        colour, alpha = unmatte(rgb(bake / 'engine' / f'{name}_{k:03d}_k.png'),
                                rgb(bake / 'engine' / f'{name}_{k:03d}_w.png'))
        return np.where(alpha[..., None] > 0, colour, 0), alpha

    def bbox(alpha: np.ndarray) -> tuple[int, int, int, int]:
        ys, xs = np.nonzero(alpha > 0.02)
        if not len(xs):
            raise ValueError('empty bake frame')
        return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1

    if scale is None:
        ks = sorted({int(f['k']) for f in meta['looks']['engine']['frames'] if f.get('part', scale_part) == scale_part})
        ks = ks or sorted({int(f['k']) for f in meta['looks']['engine']['frames']})
        mw = mh = 1
        for k in ks:
            x0, y0, x1, y1 = bbox(load(scale_part, k)[1])
            mw, mh = max(mw, x1 - x0), max(mh, y1 - y0)
        scale = min(2.0, (cw - 2 * margin) / mw, (ch - 2 * margin) / mh)
    count = len({int(f['k']) for f in meta['looks']['engine']['frames']}) or 1
    facing_of = {int(f['k']): int(f['facing']) for f in meta['looks']['engine']['frames'] if 'facing' in f}
    sheet = np.full((height, width, 3), GREY, np.float32)
    cells = []
    pad = 4
    for i, k in enumerate(facings):
        colour, alpha = load(part, k)
        x0, y0, x1, y1 = bbox(alpha)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        col, row = i % cols, i // cols
        ox, oy = col * cw + cw / 2, row * ch + ch / 2
        ys, xs = slice(max(0, y0 - pad), y1 + pad), slice(max(0, x0 - pad), x1 + pad)
        sx, sy = xs.start, ys.start
        crop, crop_alpha = (colour * alpha[..., None])[ys, xs], alpha[ys, xs]
        w2, h2 = max(1, round(crop.shape[1] * scale)), max(1, round(crop.shape[0] * scale))
        resize = lambda a: np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((w2, h2), Image.LANCZOS))
        premultiplied = np.stack([resize(crop[..., j]) for j in range(3)], -1)
        coverage = np.clip(resize(crop_alpha), 0, 1)
        ix, iy = int(round(ox + scale * (sx - cx))), int(round(oy + scale * (sy - cy)))
        tx0, ty0 = max(ix, 0), max(iy, 0)
        tx1, ty1 = min(ix + w2, width), min(iy + h2, height)
        region = sheet[ty0:ty1, tx0:tx1]
        src = (slice(ty0 - iy, ty1 - iy), slice(tx0 - ix, tx1 - ix))
        region[:] = np.clip(premultiplied[src], 0, 255) + region * (1 - coverage[src][..., None])
        cells.append({'k': int(k), 'facing': facing_of.get(int(k), round(k * 256 / count) % 256),
                      'src_centre': [float(cx), float(cy)],
                      'dst_origin': [ix - scale * (sx - cx), iy - scale * (sy - cy)], 'cell': [col * cw, row * ch, cw, ch]})
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(sheet, 0, 255).astype(np.uint8)).save(out / 'input.png')
    spec = {'bake': str(bake), 'part': part, 'scale': float(scale), 'size': [width, height], 'cells': cells}
    (out / 'input.json').write_text(json.dumps(spec, indent=1))
    return spec


def manifest_atlases(path: Path, spec: dict) -> list[Path]:
    """Validate the atlas references shared by index building and farm installation."""
    if not isinstance(spec.get('parts'), dict) or not spec['parts']:
        raise ValueError(f'{path.name}: missing atlas parts')
    atlases = set()
    for part in spec['parts'].values():
        for key in ('colour', 'paint'):
            name = part.get(key) if isinstance(part, dict) else None
            if not isinstance(name, str) or Path(name).name != name or not name.endswith('.png'):
                raise ValueError(f'{path.name}: invalid {key} atlas name: {name!r}')
            atlas = path.parent / name
            if not atlas.is_file():
                raise ValueError(f'{path.name}: missing atlas {name}')
            atlases.add(atlas)
    return sorted(atlases)


def build_index(out: Path) -> dict:
    types = {}
    for path in sorted(out.glob('*.json')):
        if path.name == 'index.json':
            continue
        spec = json.loads(path.read_text())
        if spec.get('version') == 1 and spec.get('type') and 'parts' in spec:
            manifest_atlases(path, spec)
            types[spec['type']] = path.name
    index = {'version': 1, 'types': types}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'index.json.tmp').write_text(json.dumps(index, indent=2) + '\n')
    (out / 'index.json.tmp').replace(out / 'index.json')
    return index


def install(farm: Path, build_dir: Path, type_name: str) -> list[str]:
    """Install one complete projection type without writing through farm symlinks."""
    import cache_farm

    name = f'{file_stem(type_name)}.json'
    if Path(name).name != name:
        raise ValueError(f'Invalid projection type: {type_name!r}')
    manifest = build_dir / name
    if not manifest.is_file():
        raise ValueError(f'Missing build manifest: {manifest}')
    spec = json.loads(manifest.read_text(encoding='utf-8'))
    if not isinstance(spec, dict) or spec.get('version') != 1 or spec.get('type') != type_name:
        raise ValueError(f'{name}: expected a version 1 manifest for {type_name}')
    atlases = manifest_atlases(manifest, spec)
    index_path = farm / 'vehicles-hd/index.json'
    if not index_path.is_file():
        raise ValueError(f'Missing farm index (an existing index is required): {index_path}')

    def validate_index(index):
        if not isinstance(index, dict) or index.get('version') != 1 or not isinstance(index.get('types'), dict):
            raise ValueError(f'{index_path}: expected a version 1 index with types')

    # Refuse incomplete inputs before installing anything; validate again under the JSON lock.
    validate_index(json.loads(index_path.read_text(encoding='utf-8')))
    files = [*atlases, manifest]
    for path in files:
        cache_farm.install_file(farm, 'vehicles-hd/' + path.name, path)

    def patch(index):
        validate_index(index)
        index['types'][type_name] = name
        index['types'] = dict(sorted(index['types'].items()))

    cache_farm.patch_json(farm, 'vehicles-hd/index.json', patch)
    return [path.name for path in files]


def steel_grade(
    rgba: np.ndarray, paint: np.ndarray, keep: float = 0.3, centre: float = 40.0, half: float = 20.0
) -> np.ndarray:
    """Pull the warm tan/beige the image model drifts hull metal to back toward neutral steel.

    Pixels whose hue lies in the band `centre` +- `half` degrees (default orange-yellow, full effect at 20-60 degrees,
    fading out over 10 degrees; the distance wraps around 360, so centre=0 selects reds) keep
    only `keep` of their chroma; linear luminance is preserved and the grey gets a slight cool tint. House paint
    (paint red channel above 0.3, full protection from 0.7) and alpha are untouched. The approved target frames show
    silver steel hulls, as do the original voxels; the redraws of the Soviet hulls came back tan.
    """
    rgba = np.asarray(rgba, np.uint8)
    srgb = rgba[..., :3].astype(np.float64) / 255
    lin = linear_rgb(rgba[..., :3])
    y = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    hi, lo = srgb.max(-1), srgb.min(-1)
    r, g, b = srgb[..., 0], srgb[..., 1], srgb[..., 2]
    d = np.maximum(hi - lo, 1e-6)
    hue = np.where(hi == r, ((g - b) / d) % 6, np.where(hi == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    dist = np.abs((hue - centre + 180) % 360 - 180)
    band = np.clip(1 - np.maximum(0, dist - half) / 10, 0, 1)
    protect = np.clip((np.asarray(paint, np.float64) / 255 - 0.3) / 0.4, 0, 1)
    w = (band * (1 - protect) * (1 - keep))[..., None]
    out = lin * (1 - w) + y * np.array([0.97, 1.0, 1.05]) * w
    out = np.where(out <= 0.0031308, out * 12.92, 1.055 * np.clip(out, 0, None) ** (1 / 2.4) - 0.055)
    graded = rgba.copy()
    graded[..., :3] = np.clip(np.round(out * 255), 0, 255).astype(np.uint8)
    return graded


def grade(atlases: Path, parts: list[str], keep: float, centre: float = 40.0, half: float = 20.0) -> dict:
    """steel_grade each <part>.png in place (atomic replace), using <part>_paint.png as the paint mask."""
    changed = {}
    for part in parts:
        colour_path, paint_path = atlases / f'{part}.png', atlases / f'{part}_paint.png'
        rgba = np.asarray(Image.open(colour_path).convert('RGBA'))
        paint = np.asarray(Image.open(paint_path).convert('RGB'))[..., 0]
        graded = steel_grade(rgba, paint, keep, centre, half)
        tmp = colour_path.with_suffix('.grade.png')
        Image.fromarray(graded, 'RGBA').save(tmp)
        tmp.replace(colour_path)
        changed[part] = int((np.abs(graded.astype(int) - rgba.astype(int)).max(-1) > 2).sum())
    return changed


def lift_lightness(rgba: np.ndarray, paint: np.ndarray, gamma: float,
                   protect_lo: float = 0.3, protect_hi: float = 0.7) -> np.ndarray:
    """Lift Lab lightness while preserving chroma, alpha and protected RGB bytes."""
    if not 0 < gamma <= 1:
        raise ValueError('gamma must satisfy 0 < gamma <= 1')
    if not 0 <= protect_lo < protect_hi <= 1:
        raise ValueError('paint protection must satisfy 0 <= protect_lo < protect_hi <= 1')
    rgba = np.asarray(rgba, np.uint8)
    paint = np.asarray(paint, np.float32)
    if rgba.ndim != 3 or rgba.shape[-1] != 4 or paint.shape != rgba.shape[:2]:
        raise ValueError('Expected an RGBA image and a matching paint red channel')
    result = rgba.copy()
    if gamma == 1:
        return result
    weight = 1 - np.clip((paint / 255 - protect_lo) / (protect_hi - protect_lo), 0, 1)
    active = (weight > 1e-3) & (rgba[..., 3] != 0)
    if not active.any():
        return result
    # Float conversion gives physical L*/a*/b* units from the original uint8 RGB.
    lab = cv2.cvtColor(rgba[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lightness = lab[..., 0]
    lifted = 100 * (lightness / 100) ** gamma
    lab[..., 0] = lightness + (lifted - lightness) * weight
    colour = np.clip(np.rint(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB) * 255), 0, 255).astype(np.uint8)
    # Protected and transparent texels must not acquire Lab round-trip drift.
    result[..., :3][active] = colour[active]
    return result


def load_type_build(src_dir: Path, out_dir: Path, type_name: str) -> tuple[Path, Path, bytes, dict]:
    """Discover a complete source type and reject outputs within its library."""
    if re.fullmatch(r'[A-Za-z0-9_]+', type_name) is None:
        raise ValueError(f'Invalid projection type: {type_name!r}')
    src_dir, out_dir = Path(src_dir).resolve(), Path(out_dir).resolve()
    if out_dir == src_dir or src_dir in out_dir.parents:
        raise ValueError('Output directory must not be the source directory or inside it')
    manifest = src_dir / f'{type_name}.json'
    if not manifest.is_file():
        raise ValueError(f'Missing build manifest: {manifest}')
    manifest_bytes = manifest.read_bytes()
    spec = json.loads(manifest_bytes)
    if not isinstance(spec, dict) or spec.get('version') != 1 or spec.get('type') != type_name:
        raise ValueError(f'{manifest.name}: expected a version 1 manifest for {type_name}')
    manifest_atlases(manifest, spec)
    return src_dir, out_dir, manifest_bytes, spec


def publish_atlas(out_dir: Path, name: str, data: np.ndarray | bytes):
    """Atomically publish image or file bytes without following destination symlinks."""
    with tempfile.NamedTemporaryFile(dir=out_dir, suffix='.tmp', delete=False) as temporary:
        path = Path(temporary.name)
        try:
            if isinstance(data, bytes):
                temporary.write(data)
            else:
                Image.fromarray(data).save(temporary, format='PNG')
        except BaseException:
            path.unlink(missing_ok=True)
            raise
    try:
        # Replace destination symlinks rather than writing through them into the source.
        path.replace(out_dir / name)
    finally:
        path.unlink(missing_ok=True)


def lift(src_dir: Path, out_dir: Path, type_name: str, gamma: float) -> dict[str, int]:
    """Write a complete lifted type build to a separate directory, publishing files atomically."""
    if not 0 < gamma <= 1:
        raise ValueError('gamma must satisfy 0 < gamma <= 1')
    src_dir, out_dir, manifest_bytes, spec = load_type_build(src_dir, out_dir, type_name)
    out_dir.mkdir(parents=True, exist_ok=True)

    changed = {}
    for part, entry in spec['parts'].items():
        with Image.open(src_dir / entry['colour']) as image:
            rgba = np.asarray(image.convert('RGBA'))
        with Image.open(src_dir / entry['paint']) as image:
            paint = np.asarray(image.convert('RGB'))[..., 0]
        lifted = lift_lightness(rgba, paint, gamma)
        publish_atlas(out_dir, entry['colour'], lifted)
        publish_atlas(out_dir, entry['paint'], (src_dir / entry['paint']).read_bytes())
        changed[part] = int(np.count_nonzero(np.any(lifted != rgba, axis=-1)))
    # Publish the unchanged manifest only after all of its atlases are written.
    publish_atlas(out_dir, f'{type_name}.json', manifest_bytes)
    return changed



def chroma_lock(design, redraw, background=(118, 118, 118), sigma: float = 6.0, strength: float = 1.0,
                paint_chroma: float = 42.0) -> np.ndarray:
    """Restore the design sheet's low-frequency hue/saturation on an aligned image-model redraw sheet.

    The image model sometimes repaints a faction's hull colour (Yuri's olive khaki came back as neutral steel). In
    CIE Lab the redraw keeps its lightness and its fine chroma detail (panel lines, wear, highlights) while the
    Gaussian low-pass of a*/b* (sigma in sheet pixels, normalised over the foreground) is replaced by the design's.
    Strongly saturated texels (house paint, lamps, chroma above paint_chroma) are neither sources nor targets: the
    paint becomes the house colour later and lamps keep the redraw's colour. Background = the sheet's flat fill.
    """
    design = np.asarray(design, np.uint8)[..., :3]
    redraw = np.asarray(redraw, np.uint8)
    rgb = redraw[..., :3]
    bg = np.asarray(background, np.int32)
    fg_design = (np.abs(design.astype(np.int32) - bg).max(-1) > 6).astype(np.float32)
    fg_redraw = (np.abs(rgb.astype(np.int32) - bg).max(-1) > 6).astype(np.float32)
    lab_d = cv2.cvtColor(design.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab_r = cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    src = fg_design * (np.hypot(lab_d[..., 1], lab_d[..., 2]) < paint_chroma)
    # Full correction below paint_chroma, fading out over 8 chroma units above it.
    target = fg_redraw * np.clip((paint_chroma + 8 - np.hypot(lab_r[..., 1], lab_r[..., 2])) / 8, 0, 1)

    def low_pass(ab, weight):
        num = cv2.GaussianBlur(ab * weight[..., None], (0, 0), sigma)
        den = cv2.GaussianBlur(weight, (0, 0), sigma)[..., None]
        return num / np.maximum(den, 1e-4)

    shift = low_pass(lab_d[..., 1:], src) - low_pass(lab_r[..., 1:], (target > 0.99).astype(np.float32))
    out = lab_r.copy()
    out[..., 1:] += strength * shift * target[..., None]
    locked = np.clip(cv2.cvtColor(out, cv2.COLOR_LAB2RGB) * 255 + 0.5, 0, 255).astype(np.uint8)
    result = redraw.copy()
    result[..., :3] = np.where(fg_redraw[..., None] > 0, locked, rgb)
    return result


def camo_lock(design, redraw, sigma_ab=2.5, l_lo=1.5, l_hi=8.0, l_strength=0.6, l_base=0.0,
              l_base_sigma=6.0, paint_chroma=42.0, chroma_gain=1.0):
    """Restore camouflage lightness and hull chroma that an image-model redraw turned into steel grey.

    Soviet aircraft lost their camouflage blotches and the Kirov's tan envelope. Band-passed design lightness
    brings back the blotches without voxel stair-steps or baked shading; low-pass chroma restores the tan hue.
    The prototype's final Lab round-trip is retained even at zero transfer (it can change a channel by one byte).
    """
    design = np.asarray(design, np.uint8)[..., :3]
    bg = tuple(int(v) for v in design[0, 0])
    locked = chroma_lock(design, redraw, bg, sigma_ab, 1.0, paint_chroma)
    rgb = locked[..., :3]
    bga = np.asarray(bg, np.int32)
    fg_d = (np.abs(design.astype(np.int32) - bga).max(-1) > 6).astype(np.float32)
    fg_r = (np.abs(rgb.astype(np.int32) - bga).max(-1) > 6).astype(np.float32)
    lab_d = cv2.cvtColor(design.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab_r = cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    src = fg_d * (np.hypot(lab_d[..., 1], lab_d[..., 2]) < paint_chroma)
    tgt = fg_r * np.clip((paint_chroma + 8 - np.hypot(lab_r[..., 1], lab_r[..., 2])) / 8, 0, 1)

    def lp(x, w, s):
        return cv2.GaussianBlur(x * w, (0, 0), s) / np.maximum(cv2.GaussianBlur(w, (0, 0), s), 1e-4)

    band = lp(lab_d[..., 0], src, l_lo) - lp(lab_d[..., 0], src, l_hi)
    cover = np.clip(cv2.GaussianBlur(src, (0, 0), l_lo) * 1.5, 0, 1)
    out = lab_r.copy()
    base = lp(lab_d[..., 0], src, l_base_sigma) - lp(lab_r[..., 0], (tgt > 0.99).astype(np.float32), l_base_sigma)
    out[..., 0] = np.clip(out[..., 0] + (l_strength * band * cover + l_base * base) * tgt, 0, 100)
    out[..., 1:] *= (1 + (chroma_gain - 1) * tgt)[..., None]
    res = np.clip(cv2.cvtColor(out, cv2.COLOR_LAB2RGB) * 255 + 0.5, 0, 255).astype(np.uint8)
    result = np.asarray(redraw, np.uint8).copy()
    result[..., :3] = np.where(fg_r[..., None] > 0, res, np.asarray(redraw)[..., :3])
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    builder = commands.add_parser('build')
    builder.add_argument('--type', required=True)
    builder.add_argument('--bake', type=Path, required=True)
    builder.add_argument('--sheets', nargs='+', type=Path, required=True)
    builder.add_argument('--palettes', type=Path, required=True)
    builder.add_argument('--house-key', default='unit@BakeA')
    builder.add_argument('--out', type=Path, required=True)
    builder.add_argument('--review', type=Path)
    sheeter = commands.add_parser('sheet', help='compose an image-model input sheet from a bake')
    sheeter.add_argument('--bake', type=Path, required=True)
    sheeter.add_argument('--part', required=True)
    sheeter.add_argument('--out', type=Path, required=True)
    sheeter.add_argument('--facings', required=True, help='bake frame indices: k0,k1,... or a-b')
    sheeter.add_argument('--cols', type=int, default=4)
    sheeter.add_argument('--rows', type=int, default=4)
    sheeter.add_argument('--scale', type=float)
    index = commands.add_parser('build-index')
    index.add_argument('--out', type=Path, required=True)
    installer = commands.add_parser('install', help='install a complete type into a copy-on-write cache farm')
    installer.add_argument('--farm', type=Path, required=True)
    installer.add_argument('--build-dir', type=Path, required=True)
    installer.add_argument('--type', required=True)
    grader = commands.add_parser('grade', help='steel_grade built colour atlases in place')
    grader.add_argument('--out', type=Path, required=True)
    grader.add_argument('--parts', nargs='+', required=True)
    grader.add_argument('--keep', type=float, default=0.3)
    grader.add_argument('--hue', type=float, default=40.0, help='centre of the graded hue band, degrees')
    grader.add_argument('--half', type=float, default=20.0, help='half width of the band at full effect, degrees')
    lifter = commands.add_parser('lift', help='lift hull lightness into a separate complete type build')
    lifter.add_argument('--src', type=Path, required=True)
    lifter.add_argument('--out', type=Path, required=True)
    lifter.add_argument('--type', required=True)
    lifter.add_argument('--gamma', type=float, required=True, help='lightness exponent, 0 < gamma <= 1')
    locker = commands.add_parser('lock', help='restore design colours and optionally camouflage on a redraw sheet')
    locker.add_argument('--design', type=Path, required=True, help='image-model input sheet (input.png)')
    locker.add_argument('--redraw', type=Path, required=True, help='image-model result (output.png)')
    locker.add_argument('--out', type=Path, required=True)
    locker.add_argument('--sigma', type=float, default=6.0)
    locker.add_argument('--strength', type=float, default=1.0, help='chroma-only lock weight (default: 1)')
    locker.add_argument('--l-strength', type=float, default=0.0, help='design lightness band-pass weight (default: 0)')
    locker.add_argument('--l-lo', type=float, default=1.5, help='fine lightness cutoff, sheet pixels (default: 1.5)')
    locker.add_argument('--l-hi', type=float, default=8.0, help='coarse lightness cutoff, sheet pixels (default: 8)')
    locker.add_argument('--l-base', type=float, default=0.0, help='low-pass lightness transfer weight (default: 0)')
    locker.add_argument('--chroma-gain', type=float, default=1.0, help='hull chroma multiplier (default: 1)')
    args = parser.parse_args(argv)
    if args.command == 'lock':
        with Image.open(args.design) as im:
            design = np.asarray(im.convert('RGB'))
        with Image.open(args.redraw) as im:
            mode = 'RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB'
            redraw = np.asarray(im.convert(mode))
        if design.shape[:2] != redraw.shape[:2]:
            raise SystemExit(f'size mismatch: design {design.shape[:2]} vs redraw {redraw.shape[:2]}')
        # Keep the redraw's mode so downstream registration sees the same file layout.
        if (args.l_strength, args.l_lo, args.l_hi, args.l_base, args.chroma_gain) != (0.0, 1.5, 8.0, 0.0, 1.0):
            locked = camo_lock(design, redraw, sigma_ab=args.sigma, l_lo=args.l_lo, l_hi=args.l_hi,
                               l_strength=args.l_strength, l_base=args.l_base, chroma_gain=args.chroma_gain)
        else:
            locked = chroma_lock(design, redraw, tuple(int(v) for v in design[0, 0]), args.sigma, args.strength)
        Image.fromarray(locked, mode).save(args.out)
        return
    if args.command == 'sheet':
        if '-' in args.facings:
            first, last = map(int, args.facings.split('-'))
            facings = list(range(first, last + 1))
        else:
            facings = [int(v) for v in args.facings.split(',')]
        spec = compose_sheet(args.bake, args.part, args.out, facings, args.cols, args.rows, args.scale)
        print(json.dumps({'scale': spec['scale'], 'cells': len(spec['cells'])}))
    elif args.command == 'build-index':
        print(json.dumps(build_index(args.out), indent=2))
    elif args.command == 'install':
        try:
            names = install(args.farm, args.build_dir, args.type)
        except (OSError, ValueError) as error:
            parser.error(str(error))
        for name in names:
            print(f'installed vehicles-hd/{name}')
        print(f'index {args.type} -> {file_stem(args.type)}.json')
    elif args.command == 'grade':
        print(json.dumps(grade(args.out, args.parts, args.keep, args.hue, args.half), indent=2))
    elif args.command == 'lift':
        try:
            changed = lift(args.src, args.out, args.type, args.gamma)
        except (OSError, ValueError) as error:
            parser.error(str(error))
        print(json.dumps(changed, indent=2))
        return 0
    else:
        spec = build(args.type, args.bake, args.sheets, args.palettes, args.house_key, args.out, args.review)
        print(json.dumps({**{k: spec[k] for k in ('type', 'frames', 'facingStep', 'scale', 'jacobian', 'house')},
                          'parts': {p: {'size': v['size'], 'frames': len(v['frames'])} for p, v in spec['parts'].items()},
                          'iou': {p: {'min': min(r['iou'] for r in spec['registration'] if r['part'] == p),
                                      'mean': float(np.mean([r['iou'] for r in spec['registration'] if r['part'] == p])),
                                      'below_0.85': sum(r['iou'] < 0.85 for r in spec['registration'] if r['part'] == p)}
                                  for p in spec['parts']}}, indent=2))


if __name__ == '__main__':
    main()
