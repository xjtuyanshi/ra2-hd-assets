"""Cut, re-time and label browser recordings (for example an in-page MediaRecorder capture of the HD canvas) into one
H.264 mp4, then read the written file back and fail when its frame count differs from the frames written.

Usage:
  python3 recording_video.py --out OUT.mp4 --width 1280 --fps 25 [--font FONT.ttc] [--fourcc avc1] \
      --seg 'SRC|T0|T1|SPEED|LABEL|TZERO' [--seg ...]

Each segment samples SRC between source seconds T0 and T1 at the output rate: SPEED 2 shows every second source moment
(double speed), 0.4 repeats each moment 2.5 times (slow motion). Source times come from the container timestamps
(MediaRecorder output has a variable frame rate), falling back to the nominal rate. LABEL is drawn in a dark strip at
the top left when --font is given; a numeric TZERO adds a clock "t=+x.x" relative to that source second (empty: no
clock). Prints a JSON summary; exit status 1 when the read-back frame count does not match.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np


def read_frames(path: str) -> tuple[list[np.ndarray], np.ndarray]:
    cap = cv2.VideoCapture(path)
    frames: list[np.ndarray] = []
    times: list[float] = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        times.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000)
    if not frames:
        raise SystemExit(f'no frames in {path}')
    ts = np.array(times)
    if not ts[-1] > 0:
        ts = np.arange(len(frames)) / (cap.get(cv2.CAP_PROP_FPS) or 30)
    return frames, ts


def parse_segment(spec: str) -> dict:
    parts = spec.split('|')
    if len(parts) != 6:
        raise SystemExit(f'segment needs 6 fields SRC|T0|T1|SPEED|LABEL|TZERO: {spec}')
    src, t0, t1, speed, label, tzero = parts
    if float(speed) <= 0 or float(t1) < float(t0):
        raise SystemExit(f'bad segment timing: {spec}')
    return {'src': src, 't0': float(t0), 't1': float(t1), 'speed': float(speed), 'label': label,
            'tzero': None if tzero == '' else float(tzero)}


def count_frames(path: str) -> int:
    cap = cv2.VideoCapture(path)
    n = 0
    while cap.read()[0]:
        n += 1
    return n


def render(out: str, width: int, fps: float, segments: list[dict], font: str | None = None,
           fourcc: str = 'avc1') -> dict:
    face = None
    if font:
        from PIL import ImageFont
        face = ImageFont.truetype(font, max(14, width // 48))
    cache: dict[str, tuple[list[np.ndarray], np.ndarray]] = {}
    writer = None
    written = 0
    for seg in segments:
        if seg['src'] not in cache:
            cache[seg['src']] = read_frames(seg['src'])
        frames, ts = cache[seg['src']]
        step = seg['speed'] / fps
        k = 0
        while seg['t0'] + k * step <= seg['t1'] + 1e-9:
            t = seg['t0'] + k * step
            k += 1
            # The frame on screen at source time t: the last one whose timestamp is not after t.
            i = int(np.clip(np.searchsorted(ts, t + 1e-6, side='right') - 1, 0, len(frames) - 1))
            src = frames[i]
            height = round(src.shape[0] * width / src.shape[1])
            height -= height % 2
            frame = cv2.resize(src, (width, height), interpolation=cv2.INTER_AREA)
            if face is not None and (seg['label'] or seg['tzero'] is not None):
                from PIL import Image, ImageDraw
                img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                draw = ImageDraw.Draw(img)
                text = seg['label'] + (f'   t={t - seg["tzero"]:+.1f} s' if seg['tzero'] is not None else '')
                box = draw.textbbox((0, 0), text, font=face)
                draw.rectangle((0, 0, box[2] + 24, box[3] + 16), fill=(0, 0, 0))
                draw.text((12, 6), text, font=face, fill=(255, 210, 80))
                frame = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
            if writer is None:
                writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*fourcc), fps, (width, height))
                if not writer.isOpened():
                    raise SystemExit(f'cannot open a {fourcc} writer for {out}')
            writer.write(frame)
            written += 1
    if writer is None:
        raise SystemExit('no frames written')
    writer.release()
    back = count_frames(out)
    return {'out': out, 'written': written, 'readBack': back, 'seconds': round(written / fps, 2),
            'bytes': os.path.getsize(out), 'ok': back == written}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--fps', type=float, default=25)
    ap.add_argument('--font')
    ap.add_argument('--fourcc', default='avc1')
    ap.add_argument('--seg', action='append', required=True)
    a = ap.parse_args(argv)
    res = render(a.out, a.width, a.fps, [parse_segment(s) for s in a.seg], a.font, a.fourcc)
    print(json.dumps(res))
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
