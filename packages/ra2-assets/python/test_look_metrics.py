"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_look_metrics.py'."""

from __future__ import annotations

import unittest

import numpy as np

import look_metrics as lm


class LookMetricsTests(unittest.TestCase):
    def test_lab_reference_colours(self):
        L, a, b = lm.lab(np.array([[[255.0, 255, 255], [0, 0, 0], [0, 0, 255]]]))
        self.assertAlmostEqual(L[0, 0], 100, delta=0.1)
        self.assertAlmostEqual(L[0, 1], 0, delta=0.1)
        # Pure sRGB blue: dark (L* about 32) and strongly negative b*, the reason a deep blue light reads as paint.
        self.assertAlmostEqual(L[0, 2], 32.3, delta=0.5)
        self.assertLess(b[0, 2], -100)
        self.assertAlmostEqual(a[0, 0], 0, delta=0.1)

    def test_flat_image_has_no_local_contrast_and_split_halves_separate(self):
        flat = np.full((64, 96, 3), 128.0)
        m = lm.metrics(flat, {'all': (0, 0, 96, 64)})['all']
        # The blurs are quantized to 8-bit L* steps (0.4), the unblurred L* is not.
        self.assertLess(m['lc_fine'], 0.5)
        self.assertLess(m['lc_mid'], 0.5)
        self.assertLess(m['sunshade'], 0.5)
        split = flat.copy()
        split[:, 48:] = 240
        s = lm.metrics(split, {'all': (0, 0, 96, 64), 'lit': (60, 0, 96, 64)})
        self.assertGreater(s['all']['sunshade'], 30)
        self.assertGreater(s['lit']['L'], s['all']['L'])
        self.assertEqual(s['lit']['hi_share'], 100)

    def test_rings_follow_a_blue_spill(self):
        img = np.full((200, 300, 3), 100.0)
        yy, xx = np.mgrid[0:200, 0:300]
        spill = np.exp(-np.hypot(xx - 150, (yy - 100) * 1.6) / 40)[..., None]
        img = img * (1 - spill) + np.array([60.0, 110, 255]) * spill
        values = lm.rings(img, (150, 100), (0, 20, 60, 120))
        self.assertLess(values[0][0], values[1][0])
        self.assertLess(values[1][0], values[2][0])
        self.assertLess(values[0][0], -20)


if __name__ == '__main__':
    unittest.main()
