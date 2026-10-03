"""Lock a civilian vehicle redraw's chroma to its design sheet, retaining redraw lightness/detail."""

import argparse
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from vehicle_projection import chroma_lock


def lock_pixels(design, redraw, strength=1.0, gain=1.0):
    if design.shape[:2] != redraw.shape[:2]:
        raise ValueError('design and redraw dimensions differ')
    bg = tuple(int(value) for value in design[0, 0])
    # Civilian fixed paint is design colour, rather than house remap (threshold 200).
    locked = chroma_lock(design, redraw, bg, 6.0, strength, 200.0)
    if gain != 1.0:
        foreground = np.abs(locked[..., :3].astype(np.int32) - np.asarray(bg, np.int32)).max(-1) > 6
        lab = cv2.cvtColor(locked[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
        lab[..., 1:][foreground] *= gain
        rgb = np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB) * 255 + 0.5, 0, 255).astype(np.uint8)
        locked = locked.copy()
        locked[..., :3][foreground] = rgb[foreground]
    return locked


def stage(source, out, strength=1.0, gain=1.0):
    source, out = Path(source).resolve(), Path(out).absolute()
    target = out.resolve()
    if target == source or source in target.parents or target in source.parents:
        raise ValueError('source and output directories must be disjoint')
    with Image.open(source / 'input.png') as image:
        design = np.asarray(image.convert('RGB'))
    with Image.open(source / 'output.png') as image:
        redraw = np.asarray(image.convert('RGBA'))
    locked = lock_pixels(design, redraw, strength, gain)
    out.mkdir(parents=True, exist_ok=True)
    for path in source.iterdir():
        dst = out / path.name
        if path.name != 'output.png' and not dst.exists() and not dst.is_symlink():
            dst.symlink_to(path)
    tmp = out / 'output.png.part.png'
    Image.fromarray(locked).save(tmp)
    os.replace(tmp, out / 'output.png')
    return out / 'output.png'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--strength', type=float, default=1.0)
    parser.add_argument('--chroma-gain', type=float, default=1.0)
    args = parser.parse_args(argv)
    print('locked', stage(args.source, args.out, args.strength, args.chroma_gain))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
