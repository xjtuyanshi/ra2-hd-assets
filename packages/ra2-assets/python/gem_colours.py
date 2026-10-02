#!/usr/bin/env python3
"""Match HD gem colour families to original indexed frames without changing atlas geometry.

Requires NumPy, Pillow and OpenCV. Images and source records belong outside Git.
All luminances use Rec.709 weights on sRGB values, without linear-light conversion.
"""

from __future__ import annotations

import argparse
import fcntl
import io
import json
import os
from pathlib import Path
import re

import cv2
import numpy as np
from PIL import Image

import cache_farm
from ore_fields import OverlayLibrary, read_image, read_json, write_atomic

GEMS = tuple(f'overlay:GEM{i:02d}' for i in range(1, 13))
FAMILY_NAMES = ('red', 'green', 'blue')
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float64)
N = 64
QUANTILES = (np.arange(N) + 0.5) / N
# Hue window (degrees, wrapping through 0) of the original red gems used as the red reference.
REFERENCE_RED_HUE = (12, 330)


def _hsv(rgb: np.ndarray) -> np.ndarray:
    # Public classification also accepts normalized floating-point RGB/alpha.
    pixels = np.asarray(rgb)
    normalized = pixels.astype(np.float32) / (255 if pixels.dtype == np.uint8 else 1)
    return cv2.cvtColor(normalized.reshape(1, -1, 3), cv2.COLOR_RGB2HSV).reshape(pixels.shape)


def families(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Return -1/red=0/green=1/blue=2 for uint8 or normalized float RGB and alpha."""
    hsv = _hsv(rgb)
    hue, saturation = hsv[..., 0], hsv[..., 1]
    alpha = np.asarray(alpha)
    visible = alpha.astype(np.float32) / (255 if alpha.dtype == np.uint8 else 1) > 0.5
    eligible = visible & (saturation >= 0.12)
    labels = np.full(hue.shape, -1, np.int8)
    for family, mask in enumerate(((hue <= 25) | (hue >= 320),
                                   (hue >= 70) & (hue <= 180),
                                   (hue >= 190) & (hue <= 290))):
        labels[eligible & mask] = family
    return labels


def gem_families(rgba: np.ndarray) -> np.ndarray:
    """Include bright neutral facets only when nearby coloured gems support their family."""
    labels = families(rgba[..., :3], rgba[..., 3])
    candidates = (_hsv(rgba[..., :3])[..., 1] < 0.12) & (rgba[..., 3] > 127.5)
    if not candidates.any():
        return labels
    votes = np.stack([cv2.GaussianBlur((labels == family).astype(np.float32), (0, 0), 2,
                                      borderType=cv2.BORDER_CONSTANT) for family in range(3)], axis=-1)
    winners = votes.argmax(axis=-1)
    candidates &= votes.max(axis=-1) >= 0.35
    light = rgba[..., :3] @ LUMA
    # Use the initial colour labels: promoted glints must never recruit further neutral pixels.
    coloured = labels >= 0
    height, width = labels.shape
    for y, x in np.argwhere(candidates):
        crop = np.s_[max(0, y - 2):min(height, y + 3), max(0, x - 2):min(width, x + 3)]
        neighbours = light[crop][coloured[crop]]
        if neighbours.size and light[y, x] > np.percentile(neighbours, 60):
            labels[y, x] = winners[y, x]
    return labels


def _rects(lib: OverlayLibrary, sprites) -> tuple[int, list[tuple[int, int, int, int]]]:
    names = tuple(dict.fromkeys(sprites))
    if not names:
        raise ValueError('at least one sprite is required')
    pages, rects = set(), set()
    for name in names:
        if name not in lib.library['sprites']:
            raise ValueError(f'unknown sprite: {name}')
        for frame in lib.library['sprites'][name]['frames']:
            rect = tuple(frame['rect'])
            if len(rect) != 4 or any(not isinstance(v, int) or v < 0 for v in rect):
                raise ValueError(f'{name}: invalid frame rectangle')
            if rect[2] == 0 or rect[3] == 0:
                continue
            page = frame.get('page', 0)
            if not isinstance(page, int) or not 0 <= page < len(lib.library['spriteAtlases']):
                raise ValueError(f'{name}: invalid atlas page')
            pages.add(page)
            rects.add(rect)
    if len(pages) != 1:
        raise ValueError('gem frames must share one page with non-empty rectangles')
    return pages.pop(), sorted(rects)


def _original_colours(lib: OverlayLibrary, page: int, sprites) -> dict[int, np.ndarray]:
    sprites = tuple(dict.fromkeys(sprites))
    selected_page, _ = _rects(lib, sprites)
    if page != selected_page:
        raise ValueError('gem frames do not belong to the requested page')
    indexed, palette = lib.page_img(page), lib.palette('theater')
    if indexed.ndim != 2 or palette.shape != (256, 3):
        raise ValueError('original atlas must be indexed and theater palette must have 256 RGB entries')
    samples = [[] for _ in range(3)]
    # Reference frequencies include every frame; HD atlas rectangles are processed only once.
    for x, y, w, h in (frame['rect'] for name in sprites
                       for frame in lib.library['sprites'][name]['frames']):
        if not w or not h:
            continue
        indices = indexed[y:y + h, x:x + w]
        if indices.shape != (h, w):
            raise ValueError('gem rectangle exceeds the original atlas')
        rgb = palette[indices]
        labels = families(rgb, (indices > 0).astype(np.float32))
        hsv = _hsv(rgb)
        saturated = hsv[..., 1] >= 0.30
        # The original frames carry their brown soil bed (hue about 20-30 degrees), which the red window would take
        # for dark red gems: the red reference keeps only true reds.
        red = (hsv[..., 0] <= REFERENCE_RED_HUE[0]) | (hsv[..., 0] >= REFERENCE_RED_HUE[1])
        for family in range(3):
            keep = (labels == family) & saturated & (red if family == 0 else True)
            samples[family].append(rgb[keep])
    return {family: np.concatenate(parts) for family, parts in enumerate(samples)}


def _ramps(samples: dict[int, np.ndarray]) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    ramps = {}
    for family, rgb in samples.items():
        if not len(rgb):
            ramps[family] = (np.empty((0, 3)), np.empty(0))
            continue
        ordered = rgb[np.argsort(rgb @ LUMA, kind='stable')].astype(np.float64)
        edges = np.floor(np.arange(N + 1) * len(ordered) / N).astype(int)
        colours = []
        for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
            # Sparse original palettes can leave bins empty; reuse their nearest ranked texel.
            colours.append(ordered[lo:hi].mean(axis=0) if hi > lo
                           else ordered[min(int(QUANTILES[i] * len(ordered)), len(ordered) - 1)])
        colours = np.array(colours)
        ramps[family] = (colours, np.quantile(ordered @ LUMA, QUANTILES))
    return ramps


def reference_ramps(lib: OverlayLibrary, page: int, sprites=GEMS):
    """Return family -> (64 sRGB bin-mean colours, 64 luminance quantiles), empty if absent."""
    return _ramps(_original_colours(lib, page, sprites))


def luminance_cdfs(crops) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """Build empirical midrank CDFs over every selected frame, including recruited glints."""
    samples = [[] for _ in range(3)]
    for rgba in crops:
        labels, light = gem_families(rgba), rgba[..., :3] @ LUMA
        for family in range(3):
            samples[family].append(light[labels == family])
    cdfs = {}
    for family, parts in enumerate(samples):
        values = np.concatenate(parts) if parts else np.empty(0)
        light, counts = np.unique(values, return_counts=True)
        rank = (np.cumsum(counts) - counts / 2) / max(len(values), 1)
        cdfs[family] = (light, rank)
    return cdfs


def deepen(hd_rgba: np.ndarray, ramps, strength=1.0, hd_cdfs=None) -> np.ndarray:
    """Return a uint8 frame copy; pass page-wide hd_cdfs to keep separate frames consistent."""
    if not 0 <= strength <= 1:
        raise ValueError('strength must be between 0 and 1')
    if hd_rgba.dtype != np.uint8 or hd_rgba.ndim != 3 or hd_rgba.shape[-1] != 4:
        raise ValueError('HD frame must be HxWx4 uint8 RGBA')
    out = hd_rgba.copy()
    if strength == 0:
        return out
    labels, light = gem_families(hd_rgba), hd_rgba[..., :3] @ LUMA
    if hd_cdfs is None:
        hd_cdfs = luminance_cdfs([hd_rgba])
    for family in range(3):
        mask = labels == family
        colours, reference_light = ramps[family]
        source_light, ranks = hd_cdfs[family]
        if not mask.any() or not len(reference_light) or not len(source_light):
            continue
        rank = np.interp(light[mask], source_light, ranks)
        mapped = np.interp(rank, QUANTILES, reference_light)
        # Collapse tied reference quantiles together so interpolation has a well-defined ramp.
        levels, first, counts = np.unique(reference_light, return_index=True, return_counts=True)
        colour = np.add.reduceat(colours, first, axis=0) / counts[:, None]
        target = np.stack([np.interp(mapped, levels, colour[:, channel]) for channel in range(3)], axis=-1)
        rgb = hd_rgba[..., :3][mask].astype(np.float64)
        out[..., :3][mask] = np.clip(np.rint(rgb + (target - rgb) * strength), 0, 255).astype(np.uint8)
    return out


def _stats(rgb: np.ndarray) -> dict:
    if not len(rgb):
        return {'texel_count': 0, 'mean_L_star': None, 'mean_C_star': None}
    lab = cv2.cvtColor(rgb.astype(np.uint8).reshape(1, -1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3)
    lab = lab.astype(np.float64)
    return {'texel_count': len(rgb), 'mean_L_star': float(lab[:, 0].mean() * 100 / 255),
            'mean_C_star': float(np.hypot(lab[:, 1] - 128, lab[:, 2] - 128).mean())}


def _validate(theatre, strength, suffix):
    for name, value in (('theatre', theatre), ('suffix', suffix)):
        if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
            raise ValueError(f'{name} must contain only letters, digits, hyphens and underscores')
    if not 0 <= strength <= 1:
        raise ValueError('strength must be between 0 and 1')


def _source_name(name: str) -> str:
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or path.suffix != '.png':
        raise ValueError('HD source must be a relative PNG path without parent traversal')
    return name


def _prepare(cache_root, theatre, sprites, strength, stage_dir, suffix):
    lib = OverlayLibrary(Path(cache_root), theatre)
    page, rects = _rects(lib, sprites)
    entry = lib.library['spriteAtlasesHd'][page]
    if not entry or entry.get('scale') != 2:
        raise ValueError('gem page requires a 2x HD atlas entry')
    current = _source_name(entry['file'])
    record_path = Path(stage_dir) / f'{suffix}-source.json'
    if current.endswith(f'-{suffix}.png'):
        if not record_path.is_file():
            raise ValueError(f'missing original source record: {record_path}')
        record = read_json(record_path)
        if record.get('theatre') != theatre or record.get('page') != page:
            raise ValueError('source record belongs to a different theatre or page')
        source = _source_name(record['file'])
        if source.endswith(f'-{suffix}.png'):
            raise ValueError('source record must refer to the page before gem colour matching')
    else:
        source = current
    stem = Path(current).stem
    while stem.endswith(f'-{suffix}'):
        stem = stem[:-len(suffix) - 1]
    name = f'{stem}-{suffix}.png'
    before = read_image(lib.directory / source, 'RGBA')
    indexed = lib.page_img(page)
    if before.shape[:2] != tuple(2 * v for v in indexed.shape[:2]):
        raise ValueError('HD atlas dimensions must be twice the original atlas dimensions')
    original = _original_colours(lib, page, sprites)
    ramps = reference_ramps(lib, page, sprites)
    crops = [np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)] for x, y, w, h in rects]
    cdfs = luminance_cdfs(before[crop] for crop in crops)
    after = before.copy()
    samples_before, samples_after = [[] for _ in range(3)], [[] for _ in range(3)]
    for crop in crops:
        rgba = before[crop]
        labels = gem_families(rgba)
        after[crop] = deepen(rgba, ramps, strength, hd_cdfs=cdfs)
        for family in range(3):
            samples_before[family].append(rgba[..., :3][labels == family])
            samples_after[family].append(after[crop][..., :3][labels == family])
    metrics = {'theatre': theatre, 'page': page, 'source_file': source,
               'families': {name: {'original_1x': _stats(original[family]),
                                   'hd_before': _stats(np.concatenate(samples_before[family])),
                                   'hd_after': _stats(np.concatenate(samples_after[family]))}
                            for family, name in enumerate(FAMILY_NAMES)}}
    record = {'file': source, 'theatre': theatre, 'page': page}
    return lib, page, entry, current, name, after, record_path, record, metrics


def apply_page(cache_root, theatre, sprites=GEMS, strength=1.0, stage_dir=None, suffix='l5hgem'):
    """Stage, install and report one gem page under the theatre's composition lock."""
    _validate(theatre, strength, suffix)
    if stage_dir is None:
        raise ValueError('stage_dir is required')
    root, stage = Path(cache_root), Path(stage_dir)
    relative = Path('_library') / theatre
    directory = root / relative
    if stage.resolve().is_relative_to(directory.resolve()):
        raise ValueError('staging directory must be outside the theatre library')
    # Realise directory symlinks before creating the composition lock, just as installers do.
    lock_path = cache_farm._destination(root, str(relative / '.compose.lock'))
    # flock needs no writes: inherited lock symlinks can keep their stable inode without touching the base.
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDONLY, 0o600), 'r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            _, page, entry, current, name, pixels, record_path, record, metrics = _prepare(
                root, theatre, tuple(sprites), strength, stage, suffix)
            stage.mkdir(parents=True, exist_ok=True)
            if not current.endswith(f'-{suffix}.png'):
                write_atomic(record_path, json.dumps(record, indent=2).encode())
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format='PNG')
            staged = stage / name
            write_atomic(staged, buffer.getvalue())
            cache_farm.install_file(root, str(relative / name), staged)

            def patch(data):
                if data['spriteAtlasesHd'][page] != entry:
                    raise ValueError('HD atlas entry changed during gem colour matching')
                data['spriteAtlasesHd'][page]['file'] = name

            cache_farm.patch_json(root, str(relative / 'library.json'), patch)
            # The material sidecar binds each page to its HD atlas file name (the renderer ignores a page whose
            # name differs), so the ore page keeps its normals and crystal highlights only if it follows the rename.
            if (directory / 'normals.json').exists():

                def rebind(data):
                    material = data.get('pages', {}).get(str(page))
                    if material and material.get('atlas') in (current, record['file']):
                        material['atlas'] = name

                cache_farm.patch_json(root, str(relative / 'normals.json'), rebind)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    print(json.dumps(metrics, sort_keys=True))
    return metrics


def metrics_page(cache_root, theatre, sprites=GEMS, strength=1.0, stage_dir=None, suffix='l5hgem'):
    """Report the proposed matching from the same source as apply, without any writes."""
    _validate(theatre, strength, suffix)
    if stage_dir is None:
        raise ValueError('stage_dir is required')
    metrics = _prepare(cache_root, theatre, tuple(sprites), strength, stage_dir, suffix)[-1]
    print(json.dumps(metrics, sort_keys=True))
    return metrics


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('apply', 'metrics'):
        sub = commands.add_parser(command)
        sub.add_argument('--cache-root', required=True, type=Path)
        sub.add_argument('--theatre', required=True)
        sub.add_argument('--strength', type=float, default=1.0)
        sub.add_argument('--stage', required=True, type=Path)
        sub.add_argument('--suffix', default='l5hgem')
        sub.add_argument('--sprites', default=','.join(GEMS))
    args = parser.parse_args(argv)
    try:
        action = apply_page if args.command == 'apply' else metrics_page
        action(args.cache_root, args.theatre, sprites=args.sprites.split(','), strength=args.strength,
               stage_dir=args.stage, suffix=args.suffix)
    except (ValueError, OSError, KeyError, IndexError) as error:
        parser.error(str(error))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
