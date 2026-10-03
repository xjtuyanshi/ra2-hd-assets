"""Read YR native Z-buffer captures (native-NN.json and zbuf-NN.bin).

YR layout evidence: ZBufferClass at 0x7BD130 / 0x437B3D. Coordinates
wrap the BSurface lock address plus header offset into [end-wrap, end).
Values are uint16; smaller means nearer, 0xFFFF means cleared.
"""

import argparse
import json
from pathlib import Path
import struct

import numpy as np
from raster_buffers import circular_u16


def header(native_json):
    z = json.loads(Path(native_json).read_text())['zbuf']
    ints = struct.unpack('<16i', bytes.fromhex(z['hdr']))
    sints = struct.unpack('<16i', bytes.fromhex(z['shdr'])) if z.get('shdr') else None
    return z, ints, sints


def decode(native_json, bin_path, surf_buf=None, pitch=None):
    z, ints, sints = header(native_json)
    start = z['start']
    rx, ry, rw, rh = ints[:4]
    offset = ints[4] & 0xffffffff
    surface = start if surf_buf is None else surf_buf
    out = circular_u16(Path(bin_path).read_bytes(), rw, pitch=pitch,
                       offset=offset, surface_delta=surface-start)
    return out, dict(rect=(rx, ry, rw, rh), off=offset, ints=ints, sints=sints)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native', type=Path)
    parser.add_argument('--buffer', type=Path)
    parser.add_argument('--out', type=Path, help='decoded .npy array; requires --buffer')
    parser.add_argument('--surface', type=lambda value: int(value, 0))
    parser.add_argument('--pitch', type=int)
    args = parser.parse_args(argv)
    z, ints, sints = header(args.native)
    print('zp', hex(z['zp']), 'start', hex(z['start']))
    print('hdr', [hex(value & 0xffffffff) if abs(value) > 100000 else value for value in ints])
    print('surf', sints)
    if args.out and not args.buffer:
        parser.error('--out requires --buffer')
    if args.buffer:
        out, info = decode(args.native, args.buffer, args.surface, args.pitch)
        if args.out:
            np.save(args.out, out)
        print(out.shape, info['rect'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
