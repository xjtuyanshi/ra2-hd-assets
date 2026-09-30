"""Asset-free tests: python -B -m unittest discover -s packages/ra2-assets/python -p 'test_redetail*.py'."""

from __future__ import annotations

import unittest

import numpy as np

import redetail_sprites as rd


class ColourTests(unittest.TestCase):
    def test_lab_round_trip(self):
        rng = np.random.default_rng(1)
        rgb = rng.uniform(0, 255, (32, 32, 3)).astype(np.float32)
        back = rd.lab_to_srgb(rd.srgb_to_lab(rgb))
        self.assertLess(np.abs(back - rgb).max(), 0.05)

    def test_linear_box_downsample_of_flat_image_is_identity(self):
        rgb = np.full((8, 12, 3), (200, 40, 90), np.float32)
        out = rd.box_down_linear(rgb, 2)
        self.assertEqual(out.shape, (4, 6, 3))
        self.assertLess(np.abs(out - rgb[:4, :6]).max(), 0.01)

    def test_masked_blur_ignores_unweighted_pixels(self):
        values = np.zeros((9, 9), np.float32)
        values[:, 5:] = 1000  # "background" that must not leak into the weighted half
        weight = np.zeros((9, 9), np.float32)
        weight[:, :5] = 1
        out = rd.masked_blur(values, weight, 2.0)
        self.assertLess(np.abs(out[:, :5]).max(), 1e-3)

    def test_house_colour_encodes_on_grey_ramp(self):
        ramp = np.array([[131 - 8 * i] * 3 for i in range(16)], np.float32)
        colours = ramp[[0, 5, 15]][:, None, :]
        grey = rd.neutral_to_grey(colours, ramp)[:, 0, 0]
        np.testing.assert_allclose(grey, [255, 255 - 75, 255 - 225], atol=0.5)
        # Brighter than the brightest house colour clamps to index 16.
        self.assertAlmostEqual(float(rd.neutral_to_grey(np.full((1, 1, 3), 250, np.float32), ramp)[0, 0, 0]), 255)


class GeometryTests(unittest.TestCase):
    def test_erode_distance_rings(self):
        mask = np.zeros((7, 7), bool)
        mask[1:6, 1:6] = True
        d = rd.erode_distance(mask, 2)
        self.assertEqual(d[1, 1], 1)
        self.assertEqual(d[2, 2], 2)
        self.assertEqual(d[3, 3], 3)
        self.assertEqual(d[0, 0], 0)

    def test_phase_shift_recovers_translation(self):
        rng = np.random.default_rng(3)
        base = rd.gaussian_blur(rng.uniform(0, 1, (96, 96)).astype(np.float32), 2.0)
        moved = np.roll(base, (2, -3), axis=(0, 1))
        dx, dy = rd.phase_shift(moved, base, np.ones_like(base))
        self.assertAlmostEqual(dx, -3, delta=0.2)
        self.assertAlmostEqual(dy, 2, delta=0.2)

    def test_pack_keeps_frames_inside_sheets_without_overlap(self):
        refs = [rd.FrameRef(f"tree:T{i}", 0, (0, 0, w, h), "iso", False)
                for i, (w, h) in enumerate([(30, 60), (70, 50), (40, 40), (200, 250), (300, 10), (20, 20)])]
        sheets = rd.pack(refs, max_side=160, margin=8)
        seen = []
        for sheet in sheets:
            boxes = []
            for p in sheet.placements:
                self.assertGreaterEqual(p.x, 8)
                self.assertGreaterEqual(p.y, 8)
                self.assertLessEqual(p.x + p.w + 8, sheet.width)
                self.assertLessEqual(p.y + p.h + 8, sheet.height)
                for q in boxes:  # margins included, so bled borders never overlap either
                    self.assertTrue(p.x + p.w + 8 <= q.x - 8 or q.x + q.w + 8 <= p.x - 8
                                    or p.y + p.h + 8 <= q.y - 8 or q.y + q.h + 8 <= p.y - 8)
                boxes.append(p)
                seen.append(p.key)
        self.assertEqual(sorted(seen), sorted(r.key for r in refs))


if __name__ == "__main__":
    unittest.main()
