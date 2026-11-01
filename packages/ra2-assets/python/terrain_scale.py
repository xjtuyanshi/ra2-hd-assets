"""Fitted (fractional-scale) whole-map terrain composites; the Python side of ra2-assets src/terrainScale.ts.

A map whose composite would exceed the renderer's 16384 px texture side at the requested integer scale is fitted at
the largest multiple of 1/256 that fits; each side is ceil(side * scale). Pixel x of such an image covers exactly
[x / scale, (x + 1) / scale) scale-1 pixels (the last column/row may extend past the original edge), so manifest
`terrainMap.scale` maps engine pixels to image pixels everywhere. Integer scales behave as before.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

FIT_SCALE_DENOMINATOR = 256


def is_integer_scale(scale: float) -> bool:
    return float(scale).is_integer()


def check_scale(scale: float) -> float:
    """A valid terrainMap scale: positive, and an integer or a multiple of 1/256 (what the fitting tools write)."""
    value = float(scale)
    if not value > 0 or not math.isfinite(value):
        raise ValueError(f"terrainMap scale must be positive, not {scale!r}")
    if not (value * FIT_SCALE_DENOMINATOR).is_integer():
        raise ValueError(f"terrainMap scale {scale!r} is neither an integer nor a multiple of 1/{FIT_SCALE_DENOMINATOR}")
    return value


def scaled_size(width: int, height: int, scale: float) -> tuple[int, int]:
    """(width, height) of a composite at `scale`: ceil per side (exact for integer and dyadic scales)."""
    scale = check_scale(scale)
    return math.ceil(width * scale), math.ceil(height * scale)


def upsample(image: np.ndarray, scale: float, size: tuple[int, int], interpolation: int) -> np.ndarray:
    """Resample a scale-1 image to a composite of `size` (width, height) at `scale`, pixel centres registered exactly
    (cv2.resize would stretch a rounded-up size by size / original instead). Edges replicate, as cv2.resize does."""
    s = check_scale(scale)
    matrix = np.array([[s, 0, (s - 1) / 2], [0, s, (s - 1) / 2]], np.float64)
    return cv2.warpAffine(image, matrix, size, flags=interpolation, borderMode=cv2.BORDER_REPLICATE)


def _area_axis(values: np.ndarray, step: float, count: int, axis: int) -> np.ndarray:
    """Exact area means along `axis`: output k averages [k * step, (k + 1) * step), clipped to the input."""
    n = values.shape[axis]
    moved = np.moveaxis(values, axis, 0)
    cumulative = np.concatenate([np.zeros((1,) + moved.shape[1:], np.float64), np.cumsum(moved, 0, np.float64)])
    edges = np.minimum(np.arange(count + 1, dtype=np.float64) * step, n)
    whole = np.floor(edges).astype(np.int64)
    part = edges - whole
    inside = np.minimum(whole, n - 1)
    shape = (-1,) + (1,) * (moved.ndim - 1)
    integral = cumulative[whole] + part.reshape(shape) * moved[inside]
    span = (edges[1:] - edges[:-1]).reshape(shape)
    if (span <= 0).any():
        raise ValueError("area resampling output extends past its input")
    return np.moveaxis((integral[1:] - integral[:-1]) / span, 0, axis)


def area_down(image: np.ndarray, scale: float, size: tuple[int, int]) -> np.ndarray:
    """A composite at `scale` back to scale 1, `size` = (width, height): each output pixel is the exact area mean of
    the composite over [x * scale, (x + 1) * scale) (plain values, e.g. a water mask). Returns float64."""
    s = check_scale(scale)
    width, height = size
    if image.shape[:2] != scaled_size(width, height, s)[::-1]:
        raise ValueError(f"image {image.shape[1]}x{image.shape[0]} is not {width}x{height} at scale {s}")
    rows = _area_axis(np.asarray(image, np.float64), s, height, 0)
    return _area_axis(rows, s, width, 1)
