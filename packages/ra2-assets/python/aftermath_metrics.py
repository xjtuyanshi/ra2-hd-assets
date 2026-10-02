"""Measure dark ground residue and grey veil in recordings, numbered frames or frozen pairs.

Examples (boxes use x0,y0,x1,y1, with exclusive upper edges):
  python3 aftermath_metrics.py --video death.mp4 --event 2 --box 100,200,400,500
  python3 aftermath_metrics.py --frames frames --step 0.5 --event 2 --box 0,0,160,120
  python3 aftermath_metrics.py --pairs pairs --ids pre,p1,p2 --at=-1,5,11 \
      --box 100,200,400,500 --box-scale-from 1152x744 --gate-dark '+5:6000,+11:3000'

Library images are BGR uint8 (OpenCV order). Counts and rises are native image pixels.
Sampling uses floor(seconds * fps), not container timestamps or nearest-frame rounding.
Indexed video seeks are checked against CAP_PROP_POS_FRAMES before and after decoding.
WebM, missing frame counts and failed position checks use a fresh sequential decoder;
this avoids relying on MediaRecorder WebM indexes. Only requested frames are retained.
This frame-index timeline is nominal-rate, not a variable-frame-rate timestamp timeline.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys

import cv2
import numpy as np

DEFAULT_OFFSETS = (-1, 0, 1, 2, 3, 5, 8, 11)


def pixel_counts(image: np.ndarray, dark_v: float = 50) -> dict[str, int]:
    """Count strict HSV gates in a non-empty BGR uint8 image."""
    if not math.isfinite(dark_v) or not 0 <= dark_v <= 255:
        raise ValueError('dark-v must be finite and in 0..255')
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or not image.size:
        raise ValueError('Metrics require a non-empty BGR uint8 image')
    # Exact HSV S/V avoid rounding near S=0.15 in OpenCV's uint8 HSV conversion.
    v = image.max(axis=-1)
    s = (v.astype(np.float64) - image.min(axis=-1)) / np.maximum(v, 1)
    return {'dark': int(np.count_nonzero(v < dark_v)),
            'grey': int(np.count_nonzero((s < 0.15) & (v > 0.35 * 255) & (v < 0.85 * 255)))}


def box_to_pixels(box, size: tuple[int, int], scale_from=None) -> tuple[int, int, int, int]:
    """Rescale optional reference coordinates independently on each axis, rounding outward."""
    width, height = size
    reference = size if scale_from is None else scale_from
    if len(box) != 4 or len(reference) != 2 or not all(math.isfinite(n) and n > 0 for n in (*size, *reference)):
        raise ValueError('Box needs four edges; image and reference dimensions must be positive and finite')
    x0, y0, x1, y1 = box
    if not all(math.isfinite(n) for n in box) or not (0 <= x0 < x1 <= reference[0] and 0 <= y0 < y1 <= reference[1]):
        raise ValueError(f'Box {box} must be non-empty and inside {reference[0]}x{reference[1]}')
    return (math.floor(x0 * width / reference[0]), math.floor(y0 * height / reference[1]),
            math.ceil(x1 * width / reference[0]), math.ceil(y1 * height / reference[1]))


def _indices(times, fps):
    indices = []
    for time in times:
        if not math.isfinite(time) or time < 0 or not math.isfinite(time * fps):
            raise ValueError('Requested sample times must be finite and non-negative')
        # Absorb floating-point noise only at integer frame boundaries.
        indices.append(math.floor(time * fps + 1e-9))
    return indices


def sample_video(path: Path, times, fps: float | None = None) -> tuple[list[np.ndarray], dict]:
    """Read nominal-rate samples by index, falling back to bounded-memory sequential decoding."""
    path = Path(path)
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise ValueError(f'Cannot open video: {path}')
        reported_fps = cap.get(cv2.CAP_PROP_FPS)
        if fps is None:
            if not math.isfinite(reported_fps) or not 0 < reported_fps <= 240:
                raise ValueError(f'Unusable container FPS {reported_fps}; supply --fps')
            fps = reported_fps
        elif not math.isfinite(fps) or fps <= 0:
            raise ValueError('fps must be finite and positive')
        indices = _indices(times, fps)
        if not indices:
            raise ValueError('At least one video sample is required')
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        usable_count = math.isfinite(count) and 1 <= count < 2**31 and count.is_integer()
        reason = ('WebM uses sequential decoding to avoid missing/unreliable indexes' if path.suffix.lower() == '.webm'
                  else 'Container has no usable frame count' if not usable_count else None)
        decoded = {}
        if reason is None:
            for index in sorted(set(indices)):
                try:
                    positioned = cap.set(cv2.CAP_PROP_POS_FRAMES, index)
                    before = cap.get(cv2.CAP_PROP_POS_FRAMES)
                    if not positioned or not math.isfinite(before) or abs(before - index) > 0.01:
                        reason = f'Frame-index seek position check failed at frame {index}'
                        break
                    ok, image = cap.read()
                    after = cap.get(cv2.CAP_PROP_POS_FRAMES)
                    if not ok or not math.isfinite(after) or abs(after - index - 1) > 0.01:
                        reason = f'Frame-index seek read/check failed at frame {index}'
                        break
                    decoded[index] = image
                except cv2.error:
                    reason = f'Frame-index seek raised a decoder error at frame {index}'
                    break
        if reason is not None:
            cap.release()
            cap = cv2.VideoCapture(str(path))
            if not cap.isOpened():
                raise ValueError(f'Cannot reopen video for sequential decoding: {path}')
            decoded = {}
            wanted = set(indices)
            for index in range(max(indices) + 1):
                ok, image = cap.read()
                if not ok:
                    raise ValueError(f'Requested video frame {max(indices)} is unavailable; decoded {index} frames')
                if index in wanted:
                    decoded[index] = image
        metadata = {'kind': 'video', 'path': str(path), 'fps': fps,
                    'container_fps': reported_fps if math.isfinite(reported_fps) else None,
                    'frame_count': int(count) if usable_count else None,
                    'read_mode': 'sequential' if reason else 'seek',
                    'read_reason': reason or 'Frame-index seek positions checked before and after each read',
                    'frame_indices': indices}
        return [decoded[index] for index in indices], metadata
    finally:
        cap.release()


def _load_image(path):
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f'Cannot read image: {path}')
    return image


def _numbered_frames(directory):
    files = {}
    for path in Path(directory).iterdir():
        match = re.fullmatch(r'f(\d+)\.png', path.name)
        if path.is_file() and match:
            index = int(match[1])
            if index in files:
                raise ValueError(f'Duplicate numbered frame {index}')
            files[index] = path
    if 0 not in files:
        raise ValueError('Frame directory must contain f0000.png (frame index 0)')
    return files


def _validate_offsets(offsets):
    if not offsets or not all(math.isfinite(n) for n in offsets) or len(set(offsets)) != len(offsets):
        raise ValueError('Sample offsets must be non-empty, finite and unique')


def analyze(*, boxes, video=None, frames=None, pairs=None, event=None, step=None, fps=None,
            ids=None, offsets=None, scale_from=None, dark_v=50, gate_dark=None, gate_grey=None) -> dict:
    """Return JSON-ready measurements; raise ValueError/OSError for invalid or unavailable input.

    Frozen IDs map to --at offsets in the supplied order, or to a prefix of DEFAULT_OFFSETS.
    Baselines are per-channel/per-box medians of negative-offset samples. Numbered frames
    without such samples use frame zero; video/pairs require a negative-offset sample.
    Gates check every box and, for pairs, both channels. Negative rises remain signed.
    """
    if sum(source is not None for source in (video, frames, pairs)) != 1:
        raise ValueError('Choose exactly one of video, frames or pairs')
    if not boxes:
        raise ValueError('At least one box is required')
    if event is not None and (not math.isfinite(event) or event < 0):
        raise ValueError('event must be finite and non-negative')
    if pairs is None and event is None:
        raise ValueError('--event is required for video and numbered frames')
    if (step is not None and frames is None) or (fps is not None and video is None) or (ids is not None and pairs is None):
        raise ValueError('--step is for frames, --fps for video, and --ids for pairs only')
    if pairs is not None:
        if not ids or len(set(ids)) != len(ids) or any(not re.fullmatch(r'[A-Za-z0-9_-]+', name) for name in ids):
            raise ValueError('Pairs require unique IDs containing only ASCII letters, digits, underscores or hyphens')
        if offsets is None and len(ids) > len(DEFAULT_OFFSETS):
            raise ValueError('More than eight pair IDs requires an explicit --at list')
        offsets = list(DEFAULT_OFFSETS[:len(ids)]) if offsets is None else list(offsets)
        if len(ids) != len(offsets):
            raise ValueError('--ids and --at must have the same number of entries')
    else:
        offsets = list(DEFAULT_OFFSETS) if offsets is None else list(offsets)
    _validate_offsets(offsets)
    pre = [i for i, offset in enumerate(offsets) if offset < 0]
    if not pre and frames is None:
        raise ValueError('Video and pairs need a negative --at offset for the pre-event baseline')
    gates = []
    for metric, limits in (('dark', gate_dark or {}), ('grey', gate_grey or {})):
        for offset, limit in limits.items():
            if not math.isfinite(offset) or not math.isfinite(limit) or limit < 0 or offset not in offsets:
                raise ValueError('Every gate needs a sampled offset and a finite, non-negative pixel limit')
            gates.append((metric, offset, limit))
    times = [event + offset for offset in offsets] if event is not None else [None] * len(offsets)
    baseline_images = None
    if video is not None:
        images, source = sample_video(Path(video), times, fps)
        samples = [{'frame': image} for image in images]
        indices = source.pop('frame_indices')
        actual_times = [index / source['fps'] for index in indices]
    elif frames is not None:
        if step is None or not math.isfinite(step) or step <= 0:
            raise ValueError('Numbered frames require a finite, positive --step')
        indices = _indices(times, 1 / step)
        files = _numbered_frames(frames)
        missing = set(indices) - files.keys()
        if missing:
            raise ValueError(f'Missing numbered frames: {sorted(missing)}')
        images = {index: _load_image(files[index]) for index in set(indices) | ({0} if not pre else set())}
        samples = [{'frame': images[index]} for index in indices]
        baseline_images = {'frame': images[0]} if not pre else None
        actual_times = [index * step for index in indices]
        source = {'kind': 'frames', 'path': str(frames), 'step_seconds': step}
    else:
        samples = [{'original': _load_image(Path(pairs) / f'orig-{name}.png'),
                    'hd': _load_image(Path(pairs) / f'hd-{name}.png')} for name in ids]
        indices = actual_times = [None] * len(offsets)
        source = {'kind': 'pairs', 'path': str(pairs), 'ids': list(ids)}

    sizes = {channel: (image.shape[1], image.shape[0]) for channel, image in samples[0].items()}
    for sample in samples + ([baseline_images] if baseline_images else []):
        for channel, image in sample.items():
            if (image.shape[1], image.shape[0]) != sizes[channel]:
                raise ValueError(f'Image dimensions changed over time for {channel}')
    pixel_boxes = [{channel: box_to_pixels(box, size, scale_from) for channel, size in sizes.items()} for box in boxes]

    def measure(sample):
        result = []
        for number, crops in enumerate(pixel_boxes, 1):
            channels = {}
            for channel, (x0, y0, x1, y1) in crops.items():
                channels[channel] = pixel_counts(sample[channel][y0:y1, x0:x1], dark_v)
            result.append({'box_index': number, 'channels': channels})
        return result

    measurements = [measure(sample) for sample in samples]
    references = [measure(baseline_images)] if baseline_images is not None else [measurements[i] for i in pre]
    baseline_boxes = []
    for box_index in range(len(boxes)):
        values = {channel: {metric: float(np.median([ref[box_index]['channels'][channel][metric] for ref in references]))
                            for metric in ('dark', 'grey')} for channel in sizes}
        baseline_boxes.append({'box_index': box_index + 1, 'channels': values})
    rows = []
    for i, measured in enumerate(measurements):
        for box_index, box in enumerate(measured):
            for channel, counts in box['channels'].items():
                for metric in ('dark', 'grey'):
                    counts[f'{metric}_rise'] = counts[metric] - baseline_boxes[box_index]['channels'][channel][metric]
            if pairs is not None:
                box['hd_minus_original_dark'] = box['channels']['hd']['dark'] - box['channels']['original']['dark']
        rows.append({'offset_seconds': offsets[i], 'requested_time_seconds': times[i],
                     'actual_time_seconds': actual_times[i], 'frame_index': indices[i],
                     'pair_id': ids[i] if pairs is not None else None, 'boxes': measured})
    gate_results = []
    for metric, offset, limit in gates:
        results = [{'box_index': box['box_index'], 'channel': channel,
                    'rise': counts[f'{metric}_rise'], 'passed': counts[f'{metric}_rise'] <= limit}
                   for box in rows[offsets.index(offset)]['boxes'] for channel, counts in box['channels'].items()]
        gate_results.append({'metric': metric, 'offset_seconds': offset, 'max_rise': limit,
                             'results': results, 'passed': all(result['passed'] for result in results)})
    return {'schema_version': 1, 'source': source, 'event_seconds': event,
            'thresholds': {'dark_v': dark_v, 'grey_s_max': 0.15, 'grey_v_min': 0.35, 'grey_v_max': 0.85},
            'boxes': [{'box_index': i + 1, 'requested_box': list(box),
                       'pixel_boxes': {channel: list(crop) for channel, crop in pixel_boxes[i].items()}}
                      for i, box in enumerate(boxes)],
            'box_scale_from': list(scale_from) if scale_from is not None else None,
            'image_sizes': {channel: list(size) for channel, size in sizes.items()},
            'baseline': {'method': 'first_frame' if baseline_images is not None else 'pre_event_median',
                         'offsets_seconds': [offsets[i] for i in pre],
                         'frame_index': 0 if baseline_images is not None else None, 'boxes': baseline_boxes},
            'samples': rows, 'gates': gate_results, 'passed': all(gate['passed'] for gate in gate_results)}


def _numbers(spec):
    try:
        values = [float(part) for part in spec.split(',')]
        if not all(math.isfinite(value) for value in values):
            raise ValueError
        return values
    except ValueError:
        raise argparse.ArgumentTypeError('Expected comma-separated finite numbers') from None


def _box(spec):
    values = _numbers(spec)
    if len(values) != 4:
        raise argparse.ArgumentTypeError('Box needs x0,y0,x1,y1')
    return values


def _size(spec):
    match = re.fullmatch(r'(\d+)[xX](\d+)', spec)
    if not match or min(map(int, match.groups())) <= 0:
        raise argparse.ArgumentTypeError('Reference size must be positive WxH')
    return tuple(map(int, match.groups()))


def _gates(spec):
    result = {}
    try:
        for item in spec.split(','):
            offset, limit = map(float, item.split(':'))
            if offset in result or not math.isfinite(offset) or not math.isfinite(limit) or limit < 0:
                raise ValueError
            result[offset] = limit
    except ValueError:
        raise argparse.ArgumentTypeError('Gates need unique finite OFFSET:LIMIT entries with non-negative limits') from None
    return result


def format_table(report: dict) -> str:
    """Render both pair channels on one row, retaining native-pixel count differences."""
    paired = report['source']['kind'] == 'pairs'
    headers = ['offset(s)', 'pair/frame', 'box']
    channels = ('original', 'hd') if paired else ('frame',)
    for channel in channels:
        prefix = channel + ' ' if paired else ''
        headers.extend(prefix + metric for metric in ('dark', 'dark rise', 'grey', 'grey rise'))
    if paired:
        headers.append('HD-orig dark')
    rows = [headers]
    for sample in report['samples']:
        for box in sample['boxes']:
            row = [f'{sample["offset_seconds"]:+g}', str(sample['pair_id'] or sample['frame_index']), str(box['box_index'])]
            for channel in channels:
                counts = box['channels'][channel]
                row.extend(f'{counts[metric]:g}' for metric in ('dark', 'dark_rise', 'grey', 'grey_rise'))
            if paired:
                row.append(str(box['hd_minus_original_dark']))
            rows.append(row)
    widths = [max(len(row[i]) for row in rows) for i in range(len(headers))]
    lines = ['Baseline: ' + report['baseline']['method']]
    if report['source']['kind'] == 'video':
        lines.append(f'Video: {report["source"]["fps"]:g} fps, {report["source"]["read_mode"]} ({report["source"]["read_reason"]})')
    lines.extend('  '.join(value.rjust(width) for value, width in zip(row, widths)) for row in rows)
    for gate in report['gates']:
        for result in gate['results']:
            lines.append(f'{"PASS" if result["passed"] else "FAIL"} {gate["metric"]} {gate["offset_seconds"]:+g}s '
                         f'box {result["box_index"]} {result["channel"]}: rise {result["rise"]:g} <= {gate["max_rise"]:g}')
    status = ('PASS' if report['passed'] else 'FAIL') if report['gates'] else 'none'
    lines.append('Gates: ' + status)
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument('--video', type=Path, help='cv2-readable recording (mp4/webm)')
    sources.add_argument('--frames', type=Path, help='directory of f0000.png, f0001.png, ...')
    sources.add_argument('--pairs', type=Path, help='directory of orig-ID.png / hd-ID.png')
    parser.add_argument('--ids', help='ordered comma-separated pair IDs (including names such as pre,p1,p2)')
    parser.add_argument('--event', type=float, help='death time in source seconds; required for video/frames')
    parser.add_argument('--step', type=float, help='seconds per numbered frame')
    parser.add_argument('--fps', type=float, help='override unusable or inaccurate container FPS')
    parser.add_argument('--at', type=_numbers, help='relative seconds; default -1,0,1,2,3,5,8,11 (prefix for pairs)')
    parser.add_argument('--box', type=_box, action='append', required=True, help='x0,y0,x1,y1; repeatable')
    parser.add_argument('--box-scale-from', type=_size, help='reference WxH for rescaling boxes')
    parser.add_argument('--dark-v', type=float, default=50, help='strict dark V threshold, 0..255 (default 50)')
    parser.add_argument('--gate-dark', type=_gates, help='OFFSET:MAX_RISE,... for all boxes/channels')
    parser.add_argument('--gate-grey', type=_gates, help='OFFSET:MAX_RISE,... for all boxes/channels')
    parser.add_argument('--json', type=Path, help='write all measurements and gate results')
    # argparse otherwise mistakes a quoted comma-list starting with '-' for another option.
    args_list = list(sys.argv[1:] if argv is None else argv)
    for i in range(len(args_list) - 2, -1, -1):
        if (args_list[i] in ('--at', '--box', '--gate-dark', '--gate-grey')
                and args_list[i + 1].startswith('-') and not args_list[i + 1].startswith('--')):
            args_list[i:i + 2] = [args_list[i] + '=' + args_list[i + 1]]
    args = parser.parse_args(args_list)
    try:
        report = analyze(boxes=args.box, video=args.video, frames=args.frames, pairs=args.pairs,
                         event=args.event, step=args.step, fps=args.fps,
                         ids=args.ids.split(',') if args.ids is not None else None, offsets=args.at,
                         scale_from=args.box_scale_from, dark_v=args.dark_v,
                         gate_dark=args.gate_dark, gate_grey=args.gate_grey)
        if args.json:
            args.json.parent.mkdir(parents=True, exist_ok=True)
            args.json.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        print(format_table(report))
        return 0 if report['passed'] else 1
    except (OSError, ValueError, cv2.error) as error:
        parser.error(str(error))


if __name__ == '__main__':
    sys.exit(main())
