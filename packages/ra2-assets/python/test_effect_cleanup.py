"""Asset-free regressions for the effect page clean-up (silhouette rims and late debris specks)."""

import unittest

import numpy as np

import effect_cleanup as ec


def frame_with(rim_level, size=48):
    """A grey smoke disc (straight level 0.3) on transparency, with a ring of `rim_level` along its silhouette."""
    yy, xx = np.mgrid[:size, :size]
    r = np.hypot(yy - size / 2, xx - size / 2)
    alpha = (r < 18).astype(np.float32)
    level = np.where(r > 16, rim_level, 0.3)
    rgb = np.repeat(level[..., None], 3, axis=-1)
    out = np.zeros((size, size, 4), np.uint8)
    out[..., :3] = (rgb * alpha[..., None] * 255).round()
    out[..., 3] = (alpha * 255).round()
    return out, r


class CleanupTest(unittest.TestCase):
    def test_bright_neutral_rim_is_darkened_to_the_interior(self):
        rgba, r = frame_with(0.7)
        out, changed = ec.derim(rgba)
        self.assertGreater(changed, 0)
        rim = (r > 16) & (r < 18)
        self.assertLess(out[rim][:, 0].mean(), rgba[rim][:, 0].mean() * 0.75)
        inside = r < 10
        np.testing.assert_array_equal(out[inside], rgba[inside])
        np.testing.assert_array_equal(out[..., 3], rgba[..., 3])

    def test_flame_rims_and_dark_rims_are_kept(self):
        rgba, r = frame_with(0.3)
        rgba[(r > 16) & (r < 18), 0] = 250  # orange-red flame along the edge: saturated, untouched
        rgba[(r > 16) & (r < 18), 1] = 120
        rgba[(r > 16) & (r < 18), 2] = 20
        out, changed = ec.derim(rgba)
        self.assertEqual(changed, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_small_dark_specks_are_filled_from_their_surroundings(self):
        rgba = np.zeros((40, 40, 4), np.uint8)
        rgba[5:8, 5:8] = (10, 10, 10, 255)  # a lone fragment in the air
        rgba[20:40, 0:40] = (90, 85, 80, 255)  # smoke body
        rgba[30:32, 30:32] = (8, 8, 8, 255)  # a fragment inside the smoke
        out, filled = ec.despeckle(rgba)
        self.assertGreater(filled, 0)
        self.assertLess(out[6, 6, 3], 60)  # the airborne dot becomes (nearly) transparent
        self.assertGreater(out[31, 31, :3].mean(), 60)  # the dot in the smoke takes the smoke's colour
        big = np.zeros((40, 40, 4), np.uint8)
        big[5:25, 5:25] = (10, 10, 10, 255)  # a large dark mass is not a speck
        self.assertEqual(ec.despeckle(big)[1], 0)

    def test_clean_page_despeckles_only_late_frames(self):
        page = np.zeros((20, 40, 4), np.uint8)
        page[2:4, 2:4] = (10, 10, 10, 255)
        page[2:4, 22:24] = (10, 10, 10, 255)
        meta = {"anims": {"A": {"frames": [{"page": 0, "rect": [0, 0, 20, 20]}, {"page": 0, "rect": [20, 0, 20, 20]}]}}}
        counts = ec.clean_page(page, meta, 0, late=0.5)
        self.assertGreater(counts["speck"], 0)
        self.assertEqual(page[2, 2, 3], 255)  # the early frame keeps its fragment
        self.assertLess(page[2, 22, 3], 128)


if __name__ == "__main__":
    unittest.main()
