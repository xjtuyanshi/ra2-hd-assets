"""Measure low-saturation ground Lab and saturated-highlight brightness in an explicit image crop."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def measure(image, box, scale=1, ground_sat=60, highlight_sat=90):
    x0, y0, x1, y1 = (int(value * scale) for value in box)
    if not (0 <= x0 < x1 <= image.shape[1] and 0 <= y0 < y1 <= image.shape[0]):
        raise ValueError('crop is empty or outside the image')
    crop = image[y0:y1, x0:x1]
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float)
    ground = hsv[:, 1] < ground_sat
    highlight = hsv[:, 1] >= highlight_sat
    if not ground.any() or not highlight.any():
        raise ValueError('crop must contain both ground and saturated highlights')
    lightness = lab[ground, 0] * 100 / 255
    return dict(ground_L=float(np.median(lightness)), ground_sd=float(lightness.std()),
                ground_a=float(np.median(lab[ground, 1] - 128)),
                ground_b=float(np.median(lab[ground, 2] - 128)),
                highlight_V_median=float(np.median(hsv[highlight, 2]) / 255),
                highlight_V_p95=float(np.percentile(hsv[highlight, 2], 95) / 255))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--box', nargs=4, type=int, required=True, metavar=('X0', 'Y0', 'X1', 'Y1'))
    parser.add_argument('--scale', type=float, default=1)
    parser.add_argument('--ground-sat', type=int, default=60)
    parser.add_argument('--highlight-sat', type=int, default=90)
    args = parser.parse_args(argv)
    for path in args.images:
        image = cv2.imread(str(path))
        if image is None:
            raise FileNotFoundError(path)
        print(path.name, json.dumps(measure(image, args.box, args.scale, args.ground_sat, args.highlight_sat)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
