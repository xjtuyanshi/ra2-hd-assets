#!/usr/bin/env python3
"""Inpaint light, low-saturation cliff-foot stripes beside a water-mask edge.

Detection uses a vertical water-edge reach and a square shore-ignore reach.
Closing small gaps and growing the selection by one pixel includes the stripe's
antialiased rim. Telea inpainting restores nearby rock/bed colours and preserves
terrain alpha. The output feeds materials.json terrainMap; no JSON is edited.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def prepare(terrain: np.ndarray, water_mask: np.ndarray, shore_ignore: np.ndarray,
            saturation: float = 0.2, value: float = 110, vertical_reach: int = 7,
            cliff_reach: int = 12, inpaint_radius: float = 5) -> tuple[np.ndarray, np.ndarray]:
    """Return repaired RGBA terrain and a uint8 selection mask (255 = inpainted)."""
    if terrain.ndim != 3 or terrain.shape[-1] != 4 or terrain.dtype != np.uint8:
        raise ValueError("terrain must be an RGBA uint8 image")
    if water_mask.shape != terrain.shape[:2] or shore_ignore.shape != terrain.shape[:2]:
        raise ValueError("terrain, water mask and shore ignore must have the same dimensions")
    if not 0 <= saturation <= 1 or not 0 <= value <= 255:
        raise ValueError("saturation must be in [0, 1] and value in [0, 255]")
    if vertical_reach < 0 or cliff_reach < 0 or not np.isfinite(inpaint_radius) or inpaint_radius <= 0:
        raise ValueError("reaches must be nonnegative and inpaint radius must be positive and finite")
    rgb = terrain[..., :3].astype(np.float32)
    water = (water_mask > 127).astype(np.uint8)
    ignore = (shore_ignore > 127).astype(np.uint8)
    maximum, minimum = rgb.max(2), rgb.min(2)
    sat = (maximum - minimum) / np.maximum(maximum, 1)
    grey = (sat < saturation) & (maximum > value)
    reach = np.ones((2 * vertical_reach + 1, 3), np.uint8)
    edge = (cv2.dilate(water, reach) > 0) & (cv2.dilate(1 - water, reach) > 0)
    cliff = cv2.dilate(ignore, np.ones((2 * cliff_reach + 1, 2 * cliff_reach + 1), np.uint8)) > 0
    stripe = (grey & edge & cliff).astype(np.uint8)
    stripe = cv2.morphologyEx(stripe, cv2.MORPH_CLOSE, np.ones((3, 7), np.uint8))
    stripe = cv2.dilate(stripe, np.ones((3, 3), np.uint8)) & edge.astype(np.uint8) & cliff.astype(np.uint8)
    mask = stripe * 255
    result = terrain.copy()
    if stripe.any():
        result[..., :3] = cv2.inpaint(terrain[..., :3][..., ::-1].copy(), mask,
                                    inpaint_radius, cv2.INPAINT_TELEA)[..., ::-1]
    return result, mask


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--terrain", required=True, type=Path)
    parser.add_argument("--water-mask", required=True, type=Path)
    parser.add_argument("--shore-ignore", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--mask-out", type=Path, help="optional grayscale inpaint selection")
    parser.add_argument("--saturation", type=float, default=0.2, help="maximum saturation (default: 0.2)")
    parser.add_argument("--value", type=float, default=110, help="minimum value, 0..255 (default: 110)")
    parser.add_argument("--vertical-reach", type=int, default=7, help="water-edge reach in composite pixels")
    parser.add_argument("--cliff-reach", type=int, default=12, help="shore-ignore reach in composite pixels")
    parser.add_argument("--inpaint-radius", type=float, default=5, help="Telea radius in composite pixels")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        with Image.open(args.terrain) as image:
            terrain = np.array(image.convert("RGBA"))
        with Image.open(args.water_mask) as image:
            water = np.array(image.convert("L"))
        with Image.open(args.shore_ignore) as image:
            ignore = np.array(image.convert("L"))
        result, mask = prepare(terrain, water, ignore, args.saturation, args.value,
                               args.vertical_reach, args.cliff_reach, args.inpaint_radius)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(result).save(args.out, compress_level=3)
        if args.mask_out:
            args.mask_out.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(mask).save(args.mask_out)
        print("stripe px", int((mask > 0).sum()))
    except (OSError, ValueError, cv2.error) as error:
        print(f"cliff_foot_stripe: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
