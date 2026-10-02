"""Asset-free tests of recording_video.py: synthetic frames, crops, padding, re-timing, labels and read-back."""

from contextlib import closing
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock
import weakref

import cv2
import numpy as np

import recording_video as rv


def make_source(path: str, n: int = 40, fps: float = 20) -> None:
    w = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), fps, (160, 120))
    for i in range(n):
        f = np.zeros((120, 160, 3), np.uint8)
        f[:, :, 1] = i * 6  # frame index encoded in green
        w.write(f)
    w.release()


def make_quadrant_source(path: str) -> None:
    frame = np.zeros((120, 160, 3), np.uint8)
    frame[:60, :80] = (255, 0, 0)
    frame[:60, 80:] = (0, 255, 0)
    frame[60:, :80] = (0, 0, 255)
    frame[60:, 80:] = (0, 255, 255)
    w = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), 20, (160, 120))
    for _ in range(4):
        w.write(frame)
    w.release()


class RecordingVideoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.src = os.path.join(self.dir, 'src.mp4')
        make_source(self.src)

    def quadrant_source(self):
        path = os.path.join(self.dir, 'quadrants.mp4')
        make_quadrant_source(path)
        return path

    def assert_color(self, pixel, color):
        # Lossy source/output codecs can shift a flat colour by a few levels.
        np.testing.assert_allclose(pixel, color, atol=10)

    def test_speed_and_slow_motion(self):
        out = os.path.join(self.dir, 'o.mp4')
        segs = [rv.parse_segment(f'{self.src}|0|1.95|2||'), rv.parse_segment(f'{self.src}|0|0.45|0.5||')]
        res = rv.render(out, 160, 20, segs, fourcc='mp4v')
        # 2x over 1.95 s source at 20 fps -> 20 frames; 0.5x over 0.45 s -> 19 frames
        self.assertEqual(res['written'], 20 + 19)
        self.assertTrue(res['ok'])
        self.assertEqual(rv.count_frames(out), res['written'])
        g = [int(f[60, 80, 1]) for f, _, _ in rv.read_frames(out)]
        self.assertLess(abs(g[1] - g[0] - 12), 4)  # double speed skips one source frame
        self.assertLess(abs(g[21] - g[20]), 4)  # slow motion repeats source frames

    def test_crop_uses_source_pixels(self):
        src = self.quadrant_source()
        for crop, color in [('0:0:80:60', (255, 0, 0)), ('80:0:160:60', (0, 255, 0)),
                            ('0:60:80:120', (0, 0, 255)), ('80:60:160:120', (0, 255, 255))]:
            with self.subTest(crop=crop):
                out = os.path.join(self.dir, 'crop.mp4')
                res = rv.render(out, 40, 20, [rv.parse_segment(f'{src}|0|0|1|||{crop}')], fourcc='mp4v')
                frames = [frame for frame, _, _ in rv.read_frames(out)]
                self.assertTrue(res['ok'])
                self.assertEqual(res['written'], 1)
                self.assertEqual(frames[0].shape, (30, 40, 3))
                for y, x in [(5, 5), (5, 35), (25, 5), (25, 35)]:
                    self.assert_color(frames[0][y, x], color)

    def test_six_field_spec_keeps_full_frame(self):
        src = self.quadrant_source()
        seg = rv.parse_segment(f'{src}|0|0|1|Full frame|0')
        self.assertEqual(seg['label'], 'Full frame')
        self.assertEqual(seg['tzero'], 0)
        self.assertIsNone(seg['crop'])
        out = os.path.join(self.dir, 'full.mp4')
        res = rv.render(out, 80, 20, [seg], fourcc='mp4v')
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertTrue(res['ok'])
        self.assertEqual(frames[0].shape, (60, 80, 3))
        for y, x, color in [(15, 20, (255, 0, 0)), (15, 60, (0, 255, 0)),
                            (45, 20, (0, 0, 255)), (45, 60, (0, 255, 255))]:
            self.assert_color(frames[0][y, x], color)

    def test_crop_clamps_to_frame(self):
        src = self.quadrant_source()
        for crop, color in [('-40:-30:80:60', (255, 0, 0)), ('80:60:200:150', (0, 255, 255))]:
            with self.subTest(crop=crop):
                out = os.path.join(self.dir, 'clamped.mp4')
                res = rv.render(out, 40, 20, [rv.parse_segment(f'{src}|0|0|1|||{crop}')], fourcc='mp4v')
                frames = [frame for frame, _, _ in rv.read_frames(out)]
                self.assertTrue(res['ok'])
                self.assertEqual(frames[0].shape, (30, 40, 3))
                self.assert_color(frames[0][15, 20], color)

    def test_one_pixel_crop_is_nonempty(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'thin.mp4')
        res = rv.render(out, 80, 20, [rv.parse_segment(f'{src}|0|0|1|||0:0:80:1')], fourcc='mp4v')
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertTrue(res['ok'])
        self.assertEqual(frames[0].shape, (2, 80, 3))
        self.assert_color(frames[0][0, 40], (255, 0, 0))

    def test_mismatched_crops_letterbox_to_first_segment(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'letterbox.mp4')
        segs = [rv.parse_segment(f'{src}|0|0|1|||{crop}')
                for crop in ['0:0:80:60', '80:0:140:60', '80:60:160:100']]
        res = rv.render(out, 80, 20, segs, fourcc='mp4v')
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertEqual(res['written'], 3)
        self.assertEqual(res['readBack'], 3)
        self.assertTrue(res['ok'])
        self.assertEqual([f.shape for f in frames], [(60, 80, 3)] * 3)
        self.assert_color(frames[0][5, 5], (255, 0, 0))
        self.assert_color(frames[1][30, 5], (0, 0, 0))
        self.assert_color(frames[1][30, 75], (0, 0, 0))
        self.assert_color(frames[1][5, 15], (0, 255, 0))
        self.assert_color(frames[1][55, 65], (0, 255, 0))
        self.assert_color(frames[2][5, 40], (0, 0, 0))
        self.assert_color(frames[2][55, 40], (0, 0, 0))
        self.assert_color(frames[2][15, 5], (0, 255, 255))
        self.assert_color(frames[2][45, 75], (0, 255, 255))

    def test_invalid_crop_rejected(self):
        for crop in ['', '0:0:80', '0:0:80:60:1', '0:0:80.5:60', '0:0:right:60',
                     '80:0:0:60', '0:60:80:0', '0:0:0:60', '0:0:80:0']:
            with self.subTest(crop=crop), self.assertRaisesRegex(SystemExit, 'bad segment crop'):
                rv.parse_segment(f'{self.src}|0|0|1|||{crop}')

    def test_reordered_overlapping_crops_with_max_height(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'crop-size.mp4')
        # Earlier samples are spooled before the first segment establishes its square canvas.
        segs = [rv.parse_segment(f'{src}|0.1|0.1|1|||80:0:140:60'),
                rv.parse_segment(f'{src}|0|0.1|1|||0:0:80:60'),
                rv.parse_segment(f'{src}|0|0|1|||80:60:160:100')]
        with mock.patch.object(rv, 'read_frames', wraps=rv.read_frames) as read:
            res = rv.render(out, 321, 20, segs, fourcc='mp4v', max_height=101)
        read.assert_called_once_with(src)
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertTrue(res['ok'])
        self.assertEqual(res['written'], 5)
        self.assertEqual([frame.shape for frame in frames], [(100, 100, 3)] * 5)
        self.assert_color(frames[0][5, 5], (0, 255, 0))
        for frame in frames[1:4]:
            self.assert_color(frame[5, 50], (0, 0, 0))
            self.assert_color(frame[95, 50], (0, 0, 0))
            self.assert_color(frame[50, 5], (255, 0, 0))
        self.assert_color(frames[4][5, 50], (0, 0, 0))
        self.assert_color(frames[4][95, 50], (0, 0, 0))
        self.assert_color(frames[4][50, 5], (0, 255, 255))

    def test_narrow_crop_with_max_height_keeps_even_positive_size(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'narrow.mp4')
        res = rv.render(out, 81, 20, [rv.parse_segment(f'{src}|0|0|1|||0:0:1:60')],
                        fourcc='mp4v', max_height=11)
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertTrue(res['ok'])
        self.assertEqual(frames[0].shape, (10, 2, 3))
        self.assert_color(frames[0][5, 0], (255, 0, 0))

    def test_crop_empty_after_clamping_rejected(self):
        for crop in ['160:0:200:60', '-40:0:-1:60', '0:120:80:160', '0:-40:80:-1']:
            with self.subTest(crop=crop), self.assertRaisesRegex(SystemExit, 'empty segment crop'):
                out = os.path.join(self.dir, 'empty.mp4')
                rv.render(out, 80, 20, [rv.parse_segment(f'{self.src}|0|0|1|||{crop}')], fourcc='mp4v')

    def test_label_strip(self):
        font = '/System/Library/Fonts/STHeiti Medium.ttc'
        if not os.path.exists(font):
            self.skipTest('no CJK font')
        out = os.path.join(self.dir, 'l.mp4')
        res = rv.render(out, 320, 10, [rv.parse_segment(f'{self.src}|0|0.5|1|实机|0')], font=font, fourcc='mp4v')
        with closing(rv.read_frames(out)) as frames:
            frame, _, _ = next(frames)
        self.assertTrue(res['ok'])
        self.assertGreater(frame[4:30, 4:60].max(), 150)  # label text drawn in the strip

    def test_streaming_single_decode_and_reordered_segments(self):
        # These 600 synthetic decoded frames are allocated only when read, like a real VideoCapture.
        alive = peak = decoded = opened = 0
        values = []
        sizes = []
        captures = []

        def freed():
            nonlocal alive
            alive -= 1

        class Capture:
            def __init__(self, path):
                nonlocal opened
                opened += 1
                self.index = 0
                self.released = False
                captures.append(self)

            def read(self):
                nonlocal alive, peak, decoded
                if self.index == 600:
                    return False, None
                frame = np.empty((120, 160, 3), np.uint8)
                frame[:] = (self.index % 256, self.index // 256, 0)
                self.index += 1
                decoded += 1
                alive += 1
                peak = max(peak, alive)
                weakref.finalize(frame, freed)
                return True, frame

            def get(self, prop):
                return 30 if prop == cv2.CAP_PROP_FPS else (self.index - 1) * 1000 / 30

            def release(self):
                self.released = True

        class Writer:
            def __init__(self, path, *args):
                with open(path, 'wb'):
                    pass

            def isOpened(self):
                return True

            def write(self, frame):
                values.append(int(frame[0, 0, 0]) + 256 * int(frame[0, 0, 1]))
                sizes.append(frame.shape[:2])

            def release(self):
                pass

        segs = [rv.parse_segment(f'{self.src}|15|19.966666666666665|1||'),
                rv.parse_segment(f'{self.src}|0|10|4||')]
        with mock.patch.object(rv.cv2, 'VideoCapture', Capture), \
                mock.patch.object(rv.cv2, 'VideoWriter', Writer), \
                mock.patch.object(rv, 'count_frames', side_effect=lambda _: len(values)):
            res = rv.render(os.path.join(self.dir, 'stream.mp4'), 80, 30, segs)
        self.assertTrue(res['ok'])
        self.assertEqual(opened, 1)
        self.assertEqual(decoded, 600)
        self.assertLessEqual(peak, 3)
        self.assertEqual(alive, 0)
        self.assertTrue(captures[0].released)
        self.assertEqual(values, list(range(450, 600)) + list(range(0, 301, 4)))
        self.assertEqual(set(sizes), {(60, 80)})

    def assert_samples(self, timestamps, spec, expected, nominal_rate=20):
        def frames(path):
            for i, t in enumerate(timestamps):
                yield np.full((12, 16, 3), i, np.uint8), t, i / nominal_rate

        values = []
        with mock.patch.object(rv, 'read_frames', frames):
            rv.sample_source('synthetic', [(0, rv.parse_segment(spec))], 10, 16, None,
                             lambda index, t, f: values.append((t, int(f[0, 0, 0]))))
        self.assertEqual([value for _, value in values], expected)
        return [t for t, _ in values]

    def test_speed_four_with_variable_timestamps(self):
        times = self.assert_samples([0, 0.07, 0.31, 0.39, 0.41, 0.79, 0.8, 1.19, 1.21, 1.6],
                                    'synthetic|0|1.6|4||', [0, 3, 6, 7, 9])
        self.assertEqual(times, [k * 0.4 for k in range(5)])

    def test_interleaved_sources_preserve_output_order(self):
        opened = []
        values = []

        def frames(path):
            opened.append(path)
            for i in range(10):
                yield np.full((12, 16, 3), i + (100 if path == 'b' else 0), np.uint8), i / 10, i / 10

        writer = mock.Mock()
        writer.isOpened.return_value = True
        writer.write.side_effect = lambda frame: values.append(int(frame[0, 0, 0]))
        segs = [rv.parse_segment(spec) for spec in ('a|0.3|0.5|2||', 'b|0|0.2|1||',
                                                    'a|0|0.2|1||', 'b|0.5|0.6|1||')]
        with mock.patch.object(rv, 'read_frames', frames), \
                mock.patch.object(rv.cv2, 'VideoWriter', return_value=writer), \
                mock.patch.object(rv, 'count_frames', side_effect=lambda _: len(values)), \
                mock.patch.object(rv.os.path, 'getsize', return_value=0):
            res = rv.render('interleaved.mp4', 16, 10, segs)
        self.assertTrue(res['ok'])
        self.assertEqual(opened, ['a', 'b'])
        self.assertEqual(values, [3, 5, 100, 101, 102, 0, 1, 2, 105, 106])

    def test_zero_timestamp_prefix_is_not_nominal_timing(self):
        self.assert_samples([0, 0, 0.2, 0.4], 'synthetic|-0.1|0.5|1||', [0, 1, 1, 2, 2, 3, 3])

    def test_all_zero_timestamps_use_nominal_rate(self):
        self.assert_samples([0] * 5, 'synthetic|-0.1|0.4|1||', [0, 0, 2, 4, 4, 4])

    def test_max_height_and_even_dimensions(self):
        out = os.path.join(self.dir, 'size.mp4')
        res = rv.render(out, 321, 10, [rv.parse_segment(f'{self.src}|0|0.2|1||')],
                        fourcc='mp4v', max_height=101)
        with closing(rv.read_frames(out)) as frames:
            frame, _, _ = next(frames)
        self.assertTrue(res['ok'])
        self.assertEqual(frame.shape[:2], (100, 132))
        self.assertEqual(rv.output_size(np.empty((120, 160, 3)), 161, 200), (160, 120))

    def test_quality_supported_or_ignored(self):
        for backend in ('supported', 'rejected', 'missing', 'error'):
            with self.subTest(backend=backend):
                supported = backend == 'supported'
                writer = mock.Mock()
                writer.isOpened.return_value = True
                writer.set.return_value = supported
                if backend == 'error':
                    writer.set.side_effect = cv2.error('unsupported quality')
                with mock.patch.object(rv.cv2, 'VideoWriter', return_value=writer), \
                        mock.patch.object(rv.cv2, 'VIDEOWRITER_PROP_QUALITY', 1, create=True), \
                        mock.patch.object(rv, 'count_frames', return_value=1), \
                        mock.patch.object(rv.os.path, 'getsize', return_value=0):
                    if backend == 'missing':
                        del rv.cv2.VIDEOWRITER_PROP_QUALITY
                    res = rv.render('quality.mp4', 160, 10, [rv.parse_segment(f'{self.src}|0|0|1||')],
                                    fourcc='mp4v', quality=83)
                if backend == 'missing':
                    writer.set.assert_not_called()
                else:
                    writer.set.assert_called_once_with(1, 83)
                self.assertEqual(res['quality'], {'requested': 83, 'applied': supported})
                self.assertEqual('notes' in res, not supported)
                writer.release.assert_called_once()

    def test_cli_options_and_readback_mismatch_exit(self):
        result = {'out': 'test.mp4', 'written': 5, 'readBack': 4, 'seconds': 0.5, 'bytes': 0, 'ok': False}
        stdout = io.StringIO()
        with mock.patch.object(rv, 'render', return_value=result) as render, \
                mock.patch('sys.stdout', stdout):
            status = rv.main(['--out', 'test.mp4', '--width', '320', '--fps', '10', '--max-height', '100',
                              '--quality', '90', '--seg', 'synthetic|0|1|4|Label|0'])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(stdout.getvalue()), result)
        self.assertEqual(render.call_args.args[-2:], (100, 90))

    def test_invalid_options(self):
        for options in ({'max_height': 1}, {'quality': -1}, {'quality': 101}, {'quality': float('nan')}):
            with self.subTest(options=options), self.assertRaises(SystemExit):
                rv.render('invalid.mp4', 160, 10, [], **options)

    def test_label_drawn_after_crop_and_letterbox(self):
        font = '/System/Library/Fonts/STHeiti Medium.ttc'
        if not os.path.exists(font):
            self.skipTest('no CJK font')
        src = self.quadrant_source()
        segs = [rv.parse_segment(f'{src}|0|0|1|||0:0:80:60'),
                rv.parse_segment(f'{src}|0|0|1|L|0|80:0:140:60')]
        out = os.path.join(self.dir, 'label-crop.mp4')
        res = rv.render(out, 320, 20, segs, font=font, fourcc='mp4v')
        frames = [frame for frame, _, _ in rv.read_frames(out)]
        self.assertTrue(res['ok'])
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[1].shape, (240, 320, 3))
        # Text in the left padding proves the label is applied to the final canvas.
        self.assertGreater(frames[1][4:30, 4:35].max(), 150)
        self.assert_color(frames[1][120, 20], (0, 0, 0))
        self.assert_color(frames[1][120, 160], (0, 255, 0))

    def test_bad_segment(self):
        with self.assertRaises(SystemExit):
            rv.parse_segment('a|1|0|1||')
        with self.assertRaises(SystemExit):
            rv.parse_segment('a|0|1')


if __name__ == '__main__':
    unittest.main()
