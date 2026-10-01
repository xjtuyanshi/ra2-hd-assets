"""Asset-free tests of foliage_grade: synthetic grass, road and transparent texels."""
import unittest

import numpy as np

import foliage_grade as fg


def lab_of(rgb):
    return fg.srgb_to_lab(np.asarray(rgb, dtype=np.float64).reshape(1, 1, 3) / 255)[0, 0]


class FoliageGradeTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1)
        img = np.zeros((64, 96, 4), np.uint8)
        img[..., 3] = 255
        # Cool blue-green wild grass with texture on the left, a grey road on the right, a transparent corner.
        img[:, :64, :3] = np.clip(np.array([70, 100, 70]) + rng.normal(0, 8, (64, 64, 1)), 0, 255)
        img[:, 64:, :3] = 90
        img[:8, :8, 3] = 0
        self.img = img

    def test_round_trip(self):
        rgb = np.array([[[10, 200, 30], [200, 120, 60], [128, 128, 128]]], np.float64) / 255
        back = fg.lab_to_srgb(fg.srgb_to_lab(rgb))
        self.assertLess(np.abs(back - rgb).max(), 2e-3)

    def test_grass_moves_towards_target_and_keeps_texture(self):
        out, w = fg.grade(self.img, L=60, kL=1.0, hue=100, kH=1.0, C=30, kC=1.0, sigma=4)
        before = fg.srgb_to_lab(self.img[20:44, 16:48, :3].astype(np.float64) / 255)
        after = fg.srgb_to_lab(out[20:44, 16:48, :3].astype(np.float64) / 255)
        self.assertGreater(w[30, 30], 0.9)
        self.assertAlmostEqual(after[..., 0].mean(), 60, delta=1.5)
        hue = np.degrees(np.arctan2(after[..., 2].mean(), after[..., 1].mean()))
        self.assertAlmostEqual(hue, 100, delta=4)
        # Texture contrast (deviation from the mean) survives.
        self.assertAlmostEqual(after[..., 0].std(), before[..., 0].std(), delta=0.35 * before[..., 0].std())

    def test_road_and_transparent_untouched(self):
        out, w = fg.grade(self.img, L=60, kL=1.0, hue=100, kH=1.0, C=30, kC=1.0, sigma=4)
        self.assertTrue(np.array_equal(out[:, 72:], self.img[:, 72:]))
        self.assertTrue(np.array_equal(out[:8, :8, 3], self.img[:8, :8, 3]))
        self.assertEqual(float(w[30, 90]), 0.0)

    def test_zero_strength_is_identity(self):
        out, _ = fg.grade(self.img, kL=0, kH=0, kC=0, sigma=4)
        self.assertLessEqual(np.abs(out.astype(int) - self.img.astype(int)).max(), 1)


if __name__ == '__main__':
    unittest.main()
