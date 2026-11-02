"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_terrain_seams.py'."""

from __future__ import annotations

import unittest

import numpy as np

import terrain_seams as ts


def textured(height: int, width: int, seed: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """A seam-free reference with pixel texture and soft shapes, and a 're-detail' that adds independent fine noise."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width]
    base = 140 + 30 * np.sin(xx / 37.0) * np.cos(yy / 23.0) + rng.normal(0, 10, (height, width))
    ref = np.repeat(base[..., None], 3, -1).astype(np.float32)
    out = ref + rng.normal(0, 6, ref.shape).astype(np.float32)
    return out, ref


class SeamMetricTests(unittest.TestCase):
    def setUp(self):
        self.out, self.ref = textured(1024, 1024)
        self.land = np.ones((1024, 1024), bool)

    def test_seam_free_texture_scores_below_the_limit(self):
        s = ts.seam_scores(self.out, self.ref, self.land)
        self.assertLess(max(s["tone_col"], s["tone_row"], s["detail_col"], s["detail_row"]), 1.8)

    def test_tone_step_between_tiles_is_found_where_it_is(self):
        out = self.out.copy()
        out[:, 512:] += 1.5
        s = ts.seam_scores(out, self.ref, self.land)
        self.assertGreaterEqual(s["tone_col"], 1.8)
        self.assertLessEqual(abs(s["tone_col_at"] - 512), 2)
        out = self.out.copy()
        out[600:, :] -= 1.5
        s = ts.seam_scores(out, self.ref, self.land)
        self.assertGreaterEqual(s["tone_row"], 1.8)
        self.assertLessEqual(abs(s["tone_row_at"] - 600), 2)

    def test_blurred_cross_fade_line_is_a_detail_seam(self):
        out = self.out.copy()
        out[:, 400:404] = out[:, 396:408].mean(1, keepdims=True)  # two generations averaged: fine detail drops
        s = ts.seam_scores(out, self.ref, self.land)
        self.assertGreaterEqual(s["detail_col"], 1.8)
        self.assertLessEqual(abs(s["detail_col_at"] - 402), 3)

    def test_map_border_and_transparent_corners_are_not_scored(self):
        land = self.land.copy()
        yy, xx = np.mgrid[0:1024, 0:1024]
        land &= (np.abs(xx - 512) / 2 + np.abs(yy - 512)) < 470  # diamond map border
        out = self.out.copy()
        out[~land] = 0  # transparent RGB differs completely from the reference
        s = ts.seam_scores(out, self.ref, ts.erode(land, 4))
        self.assertLess(max(s["tone_col"], s["tone_row"], s["detail_col"], s["detail_row"]), 1.8)

    def test_erode_and_bleed(self):
        mask = np.zeros((9, 9), bool)
        mask[2:7, 2:7] = True
        self.assertEqual(int(ts.erode(mask, 1).sum()), 9)
        rgba = np.zeros((4, 4, 4), np.uint8)
        rgba[1:3, 1:3] = (200, 100, 50, 255)
        self.assertTrue(np.allclose(ts.bleed_rgb(rgba), (200, 100, 50)))


if __name__ == "__main__":
    unittest.main()
