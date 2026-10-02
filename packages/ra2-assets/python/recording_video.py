"""Cut, crop, re-time and label browser recordings (for example an in-page MediaRecorder capture of the HD canvas) into one
H.264 mp4, then read the written file back and fail when its frame count differs from the frames written.

Usage:
  python3 recording_video.py --out OUT.mp4 --width 1280 --fps 25 [--font FONT.ttc] [--fourcc avc1] \
      --seg 'SRC|T0|T1|SPEED|LABEL|TZERO[|CROP]' [--seg ...]

Each segment samples SRC between source seconds T0 and T1 at the output rate: SPEED 2 shows every second source moment
(double speed), 0.4 repeats each moment 2.5 times (slow motion). Source times come from the container timestamps
(MediaRecorder output has a variable frame rate), falling back to the nominal rate. Optional CROP is x0:y0:x1:y1 in
integer source pixels, with exclusive x1/y1 and x1 > x0, y1 > y0. Bounds are clamped to each frame; invalid or empty
boxes fail. Six-field specs keep the full frame. Crops are resized to --width with proportional, even heights (at
least 2 pixels); the first segment sets the output size. Other aspect ratios fit that size with centred black padding,
without stretching.
LABEL is drawn after crop/resize/padding in a dark strip at the top left when --font is given; a numeric TZERO adds a
clock "t=+x.x" relative to that source second (empty: no clock). Prints a JSON summary; exit status 1 when the read-back
frame count does not match.
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
    if len(parts) not in (6, 7):
        raise SystemExit(f'segment needs 6 or 7 fields SRC|T0|T1|SPEED|LABEL|TZERO[|CROP]: {spec}')
    src, t0, t1, speed, label, tzero = parts[:6]
    crop = None
    if len(parts) == 7:
        try:
            x0, y0, x1, y1 = (int(v) for v in parts[6].split(':'))
        except ValueError:
            raise SystemExit(f'bad segment crop (expected integer x0:y0:x1:y1): {spec}') from None
        if x1 <= x0 or y1 <= y0:
            raise SystemExit(f'bad segment crop (requires x1 > x0 and y1 > y0): {spec}')
        crop = (x0, y0, x1, y1)
    if float(speed) <= 0 or float(t1) < float(t0):
        raise SystemExit(f'bad segment timing: {spec}')
    return {'src': src, 't0': float(t0), 't1': float(t1), 'speed': float(speed), 'label': label,
            'tzero': None if tzero == '' else float(tzero), 'crop': crop}


def crop_frame(frame: np.ndarray, crop: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = crop
    h, w = frame.shape[:2]
    x0, x1 = (min(w, max(0, x)) for x in (x0, x1))
    y0, y1 = (min(h, max(0, y)) for y in (y0, y1))
    if x1 <= x0 or y1 <= y0:
        raise SystemExit(f'empty segment crop after clamping to {w}x{h}: {crop}')
    return frame[y0:y1, x0:x1]


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
    output_size = None
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
            if seg.get('crop') is not None:
                src = crop_frame(src, seg['crop'])
            height = round(src.shape[0] * width / src.shape[1])
            # A nonempty one-pixel crop still needs an encodable, positive even height.
            height = max(2, height - height % 2)
            size = (width, height)
            if output_size is None:
                output_size = size
            elif height > output_size[1]:
                size = (max(1, round(src.shape[1] * output_size[1] / src.shape[0])), output_size[1])
            frame = cv2.resize(src, size, interpolation=cv2.INTER_AREA)
            if size != output_size:
                # Encoders require one frame size; padding preserves the later crop's proportions.
                left = (output_size[0] - size[0]) // 2
                top = (output_size[1] - size[1]) // 2
                frame = cv2.copyMakeBorder(frame, top, output_size[1] - size[1] - top,
                                           left, output_size[0] - size[0] - left,
                                           cv2.BORDER_CONSTANT, value=(0, 0, 0))
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
                writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*fourcc), fps, output_size)
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
