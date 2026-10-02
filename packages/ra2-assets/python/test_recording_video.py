"""Asset-free tests of recording_video.py: synthetic numbered frames, re-timing, labels and read-back."""

import os
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


class RecordingVideoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.src = os.path.join(self.dir, 'src.mp4')
        make_source(self.src)

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

    def test_label_strip(self):
        font = '/System/Library/Fonts/STHeiti Medium.ttc'
        if not os.path.exists(font):
            self.skipTest('no CJK font')
        out = os.path.join(self.dir, 'l.mp4')
        res = rv.render(out, 320, 10, [rv.parse_segment(f'{self.src}|0|0.5|1|实机|0')], font=font, fourcc='mp4v')
        frames, _ = rv.read_frames(out)
        self.assertTrue(res['ok'])
        self.assertGreater(frames[0][4:30, 4:60].max(), 150)  # label text drawn in the strip

    def test_bad_segment(self):
        with self.assertRaises(SystemExit):
            rv.parse_segment('a|1|0|1||')
        with self.assertRaises(SystemExit):
            rv.parse_segment('a|0|1')


if __name__ == '__main__':
    unittest.main()
