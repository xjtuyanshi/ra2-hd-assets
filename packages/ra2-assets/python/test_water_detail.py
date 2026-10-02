"""Synthetic water-detail tests, compatible with pytest and unittest discovery."""

import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import water_detail as wd


def scene():
    rng = np.random.default_rng(15)
    texture = cv2.GaussianBlur(rng.normal(0, 12, (96, 120)).astype(np.float32), (0, 0), 0.8)
    repaint = np.clip(np.array([38, 82, 105]) + texture[..., None], 0, 255).astype(np.uint8)
    target = np.full((128, 160, 3), (30, 78, 108), np.uint8)
    target[:, :80] = (38, 94, 125)
    water = np.zeros((192, 240), np.uint8)
    water[20:-20, 20:-20] = 255
    ignore = np.zeros_like(water)
    options = dict(composite_size=(240, 192), repaint_scale=3, repaint_offset=(0, 0), repaint_screen_scale=1.5,
                   target_box=(0, 0, 240, 192), detail_scale=2, cell_size=24)
    return repaint, target, water, ignore, options


class WaterDetailHelperTests(unittest.TestCase):
    def test_signed_distance_sign_cell_scale_and_isometric_y(self):
        mask = np.zeros((32, 32), bool)
        mask[:, 16:] = True
        distance = wd.signed_distance(mask, 4)
        self.assertTrue((distance[mask] > 0).all())
        self.assertTrue((distance[~mask] < 0).all())
        np.testing.assert_allclose(distance[:, 19], 1)
        np.testing.assert_allclose(distance[:, 12], -1)
        np.testing.assert_allclose(wd.signed_distance(mask, 8), distance / 2)
        horizontal = wd.signed_distance(mask.T, 4)
        self.assertAlmostEqual(horizontal[19, 16], 7.5 / 4)
        np.testing.assert_allclose(wd.signed_distance(mask.astype(np.uint8) * 255, 4), distance)

    def test_pushpull_preserves_samples_and_fills_large_holes_and_single_channel(self):
        rng = np.random.default_rng(9)
        image = rng.uniform(0.2, 0.8, (65, 97, 3)).astype(np.float32)
        valid = np.zeros(image.shape[:2], bool)
        valid[1:5, 1:5] = True
        result = wd.pushpull(image, valid)
        np.testing.assert_array_equal(result[valid], image[valid])
        self.assertTrue(np.isfinite(result).all())
        self.assertGreaterEqual(result.min(), image[valid].min() - 1e-6)
        self.assertLessEqual(result.max(), image[valid].max() + 1e-6)
        for shape in ((65, 97), (1, 19), (3, 3), (1025, 1025)):
            alpha = np.full((*shape, 1), 0.6, np.float32)
            valid = np.zeros(shape, bool)
            valid[0, 0] = True
            alpha[~valid] = np.nan
            np.testing.assert_allclose(wd.pushpull(alpha, valid), 0.6, atol=1e-6)
        with self.assertRaisesRegex(ValueError, "valid pixel"):
            wd.pushpull(image, np.zeros(image.shape[:2], bool))

    def test_profile_fills_leading_middle_and_trailing_empty_bins(self):
        colours = np.zeros((1, 70, 3), np.float32)
        colours[:, :35] = (0.1, 0.3, 0.5)
        colours[:, 35:] = (0.2, 0.4, 0.6)
        distances = np.full((1, 70), 1.5)
        distances[:, 35:] = 3.5
        valid = np.ones(distances.shape, bool)
        prof = wd.profile(colours, distances, valid, bins=np.arange(6))
        np.testing.assert_allclose(prof, [[0.1, 0.3, 0.5]] * 3 + [[0.2, 0.4, 0.6]] * 2, atol=1e-6)
        with self.assertRaisesRegex(ValueError, "valid samples"):
            wd.profile(colours, distances, np.zeros_like(valid))

    def test_coordinate_transform_uses_pixel_centres_and_both_offsets(self):
        x, y = wd.frame_coordinates((3, 2), 4, 2, (6, -2), 0.5)
        np.testing.assert_allclose(x, [[-1.5, -0.5, 0.5]] * 2)
        np.testing.assert_allclose(y, [[0.5] * 3, [1.5] * 3])

    def test_ecc_recovers_small_translation(self):
        image, _, _, _, _ = scene()
        moved = cv2.warpAffine(image, np.array([[1, 0, 2], [0, 1, -1]], np.float32), (120, 96),
                               borderMode=cv2.BORDER_REFLECT)
        aligned, score, matrix = wd.register(moved, image)
        inner = np.s_[10:-10, 10:-10]
        before = np.abs(moved[inner].astype(float) - image[inner]).mean()
        self.assertLess(np.abs(aligned[inner] - image[inner]).mean(), before * 0.15)
        self.assertGreater(score, 0.95)
        np.testing.assert_allclose(matrix[:, 2], [2, -1], atol=0.3)


class WaterDetailPipelineTests(unittest.TestCase):
    def test_target_spatial_and_closed_loop_correction(self):
        repaint, target, water, ignore, options = scene()
        flat, report = wd.prepare(repaint, repaint, target, water, ignore, gain=0, **options)
        spatial, _ = wd.prepare(repaint, repaint, target, water, ignore, gain=0, target_spatial=1, **options)
        corrected, _ = wd.prepare(repaint, repaint, target, water, ignore, gain=0,
                                  correction={"ratio": [[0.5, 0.5, 0.5]] * (len(wd.NBINS) - 1)}, **options)
        self.assertEqual((flat.shape, flat.dtype), ((96, 120, 4), np.dtype("uint8")))
        self.assertTrue((flat[..., 3] >= 30).all())
        np.testing.assert_array_equal(corrected[..., 3], flat[..., 3])
        np.testing.assert_allclose(wd.srgb_to_lin(corrected[..., :3]), wd.srgb_to_lin(flat[..., :3]) * 0.5, atol=0.004)
        self.assertGreater(spatial[48, 35, 1], spatial[48, 85, 1] + 5)
        self.assertLess(abs(int(flat[48, 35, 1]) - int(flat[48, 85, 1])), 2)
        self.assertGreater(report["ecc_score"], 0.99)

    def test_waterlike_filter_prevents_sand_from_changing_target_colours(self):
        repaint, target, water, ignore, options = scene()
        target[:] = (30, 78, 108)
        clean, _ = wd.prepare(repaint, repaint, target, water, ignore, gain=0, target_spatial=1, **options)
        target[40:85, 55:105] = (190, 160, 110)
        filtered, _ = wd.prepare(repaint, repaint, target, water, ignore, gain=0, target_spatial=1, **options)
        np.testing.assert_allclose(filtered[..., :3], clean[..., :3], atol=1)

    def test_cli_arbitrary_framing_outputs_metadata_and_keeps_inputs(self):
        repaint, target, water, ignore, _ = scene()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # An odd composite height exercises the round-up rule, independent of target image size.
            water = np.pad(water, ((0, 1), (0, 0)))
            ignore = np.pad(ignore, ((0, 1), (0, 0)))
            for name, pixels in (("repaint", repaint), ("input", repaint), ("target", target),
                                 ("water", water), ("ignore", ignore)):
                Image.fromarray(pixels).save(root / f"{name}.png")
            correction = root / "correction.json"
            correction.write_text(json.dumps({"ratio": [[1, 1, 1]] * (len(wd.NBINS) - 1)}), encoding="utf-8")
            before = {p: p.read_bytes() for p in root.iterdir()}
            out = root / "out/detail.png"
            argv = ["--repaint", str(root / "repaint.png"), "--repaint-input", str(root / "input.png"),
                    "--target", str(root / "target.png"), "--water-mask", str(root / "water.png"),
                    "--shore-ignore", str(root / "ignore.png"), "--out", str(out),
                    "--composite-size", "240", "193", "--repaint-scale", "3", "--repaint-offset", "4", "-2",
                    "--repaint-screen-scale", "1.5", "--target-box", "0", "0", "240", "193",
                    "--detail-scale", "2", "--cell-size", "24", "--gain", "0.7", "--sigma", "2",
                    "--target-spatial", "0.6", "--correction", str(correction)]
            self.assertEqual(wd.main(argv), 0)
            with Image.open(out) as result:
                self.assertEqual((result.size, result.mode), ((120, 97), "RGBA"))
            report = json.loads(Path(str(out) + ".json").read_text())
            self.assertEqual(report["composite_size"], [240, 193])
            self.assertEqual(report["repaint_offset"], [4, -2])
            self.assertEqual(report["bins"], wd.NBINS.tolist())
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    def test_invalid_framing_correction_and_empty_target_fail(self):
        repaint, target, water, ignore, options = scene()
        with self.assertRaisesRegex(ValueError, "composite size"):
            wd.prepare(repaint, repaint, target, water[:-1], ignore, **options)
        with self.assertRaisesRegex(ValueError, "positive area"):
            wd.prepare(repaint, repaint, target, water, ignore, **(options | {"target_box": (0, 0, 0, 1)}))
        with self.assertRaisesRegex(ValueError, "target spatial"):
            wd.prepare(repaint, repaint, target, water, ignore, target_spatial=1.1, **options)
        with self.assertRaisesRegex(ValueError, "valid samples"):
            wd.prepare(repaint, repaint, np.full_like(target, 100), water, ignore, **options)
        with self.assertRaisesRegex(ValueError, "ratio"):
            wd.correction_profile({"ratio": [[1, 1, 1]]})
        with self.assertRaisesRegex(ValueError, "bins"):
            wd.correction_profile({"ratio": [[1, 1, 1]] * (len(wd.NBINS) - 1), "bins": [0, 1]})


if __name__ == "__main__":
    unittest.main()
