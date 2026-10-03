"""Pure RGB565 and circular uint16 raster decoding, independent of game headers."""

import numpy as np


def rgb565(values):
    values = np.asarray(values, dtype=np.uint32)
    return np.stack([((values >> 11) & 31) * 255 // 31,
                     ((values >> 5) & 63) * 255 // 63,
                     (values & 31) * 255 // 31], -1).astype(np.uint8)


def circular_u16(data, width, *, pitch=None, offset=0, surface_delta=0):
    pitch = width * 2 if pitch is None else pitch
    if not data or len(data) % 2 or width <= 0 or pitch < width * 2 or pitch % 2:
        raise ValueError('invalid uint16 raster dimensions, pitch or buffer size')
    if offset % 2 or surface_delta % 2:
        raise ValueError('uint16 offsets must be aligned')
    raw = np.frombuffer(data, dtype='<u2')
    height = len(data) // pitch
    if height == 0:
        raise ValueError('buffer has no complete rows')
    index = (np.arange(height)[:, None] * pitch + 2 * np.arange(width)[None, :]
             + surface_delta + offset) % len(data)
    return raw[index // 2]
