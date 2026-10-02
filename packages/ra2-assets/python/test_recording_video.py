"""Asset-free tests of recording_video.py: synthetic frames, crops, padding, re-timing, labels and read-back."""

import os
import shutil
import tempfile
import unittest

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
        self.src = os.path.join(self.dir, 'src.mp4')
        make_source(self.src)
        self.addCleanup(shutil.rmtree, self.dir)

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
        frames, _ = rv.read_frames(out)
        g = [int(f[60, 80, 1]) for f in frames]
        self.assertLess(abs(g[1] - g[0] - 12), 4)  # double speed skips one source frame
        self.assertLess(abs(g[21] - g[20]), 4)  # slow motion repeats source frames

    def test_crop_uses_source_pixels(self):
        src = self.quadrant_source()
        for crop, color in [('0:0:80:60', (255, 0, 0)), ('80:0:160:60', (0, 255, 0)),
                            ('0:60:80:120', (0, 0, 255)), ('80:60:160:120', (0, 255, 255))]:
            with self.subTest(crop=crop):
                out = os.path.join(self.dir, 'crop.mp4')
                res = rv.render(out, 40, 20, [rv.parse_segment(f'{src}|0|0|1|||{crop}')], fourcc='mp4v')
                frames, _ = rv.read_frames(out)
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
        frames, _ = rv.read_frames(out)
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
                frames, _ = rv.read_frames(out)
                self.assertTrue(res['ok'])
                self.assertEqual(frames[0].shape, (30, 40, 3))
                self.assert_color(frames[0][15, 20], color)

    def test_one_pixel_crop_is_nonempty(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'thin.mp4')
        res = rv.render(out, 80, 20, [rv.parse_segment(f'{src}|0|0|1|||0:0:80:1')], fourcc='mp4v')
        frames, _ = rv.read_frames(out)
        self.assertTrue(res['ok'])
        self.assertEqual(frames[0].shape, (2, 80, 3))
        self.assert_color(frames[0][0, 40], (255, 0, 0))

    def test_mismatched_crops_letterbox_to_first_segment(self):
        src = self.quadrant_source()
        out = os.path.join(self.dir, 'letterbox.mp4')
        segs = [rv.parse_segment(f'{src}|0|0|1|||{crop}')
                for crop in ['0:0:80:60', '80:0:140:60', '80:60:160:100']]
        res = rv.render(out, 80, 20, segs, fourcc='mp4v')
        frames, _ = rv.read_frames(out)
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
        frames, _ = rv.read_frames(out)
        self.assertTrue(res['ok'])
        self.assertGreater(frames[0][4:30, 4:60].max(), 150)  # label text drawn in the strip

    def test_label_drawn_after_crop_and_letterbox(self):
        font = '/System/Library/Fonts/STHeiti Medium.ttc'
        if not os.path.exists(font):
            self.skipTest('no CJK font')
        src = self.quadrant_source()
        segs = [rv.parse_segment(f'{src}|0|0|1|||0:0:80:60'),
                rv.parse_segment(f'{src}|0|0|1|L|0|80:0:140:60')]
        out = os.path.join(self.dir, 'label-crop.mp4')
        res = rv.render(out, 320, 20, segs, font=font, fourcc='mp4v')
        frames, _ = rv.read_frames(out)
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
