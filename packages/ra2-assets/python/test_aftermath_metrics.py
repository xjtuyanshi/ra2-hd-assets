"""Asset-free aftermath measurements, gates, frozen pairs and video decoding."""

import json
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np
import pytest

import aftermath_metrics as metrics


FULL = (0, 0, 96, 64)
LEFT = (0, 0, 40, 64)
RADII = (0, 0, 6, 5, 4, 3, 2, 2, 1, 1, 1, 0, 0, 0)
AREAS = (0, 0, 113, 81, 49, 29, 13, 13, 5, 5, 5, 0, 0, 0)


def scene(second):
    image = np.full((64, 96, 3), (0, 200, 0), dtype=np.uint8)
    image[2:4, 2:4] = 0  # Persistent baseline: four dark pixels.
    image[2:4, 60:63] = 120  # Persistent baseline: six grey pixels.
    if RADII[second]:
        cv2.circle(image, (24, 32), RADII[second], (20, 20, 20), -1)
        cv2.circle(image, (68, 32), RADII[second], (120, 120, 120), -1)
    return image


@pytest.fixture
def frames(tmp_path):
    directory = tmp_path / 'frames'
    directory.mkdir()
    for second in range(len(RADII)):
        assert cv2.imwrite(str(directory / f'f{second:04d}.png'), scene(second))
    return directory


def channel(report, sample, box=0, name='frame'):
    return report['samples'][sample]['boxes'][box]['channels'][name]


def test_fading_discs_default_offsets_and_per_box_gates(frames):
    report = metrics.analyze(frames=frames, step=1, event=2, boxes=[FULL, LEFT],
                             gate_dark={5: 13, 11: 0}, gate_grey={5: 13, 11: 0})
    assert [s['offset_seconds'] for s in report['samples']] == list(metrics.DEFAULT_OFFSETS)
    assert [s['frame_index'] for s in report['samples']] == [1, 2, 3, 4, 5, 7, 10, 13]
    assert report['baseline']['method'] == 'pre_event_median'
    assert report['baseline']['boxes'][0]['channels']['frame'] == {'dark': 4, 'grey': 6}
    expected = [AREAS[i] for i in (1, 2, 3, 4, 5, 7, 10, 13)]
    for i, area in enumerate(expected):
        assert channel(report, i) == {'dark': 4 + area, 'grey': 6 + area,
                                     'dark_rise': area, 'grey_rise': area}
        assert channel(report, i, box=1) == {'dark': 4 + area, 'grey': 0,
                                            'dark_rise': area, 'grey_rise': 0}
    assert report['passed']
    assert len(report['gates']) == 4
    assert all(len(gate['results']) == 2 and gate['passed'] for gate in report['gates'])
    failed = metrics.analyze(frames=frames, step=1, event=2, boxes=[FULL, LEFT],
                             gate_dark={5: 12}, gate_grey={11: 0})
    assert not failed['passed']
    assert not failed['gates'][0]['passed']
    assert failed['gates'][1]['passed']


def test_median_baseline_retains_fractional_and_negative_rises(frames):
    pre = scene(1)
    pre[8, 8] = 0
    assert cv2.imwrite(str(frames / 'f0001.png'), pre)
    report = metrics.analyze(frames=frames, step=1, event=2, offsets=[-2, -1, 0, 11], boxes=[FULL])
    assert report['baseline']['boxes'][0]['channels']['frame']['dark'] == 4.5
    assert channel(report, 0)['dark_rise'] == -0.5
    assert channel(report, 1)['dark_rise'] == 0.5
    assert channel(report, 2)['dark_rise'] == 112.5
    assert channel(report, 3)['dark_rise'] == -0.5


def test_first_numbered_frame_baseline_and_floor_sampling(frames):
    report = metrics.analyze(frames=frames, step=0.5, event=1.24, offsets=[0, 0.5, 5.26], boxes=[FULL])
    assert report['baseline']['method'] == 'first_frame'
    assert report['baseline']['frame_index'] == 0
    assert [s['frame_index'] for s in report['samples']] == [2, 3, 13]
    assert [s['actual_time_seconds'] for s in report['samples']] == [1, 1.5, 6.5]
    assert channel(report, 0)['dark_rise'] == 113


def test_strict_dark_and_grey_thresholds():
    hsv = np.array([[[0, 0, 49], [0, 0, 50], [0, 38, 196], [0, 39, 196],
                     [0, 0, 89], [0, 0, 90], [0, 0, 216], [0, 0, 217]]], dtype=np.uint8)
    image = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    assert metrics.pixel_counts(image) == {'dark': 1, 'grey': 3}
    assert metrics.pixel_counts(image, dark_v=51)['dark'] == 2
    assert metrics.pixel_counts(image, dark_v=0)['dark'] == 0
    with pytest.raises(ValueError):
        metrics.pixel_counts(np.zeros((1, 1), dtype=np.uint8))
    with pytest.raises(ValueError):
        metrics.pixel_counts(image.astype(float))


def test_box_scaling_matches_outward_rounding_convention():
    assert metrics.box_to_pixels((1, 1, 3, 3), (15, 20), (10, 10)) == (1, 2, 5, 6)
    assert metrics.box_to_pixels((0, 0, 10, 10), (1277, 823), (10, 10)) == (0, 0, 1277, 823)
    assert metrics.box_to_pixels((1, 1, 3, 3), (10, 10)) == (1, 1, 3, 3)
    for box in ((-1, 0, 4, 4), (4, 0, 4, 4), (0, 0, 11, 4), (0, 0, 4, float('nan'))):
        with pytest.raises(ValueError):
            metrics.box_to_pixels(box, (10, 10))


def test_grey_saturation_gate_uses_exact_hsv_instead_of_uint8_rounding():
    image = np.array([[[170, 170, 200], [171, 171, 201], [169, 169, 199]]], dtype=np.uint8)
    # Saturation 30/200 = 0.15 is excluded; 30/201 is below, and 30/199 above.
    assert metrics.pixel_counts(image) == {'dark': 0, 'grey': 1}


@pytest.fixture
def pairs(tmp_path):
    directory = tmp_path / 'pairs'
    directory.mkdir()
    for name, second in (('pre', 1), ('p1', 7), ('p2', 13)):
        original = scene(second)
        hd = cv2.resize(original, (192, 128), interpolation=cv2.INTER_NEAREST)
        assert cv2.imwrite(str(directory / f'orig-{name}.png'), original)
        assert cv2.imwrite(str(directory / f'hd-{name}.png'), hd)
    return directory


def test_named_pairs_side_by_side_scaled_boxes_and_independent_baselines(pairs):
    report = metrics.analyze(pairs=pairs, ids=['pre', 'p1', 'p2'], offsets=[-1, 5, 11],
                             boxes=[FULL, LEFT], scale_from=(96, 64), gate_dark={5: 52, 11: 0})
    assert report['boxes'][1]['pixel_boxes'] == {'original': [0, 0, 40, 64], 'hd': [0, 0, 80, 128]}
    assert channel(report, 1, name='original')['dark_rise'] == 13
    assert channel(report, 1, name='hd')['dark_rise'] == 52
    assert channel(report, 1, name='original')['grey_rise'] == 13
    assert channel(report, 1, name='hd')['grey_rise'] == 52
    assert report['samples'][1]['boxes'][0]['hd_minus_original_dark'] == 51
    assert report['baseline']['boxes'][0]['channels']['hd'] == {'dark': 16, 'grey': 24}
    assert report['passed']
    failed = metrics.analyze(pairs=pairs, ids=['pre', 'p1', 'p2'], offsets=[-1, 5, 11],
                             boxes=[FULL], scale_from=(96, 64), gate_dark={5: 13})
    assert not failed['passed']
    assert [r['passed'] for r in failed['gates'][0]['results']] == [True, False]
    text = metrics.format_table(failed)
    assert 'original dark' in text and 'hd dark' in text and 'HD-orig dark' in text
    assert 'FAIL dark +5s box 1 hd' in text


def test_pair_default_offsets_are_a_prefix(pairs):
    report = metrics.analyze(pairs=pairs, ids=['pre', 'p1', 'p2'], boxes=[FULL], scale_from=(96, 64))
    assert [s['offset_seconds'] for s in report['samples']] == [-1, 0, 1]


def test_cli_table_json_and_gate_exit_status(frames, tmp_path, capsys):
    out = tmp_path / 'report' / 'metrics.json'
    args = ['--frames', str(frames), '--step', '1', '--event', '2', '--box', '0,0,96,64',
            '--box', '0,0,40,64', '--at', '-1,5,11', '--gate-dark', '+5:13,+11:0', '--json', str(out)]
    assert metrics.main(args) == 0
    assert json.loads(out.read_text())['passed']
    text = capsys.readouterr().out
    assert 'dark rise' in text and 'grey rise' in text and 'PASS dark +5s box 2' in text
    args[args.index('+5:13,+11:0')] = '+5:12,+11:0'
    assert metrics.main(args) == 1
    report = json.loads(out.read_text())
    assert not report['passed'] and not report['gates'][0]['passed']
    assert 'Gates: FAIL' in capsys.readouterr().out


def test_pair_cli_json(pairs, tmp_path, capsys):
    out = tmp_path / 'pairs.json'
    assert metrics.main(['--pairs', str(pairs), '--ids', 'pre,p1,p2', '--at=-1,5,11',
                         '--box', '0,0,96,64', '--box-scale-from', '96x64', '--json', str(out)]) == 0
    assert json.loads(out.read_text())['samples'][1]['boxes'][0]['hd_minus_original_dark'] == 51
    assert 'HD-orig dark' in capsys.readouterr().out


@pytest.mark.parametrize('extra', [
    ['--step', '0'], ['--event', 'nan'], ['--dark-v', '256'], ['--dark-v', 'nan'],
    ['--at', '-3,0'], ['--at', '-1,12'], ['--at', '-1,-1'], ['--at', 'nan,0'],
    ['--box', '-1,0,10,10'], ['--box', '0,0,0,10'], ['--box', '1,2,3'],
    ['--box-scale-from', '0x64'], ['--box-scale-from', 'nonsense'],
    ['--gate-dark', '+4:1'], ['--gate-dark', '+5:-1'], ['--gate-grey', '+5:1,+5:2'],
    ['--gate-grey', '+5:inf'], ['--gate-grey', 'oops'], ['--fps', '30'], ['--ids', 'pre,p1'],
])
def test_cli_bad_inputs_exit_two(frames, extra, capsys):
    with pytest.raises(SystemExit) as error:
        metrics.main(['--frames', str(frames), '--step', '1', '--event', '2', '--box', '0,0,96,64', *extra])
    assert error.value.code == 2
    assert 'error:' in capsys.readouterr().err


def test_missing_or_changed_inputs_are_not_passes(frames, pairs):
    (frames / 'f0007.png').unlink()
    with pytest.raises(ValueError, match='Missing numbered frames'):
        metrics.analyze(frames=frames, event=2, step=1, boxes=[FULL])
    assert cv2.imwrite(str(frames / 'f0007.png'), np.zeros((32, 48, 3), np.uint8))
    with pytest.raises(ValueError, match='dimensions changed'):
        metrics.analyze(frames=frames, event=2, step=1, boxes=[FULL])
    (pairs / 'hd-p1.png').write_bytes(b'not a PNG')
    with pytest.raises(ValueError, match='Cannot read image'):
        metrics.analyze(pairs=pairs, ids=['pre', 'p1'], boxes=[FULL])


@pytest.mark.parametrize('ids,offsets', [(['../pre'], None), (['pre', 'pre'], None),
                                      (['pre', 'p1'], [-1]), (['pre', 'p1'], [0, 1])])
def test_invalid_pairs_refused(pairs, ids, offsets):
    with pytest.raises(ValueError):
        metrics.analyze(pairs=pairs, ids=ids, offsets=offsets, boxes=[FULL])


def test_mp4_frame_index_sampling_and_gate_results(tmp_path):
    path = tmp_path / 'synthetic.mp4'
    writer = None
    for codec in ('mp4v', 'avc1'):
        candidate = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*codec), 4, (96, 64))
        if candidate.isOpened():
            writer = candidate
            break
        candidate.release()
    if writer is None:
        pytest.skip('cv2 has neither mp4v nor avc1 encoder')
    try:
        for second in range(len(RADII)):
            for _ in range(4):
                writer.write(scene(second))
    finally:
        writer.release()
    report = metrics.analyze(video=path, event=2, boxes=[FULL], gate_dark={5: 80, 11: 20})
    assert report['source']['fps'] == pytest.approx(4)
    assert report['source']['read_mode'] in ('seek', 'sequential')
    assert [s['frame_index'] for s in report['samples']] == [4, 8, 12, 16, 20, 28, 40, 52]
    # Lossy codecs can move threshold crossings on the disc edges.
    assert 90 <= channel(report, 1)['dark_rise'] <= 150
    assert channel(report, 5)['dark_rise'] < channel(report, 1)['dark_rise']
    assert abs(channel(report, 7)['dark_rise']) <= 20
    assert report['passed']
    failed = metrics.analyze(video=path, event=2, boxes=[FULL], gate_dark={0: 0})
    assert not failed['passed']
    overridden = metrics.analyze(video=path, fps=2, event=2, offsets=[-1, 0, 1], boxes=[FULL])
    assert overridden['source']['fps'] == 2
    assert [s['frame_index'] for s in overridden['samples']] == [2, 4, 6]
    # Exercise the actual executable's exit code and report, not only main().
    result = subprocess.run([sys.executable, str(Path(metrics.__file__)), '--video', str(path),
                             '--event', '2', '--box', '0,0,96,64', '--gate-dark', '+0:0'],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 1 and 'Gates: FAIL' in result.stdout


class FakeCapture:
    """Model demuxers that reject seeks or expose incorrect post-seek positions."""

    def __init__(self, mode='seek', fps=1, count=5):
        self.mode, self.fps, self.count = mode, fps, count
        self.position = 0
        self.sought = False
        self.read_after_seek = False
        self.released = False

    def isOpened(self):
        return True

    def get(self, prop):
        if prop == cv2.CAP_PROP_FPS:
            return self.fps
        if prop == cv2.CAP_PROP_FRAME_COUNT:
            return float(self.count)
        if self.mode == 'wrong-before' and self.sought:
            return self.position + 1
        if self.mode == 'wrong-after' and self.read_after_seek:
            return self.position - 1
        return float(self.position)

    def set(self, prop, value):
        assert prop == cv2.CAP_PROP_POS_FRAMES
        if self.mode == 'raise':
            raise cv2.error('unsupported seek')
        self.sought = True
        self.read_after_seek = False
        self.position = int(value)
        return self.mode != 'reject'

    def read(self):
        if self.position >= 5 or (self.mode == 'bad-read' and self.sought):
            return False, None
        image = np.full((2, 2, 3), self.position, dtype=np.uint8)
        self.position += 1
        self.read_after_seek = self.sought
        return True, image

    def release(self):
        self.released = True


@pytest.mark.parametrize('mode,suffix,count', [('reject', '.mp4', 5), ('wrong-before', '.mp4', 5),
                                            ('wrong-after', '.mp4', 5), ('bad-read', '.mp4', 5),
                                            ('seek', '.mp4', 0), ('seek', '.webm', 5), ('raise', '.mp4', 5)])
def test_unreliable_video_seeks_restart_sequentially(monkeypatch, mode, suffix, count):
    captures = [FakeCapture(mode, count=count), FakeCapture()]
    opened = []

    def capture(_):
        current = captures[len(opened)]
        opened.append(current)
        return current

    monkeypatch.setattr(metrics.cv2, 'VideoCapture', capture)
    images, source = metrics.sample_video(Path('synthetic' + suffix), [3, 1, 3])
    assert source['read_mode'] == 'sequential'
    assert source['read_reason']
    assert [int(image[0, 0, 0]) for image in images] == [3, 1, 3]
    assert len(opened) == 2 and all(cap.released for cap in opened)


@pytest.mark.parametrize('reported', [0, float('nan'), float('inf'), 1000])
def test_nonsense_container_fps_requires_override(monkeypatch, reported):
    monkeypatch.setattr(metrics.cv2, 'VideoCapture', lambda _: FakeCapture(fps=reported))
    with pytest.raises(ValueError, match='supply --fps'):
        metrics.sample_video(Path('synthetic.mp4'), [0, 1])
    images, source = metrics.sample_video(Path('synthetic.mp4'), [0, 1], fps=2)
    assert source['fps'] == 2
    assert [int(image[0, 0, 0]) for image in images] == [0, 2]
    json.dumps(source, allow_nan=False)


def test_video_unavailable_samples_and_no_baseline_are_bad_input(monkeypatch):
    monkeypatch.setattr(metrics.cv2, 'VideoCapture', lambda _: FakeCapture())
    with pytest.raises(ValueError, match='unavailable'):
        metrics.sample_video(Path('synthetic.mp4'), [0, 5])
    with pytest.raises(ValueError, match='non-negative'):
        metrics.sample_video(Path('synthetic.mp4'), [-1, 0])
    with pytest.raises(ValueError, match='baseline'):
        metrics.analyze(video=Path('synthetic.mp4'), event=0, offsets=[0, 1], boxes=[FULL])
    with pytest.raises(ValueError, match='--event'):
        metrics.analyze(video=Path('synthetic.mp4'), boxes=[FULL])
