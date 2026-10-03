"""Decode a frozen RGB565 framebuffer using dimensions in a paired native capture."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from raster_buffers import rgb565


def decode(pairs, ident):
    if Path(ident).name != ident or ident in {'.', '..'}:
        raise ValueError('capture id must be one path component')
    pairs = Path(pairs)
    info = json.loads((pairs / f'native-{ident}.json').read_text())
    width, height = info['raw']['w'], info['raw']['h']
    data = (pairs / f'raw-{ident}.rgb565').read_bytes()
    if width <= 0 or height <= 0 or len(data) < width * height * 2 or len(data) % 2:
        raise ValueError('truncated or invalid RGB565 framebuffer')
    values = np.frombuffer(data, dtype='<u2', count=width * height).reshape(height, width)
    return rgb565(values), info


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pairs', type=Path)
    parser.add_argument('id')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args(argv)
    pixels, info = decode(args.pairs, args.id)
    out = args.out or args.pairs / f'rawn-{args.id}.png'
    Image.fromarray(pixels).save(out)
    print(out, pixels.shape[1], pixels.shape[0], info.get('state', {}).get('frame'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
