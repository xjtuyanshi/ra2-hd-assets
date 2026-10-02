"""Cut, crop, re-time and label browser recordings (for example an in-page MediaRecorder capture of the HD canvas) into one
H.264 mp4, then read the written file back and fail when its frame count differs from the frames written.

Usage:
  python3 recording_video.py --out OUT.mp4 --width 1280 --fps 25 [--max-height H] [--quality Q] \
      [--font FONT.ttc] [--fourcc avc1] \
      --seg 'SRC|T0|T1|SPEED|LABEL|TZERO[|CROP]' [--seg ...]

Each segment samples SRC between source seconds T0 and T1 at the output rate: SPEED 2 shows every second source moment
(double speed), 0.4 repeats each moment 2.5 times (slow motion). Source times come from the container timestamps
(MediaRecorder output has a variable frame rate), falling back to the nominal rate. Optional CROP is x0:y0:x1:y1 in
integer source pixels, with exclusive x1/y1 and x1 > x0, y1 > y0. Bounds are clamped to each frame; invalid or empty
boxes fail. Six-field specs keep the full frame. Crops are resized to --width with proportional, even heights (at
least 2 pixels); --max-height then scales down further, keeping dimensions even. The first segment sets the output
size. Other aspect ratios fit that size with centred black padding, without stretching. Each source is decoded
sequentially once with constant frame memory; overlapping or reordered cuts use temporary disk storage.
--quality requests encoder quality (0-100), with a JSON note when unsupported.
LABEL is drawn after crop/resize/padding in a dark strip at the top left when --font is given; a numeric TZERO adds a
clock "t=+x.x" relative to that source second (empty: no clock). Prints a JSON summary; exit status 1 when the read-back
frame count does not match.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import ExitStack, closing
import heapq
import json
import math
import os
import struct
import sys
import tempfile

import cv2
import numpy as np


def read_frames(path: str) -> Iterator[tuple[np.ndarray, float, float]]:
    """Decode once, yielding a frame, container seconds and nominal seconds without retaining a frame list."""
    cap = cv2.VideoCapture(path)
    n = 0
    try:
        rate = cap.get(cv2.CAP_PROP_FPS) or 30
        if not math.isfinite(rate) or rate <= 0:
            rate = 30
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            yield frame, cap.get(cv2.CAP_PROP_POS_MSEC) / 1000, n / rate
            n += 1
        if not n:
            raise SystemExit(f'no frames in {path}')
    finally:
        cap.release()


def sample_times(segments: list[tuple[int, dict]], fps: float) -> Iterator[tuple[int, float]]:
    """Merge segment sample times with one heap entry per segment, including overlapping/reordered cuts."""
    specs = dict(segments)
    pending = [(seg['t0'], index, 0) for index, seg in segments]
    heapq.heapify(pending)
    while pending:
        t, index, k = heapq.heappop(pending)
        yield index, t
        seg = specs[index]
        k += 1
        t = seg['t0'] + k * (seg['speed'] / fps)
        if t <= seg['t1'] + 1e-9:
            heapq.heappush(pending, (t, index, k))


def output_size(frame: np.ndarray, width: int, max_height: int | None) -> tuple[int, int]:
    width -= width % 2
    height = round(frame.shape[0] * width / frame.shape[1])
    height = max(2, height - height % 2)
    if max_height is not None and height > max_height:
        height = max_height - max_height % 2
        width = int(frame.shape[1] * height / frame.shape[0])
        width = max(2, width - width % 2)
    if width < 2 or height < 2:
        raise SystemExit('output dimensions must be at least 2 pixels')
    return width, height


class _Sampler:
    """Hold a preceding frame until the next timestamp determines its requested output samples."""

    def __init__(self, samples, emit, width: int, max_height: int | None, crops: dict):
        self.samples = iter(samples)
        self.pending = next(self.samples, None)
        self.emit = emit
        self.width = width
        self.max_height = max_height
        self.crops = crops
        self.previous = None
        self.resized = None
        self.resized_crop = None

    def _emit(self):
        crop = self.crops[self.pending[0]]
        if self.resized is None or crop != self.resized_crop:
            src = self.previous if crop is None else crop_frame(self.previous, crop)
            # Cache only the last crop, so overlapping segments cannot grow frame memory.
            self.resized = cv2.resize(src, output_size(src, self.width, self.max_height),
                                      interpolation=cv2.INTER_AREA)
            self.resized_crop = crop
        self.emit(*self.pending, self.resized)
        self.pending = next(self.samples, None)

    def push(self, frame: np.ndarray, timestamp: float):
        if self.previous is None:
            self.previous = frame
        # Equal timestamps select the last frame, matching searchsorted(..., side='right').
        while self.pending is not None and self.pending[1] + 1e-6 < timestamp:
            self._emit()
        self.previous = frame
        self.resized = None

    def finish(self):
        # Samples outside the source duration clamp to its first/last frame, as before.
        while self.pending is not None:
            self._emit()
        self.previous = self.resized = None


class _FrameSpool:
    """Keep deferred, already resized samples on disk rather than in RAM."""

    header = struct.Struct('<Id')

    def __init__(self):
        self.file = tempfile.TemporaryFile()

    def append(self, index: int, t: float, frame: np.ndarray):
        self.file.write(self.header.pack(index, t))
        np.save(self.file, frame, allow_pickle=False)

    def __iter__(self):
        self.file.seek(0)
        while header := self.file.read(self.header.size):
            index, t = self.header.unpack(header)
            yield index, t, np.load(self.file, allow_pickle=False)

    def close(self):
        self.file.close()


def sample_source(path: str, segments: list[tuple[int, dict]], fps: float, width: int,
                  max_height: int | None, emit):
    """Sample one sequential decode with constant frame storage, preserving the all-zero timestamp fallback."""
    with ExitStack() as stack:
        crops = {index: seg.get('crop') for index, seg in segments}
        timestamp_prefix = _FrameSpool()
        nominal_prefix = _FrameSpool()
        stack.callback(timestamp_prefix.close)
        stack.callback(nominal_prefix.close)
        timestamp_sampler = _Sampler(sample_times(segments, fps), timestamp_prefix.append, width, max_height, crops)
        nominal_sampler = _Sampler(sample_times(segments, fps), nominal_prefix.append, width, max_height, crops)
        use_timestamps = False
        frames = stack.enter_context(closing(read_frames(path)))
        for frame, timestamp, nominal in frames:
            if not use_timestamps and timestamp > 0:
                # A zero prefix can be legitimate VFR. Do not guess nominal timing from the second frame alone.
                use_timestamps = True
                for event in timestamp_prefix:
                    emit(*event)
                timestamp_sampler.emit = emit
                nominal_sampler = None
                timestamp_prefix.close()
                nominal_prefix.close()
            timestamp_sampler.push(frame, timestamp)
            if nominal_sampler is not None:
                nominal_sampler.push(frame, nominal)
        if use_timestamps:
            timestamp_sampler.finish()
        else:
            nominal_sampler.finish()
            for event in nominal_prefix:
                emit(*event)


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
    try:
        while cap.read()[0]:
            n += 1
    finally:
        cap.release()
    return n


def render(out: str, width: int, fps: float, segments: list[dict], font: str | None = None,
           fourcc: str = 'avc1', max_height: int | None = None, quality: float | None = None) -> dict:
    if width < 2 or (max_height is not None and max_height < 2):
        raise SystemExit('width and max-height must be at least 2 pixels')
    if not math.isfinite(fps) or fps <= 0:
        raise SystemExit('fps must be positive and finite')
    if quality is not None and not 0 <= quality <= 100:
        raise SystemExit('quality must be between 0 and 100')
    face = None
    if font:
        from PIL import ImageFont
        face = ImageFont.truetype(font, max(14, width // 48))
    sources: dict[str, list[tuple[int, dict]]] = {}
    for index, seg in enumerate(segments):
        sources.setdefault(seg['src'], []).append((index, seg))
    writer = None
    canvas_size = None
    written = 0
    quality_applied = False

    def write(index: int, t: float, frame: np.ndarray):
        nonlocal writer, written, quality_applied, canvas_size
        seg = segments[index]
        if writer is None:
            canvas_size = (frame.shape[1], frame.shape[0])
            writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*fourcc), fps, canvas_size)
            if not writer.isOpened():
                raise SystemExit(f'cannot open a {fourcc} writer for {out}')
            if quality is not None and hasattr(cv2, 'VIDEOWRITER_PROP_QUALITY'):
                try:
                    quality_applied = bool(writer.set(cv2.VIDEOWRITER_PROP_QUALITY, quality))
                except cv2.error:
                    quality_applied = False
        if (frame.shape[1], frame.shape[0]) != canvas_size:
            scale = min(canvas_size[0] / frame.shape[1], canvas_size[1] / frame.shape[0])
            size = (max(1, round(frame.shape[1] * scale)), max(1, round(frame.shape[0] * scale)))
            frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
            # Deferred crops may precede the first segment in source time; fit them only when written.
            left = (canvas_size[0] - size[0]) // 2
            top = (canvas_size[1] - size[1]) // 2
            frame = cv2.copyMakeBorder(frame, top, canvas_size[1] - size[1] - top,
                                       left, canvas_size[0] - size[0] - left,
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
        writer.write(frame)
        written += 1

    try:
        with ExitStack() as stack:
            deferred: dict[int, _FrameSpool] = {}
            for index, seg in enumerate(segments):
                if seg['src'] in sources:
                    def emit(sample_index, t, frame):
                        if sample_index == index:
                            write(sample_index, t, frame)
                        else:
                            if sample_index not in deferred:
                                deferred[sample_index] = _FrameSpool()
                                stack.callback(deferred[sample_index].close)
                            deferred[sample_index].append(sample_index, t, frame)

                    sample_source(seg['src'], sources.pop(seg['src']), fps, width, max_height, emit)
                else:
                    spool = deferred.pop(index)
                    for event in spool:
                        write(*event)
                    spool.close()
    finally:
        if writer is not None:
            writer.release()
    if writer is None:
        raise SystemExit('no frames written')
    back = count_frames(out)
    result = {'out': out, 'written': written, 'readBack': back, 'seconds': round(written / fps, 2),
              'bytes': os.path.getsize(out), 'ok': back == written}
    if quality is not None:
        result['quality'] = {'requested': quality, 'applied': quality_applied}
        if not quality_applied:
            result['notes'] = ['VIDEOWRITER_PROP_QUALITY is unsupported by the chosen backend; quality ignored.']
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--fps', type=float, default=25)
    ap.add_argument('--max-height', type=int, help='scale down further to fit this height, keeping even dimensions')
    ap.add_argument('--quality', type=float, help='encoder quality (0-100), ignored with a JSON note if unsupported')
    ap.add_argument('--font')
    ap.add_argument('--fourcc', default='avc1')
    ap.add_argument('--seg', action='append', required=True)
    a = ap.parse_args(argv)
    res = render(a.out, a.width, a.fps, [parse_segment(s) for s in a.seg], a.font, a.fourcc,
                 a.max_height, a.quality)
    print(json.dumps(res))
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
