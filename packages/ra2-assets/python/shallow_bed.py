#!/usr/bin/env python3
"""Replace dark waterline strokes with nearby sand, preserving fine texture.

Inputs use the 2x composite convention of lake_shore: CELL is 84 composite
pixels, ground distances stretch image y by two, and painting uses gamma 2.2
linear light. Bed repainting is opt-in. Stroke correction keeps dark rocks;
cliff feet and alpha are preserved. Float32 working fields are tiled instead
of image-sized.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from PIL import Image

from lake_shore import CELL, box_arg

Image.MAX_IMAGE_PIXELS = None
GAMMA = 2.2
SIGMA = 0.12 * CELL
DEFAULT_DEBUG_BOX = (1900, 2400, 2700, 2950)
Box = tuple[int, int, int, int]


def smoothstep(lo: float, hi: float, values: np.ndarray) -> np.ndarray:
    """Return a clamped cubic transition as float32."""
    t = np.clip((values - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def lab(rgb: np.ndarray) -> np.ndarray:
    """Convert uint8 or normalized float32 sRGB to conventional CIE L*a*b*."""
    if rgb.dtype == np.uint8:
        rgb = rgb.astype(np.float32) / 255
    return cv2.cvtColor(np.ascontiguousarray(rgb, dtype=np.float32), cv2.COLOR_RGB2LAB)


def ground_distance(seeds: np.ndarray) -> np.ndarray:
    """Return exact pixel distances with y stretched x2, or infinity without seeds.

    Seeds occupy only even rows of the stretched raster, so vertical distances
    are measured between pixel centres rather than between repeated row edges.
    """
    height, width = seeds.shape
    if not seeds.any():
        return np.full((height, width), np.inf, np.float32)
    raster = np.ones((height * 2 - 1, width), np.uint8)
    raster[::2][seeds] = 0
    distance = cv2.distanceTransform(raster, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    return distance[::2].copy()


def beach_edge(water: np.ndarray, ignore: np.ndarray) -> np.ndarray:
    """Find water pixels touching non-ignored land in the eight-neighbourhood."""
    land = (~water & ~ignore).astype(np.uint8)
    return water & (cv2.dilate(land, np.ones((3, 3), np.uint8)) != 0)


def _expand(box: Box, shape: tuple[int, int], rx: int, ry: int) -> Box:
    x0, y0, x1, y1 = box
    return max(0, x0 - rx), max(0, y0 - ry), min(shape[1], x1 + rx), min(shape[0], y1 + ry)


def _slice(box: Box) -> tuple[slice, slice]:
    return slice(box[1], box[3]), slice(box[0], box[2])


def _relative(inner: Box, outer: Box) -> tuple[slice, slice]:
    return slice(inner[1] - outer[1], inner[3] - outer[1]), slice(inner[0] - outer[0], inner[2] - outer[0])


def _tiles(shape: tuple[int, int], size: int):
    for y in range(0, shape[0], size):
        for x in range(0, shape[1], size):
            yield x, y, min(x + size, shape[1]), min(y + size, shape[0])


def _signed_distance(edge: np.ndarray, water: np.ndarray, box: Box,
                     reach: float = 1.0) -> np.ndarray:
    # Include every seed that can affect the configured distance bands.
    outer = _expand(box, edge.shape, int(np.ceil(reach * CELL)) + 1,
                    int(np.ceil(reach * CELL / 2)) + 1)
    distance = ground_distance(edge[_slice(outer)])[_relative(box, outer)].copy() / CELL
    distance[~water[_slice(box)]] *= -1
    return distance


def _blur(field: np.ndarray, sigma: float = SIGMA) -> np.ndarray:
    rx, ry = int(np.ceil(4 * sigma)), int(np.ceil(2 * sigma))
    return cv2.GaussianBlur(field, (2 * rx + 1, 2 * ry + 1), sigma,
                            sigmaY=sigma / 2, borderType=cv2.BORDER_REFLECT_101)


def _nearest_sand(terrain: np.ndarray, samples: np.ndarray, box: Box,
                  needed: np.ndarray) -> np.ndarray:
    """Propagate nearest sample colours using anisotropic OpenCV pixel labels.

    OpenCV's labelled L2 transform uses its five-pixel chamfer approximation.
    Expand the search until omitted samples cannot be closer to any needed
    pixel. This also handles long vegetated stretches without local samples.
    """
    shape = samples.shape
    radius = int(np.ceil(1.5 * CELL))
    while True:
        outer = _expand(box, shape, radius, (radius + 1) // 2)
        source = samples[_slice(outer)]
        if source.any():
            raster = np.ones((source.shape[0] * 2 - 1, source.shape[1]), np.uint8)
            raster[::2][source] = 0
            distance, labels = cv2.distanceTransformWithLabels(
                raster, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
            sy, sx = _relative(box, outer)
            query_distance = distance[::2][sy, sx]
            # The 3% allowance covers the chamfer approximation near a border.
            xs = np.arange(box[0], box[2], dtype=np.float32)
            ys = np.arange(box[1], box[3], dtype=np.float32)
            mx = np.minimum(xs - outer[0] + 1 if outer[0] else np.inf,
                            outer[2] - xs if outer[2] < shape[1] else np.inf)
            my = np.minimum(2 * (ys - outer[1] + 1) if outer[1] else np.inf,
                            2 * (outer[3] - ys) if outer[3] < shape[0] else np.inf)
            margin = np.minimum(np.broadcast_to(mx, (1, len(xs))),
                                np.broadcast_to(np.asarray(my).reshape(-1, 1), (len(ys), 1)))
            if np.all((query_distance * 1.03 + 2 < margin)[needed]):
                sample_labels = labels[::2][source]
                colours = terrain[_slice(outer)][..., :3][source].astype(np.float32) / 255
                np.power(colours, GAMMA, out=colours)
                lookup = np.zeros((int(sample_labels.max()) + 1, 3), np.float32)
                lookup[sample_labels] = colours
                return lookup[labels[::2][sy, sx]]
            del raster, distance, labels
        if outer == (0, 0, shape[1], shape[0]):
            raise ValueError("shallow bed needs non-green beach sand samples")
        radius *= 2


def prepare(terrain: np.ndarray, water_mask: np.ndarray, ignore_mask: np.ndarray | None = None,
            *, bed_weight: float = 0.0, stroke_inner: float = -0.18,
            stroke_outer: float = 0.04, ring_inner: float = -0.45,
            ring_outer: float = -0.2,
            tile_size: int = 1024) -> tuple[np.ndarray, dict[str, int | float | None]]:
    """Return a new RGBA terrain and change/lightness statistics, without mutation.

    Sand samples lie in the configured land ring, excluding ignored land,
    vegetation (HSV hue 60..170, saturation > .25), and the darkest fifth of
    the land ring in CIE L*. Nearest colours are smoothed in linear light.
    Texture is original linear luminance divided by a 0.12-cell blur, clamped
    to .85..1.15 for strokes and .8..1.2 for the optional bed repainting.
    No noise or random sampling is introduced.
    """
    if terrain.ndim != 3 or terrain.shape[2] != 4 or terrain.dtype != np.uint8:
        raise ValueError("terrain must be uint8 RGBA")
    shape = terrain.shape[:2]
    if water_mask.shape != shape or (ignore_mask is not None and ignore_mask.shape != shape):
        raise ValueError("terrain, water and ignore masks must have the same dimensions")
    if tile_size < 32:
        raise ValueError("tile_size must be at least 32")
    if not np.isfinite([bed_weight, stroke_inner, stroke_outer, ring_inner, ring_outer]).all():
        raise ValueError("weights and distance bands must be finite")
    if not 0 <= bed_weight <= 1:
        raise ValueError("bed_weight must be between 0 and 1")
    if not stroke_inner < 0 <= stroke_outer:
        raise ValueError("stroke band must satisfy inner < 0 <= outer")
    if not ring_inner < ring_outer <= 0:
        raise ValueError("sand ring must satisfy inner < outer <= 0")
    water = water_mask > 127
    ignore = np.zeros(shape, bool) if ignore_mask is None else ignore_mask > 127
    edge = beach_edge(water, ignore)
    result = terrain.copy()
    stats: dict[str, int | float | None] = {
        "pixels_changed": 0, "bed_band_pixels": 0,
        "bed_band_mean_l_before": None, "bed_band_mean_l_after": None,
        "stroke_pixels_replaced": 0,
    }
    if not edge.any():
        return result, stats

    reach = max(1.0, -ring_inner, -stroke_inner, stroke_outer)
    paint_reach = max(1.0, -stroke_inner, stroke_outer)
    samples = np.zeros(shape, bool)
    for box in _tiles(shape, tile_size):
        d = _signed_distance(edge, water, box, reach)
        samples[_slice(box)] = (d > ring_inner) & (d < ring_outer) & ~ignore[_slice(box)]
    if not samples.any():
        raise ValueError("shallow bed needs non-green beach sand samples")
    rgb = terrain[..., :3][samples].reshape(-1, 1, 3)
    lightness = lab(rgb)[:, 0, 0]
    threshold = float(np.percentile(lightness, 20))
    hsv = cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2HSV)[:, 0]
    green = (hsv[:, 0] >= 60) & (hsv[:, 0] <= 170) & (hsv[:, 1] > 0.25)
    samples[samples] = ~green & (lightness >= threshold)
    del rgb, lightness, hsv, green
    if not samples.any():
        raise ValueError("shallow bed needs non-green beach sand samples")

    before_sum = after_sum = 0.0
    # The smoothing halo equals the finite Gaussian support, preventing seams.
    rx, ry = int(np.ceil(4 * SIGMA)), int(np.ceil(2 * SIGMA))
    for box in _tiles(shape, tile_size):
        query = _expand(box, shape, rx, ry)
        core = _relative(box, query)
        d = _signed_distance(edge, water, query, reach)
        band = np.abs(d) <= paint_reach
        if not band[core].any():
            continue
        sand = _nearest_sand(terrain, samples, query, band)
        # Normalized smoothing avoids colour leakage from outside the reference field.
        sand[~band] = 0
        sand = _blur(sand)
        sand /= np.maximum(_blur(band.astype(np.float32)), 1e-8)[..., None]

        outer = _expand(query, shape, int(CELL) + 1, int(CELL / 2) + 1)
        cliff_distance = ground_distance(ignore[_slice(outer)])[_relative(query, outer)] / CELL
        guard = smoothstep(0.25, 0.40, cliff_distance)
        lin = terrain[_slice(query)][..., :3].astype(np.float32) / 255
        np.power(lin, GAMMA, out=lin)
        luminance = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
        texture = luminance / np.maximum(_blur(luminance), 1e-8)
        weight = bed_weight * (1 - smoothstep(0.3, 0.95, d)) * ((d >= 0) & (d <= 0.95)) * guard
        wet = 0.95 - 0.10 * np.clip(d / 0.95, 0, 1)
        target = np.clip(sand * (np.clip(texture, 0.8, 1.2) * wet)[..., None], 0, 1)
        painted = lin + (target - lin) * weight[..., None]

        source_lab = lab(terrain[_slice(query)][..., :3])
        sand_lab = lab(np.clip(sand, 0, 1) ** (1 / GAMMA))
        source_chroma = np.hypot(source_lab[..., 1], source_lab[..., 2])
        sand_chroma = np.hypot(sand_lab[..., 1], sand_lab[..., 2])
        rocks = source_lab[..., 0] < sand_lab[..., 0] - 25
        stroke = ((d > stroke_inner) & (d < stroke_outer) & ~rocks &
                  ((source_lab[..., 0] < sand_lab[..., 0] - 4) |
                   (source_chroma > sand_chroma + 6)))
        del source_lab, sand_lab, source_chroma, sand_chroma
        # Feather the detected mask and fade both band ends; rocks stay untouched
        # even when adjacent stroke pixels would otherwise feather over them.
        stroke_weight = (1 - smoothstep(0, 0.02, ground_distance(stroke) / CELL)) * guard
        stroke_weight *= smoothstep(stroke_inner, stroke_inner + 0.02, d)
        stroke_weight *= 1 - smoothstep(stroke_outer - 0.02, stroke_outer, d)
        stroke_weight *= ~rocks
        stroke_wet = 0.9 + 0.1 * np.clip(d / stroke_inner, 0, 1)
        stroke_target = np.clip(sand * (np.clip(texture, 0.85, 1.15) * stroke_wet)[..., None], 0, 1)
        painted += (stroke_target - painted) * stroke_weight[..., None]
        active = ((weight > 0) | (stroke_weight > 0))[core] & band[core]
        encoded = np.round(np.clip(painted[core], 0, 1) ** (1 / GAMMA) * 255).astype(np.uint8)
        original = terrain[_slice(box)][..., :3]
        changed = active & np.any(encoded != original, axis=2)
        result[_slice(box)][..., :3][changed] = encoded[changed]
        stats["pixels_changed"] += int(changed.sum())
        stats["stroke_pixels_replaced"] += int((stroke[core] & (stroke_weight[core] > 0)).sum())
        bed_band = (d[core] >= 0) & (d[core] <= 0.3)
        count = int(bed_band.sum())
        if count:
            before_sum += float(lab(original[bed_band].reshape(-1, 1, 3))[:, 0, 0].sum(dtype=np.float64))
            after_sum += float(lab(result[_slice(box)][..., :3][bed_band].reshape(-1, 1, 3))[:, 0, 0].sum(dtype=np.float64))
            stats["bed_band_pixels"] += count
    if stats["bed_band_pixels"]:
        stats["bed_band_mean_l_before"] = before_sum / stats["bed_band_pixels"]
        stats["bed_band_mean_l_after"] = after_sum / stats["bed_band_pixels"]
    return result, stats


def write_debug(before: np.ndarray, after: np.ndarray, path: Path, box: Box) -> None:
    """Write before | after at 2x zoom, fitting the JPEG within 2000 pixels wide."""
    if box[0] < 0 or box[1] < 0 or box[2] > before.shape[1] or box[3] > before.shape[0]:
        raise ValueError("debug box must lie inside the terrain")
    comparison = np.concatenate((before[_slice(box)][..., :3], after[_slice(box)][..., :3]), axis=1)
    image = Image.fromarray(comparison)
    scale = min(2.0, 2000 / image.width)
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="JPEG", quality=94, subsampling=0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--terrain", required=True, type=Path, help="2x RGBA painted terrain")
    parser.add_argument("--water", required=True, type=Path, help="grayscale water mask, >127 is water")
    parser.add_argument("--ignore", type=Path, help="grayscale cliff/plateau mask, >127 is ignored")
    parser.add_argument("--bed-weight", type=float, default=0.0,
                        help="bed repainting weight, 0 disables it and 1 applies the full original bed treatment")
    parser.add_argument("--stroke-inner", type=float, default=-0.18, help="landward stroke-band edge in cells")
    parser.add_argument("--stroke-outer", type=float, default=0.04, help="waterward stroke-band edge in cells")
    parser.add_argument("--ring-inner", type=float, default=-0.45, help="outer land sand-reference edge in cells")
    parser.add_argument("--ring-outer", type=float, default=-0.2, help="inner land sand-reference edge in cells")
    parser.add_argument("--out", required=True, type=Path, help="RGBA terrain output (a real file)")
    parser.add_argument("--debug", type=Path, help="optional side-by-side JPEG")
    parser.add_argument("--debug-box", type=box_arg, default=DEFAULT_DEBUG_BOX)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    started = time.monotonic()
    try:
        # Preserve inputs even when an output name already aliases one of them.
        inputs = [args.terrain, args.water] + ([args.ignore] if args.ignore else [])
        outputs = [args.out] + ([args.debug] if args.debug else [])
        if len({p.absolute() for p in outputs}) != len(outputs):
            raise ValueError("terrain and debug output paths must differ")
        for output in outputs:
            if any(output.absolute() == p.absolute() for p in inputs):
                raise ValueError("output paths must differ from input paths")
            if output.exists() and not output.is_symlink() and any(output.samefile(p) for p in inputs):
                raise ValueError("output paths must not overwrite inputs")
        with Image.open(args.terrain) as image:
            terrain = np.array(image.convert("RGBA"))
        with Image.open(args.water) as image:
            water = np.array(image.convert("L"))
        ignore = None
        if args.ignore:
            with Image.open(args.ignore) as image:
                ignore = np.array(image.convert("L"))
        if args.debug:
            x0, y0, x1, y1 = args.debug_box
            if x0 < 0 or y0 < 0 or x1 > terrain.shape[1] or y1 > terrain.shape[0]:
                raise ValueError("debug box must lie inside the terrain")
        # Excess OpenCV threads can slow small tiled transforms on busy machines.
        cv2.setNumThreads(min(4, max(1, cv2.getNumThreads())))
        result, stats = prepare(terrain, water, ignore, bed_weight=args.bed_weight,
                                stroke_inner=args.stroke_inner, stroke_outer=args.stroke_outer,
                                ring_inner=args.ring_inner, ring_outer=args.ring_outer)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        if args.out.is_symlink():
            args.out.unlink()  # Replace only this farm entry, never its target.
        Image.fromarray(result).save(args.out)
        if args.debug:
            if args.debug.is_symlink():
                args.debug.unlink()
            write_debug(terrain, result, args.debug, args.debug_box)
        print("pixels changed:", stats["pixels_changed"])
        if stats["bed_band_pixels"]:
            print("mean L* (0-0.3 cell bed): {:.3f} -> {:.3f}".format(
                stats["bed_band_mean_l_before"], stats["bed_band_mean_l_after"]))
        else:
            print("mean L* (0-0.3 cell bed): n/a (empty band)")
        print("stroke pixels replaced:", stats["stroke_pixels_replaced"])
        print("done", args.out, f"({time.monotonic() - started:.2f} s)")
    except (OSError, ValueError, cv2.error) as error:
        print(f"shallow_bed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
