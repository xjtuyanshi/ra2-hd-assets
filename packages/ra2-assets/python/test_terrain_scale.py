"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_terrain_scale.py'."""

from __future__ import annotations

import unittest

import cv2
import numpy as np

import terrain_scale as ts

FITTED = 451 / 256  # A 9300 px wide composite fitted under 16384 px instead of 2x.


class TerrainScaleTests(unittest.TestCase):
    def test_sizes_round_up_and_scales_must_be_written_by_the_fitting_tools(self):
        self.assertEqual(ts.scaled_size(9300, 2505, FITTED), (16384, 4414))
        self.assertEqual(ts.scaled_size(9300, 2505, 2), (18600, 5010))
        self.assertTrue(ts.is_integer_scale(2.0))
        self.assertFalse(ts.is_integer_scale(FITTED))
        for bad in (0, -1, float("nan"), 1.3):
            with self.assertRaises(ValueError):
                ts.check_scale(bad)

    def test_area_down_is_exact_for_constant_ramp_and_integer_scales(self):
        constant = np.full(ts.scaled_size(37, 11, FITTED)[::-1], 173, np.uint8)
        np.testing.assert_allclose(ts.area_down(constant, FITTED, (37, 11)), 173, atol=1e-9)
        # Integer scale: the plain block mean (what cv2.INTER_AREA gives for whole blocks).
        rng = np.random.default_rng(3)
        blocks = rng.integers(0, 256, (12, 20)).astype(np.uint8)
        np.testing.assert_allclose(ts.area_down(blocks, 2, (10, 6)),
                                   blocks.reshape(6, 2, 10, 2).mean((1, 3)), atol=1e-9)
        # Fractional coverage: [0, 1.5) and [1.5, 3) of 0, 90, 180 -> 30, 150 (same as ra2-assets resampleArea).
        row = np.array([[0, 90, 180], [0, 90, 180]], np.uint8)  # 2 x 1 at 1.5x is 3 x 2 (ceil).
        np.testing.assert_allclose(ts.area_down(row, 1.5, (2, 1)), [[30, 150]], atol=1e-9)
        with self.assertRaises(ValueError):
            ts.area_down(row, FITTED, (2, 1))

    def test_upsample_registers_pixel_centres_at_the_manifest_scale(self):
        # Nearest: fitted pixel x shows original pixel floor((x + 0.5) / scale).
        original = np.arange(37, dtype=np.uint8)[None, :].repeat(5, 0)
        size = ts.scaled_size(37, 5, FITTED)
        up = ts.upsample(original, FITTED, size, cv2.INTER_NEAREST)
        self.assertEqual(up.shape, size[::-1])
        expected = np.minimum(np.floor((np.arange(size[0]) + 0.5) / FITTED), 36).astype(np.uint8)
        # Ties at exact pixel edges may round either way; nowhere further off than one source pixel.
        self.assertLessEqual(int(np.abs(up[2].astype(int) - expected).max()), 1)
        self.assertGreater(float((up[2] == expected).mean()), 0.95)
        # Integer scales match cv2.resize.
        ramp = np.linspace(0, 255, 40, dtype=np.float32).reshape(5, 8)
        np.testing.assert_allclose(ts.upsample(ramp, 2, (16, 10), cv2.INTER_LINEAR),
                                   cv2.resize(ramp, (16, 10), interpolation=cv2.INTER_LINEAR), atol=1e-3)
        # Round trip: fitted-and-back keeps a smooth image.
        smooth = cv2.GaussianBlur(np.random.default_rng(5).random((40, 60)).astype(np.float32) * 255, (0, 0), 3)
        size = ts.scaled_size(60, 40, FITTED)
        back = ts.area_down(ts.upsample(smooth, FITTED, size, cv2.INTER_LINEAR), FITTED, (60, 40))
        self.assertLess(float(np.abs(back - smooth)[2:-2, 2:-2].max()), 2.0)


if __name__ == "__main__":
    unittest.main()
