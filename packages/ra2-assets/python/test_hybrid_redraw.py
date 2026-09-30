"""Asset-free tests: python -B -m unittest discover -s packages/ra2-assets/python -p 'test_hybrid*.py'."""

from __future__ import annotations

import unittest

import numpy as np

import hybrid_redraw as hr
import redetail_sprites as rd


def facade(h: int = 96, w: int = 128, floors: int = 6, cols: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Synthetic facade: light wall with a regular grid of dark windows, on the flat grey background."""
    rgb = np.empty((h, w, 3), np.float32)
    rgb[:] = hr.GREY
    y0, x0, y1, x1 = 12, 16, h - 12, w - 16
    rgb[y0:y1, x0:x1] = (200, 190, 160)
    fh, cw = (y1 - y0) / floors, (x1 - x0) / cols
    for f in range(floors):
        for c in range(cols):
            ya, xa = int(y0 + f * fh + fh * 0.3), int(x0 + c * cw + cw * 0.25)
            rgb[ya:ya + int(fh * 0.45), xa:xa + int(cw * 0.5)] = (40, 45, 60)
    mask = np.zeros((h, w), bool)
    mask[y0:y1, x0:x1] = True
    return rgb, mask


class RegistrationTests(unittest.TestCase):
    def test_recovers_scale_and_shift(self):
        rgb, mask = facade(160, 200)
        # "Model output": the same art sampled with a known scale/shift.
        truth = (1.03, -2.4, 0.97, 3.1)
        inv = (1 / truth[0], -truth[1] / truth[0], 1 / truth[2], -truth[3] / truth[2])
        moved = hr.warp_st(rgb, inv, rgb.shape[:2])
        params, _ = hr.register(rgb, moved, hr.dilate(mask, 6))
        np.testing.assert_allclose(params, truth, atol=0.02 * np.abs(truth).max() + 0.05)
        back = hr.warp_st(moved, params, rgb.shape[:2])
        inner = hr.erode(mask, 6)
        self.assertLess(np.abs(back - rgb)[inner].mean(), 6.0)

    def test_identity_is_stable(self):
        rgb, mask = facade()
        params, _ = hr.register(rgb, rgb.copy(), hr.dilate(mask, 4))
        np.testing.assert_allclose(params, (1, 0, 1, 0), atol=1e-3)


class ProfileTests(unittest.TestCase):
    def test_vertical_profile_counts_window_columns(self):
        rgb, mask = facade(96, 160, floors=4, cols=6)
        lum = hr.luminance(rgb)
        prof = hr.projection_profile(lum, hr.erode(mask, 2).astype(np.float64), hr.DIRECTIONS["vertical"])
        # Each window contributes a left and a right edge.
        self.assertEqual(hr.count_peaks(prof, 0.3), 12)

    def test_dropping_a_floor_lowers_the_row_profile_correlation(self):
        a, mask = facade(120, 128, floors=6)
        b, _ = facade(120, 128, floors=5)
        m = hr.erode(mask, 2).astype(np.float64)
        pa = hr.projection_profile(hr.luminance(a), m, (1.0, 0.0))
        pb = hr.projection_profile(hr.luminance(b), m, (1.0, 0.0))
        self.assertLess(hr.pearson(pa, pb), 0.6)
        self.assertGreater(hr.pearson(pa, pa), 0.999)


class CheckTests(unittest.TestCase):
    def test_luminance_profile_counts_dark_rows(self):
        rgb, mask = facade(120, 128, floors=5)
        prof, valid = hr.luminance_profile(hr.luminance(rgb), hr.erode(mask, 2).astype(np.float64), (1.0, 0.0))
        self.assertEqual(hr.count_minima(prof, valid), 5)

    def test_flattened_decoration_lowers_the_ratio(self):
        rng = np.random.default_rng(3)
        h, w = 40, 48
        art = np.full((h, w, 3), 150, np.float32)
        art[:, ::6] = 90  # vertical pilasters (strong edges)
        art += rng.normal(0, 18, (h, w, 1)).astype(np.float32)  # carved surface texture between them
        art = np.clip(art, 0, 255)
        alpha1 = np.ones((h, w), bool)
        base = np.zeros((2 * h, 2 * w, 4), np.uint8)
        base[..., :3] = hr.to_u8(np.kron(art, np.ones((2, 2, 1), np.float32)))
        base[..., 3] = 255
        ref = rd.FrameRef("building:X", 0, (0, 0, w, h), "unit", False)
        fd = hr.FrameData(ref, art, alpha1, base, np.zeros((2 * h, 2 * w), np.uint8), None)
        a2 = np.ones((2 * h, 2 * w), bool)
        wgt = a2.astype(np.float32)
        inside = rd.erode_distance(a2, 3) > 2
        lo = hr.luminance(fd.orig2x())
        same = hr.decoration_ratio(fd, lo, hr.luminance(base[..., :3].astype(np.float32)), wgt, inside)
        flat = hr.decoration_ratio(fd, lo, hr.luminance(hr.gaussian_blur(base[..., :3].astype(np.float32), 2.0)),
                                   wgt, inside)
        self.assertAlmostEqual(same, 1.0, places=3)
        self.assertLess(flat, 0.8)


class PromptTests(unittest.TestCase):
    def test_retry_emphasis_is_named_once(self):
        spec = hr.ObjectSpec("a building", "beige")
        p = hr.build_prompt("building", spec, ["grid", "grid", "local:upper left"])
        self.assertEqual(p.count("facade grid"), 1)
        self.assertIn("upper left", p)
        self.assertIn("raw.png", p)

    def test_damaged_prompt_mentions_the_reference(self):
        p = hr.build_prompt("building", hr.ObjectSpec("a building", "beige"), [], damaged=True)
        self.assertIn("reference_intact.png", p)


    def test_style_prompt_names_the_reference_and_keeps_structure_rules(self):
        p = hr.build_prompt("building", hr.ObjectSpec("a building", "beige"), [], damaged=True, style=True)
        self.assertIn("style_reference.png", p)
        self.assertIn("reference_intact.png", p)
        self.assertIn("same number of floors", p)
        self.assertNotIn("ONLY increase material fidelity", p)


class StyleLockTests(unittest.TestCase):
    def test_lightness_target_moves_towards_the_reference_only_where_it_is_clean(self):
        h, w = 12, 12
        art = np.full((h, w, 3), 100, np.float32)
        alpha1 = np.ones((h, w), bool)
        base = np.zeros((2 * h, 2 * w, 4), np.uint8)
        base[..., 3] = 255
        ref = rd.FrameRef("building:X", 0, (0, 0, w, h), "unit", False)
        fd = hr.FrameData(ref, art, alpha1, base, np.zeros((2 * h, 2 * w), np.uint8), None)
        redraw = np.full((2 * h, 2 * w, 3), 100, np.float32)
        plain = hr.lock_colour(fd, redraw, 3.0, 3.0, 1.0, 1.0)
        fd.style1 = np.full((h + 2 * hr.MARGIN, w + 2 * hr.MARGIN, 3), 160, np.float32)
        fd.style_valid1 = np.ones((h, w), np.float32)
        fd.style_valid1[:, : w // 2] = 0  # the reference is not clean on the left half
        fd.style_lock_l = 1.0
        styled = hr.lock_colour(fd, redraw, 3.0, 3.0, 1.0, 1.0)
        lum = lambda im: rd.srgb_to_lab(im)[..., 0]  # noqa: E731
        self.assertLess(abs(float(lum(styled)[:, :4].mean() - lum(plain)[:, :4].mean())), 3.0)
        self.assertGreater(float(lum(styled)[:, -4:].mean() - lum(plain)[:, -4:].mean()), 15.0)


class EncodeTests(unittest.TestCase):
    def test_alpha_is_copied_and_paint_encoded(self):
        h, w = 6, 8
        art = np.full((h, w, 3), 150, np.float32)
        alpha1 = np.ones((h, w), bool)
        alpha1[0, 0] = False
        base = np.zeros((2 * h, 2 * w, 4), np.uint8)
        base[..., 3] = np.kron(alpha1, np.ones((2, 2), bool)) * 255
        base[1, 3, 3] = 77  # soft edge value must survive untouched
        paint = np.zeros((2 * h, 2 * w), np.uint8)
        paint[4:6, 4:6] = 255
        ramp = np.array([[200 - 10 * i] * 3 for i in range(16)], np.float32)
        ref = rd.FrameRef("building:X", 0, (0, 0, w, h), "unit", True)
        fd = hr.FrameData(ref, art, alpha1, base, paint, ramp)
        out = hr.encode_frame(fd, np.full((2 * h, 2 * w, 3), 180, np.float32))
        np.testing.assert_array_equal(out[..., 3], base[..., 3])
        # 180 lies at ramp index 2 -> grey 255 - 30.
        self.assertTrue(np.all(np.abs(out[4:6, 4:6, :3].astype(int) - 225) <= 1))
        self.assertTrue(np.all(out[8:, 8:, :3] == 180))


if __name__ == "__main__":
    unittest.main()
