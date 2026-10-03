"""Align timestamped RGB565 crop recordings with an HD video using nearest timestamps.

Ports the stage-two nrec/MediaRecorder comparison, without a game viewport or
machine font path. Both streams are decoded into memory as in the original;
use short captures. Crops retain native nearest-neighbour and HD area sampling.
"""

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from raster_buffers import rgb565
from recording_video import count_frames


def native_frames(directory):
    directory = Path(directory)
    meta = json.loads((directory / 'meta.json').read_text())
    width, height = meta['w'], meta['h']
    raw = b''.join(path.read_bytes() for path in sorted(directory.glob('chunk-*.bin')))
    if width <= 0 or height <= 0 or not raw or len(raw) % (width * height * 2):
        raise ValueError('invalid or incomplete native recording')
    frames = np.frombuffer(raw, dtype='<u2').reshape(-1, height, width)
    times = np.asarray(meta['times'][:len(frames)], dtype=float)
    if len(times) != len(frames) or not np.isfinite(times).all() or np.any(np.diff(times) < 0):
        raise ValueError('native recording timestamps are missing, invalid or decreasing')
    return frames, times


def render(out, nrec, hd, t0, box, *, hd_width, font, scale=2, fps=15,
           labels=('原版', 'HD'), title='', start=0, end=1e9, fourcc='avc1'):
    x, y, width, height = box
    if min(width, height, hd_width, scale, fps) <= 0 or min(x, y, start) < 0 or end < start:
        raise ValueError('invalid crop, scale, fps or time range')
    if not all(math.isfinite(value) for value in (scale, fps, t0, start, end)) or len(labels) != 2:
        raise ValueError('expected finite timing and exactly two labels')
    if Path(out).resolve() == Path(hd).resolve() or Path(nrec).resolve() in Path(out).resolve().parents:
        raise ValueError('output must not overwrite either recording')
    nat, ntimes = native_frames(nrec)
    ow, oh = int(width * scale), int(height * scale)
    if min(ow, oh) <= 0:
        raise ValueError('scaled crop is empty')
    cap = cv2.VideoCapture(str(hd))
    hd_frames, hd_times = [], []
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            timestamp = t0 + cap.get(cv2.CAP_PROP_POS_MSEC)
            factor = frame.shape[1] / hd_width
            left, top, right, bottom = (int(value * factor) for value in (x, y, x+width, y+height))
            if not (0 <= left < right <= frame.shape[1] and 0 <= top < bottom <= frame.shape[0]):
                raise ValueError('HD crop is outside the decoded frame')
            hd_frames.append(cv2.resize(frame[top:bottom, left:right], (ow, oh), interpolation=cv2.INTER_AREA))
            hd_times.append(timestamp)
    finally:
        cap.release()
    if not hd_frames or not np.isfinite(hd_times).all() or np.any(np.diff(hd_times) < 0):
        raise ValueError('HD recording is empty or has invalid timestamps')
    hd_times = np.array(hd_times)
    base = max(ntimes[0], hd_times[0])
    first = base + start * 1000
    last = min(ntimes[-1], hd_times[-1], base + end * 1000)
    if last < first:
        raise ValueError('recordings have no overlap in the selected time range')
    face = ImageFont.truetype(str(font), 22) if font else ImageFont.load_default()
    gap, top = 8, 34
    vw, vh = ow * 2 + gap, oh + top
    vw += vw % 2
    vh += vh % 2
    writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*fourcc), fps, (vw, vh))
    count = 0
    try:
        if not writer.isOpened():
            raise ValueError('comparison video encoder could not open')
        while first + count * 1000 / fps <= last:
            timestamp = first + count * 1000 / fps
            ni = int(np.argmin(np.abs(ntimes - timestamp)))
            hi = int(np.argmin(np.abs(hd_times - timestamp)))
            left = cv2.resize(rgb565(nat[ni])[..., ::-1], (ow, oh), interpolation=cv2.INTER_NEAREST)
            canvas = np.zeros((vh, vw, 3), np.uint8)
            canvas[top:top+oh, :ow] = left
            canvas[top:top+oh, ow+gap:ow*2+gap] = hd_frames[hi]
            image = Image.fromarray(canvas[..., ::-1])
            draw = ImageDraw.Draw(image)
            draw.text((8, 4), labels[0], fill=(255, 255, 255), font=face)
            draw.text((ow+gap+8, 4), labels[1], fill=(255, 255, 255), font=face)
            draw.text((ow-150, 4), f't={(timestamp-first)/1000:5.1f}s', fill=(200, 200, 200), font=face)
            if title:
                draw.text((ow+gap+120, 4), title, fill=(230, 230, 160), font=face)
            writer.write(np.asarray(image)[..., ::-1].copy())
            count += 1
    finally:
        writer.release()
    readback = count_frames(str(out))
    return dict(out=str(out), written=count, readBack=readback, ok=count == readback,
                bytes=Path(out).stat().st_size)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    parser.add_argument('nrec', type=Path)
    parser.add_argument('hd', type=Path)
    parser.add_argument('t0', type=float, help='HD recording start in epoch milliseconds')
    for key in ('x', 'y', 'w', 'h'):
        parser.add_argument(key, type=int)
    parser.add_argument('--hd-width', '--hdw', type=int, required=True)
    parser.add_argument('--font', type=Path)
    parser.add_argument('--scale', type=float, default=2)
    parser.add_argument('--fps', type=float, default=15)
    parser.add_argument('--title', default='')
    parser.add_argument('--labels', default='原版,HD')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--end', type=float, default=1e9)
    parser.add_argument('--fourcc', default='avc1')
    args = parser.parse_args(argv)
    result = render(args.out, args.nrec, args.hd, args.t0, (args.x, args.y, args.w, args.h),
                    hd_width=args.hd_width, font=args.font, scale=args.scale, fps=args.fps,
                    labels=args.labels.split(','), title=args.title, start=args.start,
                    end=args.end, fourcc=args.fourcc)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
