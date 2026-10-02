"""Crop frozen whole-guest live pairs and count saturated house-hue pixels.

Inputs are orig-NN.png / hd-NN.png captures of the full 1152x744 engine frame.
Counts are native screenshot pixels, not scale-normalised coverage or object labels.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ENGINE_SIZE = (1152, 744)
GAP = 8


def engine_box_to_pixels(box, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Map engine edges to screenshot pixels, rounding outward on each axis."""
    x0, y0, x1, y1 = box
    width, height = size
    if width <= 0 or height <= 0:
        raise ValueError('Screenshot dimensions must be positive')
    if not all(math.isfinite(edge) for edge in box) or not (
        0 <= x0 < x1 <= ENGINE_SIZE[0] and 0 <= y0 < y1 <= ENGINE_SIZE[1]
    ):
        raise ValueError('Engine box must be non-empty and inside the 1152x744 guest frame')
    # Divide after multiplying so a full-frame edge maps exactly to its integer image dimension.
    return (math.floor(x0 * width / ENGINE_SIZE[0]), math.floor(y0 * height / ENGINE_SIZE[1]),
            math.ceil(x1 * width / ENGINE_SIZE[0]), math.ceil(y1 * height / ENGINE_SIZE[1]))


def house_pixels(image: np.ndarray, hue: tuple[int, int], smin: int = 100, vmin: int = 60) -> int:
    """Count RGB uint8 pixels in an inclusive OpenCV HSV band; LO > HI wraps at zero."""
    lo, hi = hue
    if not (0 <= lo <= 180 and 0 <= hi <= 180 and 0 <= smin <= 255 and 0 <= vmin <= 255):
        raise ValueError('Hue bounds must be 0..180; saturation/value thresholds must be 0..255')
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or not image.size:
        raise ValueError('House pixels require a non-empty RGB uint8 image')
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    band = (h >= lo) & (h <= hi) if lo <= hi else (h >= lo) | (h <= hi)
    return int(np.count_nonzero(band & (s >= smin) & (v >= vmin)))


def side_by_side(orig: Image.Image, hd: Image.Image, labels=('原版', 'HD'),
                 font: ImageFont.ImageFont | None = None) -> Image.Image:
    """Paste native-size crops on white; only a supplied font enables the label strip."""
    strip = 0
    bounds = []
    if font is not None:
        bounds = [font.getbbox(label) for label in labels]
        strip = max(bottom - top for _, top, _, bottom in bounds) + 8
    result = Image.new('RGB', (orig.width + GAP + hd.width, max(orig.height, hd.height) + strip), 'white')
    result.paste(orig.convert('RGB'), (0, strip))
    right = orig.width + GAP
    result.paste(hd.convert('RGB'), (right, strip))
    if font is not None:
        # Clip labels to their own columns so a narrow crop still has a white gap.
        for x, image, label, (left, top, _, _) in zip((0, right), (orig, hd), labels, bounds):
            label_strip = Image.new('RGB', (image.width, strip), 'white')
            ImageDraw.Draw(label_strip).text((4 - left, 4 - top), label, font=font, fill='black')
            result.paste(label_strip, (x, 0))
    return result


def _load_crops(pairs: Path, pair_id: str, box) -> tuple[Image.Image, Image.Image]:
    if not pair_id.isascii() or not pair_id.isdecimal():
        raise ValueError('Pair id must be digits matching the orig-NN.png / hd-NN.png filenames')
    crops = []
    for prefix in ('orig', 'hd'):
        with Image.open(pairs / f'{prefix}-{pair_id}.png') as image:
            crops.append(image.convert('RGB').crop(engine_box_to_pixels(box, image.size)))
    return tuple(crops)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--pairs', type=Path, required=True)
    common.add_argument('--id', required=True)
    common.add_argument('--box', type=float, nargs=4, required=True, metavar=('EX0', 'EY0', 'EX1', 'EY1'))
    crop = commands.add_parser('crop', parents=[common], help='write a side-by-side crop at native screenshot scale')
    crop.add_argument('--out', type=Path, required=True)
    crop.add_argument('--labels', nargs=2, default=('原版', 'HD'))
    crop.add_argument('--font', type=Path, help='TTF/TTC font for labels (20 px); no font means no label strip')
    house = commands.add_parser('house', parents=[common], help='count saturated house-hue pixels in the crops')
    house.add_argument('--hue', type=int, nargs=2, required=True, metavar=('LO', 'HI'))
    house.add_argument('--smin', type=int, default=100)
    house.add_argument('--vmin', type=int, default=60)
    args = parser.parse_args(argv)
    try:
        orig, hd = _load_crops(args.pairs, args.id, args.box)
        if args.command == 'crop':
            font = ImageFont.truetype(str(args.font), 20) if args.font else None
            result = side_by_side(orig, hd, args.labels, font)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            result.save(args.out, format='PNG')
        else:
            n = house_pixels(np.asarray(orig), args.hue, args.smin, args.vmin)
            m = house_pixels(np.asarray(hd), args.hue, args.smin, args.vmin)
            print(json.dumps({'orig': n, 'hd': m, 'ratio': m / max(1, n)}))
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
